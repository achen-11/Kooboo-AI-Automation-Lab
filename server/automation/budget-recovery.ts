import type { AutomationTask } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import { ExperienceStore } from './experience-store.js';
import { Conflict } from '../lib/store.js';
import { retainRequestReservation } from './request-budget.js';

/** Manual task recovery only acknowledges this task's stopped followup requests. */
export function retainStoppedFollowupReservations(task: AutomationTask, store: AutomationStore, owns: (id: string) => boolean) {
  const budgetId = task.followup?.budgetId;
  if (!budgetId || !store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get()) return;
  const requests = store.db.prepare(`SELECT r.id,r.charged FROM auto_model_requests r
    JOIN auto_usage u ON u.event_id=r.id AND u.source='codex'
    WHERE r.account_id=? AND u.task_id=? AND json_extract(u.json,'$.stage')='followup'
      AND r.state IN ('active','unknown')`).all('followup:' + budgetId, task.id);
  if (!requests.length) return;
  if (!task.stopped || owns(task.id)) throw new Conflict('只能恢复已确认停止的任务');
  const experiences = new ExperienceStore(store), workflowId = experiences.workflow(task).id;
  const activeTask = store.tasks().some(t => experiences.workflow(t).id === workflowId && (!t.stopped || owns(t.id) || t.delivery?.stopped === false));
  const activeLearning = store.db.prepare("SELECT id FROM auto_learning_runs WHERE status='running' AND json_extract(json,'$.workflowId')=?").get(workflowId);
  if (activeTask || activeLearning) throw new Conflict('同工作流仍有活动执行，请等待全部停止后恢复');
  for (const request of requests) retainRequestReservation(store.db, request.id);
  store.event(task.id, `恢复任务：保留 ${requests.length} 笔已停止跟进请求的未知用量预占，共 ${requests.reduce((sum, r) => sum + Number(r.charged), 0)} token；解除请求阻塞，实际用量与费用仍待核算。`);
}
