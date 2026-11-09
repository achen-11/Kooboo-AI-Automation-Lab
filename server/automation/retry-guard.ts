import { createHash } from 'node:crypto';
import type { AutomationTask } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';

function fingerprint(task:AutomationTask){
  if(task.scenario!=='site-template'||task.kind!=='generation'||!task.generation?.runId||!['failed','interrupted'].includes(task.generation.state||''))return;
  return createHash('sha256').update(JSON.stringify([task.generatedSiteId,task.siteRevision,task.generation.conversationId,task.generation.runId,task.generation.state,task.error])).digest('hex');
}
export function siteRetryBlocked(task:AutomationTask,store:AutomationStore){
  const value=fingerprint(task);if(!value)return false;
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_retry_guard(task_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)');
  return store.db.prepare('SELECT fingerprint FROM auto_template_retry_guard WHERE task_id=?').get(task.id)?.fingerprint===value;
}
export function rememberSiteRetry(task:AutomationTask,store:AutomationStore){
  const value=fingerprint(task);if(!value)return;
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_retry_guard(task_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)');
  store.db.prepare('INSERT OR REPLACE INTO auto_template_retry_guard VALUES(?,?)').run(task.id,value);
}
