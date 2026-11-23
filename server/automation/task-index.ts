import { createHash } from 'node:crypto';
import type { AutomationReport, AutomationTask } from '../../shared/automation.js';
import { brief, taskSummary, type TaskSummary } from '../../shared/task-presentation.js';

/** Only the fields needed to decide delivery readiness; evidence remains in auto_tasks. */
export type ReadinessReport = Pick<AutomationReport, 'quality' | 'scores' | 'summary'> & {
  assessments: Pick<AutomationReport['assessments'][number], 'criterionId' | 'viewport' | 'score' | 'passed'>[];
  issues: Pick<AutomationReport['issues'][number], 'severity'>[];
  completeness?: Pick<NonNullable<AutomationReport['completeness']>, 'state' | 'sourceComplete'>;
  migrationCheck?: Pick<NonNullable<AutomationReport['migrationCheck']>, 'state'>;
  review?: Pick<NonNullable<AutomationReport['review']>, 'mode' | 'scopeComplete'>;
  collectionTarget?: Pick<NonNullable<AutomationReport['collectionTarget']>, 'state' | 'collectionVersionId' | 'inputVersionId' | 'generatedSiteId' | 'siteRevision'> & {
    checks: Pick<NonNullable<AutomationReport['collectionTarget']>['checks'][number], 'status'>[];
  };
};
export type ReadinessTask = Pick<AutomationTask, 'collectionVersionId' | 'versionId' | 'generatedSiteId' | 'siteRevision' | 'requirementsEnabled' | 'scope' | 'templateWorkflow'> & {
  referencePreviewUrl?: string;
  optimization?: Pick<NonNullable<AutomationTask['optimization']>, 'state' | 'reportId' | 'activeTaskId' | 'currentRevision' | 'reason' | 'stoppedAt'> & { policy: { targetScore: number } };
  rule: { criteria: Pick<NonNullable<AutomationTask['rule']>['criteria'][number], 'id' | 'required' | 'scopes' | 'viewports'>[] } | null;
};
export type TaskHeader = Omit<TaskSummary, 'report' | 'optimization' | 'delivery'> & ReadinessTask & {
  summary: TaskSummary;
  report: ReadinessReport | null;
  delivery?: Pick<NonNullable<AutomationTask['delivery']>, 'status' | 'stopped' | 'nextAt' | 'error'> & { targetUrl?: string; verifiedAt?: number };
  followup?: Pick<NonNullable<AutomationTask['followup']>, 'state' | 'nextAt'>;
  error: string;
  reflectionKey: string | null;
  workflowIds: string[];
};

export function reflectionDataKey(task: Pick<AutomationTask, 'id' | 'report' | 'interruption'>): string | null {
  if (task.report) return `${task.id}:reflection:${createHash('sha256').update(JSON.stringify(task.report)).digest('hex')}`;
  if (!task.interruption) return null;
  const { time: _time, ...stable } = task.interruption;
  return `${task.id}:reflection:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

export function interruptionReflectionProgressKey(
  task: Pick<AutomationTask, 'kind' | 'versionId' | 'generatedSiteId' | 'stage' | 'siteRevision' | 'generation' | 'artifacts'>,
): string {
  const generation = task.generation;
  return createHash('sha256').update(JSON.stringify({
    kind: task.kind,
    versionId: task.versionId,
    generatedSiteId: task.generatedSiteId ?? null,
    stage: task.stage ?? null,
    siteRevision: task.siteRevision ?? null,
    createAttempted: Boolean(generation?.createAttempted),
    prepared: Boolean(generation?.prepared),
    deliveryId: generation?.deliveryId ?? null,
    deliveryState: generation?.deliveryState ?? null,
    runId: generation?.runId ?? null,
    transferComplete: Boolean(generation?.transferComplete),
    importedMaterialCount: Object.keys(generation?.importedMaterials || {}).length,
    artifactCount: task.artifacts?.length ?? 0,
  })).digest('hex');
}

export function taskHeader(task: AutomationTask): TaskHeader {
  const summary = taskSummary(task), report = task.report, optimization = task.optimization;
  delete summary.usage;
  const reflection = task.learningPolicy?.collect && task.stopped && (report && task.status === 'completed' || task.interruption && task.status === 'interrupted');
  const referencePreviewUrl = task.generation?.referenceTemplate?.previewUrl?.trim() || task.generation?.referenceTemplateSandbox?.previewUrl?.trim() || undefined;
  return {
    ...summary, summary, versionId: task.versionId, siteRevision: task.siteRevision,
    ...(referencePreviewUrl ? { referencePreviewUrl } : {}),
    workflowIds: [...new Set([task.id, ...(task.evaluationTaskId ? [task.evaluationTaskId] : []), ...(optimization?.rounds.flatMap(round => [round.generationTaskId, ...(round.previousEvaluationTaskIds || []), ...(round.evaluationTaskId ? [round.evaluationTaskId] : [])]) || [])])],
    collectionVersionId: task.collectionVersionId, requirementsEnabled: task.requirementsEnabled, templateWorkflow:task.templateWorkflow,
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
      review: report.review ? { mode: report.review.mode, scopeComplete: report.review.scopeComplete } : undefined,
      collectionTarget: report.collectionTarget ? {
        state: report.collectionTarget.state, collectionVersionId: report.collectionTarget.collectionVersionId,
        inputVersionId: report.collectionTarget.inputVersionId, generatedSiteId: report.collectionTarget.generatedSiteId,
        siteRevision: report.collectionTarget.siteRevision,
        checks: report.collectionTarget.checks.length ? [{ status: report.collectionTarget.checks.find(check => check.status !== 'verified')?.status || 'verified' }] : [],
      } : undefined,
    } : null,
    delivery: task.delivery ? { status: task.delivery.status, stopped: task.delivery.stopped, nextAt: task.delivery.nextAt, error: brief(task.delivery.error || ''), ...(task.delivery.target?.siteUrl ? { targetUrl: task.delivery.target.siteUrl } : {}), ...(task.delivery.verifiedAt ? { verifiedAt: task.delivery.verifiedAt } : {}) } : undefined,
    followup: task.followup ? { state: task.followup.state, nextAt: task.followup.nextAt } : undefined,
    reflectionKey: reflection ? reflectionDataKey(task) : null,
  };
}
