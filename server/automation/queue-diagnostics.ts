import type { AutomationSettings } from '../../shared/automation.js';
import type { QueueDiagnostics, QueueTaskReference, QueueWaitingTask, QueueWaitCode } from '../../shared/queue-diagnostics.js';
import { taskExecuting } from '../../shared/task-presentation.js';
import type { AutomationStore } from './store.js';
import type { TaskHeader } from './task-index.js';

/** Read-only explanation of the existing claim rules. Never infers that a remote execution stopped. */
export function diagnoseQueue(store: AutomationStore, settings: AutomationSettings, options: {
  workerReady: boolean; maintenance: boolean; owns: (id: string) => boolean;
  page: number; reservationPage: number; pageSize: number; summaryOnly?: boolean; now?: number;
}): QueueDiagnostics {
  const now = options.now ?? Date.now(), headers = store.headers();
  const owned = new Set(headers.filter(task => options.owns(task.id)).map(task => task.id));
  const executing = (task: TaskHeader) => options.workerReady && (owned.has(task.id) || taskExecuting(task) || !task.stopped && task.status === 'following-up' && task.followup?.state === 'running');
  const reference = (task: TaskHeader, target: 'task' | 'delivery' = 'task'): QueueTaskReference => ({
    id: task.id, resourceName: task.resourceName, kind: task.kind, status: task.status, updatedAt: task.updatedAt, target,
    canConfirmStopped: !owned.has(task.id) && (target === 'delivery'
      ? task.delivery?.stopped === false && ['failed', 'uncertain'].includes(task.delivery.status)
      : !task.stopped && (['pending', 'interrupted'].includes(task.status) || task.kind === 'evaluation' && task.status === 'following-up' && task.followup?.state === 'queued')),
  });
  const active = headers.filter(task => !task.stopped);
  const unconfirmed = active.filter(task => !executing(task));
  const reservations = [...unconfirmed.map(task => reference(task)), ...headers.filter(task => task.delivery?.stopped === false && ['failed', 'uncertain'].includes(task.delivery.status)).map(task => reference(task, 'delivery'))];
  const waiting = headers.toReversed().filter(task => task.status === 'queued');
  function pagination<T>(items: T[], requested: number) {
    const total = items.length, pages = Math.max(1, Math.ceil(total / options.pageSize)), page = Math.min(requested, pages);
    return { items: options.summaryOnly ? [] : items.slice((page - 1) * options.pageSize, page * options.pageSize), total, pages, page, pageSize: options.pageSize };
  }
  function reason(code: QueueWaitCode, message: string, blockers: TaskHeader[] = [], nextAt?: number): QueueWaitingTask['reason'] {
    return { code, message, blockers: blockers.slice(0, 10).map(task => reference(task)), blockingCount: blockers.length, ...(nextAt ? { nextAt } : {}) };
  }
  function waitingReason(header: TaskHeader) {
    if (!settings.enabled) return reason('paused', '自动执行已暂停，请在系统设置中启用。');
    if (!options.workerReady) return reason('worker-unavailable', '后台执行服务未就绪，请检查启动窗口并正常重启服务；重启后仍需核实未知执行。');
    if (options.maintenance) return reason('maintenance', '平台正在更新维护，暂不领取任务。');
    const limit = header.kind === 'generation' ? settings.generationConcurrency : settings.evaluationConcurrency;
    const sameKind = active.filter(task => task.kind === header.kind);
    if (sameKind.length >= limit) return reason('capacity', `并发名额已占用 ${sameKind.length} / ${limit}；其中 ${sameKind.filter(task => !executing(task)).length} 项尚未确认停止。`, sameKind);
    // Full input/receipts are read only for the visible waiting page, never returned to the UI.
    const task = store.task(header.id, false);
    if (!task || task.status !== 'queued') return reason('state-changed', '任务状态已更新，请刷新队列诊断。');
    if (task.autonomy?.stopReason) return reason('autonomy-stopped', '自主执行已停止，请查看任务中断原因并从原任务恢复。');
    if ((task.autonomy?.checkpoint.nextAt || 0) > now) return reason('retry-delay', '已保存重试时间，到时自动继续。', [], task.autonomy!.checkpoint.nextAt);
    if (store.migrationReadReserved(task)) return reason('migration-read', '该站点正在被迁移读取，等待原操作释放。');
    if (store.domainReserved(task.generatedSiteId)) return reason('domain', '该站点正在换绑域名，等待原操作释放。');
    const optimization = task.generatedSiteId ? headers.filter(other => other.id !== task.id && other.generatedSiteId === task.generatedSiteId && other.optimization && !['completed', 'stopped'].includes(other.optimization.state) && task.optimizationRootId !== other.id) : [];
    if (optimization.length) return reason('optimization', '同站优化流程仍保留执行权，请查看其当前阶段。', optimization);
    const siteBusy = task.generatedSiteId ? headers.filter(other => other.id !== task.id && other.generatedSiteId === task.generatedSiteId && (!other.stopped || other.status === 'following-up' || other.delivery && (other.delivery.stopped === false || ['queued', 'running', 'verifying', 'uncertain'].includes(other.delivery.status)))) : [];
    if (siteBusy.length) return reason('site-busy', '同站仍有执行、跟进或交付保留，需等待结束或核实原执行。', siteBusy);
    return reason('ready', '当前可领取，等待后台下一次调度。');
  }
  const waitingPage = pagination(waiting, options.page);
  return {
    checkedAt: now, enabled: settings.enabled, workerReady: options.workerReady, maintenance: options.maintenance,
    capacity: Object.fromEntries((['generation', 'evaluation'] as const).map(kind => [kind, {
      executing: active.filter(task => task.kind === kind && executing(task)).length,
      occupied: active.filter(task => task.kind === kind).length,
      unconfirmed: unconfirmed.filter(task => task.kind === kind).length,
      limit: kind === 'generation' ? settings.generationConcurrency : settings.evaluationConcurrency,
    }])) as QueueDiagnostics['capacity'],
    waiting: { ...waitingPage, items: waitingPage.items.map(task => ({ ...reference(task), scope: task.scope, reason: waitingReason(task) })) },
    reservations: pagination(reservations, options.reservationPage),
  };
}
