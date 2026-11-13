import type { AutomationTask } from '../../shared/automation.js';
import type { LearningRun } from '../../shared/experience.js';
import type { AutomationStore } from './store.js';
import { ExperienceStore } from './experience-store.js';
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
  const learning = store.db.prepare("SELECT id,status,json FROM auto_learning_runs WHERE json_extract(json,'$.workflowId')=?").all(workflowId)
    .map(r => JSON.parse(r.json) as LearningRun)
    .filter(run => run.status === 'running' || owns(run.id));
  return { workflowId, tasks, learning };
}

export function workflowActiveReason(tasksCount: number, learningCount: number) {
  const parts: string[] = [];
  if (tasksCount) parts.push(`${tasksCount} 个任务未停止`);
  if (learningCount) parts.push(`${learningCount} 个经验学习执行中`);
  return `同工作流仍有活动执行（${parts.join('、')}），请等待全部停止或强制中断后恢复`;
}

export function assertWorkflowStopped(task: { id: string; parentId?: string | null }, store: AutomationStore, owns: (id: string) => boolean) {
  const { tasks, learning } = workflowBlockers(task, store, owns);
  if (tasks.length || learning.length) throw new Conflict(workflowActiveReason(tasks.length, learning.length));
}

export function retainWorkflowLearningReservations(workflowId: string, taskId: string, store: AutomationStore, reasonPrefix = '恢复复盘') {
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get()) return { count: 0, tokens: 0 };
  const requests = store.db.prepare("SELECT id,charged FROM auto_model_requests WHERE account_id=? AND state IN ('active','unknown')").all('experience:' + workflowId);
  if (!requests.length) return { count: 0, tokens: 0 };
  for (const request of requests) retainRequestReservation(store.db, String(request.id));
  const tokens = requests.reduce((sum, r) => sum + Number(r.charged), 0);
  store.event(taskId, `${reasonPrefix}：保留同工作流 ${requests.length} 笔已停止经验请求的未知用量预占，共 ${tokens} token；解除请求阻塞，实际用量与费用仍待核算。`);
  return { count: requests.length, tokens };
}

/** Explicit reflection recovery retains estimates without declaring missing usage to be zero. */
export function retainStoppedLearningReservations(run: LearningRun, store: AutomationStore, owns: (id: string) => boolean) {
  const task = store.task(run.taskId);
  if (!task) throw new Conflict('经验来源任务已不存在');
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get()) return { count: 0, tokens: 0 };
  const requests = store.db.prepare("SELECT id,charged FROM auto_model_requests WHERE account_id=? AND state IN ('active','unknown')").all(run.budgetId);
  if (!requests.length) return { count: 0, tokens: 0 };
  const workflowId = new ExperienceStore(store).workflow(task).id;
  if (run.workflowId !== workflowId || run.budgetId !== 'experience:' + workflowId) throw new Conflict('经验预算不属于当前工作流');
  assertWorkflowStopped(task, store, owns);
  for (const request of requests) retainRequestReservation(store.db, String(request.id));
  const tokens = requests.reduce((sum, r) => sum + Number(r.charged), 0);
  store.event(task.id, `恢复复盘：保留同工作流 ${requests.length} 笔已停止经验请求的未知用量预占，共 ${tokens} token；解除请求阻塞，实际用量与费用仍待核算。`);
  return { count: requests.length, tokens };
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
