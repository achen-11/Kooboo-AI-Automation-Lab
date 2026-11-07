import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import type { UsageObservation, UsageStage } from '../../shared/billing.js';

/** Per-run loopback relay: SSE bytes pass through unchanged. Only usage is retained. */
export async function usageCapture(taskId:string,stage:UsageStage,store:AutomationStore,vault:Vault,signal:AbortSignal){
  const runtime=vault.get(),settings=vault.automation();
  const endpoint=(settings.evaluationEndpoint||runtime.model.endpoint).replace(/\/(?:responses|chat\/completions)\/?$/,'').replace(/\/$/,'');
  const maxRequestBytes=(stage==='followup'?32:128)*1024*1024;
  const token=randomUUID()+randomUUID(),active=new Set<Promise<void>>(),controllers=new Set<AbortController>();let requests=0;
  const server=createServer((req,res)=>{
    const work=(async()=>{
      const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);
      if(a.length!==b.length||!timingSafeEqual(a,b)){res.writeHead(401).end();return;}
      if(req.method!=='POST'||!['/responses','/responses/compact'].includes(req.url||'')){res.writeHead(404).end();return;}
      const tooLarge=()=>{res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'automation_request_too_large',message:`Model request exceeds the local ${maxRequestBytes/1024/1024} MiB image-context limit; restart the evaluation session and reuse saved evidence.`}}));};
      if(Number(req.headers['content-length'])>maxRequestBytes){tooLarge();req.resume();return;}
      const chunks:Buffer[]=[];let bytes=0;
      for await(const part of req){bytes+=part.length;if(bytes>maxRequestBytes){tooLarge();return;}chunks.push(part);}
      const body=Buffer.concat(chunks,bytes);
      let model=settings.evaluationModel;try{const parsed=JSON.parse(body.toString());if(parsed.model!==undefined&&typeof parsed.model!=='string')throw new Error('Invalid model');model=parsed.model||model;}catch{res.writeHead(400).end();return;}
      const observation:UsageObservation={id:randomUUID(),source:'codex',stage,model,endpoint,startedAt:Date.now(),endedAt:Date.now(),status:'unknown',basis:'request',raw:null};
      const price=store.usage.price(endpoint,model,observation.startedAt);requests++;
      store.usage.record(taskId,observation,price);
      const controller=new AbortController();controllers.add(controller);const combined=AbortSignal.any([signal,controller.signal]);
      const disconnected=()=>controller.abort(new Error('SDK connection closed'));res.on('close',disconnected);
      let pending='';
      const observe=(json:string)=>{try{const item=JSON.parse(json);if(typeof item.response?.model==='string')observation.responseModel=item.response.model;if(typeof item.response?.id==='string')observation.responseId=item.response.id;if(item.type==='response.failed'||item.type==='error'||item.response?.status==='failed')observation.status='failed';const usage=item.response?.usage||item.usage;if(usage&&typeof usage==='object')observation.raw=usage;}catch{}};
      try{
        const upstream=await fetch(endpoint+req.url,{method:'POST',headers:{Authorization:'Bearer '+runtime.model.apiKey,'Content-Type':'application/json',Accept:req.headers.accept||'text/event-stream'},body,signal:combined,redirect:'error'});
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});
        if(upstream.body){const decoder=new TextDecoder(),reader=upstream.body.getReader();while(true){const next=await reader.read();if(next.done)break;const chunk=next.value;
          if(!res.destroyed)res.write(chunk);
          pending+=decoder.decode(chunk,{stream:true});
          if(pending.length>8*1024*1024)pending=pending.slice(-1024*1024);
          if(upstream.headers.get('content-type')?.includes('text/event-stream')){
            let match:RegExpExecArray|null;while((match=/\r?\n\r?\n/.exec(pending))){const event=pending.slice(0,match.index).replaceAll('\r','');pending=pending.slice(match.index+match[0].length);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');observe(data);}
          }
        }pending+=decoder.decode();observe(pending);}
        observation.status=upstream.ok&&observation.status!=='failed'?'completed':'failed';
      }catch{observation.status='failed';observation.note='模型请求失败 / 被取消；未返回的用量无法推断。';if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});if(!res.destroyed)res.write(JSON.stringify({error:{message:'Model request failed; see usage ledger.'}}));}
      finally{
        res.off('close',disconnected);controllers.delete(controller);observation.endedAt=Date.now();store.usage.complete(taskId,observation,price&&(!observation.responseModel||price.models.some(model=>model.toLowerCase()===observation.responseModel!.toLowerCase()))?price:null);if(!res.destroyed)res.end();
      }
    })();active.add(work);void work.catch(()=>{if(!res.destroyed)res.destroy();}).finally(()=>active.delete(work));
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Usage relay unavailable');
  return {env:{AUTOMATION_RESPONSES_URL:`http://127.0.0.1:${address.port}`,EVALUATOR_MODEL_KEY:token},fallback(raw:Record<string,unknown>,startedAt:number){if(!requests)store.usage.record(taskId,{id:randomUUID(),source:'codex',stage,model:settings.evaluationModel,endpoint,startedAt,endedAt:Date.now(),status:'completed',basis:'sdk-turn',raw});},async close(){for(const controller of controllers)controller.abort();server.closeAllConnections();await Promise.allSettled([...active]);await new Promise<void>(r=>server.close(()=>r()));}};
}
