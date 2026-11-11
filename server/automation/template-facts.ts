import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { Requirement, RequirementManifest } from '../../shared/completeness.js';
import { templateTargetPath } from './template-path.js';
import { pageScreenshotPolicy } from './page-screenshots.js';

export function canonicalValue(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalValue).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonicalValue(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export function readRegisteredEvidence(work:string,file:MaterialFile){
  if(!/^[a-zA-Z0-9_.-]+$/.test(file.name)||['.','..'].includes(file.name))throw new Error('证据文件名无效');
  const bytes=readFileSync(resolve(work,'evidence',file.name));
  if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('证据字节已变化');
  return bytes;
}
export interface TemplateRecordFacts {
  id:string;state:'verified'|'missing'|'unverified';reason:string;evidence:string[];
  expectedCount:number|null;actualCount:number|null;checkedKeys:string[];missingKeys:string[];unexpectedKeys:string[];emptyFields:{key:string;fields:string[]}[];
}
export interface TemplateFacts {
  version:1;taskId:string;siteRevision:string;manifestId:string|null;
  pages:{id:string;paths:{path:string;viewports:{viewport:string;image?:string;observation?:string;images?:string[];observations?:string[];coverageComplete?:boolean;gaps?:string[];navigationStatus:number|null;settled:boolean;state:'captured'|'missing'}[]}[]}[];
  records:TemplateRecordFacts[];
}
type ImplementationReader=(request:unknown)=>Promise<{evidence:string;result:unknown}>;
const field=(value:unknown,name:string):unknown=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const key=Object.keys(value).find(k=>k.toLowerCase()===name.toLowerCase());return key===undefined?undefined:(value as Record<string,unknown>)[key];
};
// These are the concrete read models of Sqlite/Data and TextContent/ByFolder.
function recordField(row:unknown,name:string,storage:'content'|'sqlite'|'commerce'):unknown {
  if(storage==='sqlite'&&Array.isArray(row)){
    const matches=row.filter(cell=>field(cell,'key')===name);
    return matches.length===1?field(matches[0],'value'):undefined;
  }
  if(storage==='content'&&field(row,name)===undefined)return field(field(row,'textValues'),name);
  return field(row,name);
}
/** Strict paginated contracts only. An unknown response shape is not an empty successful collection. */
export async function templateRecordFacts(item:Requirement,read:ImplementationReader,signal:AbortSignal):Promise<TemplateRecordFacts>{
  const out:TemplateRecordFacts={id:item.id,state:'unverified',reason:'未声明程序记录对账契约，语义与存储对应需独立核实',evidence:[],expectedCount:item.expectedCount,actualCount:null,checkedKeys:[],missingKeys:[],unexpectedKeys:[],emptyFields:[]};
  const contract=item.records;if(!contract)return out;
  const expected=item.expectedKeys;
  if(item.kind!=='data'||item.dataIdentity&&item.dataIdentity.kind!=='page'||!expected||item.expectedCount!==expected.length||new Set(expected).size!==expected.length){out.reason='来源计量域、数量或全部标识未固定，不能完成程序对账';return out;}
  const rows:unknown[]=[];let pages:number|undefined,total:number|undefined;
  try{
    for(let page=1;page<=100;page++){
      signal.throwIfAborted();
      const request=contract.storage==='content'?{kind:'content',id:contract.container,page}:contract.storage==='sqlite'?{kind:'rows',table:contract.container,page}:{kind:'products',page};
      const saved=await read(request);out.evidence.push(saved.evidence);
      let payload=field(saved.result,'value');
      if(field(payload,'value')!==undefined)payload=field(payload,'value');
      const list=field(payload,'list');
      const commerce=contract.storage==='commerce';
      const pageSize=field(payload,'pageSize');
      const pageNr=field(payload,commerce?'pageIndex':'pageNr'),count=field(payload,commerce?'count':'totalCount');
      const pageCount=commerce?(Number.isSafeInteger(pageSize)&&Number(pageSize)>0&&Number.isSafeInteger(count)?Math.ceil(Number(count)/Number(pageSize)):undefined):field(payload,'totalPages');
      if(!Array.isArray(list)||!Number.isSafeInteger(pageNr)||pageNr!==page||!Number.isSafeInteger(pageCount)||Number(pageCount)<0||!Number.isSafeInteger(count)||Number(count)<0)throw new Error('分页缺少可信list/pageNr/totalPages/totalCount，不能猜测全集');
      if(pages!==undefined&&(pages!==pageCount||total!==count))throw new Error('分页期间总量发生变化');
      pages=Number(pageCount);total=Number(count);
      if(pages===0&&(total!==0||list.length)||pages>0&&page>pages||page<pages&&!list.length)throw new Error('分页元数据与实际记录矛盾');
      rows.push(...list);if(rows.length>10000)throw new Error('程序对账超过本轮10000条读取窗口，未声明已完成');
      if(page>=pages)break;
      if(page===100)throw new Error('程序对账超过本轮100页读取窗口，未声明已完成');
    }
    if(rows.length!==total)throw new Error('记录列表与声明总量不一致');
    const keys=rows.map(row=>recordField(row,contract.keyField,contract.storage));
    if(keys.some(key=>typeof key!=='string'&&typeof key!=='number'))throw new Error('记录缺少固定标识字段');
    const actual=keys.map(String);
    if(actual.some(key=>!key)||new Set(actual).size!==actual.length)throw new Error('记录标识为空或重复，不能按去重数量冒充完整');
    out.actualCount=actual.length;out.checkedKeys=actual;
    const wanted=new Set(expected),got=new Set(actual);out.missingKeys=expected.filter(key=>!got.has(key));out.unexpectedKeys=actual.filter(key=>!wanted.has(key));
    out.emptyFields=rows.flatMap((row,index)=>{const fields=(contract.requiredFields||[]).filter(name=>{const value=recordField(row,name,contract.storage);return value===undefined||value===null||typeof value==='string'&&!value.trim();});return fields.length?[{key:actual[index],fields}]:[];});
    out.state=out.missingKeys.length||out.unexpectedKeys.length||out.emptyFields.length?'missing':'verified';
    out.reason=`程序已核对${actual.length}条记录：缺少${out.missingKeys.length}、多余${out.unexpectedKeys.length}、必填字段缺失${out.emptyFields.length}条；此结论仅涵盖声明的标识/数量/必填字段，不替代语义、动态渲染或视觉验收。`;
  }catch(error){signal.throwIfAborted();out.reason=error instanceof Error?error.message:'程序记录对账未完成';}
  return out;
}

/** All supplied files have already crossed the host binding validator; bytes are checked again before reading. */
export async function prepareTemplateFacts(input:{task:AutomationTask;manifest?:RequirementManifest;work:string;files:MaterialFile[];target:string;source:string;read:ImplementationReader;signal:AbortSignal}):Promise<TemplateFacts>{
  const {task,manifest,work,files,target,source,read,signal}=input;
  const facts:TemplateFacts={version:1,taskId:task.id,siteRevision:task.siteRevision||'',manifestId:manifest?.id||null,pages:[],records:[]};
  let capturePlan:{policy:string;progress:{slot:{role:string;viewport:string;url:string};files:string[];coverageComplete:boolean;gaps:string[];error?:string}[]}|undefined;
  try{capturePlan=JSON.parse(readFileSync(resolve(work,'capture-plan.json'),'utf8'));}catch{/* Missing coverage remains unverified for the live template path. */}
  const observations=files.filter(f=>f.type==='application/json'&&f.role==='target'&&/^[a-f0-9-]{36}\.json$/.test(f.name)).flatMap(file=>{try{return [{file,value:JSON.parse(readRegisteredEvidence(work,file).toString())}];}catch{return [];}});
  for(const item of manifest?.items||[]){
    if(['page','template'].includes(item.kind))facts.pages.push({id:item.id,paths:(item.kind==='page'?item.paths:item.samples||[]).map(path=>({path,viewports:item.viewports.filter(v=>v!=='business').map(viewport=>{
      let url:string;try{url=new URL(templateTargetPath(path,target,source),target).href;}catch{return {viewport,navigationStatus:null,settled:false,state:'missing' as const};}
      const matches=observations.filter(({value:o})=>o.binding?.taskId===task.id&&o.binding?.siteRevision===(task.siteRevision||'')&&o.role==='target'&&o.viewport===viewport&&o.url===url).sort((a,b)=>(b.value.capturedAt||0)-(a.value.capturedAt||0));
      const slot=capturePlan?.policy===pageScreenshotPolicy?capturePlan.progress.find(p=>p.slot.role==='target'&&p.slot.viewport===viewport&&p.slot.url===url):undefined;
      const selected=slot?matches.filter(m=>slot.files.includes(m.file.name)):matches.slice(0,1);
      const pairs=selected.flatMap(found=>{const image=files.find(f=>f.name===found.value.file&&f.type==='image/png'&&f.role==='target'&&f.viewport===viewport);return image?[{found,image}]:[];});
      if(!pairs.length)return {viewport,navigationStatus:null,settled:false,state:'missing' as const};
      const coverageComplete=slot?slot.coverageComplete&&slot.files.length===pairs.length*2:!(task.kind==='evaluation'&&task.scenario==='site-template');
      const images=pairs.map(p=>p.image.name),jsons=pairs.map(p=>p.found.file.name),status=pairs.find(p=>Number.isInteger(p.found.value.navigationStatus))?.found.value.navigationStatus;
      const gaps=[...(slot?.gaps||[]),...(slot?.error?[slot.error]:[])];
      return {viewport,image:images[0],observation:jsons[0],images,observations:jsons,coverageComplete,gaps,navigationStatus:status??null,settled:coverageComplete&&pairs.every(p=>p.found.value.settlement?.settled===true),state:'captured' as const};
    })}))});
    if(item.kind==='data')facts.records.push(await templateRecordFacts(item,read,signal));
  }
  writeFileSync(resolve(work,'template-program.json'),JSON.stringify(facts,null,2),{mode:0o600});return facts;
}

/** The model judges semantics, while host counters and full identities come from the actual read. */
export function applyTemplateFacts(raw:unknown,facts:TemplateFacts|undefined,manifest?:RequirementManifest):unknown{
  if(!facts||!raw||typeof raw!=='object')return raw;
  const result=structuredClone(raw) as {completeness?:Record<string,unknown>[]};
  if(!Array.isArray(result.completeness))return result;
  for(const check of result.completeness){
    const pages=facts.pages?.find(p=>p.id===check.id),item=manifest?.items.find(i=>i.id===check.id);
    if(pages){
      const wanted=item?(item.kind==='template'?item.samples||[]:item.paths):undefined,paths=pages.paths.filter(p=>!wanted||wanted.includes(p.path));
      const views=paths.flatMap(p=>p.viewports),evidence=views.flatMap(v=>v.images&&v.observations?[...v.images,...v.observations]:v.image&&v.observation?[v.image,v.observation]:[]);
      check.evidence=[...new Set([...(Array.isArray(check.evidence)?check.evidence as string[]:[]),...evidence])];
      check.sampledPaths=paths.filter(p=>p.viewports.length&&p.viewports.every(v=>v.state==='captured'&&v.settled)).map(p=>p.path);
      check.checkedViewports=[...new Set(views.map(v=>v.viewport))].filter(viewport=>paths.length&&paths.every(p=>p.viewports.some(v=>v.viewport===viewport&&v.state==='captured'&&v.settled)));
      if(views.some(v=>v.navigationStatus!==null&&(v.navigationStatus<200||v.navigationStatus>=300))&&check.status==='verified'){check.status='partial';check.reason=String(check.reason||'')+'；程序记录到非成功HTTP导航状态，不能声明该页面完成';}
      if((!paths.length||paths.some(p=>!p.viewports.length||p.viewports.some(v=>v.state==='missing'||!v.settled)))&&check.status==='verified'){check.status='unverified';check.reason=String(check.reason||'')+'；程序取证覆盖或页面稳定状态不完整';}
    }
    const proof=facts.records.find(p=>p.id===check.id&&p.evidence.length);if(!proof)continue;
    check.evidence=[...new Set([...(Array.isArray(check.evidence)?check.evidence as string[]:[]),...proof.evidence])];
    check.actualCount=proof.actualCount;check.checkedKeys=proof.checkedKeys;
    if(proof.state==='missing'&&check.status!=='missing'&&check.status!=='partial'){check.status='partial';check.reason=String(check.reason||'')+'；'+proof.reason;}
    if(proof.state==='unverified'&&check.status==='verified'){check.status='unverified';check.reason=String(check.reason||'')+'；'+proof.reason;}
  }
  return result;
}
