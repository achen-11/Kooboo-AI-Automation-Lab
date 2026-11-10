import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, GeneratedSite, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { evidenceWriter, inspectImplementation, implementationInput, sourceReader, ManifestStore, manifestInput } from './completeness.js';
import { z } from 'zod';

/** Keep the registered source bytes on disk, rather than echoing HTML through SDK events. */
export function sourceInspectionReply(value:unknown) {
  if(!value||typeof value!=='object')return value;
  const saved=value as {evidence?:unknown;result?:{kind?:unknown;body?:unknown}};
  if(typeof saved.evidence!=='string'||!/^source-review-[a-f0-9-]{36}\.json$/.test(saved.evidence)||saved.result?.kind!=='source'||typeof saved.result.body!=='string'||Buffer.byteLength(saved.result.body)<=6000)return value;
  let end=Math.min(saved.result.body.length,6000);
  while(Buffer.byteLength(saved.result.body.slice(0,end))>6000)end=Math.floor(end*0.8);
  return {...saved,result:{...saved.result,body:saved.result.body.slice(0,end)},outputTruncated:true,evidencePath:'evidence/'+saved.evidence,note:'此工具响应仅预览来源正文开头；已登记证据文件保留原始读取结果及 truncated 标志。按需从 evidencePath 用 jq 读取具体字段或有界片段，不把整份 HTML 输出到执行流。预览不能证明页面全集。'};
}

/** Host-owned identity of the exact input and implementation inspected. */
export function implementationEvidenceBinding(task:AutomationTask,site:GeneratedSite|undefined){
  if(!task.siteRevision||!task.versionId||!site||!site.siteId||!site.versionId||!site.environmentId||task.generatedSiteId!==site.id||task.resourceId!==site.resourceId||task.environmentId!==site.environmentId)return;
  let targetUrl:string;try{const url=new URL(site.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;targetUrl=url.href;}catch{return;}
  return {kind:'implementation' as const,version:1,taskId:task.id,inputVersionId:task.versionId,resourceId:task.resourceId,siteRevision:task.siteRevision,generatedSiteId:site.id,siteId:site.siteId,environmentId:site.environmentId,generatedSiteVersionId:site.versionId,targetUrl};
}

export async function inspectionTools(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,work:string,artifacts:MaterialFile[],signal:AbortSignal,validateDraft?:(resultFile:string)=>void){
  const token=randomUUID()+randomUUID();let calls=0,manifestCalls=0,busy=false,active:Promise<unknown>|undefined;const validationCalls=new Map<string,number>();
  const manifests=new ManifestStore(store);
  const write=evidenceWriter(work,artifacts,'target','implementation'),sourceWrite=evidenceWriter(work,artifacts,'content','source-review',file=>{const destination=resolve(directory,'manifest-runs',task.id,'evidence');mkdirSync(destination,{recursive:true,mode:0o700});copyFileSync(resolve(work,'evidence',file.name),resolve(destination,file.name));store.db.prepare('INSERT INTO auto_manifest_artifacts VALUES(?,?,?)').run(file.name,task.id,file.sha256);}),readSource=sourceReader(task,store,directory,sourceWrite,{bodyCharacters:1024*1024});
  const currentBinding=(current:AutomationTask)=>{const revision=current.generatedSiteId?store.siteState(current.generatedSiteId)?.revision:undefined;if(revision&&revision!==current.siteRevision)return;return implementationEvidenceBinding(current,current.generatedSiteId?store.site(current.generatedSiteId):undefined);};
  const checkpoint=()=>{task.artifacts=structuredClone(artifacts);store.put(task);writeFileSync(resolve(work,'evidence-manifest.json'),JSON.stringify(artifacts),{mode:0o600});};
  const implementation=async(raw:unknown)=>{
    const binding=currentBinding(task),persisted=store.task(task.id);
    if(!binding||!persisted||JSON.stringify(binding)!==JSON.stringify(currentBinding(persisted)))throw new Error('后台取证缺少当前任务与站点修订绑定');
    signal.throwIfAborted();
    const request=implementationInput.parse(raw);
    const stateful=['content','contentItem','rows','products','product','categories'].includes(request.kind);
    for(const file of artifacts.filter(f=>task.scenario==='site-template'&&/^implementation-[a-f0-9-]{36}\.json$/.test(f.name)))try{
      const bytes=readFileSync(resolve(work,'evidence',file.name));
      const saved=JSON.parse(bytes.toString());
      const ordered=(value:object)=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
      if(file.role==='target'&&file.type==='application/json'&&bytes.length===file.size&&createHash('sha256').update(bytes).digest('hex')===file.sha256&&JSON.stringify(saved.binding)===JSON.stringify(binding)&&saved.request&&Object.hasOwn(saved,'value')&&ordered(saved.request)===ordered(request)){
        // Browser actions can change test data without a generation revision.
        const changed=stateful&&artifacts.slice(artifacts.indexOf(file)+1).some(f=>{
          if(f.role!=='target'||!/^[-a-f0-9]{36}\.json$/.test(f.name))return false;
          try{const data=readFileSync(resolve(work,'evidence',f.name));if(data.length!==f.size||createHash('sha256').update(data).digest('hex')!==f.sha256)return true;const o=JSON.parse(data.toString());return o.binding?.taskId===task.id&&o.binding?.siteRevision===task.siteRevision&&['click','fill','select','press'].includes(o.action);}catch{return true;}
        });
        if(!changed)return {evidence:file.name,result:saved};
      }
    }catch{/* A missing or changed current proof is read again. */}
    const result=await inspectImplementation(task,store,vault,signal,raw);signal.throwIfAborted();
    const latest=store.task(task.id);
    if(!latest||JSON.stringify(binding)!==JSON.stringify(currentBinding(task))||JSON.stringify(binding)!==JSON.stringify(currentBinding(latest)))throw new Error('后台取证期间任务或站点已变化，请重新取证');
    const saved=write({...result,binding});checkpoint();return saved;
  };
  const programIndex=async()=>{
    const rows:{kind:string;evidence?:string;error?:string}[]=[];
    for(const kind of ['pages','routes','views','codes']){
      signal.throwIfAborted();
      try{const saved=await implementation({kind,page:1});rows.push({kind,evidence:saved.evidence});}catch(error){signal.throwIfAborted();rows.push({kind,error:store.sanitize(error instanceof Error?error.message:'后台索引读取失败')});}
    }
    writeFileSync(resolve(work,'implementation-index.json'),JSON.stringify({siteRevision:task.siteRevision,rows,note:'固定只读入口索引，每类第1页；不证明分页全集、实现正确或数据完整，模型按具体问题读取原件和后续分页。'},null,2),{mode:0o600});return rows;
  };
  const server=createServer(async(req,res)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(value));};
    const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);if(a.length!==b.length||!timingSafeEqual(a,b))return reply(401,{error:'Unauthorized'});
    if(req.method!=='POST'||req.url!=='/inspect')return reply(404,{error:'Not found'});if(busy)return reply(409,{error:'请顺序取证'});busy=true;
    try{signal.throwIfAborted();let text='';for await(const chunk of req){text+=chunk;if(text.length>2000000)throw new Error('请求过大');}const input=JSON.parse(text);
      if(input.tool==='validate_result'){
        if(!validateDraft||typeof input.resultFile!=='string')throw new Error('预检需要本轮宿主指定的 resultFile');
        const count=(validationCalls.get(input.resultFile)||0)+1;validationCalls.set(input.resultFile,count);if(count>6)throw new Error('本份结果本地预检达到调用上限');
        writeFileSync(resolve(work,'evidence-manifest.json'),JSON.stringify(artifacts),{mode:0o600});
        validateDraft(input.resultFile);
        return reply(200,{valid:true,note:'仅表示当前草稿通过结构与证据契约校验；请按本轮合同提交结果。预检不发布报告、不改站、不请求模型。'});
      }
      // Exhausted evidence reads must not prevent saving the already collected scope and gaps.
      // This separate, bounded allowance performs no additional source/target requests.
      if(input.tool==='manifest'||input.tool==='extend_manifest'){
        if(++manifestCalls>20)throw new Error('本轮清单查询与补充达到调用上限');
      }else if(++calls>300)throw new Error('本轮只读取证达到调用上限');
      active=(async()=>{if(input.tool==='source')return readSource(input.input,signal);if(input.tool==='manifest')return {manifest:manifests.get(task.requirementsId),schema:z.toJSONSchema(manifestInput)};
        if(input.tool==='extend_manifest'){
          const parsed=manifestInput.parse(input.input),old=manifests.get(task.requirementsId);if(!old||task.report)throw new Error('当前没有可复核的清单或报告已固定');
          const names=new Set([...old.evidence,...artifacts.filter(f=>f.name.startsWith('source-review-')).map(f=>f.name)]);if(parsed.evidence.some(e=>!names.has(e))||!parsed.evidence.some(e=>e.startsWith('source-review-')))throw new Error('必须引用本轮独立复核来源证据，不得仅根据生成站反推范围');
          const manifest=manifests.save(task,parsed,'ai',old.id);store.event(task.id,'独立评测复核并补充交付清单版本 '+manifest.revision+'，保留原必交付范围');return {manifest};
        }
        if(input.tool!=='implementation')throw new Error('tool 仅支持 implementation / source / manifest / extend_manifest / validate_result');
        return implementation(input.input);})();
      const value=await active;task.artifacts=structuredClone(artifacts);store.put(task);writeFileSync(resolve(work,'evidence-manifest.json'),JSON.stringify(artifacts),{mode:0o600});reply(200,sourceInspectionReply(value));
    }catch(error){reply(400,{error:error instanceof Error?error.message:'只读取证失败，相关项应标记未验证'});}finally{busy=false;active=undefined;}
  });
  await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const address=server.address();if(!address||typeof address==='string')throw new Error('只读取证服务失败');
  writeFileSync(resolve(work,'inspect.mjs'),`const r=await fetch(process.env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:process.argv[2]||'{}'});console.log(await r.text());if(!r.ok)process.exitCode=1;`,{mode:0o600});
  return {programIndex,readImplementation:implementation,env:{INSPECTION_URL:`http://127.0.0.1:${address.port}/inspect`,INSPECTION_TOKEN:token},async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await active?.catch(()=>{});}};
}
