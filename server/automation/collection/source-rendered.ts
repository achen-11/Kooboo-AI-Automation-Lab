import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CollectionRun, SourceRenderedEvidence } from '../../../shared/collection.js';
import type { Requirement } from '../../../shared/completeness.js';
import { evaluationBrowser } from '../browser.js';
import { collectionHash, safeCollectionPath } from './runtime.js';
import type { CollectionStore } from './store.js';

export const sourceRenderedEvidencePath='site/source-rendered-evidence.json' as const;
type Binding=Pick<CollectionRun,'id'|'inputVersionId'|'engineVersion'|'sourceRenderedEvidence'>;
type Read=(path:string)=>Buffer;
const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
const normalized=(text:string)=>text.replace(/\s+/g,' ').trim();
function httpUrl(value:string){const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('来源渲染只允许无凭据的HTTP(S)页面');return url;}
function pageRecord(read:Read,url:string){
  const state=JSON.parse(read('.work/state.json').toString()),record=(Object.values(state.urls||{}) as any[]).find(item=>item.url===url&&item.action==='keep');
  if(!record||typeof record.id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(record.id)||typeof record.rawFile!=='string'||!Number.isInteger(record.status)||record.status<200||record.status>=300)throw new Error('来源渲染需要已登记keep且有成功HTTP原件的精确URL');
  if(httpUrl(url).origin!==httpUrl(state.source).origin)throw new Error('来源渲染页面不能越出固定来源');
  return record;
}
function observationText(value:unknown){
  const observation=object(value);
  if(!observation||observation.action!=='snapshot'||observation.role!=='content'||observation.viewport!=='desktop'||typeof observation.url!=='string'||typeof observation.text!=='string'||typeof observation.snapshot!=='string'||!Number.isSafeInteger(observation.capturedAt))throw new Error('来源浏览器观察格式不完整');
  if(observation.framesComplete!==true||observation.textTruncated!==false)throw new Error('来源渲染正文或frame不完整，不能闭合正文缺口');
  const frames=(observation.frames??[]) as unknown;
  if(!Array.isArray(frames)||frames.some(frame=>!object(frame)||typeof frame.url!=='string'||typeof frame.text!=='string'))throw new Error('来源frame正文格式不完整');
  const visibleText=[observation.text,...frames.map(frame=>frame.text)].filter(text=>normalized(text)).join('\n');
  if(!normalized(visibleText)||visibleText.length>120_000)throw new Error('来源浏览器没有完整可见正文');
  return {observation,frames:frames as {url:string;text:string}[],visibleText};
}
export function sourceRenderedEvidenceIndex(run:Binding){return {version:1,collectionId:run.id,inputVersionId:run.inputVersionId,engineVersion:run.engineVersion,evidence:run.sourceRenderedEvidence||[]};}

/** Works with live reads in A and frozen original reads in B; no mutable state is inferred. */
export function assertSourceRenderedEvidenceIndex(run:Binding,read:Read):void {
  if(!run.sourceRenderedEvidence?.length)return;
  const index=JSON.parse(read(sourceRenderedEvidencePath).toString());
  if(collectionHash(JSON.stringify(index))!==collectionHash(JSON.stringify(sourceRenderedEvidenceIndex(run))))throw new Error('来源渲染索引与当前固定输入不一致');
  if(new Set(run.sourceRenderedEvidence.map(item=>item.pageId)).size!==run.sourceRenderedEvidence.length||new Set(run.sourceRenderedEvidence.map(item=>item.url)).size!==run.sourceRenderedEvidence.length)throw new Error('来源渲染索引存在重复页面');
  for(const item of run.sourceRenderedEvidence){
    if(!/^[a-f0-9-]{36}$/.test(item.id)||item.collectionId!==run.id||item.inputVersionId!==run.inputVersionId||item.engineVersion!==run.engineVersion||item.viewport!=='desktop')throw new Error('来源渲染证据绑定无效');
    const record=pageRecord(read,item.url),expectedFolder=`site/source-rendered/${item.id}`;
    if(record.id!==item.pageId||record.rawFile!==item.rawPath||item.extractPath!==`.work/extract/${record.id}.json`||item.observationPath!==`${expectedFolder}/observation.json`||item.screenshotPath!==`${expectedFolder}/screenshot.png`)throw new Error('来源渲染页面或证据路径不一致');
    for(const [path,hash] of [[item.rawPath,item.rawSha256],[item.extractPath,item.extractSha256],[item.observationPath,item.observationSha256],[item.screenshotPath,item.screenshotSha256]])if(!/^[a-f0-9]{64}$/.test(hash)||collectionHash(read(path))!==hash)throw new Error('来源渲染证据哈希已变化：'+path);
    const {observation,frames,visibleText}=observationText(JSON.parse(read(item.observationPath).toString()));
    if(observation.url!==httpUrl(item.url).href||item.text!==observation.text||item.visibleText!==visibleText||JSON.stringify(item.frames)!==JSON.stringify(frames)||item.capturedAt!==observation.capturedAt||item.framesComplete!==(observation.framesComplete!==false)||item.textTruncated!==false)throw new Error('来源渲染正文与真实观察不一致');
    if(!read(item.screenshotPath).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('来源渲染缺少真实PNG截图');
  }
}

/** Only this one precise finding can be supplemented by independent browser evidence. */
export function sourceRenderedContentFinding(run:Binding,finding:{kind?:string;reason?:string;url?:string}):boolean {
  return finding.kind==='content'&&finding.reason==='empty-content'&&!!run.sourceRenderedEvidence?.some(item=>item.url===finding.url);
}
export function assertSourceRenderedManifest(run:Binding,items:readonly Requirement[]):void {
  for(const evidence of run.sourceRenderedEvidence||[]){
    const matches=(item:Requirement)=>item.required&&item.paths.some(path=>{try{return httpUrl(new URL(path,evidence.url).href).href===httpUrl(evidence.url).href;}catch{return false;}});
    if(!items.some(item=>item.kind==='page'&&matches(item)&&item.viewports.includes('desktop')&&item.viewports.includes('mobile'))||!items.some(item=>item.kind==='interaction'&&matches(item)))throw new Error('渲染来源必须有对应required page（desktop/mobile）和interaction功能交付项：'+evidence.url);
  }
}
export function sourceRenderedGuidance(run:Pick<CollectionRun,'sourceRenderedEvidence'>):string {
  return run.sourceRenderedEvidence?.length?`来源浏览器实际渲染证据共${run.sourceRenderedEvidence.length}页，索引 collection/${sourceRenderedEvidencePath}。静态fullText和原件保持原义；动态可见文字、真实截图、frame正文另存观察，不能把脚本补作静态正文。按冻结page/interaction清单交付实际页面和功能；来源截图不证明目标功能，目标当前修订仍须独立浏览器取证。只观察到控件不等于验证交互，地图瓦片数量不等于业务数据量。`:'';
}

/** Product-owned read-only capture; model callers cannot provide actions, headers or browser URLs. */
export async function captureSourceRenderedEvidence(collections:CollectionStore,run:CollectionRun,url:string,options:{signal:AbortSignal;openBrowser?:typeof evaluationBrowser;request?:typeof fetch;settleMs?:number}):Promise<SourceRenderedEvidence> {
  if(run.status==='ready')throw new Error('已冻结来源不能新增渲染证据，应创建来源修订');
  const read=(path:string)=>collections.read(run,path),record=pageRecord(read,url),extractPath=`.work/extract/${record.id}.json`;
  const existing=run.sourceRenderedEvidence?.find(item=>item.url===url);
  if(existing){
    try{assertSourceRenderedEvidenceIndex(run,read);return existing;}
    catch{/* Changed bindings or evidence require a fresh, independently captured observation. */}
  }
  const rawSha256=collectionHash(read(record.rawFile)),extractSha256=collectionHash(read(extractPath));
  const id=randomUUID(),folder=`site/source-rendered/${id}`,root=collections.workspace(run),directory=safeCollectionPath(root,folder);
  mkdirSync(safeCollectionPath(root,folder+'/evidence'),{recursive:true,mode:0o700});
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(90_000)]);
  const browser=await (options.openBrowser||evaluationBrowser)({target:'',reference:'',content:httpUrl(url).href},directory,signal);
  try{
    const service=httpUrl(browser.env.EVALUATION_BROWSER_URL);if(service.protocol!=='http:'||service.hostname!=='127.0.0.1')throw new Error('来源浏览器服务不是宿主本机端点');
    const snapshot=async()=>{
      signal.throwIfAborted();const response=await (options.request||fetch)(service,{method:'POST',headers:{Authorization:'Bearer '+browser.env.EVALUATION_BROWSER_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({action:'snapshot',role:'content',viewport:'desktop',fullPage:false}),signal,redirect:'error'});
      const value=await response.json();if(!response.ok)throw new Error(typeof value?.error==='string'?value.error:'来源浏览器取证失败');
      if(value.url!==httpUrl(url).href)throw new Error('来源浏览器最终URL与登记页面不同');
      return value;
    };
    await snapshot();
    // One bounded second snapshot on the same session lets asynchronous content settle.
    await new Promise<void>((done,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener('abort',stop);done();},Math.min(5000,Math.max(0,options.settleMs??1500)));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
    const value=await snapshot();
    if(typeof value.file!=='string'||!/^[a-f0-9-]+\.png$/.test(value.file))throw new Error('来源浏览器没有可信截图文件');
    const observationBytes=readFileSync(safeCollectionPath(root,`${folder}/evidence/${value.file.replace('.png','.json')}`)),screenshotBytes=readFileSync(safeCollectionPath(root,`${folder}/evidence/${value.file}`));
    if(screenshotBytes.length>20*1024*1024||observationBytes.length>2*1024*1024)throw new Error('来源渲染证据超过保存上限');
    const {observation,frames,visibleText}=observationText(JSON.parse(observationBytes.toString()));
    if(observation.url!==httpUrl(url).href)throw new Error('来源浏览器保存的URL不匹配');
    const observationPath=`${folder}/observation.json`,screenshotPath=`${folder}/screenshot.png`;
    writeFileSync(safeCollectionPath(root,observationPath),observationBytes,{mode:0o600,flag:'wx'});writeFileSync(safeCollectionPath(root,screenshotPath),screenshotBytes,{mode:0o600,flag:'wx'});
    const evidence:SourceRenderedEvidence={id,collectionId:run.id,inputVersionId:run.inputVersionId,engineVersion:run.engineVersion,pageId:record.id,url,rawPath:record.rawFile,rawSha256,extractPath,extractSha256,observationPath,observationSha256:collectionHash(observationBytes),screenshotPath,screenshotSha256:collectionHash(screenshotBytes),capturedAt:observation.capturedAt,viewport:'desktop',text:observation.text,visibleText,frames,framesComplete:observation.framesComplete!==false,textTruncated:false};
    // Old capture bytes remain archived; the current pointer advances only for this page.
    const next={...run,sourceRenderedEvidence:[...(run.sourceRenderedEvidence||[]).filter(item=>item.pageId!==record.id),evidence]};
    const indexBytes=Buffer.from(JSON.stringify(sourceRenderedEvidenceIndex(next),null,2));
    assertSourceRenderedEvidenceIndex(next,path=>path===sourceRenderedEvidencePath?indexBytes:read(path));
    writeFileSync(safeCollectionPath(root,sourceRenderedEvidencePath),indexBytes,{mode:0o600});
    run.sourceRenderedEvidence=next.sourceRenderedEvidence;collections.put(run);return evidence;
  }finally{await browser.close();}
}
