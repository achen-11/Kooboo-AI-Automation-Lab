import { randomUUID } from 'node:crypto';
import type { AutomationTask } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Pending } from './errors.js';

import { koobooClient, siteIdentity, refreshSite, probeSite } from './kooboo.js';
import { materialDestination, readMaterial } from './materials.js';
import { generationSession } from './generation-session.js';
import { readEvidence } from './optimization-evidence.js';
import { ensureManifest, ManifestStore } from './completeness.js';
import { selectExperience, adoptedGuidance } from './experience.js';
import { optimizationBudgetReason } from './optimization.js';
import { ModelBudgetExceeded } from './request-budget.js';

async function delay(ms:number,signal:AbortSignal){await new Promise<void>((r,j)=>{signal.throwIfAborted();const done=()=>{signal.removeEventListener('abort',abort);r();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);j(signal.reason);};signal.addEventListener('abort',abort,{once:true});});}

/** Existing Kooboo APIs + the existing frontend stream/function loop. No server generation API is introduced. */
export async function executeGeneration(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,openSession:typeof generationSession=generationSession){
  const input=store.version(task.versionId);if(!input)throw new Error('缺少固定的输入版本');
  const {environment,origin,request}=koobooClient(task,vault,signal);const apiOrigin=new URL(environment.apiOrigin||origin).origin;
  // Older executions already submitted a prompt without durable delivery receipts.
  // Retain their conversation and require explicit AI evidence before another message.
  if(!task.generation&&task.generatedSiteId&&task.context)task.generation={legacySubmitted:true,prepared:true,conversationId:task.threadId||undefined};
  task.stage='prepare';task.generation??={};store.put(task);
  let site=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
  if(!site){
    const slug=`auto-${task.id.slice(0,12)}`;
    if(task.generation.createAttempted){
      const list=await request('Site/List');const matches=(Array.isArray(list)?list:[]).filter((s:any)=>(s.siteName||s.SiteName)===slug);
      if(matches.length!==1)throw new Pending(`站点 ${slug} 创建结果尚未唯一确认，禁止重复创建；请检查 Kooboo 环境。`);
      const adopted={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId:siteIdentity(matches[0]),name:slug,url:'',createdAt:Date.now()};
      store.saveSite(adopted);task.generatedSiteId=adopted.id;store.put(task);throw new Pending('已找到并绑定先前创建的站点，将在下一次执行中继续准备；未重复建站。');
    }
    const domains=await request('Domain/Available');
    const domainList=Array.isArray(domains)?domains:[];
    const root=domainList.map((d:any)=>typeof d==='string'?d:d.domainName||d.domain||d.name||d.rootDomain).find((d:unknown)=>typeof d==='string'&&d);
    if(!root)throw new Error('Kooboo 未返回可用根域名，请核对连接环境');
    store.event(task.id,`准备新站 ${slug}；创建结果不确定时停止，不自动重发创建请求`);
    let created:any;task.generation.createAttempted=true;store.put(task);
    try{
      created=task.scenario==='upgrade'
        ?await request('Transfer/ByLevel',{siteName:slug,subDomain:slug,rootDomain:root,url:input.contentUrl,headless:false,convertToRoot:false,TotalPages:20,Depth:2})
        :await request('Site/Create',{SiteName:slug,SubDomain:slug,RootDomain:root,SiteType:'p'});
    }catch{throw new Pending(`新站 ${slug} 创建结果未确认，请在 Kooboo 检查后将实际站点关联到此资源，禁止自动重复建站。`);}
    const siteId=siteIdentity(created);
    if(!/^[a-f0-9-]{36}$/i.test(siteId)||/^00000000-0000-0000-0000-000000000000$/i.test(siteId))throw new Pending(`新站 ${slug} 未返回有效身份，请检查 Kooboo 实际站点。`);
    site={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId,name:slug,url:'',createdAt:Date.now()};
    if(task.scenario==='upgrade')task.generation.transferTaskId=created.taskId;
    store.saveSite(site);task.generatedSiteId=site.id;store.put(task);store.event(task.id,`已绑定生成站 ${siteId}`);
  }
  if(!site)throw new Error('没有可执行的生成站');
  store.beginSiteChange(task);
  if(task.scenario==='upgrade'&&!task.generation.transferComplete&&!task.generation.prepared){
      const siteId=site.siteId;
      const taskId=task.generation.transferTaskId;if(!taskId)throw new Pending('内容站克隆未返回任务标识，请检查实际克隆状态');
      let previous=-1,stable=0;
      while(stable<2){
        signal.throwIfAborted();
        const status=await request(`Transfer/GetStatus?id=${encodeURIComponent(taskId)}`,undefined,siteId);
        const pages=Array.isArray(status)?status:[];const done=pages.length>0&&pages.every((p:any)=>p.done===true);
        stable=done&&previous===pages.length?stable+1:0;previous=pages.length;await delay(2000,signal);
      }
      const status=await request('Transfer/GetTaskStatus',undefined,siteId);if(!status?.pages)throw new Pending('内容站克隆未确认有页面导入，需检查原站与目标站');
      task.generation.transferComplete=true;store.put(task);
      store.event(task.id,'内容站克隆完成；参考站由 Kooboo AI 使用 Sandbox tools 准备');
  }
  // Materials are copied into the chosen target; no mandatory README or naming convention.
  const uploaded:string[]=[];
  for(const file of task.generation.prepared?[]:input.files){
    signal.throwIfAborted();const bytes=readMaterial(directory,file);
    const {filename,folder,text,path}=materialDestination(task.resourceId,task.versionId,file);
    const mapping=`${file.name} → ${text?'kfile:':''}${path}`;
    if(task.generation.importedMaterials?.[file.id]===file.sha256){uploaded.push(mapping);continue;}
    if(text){
      const response=await request('AI/CallFunction',{name:'run_kscript',callId:randomUUID(),arguments:{code:`k.file.write(${JSON.stringify(path)}, ${JSON.stringify(bytes.toString('utf8'))}); return true;`}},site.siteId);
      const content=response?.contents?.[0];if(!content||content.isError||content.result?.error||content.result===false)throw new Error(`资料写入未确认：${file.name}`);
    }else{
      const form=new FormData();form.append('Folder',folder);form.append('file',new Blob([new Uint8Array(bytes)],{type:file.type}),filename);
      const url=new URL('/_api/v2/Upload/File',apiOrigin);url.searchParams.set('SiteId',site.siteId);
      const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${environment.token}`},body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),redirect:'error'});
      if(!response.ok)throw new Error(`上传资料失败（HTTP ${response.status}）：${file.name}`);
      const receipt=await response.json();
      // Kooboo's ApiManager consumes boolean results; v2 serializes a successful
      // bool-returning Upload/File as null. Never infer persistence from that alone.
      if(receipt!==true&&receipt!==null)throw new Error(`上传资料回执异常：${file.name}`);
      const query=new URLSearchParams({path:'/'+folder,keyword:filename,pageNr:'1',pageSize:'100'});
      let confirmed=false;
      for(let page=1;!confirmed;page++){
        query.set('pageNr',String(page));const listing=await request('File/List?'+query,undefined,site.siteId);
        if(listing?.errorMessage||!Array.isArray(listing?.files?.list))throw new Error(`读取上传资料确认失败：${file.name}`);
        confirmed=listing.files.list.some((item:any)=>item.url===path&&item.size===bytes.length);
        if(confirmed||page>=listing.files.totalPages)break;
        if(!Number.isInteger(listing.files.totalPages)||listing.files.totalPages>1000)throw new Error(`上传资料目录分页异常：${file.name}`);
      }
      if(!confirmed)throw new Error(`上传资料未确认（目标路径或大小不匹配）：${file.name}`);
    }
    task.generation.importedMaterials??={};task.generation.importedMaterials[file.id]=file.sha256;store.put(task);
    uploaded.push(mapping);store.event(task.id,`资料已导入：${file.name}`);
  }
  if(uploaded.length){
    const manifestPath=`_automation-manifests/${task.id}.json`;
    const mappings=input.files.map(file=>({name:file.name,id:file.id,destination:materialDestination(task.resourceId,task.versionId,file).path}));
    const result=await request('AI/CallFunction',{name:'run_kscript',callId:randomUUID(),arguments:{code:`k.file.write(${JSON.stringify(manifestPath)}, ${JSON.stringify(JSON.stringify(mappings))}); return true;`}},site.siteId);
    const content=result?.contents?.[0];if(!content||content.isError||content.result===false||content.result?.error)throw new Error('资料映射清单写入未确认');
    task.message+='\n资料映射清单：kfile:'+manifestPath;task.message+='\n\n已导入资料位置：\n'+uploaded.join('\n');store.put(task);}
  task.generation.prepared=true;store.put(task);
  if((!task.generation.deliveryId||task.generation.next)&&!task.generation.legacySubmitted&&(task.generation.deliveryState!=='completed'||task.generation.next)){
    await ensureManifest(task,store,vault,directory,signal);
    await selectExperience(task,'generation',store,vault,directory,signal);
  }
  // A finished chat loop may have produced no page. An explicit, validated
  // continuation must reach the pinned conversation even after that receipt.
  const continuation=task.generation.next?.action==='continue'||task.generation.next?.action==='answer';
  if(task.generation.deliveryState==='completed'&&!continuation){
    task.stage='handoff';store.put(task);const ready=await refreshSite(task,store,vault,signal);await probeSite(ready?.url||'',signal);return;
  }
  task.stage='generation';store.put(task);
  const budget=optimizationBudgetReason(task,store);if(budget)throw new ModelBudgetExceeded(budget);
  const session=await openSession(task,store,vault,directory,signal);
  try{
    let state=await session.snapshot();
    const action=task.generation.next;
    const initial=!task.generation.deliveryId;
    if(initial&&task.generation.legacySubmitted&&!action)throw new Pending('旧任务已提交过原始委托，由 AI 核对交付并交接评测或明确继续，不能重发初始消息');
    if(initial||action?.action==='continue'||action?.action==='answer'){
      if(state.running)throw new Pending('原会话仍在执行，保留当前执行，稍后核对');
      const images=task.repairEvidence?task.repairEvidence.files.map(name=>{
        const file=store.task(task.repairEvidence!.reportId)?.report?.artifacts.find(f=>f.name===name);if(!file)throw new Error('修复引用的原报告图片不存在');
        const image=readEvidence(directory,task.repairEvidence!.reportId,file);return {uri:'data:image/png;base64,'+image.bytes.toString('base64'),mediaType:'image/png' as const};
      }):undefined;
      if(images?.length&&!state.imageInput)throw new Pending('当前 Kooboo automation bridge 不支持图片修复委托，请更新 bridge 后恢复；尚未发送修复消息。');
      if(images&&images.reduce((sum,image)=>sum+image.uri.length,0)>24*1024*1024)throw new Pending('本轮修复图片超过 24 MiB，需要缩小修复批次；尚未发送消息。');
      const id=randomUUID();task.generation.deliveryId=id;task.generation.deliveryState='sending';delete task.generation.next;store.put(task);
      const receipt=await session.deliver({id,conversationId:task.generation.conversationId||state.conversationId,images,
        ...(action?.action==='answer'?{answer:action.answer,callId:action.callId}:{text:(action?.action==='continue'?action.message:task.message)+adoptedGuidance(task,store,'generation')+(task.requirementsId?'\n\n本轮固定交付清单（不得缩减，逐项完成）：\n'+JSON.stringify(new ManifestStore(store).get(task.requirementsId)):'')})});
      if(receipt?.state!=='accepted')throw new Pending('委托是否被接受尚未确认，需要核对原会话；不会自动重复发送');
      task.generation.deliveryState='accepted';task.generation.conversationId=receipt.conversationId;task.threadId=receipt.conversationId;store.put(task);
      store.event(task.id,initial?'委托已接受，正在追踪 Kooboo 实际执行循环':'AI 跟进已提交到原站原会话');
    } else if(task.generation.deliveryState==='sending'){
      if(state.delivery?.id!==task.generation.deliveryId||state.delivery?.state!=='accepted')throw new Pending('上一次发送结果不确定，不能自动重发，请核对原会话');
      task.generation.deliveryState='accepted';store.put(task);
    }
    let idleSince=Date.now();
    while(true){
      signal.throwIfAborted();state=await session.snapshot();
      if(state.conversationId!==task.generation.conversationId)throw new Pending('原会话身份发生变化，停止自动操作并核对');
      if(state.pending)throw new Pending('Kooboo 正在等待输入或工具确认：'+state.pending.name);
      if(state.delivery?.error)throw new Pending(state.delivery.error);
      if(!state.running&&state.state==='completed'&&state.outcome?.runId&&state.delivery?.id===task.generation.deliveryId){
        task.generation.deliveryState='completed';task.generation.state='completed';store.put(task);store.event(task.id,'Kooboo 本轮执行循环已结束，正在核对站点是否可交接评测');break;
      }
      if(!state.running&&['failed','interrupted'].includes(state.state))throw new Pending('Kooboo 本轮执行结束，结果为 '+state.state+'，由 AI 核对并跟进');
      if(state.running)idleSince=Date.now();
      if(!state.running&&Date.now()-idleSince>45000)throw new Pending('执行状态尚未取得可信终态，由 AI 读取原会话核对');
      await delay(1000,signal);
    }
  }finally{await session.close();}
  task.stage='handoff';store.put(task);
  const ready=await refreshSite(task,store,vault,signal);await probeSite(ready?.url||'',signal);
}
