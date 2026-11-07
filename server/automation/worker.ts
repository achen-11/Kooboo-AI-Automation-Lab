import type { AutomationTask } from '../../shared/automation.js';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { executeGeneration } from './generator.js';
import { Pending, UnconfirmedStop } from './errors.js';
import { executeEvaluation } from './evaluator.js';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
export type Execute=(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal)=>Promise<void>;
export class AutomationWorker{
  private timer?:ReturnType<typeof setInterval>;
  private running=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stopping=false;
  private ticking=false;
  private lockId=randomUUID();
  private lockHeld=false;
  constructor(readonly store:AutomationStore,private vault:Vault,private directory:string,private execute:{generation:Execute;evaluation:Execute}={generation:executeGeneration,evaluation:executeEvaluation},private browserReady=()=>existsSync(chromium.executablePath())){}
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
    this.lockHeld=true;this.stopping=false;this.store.recover();this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();void this.tick();
  }
  async tick(){
    if(this.stopping||this.ticking)return;this.ticking=true;
    try{
      const settings=this.vault.automation();if(!settings.enabled)return;
      for(const kind of ['generation','evaluation'] as const){
        const limit=kind==='generation'?settings.generationConcurrency:settings.evaluationConcurrency;
        for(let i=0;i<limit;i++){
          const runtime=this.vault.get();
          if(!this.browserReady())break;
          if(kind==='evaluation'&&!(settings.evaluationEndpoint||runtime.model.endpoint))break;
          const task=this.store.claim(kind,limit,t=>kind==='evaluation'||runtime.environments.some(e=>e.id===t.environmentId&&e.token));if(!task)break;
          const controller=new AbortController();
          const promise=this.run(task,controller,settings.timeoutMinutes).finally(()=>{this.running.delete(task.id);if(!this.stopping)void this.tick();});
          this.running.set(task.id,{controller,promise});
        }
      }
    }finally{this.ticking=false;}
  }
  cancel(id:string){this.running.get(id)?.controller.abort(new Error('任务已请求取消'));}
  owns(id:string){return this.running.has(id);}
  private async run(task:AutomationTask,controller:AbortController,timeout:number){
    const timer=setTimeout(()=>controller.abort(new Pending('超过本轮执行时间，已停止，需检查原会话再跟进')),timeout*60000);timer.unref();
    let stopped=true;
    try{
      await this.execute[task.kind](task,this.store,this.vault,this.directory,controller.signal);
      const current=this.store.task(task.id);task.status=current?.status==='cancelling'?'cancelled':'completed';
    }catch(error){
      const current=this.store.task(task.id);const reason=error instanceof UnconfirmedStop?error:controller.signal.reason||error;
      stopped=!(error instanceof UnconfirmedStop);
      task.status=!stopped?'pending':current?.status==='cancelling'?'cancelled':this.stopping||reason instanceof Pending?'pending':'failed';
      task.error=reason instanceof Error?reason.message:'执行失败，需要检查配置和任务上下文';
    }finally{
      clearTimeout(timer);task.stopped=stopped;this.store.put(task);this.store.event(task.id,task.error||'执行已结束');
      if(task.kind==='generation'&&task.status==='completed'&&this.vault.automation().autoEvaluate){
        if(task.generatedSiteId&&task.siteUrl){
          try{const next=this.store.create({resourceIds:[task.resourceId],kind:'evaluation',scope:task.scope,environmentId:task.environmentId,generatedSiteId:task.generatedSiteId,versionId:task.versionId,requirements:'按已完成生成任务的输入版本和范围进行独立评测。',parentId:task.id},this.vault.automation());this.store.event(task.id,`已交接独立评测：${next[0].id}`);}catch(error){this.store.event(task.id,`自动评测未创建：${error instanceof Error?error.message:'请手动发起评测'}`);}
        }else this.store.event(task.id,'生成结束；公开地址待确认，可在资源详情确认站点后手动发起评测');
      }
    }
  }
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;for(const item of this.running.values())item.controller.abort(new Pending('服务正在停止，原委托需要检查后继续'));await Promise.allSettled([...this.running.values()].map(r=>r.promise));if(this.lockHeld){const lock=resolve(this.directory,'automation-worker.lock');try{if(JSON.parse(readFileSync(lock,'utf8')).id===this.lockId)unlinkSync(lock);}finally{this.lockHeld=false;}}}
}
