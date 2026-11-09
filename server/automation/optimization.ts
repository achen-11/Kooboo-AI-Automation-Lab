import { randomUUID } from 'node:crypto';
import type { AutomationReport, AutomationSettings, AutomationTask, FollowupAction } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';
import { optimizationScenarioGuidance } from '../../shared/automation.js';
import { MigrationVerificationStore, migrationRepairContext } from './migration-verification.js';
import { autonomousActionStrategy, recordAutonomousAttempt } from './autonomy.js';
import { ManifestStore } from './completeness.js';
import { collectionTargetGate, latestCollectionTargetReport } from './collection/target-verification.js';
import { collectionTargetRepairContext } from './collection/report.js';
import { CollectionStore } from './collection/store.js';
import { validateRecollectionAction, validateRecollectionScope } from './collection/recollection.js';
import type { ReadinessReport, ReadinessTask } from './task-index.js';

export function targetReached(task: ReadinessTask, report: ReadinessReport) {
  const target=report.collectionTarget;
  if(task.collectionVersionId&&(!target||target.state!=='complete'||target.collectionVersionId!==task.collectionVersionId||target.inputVersionId!==task.versionId||target.generatedSiteId!==task.generatedSiteId||target.siteRevision!==(task.optimization?.currentRevision||task.siteRevision)||!target.checks.length||target.checks.some(check=>check.status!=='verified')))return false;
  if(report.migrationCheck&&report.migrationCheck.state!=='complete')return false;
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
  const root=store.root(task);if(!root)return '';
  const limits=[root.autonomy?.policy.hardCostCny,root.optimization?.policy.maxCostCny].filter((value):value is number=>typeof value==='number');
  if(!limits.length)return '';const max=Math.min(...limits);
  const usage=store.usage.summary(root.id,store.workflowIds(root).filter(id=>id!==root.id));
  if(usage.knownCny>=max)return '整个任务链已达到费用上限，停止启动新的模型阶段。';
  if(usage.missing)return '已有请求费用尚未完整核算，无法确认费用预算余量，停止启动新的模型阶段。';
  return '';
}
function roundLimit(task:AutomationTask) { return task.autonomy?task.autonomy.policy.hardMaxRounds:task.optimization?.policy.maxRounds; }
/** Improvements must appear in independent checks, not only in the planner's claim. */
export function verifiedOptimizationProgress(task:AutomationTask,store:AutomationStore) {
  const rounds=task.optimization!.rounds,current=store.task(rounds.at(-1)!.evaluationTaskId||'')?.report,previous=store.task(rounds.at(-2)?.evaluationTaskId||'')?.report;
  if(!current||!previous)return false;
  const earlierIssues=new Map(previous.issues.map(i=>[i.title,i]));
  const resolvedIssue=[...earlierIssues.keys()].some(title=>!current.issues.some(i=>i.title===title));
  const improvedAssessment=current.assessments.some(a=>a.passed===true&&a.evidence.length>0&&previous.assessments.some(p=>p.criterionId===a.criterionId&&p.viewport===a.viewport&&p.passed!==true));
  const improvedCompleteness=current.completeness?.checks.some(c=>c.status==='verified'&&c.evidence.length>0&&previous.completeness?.checks.some(p=>p.id===c.id&&p.status!=='verified'));
  const improvedMigration=current.migrationCheck?.checks.some(c=>c.evidence.length>0&&previous.migrationCheck?.checks.some(p=>p.id===c.id&&(c.status==='verified'&&p.status!=='verified'||c.differences.filter(d=>d.confirmed).length<p.differences.filter(d=>d.confirmed).length)));
  const improvedCollection=current.collectionTarget?.checks.some(c=>c.status==='verified'&&c.evidence.length>0&&previous.collectionTarget?.checks.some(p=>p.id===c.id&&p.status!=='verified'));
  return !!(resolvedIssue||improvedAssessment||improvedCompleteness||improvedMigration||improvedCollection);
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
  const migrationRegistry=new MigrationVerificationStore(store);
  const migrationRequired=!!migrationRegistry.profile(task),migrationRun=migrationRequired?migrationRegistry.current(task):undefined;
  if(evaluation.collectionVersionId){
    const manifest=new ManifestStore(store).get(evaluation.requirementsId);
    const target=manifest?latestCollectionTargetReport(store,evaluation,manifest):undefined;
    if(!manifest||!target||target.id!==evaluation.report.collectionTarget?.id||target.state==='pending'){
      stopOptimization(task,store,'当前版本缺少已完成的 B 段程序核验，保留原站和评分检查点。',['恢复当前评测任务完成程序取证后再继续。']);return;
    }
    if(target.state==='complete'&&!collectionTargetGate(target,evaluation,manifest))throw new Conflict('B段报告绑定已失效');
  }
  if(migrationRequired&&!migrationRun){stopOptimization(task,store,'当前版本缺少程序迁移检查，停止修复规划与达标判断。',['先对当前站点修订执行程序检查，再恢复原任务；保留累计预算。']);return;}
  if((!migrationRequired||migrationRun?.state==='complete')&&targetReached(task,evaluation.report)){stopOptimization(task,store,'PC / 移动端均达到质量目标，适用必过项通过且无重大缺陷。',[],true);return;}
  const budget=optimizationBudgetReason(task,store);
  if(budget){stopOptimization(task,store,budget,['查看用量与当前版本报告，核算费用后再决定后续任务。']);return;}
  const limit=roundLimit(task);
  if(limit!==undefined&&round.number>=limit){stopOptimization(task,store,'已达到最多修复轮数，当前版本仍未达到优化目标。',['查看最终报告及未解决问题，再决定后续修复。']);return;}
  if(task.autonomy&&run.noImprovement>=2&&!task.autonomy.checkpoint.diagnosticRequired){
    if(task.autonomy.history.diagnostics>=task.autonomy.policy.maxDiagnostics){stopOptimization(task,store,'有限诊断与换策后仍无实质改善，已触发自主优化防循环。',['查看各轮实际证据、失败路径和保留的原站，提供新的修复条件后恢复。']);return;}
    task.autonomy.history.diagnostics++;task.autonomy.checkpoint.diagnosticRequired=true;store.event(task.id,'连续两轮无改善，下一轮先诊断失败原因并提出不同的证据支持路径。');
  }
  run.state='planning';run.activeTaskId=task.id;task.stage='optimization';task.model ||= evaluation.model;
  if(task.followup)task.followup.threadId='';
  // One cumulative decision budget across this workflow; recovery never resets it implicitly.
  const firstPlan=!run.planningStarted;run.planningStarted=true;store.scheduleFollowup(task,run.recoveryPolicy,firstPlan&&!task.autonomy);store.event(task.id,`读取第 ${round.number} 轮独立报告，准备分析修复与实际改善。`);
}
export function applyOptimizationAction(task: AutomationTask, action: FollowupAction, store: AutomationStore, settings: AutomationSettings, directory?:string) {
  const run=task.optimization!;
  if(run.state!=='planning')throw new Conflict('当前不处于质量分析阶段');
  if(action.action==='interrupt'){stopOptimization(task,store,action.reason,action.nextSteps||['查看本轮报告与问题后决定后续任务。']);return;}
  const collecting=action.action==='collect',objective=collecting?validateRecollectionAction(task,action,task.followup?.reportObservations||{}):undefined;
  if(collecting&&!directory)throw new Conflict('定向补采缺少平台资料目录');
  if(!collecting&&(action.action!=='repair'||!action.message?.trim()||!action.progress||!action.imageEvidence?.length))throw new Conflict('质量优化需要明确修复委托、图片与改善分析');
  const collections=collecting?new CollectionStore(store,directory!):undefined,source=collections?.forTask(task);
  if(collecting){if(!source)throw new Conflict('定向补采缺少已冻结来源');validateRecollectionScope(source,objective!);action={...action,message:action.message||`补齐已确认的来源缺口，并修复原站对应交付：${objective!.description}\n对象：${objective!.affectedObjects.join('、')}\n验收：${objective!.acceptance}`,progress:action.progress||{improved:false,reason:action.reason,resolved:[],remaining:objective!.affectedObjects,unverified:objective!.affectedObjects,introduced:[]}};}
  const round=run.rounds.at(-1)!,alreadyAnalyzed=!!round.progress,progress=action.progress!;round.progress=progress;
  const verified=task.autonomy?verifiedOptimizationProgress(task,store):progress.improved;
  if(round.number>0&&!alreadyAnalyzed)run.noImprovement=verified?0:run.noImprovement+1;
  if(!task.autonomy&&run.noImprovement>=2){stopOptimization(task,store,'连续两轮修复未取得实质改善：'+progress.reason,['查看各轮证据及仍存在的问题，调整生成能力或输入后再运行。']);return;}
  if(task.autonomy){
    if(task.autonomy.checkpoint.diagnosticRequired&&task.autonomy.history.strategies.includes(autonomousActionStrategy(action))){stopOptimization(task,store,'诊断后仍提交已失败的相同修复路径，停止无进展重复。',['根据实际失败证据补齐不同方法后恢复。']);return;}
    // The independent report is the host-owned state used by the recovery guard.
    const current=store.task(run.reportId||'')?.report;
    const priorReport=task.report;task.report=current||null;
    const stop=recordAutonomousAttempt(task,autonomousActionStrategy(action),'优化修复：'+action.message);
    task.report=priorReport;
    if(stop){stopOptimization(task,store,stop,['查看重复修复路径与独立报告，补充新条件后恢复。']);return;}
    if(run.noImprovement>=2){
      if(task.autonomy.checkpoint.diagnosticRequired){
        task.autonomy.checkpoint.diagnosticRequired=false;
        if(task.autonomy.history.diagnostics>=task.autonomy.policy.maxDiagnostics){stopOptimization(task,store,'有限诊断与换策后仍无实质改善，停止自动修复。',['查看诊断、原站和各轮独立证据，补齐新的修复条件后恢复。']);return;}
      }else{
        task.autonomy.history.diagnostics++;task.autonomy.checkpoint.diagnosticRequired=true;
        task.status='following-up';task.followup!.state='waiting';task.followup!.nextAt=task.autonomy.checkpoint.nextAt||Date.now();store.put(task);store.event(task.id,'连续两轮无改善：保留当前版本，先诊断新路径，再安排修复。');return;
      }
    }
  }
  const budget=optimizationBudgetReason(task,store);if(budget){stopOptimization(task,store,budget,['查看费用明细并核算预算。']);return;}
  const limit=roundLimit(task);if(limit!==undefined&&round.number>=limit){stopOptimization(task,store,'已达到最多修复轮数。');return;}
  const migration=migrationRepairContext(task,store);
  const target=collectionTargetRepairContext(store.task(run.reportId||'')?.report?.collectionTarget);
  const original=store.task(round.generationTaskId);if(!original?.generation?.prepared||!original.generation.conversationId||!original.stopped&&!(original.id===task.id&&task.followup?.executionStopped))throw new Conflict('缺少已停止且可继续的原 Kooboo 会话');
  if(collecting&&(['sending','accepted'].includes(original.generation.deliveryState||'')||original.generation.next))throw new Conflict('原委托仍未确认结束，不能启动来源回采与新修复');
  const originalGeneration=original.generation;
  store.db.transaction(()=>{
    const child=store.create({resourceIds:[task.resourceId],kind:'generation',scope:task.scope,environmentId:task.environmentId,generatedSiteId:task.generatedSiteId!,requirements:action.message!,parentId:task.id,versionId:task.versionId,ruleSnapshot:task.rule!,optimizationRootId:task.id,optimizationRound:round.number+1},settings)[0];
    // Independent review can add verified source identities. Carry that exact
    // contract forward; inheriting the older root silently loses those keys.
    const evaluation=store.task(run.reportId||'');
    if(evaluation?.requirementsId&&evaluation.requirementsId!==child.requirementsId){
      if(evaluation.versionId!==child.versionId||evaluation.generatedSiteId!==child.generatedSiteId||evaluation.collectionVersionId!==child.collectionVersionId||evaluation.siteRevision!==run.currentRevision)throw new Conflict('修复清单与当前评测输入、资料或站点修订不一致');
      const manifests=new ManifestStore(store),reviewed=manifests.get(evaluation.requirementsId);
      if(!reviewed)throw new Conflict('独立评测的交付清单来源无效');
      if(reviewed.taskId===evaluation.id){
        const {sourceComplete,limitations,items,evidence,migration}=reviewed;
        const adopted=manifests.save(child,{sourceComplete,limitations,items,evidence,...(migration?{migration}:{})},'ai',child.requirementsId||'');
        task.requirementsId=adopted.id;
      }else{
        // A historical evaluation may inherit an earlier generation manifest.
        // Keep the root's newer frozen baseline (for example, a registered
        // migration profile), without allowing an unrelated task's contract.
        const seen=new Set<string>();let ancestor=evaluation.parentId?store.task(evaluation.parentId):undefined;
        while(ancestor&&ancestor.id!==reviewed.taskId&&!seen.has(ancestor.id)){
          seen.add(ancestor.id);ancestor=ancestor.parentId?store.task(ancestor.parentId):undefined;
        }
        if(!ancestor||ancestor.id!==reviewed.taskId||ancestor.versionId!==evaluation.versionId||ancestor.generatedSiteId!==evaluation.generatedSiteId||ancestor.scope!==evaluation.scope)throw new Conflict('独立评测的交付清单来源无效');
      }
    }
    child.message=`在原站原会话完成以下修复，不新建站点。范围：${task.scope}。${optimizationScenarioGuidance(task.scenario)}保持原内容事实、已完成区域和另一视口。\n\n${action.message}${migration?.message||''}`;
    if(collecting)child.message+='\n\n本轮先返回A段定向补采并独立复核、冻结新资料版本。原目标和验收范围保持固定。补采目标：'+JSON.stringify(objective)+'\nA段通过后，重新导入新冻结资料及映射，再向原站原会话明确发送上述补资料与修复委托；不能用上一轮完成回执直接交评测。';
    if(target)child.message+='\nB段程序核验定向修复依据：'+JSON.stringify(target);
    child.model=task.model;child.siteRevision=randomUUID();
    child.generation={...originalGeneration,next:{action:'continue',reason:action.reason,evidence:action.evidence,message:child.message}};
    if(collecting){child.generation.prepared=false;child.generation.importedMaterials={...originalGeneration.importedMaterials};collections!.requestRevision(child,objective!);}
    if(action.imageEvidence?.length)child.repairEvidence={reportId:run.reportId!,files:action.imageEvidence};store.put(child);
    run.rounds.push({number:round.number+1,revision:child.siteRevision,generationTaskId:child.id,sourceReportId:run.reportId!,brief:child.message,images:action.imageEvidence,startedAt:Date.now()});
    run.currentRevision=child.siteRevision;run.reportId=null;run.activeTaskId=child.id;run.state='repairing';task.evaluationTaskId=undefined;
    task.status='completed';task.error='';task.stage='optimization';if(task.followup)task.followup.state='resolved';
    store.put(task);store.event(task.id,`${collecting?'定向补采后修复':'修复'} ${round.number+1} 已入队：${child.id}；旧报告保留为历史，当前版本待复评。`);
  });
}
