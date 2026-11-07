import type { AutomationTask, FollowupAction } from '../../shared/automation.js';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { executeGeneration } from './generator.js';
import { FollowupRuntimeError, Pending, UnconfirmedStop } from './errors.js';
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
export type Execute=(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal)=>Promise<void>;
export class AutomationWorker{
  private timer?:ReturnType<typeof setInterval>;
  private running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stopping=false;
  private ticking=false;
  private learning=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private learningReady=false;
  private lockId=randomUUID();
  private lockHeld=false;
  constructor(readonly store:AutomationStore,private vault:Vault,private directory:string,private execute:{generation:Execute;evaluation:Execute}={generation:executeGeneration,evaluation:executeEvaluation},private browserReady=()=>existsSync(chromium.executablePath()),private followupExecute:FollowupExecute=executeFollowup){}
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
    if(this.stopping||this.ticking)return;this.ticking=true;
    try{
      const settings=this.vault.automation();if(!settings.enabled)return;
      for(const root of this.store.tasks().filter(t=>t.optimization&&!this.running.has(t.id))){
        try{advanceOptimization(root,this.store,settings);}catch(error){stopOptimization(root,this.store,'优化调度无法继续：'+(error as Error).message,['查看执行记录，核实站点、原会话与报告。']);}
      }
      // Executor-injected test workers do not start real model side effects.
      if(this.execute.generation===executeGeneration&&this.execute.evaluation===executeEvaluation){
        const experiences=new ExperienceStore(this.store);
        if(!this.learningReady){experiences.recover();this.learningReady=true;}
        for(const task of this.store.tasks().filter(t=>t.learningPolicy?.collect&&t.stopped&&(t.report&&t.status==='completed'||t.interruption&&t.status==='interrupted')))queueReflection(task,this.store);
        const limit=settings.learning?.concurrency||1;
        while(this.learning.size<limit){const run=experiences.claim(run=>{if(this.learning.has(run.id))return false;const root=this.store.task(run.workflowId);return !!root&&(!root.optimization||['completed','stopped'].includes(root.optimization.state))&&!this.store.workflowIds(root).some(id=>{const t=this.store.task(id);return t&&(!t.stopped||['queued','following-up'].includes(t.status));});});if(!run)break;const controller=new AbortController();const promise=reflectExperience(run,this.store,this.vault,this.directory,controller.signal).catch(error=>{run.status='failed';run.reason=(error as Error).message;experiences.put(run);}).finally(()=>{this.learning.delete(run.id);if(!this.stopping)void this.tick();});this.learning.set(run.id,{controller,promise});}
      }
      for(const kind of ['generation','evaluation'] as const){
        const limit=kind==='generation'?settings.generationConcurrency:settings.evaluationConcurrency;
        for(let i=0;i<limit;i++){
          const task=this.store.claim(kind,limit,t=>!this.running.has(t.id));if(!task)break;
          const controller=new AbortController();
          const promise=this.run(task,controller,settings.timeoutMinutes).finally(()=>{if(this.running.get(task.id)?.controller===controller)this.running.delete(task.id);if(!this.stopping)void this.tick();});
          this.running.set(task.id,{controller,promise});
        }
      }
      for(let i=0;i<settings.followup.concurrency;i++){
        const task=this.store.claimFollowup(settings.followup.concurrency,t=>!this.running.has(t.id));if(!task)break;
        const controller=new AbortController();const promise=this.runFollowup(task,controller).finally(()=>{if(this.running.get(task.id)?.controller===controller)this.running.delete(task.id);if(!this.stopping)void this.tick();});
        this.running.set(task.id,{controller,promise});
      }
      if(![...this.running.keys()].some(id=>{const task=this.store.task(id);return task?.delivery&&['running','verifying'].includes(task.delivery.status);})){
        const task=this.store.tasks().toReversed().find(t=>t.delivery?.status==='queued'&&(t.delivery.nextAt||0)<=Date.now()&&!this.running.has(t.id)&&!this.store.tasks().some(other=>other.id!==t.id&&other.generatedSiteId===t.generatedSiteId&&!other.stopped));
        if(task){const controller=new AbortController();task.delivery!.status=task.delivery!.target?'verifying':'running';task.delivery!.stopped=false;this.store.put(task);const promise=this.runDelivery(task,controller).finally(()=>{this.running.delete(task.id);if(!this.stopping)void this.tick();});this.running.set(task.id,{controller,promise});}
      }
    }finally{this.ticking=false;}
  }
  cancel(id:string){this.running.get(id)?.controller.abort(new Error('任务已请求取消'));}
  owns(id:string){return this.running.has(id)||this.learning.has(id);}
  private interrupt(task:AutomationTask,reason:string,nextSteps:string[],evidence:string[]=[]) {
    this.store.interrupt(task,{reason,evidence,attempted:this.store.events(task.id).filter(e=>/AI 决策|工具失败|执行失败|重试/.test(e.message)).slice(-12).map(e=>e.message),nextSteps,resumeFrom:task.generatedSiteId?'沿用当前生成站、输入版本和已保存证据，从当前阶段继续。':'确认环境及建站结果后，从资料准备阶段继续。'});
    if(task.optimization){task.optimization.state='stopped';task.optimization.reason=reason;task.optimization.nextSteps=nextSteps;task.optimization.stoppedAt=Date.now();this.store.put(task);}
  }
  private recoverTask(task:AutomationTask) {
    const policy=task.followup?.policy||this.vault.automation().followup;
    if(policy.enabled)this.store.scheduleFollowup(task,policy);
    else this.interrupt(task,task.error,['在系统设置启用 AI 跟进，或补齐问题条件后点击“AI 接管 / 恢复”。']);
  }
  private async run(task:AutomationTask,controller:AbortController,timeout:number){
    const timer=setTimeout(()=>controller.abort(new Pending('本轮执行达到时限，需要核对当前成果后继续')),timeout*60000);timer.unref();
    try{
      const budget=optimizationBudgetReason(task,this.store);
      if(budget){task.stopped=true;task.status='cancelled';task.error=budget;this.store.put(task);const root=this.store.root(task);if(root?.optimization)stopOptimization(root,this.store,budget,['查看费用与用量，核算预算后再决定后续任务。']);return;}
      if(!this.browserReady())throw new Error('浏览器执行环境尚未安装，请安装 Playwright Chromium');
      await this.execute[task.kind](task,this.store,this.vault,this.directory,controller.signal);
      const saved=this.store.task(task.id);if(task.optimization&&saved?.optimization?.stoppedAt)task.optimization=saved.optimization;
      task.stopped=true;
      if(this.store.task(task.id)?.status==='cancelling'){task.status='cancelled';task.error='';}
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
      task.error=reason instanceof Error?reason.message:'执行失败，需要查证当前任务';this.store.event(task.id,task.error);
      if(this.store.task(task.id)?.status==='cancelling'){
        if(task.stopped){task.status='cancelled';this.store.put(task);}
        else this.interrupt(task,task.error,['检查原执行浏览器 / 会话，确认已停止后释放名额。']);
      }else this.recoverTask(task);
    }finally{clearTimeout(timer);}
  }
  private async runDelivery(task:AutomationTask,controller:AbortController){
    let unconfirmed=false;const delivery=task.delivery!;delivery.attempts=(delivery.attempts||0)+1;this.store.put(task);
    const timer=setTimeout(()=>controller.abort(new Error('交付执行达到本轮时限')),(delivery.policy.timeoutSeconds+this.vault.automation().timeoutMinutes*60)*1000);timer.unref();
    try{await executeDelivery(task,this.store,this.vault,this.directory,controller.signal);this.store.notice(task,delivery.status==='completed'?'交付核验完成':'交付需要核查',delivery.error||'目标站与独立交付核验证据已保存。');}
    catch(error){unconfirmed=error instanceof UnconfirmedStop;delivery.error=(error instanceof Error?error.message:'交付失败')+'；源站报告保留。';
      if(!unconfirmed&&delivery.target&&(delivery.attempts||0)<3&&!controller.signal.aborted&&!this.stopping){delivery.status='queued';delivery.nextAt=Date.now()+10000;this.store.event(task.id,'保留目标回执，稍后恢复原交付核验会话：'+delivery.error);}
      else{delivery.status=delivery.target?'failed':delivery.attemptedAt?'uncertain':'failed';this.store.notice(task,'交付已中断',delivery.error+' 请检查迁移回执、目标连接或核验证据后恢复核验。');}
    }finally{clearTimeout(timer);delivery.stopped=!unconfirmed;delivery.updatedAt=Date.now();this.store.put(task);}
  }
  private async runFollowup(task:AutomationTask,controller:AbortController){
    const followup=task.followup!;const policy=followup.policy;
    followup.budgetId||=randomUUID();this.store.put(task);
    const remaining=policy.maxMinutes*60000-(followup.elapsedMs||0);
    const overBudget=followup.attempts>=policy.maxAttempts||followup.tokens>=policy.maxTokens||remaining<=0;
    const cost=optimizationBudgetReason(task,this.store);
    if(cost){task.stopped=followup.executionStopped;const root=this.store.root(task);if(root?.optimization){if(root.id!==task.id)this.interrupt(task,cost,['查看费用明细，核算后再决定后续任务。']);stopOptimization(root,this.store,cost,['查看费用明细，核算后再决定后续任务。']);}return;}
    if(overBudget){task.stopped=followup.executionStopped;this.interrupt(task,'AI 跟进已达到配置的次数、时间或 token 预算，当前流程仍未完成。',['查看 AI 跟进记录和原始问题；补齐条件或调整预算后点击“AI 接管 / 恢复”。'],followup.observations);return;}
    await selectExperience(task,'followup',this.store,this.vault,this.directory,controller.signal);
    const monotonicStart=performance.now();const activeStart=Date.now();followup.activeStartedAt=activeStart;followup.activeHeartbeatAt=activeStart;followup.activeElapsedMs=0;
    const heartbeat=setInterval(()=>{followup.activeHeartbeatAt=Date.now();followup.activeElapsedMs=Math.max(0,Math.round(performance.now()-monotonicStart));this.store.put(task);},1000);heartbeat.unref();
    const timer=setTimeout(()=>controller.abort(new Error('AI 跟进达到本轮时间预算')),Math.min(remaining,5*60000));timer.unref();
    try{
      followup.attempts++;this.store.put(task);this.store.event(task.id,`AI 跟进第 ${followup.attempts} 次，阶段：${task.stage||task.kind}`);
      const action=await this.followupExecute(task,this.store,this.vault,this.directory,controller.signal);
      if(this.store.task(task.id)?.status==='cancelling'){task.stopped=followup.executionStopped;if(task.stopped){task.status='cancelled';this.store.put(task);}else this.interrupt(task,'取消时原执行仍未确认停止。',['检查原执行并确认停止后释放名额。']);return;}
      controller.signal.throwIfAborted();task.stopped=followup.executionStopped;followup.lastAction=action;
      this.applyAction(task,action);
    }catch(error){
      task.stopped=error instanceof UnconfirmedStop?false:followup.executionStopped;
      const reason=controller.signal.reason||error;const detail=reason instanceof Error?reason.message:'跟进 Agent 执行失败';
      this.store.event(task.id,'AI 跟进未完成：'+detail);
      if(this.store.task(task.id)?.status==='cancelling'&&task.stopped){task.status='cancelled';this.store.put(task);}
      else if(this.store.task(task.id)?.status==='cancelling'){this.interrupt(task,'取消时原执行仍未确认停止：'+detail,['检查原执行并确认停止后释放名额。']);}
      else if(error instanceof UnconfirmedStop){followup.executionStopped=false;this.interrupt(task,detail,['确认原浏览器已停止后释放名额，再恢复本任务。'],followup.observations);}
      else if(error instanceof ModelBudgetExceeded){this.interrupt(task,detail,['检查用量、未知请求及预算配置，确认后再恢复。恢复不会清零已用额度。'],followup.observations);}
      else if(error instanceof FollowupRuntimeError){this.interrupt(task,detail,error.nextSteps,followup.observations);}
      else if(!this.stopping&&followup.attempts>=policy.maxAttempts){this.interrupt(task,`${task.error}；AI 跟进未能继续：${detail}`,['查看跟进记录，检查模型连接、环境及任务条件，处理后恢复本任务。'],followup.observations);}
      else{task.status='following-up';followup.state='waiting';followup.nextAt=Date.now()+5000;this.store.put(task);}
    }finally{clearTimeout(timer);clearInterval(heartbeat);followup.elapsedMs=(followup.elapsedMs||0)+Math.max(0,Math.round(performance.now()-monotonicStart));delete followup.activeStartedAt;delete followup.activeHeartbeatAt;delete followup.activeElapsedMs;this.store.put(task);}
  }
  private applyAction(task:AutomationTask,action:FollowupAction){
    const followup=task.followup!;
    if(task.optimization?.state==='planning'){
      applyOptimizationAction(task,action,this.store,this.vault.automation());return;
    }
    if(action.action==='interrupt'){this.interrupt(task,action.reason,action.nextSteps||['检查当前任务条件后恢复。'],action.evidence);return;}
    if(action.action==='wait'){task.status='following-up';followup.state='waiting';followup.nextAt=Date.now()+(action.waitSeconds||30)*1000;this.store.put(task);return;}
    if(!followup.executionStopped)throw new Error('原执行停止尚未确认，不能重试或交接');
    if(action.action==='evaluate'){
      task.generation={...task.generation,deliveryState:'completed',state:'completed'};task.stage='handoff';
      this.store.ensureEvaluation(task,this.vault.automation());task.status='completed';task.error='';followup.state='resolved';
    }else{
      if(action.action==='continue'||action.action==='answer')task.generation={...task.generation,next:action};
      task.status='queued';followup.state='resolved';
    }
    this.store.put(task);this.store.event(task.id,`AI 已安排 ${action.action}：${action.reason}`);
  }
  async stop(){this.stopping=true;for(const item of this.learning.values())item.controller.abort(new Pending('服务正在停止，经验队列保留用量和已写入版本'));await Promise.allSettled([...this.learning.values()].map(r=>r.promise));if(this.timer)clearInterval(this.timer);this.timer=undefined;for(const item of this.running.values())item.controller.abort(new Pending('服务正在停止，原委托需要检查后继续'));await Promise.allSettled([...this.running.values()].map(r=>r.promise));if(this.lockHeld){const lock=resolve(this.directory,'automation-worker.lock');try{if(JSON.parse(readFileSync(lock,'utf8')).id===this.lockId)unlinkSync(lock);}finally{this.lockHeld=false;}}}
}
