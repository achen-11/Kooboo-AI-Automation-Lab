import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import { defaultCompletenessSettings } from '../../shared/completeness.js';
import type { Requirement, RequirementManifest, CompletenessReport } from '../../shared/completeness.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { localDecision } from './local-decision.js';
import { httpRead, koobooClient } from './kooboo.js';
import { readMaterial } from './materials.js';
import { Conflict } from '../lib/store.js';
import { migrationBaselineSchema } from './migration-contract.js';
import { assertMigrationBaselinePreserved } from './migration-check.js';
import { effectiveCollectionInput } from './collection/store.js';

export const completenessSettingsSchema=z.object({enabled:z.boolean(),maxTokens:z.number().int().min(1000).max(1000000000),maxMinutes:z.number().int().min(1).max(30),maxRequests:z.number().int().min(1).max(200),sop:z.string().trim().min(1).max(50000)});
const viewport=z.enum(['desktop','mobile','business']);
const requirementId=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const dataIdentitySchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('page')}).strict(),
  z.object({kind:z.literal('relations'),parentRequirementIds:z.array(requirementId).min(1).max(1000),childRequirementIds:z.array(requirementId).min(1).max(1000)}).strict(),
  z.object({kind:z.literal('assets')}).strict(),
]).describe('data的计量域：page为来源页面记录（省略时默认），relations为精确页面成员边，assets为来源素材。不得按ID或标题猜测。relations的expectedKeys为JSON.stringify([parentSourceURL,childSourceURL])；两端必须为同源、规范化的完整HTTP(S) URL。父子引用必须是本清单required page全量paths或required data page域expectedKeys。');
function canonicalSourceUrl(value:unknown):URL|undefined {
  if(typeof value!=='string')return;
  try{const url=new URL(value);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash&&url.href===value)return url;}catch{/* Invalid source identities cannot establish relation coverage. */}
}
export const manifestInput=z.object({
  sourceComplete:z.boolean(), limitations:z.array(z.string().min(1).max(4000)).max(100),
  items:z.array(z.object({
    id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), title:z.string().min(1).max(500),
    kind:z.enum(['page','template','data','interaction','implementation','seo','workflow']), required:z.boolean(),
    source:z.string().min(1).max(4000), expectation:z.string().min(1).max(12000),
    paths:z.array(z.string().max(2000)).max(5000), expectedCount:z.number().int().nonnegative().nullable(),
    expectedKeys:z.array(z.string().max(2000)).max(20000).optional(), samples:z.array(z.string().max(2000)).max(100).optional(),
    dataIdentity:dataIdentitySchema.optional(),
    viewports:z.array(viewport).min(1).max(3),
  }).strict()).min(1).max(1000), evidence:z.array(z.string()).max(200), migration:migrationBaselineSchema.optional(),
}).strict().superRefine((v,c)=>{
  if(new Set(v.items.map(i=>i.id)).size!==v.items.length)c.addIssue({code:'custom',message:'清单 ID 不能重复'});
  for(const i of v.items){
    if(['page','template'].includes(i.kind)&&(!i.paths.length||!i.viewports.includes('desktop')||!i.viewports.includes('mobile')))c.addIssue({code:'custom',message:'页面及动态模板需声明路径并覆盖 PC / 移动端'});
    if(i.expectedKeys&&new Set(i.expectedKeys).size!==i.expectedKeys.length)c.addIssue({code:'custom',message:'预期记录标识不能重复'});
    if(i.dataIdentity&&i.kind!=='data')c.addIssue({code:'custom',message:'仅data交付项可声明dataIdentity计量域'});
    if(i.dataIdentity?.kind==='relations'){
      const identity=i.dataIdentity,refs=[...identity.parentRequirementIds,...identity.childRequirementIds];
      if(new Set(identity.parentRequirementIds).size!==identity.parentRequirementIds.length||new Set(identity.childRequirementIds).size!==identity.childRequirementIds.length)c.addIssue({code:'custom',message:'关系计量域的父子清单引用不能重复'});
      for(const id of refs){
        const referenced=v.items.find(item=>item.id===id);
        if(id===i.id)c.addIssue({code:'custom',message:'关系计量域不得自引用或循环引用'});
        if(!referenced?.required||!(referenced.kind==='page'&&referenced.paths.length||referenced.kind==='data'&&(!referenced.dataIdentity||referenced.dataIdentity.kind==='page')&&referenced.expectedKeys?.length))c.addIssue({code:'custom',message:'关系计量域必须引用有效required page全量路径或data page域全部标识：'+id});
      }
      let sourceOrigin:string|undefined;
      for(const key of i.expectedKeys||[]){
        let pair:unknown;try{pair=JSON.parse(key);}catch{/* Rejected below. */}
        if(!Array.isArray(pair)||pair.length!==2||JSON.stringify(pair)!==key){c.addIssue({code:'custom',message:'关系标识必须为规范JSON.stringify([parentSourceURL,childSourceURL])'});continue;}
        const parent=canonicalSourceUrl(pair[0]),child=canonicalSourceUrl(pair[1]);
        if(!parent||!child||parent.origin!==child.origin||sourceOrigin&&sourceOrigin!==parent.origin){c.addIssue({code:'custom',message:'关系标识必须使用同源、规范化的完整HTTP(S) URL'});continue;}
        sourceOrigin=parent.origin;
        for(const [endpoint,ids] of [[parent,identity.parentRequirementIds],[child,identity.childRequirementIds]] as const){
          const belongs=ids.some(id=>{const ref=v.items.find(item=>item.id===id);return (ref?.kind==='page'?ref.paths:ref?.expectedKeys||[]).some(value=>{try{return new URL(value,sourceOrigin).href===endpoint.href;}catch{return false;}});});
          if(!belongs)c.addIssue({code:'custom',message:'关系端点不属于对应父子引用的全部来源标识：'+endpoint.href});
        }
      }
    }
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string):boolean=>{if(visiting.has(id))return true;if(visited.has(id))return false;visiting.add(id);const identity=v.items.find(item=>item.id===id)?.dataIdentity;if(identity?.kind==='relations'&&[...identity.parentRequirementIds,...identity.childRequirementIds].some(visit))return true;visiting.delete(id);visited.add(id);return false;};
  if(v.items.some(item=>visit(item.id)))c.addIssue({code:'custom',message:'关系计量域不得自引用或循环引用'});
  if(!v.sourceComplete&&!v.limitations.length)c.addIssue({code:'custom',message:'来源未完整覆盖时必须说明缺口'});
});
export const checksSchema=z.array(z.object({id:z.string(),status:z.enum(['verified','partial','missing','unverified','excluded']),reason:z.string().min(1).max(12000),evidence:z.array(z.string()).max(1000),checkedViewports:z.array(viewport).max(3),actualCount:z.number().int().nonnegative().nullable(),sampledPaths:z.array(z.string()).max(5000),checkedKeys:z.array(z.string()).max(20000)}).strict()).max(1000);
/** Shared by persistence and host verification of append-only frozen manifests. */
export function assertRequirementDataIdentityPreserved(previous:Requirement,next:Requirement):void {
  const old=previous.dataIdentity,current=next.dataIdentity;
  // Legacy domains can be explicitly clarified once; the host must reconcile that
  // clarification against frozen source evidence before certifying target coverage.
  if(!old)return;
  if(!current||old.kind!==current.kind)throw new Error('不得移除或变更已固定的data计量域');
  if(old.kind==='relations'&&(current.kind!=='relations'||old.parentRequirementIds.some(id=>!current.parentRequirementIds.includes(id))||old.childRequirementIds.some(id=>!current.childRequirementIds.includes(id))))throw new Error('不得缩减已固定关系计量域的父子清单引用');
}
export class ManifestStore {
  constructor(readonly store:AutomationStore){store.db.exec('CREATE TABLE IF NOT EXISTS auto_requirement_manifests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS auto_manifest_artifacts(name TEXT PRIMARY KEY,task_id TEXT NOT NULL,sha256 TEXT NOT NULL)');}
  get(id?:string):RequirementManifest|undefined {if(!id)return;const row=this.store.db.prepare('SELECT json FROM auto_requirement_manifests WHERE id=?').get(id);return row?JSON.parse(row.json):undefined;}
  save(task:AutomationTask,raw:unknown,actor:'human'|'ai',expectedId?:string){return this.store.db.transaction(()=>{
    const input=manifestInput.parse(this.store.sanitize(raw)),old=this.get(task.requirementsId);
    if(expectedId!==undefined&&expectedId!==(task.requirementsId||''))throw new Conflict('交付清单已更新，请刷新后重试');
    if(input.migration&&input.migration.inputVersionId!==task.versionId)throw new Conflict('迁移基线与固定输入版本不一致');
    try{assertMigrationBaselinePreserved(old?.migration,input.migration);}catch(error){throw new Conflict((error as Error).message);}
    if(old&&old.items.some(i=>i.required&&!input.items.some(n=>n.id===i.id&&n.required&&n.kind===i.kind&&i.paths.every(p=>n.paths.includes(p))&&i.viewports.every(v=>n.viewports.includes(v))&&(i.expectedCount===null||n.expectedCount!==null&&n.expectedCount>=i.expectedCount)&&(i.expectedKeys||[]).every(k=>n.expectedKeys?.includes(k))&&(i.samples||[]).every(k=>n.samples?.includes(k)))))throw new Conflict('不得移除、缩减或降级已固定的必交付范围；请新增说明并在评测中记录排除依据');
    try{for(const previous of old?.items||[]){const next=input.items.find(item=>item.id===previous.id);if(next)assertRequirementDataIdentityPreserved(previous,next);}}catch(error){throw new Conflict((error as Error).message);}
    const sourceEvidence=input.evidence.flatMap(name=>{const row=this.store.db.prepare('SELECT task_id AS taskId,sha256 FROM auto_manifest_artifacts WHERE name=?').get(name);return row?[{name,taskId:String(row.taskId),sha256:String(row.sha256)}]:[];});
    const value:RequirementManifest={...input,id:randomUUID(),taskId:task.id,revision:(old?.revision||0)+1,createdAt:Date.now(),actor,sourceEvidence};
    this.store.db.prepare('INSERT INTO auto_requirement_manifests VALUES(?,?,?,?)').run(value.id,task.id,value.revision,JSON.stringify(value));task.requirementsId=value.id;this.store.put(task);return value;
  });}
}
export function validateCompleteness(raw:unknown,manifest:RequirementManifest,files:MaterialFile[],observations:Record<string,{url:string;role:string;viewport:string}>={},targetBaseUrl?:string,pageAliases:Readonly<Record<string,string>>={}):CompletenessReport {
  const checks=checksSchema.parse(raw),names=new Set(files.map(f=>f.name));
  const samplePath=(value:string)=>{if(Object.hasOwn(pageAliases,value)){const path=pageAliases[value];if(!path.startsWith('/')||path.startsWith('//'))throw new Error('冻结页面样本别名不是有效路径：'+value);return path;}if(/^u\d+$/.test(value))throw new Error('未知或歧义的采集页面样本ID：'+value);return value;};
  const pathKey=(value:string)=>{const parsed=new URL(value,targetBaseUrl||'https://placeholder.test');return parsed.origin+parsed.pathname+parsed.search;};
  if(checks.length!==manifest.items.length||new Set(checks.map(c=>c.id)).size!==checks.length||checks.some(c=>!manifest.items.some(i=>i.id===c.id)))throw new Error('完整度结果必须逐项对应冻结清单，不得删除遗漏项');
  for(const check of checks){
    const item=manifest.items.find(i=>i.id===check.id)!;
    if(check.evidence.some(n=>!names.has(n)))throw new Error('完整度结果引用了不存在的证据');
    if(item.required&&check.status==='excluded')throw new Error('必交付项不能由评测员自行排除');
    if(check.status==='verified'){
      if(!check.evidence.length||item.viewports.some(v=>!check.checkedViewports.includes(v)))throw new Error('已验证项必须有证据并覆盖规定视口');
      if(item.kind==='data'&&(item.expectedCount===null||check.actualCount===null||check.actualCount<item.expectedCount||!item.expectedKeys||new Set(item.expectedKeys).size!==item.expectedCount||!check.checkedKeys||new Set(check.checkedKeys).size!==check.actualCount||item.expectedKeys.some(k=>!check.checkedKeys?.includes(k))))throw new Error('动态内容必须核对预期数量与全部记录标识（按声明的页面记录、页面成员关系或素材计量域）；总数或来源标识未知时不可判定完成');
      if(['data','template','implementation'].includes(item.kind)&&!check.evidence.some(n=>n.startsWith('implementation-')&&n.endsWith('.json')))throw new Error('动态内容和实现规范必须有只读后台证据，截图不能证明实现');
      if(['page','template'].includes(item.kind)){
        const sampledPaths=check.sampledPaths.map(samplePath),sampledKeys=new Set(sampledPaths.map(pathKey));
        if(!sampledPaths.length||item.kind==='page'&&item.paths.some(p=>!sampledKeys.has(pathKey(p)))||item.kind==='template'&&(!item.samples?.length||item.samples.some(p=>!sampledKeys.has(pathKey(samplePath(p))))))throw new Error('静态页面应覆盖清单路径；动态模板需声明样本及边界路径');
        for(const path of item.kind==='page'?item.paths:sampledPaths)for(const v of item.viewports.filter(v=>v!=='business')){
          if(!check.evidence.some(n=>{const f=files.find(f=>f.name===n),o=observations[n];if(!f||!o||f.role!=='target'||o.role!=='target'||o.viewport!==v||f.viewport!==v||f.type!=='image/png')return false;try{const expected=new URL(path,targetBaseUrl||'https://placeholder.test'),actual=new URL(o.url);return (!targetBaseUrl||expected.origin===new URL(targetBaseUrl).origin&&actual.origin===expected.origin&&!actual.username&&!actual.password)&&expected.pathname===actual.pathname&&expected.search===actual.search;}catch{return false;}}))throw new Error('页面路径 '+path+' 缺少对应 '+v+' 的真实截图与 URL 观察，不能复用首页截图证明全部页面');
        }
      }
    }
  }
  const required=checks.filter(c=>manifest.items.find(i=>i.id===c.id)!.required);
  // Structured migration must be independently reconciled by the host. An AI's
  // legacy count-based checks cannot certify the new contract before integration.
  const state=required.some(c=>c.status==='missing'||c.status==='partial')?'incomplete':!manifest.sourceComplete||manifest.migration||required.some(c=>c.status!=='verified')?'unverified':'complete';
  return {manifestId:manifest.id,manifestRevision:manifest.revision,sourceComplete:manifest.sourceComplete,state,checks};
}

/** Source-verified read-only allowlist. Commerce list uses a fixed query-only POST body. */
export async function inspectImplementation(task:AutomationTask,store:AutomationStore,vault:Vault,signal:AbortSignal,raw:unknown){
  const input=z.object({kind:z.enum(['pages','routes','views','codes','page','view','code','folders','content','contentItem','tables','rows','products','product','categories']),id:z.string().regex(/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9-]{36})$/).optional(),table:z.string().min(1).max(200).optional(),page:z.number().int().min(1).max(100000).default(1)}).strict().parse(raw);
  const paths:Record<string,string>={pages:'Page/All',routes:'Route/List',views:'View/List',codes:'Code/List',page:'Page/Get',view:'View/Get',code:'Code/Get',folders:'ContentFolder/List',content:'TextContent/ByFolder',contentItem:'TextContent/Get',tables:'Sqlite/Tables',rows:'Sqlite/Data',products:'productManagement/PagingList',product:'productManagement/GetEdit',categories:'ProductCategory/List'};
  if(['page','view','code','content','contentItem','product'].includes(input.kind)&&!input.id)throw new Error('读取此类实现需要 id');if(input.kind==='rows'&&!input.table)throw new Error('读取数据需要 table');
  const site=task.generatedSiteId&&store.site(task.generatedSiteId);if(!site)throw new Error('无生成站');
  const query=new URLSearchParams({pageNr:String(input.page),pageSize:'100'});if(input.id)query.set(input.kind==='content'?'FolderId':'id',input.id);if(input.table)query.set('table',input.table);
  const value=await koobooClient(task,vault,signal).request(paths[input.kind]+'?'+query.toString(),input.kind==='products'?{pageIndex:input.page,pageSize:100,keyword:''}:undefined,site.siteId);
  return store.sanitize({request:input,value,capturedAt:Date.now(),note:'仅代表当前分页；总量、逐条标识及路由对应需完整核对。权限或能力不足需标记未验证。'});
}
export function evidenceWriter(work:string,artifacts:MaterialFile[],role:'content'|'target',prefix:string,checkpoint?:(file:MaterialFile)=>void){mkdirSync(resolve(work,'evidence'),{recursive:true,mode:0o700});return (value:unknown)=>{const name=prefix+'-'+randomUUID()+'.json',bytes=Buffer.from(JSON.stringify(value));writeFileSync(resolve(work,'evidence',name),bytes,{mode:0o600});const file:MaterialFile={id:randomUUID(),name,type:'application/json',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role};artifacts.push(file);checkpoint?.(file);return {evidence:name,result:value};};}
export function sourceReader(task:AutomationTask,store:AutomationStore,directory:string,write:(value:unknown)=>unknown){
  const input=effectiveCollectionInput(task,store,directory)!;
  return async(raw:unknown,signal:AbortSignal)=>{
    const spec=z.object({kind:z.enum(['source','material']),role:z.enum(['content','reference']).optional(),url:z.string().max(2000).optional(),id:z.string().optional()}).strict().parse(raw);
    if(spec.kind==='material'){const file=input.files.find(f=>f.id===spec.id);if(!file)throw new Error('资料不存在');const bytes=readMaterial(directory,file);if(/text|json|xml|csv|svg/.test(file.type)||/\.(md|txt|json|csv|xml|svg)$/i.test(file.name)){const text=bytes.toString('utf8');return write({kind:'material',id:file.id,name:file.name,text:text.slice(0,80000),truncated:text.length>80000});}const record=write({kind:'material',id:file.id,name:file.name,type:file.type,sha256:file.sha256,size:bytes.length});return {...record as object,...(file.type.startsWith('image/')?{imagePath:resolve(directory,'materials',file.id),note:'需实际查看图片后提炼要求'}:{filePath:resolve(directory,'materials',file.id),note:'使用本地只读工具检查原始文件，无法读取的资料需明确标记未验证'})};}
    const base=spec.role==='reference'?input.referenceUrl||input.contentUrl:input.contentUrl;if(!base)throw new Error('无此来源站');const url=new URL(spec.url||base,base);if(url.origin!==new URL(base).origin||url.username||url.password)throw new Error('只能读取本任务来源站域名');
    const result=await httpRead(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),limit:1024*1024});return write({kind:'source',url:url.href,status:result.status,body:result.body.slice(0,100000),truncated:result.body.length>100000});
  };
}
export async function ensureManifest(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal){
  if(!task.requirementsEnabled||task.scope!=='site'||task.requirementsId)return;
  const manifests=new ManifestStore(store),work=resolve(directory,'manifest-runs',task.id),artifacts:MaterialFile[]=[],write=evidenceWriter(work,artifacts,'content','source',file=>store.db.prepare('INSERT INTO auto_manifest_artifacts VALUES(?,?,?)').run(file.name,task.id,file.sha256));
  const input=store.version(task.versionId)!,policy=task.completenessPolicy||defaultCompletenessSettings;
  const context={scenario:task.scenario,scope:task.scope,input,message:task.message,submissionSchema:z.toJSONSchema(manifestInput),dataIdentityInstructions:'data项必须按来源声明计量域dataIdentity：page记录、relations精确页面成员边或assets素材；省略仅兼容旧page记录，不能按ID或标题自动猜测。每个域都需要完整expectedKeys及expectedCount，未知时保留未验证，不能以目标反推来源总量。relations键为JSON.stringify([parentSourceURL,childSourceURL])，保留分页及首页别名的精确页面身份；同源完整HTTP(S) URL须规范化，并引用本清单required page的全量paths或required data page域的全部expectedKeys。页面成员关系数量不能替换成去重后的业务实体关系数量；来源素材URL数量不能替换成去重文件数量。只有正常extend_manifest才能补充冻结范围，已显式计量域及父子引用不能缩减。'};
  try{await localDecision({task,store,vault,directory,id:'manifest-'+task.id,stage:'planning',sop:policy.sop+'\n从冻结资料与源站建立应交付清单，不能根据生成站已经做了什么缩减要求。先通过 read 查询来源：{kind:"source",role:"content"或"reference",url:同域URL}、{kind:"material",id:附件ID}。发现导航、sitemap、列表、动态内容、静态页面、交互和业务流程。覆盖范围不明确必须 sourceComplete=false 并说明缺口。每项来源必须引用读到的证据。动态内容列出全部 expectedKeys 和 expectedCount，不能只给采样数；静态页面全覆盖 PC/移动，动态模板声明边界样本。App 按业务流程列项。迁移/升级检查 URL 和 SEO，模板采用替代图片/示例内容，不要求搬运原站版权资源或继承原站 SEO。只读探查不可提交表单。submit.result 必须符合 context.submissionSchema。',context,policy:{key:'planning:'+task.id,runKey:task.id,maxTokens:policy.maxTokens,maxRequests:policy.maxRequests},minutes:policy.maxMinutes,signal,read:sourceReader(task,store,directory,write),submit:raw=>{
      const parsed=manifestInput.parse(raw);if(parsed.evidence.some(e=>!artifacts.some(f=>f.name===e)))throw new Error('清单引用了不存在的来源证据');if((input.contentUrl||input.referenceUrl||input.files.length)&&!parsed.evidence.length)throw new Error('清单必须先读取资料或来源站');return manifests.save(task,parsed,'ai');
    }});
  }catch(error){signal.throwIfAborted();if(task.requirementsId)return;store.event(task.id,'清单规划未完成，保留未验证基线：'+(error as Error).message);manifests.save(task,{sourceComplete:false,limitations:['规划未完成：'+(error as Error).message],evidence:artifacts.map(f=>f.name),items:[{id:'source-coverage',title:'来源与全部交付范围待核对',kind:'implementation',required:true,source:'冻结输入 '+task.versionId,expectation:'独立评测必须重新检查来源，补充完整清单并验证全部交付范围，不能以现有产物倒推全部范围。',paths:[],expectedCount:null,viewports:['business']}]},'ai');}
}
