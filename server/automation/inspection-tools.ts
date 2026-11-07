import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { evidenceWriter, inspectImplementation, sourceReader, ManifestStore, manifestInput } from './completeness.js';
import { z } from 'zod';
export async function inspectionTools(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,work:string,artifacts:MaterialFile[],signal:AbortSignal){
  const token=randomUUID()+randomUUID();let calls=0,busy=false,active:Promise<unknown>|undefined;
  const manifests=new ManifestStore(store);
  const write=evidenceWriter(work,artifacts,'target','implementation'),sourceWrite=evidenceWriter(work,artifacts,'content','source-review',file=>{const destination=resolve(directory,'manifest-runs',task.id,'evidence');mkdirSync(destination,{recursive:true,mode:0o700});copyFileSync(resolve(work,'evidence',file.name),resolve(destination,file.name));store.db.prepare('INSERT INTO auto_manifest_artifacts VALUES(?,?,?)').run(file.name,task.id,file.sha256);}),readSource=sourceReader(task,store,directory,sourceWrite);
  const server=createServer(async(req,res)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));};
    const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);if(a.length!==b.length||!timingSafeEqual(a,b))return reply(401,{error:'Unauthorized'});
    if(req.method!=='POST'||req.url!=='/inspect')return reply(404,{error:'Not found'});if(busy)return reply(409,{error:'请顺序取证'});busy=true;
    try{signal.throwIfAborted();if(++calls>300)throw new Error('本轮只读取证达到调用上限');let text='';for await(const chunk of req){text+=chunk;if(text.length>2000000)throw new Error('请求过大');}const input=JSON.parse(text);
      active=(async()=>{if(input.tool==='source')return readSource(input.input,signal);if(input.tool==='manifest')return {manifest:manifests.get(task.requirementsId),schema:z.toJSONSchema(manifestInput)};
        if(input.tool==='extend_manifest'){
          const parsed=manifestInput.parse(input.input),old=manifests.get(task.requirementsId);if(!old||task.report)throw new Error('当前没有可复核的清单或报告已固定');
          const names=new Set([...old.evidence,...artifacts.filter(f=>f.name.startsWith('source-review-')).map(f=>f.name)]);if(parsed.evidence.some(e=>!names.has(e))||!parsed.evidence.some(e=>e.startsWith('source-review-')))throw new Error('必须引用本轮独立复核来源证据，不得仅根据生成站反推范围');
          const manifest=manifests.save(task,parsed,'ai',old.id);store.event(task.id,'独立评测复核并补充交付清单版本 '+manifest.revision+'，保留原必交付范围');return {manifest};
        }
        if(input.tool!=='implementation')throw new Error('tool 仅支持 implementation / source / manifest / extend_manifest');return write(await inspectImplementation(task,store,vault,signal,input.input));})();
      const value=await active;task.artifacts=structuredClone(artifacts);store.put(task);reply(200,value);
    }catch(error){reply(400,{error:error instanceof Error?error.message:'只读取证失败，相关项应标记未验证'});}finally{busy=false;active=undefined;}
  });
  await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const address=server.address();if(!address||typeof address==='string')throw new Error('只读取证服务失败');
  writeFileSync(resolve(work,'inspect.mjs'),`const r=await fetch(process.env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:process.argv[2]||'{}'});console.log(await r.text());if(!r.ok)process.exitCode=1;`,{mode:0o600});
  return {env:{INSPECTION_URL:`http://127.0.0.1:${address.port}/inspect`,INSPECTION_TOKEN:token},async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await active?.catch(()=>{});}};
}
