import type { TaskSnapshot, TaskSummary } from '../../../shared/task-presentation.js';

/** A task's own results remain useful history after a later task changes the same site. */
export function taskEvaluation(task: TaskSummary, tasks: ReadonlyMap<string, TaskSummary>): TaskSummary | undefined {
  if (task.kind === 'evaluation') return task.report ? task : undefined;
  const evaluation = task.evaluationTaskId ? tasks.get(task.evaluationTaskId) : undefined;
  if (!evaluation?.report || evaluation.kind !== 'evaluation' || evaluation.generatedSiteId !== task.generatedSiteId || evaluation.scope !== task.scope) return;
  if (task.optimization && task.optimization.reportId !== evaluation.id) return;
  return evaluation;
}

/** Older running servers hide historical list scores but retain them in the compact task summary. */
export function createTaskEvaluationLoader(fetchSummary: (id: string) => Promise<Pick<TaskSnapshot, 'task' | 'currentReportId'>>) {
  const cache = new Map<string, { revision: number; result: Promise<TaskSummary | undefined> }>();
  return (task: TaskSummary): Promise<TaskSummary | undefined> => {
    const cached = cache.get(task.id);
    if (cached?.revision === task.updatedAt) return cached.result;
    const result = fetchSummary(task.id).then(snapshot => {
      const value = snapshot.task;
      if (value.id !== task.id || value.updatedAt !== task.updatedAt || value.kind !== 'evaluation' || value.status !== 'completed' || value.generatedSiteId !== task.generatedSiteId || value.scope !== task.scope || !value.report) return;
      return { ...value, reportCurrent: snapshot.currentReportId === undefined ? value.reportCurrent : snapshot.currentReportId === value.id };
    }).catch(() => {
      if (cache.get(task.id)?.result === result) cache.delete(task.id);
      return undefined;
    });
    cache.set(task.id, { revision: task.updatedAt, result });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return result;
  };
}

export function scoreTone(value: number | null, threshold: number): 'good' | 'warning' | 'low' | 'unknown' {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  if (value >= threshold) return 'good';
  return value < Math.min(60, threshold) ? 'low' : 'warning';
}

export function siteLink(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return; }
}
