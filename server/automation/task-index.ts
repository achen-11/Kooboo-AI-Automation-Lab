import { createHash } from 'node:crypto';
import type { AutomationReport, AutomationTask } from '../../shared/automation.js';
import { brief, taskSummary, type TaskSummary } from '../../shared/task-presentation.js';

/** Only the fields needed to decide delivery readiness; evidence remains in auto_tasks. */
export type ReadinessReport = Pick<AutomationReport, 'quality' | 'scores' | 'summary'> & {
  assessments: Pick<AutomationReport['assessments'][number], 'criterionId' | 'viewport' | 'score' | 'passed'>[];
  issues: Pick<AutomationReport['issues'][number], 'severity'>[];
  completeness?: Pick<NonNullable<AutomationReport['completeness']>, 'state' | 'sourceComplete'>;
  migrationCheck?: Pick<NonNullable<AutomationReport['migrationCheck']>, 'state'>;
  collectionTarget?: Pick<NonNullable<AutomationReport['collectionTarget']>, 'state' | 'collectionVersionId' | 'inputVersionId' | 'generatedSiteId' | 'siteRevision'> & {
    checks: Pick<NonNullable<AutomationReport['collectionTarget']>['checks'][number], 'status'>[];
  };
};
export type ReadinessTask = Pick<AutomationTask, 'collectionVersionId' | 'versionId' | 'generatedSiteId' | 'siteRevision' | 'requirementsEnabled' | 'scope'> & {
  optimization?: Pick<NonNullable<AutomationTask['optimization']>, 'state' | 'reportId' | 'activeTaskId' | 'currentRevision' | 'reason' | 'stoppedAt'> & { policy: { targetScore: number } };
  rule: { criteria: Pick<NonNullable<AutomationTask['rule']>['criteria'][number], 'id' | 'required' | 'scopes' | 'viewports'>[] } | null;
};
export type TaskHeader = Omit<TaskSummary, 'report' | 'optimization' | 'delivery'> & ReadinessTask & {
  summary: TaskSummary;
  report: ReadinessReport | null;
  delivery?: Pick<NonNullable<AutomationTask['delivery']>, 'status' | 'stopped' | 'nextAt' | 'error'>;
  followup?: Pick<NonNullable<AutomationTask['followup']>, 'state' | 'nextAt'>;
  error: string;
  reflectionKey: string | null;
  workflowIds: string[];
};

export function taskHeader(task: AutomationTask): TaskHeader {
  const summary = taskSummary(task), report = task.report, optimization = task.optimization;
  delete summary.usage;
  const reflection = task.learningPolicy?.collect && task.stopped && (report && task.status === 'completed' || task.interruption && task.status === 'interrupted');
  return {
    ...summary, summary, versionId: task.versionId, siteRevision: task.siteRevision,
    workflowIds: [...new Set([task.id, ...(task.evaluationTaskId ? [task.evaluationTaskId] : []), ...(optimization?.rounds.flatMap(round => [round.generationTaskId, ...(round.evaluationTaskId ? [round.evaluationTaskId] : [])]) || [])])],
    collectionVersionId: task.collectionVersionId, requirementsEnabled: task.requirementsEnabled,
    error: brief(task.error),
    rule: task.rule ? { criteria: (task.rule.criteria || []).map(({ id, required, scopes, viewports }) => ({ id, required, scopes, viewports })) } : null,
    optimization: optimization ? {
      state: optimization.state, reportId: optimization.reportId, activeTaskId: optimization.activeTaskId,
      currentRevision: optimization.currentRevision, reason: brief(optimization.reason), stoppedAt: optimization.stoppedAt,
      policy: { targetScore: optimization.policy.targetScore },
    } : undefined,
    report: report ? {
      summary: brief(report.summary, 220), quality: report.quality, scores: report.scores,
      assessments: report.assessments.map(({ criterionId, viewport, score, passed }) => ({ criterionId, viewport, score, passed })),
      issues: report.issues.map(({ severity }) => ({ severity })),
      completeness: report.completeness ? { state: report.completeness.state, sourceComplete: report.completeness.sourceComplete } : undefined,
      migrationCheck: report.migrationCheck ? { state: report.migrationCheck.state } : undefined,
      collectionTarget: report.collectionTarget ? {
        state: report.collectionTarget.state, collectionVersionId: report.collectionTarget.collectionVersionId,
        inputVersionId: report.collectionTarget.inputVersionId, generatedSiteId: report.collectionTarget.generatedSiteId,
        siteRevision: report.collectionTarget.siteRevision,
        checks: report.collectionTarget.checks.length ? [{ status: report.collectionTarget.checks.find(check => check.status !== 'verified')?.status || 'verified' }] : [],
      } : undefined,
    } : null,
    delivery: task.delivery ? { status: task.delivery.status, stopped: task.delivery.stopped, nextAt: task.delivery.nextAt, error: brief(task.delivery.error || '') } : undefined,
    followup: task.followup ? { state: task.followup.state, nextAt: task.followup.nextAt } : undefined,
    reflectionKey: reflection ? `${task.id}:reflection:${createHash('sha256').update(JSON.stringify(report || task.interruption)).digest('hex')}` : null,
  };
}
