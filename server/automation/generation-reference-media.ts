import { createHash, randomUUID } from 'node:crypto';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { ContextRequest } from './generation-context.js';
import { GenerationInputError } from './errors.js';
import { TemplateWorkflowStore, readTemplateEvidence } from './template-workflow-store.js';
import { readEvidence } from './optimization-evidence.js';
import { readMaterial } from './materials.js';
import { sourceVisualMaterial, type SourceVisualIndex } from './collection/source-visual.js';

export interface ReferenceImage {
  name:string; ownerTaskId:string; sha256:string; size:number; url:string;
  role:'reference'|'target'; siteRevision:string|null;
  viewport?:'desktop'|'mobile'; imageId:string; path:string; sandbox:string;
  views:{pagePath:string;viewId:string;viewport:'desktop'|'mobile'}[];
}
type MediaSource=Omit<ReferenceImage,'imageId'|'path'|'sandbox'>&{read:()=>Buffer};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validId=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value)&&value!=='00000000-0000-0000-0000-000000000000';

export function researchSandboxName(siteId:string){
  if(!validId(siteId))throw new GenerationInputError('研究 Sandbox 缺少有效的目标站身份');
  return 'autoref-'+BigInt('0x'+siteId.replace(/-/g,'').toLowerCase()).toString(36).padStart(25,'0');
}

async function researchSandbox(request:ContextRequest,siteId:string){
  // Sandbox names are unique across the organization and share Kooboo's 50-char __ai_sandbox__ name budget.
  const sandbox=researchSandboxName(siteId),legacyTruncated=('automation-ref-'+siteId.replace(/-/g,'').toLowerCase()).slice(0,36);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const response=await request('AI/CallFunction',{name,callId:randomUUID(),arguments:args},siteId),content=response?.contents?.[0];
    if(!content||content.isError||content.result?.error||content.result?.success===false)throw new Error('研究 Sandbox 工具未成功：'+name);
    return content.result;
  };
  const lookup=async()=>{
    const list=await call('list_sandbox',{});if(!Array.isArray(list))throw new Error('研究 Sandbox 列表回执无效');
    const exact=list.filter(item=>item?.siteName===sandbox);
    const matches=exact.length?exact:list.filter(item=>item?.siteName===legacyTruncated);
    if(matches.length>1||matches.some(item=>!validId(item.id)||item.id===siteId))throw new GenerationInputError('研究 Sandbox 身份不唯一或无效');
    return matches[0] as {id:string;siteName:string}|undefined;
  };
  const existing=await lookup();if(existing)return {sandbox:existing.siteName,siteId:existing.id};
  try{
    const result=await call('create_sandbox',{siteName:sandbox,contentTypes:[]});
    const site=result?.site||result;
    if(site?.siteName!==sandbox||!validId(site?.id)||site.id===siteId)throw new Error('研究 Sandbox 创建身份未确认');
    return {sandbox,siteId:site.id as string};
  }catch(error){
    // Reconcile lost creation responses or concurrent creators by name; never blindly recreate.
    const recovered=await lookup();if(recovered)return {sandbox:recovered.siteName,siteId:recovered.id};throw error;
  }
}

/** Isolated media only. Target-site kfile contains references, never PNG bytes.
 * Verify persisted bytes on every preparation; retain the sandbox for continuations.
 */
export async function prepareReferenceMedia(task:AutomationTask,store:AutomationStore,directory:string,
  target:{siteId:string;apiOrigin:string;token:string;request:ContextRequest;input?:{files:MaterialFile[]};includeBaseline?:boolean},
  signal:AbortSignal,fetcher:typeof fetch=fetch){
  const registry=new TemplateWorkflowStore(store),sources:MediaSource[]=[];
  const baseline=task.templateWorkflow?registry.get(task)?.baseline:undefined;
  if(task.templateWorkflow){
    if(!baseline?.complete)throw new GenerationInputError('缺少完整冻结基线，不能交付参考图片');
    const files=baseline.evidence.filter(file=>file.role==='reference'&&file.type==='image/png');
    const registered=new Set(files.map(file=>file.name));
    for(const page of baseline.pages)for(const view of page.views)for(const layout of view.layouts)
      if(!layout.evidence.some(name=>registered.has(name)))throw new GenerationInputError('布局缺少可交付的参考 PNG：'+page.path+'/'+view.id+'/'+layout.viewport);
    const evaluation=task.repairEvidence?registry.evaluation(task.repairEvidence.reportId):undefined;
    if(task.repairEvidence){
      if(!evaluation||evaluation.baselineId!==baseline.id)throw new GenerationInputError('修复图片没有匹配的冻结基线评测');
      const issueImages=evaluation.issues.filter(issue=>issue.status==='open').flatMap(issue=>issue.evidence).filter(name=>evaluation.evidence.some(file=>file.name===name&&file.type==='image/png'));
      for(const name of new Set([...task.repairEvidence.files,...issueImages])){
        const file=evaluation.evidence.find(file=>file.name===name&&file.type==='image/png');
        if(!file||file.role==='content')throw new GenerationInputError('修复图片未登记在本轮评测：'+name);
        if(!files.some(item=>item.name===name))files.push(file);
      }
    }
    for(const file of files){
      const views=file.role==='reference'?baseline.pages.flatMap(page=>page.views.flatMap(view=>view.layouts.filter(layout=>layout.evidence.includes(file.name)).map(layout=>({pagePath:page.path,viewId:view.id,viewport:layout.viewport})))):
        (evaluation?.checks||[]).filter(check=>check.evidence.includes(file.name)).map(check=>({pagePath:check.pagePath,viewId:check.viewId,viewport:check.viewport}));
      sources.push({name:file.name,ownerTaskId:file.ownerTaskId,sha256:file.sha256,size:file.size,url:file.url,role:file.role as 'reference'|'target',siteRevision:file.siteRevision,viewport:file.viewport,
        views:[...new Map(views.map(view=>[JSON.stringify(view),view])).values()],read:()=>readTemplateEvidence(directory,file)});
    }
  }else{
    if(task.repairEvidence){
      const report=store.task(task.repairEvidence.reportId);if(!report?.report)throw new GenerationInputError('修复引用的原报告不存在');
      const reportInput=store.version(report.versionId);
      for(const name of new Set(task.repairEvidence.files)){
        const file=report.report.artifacts.find(file=>file.name===name&&file.type==='image/png');
        if(!file||!['reference','target'].includes(file.role||''))throw new GenerationInputError('修复图片未登记在原报告：'+name);
        sources.push({name:file.name,ownerTaskId:report.id,sha256:file.sha256,size:file.size,url:file.role==='target'?report.siteUrl:(reportInput?.referenceUrl||reportInput?.contentUrl||''),
          role:file.role as 'reference'|'target',siteRevision:file.role==='target'?report.siteRevision||null:null,viewport:file.viewport,views:[],read:()=>readEvidence(directory,report.id,file).bytes});
      }
    }
    const input=target.input,indexFile=target.includeBaseline&&input?.files.find(file=>file.name===sourceVisualMaterial);
    if(input&&indexFile){
      const index=JSON.parse(readMaterial(directory,indexFile).toString()) as SourceVisualIndex,seen=new Set<string>();
      for(const template of index.templates)for(const screen of template.screens)for(const path of [screen.path,...(screen.foldPath?[screen.foldPath]:[])]){
        const name='collection/'+path;if(seen.has(name))continue;seen.add(name);
        const file=input.files.find(file=>file.name===name&&file.type==='image/png');if(!file)throw new GenerationInputError('冻结来源视觉基线 PNG 缺失：'+name);
        sources.push({name,ownerTaskId:task.id,sha256:file.sha256,size:file.size,url:screen.url,role:'reference',siteRevision:null,viewport:screen.viewport,views:[],read:()=>readMaterial(directory,file)});
      }
    }
  }
  if(!sources.length)return;
  // Validate all originals before creating a sandbox or uploading media.
  for(const source of sources){signal.throwIfAborted();const bytes=source.read();if(bytes.length!==source.size||digest(bytes)!==source.sha256)throw new GenerationInputError('参考图片原件校验失败：'+source.name);}
  const research=await researchSandbox(target.request,target.siteId);
  const entries:ReferenceImage[]=[],namespace=baseline?.id||task.repairEvidence?.reportId||task.versionId;
  for(const source of sources){
    signal.throwIfAborted();const bytes=source.read();
    const folder=`/_automation-reference/${namespace}`,path=`${folder}/${source.sha256}.png`;
    const cacheKey=`reference-media:${research.siteId}:${namespace}:${source.sha256}`;
    const previous=registry.batch<{imageId:string;path:string}>(cacheKey);
    const options={headers:{Authorization:`Bearer ${target.token}`},signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),redirect:'error' as const};
    const download=async(imageId:string)=>{
      const url=new URL('/_api/Download/Single',target.apiOrigin);
      url.searchParams.set('SiteId',research.siteId);url.searchParams.set('id',imageId);url.searchParams.set('type','media');url.searchParams.set('provider','default');
      return fetcher(url,options);
    };
    const existing=previous?await download(previous.imageId):undefined;
    let imageId=previous?.imageId,actualPath=previous?.path||path;
    if(existing?.ok){
      if(digest(Buffer.from(await existing.arrayBuffer()))!==source.sha256)throw new GenerationInputError('参考图片目标路径字节冲突：'+source.name);
    }else if(existing&&existing.status!==404)throw new Error('参考图片回读失败（HTTP '+existing.status+'）：'+source.name);
    if(!existing?.ok||!imageId){
      const form=new FormData();form.append('Folder',folder);form.append('file',new Blob([new Uint8Array(bytes)],{type:'image/png'}),source.sha256+'.png');
      const url=new URL('/_api/v2/Upload/Image',target.apiOrigin);url.searchParams.set('SiteId',research.siteId);url.searchParams.set('provider','default');
      const response=await fetcher(url,{...options,method:'POST',body:form});
      if(!response.ok)throw new Error('参考图片上传失败（HTTP '+response.status+'）：'+source.name);
      const receipt=await response.json();const item=Array.isArray(receipt)&&receipt.length===1?receipt[0]:undefined;
      if(!validId(item?.id))throw new GenerationInputError('参考图片上传回执身份无效：'+source.name);
      imageId=item.id;actualPath=typeof item.url==='string'?item.url:'';
      const check=await download(imageId!);
      if(!check.ok||digest(Buffer.from(await check.arrayBuffer()))!==source.sha256)throw new GenerationInputError('参考图片上传后字节校验失败：'+source.name);
      registry.saveBatch(cacheKey,{imageId,path:actualPath});
    }
    const {read,...metadata}=source;
    entries.push({...metadata,imageId:imageId!,path:actualPath,sandbox:research.sandbox});
  }
  return {siteId:research.siteId,targetSiteId:target.siteId,sandbox:research.sandbox,baselineId:baseline?.id,entries,
    note:'图片仅存专用研究 Sandbox，不属于生成站模板素材。read_image 和 process_image 必须携带每项 sandbox。媒体上传和索引回读不代表模型已看图。'};
}
