import { randomUUID } from 'node:crypto';
import type { AutomationReport, AutomationSettings, AutomationTask, FollowupAction } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';

export function targetReached(task: AutomationTask, report: AutomationReport) {
  if(task.requirementsEnabled&&task.scope==='site'&&report.completeness?.state!=='complete')return false;
  const policy=task.optimization!.policy,criteria=task.rule?.criteria.filter(c=>c.scopes.includes(task.scope))||[];
  if(!criteria.length)return false;
  return ['desktop','mobile'].every(v=>{const value=report.scores.find(s=>s.viewport===v)?.value;return typeof value==='number'&&value>=policy.targetScore;})
    && criteria.every(c=>c.viewports.every(v=>{const a=report.assessments.find(a=>a.criterionId===c.id&&a.viewport===v);return !!a&&a.score!==null&&(!c.required||a.passed===true);}))
    && !report.issues.some(i=>i.severity==='critical'||i.severity==='major');
}
export function stopOptimization(task: AutomationTask, store: AutomationStore, reason: string, nextSteps: string[]=[], reached=false) {
  const run=task.optimization!;run.state=reached?'completed':'stopped';run.reason=reason;run.nextSteps=nextSteps;run.stoppedAt=Date.now();
  if(task.stopped){task.status='completed';task.error='';if(task.followup)task.followup.state='resolved';}
  store.put(task);store.event(task.id,reason);store.notice(task,reached?'优化目标已达成':'自动优化已停止',reason+(nextSteps.length?'\n下一步：'+nextSteps.join('；'):''));
}
export function optimizationBudgetReason(task: AutomationTask, store: AutomationStore) {
  const root=store.root(task);if(!root?.optimization)return '';
  const max=root.optimization.policy.maxCostCny;if(max===null)return '';
  const usage=store.usage.summary(root.id,store.workflowIds(root).filter(id=>id!==root.id));
  if(usage.knownCny>=max)return '整个任务链已达到费用上限，停止启动新的模型阶段。';
  if(usage.missing)return '已有请求费用尚未完整核算，无法确认费用预算余量，停止启动新的模型阶段。';
  return '';
}
/** Called between executor stages. No external side effects; each transition is durable and idempotent. */
export function advanceOptimization(task: AutomationTask, store: AutomationStore, settings: AutomationSettings) {
  if(!task.optimization||['completed','stopped','planning'].includes(task.optimization.state)||!task.stopped||['following-up','pending','interrupted','cancelled','cancelling'].includes(task.status))return;
  const run=task.optimization,round=run.rounds.at(-1)!;
  const active=store.task(run.activeTaskId);
  if(active&&active.id!==task.id&&['interrupted','failed','cancelled'].includes(active.status)){
    stopOptimization(task,store,'本轮执行已停止：'+(active.interruption?.reason||active.error||'操作者取消'),active.interruption?.nextSteps||['查看当前轮次执行记录，处理后恢复原任务。']);return;
  }
  const generation=store.task(round.generationTaskId);
  if(!generation||generation.status!=='completed'||!generation.stopped)return;
  if(!round.evaluationTaskId){
    const evaluation=store.ensureEvaluation(generation,settings);round.evaluationTaskId=evaluation.id;run.activeTaskId=evaluation.id;task.evaluationTaskId=evaluation.id;run.state='waiting-evaluation';store.put(task);
  }
  const evaluation=store.task(round.evaluationTaskId!);
  if(!evaluation?.report||evaluation.status!=='completed'||!evaluation.stopped)return;
  if(evaluation.siteRevision!==run.currentRevision)return;
  run.reportId=evaluation.id;task.evaluationTaskId=evaluation.id;
  if(targetReached(task,evaluation.report)){stopOptimization(task,store,'PC / 移动端均达到质量目标，适用必过项通过且无重大缺陷。',[],true);return;}
  const budget=optimizationBudgetReason(task,store);
  if(budget){stopOptimization(task,store,budget,['查看用量与当前版本报告，核算费用后再决定后续任务。']);return;}
  if(round.number>=run.policy.maxRounds){stopOptimization(task,store,'已达到最多修复轮数，当前版本仍未达到优化目标。',['查看最终报告及未解决问题，再决定后续修复。']);return;}
  run.state='planning';run.activeTaskId=task.id;task.stage='optimization';task.model ||= evaluation.model;
  if(task.followup)task.followup.threadId='';
  // One cumulative decision budget across this workflow; recovery never resets it implicitly.
  const firstPlan=!run.planningStarted;run.planningStarted=true;store.scheduleFollowup(task,run.recoveryPolicy,firstPlan);store.event(task.id,`读取第 ${round.number} 轮独立报告，准备分析修复与实际改善。`);
}
export function applyOptimizationAction(task: AutomationTask, action: FollowupAction, store: AutomationStore, settings: AutomationSettings) {
  const run=task.optimization!;
  if(run.state!=='planning')throw new Conflict('当前不处于质量分析阶段');
  if(action.action==='interrupt'){stopOptimization(task,store,action.reason,action.nextSteps||['查看本轮报告与问题后决定后续任务。']);return;}
  if(action.action!=='repair'||!action.message?.trim()||!action.progress||!action.imageEvidence?.length)throw new Conflict('质量优化需要明确修复委托、图片与改善分析');
  const round=run.rounds.at(-1)!;round.progress=action.progress;
  if(round.number>0)run.noImprovement=action.progress.improved?0:run.noImprovement+1;
  if(run.noImprovement>=2){stopOptimization(task,store,'连续两轮修复未取得实质改善：'+action.progress.reason,['查看各轮证据及仍存在的问题，调整生成能力或输入后再运行。']);return;}
  const budget=optimizationBudgetReason(task,store);if(budget){stopOptimization(task,store,budget,['查看费用明细并核算预算。']);return;}
  if(round.number>=run.policy.maxRounds){stopOptimization(task,store,'已达到最多修复轮数。');return;}
  const original=store.task(round.generationTaskId);if(!original?.generation?.prepared||!original.generation.conversationId||!original.stopped&&!(original.id===task.id&&task.followup?.executionStopped))throw new Conflict('缺少已停止且可继续的原 Kooboo 会话');
  store.db.transaction(()=>{
    const child=store.create({resourceIds:[task.resourceId],kind:'generation',scope:task.scope,environmentId:task.environmentId,generatedSiteId:task.generatedSiteId!,requirements:action.message!,parentId:task.id,versionId:task.versionId,ruleSnapshot:task.rule!,optimizationRootId:task.id,optimizationRound:round.number+1},settings)[0];
    child.message=`在原站原会话完成以下修复，不新建站点。范围：${task.scope}。图片仅作为比对证据，最终模板继续使用 imagePlaceholder，不得复用参考站图片。保持原内容事实、已完成区域和另一视口。\n\n${action.message}`;
    child.model=task.model;child.siteRevision=randomUUID();
    child.generation={...original.generation,next:{action:'continue',reason:action.reason,evidence:action.evidence,message:child.message}};
    child.repairEvidence={reportId:run.reportId!,files:action.imageEvidence!};store.put(child);
    run.rounds.push({number:round.number+1,revision:child.siteRevision,generationTaskId:child.id,sourceReportId:run.reportId!,brief:child.message,images:action.imageEvidence,startedAt:Date.now()});
    run.currentRevision=child.siteRevision;run.reportId=null;run.activeTaskId=child.id;run.state='repairing';task.evaluationTaskId=undefined;
    task.status='completed';task.error='';task.stage='optimization';if(task.followup)task.followup.state='resolved';
    store.put(task);store.event(task.id,`修复 ${round.number+1} 已入队：${child.id}；旧报告保留为历史，当前版本待复评。`);
  });
}
