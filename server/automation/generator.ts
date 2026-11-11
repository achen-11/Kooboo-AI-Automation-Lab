import { randomUUID } from 'node:crypto';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Pending, GenerationInputError, FollowupRuntimeError } from './errors.js';
import { prepareGenerationContext, assertGenerationInput, cleanupGenerationContext } from './generation-context.js';

import { koobooClient, siteIdentity, refreshSite, probeSite } from './kooboo.js';
import { materialDestination, readMaterial } from './materials.js';
import { generationSession } from './generation-session.js';
import { readEvidence } from './optimization-evidence.js';
import { ensureManifest, ManifestStore } from './completeness.js';
import { selectExperience, adoptedGuidance } from './experience.js';
import { optimizationBudgetReason } from './optimization.js';
import { ModelBudgetExceeded } from './request-budget.js';
import { ensureSourceCollection } from './collection/orchestrator.js';
import { effectiveCollectionInput } from './collection/store.js';
import { frozenCollectionAssetGapGuidance, preflightCollectionTarget } from './collection/target-verification.js';
import { sourceVisualFoldImages, sourceVisualMaterial, sourceVisualRequired, type SourceVisualIndex } from './collection/source-visual.js';
import { adaptRepairImages } from './repair-images.js';
import { resolve } from 'node:path';
import { generatedSiteName, normalizeRootDomain, parseRootDomains } from '../../shared/kooboo-domains.js';

async function delay(ms:number,signal:AbortSignal){await new Promise<void>((r,j)=>{signal.throwIfAborted();const done=()=>{signal.removeEventListener('abort',abort);r();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);j(signal.reason);};signal.addEventListener('abort',abort,{once:true});});}

/** Existing Kooboo APIs + the existing frontend stream/function loop. No server generation API is introduced. */
export async function executeGeneration(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,openSession:typeof generationSession=generationSession){
  await ensureSourceCollection(task,store,vault,directory,signal);
  const input=effectiveCollectionInput(task,store,directory);if(!input)throw new Error('缺少固定的输入版本');
  if(task.collectionVersionId){
    const manifest=new ManifestStore(store).get(task.requirementsId);
    if(!manifest)throw new GenerationInputError('冻结来源缺少固定交付清单，禁止创建生成站');
    const preflight=preflightCollectionTarget({task,manifest,store,directory});
    if(preflight.state==='blocked')throw new GenerationInputError('冻结来源生成预检未通过：'+preflight.checks.filter(check=>check.failureClass==='contract-tool-defect').map(check=>check.reason).join('；').slice(0,1800));
    if(!task.generatedSiteId&&sourceVisualRequired(input)&&!input.files.some(file=>file.name===sourceVisualMaterial))
      throw new GenerationInputError(`原站迁移新建站点需要冻结的来源视觉基线 ${sourceVisualMaterial}，资料版本 ${task.collectionVersionId} 不含该基线。先对来源发起A段修订补采视觉基线，再新建站点；继续生成已有站点不受影响。`);
  }
  const acceptedAssetGuidance=frozenCollectionAssetGapGuidance(task,store,directory);
  const {environment,origin,request}=koobooClient(task,vault,signal);const apiOrigin=new URL(environment.apiOrigin||origin).origin;
  // Older executions already submitted a prompt without durable delivery receipts.
  // Retain their conversation and require explicit AI evidence before another message.
  if(!task.generation&&task.generatedSiteId&&task.context)task.generation={legacySubmitted:true,prepared:true,conversationId:task.threadId||undefined};
  task.stage='prepare';task.generation??={};store.put(task);
  let site=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
  if(!site){
    // A pre-upgrade uncertain create must still reconcile the exact old name.
    const slug=task.generation.siteName||(task.generation.createAttempted?`auto-${task.id.slice(0,12)}`:generatedSiteName(task.id));
    if(task.generation.createAttempted){
      const list=await request('Site/List');const matches=(Array.isArray(list)?list:[]).filter((s:any)=>(s.siteName||s.SiteName)===slug);
      if(matches.length!==1)throw new Pending(`站点 ${slug} 创建结果尚未唯一确认，禁止重复创建；请检查 Kooboo 环境。`);
      const adopted={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId:siteIdentity(matches[0]),name:slug,url:'',createdAt:Date.now()};
      store.saveSite(adopted);task.generatedSiteId=adopted.id;store.put(task);throw new Pending('已找到并绑定先前创建的站点，将在下一次执行中继续准备；未重复建站。');
    }
    const domains=parseRootDomains(await request('Domain/Available'));
    // Legacy tasks without a choice freeze it before the first creation attempt.
    const root=normalizeRootDomain(task.generation.rootDomain||environment.defaultRootDomain||domains[0]?.domainName||'');
    if(!root)throw new Error('Kooboo 未返回可用根域名，请核对连接环境');
    task.generation.rootDomain=root;store.put(task);
    if(!domains.some(domain=>domain.domainName===root))throw new FollowupRuntimeError(`建站根域名 ${root} 在当前 Kooboo 环境中已不可用，请核对环境域名后重试；不会自动改用其他域名。`,['在原 Kooboo 环境恢复所选根域名后重试；或停止本任务，选择可用根域名新建任务。']);
    store.event(task.id,`准备新站 ${slug}；根域名 ${root}；创建结果不确定时停止，不自动重发创建请求`);
    let created:any;task.generation.siteName=slug;task.generation.createAttempted=true;store.put(task);
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
  const materials=input.files.map(file=>{const destination=materialDestination(task.resourceId,task.versionId,file);return {name:file.name,id:file.id,destination:destination.path,type:file.type,size:file.size,sha256:file.sha256,storage:destination.text?'kfile':'file'};});
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
    const mappings=materials.map(({name,id,destination})=>({name,id,destination}));
    const result=await request('AI/CallFunction',{name:'run_kscript',callId:randomUUID(),arguments:{code:`k.file.write(${JSON.stringify(manifestPath)}, ${JSON.stringify(JSON.stringify(mappings))}); return true;`}},site.siteId);
    const content=result?.contents?.[0];if(!content||content.isError||content.result===false||content.result?.error)throw new Error('资料映射清单写入未确认');
    task.message+='\n资料映射清单：kfile:'+manifestPath+'；共 '+uploaded.length+' 份资料。按需从清单定位文件，每次只返回必要摘要，禁止把全清单展开到聊天。';store.put(task);}
  task.generation.prepared=true;store.put(task);
  if((!task.generation.deliveryId||task.generation.next)&&!task.generation.legacySubmitted&&(task.generation.deliveryState!=='completed'||task.generation.next)){
    await ensureManifest(task,store,vault,directory,signal);
    await selectExperience(task,'generation',store,vault,directory,signal);
  }
  // A finished chat loop may have produced no page. An explicit, validated
  // continuation must reach the pinned conversation even after that receipt.
  const continuation=task.generation.next?.action==='continue'||task.generation.next?.action==='answer'||!!(task.generation.repairBatch&&task.generation.repairBatch.completed<task.generation.repairBatch.total);
  if(task.generation.deliveryState==='completed'&&!continuation){
    await cleanupGenerationContext(task,store,request,site.siteId,true);
    task.stage='handoff';store.put(task);const ready=await refreshSite(task,store,vault,signal);await probeSite(ready?.url||'',signal);return;
  }
  task.stage='generation';store.put(task);
  const budget=optimizationBudgetReason(task,store);if(budget)throw new ModelBudgetExceeded(budget);
  const session=await openSession(task,store,vault,directory,signal);
  try{
    let adapted:ReturnType<typeof adaptRepairImages>|undefined;
    // Each batch owns a durable delivery receipt. Only a matching terminal run
    // advances it; a restart must never replay an accepted, uncertain send.
    while(true){
    let state=await session.snapshot();
    const action=task.generation.next;
    const initial=!task.generation.deliveryId;
    if(initial&&task.generation.legacySubmitted&&!action)throw new Pending('旧任务已提交过原始委托，由 AI 核对交付并交接评测或明确继续，不能重发初始消息');
    if(initial||action?.action==='continue'||action?.action==='answer'){
      if(state.running)throw new Pending('原会话仍在执行，保留当前执行，稍后核对');
      if(state.pending&&action?.action!=='answer')throw new Pending('原会话存在待输入调用，需先回答后再发送修复批次：'+state.pending.name);
      const repairSources=task.repairEvidence?task.repairEvidence.files.map(name=>{
        const file=store.task(task.repairEvidence!.reportId)?.report?.artifacts.find(f=>f.name===name);if(!file)throw new Error('修复引用的原报告图片不存在');
        return readEvidence(directory,task.repairEvidence!.reportId,file);
      }):undefined;
      if(task.scenario==='site-template'&&repairSources&&action?.action!=='answer')adapted??=adaptRepairImages(repairSources,resolve(directory,'automation-runs',task.id,'repair-images'));
      if(adapted?.batches.length){
        const saved=task.generation.repairBatch;
        if(saved&&saved.planKey!==adapted.planKey)throw new GenerationInputError('修复图片计划发生变化，需核对已发送批次；禁止重置后重复发送');
        task.generation.repairBatch??={planKey:adapted.planKey,completed:0,total:adapted.batches.length};store.put(task);
      }
      const batch=action?.action==='answer'?undefined:adapted?.batches[task.generation.repairBatch?.completed||0];
      let images=action?.action==='answer'?undefined:batch?.images||(!adapted?repairSources?.map(image=>({uri:'data:image/png;base64,'+image.bytes.toString('base64'),mediaType:'image/png' as const})):undefined);
      const baseline=initial&&!images&&state.imageInput?sourceVisualBaselineImages(input,directory):undefined;
      if(baseline?.images.length)images=baseline.images;
      if(images?.length&&!state.imageInput)throw new Pending('当前 Kooboo automation bridge 不支持图片修复委托，请更新 bridge 后恢复；尚未发送修复消息。');
      // Validate images/answers before provisioning files or changing deliveryId.
      assertGenerationInput(undefined,images,action?.action==='answer'?action.answer:undefined);
      const manifest=task.requirementsId?new ManifestStore(store).get(task.requirementsId):undefined;
      const collectionGuidance=task.collectionVersionId?'\n本任务的A段已核验并冻结资料版本 '+task.collectionVersionId+'。使用资料映射清单按需读取原件、完整正文、数据分片和关系；批量落地当前范围，避免重新全站采集。动态记录保存可回读的 sourceUrl 或 oldUrl 完整来源 URL。SQLite 表 CollectionRecordBindings 用 id、requirementId、sourceUrl、targetKind（sqlite/content）、targetContainer（真实表名/Content容器）、targetId（真实记录主键）、identityKeyField（可空，默认id）声明每项页面或数据要求的规范记录；记录本身的sourceUrl/oldUrl必须匹配原URL。页面索引和业务记录可共存，不为凑数复制实体；每个冻结路径含分页都要明确映射。CollectionRelationBindings 用 id、sourcePath（完整原路径及查询参数）、tableName、parentField、childField、orderField、parentIdentityField、childIdentityField、sourcePathField 声明真实关系字段。父子引用字段从对应规范记录读取，默认identityKeyField/id；关系行须用sourcePathField区分分页与别名，不能把分类全部分页混成一页，顺序字段须为唯一数值。所有含详情成员的来源页均适用，不依赖pageType标签。CollectionAssetBindings 用 id、sourceUrl、materialPath（冻结state.localPath原值）、targetUrl（当前目标同域真实URL）记录已取得素材映射；同字节允许多个源URL共用文件，不能混淆源URL数与文件数。三张表仅声明现有实现，不提供或改写预期成员，不把目标总量反推来源。保留分类关系、成员顺序、分页、数字路径、.aspx与查询参数；元数据引号等原字符按HTML上下文转义，不能删字符。实际目标响应须承接原页标题、可见正文和链接，禁止以HTTP200、隐藏文本、记录数量或生成自述替代完整性。每批只返回完成对象、缺口与证据的短摘要。':'';
      if(task.requirementsId&&!manifest)throw new GenerationInputError('固定交付清单不存在，禁止发送不完整委托');
      const prepared=action?.action==='answer'?undefined:await prepareGenerationContext(task,store,request,site.siteId,{
        instructions:batch&&task.generation.repairBatch!.completed<adapted!.batches.length-1
          ?'修复证据正在分批传递。此批仅研读附件，简要记录可见差异和图片区域对应关系，不修改目标站、不调用写入工具、不重新采集。后续批次将补齐证据，最后一批才会收到完整修复委托。读完本批后简短结束，等待调度器追加下一批。'
          :action?.action==='continue'&&action.message!==task.message
          ?task.message+'\n\n本轮已核对的跟进要求：\n'+action.message:task.message,
        guidance:adoptedGuidance(task,store,'generation')+collectionGuidance+acceptedAssetGuidance+(baseline?.label||'')+(batch?`\n修复证据批次 ${(task.generation.repairBatch?.completed||0)+1}/${adapted!.batches.length}。${task.generation.repairBatch!.completed===adapted!.batches.length-1?'已到最后一批，结合前批已研读的证据统一执行本次完整修复，完成后按原完整范围独立复评。':'本批只研读，不执行修复。'}`+batch.label:''),
        manifest,
        materials,
      });
      assertGenerationInput(prepared?.text,images,action?.action==='answer'?action.answer:undefined);
      if(prepared){store.event(task.id,`生成委托资料：${prepared.mode}；最终文本 ${Buffer.byteLength(prepared.text)} bytes，图片 ${images?.length||0} 张；平台原件 ${prepared.packageId}`);}
      const id=randomUUID();task.generation.deliveryId=id;task.generation.deliveryState='sending';if(task.generation.repairBatch&&task.generation.repairBatch.completed<task.generation.repairBatch.total)task.generation.repairBatch.deliveryId=id;delete task.generation.next;store.put(task);
      const receipt=await session.deliver({id,conversationId:task.generation.conversationId||state.conversationId,images,
        ...(action?.action==='answer'?{answer:action.answer,callId:action.callId}:{text:prepared!.text})});
      if(receipt?.state!=='accepted')throw new Pending('委托是否被接受尚未确认，需要核对原会话；不会自动重复发送');
      task.generation.deliveryState='accepted';task.generation.conversationId=receipt.conversationId;task.threadId=receipt.conversationId;task.error='';store.put(task);
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
      if(state.delivery?.error){if(isContextOverflow(state.delivery.error))throw new GenerationInputError(state.delivery.error+'；已停止原样重试');throw new Pending(state.delivery.error);}
      if(!state.running&&state.state==='completed'&&state.outcome?.runId&&state.delivery?.id===task.generation.deliveryId){
        task.generation.deliveryState='completed';task.generation.state='completed';store.put(task);store.event(task.id,'Kooboo 本轮执行循环已结束，正在核对站点是否可交接评测');break;
      }
      if(!state.running&&['failed','interrupted'].includes(state.state)){
        if(isContextOverflow(JSON.stringify(state.context)))throw new GenerationInputError('Kooboo 报告上下文超限，已停止原样重试；需先压缩原会话或完成同站交接');
        throw new Pending('Kooboo 本轮执行结束，结果为 '+state.state+'，由 AI 核对并跟进');
      }
      if(state.running)idleSince=Date.now();
      if(!state.running&&Date.now()-idleSince>45000)throw new Pending('执行状态尚未取得可信终态，由 AI 读取原会话核对');
      await delay(1000,signal);
    }
    const progress=task.generation.repairBatch;
    if(progress&&progress.deliveryId===task.generation.deliveryId&&progress.completed<progress.total){
      progress.completed++;delete progress.deliveryId;
      if(progress.completed<progress.total)task.generation.next={action:'continue',reason:'上一修复批次已取得匹配的完成回执，接续剩余证据',evidence:[],message:'继续原修复任务，仅处理本批附件所对应的剩余问题。保留已完成修复，全部批次后检查原范围与双端。'};
      store.put(task);store.event(task.id,`修复证据批次 ${progress.completed}/${progress.total} 已完成并保存回执。`);
      if(progress.completed<progress.total)continue;
    }
    break;
    }
  }finally{await session.close();}
  // The trusted terminal receipt/context were persisted above and the browser
  // has closed. The full package is archived locally for future re-provisioning.
  await cleanupGenerationContext(task,store,request,site.siteId,true);
  task.stage='handoff';store.put(task);
  const ready=await refreshSite(task,store,vault,signal);await probeSite(ready?.url||'',signal);
}

/** Source first screens for the initial delegate; full-page baselines stay in the material package. */
export function sourceVisualBaselineImages(input:{files:MaterialFile[]},directory:string,limits={each:4*1024*1024,total:12*1024*1024,count:6}){
  const files=input.files,indexFile=files.find(file=>file.name===sourceVisualMaterial);
  if(!indexFile)return undefined;
  const index=JSON.parse(readMaterial(directory,indexFile).toString()) as SourceVisualIndex,images:{uri:string;mediaType:'image/png'}[]=[],labels:string[]=[];let total=0;
  for(const shot of sourceVisualFoldImages(index,limits.count)){
    const file=files.find(item=>item.name==='collection/'+shot.path);if(!file)continue;
    const bytes=readMaterial(directory,file);if(bytes.length>limits.each||total+bytes.length>limits.total)continue;
    total+=bytes.length;images.push({uri:'data:image/png;base64,'+bytes.toString('base64'),mediaType:'image/png'});
    labels.push(`${images.length}. ${shot.urlTemplate}（${shot.url}）${shot.settled===false?'：截图时仍有图片未加载，空白处不代表原站没有内容':''}`);
  }
  return {images,label:images.length?`\n本次附带原站桌面首屏截图 ${images.length} 张，按顺序对应：${labels.join('；')}。完整整页图和移动端截图见 collection/site/visual/。`:''};
}

export function isContextOverflow(message:string){return /context_length_exceeded|maximum context length|context.{0,35}(?:overflow|exceed)|上下文.{0,12}(?:溢出|超限|超出)/i.test(message);}
