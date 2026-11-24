import { randomUUID } from 'node:crypto';
import { ensureTemplateAnalysis } from './template-analysis.js';
import {
  effectiveTemplateUsageMode,
  requiredKoobooSandboxCapability,
  type AutomationTask,
  type InputVersion,
  type MaterialFile,
  type RequiredKoobooSandboxCapability,
} from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Pending, GenerationInputError, FollowupRuntimeError } from './errors.js';
import { prepareGenerationContext, assertGenerationInput, cleanupGenerationContext } from './generation-context.js';

import {
  koobooClient,
  siteIdentity,
  refreshSite,
  probeSite,
  fetchKoobooTemplateDetail,
  probeKoobooApiMethod,
} from './kooboo.js';
import { readMaterial } from './materials.js';
import { mergeTaskMaterials, resolveTaskMaterialEntry, syncMaterialManifestToSite, uploadMaterialsToKoobooSite } from './kooboo-materials.js';
import { generationSession, matchingGenerationOutcome } from './generation-session.js';
import { ensureManifest, ManifestStore } from './completeness.js';
import { selectExperience, adoptedGuidance } from './experience.js';
import { optimizationBudgetReason } from './optimization.js';
import { ModelBudgetExceeded } from './request-budget.js';
import { ensureSourceCollection } from './collection/orchestrator.js';
import { effectiveCollectionInput } from './collection/store.js';
import { frozenCollectionAssetGapGuidance, preflightCollectionTarget } from './collection/target-verification.js';
import { sourceVisualFoldImages, sourceVisualMaterial, sourceVisualRequired, type SourceVisualIndex } from './collection/source-visual.js';
import { generatedSiteName, normalizeRootDomain, parseRootDomains, findRootDomain, rootDomainValue } from '../../shared/kooboo-domains.js';
import { generationSourceEvidence, templateGenerationSources } from './generation-reference.js';
import { GenerationDeliveryStore, isPreSendBridgeRejection } from './generation-delivery.js';
import { assertSiteNaming, availableSiteNames } from './site-naming.js';
import { prepareReferenceMedia } from './generation-reference-media.js';
import { deriveHumanNotice } from '../../shared/human-diagnostics.js';
import {
  checkReferenceUrlPreflight,
  type ReferencePreflightFn,
  type ReferencePreflightResult,
} from './reference-preflight.js';

async function delay(ms:number,signal:AbortSignal){await new Promise<void>((r,j)=>{signal.throwIfAborted();const done=()=>{signal.removeEventListener('abort',abort);r();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);j(signal.reason);};signal.addEventListener('abort',abort,{once:true});});}

function zeroPageTransferError(contentUrl:string,siteId:string,sandboxName?:string){
  const techReason=sandboxName
    ?`旧内容站 Sandbox 克隆完成但导入 0 页（${contentUrl} -> ${sandboxName}），已重试后仍无法获取源站页面`
    :`内容站克隆完成但导入 0 页（${contentUrl}），已重试后仍无法获取源站页面`;
  const nextSteps=[
    `在浏览器打开 ${contentUrl}，确认原网站可公开访问且未被验证码或登录拦截。`,
    `如原站开启了防抓取限制，可在 Kooboo ${sandboxName?'源站 Sandbox':'目标站'}手动导入页面后，回到此处点击「恢复执行」。`,
    `如果原网址无效或已更换，请调整输入中的源站地址或改用上传资料重新生成。`,
  ];
  const userSummary=deriveHumanNotice({
    reason:`pages=0 ${sandboxName?'sourceSandbox':'transferTaskId'} ${techReason}`,
    error:techReason,
    stage:'generation',
    generatedSiteId:siteId,
    nextSteps,
  });
  return new FollowupRuntimeError(techReason,nextSteps,userSummary);
}

export interface TransferWaitResult{
  pages:number;
  done:boolean;
  completedPages?:number;
  totalPages?:number;
  stalled?:boolean;
  timedOut?:boolean;
}

export async function waitForTransferPages(params:{
  request:(path:string,body?:unknown,siteId?:string)=>Promise<any>;
  siteId:string;
  transferTaskId:string;
  signal:AbortSignal;
  allowInitialCheck:boolean;
  pollMs?:number;
  maxEmptyPolls?:number;
  stallTimeoutMs?:number;
  maxWaitMs?:number;
  progressIntervalMs?:number;
  onProgress?:(info:{completedPages:number;totalPages:number;elapsedMs:number})=>void;
}):Promise<TransferWaitResult>{
  const {request,siteId,transferTaskId,signal,allowInitialCheck}=params;
  const pollMs=params.pollMs??2000;
  const emptyDoneDelayMs=Math.min(pollMs,500);
  const maxEmptyPolls=params.maxEmptyPolls??12;
  // Align stall detection with .NET HttpClient's 100s timeout and Kooboo GetTaskStatus's 2-minute TTL.
  const stallTimeoutMs=params.stallTimeoutMs??120_000;
  const maxWaitMs=params.maxWaitMs??5*60_000;
  const progressIntervalMs=params.progressIntervalMs??15_000;
  if(allowInitialCheck){
    const existing=await request('Transfer/GetTaskStatus',undefined,siteId);
    if(Number(existing?.pages||0)>0&&existing?.done!==false){
      return {pages:Number(existing.pages),done:true};
    }
  }
  const startedAt=Date.now();
  let lastProgressAt=startedAt,lastReportAt=0;
  let previousTotal=-1,previousDone=-1,stable=0,emptyPolls=0,emptyDoneChecks=0;
  while(stable<2){
    signal.throwIfAborted();
    const status=await request(`Transfer/GetStatus?id=${encodeURIComponent(transferTaskId)}`,undefined,siteId);
    const pages=Array.isArray(status)?status:[];
    const now=Date.now();
    if(pages.length>0){
      const doneCount=pages.filter((p:any)=>p?.done===true).length;
      const allDone=doneCount===pages.length;
      if(pages.length!==previousTotal||doneCount!==previousDone){
        lastProgressAt=now;
      }
      stable=allDone&&previousTotal===pages.length?stable+1:0;
      previousTotal=pages.length;
      previousDone=doneCount;
      emptyPolls=0;
      emptyDoneChecks=0;
      if(stable>=2)break;
      if(!allDone&&params.onProgress){
        if((lastReportAt===0?now-startedAt:now-lastReportAt)>=progressIntervalMs){
          lastReportAt=now;
          params.onProgress({completedPages:doneCount,totalPages:pages.length,elapsedMs:now-startedAt});
        }
      }
      const stalled=(now-lastProgressAt)>=stallTimeoutMs;
      const timedOut=(now-startedAt)>=maxWaitMs;
      if(!allDone&&(stalled||timedOut)){
        const summary=await request('Transfer/GetTaskStatus',undefined,siteId);
        return {pages:Number(summary?.pages||0),done:summary?.done!==false,completedPages:doneCount,totalPages:pages.length,stalled,timedOut};
      }
      await delay(pollMs,signal);
      continue;
    }
    emptyPolls++;
    const summary=await request('Transfer/GetTaskStatus',undefined,siteId);
    if(Number(summary?.pages||0)>0&&summary?.done!==false){
      return {pages:Number(summary.pages),done:true};
    }
    if(summary?.done===true){
      emptyDoneChecks++;
      if(emptyDoneChecks>=2)return {pages:0,done:true};
      await delay(emptyDoneDelayMs,signal);
      continue;
    }
    if(emptyPolls>=maxEmptyPolls)return {pages:0,done:Boolean(summary?.done)};
    if((now-startedAt)>=maxWaitMs)return {pages:Number(summary?.pages||0),done:Boolean(summary?.done),timedOut:true};
    await delay(pollMs,signal);
  }
  const status=await request('Transfer/GetTaskStatus',undefined,siteId);
  return {pages:Number(status?.pages||0),done:status?.done!==false,completedPages:Math.max(0,previousDone),totalPages:Math.max(0,previousTotal),stalled:false,timedOut:false};
}

function isValidHttpUrl(value:string){
  try{const url=new URL(value);return /^https?:$/i.test(url.protocol)&&Boolean(url.hostname);}catch{return false;}
}

async function resolveTaskReferenceTemplate(task:AutomationTask,input:InputVersion,store:AutomationStore,vault:Vault,signal:AbortSignal){
  const templateId=input.referenceTemplateId?.trim();
  if(!templateId)return undefined;
  const existing=task.generation?.referenceTemplate;
  if(existing?.templateId===templateId&&isValidHttpUrl(existing.previewUrl))return existing;
  const {origin,request}=koobooClient(task,vault,signal);
  const detail=await fetchKoobooTemplateDetail(request,templateId,origin);
  if(!detail.previewUrl||!isValidHttpUrl(detail.previewUrl))
    throw new GenerationInputError(`当前 Kooboo 环境未返回模板 ${templateId} 的有效 previewUrl，已停止生成（不回退默认预览域名）`);
  const existingTargetDirect=task.generatedSiteId
    ?store.siteTasks(task.generatedSiteId).some(other=>other.kind==='generation'&&other.generation?.referenceTemplate?.mode==='direct-template'&&other.generation.referenceTemplate.templateId===detail.id)
    :false;
  const mode=task.generatedSiteId
    ?(existingTargetDirect?'direct-template':'reference-sandbox')
    :effectiveTemplateUsageMode(input,false)!;
  const frozen={templateId:detail.id,templateName:detail.name||input.referenceTemplateName||detail.id,previewUrl:new URL(detail.previewUrl).href,mode};
  task.generation={...(task.generation||{}),referenceTemplate:frozen};
  store.put(task);
  store.event(task.id,`已绑定 Kooboo 模板 ${frozen.templateName}（${mode==='direct-template'?'直接模板建站并原位适配':'克隆到参考 Sandbox'}）：${frozen.previewUrl}`);
  return frozen;
}

function buildTemplateExecutionGuidance(task:AutomationTask,input:InputVersion,targetSiteId:string){
  const ref=task.generation?.referenceTemplate;
  if(!ref)return undefined;
  if(ref.mode==='direct-template'){
    const facts={
      mode:ref.mode,
      templateId:ref.templateId,
      templateName:ref.templateName,
      previewUrl:ref.previewUrl,
      targetSiteId,
      ...(task.generation?.sourceSandbox?{sourceSandbox:task.generation.sourceSandbox}:{}),
    };
    return [
      'Kooboo 原生模板原位适配执行说明（宿主已准备完成，不要重新建站或使用 transfer_page）：',
      JSON.stringify(facts),
      '1. 目标站已直接从该 Kooboo 模板创建。先按 kooboo-site-redesign 的 references/template-adaptation.md 检查目标站现有 Page / Layout / View / ContentType / Content / File / Menu / Style / Script，在原位适配替换，不从零重写全站模板。',
      '2. 强制零残留：完成改造后必须检查并清除所有模板原品牌名（含 '+ref.templateName+'）、演示文案、演示图片/占位图及多余示例页面或导航链接。',
      ...(task.generation?.sourceSandbox
        ?[`3. 旧站角色对调（只读源站 Sandbox）：旧内容站 ${input.contentUrl} 已克隆到只读源站 Sandbox「${task.generation.sourceSandbox.sandbox}」（siteId：${task.generation.sourceSandbox.siteId}）。请仅从该源站 Sandbox 读取旧站事实/路由/正文/动态数据/图片素材并映射到原生模板结构中，严禁把旧站整套 HTML/CSS 模板覆写进目标站。`]
        :[]),
    ].join('\n');
  }
  const sandbox=task.generation?.referenceTemplateSandbox;
  return [
    'Kooboo 模板参考 Sandbox 执行说明（宿主已预先导入隔离 Sandbox，不要再对预览地址运行 transfer_page）：',
    JSON.stringify({mode:ref.mode,templateId:ref.templateId,templateName:ref.templateName,previewUrl:ref.previewUrl,referenceTemplateSandbox:sandbox}),
    '直接通过 list_sandbox / read_object_text / take_screenshot 读取隔离研究 Sandbox 中的原生 Kooboo 对象与视觉呈现，按 kooboo-site-redesign 重建到目标站，严禁将参考源码直接整站复制到目标站。',
  ].join('\n');
}

function unsupportedKoobooTemplateError(required: RequiredKoobooSandboxCapability, siteId?: string | null) {
  const techReason = `目标 Kooboo 环境版本暂不支持模板 Sandbox 接口（${required.method}），无法执行「${required.label}」`;
  const nextSteps = [
    '将该资源的参考站来源改回「外部参考站 URL」（可直接填入模板预览地址），再新建任务。',
    '或切换至已升级最新版本的 Kooboo 环境后重新发起任务。',
    ...(required.key === 'transferByLevel'
      ? ['若已准备好旧站离线资料，也可通过「补充资料」跳过原站克隆后恢复执行。']
      : []),
  ];
  const userSummary = deriveHumanNotice({
    userSummary: {
      headline: '目标 Kooboo 环境暂不支持模板 Sandbox 接口',
      category: 'environment',
      explanation: `当前 Kooboo 环境尚未更新「${required.label}」所需接口，因此已在${siteId ? '导入参考或源站 Sandbox 前' : '建站前'}安全拦截，未留下半成品站点。`,
      userActions: nextSteps,
    },
    stage: 'prepare',
    generatedSiteId: siteId,
  });
  return new FollowupRuntimeError(techReason, nextSteps, userSummary);
}

function referencePreflightError(
  refUrl: string,
  result: Extract<ReferencePreflightResult, { ok: false }>,
  siteId?: string | null,
) {
  const reasonLabelMap: Record<typeof result.reasonCode, string> = {
    invalid_url: '地址无效',
    network_error: '网络连接失败',
    timeout: '加载超时',
    http_error: '返回错误状态',
    challenge_or_waf: '防火墙/反爬拦截',
    login_required: '需要登录访问',
    blank_page: '空白页或空壳',
  };
  const reasonLabel = reasonLabelMap[result.reasonCode] || '无法访问';
  const techReason = `参考站预检失败（${reasonLabel}，${refUrl}）：${result.detail}`;
  const nextSteps = [
    '点击「补充资料」，更换可公开访问的参考站 URL 后重新预检。',
    '或在「补充资料」手动上传参考站截图，并勾选「跳过外链预检并按截图还原」。',
    '如确认无需参考站，可在「补充资料」勾选「放弃参考站，授权 AI 自由设计」后恢复执行。',
  ];
  const userSummary = deriveHumanNotice({
    userSummary: {
      headline: '无法获取参考站页面，已暂停等待决策',
      category: 'source-access',
      explanation: `建站前预检参考站失败（${reasonLabel}：${result.detail}）。为避免 AI 在没有参考站的情况下自由发挥并浪费 Token，已在${siteId ? '发送生成委托前' : '创建站点前'}暂停，等待您决定处理方式。`,
      userActions: nextSteps,
    },
    stage: 'prepare',
    generatedSiteId: siteId,
  });
  return new FollowupRuntimeError(techReason, nextSteps, userSummary);
}

/** Existing Kooboo APIs + the existing frontend stream/function loop. No server generation API is introduced. */
export async function executeGeneration(
  task: AutomationTask,
  store: AutomationStore,
  vault: Vault,
  directory: string,
  signal: AbortSignal,
  openSession: typeof generationSession = generationSession,
  options?: { preflightReference?: ReferencePreflightFn },
) {
  const hadTransferTaskBeforeRun=Boolean(task.generation?.transferTaskId);
  const versionInput=store.version(task.versionId);
  if(versionInput?.referenceTemplateId)await resolveTaskReferenceTemplate(task,versionInput,store,vault,signal);
  const templateBaseline=await ensureTemplateAnalysis(task,store,vault,directory,signal);
  if(templateBaseline&&!templateBaseline.complete)throw new Pending('生成前的来源分析仍有缺口，尚未创建或修改生成站：'+templateBaseline.limitations.join('；'));
  await ensureSourceCollection(task,store,vault,directory,signal);
  const rawInput=effectiveCollectionInput(task,store,directory);if(!rawInput)throw new Error('缺少固定的输入版本');
  const overrideContentUrl=task.generation?.overrideContentUrl?.trim()||'';
  const overrideReferenceUrl=task.generation?.overrideReferenceUrl?.trim()||'';
  const input=(overrideContentUrl||overrideReferenceUrl)
    ?{...rawInput,...(overrideContentUrl?{contentUrl:overrideContentUrl}:{}),...(overrideReferenceUrl?{referenceUrl:overrideReferenceUrl}:{})}
    :rawInput;
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
  const shouldPreflightReference =
    ['upgrade', 'site-template'].includes(task.scenario) &&
    !task.templateWorkflow &&
    !input.referenceTemplateId?.trim() &&
    !task.generation.deliveryId &&
    !task.generation.legacySubmitted &&
    !task.generation.allowFreeDesignWithoutReference &&
    !task.generation.skipReferencePreflight;
  if (shouldPreflightReference) {
    const refUrl = (input.referenceUrl || (task.scenario === 'site-template' ? input.contentUrl : '') || '').trim();
    const cached = task.generation.referencePreflight;
    if (refUrl && !(cached?.url === refUrl && cached.status === 'passed')) {
      const check = await (options?.preflightReference || checkReferenceUrlPreflight)(refUrl, signal);
      task.generation.referencePreflight = {
        url: refUrl,
        status: check.ok ? 'passed' : 'failed',
        ...(check.ok ? {} : { reasonCode: check.reasonCode, detail: check.detail }),
        checkedAt: Date.now(),
      };
      store.put(task);
      if (!check.ok) {
        store.event(task.id, `参考站预检失败（${check.reasonCode}）：${refUrl} — ${check.detail}`);
        throw referencePreflightError(refUrl, check, site?.id);
      }
      store.event(
        task.id,
        `参考站可达性预检通过（${check.method === 'browser' ? '浏览器渲染' : 'HTTP'} ${check.status}）：${refUrl}`,
      );
    }
  }
  const precheckRef=task.generation.referenceTemplate;
  if(precheckRef){
    const requiredCap=requiredKoobooSandboxCapability(task.scenario,precheckRef.mode,task.generation.skipSourceTransfer);
    const needsSandboxStep=requiredCap&&(
      requiredCap.key==='transferByLevel'
        ?(!task.generation.sourceSandbox?.complete&&!task.generation.prepared)
        :(!task.generation.referenceTemplateSandbox||task.generation.referenceTemplateSandbox.templateId!==precheckRef.templateId)
    );
    if(requiredCap&&needsSandboxStep){
      const support=await probeKoobooApiMethod({apiOrigin,token:environment.token,path:requiredCap.method,signal});
      if(support==='unsupported')throw unsupportedKoobooTemplateError(requiredCap,site?.id);
    }
  }
  if(!site){
    // A pre-upgrade uncertain create must still reconcile the exact old name.
    let slug=task.generation.siteName||(task.generation.createAttempted?`auto-${task.id.slice(0,12)}`:generatedSiteName(task.id));
    if(task.generation.createAttempted){
      const list=await request('Site/List');const matches=(Array.isArray(list)?list:[]).filter((s:any)=>(s.siteName||s.SiteName)===slug);
      if(matches.length!==1)throw new Pending(`站点 ${slug} 创建结果尚未唯一确认，禁止重复创建；请检查 Kooboo 环境。`);
      const adopted={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId:siteIdentity(matches[0]),name:slug,url:'',createdAt:Date.now()};
      store.saveSite(adopted);task.generatedSiteId=adopted.id;store.put(task);throw new Pending('已找到并绑定先前创建的站点，将在下一次执行中继续准备；未重复建站。');
    }
    const domains=parseRootDomains(await request('Domain/Available'));
    // Legacy tasks without a choice freeze it before the first creation attempt.
    const selected=normalizeRootDomain(task.generation.rootDomain||environment.defaultRootDomain||domains[0]?.domainName||'');
    const rootOption=findRootDomain(domains,selected),root=rootOption?.domainName||selected;
    if(!root)throw new Error('Kooboo 未返回可用根域名，请核对连接环境');
    task.generation.rootDomain=rootOption?rootDomainValue(rootOption):root;store.put(task);
    if(!rootOption)throw new FollowupRuntimeError(`建站根域名 ${root} 在当前 Kooboo 环境中已不可用，请核对环境域名后重试；不会自动改用其他域名。`,['在原 Kooboo 环境恢复所选根域名后重试；或停止本任务，选择可用根域名新建任务。']);
    let subDomain=task.generation.subDomain||slug;
    assertSiteNaming(slug,subDomain,rootOption);
    if(task.generation.subDomain||task.generation.siteName){
      const selected=await availableSiteNames(slug,subDomain,rootOption,request);
      if(selected.siteName!==slug||selected.subDomain!==subDomain)
        store.event(task.id,`名称已占用，自动调整：站点名称 ${slug} → ${selected.siteName}；子域名 ${subDomain} → ${selected.subDomain}`);
      slug=selected.siteName;subDomain=selected.subDomain;
    }
    store.event(task.id,`准备新站 ${slug}；根域名 ${root}；创建结果不确定时停止，不自动重发创建请求`);
    let created:any;task.generation.siteName=slug;task.generation.subDomain=subDomain;task.generation.createAttempted=true;store.put(task);
    const templateRef=task.generation.referenceTemplate;
    const directTemplate=templateRef?.mode==='direct-template';
    try{
      created=directTemplate
        ?await request('Template/Use',{SiteName:slug,RootDomain:root,SubDomain:subDomain,id:templateRef!.templateId})
        :task.scenario==='upgrade'
          ?await request('Transfer/ByLevel',{siteName:slug,subDomain,rootDomain:root,url:input.contentUrl,headless:false,convertToRoot:false,TotalPages:20,Depth:2})
          :await request('Site/Create',{SiteName:slug,SubDomain:subDomain,RootDomain:root,SiteType:'p'});
    }catch{throw new Pending(`新站 ${slug} 创建结果未确认，请在 Kooboo 检查后将实际站点关联到此资源，禁止自动重复建站。`);}
    const siteId=siteIdentity(created);
    if(!/^[a-f0-9-]{36}$/i.test(siteId)||/^00000000-0000-0000-0000-000000000000$/i.test(siteId))throw new Pending(`新站 ${slug} 未返回有效身份，请检查 Kooboo 实际站点。`);
    site={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId,name:slug,url:'',createdAt:Date.now()};
    if(task.scenario==='upgrade'&&!directTemplate)task.generation.transferTaskId=created.taskId;
    store.saveSite(site);task.generatedSiteId=site.id;store.put(task);
    store.event(task.id,directTemplate?`已通过模板 ${templateRef!.templateName} 创建生成站 ${siteId}`:`已绑定生成站 ${siteId}`);
  }
  if(!site)throw new Error('没有可执行的生成站');
  store.beginSiteChange(task);
  const templateRef=task.generation.referenceTemplate;
  const directTemplate=templateRef?.mode==='direct-template';
  if(task.generation.skipSourceTransfer){
    if(!task.generation.transferComplete||(task.generation.sourceSandbox&&!task.generation.sourceSandbox.complete)){
      task.generation.transferComplete=true;
      if(task.generation.sourceSandbox)task.generation.sourceSandbox.complete=true;
      store.put(task);
      store.event(task.id,'已配置跳过原站克隆，改用补充资料继续生成');
    }
  }
  const transferProgress=(label:string)=>({completedPages,totalPages,elapsedMs}:{completedPages:number;totalPages:number;elapsedMs:number})=>{
    const seconds=Math.max(1,Math.round(elapsedMs/1000));
    store.event(task.id,`${label}：已完成 ${completedPages}/${totalPages} 页（已等待 ${seconds} 秒）`);
    store.put(task);
  };
  if(task.scenario==='upgrade'&&directTemplate&&!task.generation.skipSourceTransfer&&!task.generation.sourceSandbox?.complete&&!task.generation.prepared){
    let sourceSandbox=task.generation.sourceSandbox;
    const hadSandboxTransfer=Boolean(sourceSandbox?.siteId&&sourceSandbox.transferTaskId);
    const isValidSandbox=(sandbox:string,sandboxSiteId:string,transferTaskId:string)=>
      Boolean(sandbox&&/^[a-f0-9-]{36}$/i.test(sandboxSiteId)&&!/^00000000-0000-0000-0000-000000000000$/i.test(sandboxSiteId)&&transferTaskId);
    if(!sourceSandbox?.siteId||!sourceSandbox.transferTaskId){
      let transferred=await request('AISandbox/TransferByLevel',{url:input.contentUrl,totalPages:20,depth:2},site.siteId);
      let sandboxSiteId=siteIdentity(transferred),sandbox=String(transferred?.sandbox||'').trim(),transferTaskId=String(transferred?.taskId||'').trim(),previewUrl=String(transferred?.previewUrl||'').trim();
      if(!isValidSandbox(sandbox,sandboxSiteId,transferTaskId)&&!task.generation.transferFallbackAttempted){
        task.generation.transferFallbackAttempted=true;store.put(task);
        store.event(task.id,'旧内容站克隆到只读源站 Sandbox 未返回有效标识，尝试重建 1 次只读源站抓取');
        try{
          transferred=await request('AISandbox/TransferByLevel',{url:input.contentUrl,totalPages:20,depth:2},site.siteId);
          sandboxSiteId=siteIdentity(transferred);sandbox=String(transferred?.sandbox||'').trim();transferTaskId=String(transferred?.taskId||'').trim();previewUrl=String(transferred?.previewUrl||'').trim();
        }catch(err:any){store.event(task.id,`重建只读源站抓取失败：${err?.message||'请求异常'}`);}
      }
      if(!isValidSandbox(sandbox,sandboxSiteId,transferTaskId)){
        task.generation.transferFallbackAttempted=true;store.put(task);
        throw zeroPageTransferError(input.contentUrl,site.id,sandbox||'source-sandbox');
      }
      sourceSandbox={sandbox,siteId:sandboxSiteId,previewUrl,transferTaskId,complete:false};
      task.generation.sourceSandbox=sourceSandbox;store.put(task);
      store.event(task.id,`已创建只读源站 Sandbox ${sandbox}（${sandboxSiteId}），正在同步旧内容站`);
    }
    let transfer=await waitForTransferPages({request,siteId:sourceSandbox.siteId,transferTaskId:sourceSandbox.transferTaskId!,signal,allowInitialCheck:hadSandboxTransfer,onProgress:transferProgress('正在同步旧内容站 Sandbox')});
    if(!transfer.pages&&!task.generation.transferFallbackAttempted){
      task.generation.transferFallbackAttempted=true;store.put(task);
      store.event(task.id,'旧内容站 Sandbox 克隆完成但导入 0 页，尝试重建 1 次只读源站抓取');
      try{
        const retried=await request('AISandbox/TransferByLevel',{url:input.contentUrl,totalPages:20,depth:2},site.siteId);
        const sandboxSiteId=siteIdentity(retried),sandbox=String(retried?.sandbox||'').trim(),transferTaskId=String(retried?.taskId||'').trim(),previewUrl=String(retried?.previewUrl||'').trim();
        if(isValidSandbox(sandbox,sandboxSiteId,transferTaskId)){
          sourceSandbox={sandbox,siteId:sandboxSiteId,previewUrl,transferTaskId,complete:false};
          task.generation.sourceSandbox=sourceSandbox;store.put(task);
          transfer=await waitForTransferPages({request,siteId:sandboxSiteId,transferTaskId,signal,allowInitialCheck:false,onProgress:transferProgress('正在同步旧内容站 Sandbox')});
        }
      }catch(err:any){store.event(task.id,`重建只读源站抓取失败：${err?.message||'请求异常'}`);}
    }
    if(!transfer.pages)throw zeroPageTransferError(input.contentUrl,site.id,sourceSandbox.sandbox);
    sourceSandbox.complete=true;task.generation.sourceSandbox=sourceSandbox;task.generation.transferComplete=true;store.put(task);
    store.event(
      task.id,
      transfer.stalled||transfer.timedOut
        ?`旧内容站 Sandbox 克隆部分完成（已导入 ${transfer.pages} 页，进度 ${transfer.completedPages??transfer.pages}/${transfer.totalPages??transfer.pages} 页，其余页面超时未完成），保留已导入页面并继续后续流程`
        :`旧内容站已克隆至源站 Sandbox ${sourceSandbox.sandbox}（目标站保留原生 Kooboo 模板）`,
    );
  }else if(task.scenario==='upgrade'&&!directTemplate&&!task.generation.transferComplete&&!task.generation.prepared){
      const siteId=site.siteId;
      const taskId=task.generation.transferTaskId;
      if(!taskId){
        let existing=await request('Transfer/GetTaskStatus',undefined,siteId);
        let pages=Number(existing?.pages||0);
        if(!pages&&input.contentUrl&&!task.generation.transferFallbackAttempted){
          task.generation.transferFallbackAttempted=true;store.put(task);
          store.event(
            task.id,
            task.generation.overrideContentUrl
              ?'内容站克隆未返回任务标识，尝试使用替换原网址通过 Transfer/Single 抓取首页 1 次'
              :'内容站克隆未返回任务标识且当前为 0 页，尝试通过 Transfer/Single 降级抓取首页 1 次',
          );
          try{
            const single=await request('Transfer/Single',{pageUrl:input.contentUrl,name:'index'},siteId);
            if(single?.taskId){
              const transfer=await waitForTransferPages({request,siteId,transferTaskId:String(single.taskId),signal,allowInitialCheck:false,onProgress:transferProgress('正在等待内容站克隆')});
              pages=transfer.pages;
            }else{
              existing=await request('Transfer/GetTaskStatus',undefined,siteId);
              pages=Number(existing?.pages||0);
            }
          }catch(err:any){store.event(task.id,`${task.generation.overrideContentUrl?'替换原网址单页':'单页降级'}抓取失败：${err?.message||'请求异常'}`);}
        }
        if(!pages){
          task.generation.transferFallbackAttempted=true;store.put(task);
          throw zeroPageTransferError(input.contentUrl,site.id);
        }
        task.generation.transferComplete=true;store.put(task);
        store.event(task.id,'已确认目标站存在导入页面，继续准备参考站');
      }else{
        store.event(task.id,`正在等待内容站克隆完成：${input.contentUrl}`);
        store.put(task);
        let transfer=await waitForTransferPages({request,siteId,transferTaskId:taskId,signal,allowInitialCheck:hadTransferTaskBeforeRun,onProgress:transferProgress('正在等待内容站克隆')});
        if(!transfer.pages&&!task.generation.transferFallbackAttempted){
          task.generation.transferFallbackAttempted=true;store.put(task);
          store.event(task.id,'内容站克隆完成但导入 0 页，尝试通过 Transfer/Single 降级抓取首页 1 次');
          try{
            const single=await request('Transfer/Single',{pageUrl:input.contentUrl,name:'index'},siteId);
            if(single?.taskId){
              transfer=await waitForTransferPages({request,siteId,transferTaskId:String(single.taskId),signal,allowInitialCheck:false,onProgress:transferProgress('正在等待内容站克隆')});
            }else{
              const summary=await request('Transfer/GetTaskStatus',undefined,siteId);
              transfer={pages:Number(summary?.pages||0),done:summary?.done!==false};
            }
          }catch(err:any){store.event(task.id,`单页降级抓取失败：${err?.message||'请求异常'}`);}
        }
        if(!transfer.pages)throw zeroPageTransferError(input.contentUrl,site.id);
        task.generation.transferComplete=true;store.put(task);
        store.event(
          task.id,
          transfer.stalled||transfer.timedOut
            ?`内容站克隆部分完成（已导入 ${transfer.pages} 页，进度 ${transfer.completedPages??transfer.pages}/${transfer.totalPages??transfer.pages} 页，其余页面超时未完成），保留已导入页面并继续后续流程`
            :'内容站克隆完成；参考站由 Kooboo AI 使用 Sandbox tools 准备',
        );
      }
  }
  if(templateRef?.mode==='reference-sandbox'&&(!task.generation.referenceTemplateSandbox||task.generation.referenceTemplateSandbox.templateId!==templateRef.templateId)){
    const imported=await request('AISandbox/ImportFromTemplate',{templateId:templateRef.templateId,templateName:templateRef.templateName||templateRef.templateId},site.siteId);
    const sandboxSiteId=siteIdentity(imported),sandbox=String(imported?.sandbox||'').trim();
    if(!sandbox||!/^[a-f0-9-]{36}$/i.test(sandboxSiteId)||/^00000000-0000-0000-0000-000000000000$/i.test(sandboxSiteId))
      throw new Pending('参考模板导入隔离 Sandbox 未返回有效标识，请检查实际 Sandbox 状态');
    task.generation.referenceTemplateSandbox={sandbox,siteId:sandboxSiteId,previewUrl:String(imported?.previewUrl||templateRef.previewUrl),templateId:templateRef.templateId,templateName:String(imported?.templateName||templateRef.templateName)};
    store.put(task);
    store.event(task.id,`参考模板已导入研究 Sandbox ${sandbox}（${sandboxSiteId}）`);
  }
  // Materials are copied into the chosen target; no mandatory README or naming convention.
  const allMaterialFiles=mergeTaskMaterials(input.files,task.generation.supplementalFiles);
  const pendingFiles=task.generation.next?.action==='answer'
    ?[]
    :task.generation.prepared
      ?(task.generation.supplementalFiles||[]).filter(file=>task.generation!.importedMaterials?.[file.id]!==file.sha256)
      :allMaterialFiles;
  if(pendingFiles.length){
    const uploadResult=await uploadMaterialsToKoobooSite({
      task,
      siteId:site.siteId,
      files:pendingFiles,
      apiOrigin,
      token:environment.token!,
      request,
      directory,
      signal,
      mode:'materials',
      onUploaded:(file)=>{store.put(task);store.event(task.id,`资料已导入：${file.name}`);},
    });
    store.put(task);
    if(uploadResult.newlyImportedCount>0||!task.generation.prepared){
      const manifestPath=await syncMaterialManifestToSite({task,siteId:site.siteId,allFiles:allMaterialFiles,request});
      const manifestMarker=`kfile:${manifestPath}`;
      if(!task.message.includes(manifestMarker)){
        task.message+=(task.message?'\n':'')+`资料映射清单：${manifestMarker}；共 ${allMaterialFiles.length} 份资料。按需从清单定位文件，每次只返回必要摘要，禁止把全清单展开到聊天。`;
      }
      store.put(task);
    }
  }
  const materials=allMaterialFiles.map(file=>resolveTaskMaterialEntry(task,file));
  task.generation.prepared=true;store.put(task);
  if((!task.generation.deliveryId||task.generation.next)&&!task.generation.legacySubmitted&&(task.generation.deliveryState!=='completed'||task.generation.next)){
    if(!task.templateWorkflow)await ensureManifest(task,store,vault,directory,signal);
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
  const deliveries=new GenerationDeliveryStore(store);
  const session=await openSession(task,store,vault,directory,signal);
  const snapshot=async()=>{const state=await session.snapshot();deliveries.observe(state);return state;};
  try{
    // Each batch owns a durable delivery receipt. Only a matching terminal run
    // advances it; a restart must never replay an accepted, uncertain send.
    while(true){
    let state=await snapshot();
    const action=task.generation.next;
    const initial=!task.generation.deliveryId;
    if(initial&&task.generation.legacySubmitted&&!action)throw new Pending('旧任务已提交过原始委托，由 AI 核对交付并交接评测或明确继续，不能重发初始消息');
    if(initial||action?.action==='continue'||action?.action==='answer'){
      if(state.running)throw new Pending('原会话仍在执行，保留当前执行，稍后核对');
      if(state.pending&&action?.action!=='answer')throw new Pending('原会话存在待输入调用，需先回答后再发送修复批次：'+state.pending.name);
      if(state.canSend===false)throw new Pending('目标环境 Kooboo AI 模型尚未就绪或无可用模型（canSend=false），尚未发送委托；请检查目标环境 AI 配置后重试');
      if(action?.retryOf&&(!matchingGenerationOutcome(task,state)||task.generation.deliveryId!==action.retryOf.deliveryId||state.runId!==action.retryOf.runId||!['failed','interrupted'].includes(state.state)))throw new Pending('原失败执行的回执已变化，需重新查证后决定是否重试；尚未发送新消息');
      // Pixels are read from an isolated media library, never through bridge attachments.
      assertGenerationInput(undefined,undefined,action?.action==='answer'?action.answer:undefined);
      const manifest=task.requirementsId?new ManifestStore(store).get(task.requirementsId):undefined;
      const collectionGuidance=task.collectionVersionId?'\n本任务的A段已核验并冻结资料版本 '+task.collectionVersionId+'。使用资料映射清单按需读取原件、完整正文、数据分片和关系；批量落地当前范围，避免重新全站采集。动态记录保存可回读的 sourceUrl 或 oldUrl 完整来源 URL。SQLite 表 CollectionRecordBindings 用 id、requirementId、sourceUrl、targetKind（sqlite/content）、targetContainer（真实表名/Content容器）、targetId（真实记录主键）、identityKeyField（可空，默认id）声明每项页面或数据要求的规范记录；记录本身的sourceUrl/oldUrl必须匹配原URL。页面索引和业务记录可共存，不为凑数复制实体；每个冻结路径含分页都要明确映射。CollectionRelationBindings 用 id、sourcePath（完整原路径及查询参数）、tableName、parentField、childField、orderField、parentIdentityField、childIdentityField、sourcePathField 声明真实关系字段。父子引用字段从对应规范记录读取，默认identityKeyField/id；关系行须用sourcePathField区分分页与别名，不能把分类全部分页混成一页，顺序字段须为唯一数值。所有含详情成员的来源页均适用，不依赖pageType标签。CollectionAssetBindings 用 id、sourceUrl、materialPath（冻结state.localPath原值）、targetUrl（当前目标同域真实URL）记录已取得素材映射；同字节允许多个源URL共用文件，不能混淆源URL数与文件数。三张表仅声明现有实现，不提供或改写预期成员，不把目标总量反推来源。保留分类关系、成员顺序、分页、数字路径、.aspx与查询参数；元数据引号等原字符按HTML上下文转义，不能删字符。实际目标响应须承接原页标题、可见正文和链接，禁止以HTTP200、隐藏文本、记录数量或生成自述替代完整性。每批只返回完成对象、缺口与证据的短摘要。':'';
      if(task.requirementsId&&!manifest)throw new GenerationInputError('固定交付清单不存在，禁止发送不完整委托');
      const referenceImages=action?.action==='answer'?undefined:await prepareReferenceMedia(task,store,directory,{siteId:site.siteId,apiOrigin,token:environment.token!,request,input,includeBaseline:initial},signal);
      const templateExecutionGuidance=buildTemplateExecutionGuidance(task,input,site.siteId);
      const prepared=action?.action==='answer'?undefined:await prepareGenerationContext(task,store,request,site.siteId,{
        instructions:action?.action==='continue'&&action.message!==task.message
          ?task.message+'\n\n本轮已核对的跟进要求：\n'+action.message:task.message,
        guidance:adoptedGuidance(task,store,'generation',vault)+collectionGuidance+acceptedAssetGuidance,
        ...(templateExecutionGuidance?{templateExecutionGuidance}:{}),
        manifest,
        materials,
        ...(referenceImages?{referenceImages}:{}),
        ...(task.scenario==='site-template'?{sourceEvidence:task.templateWorkflow?templateGenerationSources(task,store,directory):generationSourceEvidence(manifest,store,directory)}:{}),
      },Boolean(vault.automation().learning?.use),{isInitialDelivery:initial});
      assertGenerationInput(prepared?.text,undefined,action?.action==='answer'?action.answer:undefined);
      if(prepared){store.event(task.id,`生成委托资料：${prepared.mode}；最终文本 ${Buffer.byteLength(prepared.text)} bytes，媒体库图片 ${referenceImages?.entries.length||0} 张；平台原件 ${prepared.packageId}`);}
      const id=randomUUID(),conversationId=task.generation.conversationId||state.conversationId;
      const payload:Parameters<typeof session.deliver>[0]={id,conversationId,...(action?.action==='answer'?{answer:action.answer,callId:action.callId}:{text:prepared!.text})};
      // Persist the real outgoing payload independently of mutable checkpoints and chat summaries.
      deliveries.archive({id,taskId:task.id,versionId:task.versionId,siteId:site.siteId,packageId:prepared?.packageId,
        kind:action?.action==='answer'?'answer':task.repairEvidence?'repair':action?.action==='continue'||!initial?'continue':'initial',
        createdAt:Date.now(),conversationId,previousRunId:action?.action==='answer'?task.generation.previousRunId:state.runId||undefined,
        state:'prepared',text:payload.text,answer:payload.answer,callId:payload.callId,textBytes:Buffer.byteLength(payload.text||''),images:[]});
      const priorGeneration=structuredClone(task.generation);
      if(action?.action!=='answer'){task.generation.previousRunId=state.runId||undefined;delete task.generation.repairBatch;}task.generation.deliveryId=id;task.generation.deliveryState='sending';delete task.generation.next;store.put(task);
      deliveries.sending(id);
      let receipt:Awaited<ReturnType<typeof session.deliver>>;
      try{receipt=await session.deliver(payload);}
      catch(error){
        if(isPreSendBridgeRejection(error)){
          const live=await snapshot().catch(()=>undefined);
          if(live&&live.taskId===task.id&&(!conversationId||live.conversationId===conversationId)&&live.delivery?.id!==id){
            const detail=error instanceof Error?error.message:String(error);
            store.db.transaction(()=>{task.generation=priorGeneration;store.put(task);deliveries.rejectPreSend(id,detail);});
            throw new Pending('Kooboo 会话发送前置检查未通过（'+detail+'），已确认未发出请求并保留待发送委托');
          }
        }
        throw error;
      }
      if(receipt?.state!=='accepted'||receipt.id!==id||conversationId&&receipt.conversationId!==conversationId)throw new Pending('委托是否被接受尚未确认，需要核对原会话；不会自动重复发送');
      deliveries.accept(id,receipt.conversationId);
      task.generation.deliveryState='accepted';task.generation.conversationId=receipt.conversationId;task.threadId=receipt.conversationId;task.error='';store.put(task);
      store.event(task.id,initial?'委托已接受，正在追踪 Kooboo 实际执行循环':'AI 跟进已提交到原站原会话');
    } else if(task.generation.deliveryState==='sending'){
      if(state.delivery?.id!==task.generation.deliveryId||state.delivery?.state!=='accepted')throw new Pending('上一次发送结果不确定，不能自动重发，请核对原会话');
      task.generation.deliveryState='accepted';store.put(task);
    }
    let idleSince=Date.now();
    while(true){
      signal.throwIfAborted();state=await snapshot();
      if(state.conversationId!==task.generation.conversationId)throw new Pending('原会话身份发生变化，停止自动操作并核对');
      if(state.pending)throw new Pending('Kooboo 正在等待输入或工具确认：'+state.pending.name);
      if(state.delivery&&state.delivery.id===task.generation.deliveryId&&state.delivery.error){if(isContextOverflow(state.delivery.error))throw new GenerationInputError(state.delivery.error+'；已停止原样重试');throw new Pending(state.delivery.error);}
      const matchingOutcome=matchingGenerationOutcome(task,state);
      if(!state.running&&state.state==='completed'&&matchingOutcome){
        task.generation.deliveryState='completed';task.generation.state='completed';store.put(task);store.event(task.id,'Kooboo 本轮执行循环已结束，正在核对站点是否可交接评测');break;
      }
      if(!state.running&&['failed','interrupted'].includes(state.state)&&matchingOutcome){
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
