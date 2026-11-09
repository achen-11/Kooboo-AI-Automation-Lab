import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

export interface CollectionAssetBinding { sourceUrl:string; materialPath:string; targetUrl:string }
export interface FrozenSourceAsset { sourceUrl:string; materialPath:string; sha256:string; size:number }
export interface AssetSourceIssue { sourceUrl?:string; reason:string }
export interface FrozenAssetSource {
  sourceUrl:string; expectedKeys:string[]; expectedCount:number|null;
  assets:FrozenSourceAsset[]; excludedKeys:string[]; issues:AssetSourceIssue[];
}
/** A host digest of the actual response bytes, suitable for a revision-bound B checkpoint. */
export interface AssetTargetObservation { url:string; finalUrl:string; status:number; sha256:string; size:number }
export interface AssetTargetCheck {
  sourceUrl:string; materialPath?:string; targetUrl?:string;
  status:'verified'|'missing'|'unverified'; reason:string;
  expected?:{sha256:string;size:number}; actual?:{sha256:string;size:number;status:number};
}
export interface AssetTargetComparison {
  state:'complete'|'incomplete'|'unverified'; checks:AssetTargetCheck[]; issues:AssetSourceIssue[];
  expectedKeys:string[]; actualKeys:string[];
  /** Unique, validated target URLs. Feed only these URLs to the controlled reader. */
  requests:string[];
}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const unique=<T>(values:T[])=>[...new Set(values)];
function assetUrl(value:string,base:string){
  const result=new URL(value,base);
  if(!['http:','https:'].includes(result.protocol)||result.username||result.password)throw new Error('素材 URL 必须为无凭据 HTTP(S) 地址');
  result.hash='';return result;
}
function materialPath(value:unknown):value is string {
  return typeof value==='string'&&!!value&&!/[\\\0:]/.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
}

/** Source identities and hashes come exclusively from the frozen state and original bytes. */
export function parseFrozenAssetSource(input:{state:unknown;sourceUrl:string;expectedKeys?:readonly string[];expectedCount:number|null;readFrozen:(path:string)=>Buffer;collection?:'assets'|'files'|'stylesheets'}):FrozenAssetSource {
  const result:FrozenAssetSource={sourceUrl:input.sourceUrl,expectedKeys:[],expectedCount:input.expectedCount,assets:[],excludedKeys:[],issues:[]};
  const issue=(reason:string,sourceUrl?:string)=>result.issues.push({...(sourceUrl?{sourceUrl}:{}),reason});
  let base:URL;try{base=assetUrl(input.sourceUrl,input.sourceUrl);}catch{issue('冻结来源 URL 无效');return result;}
  const state=object(input.state),collection=input.collection||'assets';
  if(state?.source!==input.sourceUrl)issue('冻结素材状态与固定来源不一致');
  const rawKeys=input.expectedKeys;
  if(!Array.isArray(rawKeys))issue('清单缺少完整素材来源 URL 身份全集');
  for(const key of rawKeys||[]){try{if(typeof key!=='string'||!key)throw new Error();result.expectedKeys.push(assetUrl(key,base.href).href);}catch{issue('清单素材来源 URL 无效');}}
  if(new Set(result.expectedKeys).size!==result.expectedKeys.length)issue('清单素材来源 URL 重复或冲突');
  result.expectedKeys=unique(result.expectedKeys);
  if(!Number.isSafeInteger(input.expectedCount)||input.expectedCount===null||input.expectedCount<0||input.expectedCount!==result.expectedKeys.length)issue('清单素材数量必须与完整来源 URL 身份全集一致，不能仅按文件数量核验');
  if(!Array.isArray(state?.[collection])){issue('冻结状态缺少素材集合 '+collection);return result;}
  const expected=new Set(result.expectedKeys),records=new Map<string,Record<string,unknown>[]>(),successful=new Set<string>();
  for(const raw of state[collection] as unknown[]){
    const row=object(raw);let sourceUrl:string;
    try{if(typeof row?.url!=='string'||!row.url)throw new Error();sourceUrl=assetUrl(row.url,base.href).href;}catch{issue('冻结素材记录缺少有效来源 URL');continue;}
    const group=records.get(sourceUrl)||[];group.push(row!);records.set(sourceUrl,group);
    if(['saved','cached','deduped',...(collection==='stylesheets'?['read']:[])].includes(String(row!.status)))successful.add(sourceUrl);else result.excludedKeys.push(sourceUrl);
  }
  for(const sourceUrl of successful)if(!expected.has(sourceUrl))issue('清单遗漏冻结素材来源 URL，不能按目标文件反推或缩减来源全集',sourceUrl);
  for(const sourceUrl of result.expectedKeys){
    const rows=records.get(sourceUrl);
    if(!rows||rows.length!==1){issue(rows?'冻结素材来源 URL 重复或冲突':'清单素材身份不在冻结状态中',sourceUrl);continue;}
    if(!successful.has(sourceUrl)){issue('冻结素材未成功取得，不能列为已交付原件',sourceUrl);continue;}
    const row=rows[0];
    if(!materialPath(row.localPath)){issue('冻结素材缺少安全原件路径；读取状态不能替代冻结原始字节',sourceUrl);continue;}
    if(typeof row.hash!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.hash)){issue('冻结素材缺少有效原件哈希',sourceUrl);continue;}
    if(typeof row.bytes!=='number'||!Number.isSafeInteger(row.bytes)||row.bytes<1){issue('冻结素材缺少有效原件字节数',sourceUrl);continue;}
    try{
      const bytes=input.readFrozen(row.localPath);
      if(!Buffer.isBuffer(bytes)||bytes.length!==row.bytes||createHash(row.hash.length===40?'sha1':'sha256').update(bytes).digest('hex')!==row.hash)throw new Error('原件哈希或字节数变化');
      result.assets.push({sourceUrl,materialPath:row.localPath,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
    }catch{issue('冻结素材原件缺失、哈希或字节数变化',sourceUrl);}
  }
  result.excludedKeys=unique(result.excludedKeys);return result;
}

/** Compare every frozen URL identity. Multiple identities may legitimately share identical bytes. */
export function compareAssetTargets(source:FrozenAssetSource,bindings:readonly CollectionAssetBinding[],observations:readonly AssetTargetObservation[],targetBaseUrl:string):AssetTargetComparison {
  const issues=[...source.issues],checks:AssetTargetCheck[]=[],requests:string[]=[],expectedKeys=[...source.expectedKeys];
  const finish=():AssetTargetComparison=>({state:checks.some(check=>check.status==='missing')?'incomplete':issues.length||checks.some(check=>check.status!=='verified')||!checks.length&&source.expectedCount!==0?'unverified':'complete',checks,issues,expectedKeys,actualKeys:checks.filter(check=>check.status==='verified').map(check=>check.sourceUrl),requests:unique(requests)});
  let target:URL;try{target=assetUrl(targetBaseUrl,targetBaseUrl);}catch{issues.push({reason:'目标站 URL 无效'});return finish();}
  const expected=new Set(expectedKeys),declarations=new Map<string,CollectionAssetBinding[]>(),mapped=new Map<string,{asset:FrozenSourceAsset;url:string}>(),conflictingTargets=new Set<string>();
  for(const raw of bindings){
    let key:string;try{if(typeof raw?.sourceUrl!=='string')throw new Error();key=assetUrl(raw.sourceUrl,source.sourceUrl).href;}catch{issues.push({reason:'素材映射缺少有效来源 URL'});continue;}
    if(!expected.has(key)){issues.push({sourceUrl:key,reason:'素材映射越出冻结清单身份全集'});continue;}
    const group=declarations.get(key)||[];group.push(raw);declarations.set(key,group);
  }
  for(const key of expectedKeys){
    const assets=source.assets.filter(asset=>asset.sourceUrl===key),rows=declarations.get(key);
    if(assets.length!==1){checks.push({sourceUrl:key,status:'unverified',reason:'来源原件未唯一冻结，不能推导目标素材'});continue;}
    const asset=assets[0],expected={sha256:asset.sha256,size:asset.size};
    if(!rows||rows.length!==1){checks.push({sourceUrl:key,materialPath:asset.materialPath,expected,status:'unverified',reason:rows?'素材声明存在重复或冲突':'缺少 sourceUrl/materialPath/targetUrl 显式映射'});continue;}
    const row=rows[0];
    if(!materialPath(row.materialPath)||row.materialPath!==asset.materialPath){checks.push({sourceUrl:key,materialPath:asset.materialPath,expected,status:'unverified',reason:'素材映射未精确指向该来源冻结原件'});continue;}
    let url:URL;try{if(typeof row.targetUrl!=='string'||!row.targetUrl)throw new Error();url=assetUrl(row.targetUrl,target.href);if(url.origin!==target.origin)throw new Error();}catch{checks.push({sourceUrl:key,materialPath:asset.materialPath,expected,status:'unverified',reason:'目标素材 URL 越出当前目标站或含凭据'});continue;}
    mapped.set(key,{asset,url:url.href});
  }
  const targetDigests=new Map<string,string>();
  for(const {asset,url} of mapped.values()){const identity=asset.sha256+':'+asset.size,previous=targetDigests.get(url);if(previous&&previous!==identity)conflictingTargets.add(url);targetDigests.set(url,identity);}
  for(const [key,{asset,url}] of mapped){
    const common={sourceUrl:key,materialPath:asset.materialPath,expected:{sha256:asset.sha256,size:asset.size}};
    if(conflictingTargets.has(url)){checks.push({...common,status:'unverified',reason:'不同来源字节冲突地指向同一目标 URL'});continue;}
    requests.push(url);
    const matches=observations.filter(observation=>observation.url===url);
    if(matches.length!==1){checks.push({...common,targetUrl:url,status:'unverified',reason:matches.length?'目标原字节观测重复或冲突':'尚未取得目标原字节观测'});continue;}
    const actual=matches[0];let final:URL;
    try{final=assetUrl(actual.finalUrl,target.href);if(final.origin!==target.origin)throw new Error();}catch{checks.push({...common,targetUrl:url,status:'unverified',reason:'目标素材最终响应越出当前站点'});continue;}
    if(!Number.isInteger(actual.status)||!/^[a-f0-9]{64}$/.test(actual.sha256)||!Number.isSafeInteger(actual.size)||actual.size<0){checks.push({...common,targetUrl:url,status:'unverified',reason:'目标原字节观测缺少有效状态、SHA256 或字节数'});continue;}
    const digest={sha256:actual.sha256,size:actual.size,status:actual.status};
    if(actual.status<200||actual.status>=300){checks.push({...common,targetUrl:url,actual:digest,status:[404,410].includes(actual.status)?'missing':'unverified',reason:'目标素材响应 HTTP '+actual.status});continue;}
    const equal=actual.sha256===asset.sha256&&actual.size===asset.size;
    checks.push({...common,targetUrl:url,actual:digest,status:equal?'verified':'missing',reason:equal?'目标原字节 SHA256 与字节数逐来源 URL 匹配冻结原件':'目标素材原字节与冻结来源不一致'});
  }
  return finish();
}

/** No credentials, text decoding, arbitrary URLs or redirects outside the target origin. */
export async function readTargetAsset(value:string,options:{targetBaseUrl:string;allowedTargetUrls:readonly string[];signal:AbortSignal;maxBytes?:number}):Promise<AssetTargetObservation> {
  const target=assetUrl(options.targetBaseUrl,options.targetBaseUrl),initial=assetUrl(value,target.href),maxBytes=options.maxBytes??32*1024*1024;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('素材读取字节上限无效');
  if(initial.origin!==target.origin||!options.allowedTargetUrls.includes(initial.href))throw new Error('目标素材 URL 未在当前冻结映射许可中');
  let current=initial;
  for(let hop=0;hop<=4;hop++){
    options.signal.throwIfAborted();
    const result=await new Promise<{status:number;location?:string;sha256:string;size:number}>((resolve,reject)=>{
      const request=(current.protocol==='https:'?https:http).get(current,{signal:AbortSignal.any([options.signal,AbortSignal.timeout(30000)]),headers:{Connection:'close','Accept-Encoding':'identity'}},response=>{
        const hash=createHash('sha256');let size=0;
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){response.destroy(new Error('目标素材响应超过字节上限'));return;}hash.update(chunk);});
        response.on('end',()=>resolve({status:response.statusCode||0,location:response.headers.location,sha256:hash.digest('hex'),size}));response.on('error',reject);
      });request.on('error',reject);
    });
    if(result.status>=300&&result.status<400&&result.location){const next=assetUrl(result.location,current.href);if(next.origin!==target.origin)throw new Error('目标素材重定向越出当前站点');current=next;continue;}
    return {url:initial.href,finalUrl:current.href,status:result.status,sha256:result.sha256,size:result.size};
  }
  throw new Error('目标素材重定向次数超限');
}
