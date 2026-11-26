import type { AutomationTask } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';
import { retainRequestReservation } from './request-budget.js';
import { optimizationEvidence } from './optimization-evidence.js';

export function workflowBlockers(task: { id: string; parentId?: string | null }, store: AutomationStore, owns: (id: string) => boolean) {
  const headers = store.headers();
  const byId = new Map(headers.map(h => [h.id, h]));
  const rootId = (candidate: { id: string; parentId?: string | null }) => {
    let current = candidate;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentId) || store.header(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };
  const workflowId = rootId(task);
  const tasks = headers.filter(t => rootId(t) === workflowId && (!t.stopped || owns(t.id) || t.delivery?.stopped === false));
  return { workflowId, tasks };
}

export function workflowActiveReason(tasksCount: number) {
  return `同工作流仍有活动执行（${tasksCount} 个任务未停止），请等待全部停止或强制中断后恢复`;
}

export function assertWorkflowStopped(task: { id: string; parentId?: string | null }, store: AutomationStore, owns: (id: string) => boolean) {
  const { tasks } = workflowBlockers(task, store, owns);
  if (tasks.length) throw new Conflict(workflowActiveReason(tasks.length));
}

/** Old preflight retries are not model attempts. Prove this for the current window only. */
export function correctUnsentPlanningAttempts(task:AutomationTask,store:AutomationStore,directory:string) {
  const followup=task.followup;
  if(task.optimization?.state!=='planning'||!task.stopped||!followup?.budgetId||!followup.startedAt||followup.tokens!==0||followup.threadId||!followup.attempts)return;
  if(store.usage.entries(task.id).some(e=>e.stage==='followup'&&e.startedAt>=followup.startedAt))return;
  if(!store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get())return;
  if(store.db.prepare('SELECT id FROM auto_model_requests WHERE account_id=? LIMIT 1').get('followup:'+followup.budgetId))return;
  optimizationEvidence(task,store,directory);
  store.event(task.id,`恢复分析前纠正 ${followup.attempts} 次未发出模型请求的前置校验重试；当前窗口无请求记录，历史用量、预占与活动时间保留。`);
  followup.attempts=0;
}

/** Manual recovery retains this task's stopped followup, planning and evaluation requests. */
export function retainStoppedFollowupReservations(task: AutomationTask, store: AutomationStore, owns: (id: string) => boolean) {
  const budgetId = task.followup?.budgetId;
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get()) return;
  const requests = store.db.prepare(`SELECT r.id,r.charged FROM auto_model_requests r
    JOIN auto_usage u ON u.event_id=r.id AND u.source='codex'
    WHERE u.task_id=? AND ((r.account_id=? AND json_extract(u.json,'$.stage')='followup')
      OR (r.account_id=? AND json_extract(u.json,'$.stage')='planning')
      OR (r.account_id=? AND json_extract(u.json,'$.stage')='evaluation'))
      AND r.state IN ('active','unknown')`).all(task.id,budgetId?'followup:' + budgetId:'','planning:' + task.id,'evaluation:' + task.id);
  if (!requests.length) return;
  if (!task.stopped || owns(task.id)) throw new Conflict('只能恢复已确认停止的任务');
  assertWorkflowStopped(task, store, owns);
  for (const request of requests) retainRequestReservation(store.db, request.id);
  store.event(task.id, `恢复任务：保留 ${requests.length} 笔已停止跟进 / 分析 / 评测请求的未知用量预占，共 ${requests.reduce((sum, r) => sum + Number(r.charged), 0)} token；解除请求阻塞，实际用量与费用仍待核算。`);
}
