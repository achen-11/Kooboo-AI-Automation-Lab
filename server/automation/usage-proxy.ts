import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import type { UsageObservation, UsageStage } from '../../shared/billing.js';
import { ModelBudgetExceeded, RequestBudget, type RequestBudgetPolicy } from './request-budget.js';
import { optimizationBudgetReason } from './optimization.js';
import { setTimeout as delay } from 'node:timers/promises';

/** Per-run loopback relay: SSE bytes pass through unchanged. Only usage is retained. */
export async function usageCapture(taskId:string,stage:UsageStage,store:AutomationStore,vault:Vault,signal:AbortSignal,policy?:RequestBudgetPolicy){
  const runtime=vault.get(),settings=vault.automation();
  const frozen=store.task(taskId)?.model;
  const endpoint=(frozen?.endpoint||settings.evaluationEndpoint||runtime.model.endpoint).replace(/\/(?:responses|chat\/completions)\/?$/,'').replace(/\/$/,'');
  const maxRequestBytes=(stage==='followup'?32:128)*1024*1024;
  const budget=policy?new RequestBudget(store.db,policy):undefined,limitController=new AbortController();
  const runSignal=AbortSignal.any([signal,limitController.signal]);
  const token=randomUUID()+randomUUID(),active=new Set<Promise<void>>(),controllers=new Set<AbortController>();let requests=0,requestError:Error|undefined;
  const server=createServer((req,res)=>{
    const work=(async()=>{
      const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);
      if(a.length!==b.length||!timingSafeEqual(a,b)){res.writeHead(401).end();return;}
      if(req.method!=='POST'||!['/responses','/responses/compact'].includes(req.url||'')){res.writeHead(404).end();return;}
      const tooLarge=()=>{res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'automation_request_too_large',message:`Model request exceeds the local ${maxRequestBytes/1024/1024} MiB image-context limit; restart the evaluation session and reuse saved evidence.`}}));};
      if(Number(req.headers['content-length'])>maxRequestBytes){tooLarge();req.resume();return;}
      const chunks:Buffer[]=[];let bytes=0;
      for await(const part of req){bytes+=part.length;if(bytes>maxRequestBytes){tooLarge();return;}chunks.push(part);}
      let body:Buffer=Buffer.concat(chunks,bytes);
      let model=frozen?.name||settings.evaluationModel;try{const parsed=JSON.parse(body.toString());if(parsed.model!==undefined&&typeof parsed.model!=='string')throw new Error('Invalid model');model=parsed.model||model;}catch{res.writeHead(400).end();return;}
      let observation:UsageObservation={id:randomUUID(),source:'codex',stage,model,endpoint,startedAt:Date.now(),endedAt:Date.now(),status:'unknown',basis:'request',raw:null};
      let price=store.usage.price(endpoint,model,observation.startedAt);
      try{
        runSignal.throwIfAborted();
        if(requestError)throw requestError;
        const task=store.task(taskId),cost=task?optimizationBudgetReason(task,store):'';
        if(cost)throw new ModelBudgetExceeded(cost);
        store.db.transaction(()=>{if(budget){
          if(req.url==='/responses/compact'){const parsed=JSON.parse(body.toString());parsed.__compact=true;body=Buffer.from(JSON.stringify(parsed));}
          body=budget.reserve(observation.id,body);
        }store.usage.record(taskId,observation,price);});
      }catch(error){
        const reason=requestError||(error instanceof ModelBudgetExceeded?error:new ModelBudgetExceeded(error instanceof Error?error.message:'模型预算不可用'));
        res.writeHead(429,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'automation_budget_exceeded',message:reason.message}}));
        limitController.abort(reason);return;
      }
      requests++;
      const controller=new AbortController();controllers.add(controller);const combined=AbortSignal.any([runSignal,controller.signal]);
      const disconnected=()=>controller.abort(new Error('SDK connection closed'));res.on('close',disconnected);
      let pending='',streaming=false,responseCompleted=false;
      const observe=(json:string)=>{try{const item=JSON.parse(json);if(typeof item.response?.model==='string')observation.responseModel=item.response.model;if(typeof item.response?.id==='string')observation.responseId=item.response.id;if(item.type==='response.failed'||item.type==='error'||item.response?.status==='failed')observation.status='failed';if(item.type==='response.completed'&&item.response?.status!=='failed')responseCompleted=true;const usage=item.response?.usage||item.usage;if(usage&&typeof usage==='object')observation.raw=usage;}catch{}};
      try{
        let upstream:Response,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,first:ReadableStreamReadResult<Uint8Array>|undefined;
        for(let attempt=0;;attempt++){
          try{
            upstream=await fetch(endpoint+req.url,{method:'POST',headers:{Authorization:'Bearer '+runtime.model.apiKey,'Content-Type':'application/json',Accept:req.headers.accept||'text/event-stream'},body:new Uint8Array(body),signal:combined,redirect:'error'});
            if(['evaluation','planning','followup'].includes(stage)&&upstream.ok&&upstream.body){reader=upstream.body.getReader();first=await reader.read();}
            break;
          }catch(error){
            const code=(error as {cause?:{code?:unknown}})?.cause?.code;
            // Only retry independent read-only evaluation/planning/followup before any response
            // bytes reach the SDK. Never replay a partial stream or an action.
            if(!['evaluation','planning','followup'].includes(stage)||attempt>=2||combined.aborted||!['UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','ECONNRESET','ETIMEDOUT'].includes(String(code)))throw error;
            await reader?.cancel().catch(()=>{});reader=undefined;first=undefined;
            observation.status='failed';observation.endedAt=Date.now();observation.note=`模型连接在首段响应前断开（${code}）；保留未知用量，有限重试 ${attempt+1}/2。`;
            budget?.complete(observation.id,null);store.usage.complete(taskId,observation,price);
            store.event(taskId,observation.note);
            await delay(300,undefined,{signal:combined});
            const next:UsageObservation={id:randomUUID(),source:'codex',stage,model,endpoint,startedAt:Date.now(),endedAt:Date.now(),status:'unknown',basis:'request',raw:null},nextPrice=store.usage.price(endpoint,model,next.startedAt);
            try{runSignal.throwIfAborted();const task=store.task(taskId),cost=task?optimizationBudgetReason(task,store):'';if(cost)throw new ModelBudgetExceeded(cost);store.db.transaction(()=>{if(budget)body=budget.reserve(next.id,body);store.usage.record(taskId,next,nextPrice);});}
            catch(reason){requestError=reason instanceof Error?reason:new Error('评测重试预算不可用');limitController.abort(requestError);throw reason;}
            observation=next;price=nextPrice;requests++;
          }
        }
        streaming=Boolean(upstream.headers.get('content-type')?.includes('text/event-stream'));
        if(!upstream.ok){const failure=new Error(upstream.status===402?'模型服务拒绝请求（HTTP 402）；请检查模型账户余额、额度及服务配置后恢复。':`模型服务返回 HTTP ${upstream.status}；请在模型服务恢复后重试。`);requestError??=failure;observation.note=failure.message;}
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});
        if(upstream.body){const decoder=new TextDecoder(),bodyReader=reader||upstream.body.getReader();while(true){const next=first||await bodyReader.read();first=undefined;if(next.done)break;const chunk=next.value;
          if(!res.destroyed)res.write(chunk);
          pending+=decoder.decode(chunk,{stream:true});
          if(pending.length>8*1024*1024)pending=pending.slice(-1024*1024);
          if(upstream.headers.get('content-type')?.includes('text/event-stream')){
            let match:RegExpExecArray|null;while((match=/\r?\n\r?\n/.exec(pending))){const event=pending.slice(0,match.index).replaceAll('\r','');pending=pending.slice(match.index+match[0].length);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');observe(data);}
          }
          // Responses completion is the protocol boundary. The SDK may close
          // its HTTP body here while a provider keeps the SSE transport open.
          // Do not turn that normal close into a sticky error for the next turn.
          if(responseCompleted){await bodyReader.cancel();break;}
        }pending+=decoder.decode();observe(pending);}
        observation.status=upstream.ok&&observation.status!=='failed'?'completed':'failed';
      }catch(error){
        if(responseCompleted&&observation.status!=='failed'){
          observation.status='completed';
        }else{
        observation.status='failed';
        const code=typeof (error as {cause?:{code?:unknown}})?.cause?.code==='string'?String((error as {cause:{code:string}}).cause.code):'';
        // Keep only machine codes; provider messages, URLs, headers and bodies can contain credentials.
        const safeCode=/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:'';
        const reason=runSignal.aborted?'本轮已取消或达到活动时间上限':controller.signal.aborted?'SDK 已关闭模型连接':safeCode==='UND_ERR_CONNECT_TIMEOUT'?'连接模型服务超时':safeCode==='ENOTFOUND'?'模型域名解析失败':'模型上游连接失败';
        const failure=new Error(`${reason}${safeCode?'（'+safeCode+'）':''}；未返回的用量无法推断，预占保留。`);requestError??=failure;observation.note||=failure.message;
        if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});
        if(!res.destroyed){const value=JSON.stringify({error:{message:requestError.message}});res.write(streaming?'data: '+JSON.stringify({type:'error',message:requestError.message})+'\n\n':value);}
        }
      }
      finally{
        res.off('close',disconnected);controllers.delete(controller);observation.endedAt=Date.now();budget?.complete(observation.id,observation.raw);store.usage.complete(taskId,observation,price&&(!observation.responseModel||price.models.some(model=>model.toLowerCase()===observation.responseModel!.toLowerCase()))?price:null);if(!res.destroyed)res.end();
      }
    })();active.add(work);void work.catch(()=>{if(!res.destroyed)res.destroy();}).finally(()=>active.delete(work));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Usage relay unavailable');
  return {signal:runSignal, get error(){return limitController.signal.reason as ModelBudgetExceeded|undefined||requestError;}, env:{AUTOMATION_RESPONSES_URL:`http://127.0.0.1:${address.port}`,EVALUATOR_MODEL_KEY:token},fallback(raw:Record<string,unknown>,startedAt:number){if(!requests)store.usage.record(taskId,{id:randomUUID(),source:'codex',stage,model:frozen?.name||settings.evaluationModel,endpoint,startedAt,endedAt:Date.now(),status:'completed',basis:'sdk-turn',raw});},async close(){for(const controller of controllers)controller.abort();server.closeAllConnections();await Promise.allSettled([...active]);await new Promise<void>(r=>server.close(()=>r()));}};
}
