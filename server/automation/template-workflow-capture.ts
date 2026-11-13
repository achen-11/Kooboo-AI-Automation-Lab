import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { TemplateCaptureScope, TemplateEvidence, TemplateLayoutSnapshot, TemplateViewport } from '../../shared/template-workflow.js';
import type { evaluationBrowser } from './browser.js';
import { screenshotRangeCovered, type PageScreenshotsReceipt } from './page-screenshots.js';
import { readTemplateEvidence, TemplateWorkflowStore, templateHash } from './template-workflow-store.js';

export type WorkflowBrowser=Awaited<ReturnType<typeof evaluationBrowser>>;
export interface WorkflowCapture {layout:TemplateLayoutSnapshot;scope:TemplateCaptureScope;files:TemplateEvidence[]}
export function compactLayout(layout:TemplateLayoutSnapshot,offset=0,limit=20){
  const elements=layout.elements.slice(offset,offset+limit).map(({signature,...element})=>({...element,text:element.text.slice(0,240),textTruncated:element.text.length>240}));
  const links=layout.links.slice(offset,offset+limit),count=Math.max(layout.elements.length,layout.links.length);
  return {...layout,elements,links,elementCount:layout.elements.length,linkCount:layout.links.length,nextOffset:offset+limit<count?offset+limit:null,dependencyHash:layout.dependencyHash};
}
export function compactCapture(capture:WorkflowCapture){return {...capture,layout:compactLayout(capture.layout)};}
/** The model gets an index, not repeated hashes, URLs, full body text and API metadata. */
export function analysisCaptureIndex(capture:WorkflowCapture,directory:string){
  const {url,viewport,width,height,truncated}=capture.layout;
  const candidates=capture.layout.elements.filter(element=>element.selector!=='body'&&(/^(header|nav|main|section|footer|h1|h2)$/.test(element.tag)||element.parentSelector==='body'||element.rect.width>=width*.75&&element.rect.height>=140));
  const frames=capture.files.filter(file=>file.type==='image/png').map(file=>{
    const proof=capture.files.find(item=>item.name===file.name.replace(/\.png$/,'.json'));if(!proof)throw new Error('逐屏来源缺少位置观察');
    const observation=JSON.parse(readTemplateEvidence(directory,proof).toString()),p=observation.position;
    return {file:file.name,settled:file.settled,...(p?{y:p.scrollY,width:p.viewportWidth,height:p.viewportHeight,documentHeight:p.documentHeight}:{}),stableForMs:observation.readiness?.stableForMs};
  });
  return {scope:capture.scope,layout:{url,viewport,width,height,truncated,elementCount:capture.layout.elements.length,linkCount:capture.layout.links.length,internalLinks:capture.layout.links.slice(0,30),candidates:candidates.slice(0,60).map(({selector,tag,text,rect})=>({selector,tag,text:text.slice(0,160),rect})),candidatesTruncated:candidates.length>60},frames,files:capture.files.map(({name,type,settled})=>({name,type,settled}))};
}
export function recordTemplateLayout(task:AutomationTask,layout:TemplateLayoutSnapshot,role:TemplateEvidence['role'],directory:string,browser:WorkflowBrowser):TemplateEvidence {
  const name=randomUUID()+'.json',bytes=Buffer.from(JSON.stringify({kind:'template-layout',url:layout.url,viewport:layout.viewport,role,capturedAt:Date.now(),binding:{taskId:task.id,inputVersionId:task.versionId,siteRevision:role==='target'?task.siteRevision:null},layout}));
  writeFileSync(resolve(directory,'automation-runs',task.id,'evidence',name),bytes,{mode:0o600});
  const file:MaterialFile={id:randomUUID(),name,type:'application/json',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role,viewport:layout.viewport};browser.artifacts.push(file);task.artifacts=browser.artifacts;
  return registeredTemplateEvidence(task,[file],directory)[0];
}
export function registeredTemplateEvidence(task:AutomationTask,files:MaterialFile[],directory:string):TemplateEvidence[]{
  return files.filter(file=>file.role).map(file=>{
    let url='';try{url=JSON.parse(readFileSync(resolve(directory,'automation-runs',task.id,'evidence',file.type==='image/png'?file.name.replace(/\.png$/,'.json'):file.name),'utf8')).url||'';}catch{}
    return {name:file.name,ownerTaskId:task.id,role:file.role!,viewport:file.viewport,url,type:file.type,sha256:file.sha256,size:file.size,settled:file.settled,siteRevision:file.role==='target'?task.siteRevision||null:null,href:`/api/automation/tasks/${task.id}/template-workflow/artifacts/${file.name}`};
  });
}
/** One receipt supplies every check. Persist each prefix before the next viewport operation. */
export async function captureWorkflowScope(input:{task:AutomationTask;registry:TemplateWorkflowStore;directory:string;browser:WorkflowBrowser;role:'reference'|'content'|'target';url:string;viewport:TemplateViewport;signal:AbortSignal;mode?:'page'|'regions';selectors?:string[];reason?:string;layout?:TemplateLayoutSnapshot}):Promise<WorkflowCapture>{
  const {task,registry,directory,browser,role,url,viewport,signal}=input;
  const key=templateHash(['template-capture-v1',task.templateWorkflow,role,role==='target'?[task.id,task.siteRevision]:null,url,viewport,input.mode||'page',input.selectors||[]]);
  type Saved={files:TemplateEvidence[];receipts:PageScreenshotsReceipt['screenshots'];complete:boolean;nextStartY:number|null;nextSelectorIndex:number|null;gaps:string[];layout:TemplateLayoutSnapshot;layoutEvidence?:string;traversed?:boolean;externalMotionBypass?:boolean};
  let saved=registry.batch<Saved>(key);
  if(saved){try{for(const file of saved.files)readTemplateEvidence(directory,file);}catch{saved=undefined;}}
  if(saved){if(saved.complete)return {layout:saved.layout,files:saved.files,scope:{pagePath:new URL(url).pathname+new URL(url).search,viewport,mode:input.mode||'page',selectors:input.selectors||[],reason:input.reason||(saved.externalMotionBypass?'外部来源已全页覆盖且完成 10s 降噪重试，保留未静止帧提示并继续分析':'复用同一次采集的已验证回执'),evidence:saved.files.map(f=>f.name),complete:true}};}
  signal.throwIfAborted();
  const layout=saved?.layout||input.layout||await browser.capture({action:'inspect_layout',role,url,viewport}) as TemplateLayoutSnapshot;
  saved??={files:[],receipts:[],complete:false,nextStartY:0,nextSelectorIndex:0,gaps:[],layout};
  // Retry unsettled frames once per capture call; never suppress retries across restarts.
  const repaired=new Set<string>();
  const frameKey=(frame:PageScreenshotsReceipt['screenshots'][number])=>`${frame.capture?.selectorIndex??''}:${frame.position.scrollY}`;
  const externalSettledEnough=(positions:PageScreenshotsReceipt['screenshots'][number]['position'][])=>{
    if(role==='target'||!saved!.traversed||!saved!.receipts.length||saved!.gaps.length)return false;
    if(positions.some(position=>position.horizontalOverflow))return false;
    if(input.mode!=='regions'&&!screenshotRangeCovered(positions))return false;
    const unsettled=saved!.receipts.filter(frame=>!frame.settlement?.settled);
    if(!unsettled.length||unsettled.some(frame=>!repaired.has(frameKey(frame))))return false;
    return unsettled.every(frame=>{
      const r=frame.readiness;
      return Boolean(r&&r.brokenImages===0&&r.fontsReady&&(r.stableForMs>=500||r.pendingImages===0));
    });
  };
  let traversalBatches=0,retryBatches=0;
  while(!saved.complete){
    const retry=saved.traversed?saved.receipts.find(frame=>!frame.settlement?.settled&&!repaired.has(frameKey(frame))):undefined;
    if(saved.traversed&&!retry){
      const positions=[...saved.receipts].sort((a,b)=>a.position.scrollY-b.position.scrollY).map(frame=>frame.position);
      if(externalSettledEnough(positions)){saved.complete=true;saved.externalMotionBypass=true;registry.saveBatch(key,saved);}
      break;
    }
    if(!retry&&traversalBatches>=4)break;
    if(retry&&retryBatches>=16)break;
    const startY=retry?Math.floor(retry.position.scrollY):saved.nextStartY||0,startSelectorIndex=retry?.capture?.selectorIndex??saved.nextSelectorIndex??0;
    if(retry){repaired.add(frameKey(retry));retryBatches++;}else traversalBatches++;
    const receipt=await browser.capture({action:'take_page_screenshots',role,url,viewport,scope:input.mode||'page',selectors:input.selectors||[],startY,startSelectorIndex,maxScreenshots:retry?1:16,...(retry?{settleTimeoutMs:10000}:{})}) as PageScreenshotsReceipt;
    if(receipt.action!=='take_page_screenshots'||!Array.isArray(receipt.screenshots))throw new Error('采集工具没有返回已登记逐屏证据');
    const names=receipt.screenshots.flatMap(frame=>[frame.file,frame.file.replace(/\.png$/,'.json')]);
    const files=registeredTemplateEvidence(task,browser.artifacts.filter(f=>names.includes(f.name)),directory);
    if(files.length!==names.length||new Set(names).size!==names.length)throw new Error('采集文件与回执不匹配');
    for(const file of files){readTemplateEvidence(directory,file);if(file.role!==role||file.viewport!==viewport)throw new Error('采集角色/视口不匹配');}
    for(const frame of receipt.screenshots){const json=files.find(f=>f.name===frame.file.replace(/\.png$/,'.json'))!;const observation=JSON.parse(readTemplateEvidence(directory,json).toString());if(observation.url!==url||observation.file!==frame.file||observation.role!==role||observation.viewport!==viewport||observation.binding?.taskId!==task.id||observation.binding?.inputVersionId!==task.versionId||role==='target'&&observation.binding?.siteRevision!==task.siteRevision)throw new Error('采集观察绑定不匹配');}
    for(const frame of receipt.screenshots){
      const old=saved.receipts.findIndex(previous=>previous.capture?.selectorIndex===frame.capture?.selectorIndex&&Math.abs(previous.position.scrollY-frame.position.scrollY)<1);
      if(old>=0){const name=saved.receipts[old].file;saved.files=saved.files.filter(file=>file.name!==name&&file.name!==name.replace(/\.png$/,'.json'));saved.receipts[old]=frame;}else saved.receipts.push(frame);
    }
    saved.files.push(...files);
    // These diagnostics are derived from the current frames/continuation, not sticky historical failures.
    const persistent=(gap:string)=>!/^Screenshot \d+ did not settle:|^Horizontal overflow was not captured\.|^Actual viewport intervals|^Collection interrupted;/.test(gap);
    saved.gaps=[...new Set([...saved.gaps.filter(persistent),...receipt.gaps.filter(persistent)])];
    if(!retry){saved.nextStartY=receipt.nextStartY;saved.nextSelectorIndex=receipt.nextSelectorIndex;saved.traversed=receipt.nextStartY===null&&receipt.nextSelectorIndex===null;}
    const positions=[...saved.receipts].sort((a,b)=>a.position.scrollY-b.position.scrollY).map(frame=>frame.position);
    const diagnostics=[...saved.gaps];
    if(saved.receipts.some(frame=>!frame.settlement?.settled))diagnostics.push('存在尚未稳定的画面，保留有效帧并仅补采这些位置');
    if(positions.some(position=>position.horizontalOverflow))diagnostics.push('Horizontal overflow was not captured.');
    saved.complete=!!saved.traversed&&saved.receipts.length>0&&!diagnostics.length&&(input.mode==='regions'||screenshotRangeCovered(positions));
    if(!saved.complete&&externalSettledEnough(positions)){saved.complete=true;saved.externalMotionBypass=true;}
    registry.saveBatch(key,saved);
    if(saved.complete)break;
    if(!receipt.screenshots.length)break;
    if(!retry&&!saved.traversed&&(input.mode||'page')==='page'&&(receipt.nextStartY===null||receipt.nextStartY<=startY))throw new Error('逐屏采集没有前进，已保留有效证据');
  }
  if(saved.complete&&!saved.layoutEvidence){saved.layout=await browser.capture({action:'inspect_layout',role,url,viewport}) as TemplateLayoutSnapshot;const proof=recordTemplateLayout(task,saved.layout,role,directory,browser);saved.files.push(proof);saved.layoutEvidence=proof.name;registry.saveBatch(key,saved);registry.store.put(task);}
  return {layout:saved.layout,files:saved.files,scope:{pagePath:new URL(url).pathname+new URL(url).search,viewport,mode:input.mode||'page',selectors:input.selectors||[],reason:input.reason||(saved.externalMotionBypass?'外部来源已全页覆盖且完成 10s 降噪重试，保留未静止帧提示并继续分析':'一次采集服务全部检查'),evidence:saved.files.map(f=>f.name),complete:saved.complete}};
}
