import type { AutomationTask, FollowupAction } from '../../shared/automation.js';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { executeGeneration } from './generator.js';
import { EvaluationSliceYield, FollowupRuntimeError, Pending, UnconfirmedStop } from './errors.js';
import { executeDelivery, queueDelivery } from './delivery.js';
import { executeEvaluation } from './evaluator.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { executeFollowup, type FollowupExecute } from './followup.js';
import { advanceOptimization, applyOptimizationAction, optimizationBudgetReason, stopOptimization } from './optimization.js';
import { ModelBudgetExceeded } from './request-budget.js';
import { ExperienceStore } from './experience-store.js';
import { queueReflection, reflectExperience, selectExperience } from './experience.js';
import { cleanupGenerationContext } from './generation-context.js';
import { trimTaskGenerationBrowserCache } from './generation-cache.js';
import { koobooClient } from './kooboo.js';
import { autonomousActionStrategy, autonomousReady, autonomousWindowRemaining, canReplayGeneration, followupAccountState, isAutonomousRetry, isModelBillingOrAuthError, nextAutonomousWindow, recordAutonomousAttempt } from './autonomy.js';
import { inMaintenance } from '../updates/maintenance.js';
import { rememberSiteRetry, siteRetryBlocked } from './retry-guard.js';
import { optimizationEvidence } from './optimization-evidence.js';
export type Execute=(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal)=>Promise<void>;
export function syncReflectionCandidates(store:AutomationStore,experiences=new ExperienceStore(store)){
  for(const id of store.reflectionCandidates()){
    const header=store.header(id);if(!header)continue;
    const parentHeader=header.parentId?store.header(header.parentId):undefined;
    const rootHeader=header.optimizationRootId?store.header(header.optimizationRootId):parentHeader?.optimization?parentHeader:parentHeader?.optimizationRootId?store.header(parentHeader.optimizationRootId):header;
    if(rootHeader?.optimization&&!['completed','stopped'].includes(rootHeader.optimization.state))continue;
    const candidate=store.task(id,false);if(!candidate)continue;
    const root=store.root(candidate);
    if(root?.optimization){
      if(!['completed','stopped'].includes(root.optimization.state))continue;
      const latestReportId=root.optimization.reportId||[...root.optimization.rounds].reverse().map(r=>r.evaluationTaskId).find(evalId=>evalId&&store.header(evalId)?.report);
      if(candidate.kind==='evaluation'&&candidate.report&&!candidate.interruption&&latestReportId&&latestReportId!==candidate.id){
        const key=header.reflectionKey;
        if(key){
          const skipped=experiences.enqueue(candidate,'evaluation','reflection',key);
          if(skipped.status==='queued'){skipped.status='completed';skipped.reason='跳过复盘：自动优化工作流已产生更新轮次报告，仅对终态结果复盘。';experiences.put(skipped);}
        }
        continue;
      }
    }
    queueReflection(candidate,store);
  }
}
export class AutomationWorker{
  private timer?:ReturnType<typeof setInterval>;
  private running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stopping=false;
  private ticking=false;
  private learning=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private learningReady=false;
  private lockId=randomUUID();
  private lockHeld=false;
  onOwnershipChanged?:()=>void;
  ownedIds(){return [...new Set([...this.running.keys(),...this.learning.keys()])];}
  private own(id:string,item:{controller:AbortController;promise:Promise<void>}){this.running.set(id,item);this.onOwnershipChanged?.();}
  private release(id:string,controller?:AbortController){if(!controller||this.running.get(id)?.controller===controller){this.running.delete(id);this.onOwnershipChanged?.();}}
  constructor(readonly store:AutomationStore,private vault:Vault,private directory:string,private execute:{generation:Execute;evaluation:Execute}={generation:executeGeneration,evaluation:executeEvaluation},private browserReady=()=>existsSync(chromium.executablePath()),private followupExecute:FollowupExecute=executeFollowup,private reflect:typeof reflectExperience=reflectExperience){}
  start(){
    if(this.timer)return;
    const lock=resolve(this.directory,'automation-worker.lock');
    const acquire=()=>writeFileSync(lock,JSON.stringify({id:this.lockId,pid:process.pid}),{flag:'wx',mode:0o600});
    try{acquire();}catch(error){
      if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;
      const previous=JSON.parse(readFileSync(lock,'utf8'));
      let alive=true;try{process.kill(previous.pid,0);}catch(reason){if((reason as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
      if(alive)throw new Error('此数据目录已有自动化执行服务，请使用现有服务');
      unlinkSync(lock);acquire();
    }
    this.lockHeld=true;this.stopping=false;this.store.recover();for(const task of this.store.tasks().filter(t=>t.status==='pending'&&!t.stopped)){if(this.vault.automation().followup.enabled)this.store.scheduleFollowup(task,this.vault.automation().followup);}this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();void this.tick();
  }
  async tick(){
    if(this.stopping||this.ticking||inMaintenance(this.directory))return;this.ticking=true;
    try{
      const settings=this.vault.automation();if(!settings.enabled)return;
      for(const header of this.store.headers().filter(t=>t.optimization&&!['completed','stopped','planning'].includes(t.optimization.state)&&t.stopped&&!['following-up','pending','interrupted','cancelled','cancelling'].includes(t.status)&&!this.running.has(t.id))){
        const root=this.store.task(header.id,false)!;
        try{advanceOptimization(root,this.store,settings);}catch(error){stopOptimization(root,this.store,'优化调度无法继续：'+(error as Error).message,['查看执行记录，核实站点、原会话与报告。']);}
      }
      // Executor-injected test workers do not start real model side effects.
      if(settings.learning?.collect&&((this.execute.generation===executeGeneration&&this.execute.evaluation===executeEvaluation)||this.reflect!==reflectExperience)){
        const experiences=new ExperienceStore(this.store);
        if(!this.learningReady){experiences.recover();this.learningReady=true;}
        syncReflectionCandidates(this.store,experiences);
        const limit=settings.learning?.concurrency||1;
        while(this.learning.size<limit){const run=experiences.claim(run=>{if(this.learning.has(run.id))return false;const root=this.store.task(run.workflowId);return !!root&&(!root.optimization||['completed','stopped'].includes(root.optimization.state))&&!this.store.workflowIds(root).some(id=>{const t=this.store.task(id);return t&&(!t.stopped||['queued','following-up'].includes(t.status));});});if(!run)break;const controller=new AbortController();const promise=this.reflect(run,this.store,this.vault,this.directory,controller.signal).catch(error=>{run.status='failed';run.reason=(error as Error).message;experiences.put(run);}).finally(()=>{this.learning.delete(run.id);this.onOwnershipChanged?.();if(!this.stopping)void this.tick();});this.learning.set(run.id,{controller,promise});this.onOwnershipChanged?.();}
      }
      for(const kind of ['generation','evaluation'] as const){
        const limit=kind==='generation'?settings.generationConcurrency:settings.evaluationConcurrency;
        for(let i=0;i<limit;i++){
          const task=this.store.claim(kind,limit,t=>!this.running.has(t.id)&&autonomousReady(t));if(!task)break;
          const controller=new AbortController();
          const promise=this.run(task,controller,settings.timeoutMinutes).finally(()=>{this.release(task.id,controller);if(!this.stopping)void this.tick();});
          this.own(task.id,{controller,promise});
        }
      }
      for(let i=0;i<settings.followup.concurrency;i++){
        const task=this.store.claimFollowup(settings.followup.concurrency,t=>!this.running.has(t.id)&&autonomousReady(t));if(!task)break;
        const controller=new AbortController();const promise=this.runFollowup(task,controller).finally(()=>{this.release(task.id,controller);if(!this.stopping)void this.tick();});
        this.own(task.id,{controller,promise});
      }
      if(![...this.running.keys()].some(id=>{const task=this.store.header(id);return task?.delivery&&['running','verifying'].includes(task.delivery.status);})){
        const headers=this.store.headers();
        const candidate=headers.toReversed().find(t=>t.delivery?.status==='queued'&&(t.delivery.nextAt||0)<=Date.now()&&!this.running.has(t.id)&&!this.store.domainReserved(t.generatedSiteId)&&!headers.some(other=>other.id!==t.id&&other.generatedSiteId===t.generatedSiteId&&!other.stopped));
        const task=candidate?this.store.task(candidate.id,false):undefined;
        if(task){const controller=new AbortController();task.delivery!.status=task.delivery!.target?'verifying':'running';task.delivery!.stopped=false;this.store.put(task);const promise=this.runDelivery(task,controller).finally(()=>{this.release(task.id);if(!this.stopping)void this.tick();});this.own(task.id,{controller,promise});}
      }
    }finally{this.ticking=false;}
  }
  cancel(id:string):Promise<void>{
    const running=this.running.get(id),learning=this.learning.get(id);
    running?.controller.abort(new Error('任务已请求取消'));
    learning?.controller.abort(new Error('操作者已强制中断本次经验学习'));
    const pending=[running?.promise,learning?.promise].filter((p):p is Promise<void>=>Boolean(p));
    if(!pending.length)return Promise.resolve();
    return Promise.race([Promise.allSettled(pending).then(()=>{}),new Promise<void>(r=>{const t=setTimeout(r,5000);t.unref();})]);
  }
  owns(id:string){return this.running.has(id)||this.learning.has(id);}
  private interrupt(task:AutomationTask,reason:string,nextSteps:string[],evidence:string[]=[]) {
    this.store.interrupt(task,{reason,evidence,attempted:this.store.events(task.id).filter(e=>/AI 决策|工具失败|执行失败|重试/.test(e.message)).slice(-12).map(e=>e.message),nextSteps,resumeFrom:task.generatedSiteId?'沿用当前生成站、输入版本和已保存证据，从当前阶段继续。':'确认环境及建站结果后，从资料准备阶段继续。'});
    if(task.optimization){task.optimization.state='stopped';task.optimization.reason=reason;task.optimization.nextSteps=nextSteps;task.optimization.stoppedAt=Date.now();this.store.put(task);}
  }
  private recoverTask(task:AutomationTask) {
    if(isModelBillingOrAuthError(task.error)){
      this.interrupt(task,task.error,['请检查模型账户余额、额度及服务配置，确认恢复后再点击“恢复任务”。']);
      return;
    }
    const policy=task.followup?.policy||this.vault.automation().followup;
    if(policy.enabled)this.store.scheduleFollowup(task,policy);
    else this.interrupt(task,task.error,['在系统设置启用 AI 跟进，或补齐问题条件后点击“AI 接管 / 恢复”。']);
  }
  private retainCollectionShutdown(task:AutomationTask) {
    const preCreate=(value:AutomationTask|undefined)=>!!value?.autonomy&&value.kind==='generation'&&value.scope==='site'&&['migration','upgrade'].includes(value.scenario)&&!!value.collectionId&&!value.generatedSiteId&&!value.generation?.createAttempted&&!value.generation?.legacySubmitted&&!value.generation?.deliveryId&&!value.generation?.conversationId&&!value.generation?.runId&&!value.generation?.prepared&&!['sending','accepted'].includes(value.generation?.deliveryState||'');
    const current=this.store.task(task.id);
    if(!this.stopping||!task.stopped||!preCreate(task)||!preCreate(current)||current?.collectionId!==task.collectionId)return false;
    task.status='queued';task.error='采集执行服务停止；已保留批次、进程身份和检查点，恢复时先核对原操作回执再接续。';
    if(task.followup)task.followup.state='resolved';
    this.store.put(task);this.store.event(task.id,task.error);return true;
  }
  private autonomousRecovery(task:AutomationTask, reason:unknown, followup=false) {
    if(!task.autonomy||this.stopping)return false;
    const detail=reason instanceof Error?reason.message:'本轮执行需要恢复';
    const collection=reason as {name?:string;safeToRetry?:boolean;nextAt?:number;waiting?:boolean;progressKey?:string;nextSteps?:string[]};
    if(collection.name==='CollectionBlocked'){this.interrupt(task,detail,collection.nextSteps||['补齐原站采集所需外部条件后恢复原任务。']);return true;}
    if(!isAutonomousRetry(reason)&&!(followup&&reason instanceof Error&&!(reason instanceof FollowupRuntimeError)&&!(reason instanceof UnconfirmedStop)&&!isModelBillingOrAuthError(reason)))return false;
    if(!task.stopped)return false;
    if(followup&&reason instanceof ModelBudgetExceeded&&followupAccountState(task,this.store).active){this.interrupt(task,detail,['仍有模型请求执行中，请等待当前执行结束后恢复。']);return true;}
    const waiting=collection.name==='CollectionPending'&&collection.waiting===true;
    const stop=waiting?'':recordAutonomousAttempt(task,followup?'followup-recovery':task.stage||task.kind,detail,Date.now(),collection.name==='CollectionPending'?collection.progressKey:undefined);
    if(waiting&&collection.progressKey)task.autonomy.checkpoint.progressKey=collection.progressKey;
    if(stop){this.interrupt(task,stop,['查看保存的检查点、重复失败与已尝试策略；提供新条件或新的有证据路径后恢复。']);return true;}
    if(collection.name==='CollectionPending'&&collection.safeToRetry){
      task.autonomy.checkpoint.nextAt=Math.max(task.autonomy.checkpoint.nextAt||0,collection.nextAt||0);
      task.status='queued';this.store.put(task);this.store.event(task.id,'原站采集检查点已保留，按已保存时间自动接续：'+detail);return true;
    }
    if(followup){
      if(reason instanceof ModelBudgetExceeded)nextAutonomousWindow(task);
      task.status='following-up';task.followup!.state='waiting';task.followup!.nextAt=task.autonomy.checkpoint.nextAt||Date.now();this.store.put(task);
    }else if(canReplayGeneration(task)){
      task.status='queued';this.store.put(task);
    }else{
      this.recoverTask(task);
      if(task.followup){task.followup.nextAt=task.autonomy.checkpoint.nextAt||Date.now();this.store.put(task);}
    }
    this.store.event(task.id,'已保留原站、会话、累计用量与检查点，退避后接续：'+detail);return true;
  }
  private async run(task:AutomationTask,controller:AbortController,timeout:number){
    let timer:ReturnType<typeof setTimeout>|undefined;
    const armTimer=()=>{
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>controller.abort(new Pending('本轮执行达到时限，需要核对当前成果后继续')),timeout*60000);
      timer.unref();
    };
    const readBatchProgress=()=>{
      if(task.kind!=='evaluation')return '0:0:0';
      try{
        const row=this.store.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(rowid),0) AS lastRow, COALESCE(MAX(updated_at),0) AS latest FROM auto_template_review_batches WHERE task_id=?').get(task.id);
        return `${row?.count||0}:${row?.lastRow||0}:${row?.latest||0}`;
      }catch{
        try{
          const row=this.store.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(rowid),0) AS lastRow FROM auto_template_review_batches WHERE task_id=?').get(task.id);
          return `${row?.count||0}:${row?.lastRow||0}:0`;
        }catch{return '0:0:0';}
      }
    };
    let lastBatchProgress=readBatchProgress();
    armTimer();
    const heartbeat=setInterval(()=>{
      this.store.timing.heartbeat(task.id);
      if(task.kind==='evaluation'){
        const nextProgress=readBatchProgress();
        if(nextProgress!==lastBatchProgress){lastBatchProgress=nextProgress;armTimer();}
      }
    },1000);heartbeat.unref();
    try{
      const budget=optimizationBudgetReason(task,this.store);
      if(budget){task.stopped=true;task.status='cancelled';task.error=budget;this.store.put(task);const root=this.store.root(task);if(root?.optimization)stopOptimization(root,this.store,budget,['查看费用与用量，核算预算后再决定后续任务。']);return;}
      if(!this.browserReady())throw new Error('浏览器执行环境尚未安装，请安装 Playwright Chromium');
      await this.execute[task.kind](task,this.store,this.vault,this.directory,controller.signal);
      const saved=this.store.task(task.id);if(task.optimization&&saved?.optimization?.stoppedAt)task.optimization=saved.optimization;
      task.stopped=true;
      if(['cancelling','cancelled'].includes(this.store.task(task.id)?.status||'')){task.status='cancelled';task.error='';this.store.noteCancelledSiteChange(task);}
      else{
        task.status='completed';task.error='';
        if(task.followup)task.followup.state='resolved';
        if(task.kind==='evaluation')this.store.publishSiteReport(task);
        if(task.kind==='generation'&&(task.optimization||task.optimizationRootId||this.vault.automation().autoEvaluate)&&(!this.store.root(task)?.optimization||!['stopped','completed'].includes(this.store.root(task)!.optimization!.state))){task.stage='handoff';this.store.ensureEvaluation(task,this.vault.automation());}
        else this.store.notice(task,task.kind==='evaluation'?'评测报告已完成':'生成已结束',task.resourceName+(task.kind==='evaluation'?'：查看本轮报告、问题与证据。':'：自动评测已关闭。'));
      }
      this.store.put(task);this.store.event(task.id,task.status==='cancelled'?'任务已取消':'本阶段执行已结束');
      if(task.kind==='evaluation'&&task.status==='completed'){const delivery=this.vault.get().environments.find(e=>e.id===task.environmentId)?.delivery;if(delivery?.enabled&&delivery.auto&&task.scope==='site'&&['migration','upgrade'].includes(task.scenario)){try{queueDelivery(task,this.store,this.vault);}catch(error){this.store.notice(task,'自动交付未启动',(error as Error).message);}}}
    }catch(error){
      task.stopped=!(error instanceof UnconfirmedStop);
      const reason=error instanceof UnconfirmedStop?error:controller.signal.reason||error;
      if(['cancelling','cancelled'].includes(this.store.task(task.id)?.status||'')){
        task.error=reason instanceof Error?reason.message:'执行失败，需要查证当前任务';this.store.event(task.id,task.error);
        if(task.stopped){task.status='cancelled';this.store.noteCancelledSiteChange(task);this.store.put(task);}
        else this.interrupt(task,task.error,['检查原执行浏览器 / 会话，确认已停止后释放名额。']);
      }else if(reason instanceof EvaluationSliceYield&&task.stopped&&!this.stopping){
        task.status='queued';task.error='';
        if(task.followup)task.followup.executionStopped=true;
        this.store.put(task);this.store.event(task.id,reason.message);
      }else{
        task.error=reason instanceof Error?reason.message:'执行失败，需要查证当前任务';this.store.event(task.id,task.error);
        if(this.retainCollectionShutdown(task)){}
        else if(this.autonomousRecovery(task,reason)){}
        else if(reason instanceof FollowupRuntimeError)this.interrupt(task,task.error,reason.nextSteps);
        else this.recoverTask(task);
      }
    }finally{
      clearInterval(heartbeat);
      if(timer)clearTimeout(timer);
      if(task.kind==='generation'&&task.stopped&&['completed','cancelled'].includes(task.status))
        await trimTaskGenerationBrowserCache(this.directory,task.id,()=>this.store.event(task.id,'生成浏览器已关闭；可再生缓存未能全部清理，将在后续维护时重试。'));
      // A confirmed cancellation may clean only this task's registered copies.
      // Interruptions retain files; they may still be needed for recovery.
      if(task.kind==='generation'&&task.status==='cancelled'&&task.stopped&&task.generatedSiteId){
        const site=this.store.site(task.generatedSiteId);
        if(site)try{await cleanupGenerationContext(task,this.store,koobooClient(task,this.vault,AbortSignal.timeout(30000)).request,site.siteId,true);}catch(error){this.store.event(task.id,'取消后的临时资料待清理：'+(error as Error).message);}
      }
    }
  }
  private async runDelivery(task:AutomationTask,controller:AbortController){
    const finishTiming=this.store.timing.activity(task.id,'delivery');
    let unconfirmed=false;const delivery=task.delivery!;delivery.attempts=(delivery.attempts||0)+1;this.store.put(task);
    const timer=setTimeout(()=>controller.abort(new Error('交付执行达到本轮时限')),(delivery.policy.timeoutSeconds+this.vault.automation().timeoutMinutes*60)*1000);timer.unref();
    try{await executeDelivery(task,this.store,this.vault,this.directory,controller.signal);this.store.notice(task,delivery.status==='completed'?'交付核验完成':'交付需要核查',delivery.error||'目标站与独立交付核验证据已保存。');}
    catch(error){unconfirmed=error instanceof UnconfirmedStop;delivery.error=(error instanceof Error?error.message:'交付失败')+'；源站报告保留。';
      if(!unconfirmed&&delivery.target&&(delivery.attempts||0)<3&&!controller.signal.aborted&&!this.stopping){delivery.status='queued';delivery.nextAt=Date.now()+10000;this.store.event(task.id,'保留目标回执，稍后恢复原交付核验会话：'+delivery.error);}
      else{delivery.status=delivery.target?'failed':delivery.attemptedAt?'uncertain':'failed';this.store.notice(task,'交付已中断',delivery.error+' 请检查迁移回执、目标连接或核验证据后恢复核验。');}
    }finally{finishTiming();clearTimeout(timer);delivery.stopped=!unconfirmed;delivery.updatedAt=Date.now();this.store.put(task);}
  }
  private async runFollowup(task:AutomationTask,controller:AbortController){
    if(siteRetryBlocked(task,this.store)){task.stopped=task.followup?.executionStopped??task.stopped;this.interrupt(task,'同一生成执行的失败终态没有变化，已停止重复 retry。',['查看当前 run 的具体失败原因，补齐条件或使用有明确新消息的同站继续生成；原站、证据和用量均已保留。']);return;}
    const followup=task.followup!;const policy=followup.policy;
    if(task.scenario==='site-template'&&task.kind==='evaluation'&&!followup.executionStopped){
      task.stopped=false;
      this.interrupt(task,'原评测执行尚未确认停止，自动跟进无法安全重试。',['检查原评测进程，确认停止后点击“已检查并确认原执行停止”，再恢复原任务；保留已有证据和未知用量。']);
      return;
    }
    followup.budgetId||=randomUUID();this.store.put(task);
    let window=autonomousWindowRemaining(task);
    const account=task.autonomy?followupAccountState(task,this.store):undefined;
    if(account?.active){task.stopped=followup.executionStopped;this.interrupt(task,'仍有模型请求执行中，请等待当前执行结束后恢复。',['等待当前执行结束后恢复原任务。']);return;}
    if(task.autonomy&&(window.attempts<=0||window.tokens<=0||window.milliseconds<=0||account&&(!account.active&&(account.spent>=policy.maxTokens||account.requests>=(policy.maxRequests||80))))){
      const stop=recordAutonomousAttempt(task,'followup-window','普通执行窗口已结束，保存累计用量并继续原目标');
      if(stop){task.stopped=followup.executionStopped;this.interrupt(task,stop,['查看当前目标、检查点与无进展历史，补齐新路径后恢复。']);return;}
      nextAutonomousWindow(task);window=autonomousWindowRemaining(task);this.store.put(task);
      this.store.event(task.id,`跟进软窗口 ${task.autonomy.window.index+1} 已开启；累计尝试、活动时间和用量保留。`);
    }
    const remaining=window.milliseconds;
    const overBudget=window.attempts<=0||window.tokens<=0||remaining<=0;
    const cost=optimizationBudgetReason(task,this.store);
    if(cost){task.stopped=followup.executionStopped;const root=this.store.root(task);if(root?.optimization){if(root.id!==task.id)this.interrupt(task,cost,['查看费用明细，核算后再决定后续任务。']);stopOptimization(root,this.store,cost,['查看费用明细，核算后再决定后续任务。']);}else this.interrupt(task,cost,['查看费用明细，核算后再决定后续任务。']);return;}
    if(overBudget){task.stopped=followup.executionStopped;this.interrupt(task,'AI 跟进已达到配置的次数、时间或 token 预算，当前流程仍未完成。',['查看 AI 跟进记录和原始问题；补齐条件或调整预算后点击“AI 接管 / 恢复”。'],followup.observations);return;}
    const monotonicStart=performance.now(),windowAtStart=task.autonomy?.window.index,followupWindowAtStart=followup.window?.index;const activeStart=Date.now();followup.activeStartedAt=activeStart;followup.activeHeartbeatAt=activeStart;followup.activeElapsedMs=0;
    const heartbeat=setInterval(()=>{followup.activeHeartbeatAt=Date.now();followup.activeElapsedMs=Math.max(0,Math.round(performance.now()-monotonicStart));this.store.put(task);},1000);heartbeat.unref();
    const timer=setTimeout(()=>controller.abort(new Error('AI 跟进达到累计时间预算')),remaining);timer.unref();
    try{
      if(task.optimization?.state==='planning')optimizationEvidence(task,this.store,this.directory);
      await selectExperience(task,'followup',this.store,this.vault,this.directory,controller.signal);
      followup.attempts++;this.store.put(task);this.store.event(task.id,`AI 跟进第 ${followup.attempts} 次，阶段：${task.stage||task.kind}`);
      const action=await this.followupExecute(task,this.store,this.vault,this.directory,controller.signal);
      if(['cancelling','cancelled'].includes(this.store.task(task.id)?.status||'')){task.stopped=followup.executionStopped;if(task.stopped){task.status='cancelled';this.store.put(task);if(task.kind==='generation')await trimTaskGenerationBrowserCache(this.directory,task.id);}else this.interrupt(task,'取消时原执行仍未确认停止。',['检查原执行并确认停止后释放名额。']);return;}
      controller.signal.throwIfAborted();task.stopped=followup.executionStopped;followup.lastAction=action;
      this.applyAction(task,action);
      if(task.kind==='generation'&&task.stopped&&task.status==='completed')await trimTaskGenerationBrowserCache(this.directory,task.id);
    }catch(error){
      task.stopped=error instanceof UnconfirmedStop?false:followup.executionStopped;
      const reason=controller.signal.reason||error;const detail=reason instanceof Error?reason.message:'跟进 Agent 执行失败';
      this.store.event(task.id,'AI 跟进未完成：'+detail);
      if(['cancelling','cancelled'].includes(this.store.task(task.id)?.status||'')&&task.stopped){task.status='cancelled';this.store.put(task);if(task.kind==='generation')await trimTaskGenerationBrowserCache(this.directory,task.id);}
      else if(['cancelling','cancelled'].includes(this.store.task(task.id)?.status||'')){this.interrupt(task,'取消时原执行仍未确认停止：'+detail,['检查原执行并确认停止后释放名额。']);}
      else if(error instanceof UnconfirmedStop){followup.executionStopped=false;this.interrupt(task,detail,['确认原浏览器已停止后释放名额，再恢复本任务。'],followup.observations);}
      else if(this.retainCollectionShutdown(task)){}
      else if(this.autonomousRecovery(task,reason,true)){}
      else if(isModelBillingOrAuthError(reason)){this.interrupt(task,detail,['请检查模型账户余额、额度及服务配置，确认恢复后再点击“恢复任务”。'],followup.observations);}
      else if(error instanceof ModelBudgetExceeded){this.interrupt(task,detail,['检查用量、未知请求及预算配置，确认后再恢复。恢复不会清零已用额度。'],followup.observations);}
      else if(error instanceof FollowupRuntimeError){this.interrupt(task,detail,error.nextSteps,followup.observations);}
      else if(!this.stopping&&autonomousWindowRemaining(task).attempts<=0){this.interrupt(task,`${task.error}；AI 跟进未能继续：${detail}`,['查看跟进记录，检查模型连接、环境及任务条件，处理后恢复本任务。'],followup.observations);}
      else{task.status='following-up';followup.state='waiting';followup.nextAt=Date.now()+5000;this.store.put(task);}
    }finally{clearTimeout(timer);clearInterval(heartbeat);const elapsed=Math.max(0,Math.round(performance.now()-monotonicStart));followup.elapsedMs=(followup.elapsedMs||0)+elapsed;if(task.autonomy&&task.autonomy.window.index!==windowAtStart)task.autonomy.window.elapsedMsBase+=elapsed;if(followup.window&&followup.window.index!==followupWindowAtStart)followup.window.elapsedMsBase+=elapsed;delete followup.activeStartedAt;delete followup.activeHeartbeatAt;delete followup.activeElapsedMs;this.store.put(task);}
  }
  private applyAction(task:AutomationTask,action:FollowupAction){
    const followup=task.followup!;
    if(task.optimization?.state==='planning'){
      applyOptimizationAction(task,action,this.store,this.vault.automation(),this.directory);return;
    }
    if(action.action==='interrupt'){this.interrupt(task,action.reason,action.nextSteps||['检查当前任务条件后恢复。'],action.evidence);return;}
    if(task.autonomy){
      const stop=recordAutonomousAttempt(task,autonomousActionStrategy(action),'已核对当前执行并安排 '+action.action);
      if(stop){this.interrupt(task,stop,['查看重复恢复操作和已有证据，补齐新的恢复路径后继续。'],action.evidence);return;}
    }
    if(action.action==='wait'){task.status='following-up';followup.state='waiting';followup.nextAt=Date.now()+(action.waitSeconds||30)*1000;this.store.put(task);return;}
    if(!followup.executionStopped)throw new Error('原执行停止尚未确认，不能重试或交接');
    if(action.action==='evaluate'){
      task.generation={...task.generation,deliveryState:'completed',state:'completed'};task.stage='handoff';
      this.store.ensureEvaluation(task,this.vault.automation());task.status='completed';task.error='';followup.state='resolved';
    }else{
      if(action.action==='retry')rememberSiteRetry(task,this.store);
      if(action.action==='continue'||action.action==='answer')task.generation={...task.generation,next:action};
      task.status='queued';followup.state='resolved';
    }
    this.store.put(task);this.store.event(task.id,`AI 已安排 ${action.action}：${action.reason}`);
  }
  async stop(){this.stopping=true;for(const item of this.learning.values())item.controller.abort(new Pending('服务正在停止，经验队列保留用量和已写入版本'));await Promise.allSettled([...this.learning.values()].map(r=>r.promise));if(this.timer)clearInterval(this.timer);this.timer=undefined;for(const item of this.running.values())item.controller.abort(new Pending('服务正在停止，原委托需要检查后继续'));await Promise.allSettled([...this.running.values()].map(r=>r.promise));if(this.lockHeld){const lock=resolve(this.directory,'automation-worker.lock');try{if(JSON.parse(readFileSync(lock,'utf8')).id===this.lockId)unlinkSync(lock);}finally{this.lockHeld=false;}}}
}
