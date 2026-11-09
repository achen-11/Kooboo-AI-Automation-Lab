import { createHash, randomUUID } from 'node:crypto';
import type { AutomationTask, FollowupAction } from '../../shared/automation.js';
import { Pending, UnconfirmedStop, FollowupRuntimeError } from './errors.js';
import { ModelBudgetExceeded, RequestBudget, retainRequestReservation, type RequestBudgetPolicy } from './request-budget.js';
import type { AutomationStore } from './store.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function autonomousReady(task: AutomationTask, now=Date.now()) {
  return !task.autonomy||(!task.autonomy.stopReason&&(task.autonomy.checkpoint.nextAt||0)<=now);
}
/** A new thread, random observation id, time, or AI progress claim is never progress. */
export function recoveryProgressKey(task: AutomationTask) {
  // Re-taking the same screenshot with a new filename/hash is not a completed goal.
  const evidenceRoles=[...new Set(task.artifacts?.map(f=>JSON.stringify([f.type,f.role,f.viewport]))||[])].sort();
  return digest({version:task.versionId,site:task.generatedSiteId,prepared:task.generation?.prepared,materials:Object.entries(task.generation?.importedMaterials||{}).sort(),transfer:task.generation?.transferComplete,delivery:task.generation?.deliveryState,evidenceRoles,report:task.report?{assessments:task.report.assessments.map(a=>[a.criterionId,a.viewport,a.passed]).sort(),issues:task.report.issues.map(i=>[i.title,i.severity]).sort(),completeness:task.report.completeness?.checks.map(c=>[c.id,c.status]).sort(),migration:task.report.migrationCheck?.checks.map(c=>[c.id,c.status,c.differences.filter(d=>d.confirmed).map(d=>[d.code,d.subject]).sort()]).sort()}:undefined});
}
export function isAutonomousRetry(error: unknown) {
  if(error instanceof UnconfirmedStop||error instanceof FollowupRuntimeError)return false;
  return error instanceof Pending||error instanceof ModelBudgetExceeded||error instanceof Error&&/timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|429|502|503|504|超时|连接失败|连接模型|模型上游|模型服务返回 HTTP|达到.*(?:时限|时间|预算)|耗尽累计活动时间|未提交.*(?:结果|行动)/i.test(error.message);
}
/** Records host-observed state before scheduling another paid action. Never erases history. */
export function recordAutonomousAttempt(task: AutomationTask, strategy: string, reason: string, now=Date.now(), confirmedProgressKey?:string) {
  const autonomous=task.autonomy;if(!autonomous)return '';
  const history=autonomous.history,progressKey=confirmedProgressKey||recoveryProgressKey(task),previous=autonomous.checkpoint.progressKey;
  const progressed=previous!==undefined&&previous!==progressKey&&!history.failures.some(f=>f.progressKey===progressKey);
  if(progressed){history.noProgress=0;history.strategyReturns=0;history.strategies=[];autonomous.checkpoint.diagnosticRequired=false;}
  else history.noProgress++;
  const normalized=reason.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'[id]').replace(/\b\d{4,}\b/g,'[number]').trim().slice(0,1500);
  const fingerprint=digest({stage:task.stage,strategy,reason:normalized});
  history.failures.push({fingerprint,progressKey,strategy,at:now,reason:normalized});
  history.failures=history.failures.slice(-80);
  const recent=history.strategies;
  if(!progressed&&recent.at(-1)!==strategy&&recent.includes(strategy))history.strategyReturns++;
  if(recent.at(-1)!==strategy)recent.push(strategy);
  history.strategies=recent.slice(-20);
  const same=history.failures.filter(f=>f.fingerprint===fingerprint&&f.progressKey===progressKey).length;
  const stop=same>=autonomous.policy.maxSameFailures?'相同目标、输入和证据下重复失败，已触发自主执行防循环。':history.strategyReturns>=autonomous.policy.maxStrategyReturns?'恢复策略反复回转且无可验证进展，已触发自主执行防循环。':history.noProgress>=autonomous.policy.maxNoProgress?'多次执行仍没有可验证进展，已停止自动接续并保留成果。':'';
  autonomous.checkpoint={...autonomous.checkpoint,progressKey,stage:task.stage,reason:normalized,nextAt:now+Math.min(autonomous.policy.retryMaxMs,autonomous.policy.retryBaseMs*2**Math.min(10,Math.max(0,same-1)))};
  if(stop)autonomous.stopReason=stop;
  return stop;
}
export function nextAutonomousWindow(task: AutomationTask, now=Date.now()) {
  if(!task.autonomy||!task.followup)return;
  const followup=task.followup;
  task.autonomy.window={index:task.autonomy.window.index+1,startedAt:now,attemptsBase:followup.attempts,tokensBase:followup.tokens,elapsedMsBase:followup.elapsedMs||0};
  followup.budgetId=randomUUID();followup.threadId='';
}
export function autonomousWindowRemaining(task: AutomationTask) {
  const followup=task.followup!,window=task.autonomy?.window;
  return {attempts:followup.policy.maxAttempts-(followup.attempts-(window?.attemptsBase||0)),tokens:followup.policy.maxTokens-(followup.tokens-(window?.tokensBase||0)),milliseconds:followup.policy.maxMinutes*60000-((followup.elapsedMs||0)-(window?.elapsedMsBase||0))};
}
export function followupRequestPolicy(task: AutomationTask): RequestBudgetPolicy {
  const followup=task.followup!;followup.budgetId||=randomUUID();
  return {key:'followup:'+followup.budgetId,runKey:followup.budgetId,maxTokens:followup.policy.maxTokens,maxRequests:followup.policy.maxRequests||80,initialTokens:Math.max(0,followup.tokens-(task.autonomy?.window.tokensBase||0))};
}
/** Caller must await usage.close and its tool/browser shutdown first. Estimates remain charged. */
export function retainStoppedFollowupReservations(task: AutomationTask, store: AutomationStore, stoppedRequestIds: ReadonlySet<string>) {
  if(!task.autonomy||!task.followup?.budgetId)return;
  const budget=new RequestBudget(store.db,followupRequestPolicy(task));
  const rows=store.db.prepare("SELECT id,charged FROM auto_model_requests WHERE account_id=? AND state IN ('active','unknown')").all(budget.policy.key).filter(row=>stoppedRequestIds.has(String(row.id)));
  for(const row of rows)retainRequestReservation(store.db,String(row.id));
  if(rows.length)store.event(task.id,`本轮模型与工具已确认停止，保留 ${rows.length} 笔未知用量预占；实际用量与费用仍待核算。`);
}
export function followupAccountState(task: AutomationTask, store: AutomationStore) {
  return new RequestBudget(store.db,followupRequestPolicy(task)).state();
}
export function autonomousActionStrategy(action: FollowupAction) {
  return action.action+':'+digest({message:action.message,answer:action.answer,callId:action.callId});
}
export function canReplayGeneration(task: AutomationTask) {
  const generation=task.generation;
  return task.kind!=='generation'||!generation||!generation.legacySubmitted&&(!generation.createAttempted||!!task.generatedSiteId)&&!['sending','accepted'].includes(generation.deliveryState||'');
}
