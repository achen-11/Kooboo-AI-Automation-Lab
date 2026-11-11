import type { AutomationTask } from '../../shared/automation.js';
import type { LearningRun } from '../../shared/experience.js';
import type { AutomationStore } from './store.js';
import { ExperienceStore } from './experience-store.js';
import { Conflict } from '../lib/store.js';
import { retainRequestReservation } from './request-budget.js';
import { optimizationEvidence } from './optimization-evidence.js';

export function assertWorkflowStopped(task: AutomationTask, store: AutomationStore, owns: (id: string) => boolean) {
  const experiences = new ExperienceStore(store), workflowId = experiences.workflow(task).id;
  const activeTask = store.tasks().some(t => experiences.workflow(t).id === workflowId && (!t.stopped || owns(t.id) || t.delivery?.stopped === false));
  const learning = store.db.prepare("SELECT id,status FROM auto_learning_runs WHERE json_extract(json,'$.workflowId')=?").all(workflowId);
  if (activeTask || learning.some(run => run.status === 'running' || owns(String(run.id)))) throw new Conflict('同工作流仍有活动执行，请等待全部停止后恢复');
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

/** Manual recovery retains this task's stopped followup and planning requests. */
export function retainStoppedFollowupReservations(task: AutomationTask, store: AutomationStore, owns: (id: string) => boolean) {
  const budgetId = task.followup?.budgetId;
  if (!store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get()) return;
  const requests = store.db.prepare(`SELECT r.id,r.charged FROM auto_model_requests r
    JOIN auto_usage u ON u.event_id=r.id AND u.source='codex'
    WHERE u.task_id=? AND ((r.account_id=? AND json_extract(u.json,'$.stage')='followup')
      OR (r.account_id=? AND json_extract(u.json,'$.stage')='planning'))
      AND r.state IN ('active','unknown')`).all(task.id,budgetId?'followup:' + budgetId:'','planning:' + task.id);
  if (!requests.length) return;
  if (!task.stopped || owns(task.id)) throw new Conflict('只能恢复已确认停止的任务');
  assertWorkflowStopped(task, store, owns);
  for (const request of requests) retainRequestReservation(store.db, request.id);
  store.event(task.id, `恢复任务：保留 ${requests.length} 笔已停止跟进 / 分析请求的未知用量预占，共 ${requests.reduce((sum, r) => sum + Number(r.charged), 0)} token；解除请求阻塞，实际用量与费用仍待核算。`);
}
