import type { AutomationReport, AutomationTask, TaskStatus, OptimizationPolicy, OptimizationRun } from './automation.js';
import type { ItemDisposition } from './dispositions.js';
export interface OptimizationSummary { state: OptimizationRun['state']; policy: Omit<OptimizationPolicy,'sop'>; round: number; activeTaskId: string; reportId: string | null; reason: string; nextStep: string }

export type TaskTab = 'overview' | 'report' | 'execution' | 'usage' | 'input' | 'delivery';
export type TaskRecoveryTarget = Pick<AutomationTask, 'id' | 'status' | 'stopped'> & { canAdjustSiteNames?: boolean };
export type TaskRecoveryAction = 'resume' | 'confirm-stopped' | 'adjust-site-names';
export function canAdjustTaskSiteNames(task: AutomationTask): boolean {
  const generation = task.generation;
  return task.kind === 'generation' && task.stopped === true && ['pending', 'failed', 'interrupted'].includes(task.status)
    && !task.generatedSiteId && !task.threadId && !generation?.createAttempted && !generation?.legacySubmitted
    && !generation?.deliveryId && !generation?.deliveryState && !generation?.conversationId && !generation?.runId && !generation?.previousRunId
    && !generation?.prepared && !generation?.transferTaskId && !generation?.transferComplete && !generation?.repairBatch && !generation?.next && !task.delivery
    && /自定义站点名或子域名已被占用|站点名称或子域名连续 \d+ 次被占用/.test(task.interruption?.reason || task.error || '');
}
export function taskRecoveryAction(task?: TaskRecoveryTarget): TaskRecoveryAction | null {
  if (!task) return null;
  if (task.stopped === true && task.canAdjustSiteNames && ['pending', 'failed', 'interrupted'].includes(task.status)) return 'adjust-site-names';
  if (task.stopped === true && ['pending', 'failed', 'interrupted', 'cancelled'].includes(task.status)) return 'resume';
  if (task.stopped === false && ['pending', 'interrupted'].includes(task.status)) return 'confirm-stopped';
  return null;
}
export type DeliveryTask = Pick<AutomationTask, 'id' | 'kind' | 'environmentId' | 'status' | 'delivery'> & { report: Pick<AutomationReport, 'quality'> | null };
export type TaskSummary = Pick<AutomationTask, 'id' | 'kind' | 'resourceId' | 'resourceName' | 'scenario' | 'scope' | 'environmentId' | 'generatedSiteId' | 'parentId' | 'evaluationTaskId' | 'stage' | 'status' | 'stopped' | 'createdAt' | 'updatedAt' | 'siteUrl' | 'usage'> & {
  report: (Pick<AutomationReport, 'quality' | 'scores'> & { issueCount: number; unverifiedCount: number }) | null;
  /** Compact list results remain accessible when a later task changes the site. */
  reportCurrent?: boolean;
  attention: string;
  nextStep: string;
  canAdjustSiteNames?: boolean;
  deliveryStatus?: string;
  optimization?: OptimizationSummary;
  optimizationRootId?: string;
  optimizationRound?: number;
  completionFirst?: boolean;
  hardMaxRounds?: number;
  delivery?: Pick<NonNullable<AutomationTask['delivery']>, 'status'>;
  disposition?: ItemDisposition;
};
export interface TaskSnapshot { task: TaskSummary; evaluation: TaskSummary | null; active?: TaskSummary | null; currentReportId?: string | null; deliveryEnabled: boolean; canCompareLive?: boolean; disposition?: ItemDisposition; resourceDisposition?: ItemDisposition; latest: { seq: number; time: number; message: string; taskId: string } | null }
export interface CompactNotice { id: string; taskId: string; resourceName: string; title: string; summary: string; tab: TaskTab; createdAt: number; readAt: number | null; currentStatus?: TaskStatus; superseded: boolean }
export interface NoticePage<T = CompactNotice> { items: T[]; total: number; unread: number; page: number; pages: number; pageSize: number }

export const stageNames: Record<string, string> = { prepare: '资料准备', generation: '站点生成', handoff: '交接评测', evaluation: '独立评测', delivery: '交付核验', optimization: '质量优化' };
/** Unconfirmed historical executions reserve capacity but are not running jobs. */
export function taskExecuting(task: Pick<AutomationTask, 'status' | 'stopped'>): boolean {
  return !task.stopped && (task.status === 'running' || task.status === 'cancelling');
}
export function brief(text: string, max = 160): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}
export function taskSummary(task: AutomationTask): TaskSummary {
  const { id, kind, resourceId, resourceName, scenario, scope, environmentId, generatedSiteId, parentId, evaluationTaskId, stage, status, stopped, createdAt, updatedAt, siteUrl, usage } = task;
  return { id, kind, resourceId, resourceName, scenario, scope, environmentId, generatedSiteId, parentId, evaluationTaskId, stage, status, stopped, createdAt, updatedAt, siteUrl, usage,
    optimization: task.optimization ? {state:task.optimization.state,policy:{targetScore:task.optimization.policy.targetScore,maxRounds:task.optimization.policy.maxRounds,maxCostCny:task.optimization.policy.maxCostCny},round:task.optimization.rounds.at(-1)!.number,activeTaskId:task.optimization.activeTaskId,reportId:task.optimization.reportId,reason:brief(task.optimization.reason),nextStep:brief(task.optimization.nextSteps[0]||'')} : undefined,
    optimizationRootId: task.optimizationRootId, optimizationRound: task.optimizationRound,completionFirst:!!task.autonomy,hardMaxRounds:task.autonomy?.policy.hardMaxRounds,
    report: task.report ? { quality: task.report.quality, scores: task.report.scores, issueCount: task.report.issues.length, unverifiedCount: task.report.coverage.unverified.length } : null,
    attention: ['pending', 'failed', 'interrupted'].includes(status) ? brief(task.interruption?.reason || task.error || '当前阶段未完成，请查看执行记录。') : '',
    nextStep: canAdjustTaskSiteNames(task) ? '自动调整被占用的站点名称或子域名后继续原任务。' : brief(task.interruption?.nextSteps[0] || ''),
    canAdjustSiteNames: canAdjustTaskSiteNames(task), deliveryStatus: task.delivery?.status, delivery: task.delivery ? { status: task.delivery.status } : undefined };
}
export function initialTaskTab(search: string): TaskTab {
  const value = new URLSearchParams(search).get('tab');
  return ['overview', 'report', 'execution', 'usage', 'input', 'delivery'].includes(value || '') ? value as TaskTab : 'overview';
}
export function compactNotice(notice: { id: string; taskId: string; title: string; createdAt: number; readAt: number | null }, task?: Pick<TaskSummary, 'resourceName' | 'status' | 'delivery'>): CompactNotice {
  const delivery = notice.title.includes('交付');
  const interruption = /中断|核查|检查|未启动/.test(notice.title);
  const summaries: Record<string, string> = { '任务已中断': '自动跟进未能继续，请查看中断原因与下一步。', '评测报告已完成': '评分、问题清单和证据已保存。', '生成已结束': '生成阶段已结束，可查看站点并发起评测。', '自动交付未启动': '源站评测已结束，请查看交付条件。', '交付核验完成': '目标站核验结果与证据已保存。', '交付需要核查': '请核查迁移回执或目标站状态。', '交付已中断': '请查看交付原因与恢复方式。', '交付恢复检查': '服务恢复后需要检查交付状态。' };
  const superseded = Boolean(task && interruption && (delivery ? task.delivery?.status === 'completed' : !['pending', 'failed', 'interrupted'].includes(task.status)));
  const {id,taskId,title,createdAt,readAt}=notice;
  return { id, taskId, title, createdAt, readAt, resourceName: task?.resourceName || '任务', summary: summaries[notice.title] || '查看任务详情了解进展。', tab: delivery ? 'delivery' : notice.title.includes('报告') ? 'report' : 'overview', currentStatus: task?.status, superseded };
}
