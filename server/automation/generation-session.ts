import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Pending, UnconfirmedStop } from './errors.js';
import { koobooClient } from './kooboo.js';

export interface GenerationObservation {
  imageInput?: boolean;
  canSend?: boolean;
  usage?:{id:string;conversationId:string;runId:string;provider:string;model:string;startedAt:number;endedAt:number;status:'unknown'|'completed'|'failed';raw:Record<string,unknown>|null;note?:string}[];usageError?:string;
  version:number;taskId:string;siteId:string;conversationId:string;runId:string;ready:boolean;running:boolean;state:string;observedAt:number;
  pending:{callId:string;name:string;args:Record<string,unknown>}|null;
  delivery?:{id:string;state:'sending'|'accepted';conversationId:string;error?:string};
  outcome?:{conversationId:string;runId:string;status:string;time:number};context:unknown[];
}

/** A terminal receipt belongs to the current delivery, never to its predecessor. */
export function matchingGenerationOutcome(task:AutomationTask,state:GenerationObservation) {
  const generation=task.generation,outcome=state.outcome;
  return !!generation?.deliveryId&&state.taskId===task.id&&state.conversationId===generation.conversationId
    &&state.delivery?.id===generation.deliveryId&&state.delivery.state==='accepted'
    &&state.delivery.conversationId===state.conversationId&&!!outcome?.runId
    &&outcome.conversationId===state.conversationId&&outcome.runId===state.runId
    &&outcome.runId!==generation.previousRunId&&outcome.status===state.state;
}
export async function pause(ms:number,signal:AbortSignal) {
  signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{
    const done=()=>{signal.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
  });
}

export function applyGenerationObservation(task:AutomationTask,state:GenerationObservation,expectedConversation=task.generation?.conversationId) {
  task.generation={...task.generation,state:state.state,observedAt:state.observedAt,pending:state.pending};
  if(state.conversationId&&(!expectedConversation||state.conversationId===expectedConversation))task.generation.conversationId=state.conversationId;
  if(state.runId)task.generation.runId=state.runId;
  // Evaluation owns a separate Codex thread; inspecting Kooboo must not replace it.
  if(task.kind==='generation'){task.threadId=state.conversationId;task.context=JSON.stringify(state.context).slice(-50000);}
}

export async function generationSession(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal) {
  const site=task.generatedSiteId&&store.site(task.generatedSiteId);if(!site)throw new Pending('尚未绑定实际生成站');
  const {origin,environment}=koobooClient(task,vault,signal);
  const expectedConversation=task.generation?.conversationId;
  const profile=resolve(directory,'generation-browsers',task.id);mkdirSync(profile,{recursive:true,mode:0o700});
  let context;
  // Read once per session: setting changes never replace an active execution.
  // Pin full Chromium so headless uses the same browser/profile as visible mode.
  const headless=vault.automation().showExecutionBrowser!==true;
  try { context=await chromium.launchPersistentContext(profile,{headless,channel:'chromium'}); }
  catch(error) {
    if(error instanceof Error&&/ProcessSingleton|SingletonLock|profile.*in use|user data directory.*in use/i.test(error.message))throw new UnconfirmedStop('原执行浏览器配置仍被占用，需确认原进程已停止后恢复');
    throw error;
  }
  let closing:Promise<void>|undefined;
  // Retain HTTP/Code Cache across retries and follow-up inspections of the same task;
  // regenerable caches are trimmed once the task reaches a terminal state.
  const close=()=>closing??=context.close().catch(()=>{throw new UnconfirmedStop('无法确认生成执行浏览器已关闭，请检查原执行再恢复');});
  const onAbort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',onAbort,{once:true});
  try {
    signal.throwIfAborted();
    await context.addCookies([{name:'jwt_token',value:environment.token,url:origin,httpOnly:false,secure:origin.startsWith('https:')}]);
    const page=context.pages()[0]||await context.newPage();
    const url=new URL('/_Admin/ai-chat/overview',origin);url.searchParams.set('SiteId',site.siteId);url.searchParams.set('automationTaskId',task.id);url.searchParams.set('starterSiteCreated','1');
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>{try{return (window as any).__koobooAutomation?.snapshot().ready===true;}catch{return false;}},{},{timeout:180000}).catch(async()=>{
      const probe=await Promise.resolve(page.evaluate(()=>{
        const pathname=typeof location!=='undefined'?location.pathname:'';
        const readyState=typeof document!=='undefined'?document.readyState:'unknown';
        const bridge=(window as any).__koobooAutomation;
        if(!bridge)return {pathname,readyState,hasBridge:false,state:''};
        try{const s=bridge.snapshot();return {pathname,readyState,hasBridge:true,state:String(s?.state||'')};}
        catch(err){return {pathname,readyState,hasBridge:true,state:err instanceof Error?err.message:'error'};}
      })).catch(()=>null);
      if(probe?.pathname&&!/^\/_admin\/ai-chat\b/i.test(probe.pathname))
        throw new Pending(`Kooboo AI Chat 页面未能进入工作台（当前路径 ${probe.pathname}），请检查目标环境登录令牌是否有效`);
      if(probe&&!probe.hasBridge&&probe.readyState!=='complete')
        throw new Pending(`Kooboo AI Chat 前端静态资源加载超时（readyState=${probe.readyState}），远端网络较慢；浏览器缓存已保留，稍后重试可加速加载`);
      if(probe?.hasBridge)
        throw new Pending(`Kooboo AI Chat 会话初始化超时（state=${probe.state||'loading'}），稍后可重试核对`);
      throw new Pending('Kooboo AI Chat 执行状态桥接尚未就绪；请确认目标环境包含 automation bridge 前端');
    });
    task.generation={...task.generation,ownerPid:process.pid};store.put(task);
    const snapshot=async()=>{
      signal.throwIfAborted();
      const state=await page.evaluate(()=>((window as any).__koobooAutomation.snapshot())) as GenerationObservation;
      if(state.version!==1||state.taskId!==task.id||state.siteId.toLowerCase()!==site.siteId.toLowerCase())throw new Pending('执行页面与任务身份不一致，已停止自动操作');
      const acknowledged:string[]=[];
      for(const value of state.usage||[]){
        if(!value.runId||!value.id||!Number.isFinite(value.startedAt)||!Number.isFinite(value.endedAt)||value.endedAt<value.startedAt)continue;
        const endpoint=/deepseek/i.test(value.provider)?'https://api.deepseek.com':value.provider;
        const observation={...value,source:'kooboo' as const,stage:'generation' as const,basis:'request' as const,endpoint,note:(value.note||'')+' Kooboo 直连官方的部署口径；后台压缩 / 未返回 usage 的重试不一定包含在内。'};
        const old=store.usage.entries(task.id).find(e=>e.source==='kooboo'&&e.id===value.id);
        if(!old)store.usage.record(task.id,observation);
        else if(old.status==='unknown')store.usage.complete(task.id,observation,old.price);
        if(value.status!=='unknown')acknowledged.push(value.id);
      }
      if(state.usageError){store.usage.record(task.id,{id:'bridge-storage-failure',source:'kooboo',stage:'generation',model:'unknown',endpoint:'',startedAt:Date.now(),endedAt:Date.now(),status:'unknown',basis:'request',raw:null,note:state.usageError});}
      if(acknowledged.length)await page.evaluate(ids=>(window as any).__koobooAutomation.acknowledgeUsage?.(ids),acknowledged);
      applyGenerationObservation(task,state,expectedConversation);store.put(task);return state;
    };
    const deadline=Date.now()+90000;let state=await snapshot();
    while(!state.ready){if(Date.now()>deadline)throw new Pending('原会话加载超时');await pause(1000,signal);state=await snapshot();}
    const expected=expectedConversation;
    // snapshot may describe the last selected chat; restore the pinned identity before acting.
    if(expected&&state.conversationId!==expected){await page.evaluate(id=>(window as any).__koobooAutomation.selectConversation(id),expected);state=await snapshot();}
    // AI/Providers loads asynchronously alongside AI/Conversation; wait briefly so canSend settles.
    const providerDeadline=Date.now()+30000;
    while(!state.running&&state.canSend===false&&Date.now()<providerDeadline){await pause(500,signal);state=await snapshot();}
    return {snapshot,deliver:async(input:{id:string;conversationId:string;text?:string;answer?:Record<string,unknown>;callId?:string;images?:{uri:string;mediaType:'image/png'}[]})=>{
      signal.throwIfAborted();return page.evaluate(value=>(window as any).__koobooAutomation.deliver(value),input) as Promise<GenerationObservation['delivery']>;
    },close:async()=>{signal.removeEventListener('abort',onAbort);await close();}};
  } catch(error) {signal.removeEventListener('abort',onAbort);await close();throw error;}
}
