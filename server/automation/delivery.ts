import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { UnconfirmedStop } from './errors.js';
import { Conflict } from '../lib/store.js';
import { koobooClient, siteIdentity, probeSite, publicSiteUrl } from './kooboo.js';
import { evaluationBrowser } from './browser.js';
import { codexClient } from './evaluator.js';
import { usageCapture } from './usage-proxy.js';
import { builtInHarnessSop } from './harness.js';
import { exportRedactor } from '../diagnostics/redact.js';

const receiptSchema=z.object({siteId:z.guid(),siteUrl:z.url().refine(v=>{const u=new URL(v);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;})});
export function reportPassedDeliveryGate(task:AutomationTask,threshold:number):boolean{
  const report=task.report;
  if(!report)return false;
  if(report.quality==='passed')return true;
  if(report.quality==='failed')return false;
  if(task.templateWorkflow||report.review?.scopeComplete===false)return false;
  if((task.requirementsEnabled||report.completeness)&&(report.completeness?.state!=='complete'||report.completeness.sourceComplete===false))return false;
  if(report.migrationCheck&&report.migrationCheck.state!=='complete')return false;
  if((task.collectionVersionId||report.collectionTarget)&&(!report.collectionTarget||report.collectionTarget.state!=='complete'||!report.collectionTarget.checks.length||report.collectionTarget.checks.some(check=>check.status!=='verified')))return false;
  if(report.issues.some(issue=>issue.severity==='critical'||issue.severity==='major'))return false;
  const criteria=task.rule?.criteria.filter(c=>c.scopes.includes(task.scope))||[];
  if(!criteria.length)return false;
  if(report.assessments.some(a=>a.score===null))return false;
  const criteriaOk=criteria.every(criterion=>criterion.viewports.every(viewport=>{
    const assessment=report.assessments.find(a=>a.criterionId===criterion.id&&a.viewport===viewport);
    return Boolean(assessment&&assessment.score!==null&&(!criterion.required||assessment.passed===true));
  }));
  if(!criteriaOk)return false;
  const requiredViewports=[...new Set(criteria.flatMap(c=>c.viewports))];
  return report.scores.every(s=>typeof s.value==='number'&&s.value>=threshold)
    &&requiredViewports.every(viewport=>{
      const score=report.scores.find(s=>s.viewport===viewport)?.value;
      return typeof score==='number'&&score>=threshold;
    });
}
export function queueDelivery(task:AutomationTask,store:AutomationStore,vault:Vault){
  if(store.domainReserved(task.generatedSiteId))throw new Conflict('站点正在换绑域名，请稍后安排交付');
  if(task.kind!=='evaluation'||task.status!=='completed'||!task.stopped||!task.report)throw new Conflict('请先完成源站的独立评测');
  if(task.delivery)return task;
  const env=vault.get().environments.find(e=>e.id===task.environmentId),config=env?.delivery;
  if(!config?.enabled||!config.token)throw new Conflict('当前连接未启用交付，或缺少迁移令牌');
  const threshold=store.root(task)?.optimization?.threshold??vault.get().threshold;
  if(config.requirePassed&&!reportPassedDeliveryGate(task,threshold))throw new Conflict('当前交付策略要求源站评测通过');
  const site=task.generatedSiteId&&store.site(task.generatedSiteId);if(!site||!site.url)throw new Conflict('缺少生成站身份或地址');
  if(site.preferredDomain&&store.currentReport(task)?.id!==task.id)throw new Conflict('站点域名已变更，请先完成当前地址的独立评测再交付');
  const related=store.tasks().filter(t=>t.generatedSiteId===site.id);
  if(related.some(t=>!t.stopped||['queued','following-up'].includes(t.status)))throw new Conflict('同一个源站还有执行任务，请等待结束');
  if(related.some(t=>t.id!==task.id&&t.delivery))throw new Conflict('这个源站已有关联交付；请查看原交付记录，首版不重复迁移或覆盖目标站');
  const {token,targetEnvironmentId:_legacyTarget,...policy}=config;
  task.delivery={id:randomUUID(),policy,status:'queued',stopped:true,sourceEnvironmentId:task.environmentId,sourceSiteId:site.siteId,sourceUrl:site.url,evaluationTaskId:task.id,updatedAt:Date.now(),error:'',checks:[]};
  store.put(task);store.event(task.id,'已排队跨环境交付；源站和评测报告保留不变');return task;
}
export function deliveryReceipt(raw:unknown){return receiptSchema.parse(raw);}
export function expectedDeliveryPaths(task:AutomationTask,directory:string){
  const source=new URL(task.delivery!.sourceUrl);const paths=new Set<string>([source.pathname+source.search]);const origin=source.origin;
  for(const file of task.report?.artifacts||[]){if(file.type!=='application/json'||file.role!=='target')continue;
    try{const bytes=readFileSync(resolve(directory,'automation-runs',task.id,'evidence',file.name));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)continue;const data=JSON.parse(bytes.toString());const u=new URL(data.url);if(u.origin===origin)paths.add(u.pathname+u.search);}catch{}
  }
  return [...paths].slice(0,100);
}
const evidenceFileName=z.string().regex(/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/,'evidence 每项必须是单个裸文件名（例如 xxxx.png），禁止拼接多个文件名或附带说明');
const verificationOutputSchema=z.object({summary:z.string().min(1),verified:z.array(z.string()),unverified:z.array(z.string()),outOfScope:z.array(z.string()),evidence:z.array(z.string()).min(1)}).strict();
const verificationSchema=verificationOutputSchema.extend({evidence:z.array(evidenceFileName).min(1)}).strict();
export function parseDeliveryVerification(raw:unknown){return verificationSchema.parse(raw);}
export async function checkDeliveryAccess(task:AutomationTask,store:AutomationStore,directory:string,signal:AbortSignal){
  signal.throwIfAborted();
  const delivery=task.delivery!;if(!delivery.target)throw new Error('缺少目标交付回执，不能核验');
  delivery.target=deliveryReceipt(delivery.target);
  // The migration service owns the destination. Historical target connections are ignored.
  delivery.targetOrigin=new URL(delivery.target.siteUrl).origin;
  delivery.status='verifying';delivery.error='';store.put(task);
  const paths=expectedDeliveryPaths(task,directory);delivery.checks=[];
  for(const path of paths){const url=new URL(path,delivery.target.siteUrl).href;try{const result=await probeSite(url,signal);delivery.checks.push({...result,ok:true,detail:'HTTP 可访问；业务核验见下方 AI 证据'});}catch(error){delivery.checks.push({url,status:null,ok:false,detail:(error as Error).message});}store.put(task);}
  signal.throwIfAborted();
  return paths;
}
export async function verifyDelivery(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,dependencies:{openBrowser?:typeof evaluationBrowser;createClient?:typeof codexClient}={}){
  const paths=await checkDeliveryAccess(task,store,directory,signal);
  const delivery=task.delivery!;
  const work=resolve(directory,'automation-runs',task.id,'delivery',delivery.id);mkdirSync(resolve(work,'evidence'),{recursive:true,mode:0o700});
  const retained=(delivery.artifacts||[]).filter(f=>{try{return createHash('sha256').update(readFileSync(resolve(work,'evidence',f.name))).digest('hex')===f.sha256;}catch{return false;}});
  writeFileSync(resolve(work,'evidence-manifest.json'),JSON.stringify(retained),{mode:0o600});
  const browser=await (dependencies.openBrowser||evaluationBrowser)({target:delivery.target!.siteUrl,reference:delivery.sourceUrl,content:''},work,signal,retained,files=>{delivery.artifacts=files;writeFileSync(resolve(work,'evidence-manifest.json'),JSON.stringify(files),{mode:0o600});store.put(task);});
  let usage:Awaited<ReturnType<typeof usageCapture>>|undefined;
  try{
    const budgetPolicy={key:`delivery:${task.id}:${delivery.id}`,runKey:delivery.id,maxRequests:4,maxTokens:1_500_000,maxOutputTokens:16384};
    usage=await usageCapture(task.id,'delivery',store,vault,signal,budgetPolicy);

    const canCapture=typeof (browser as {capture?:unknown}).capture==='function';
    const existingObservations=()=>browser.artifacts.filter(f=>f.type==='application/json').flatMap(f=>{try{return [JSON.parse(readFileSync(resolve(work,'evidence',f.name),'utf8')) as {file?:string;url?:string;role?:string;viewport?:string}];}catch{return [];}});
    const capturedSet=new Map<string,{name:string;absPath:string;role:'target'|'reference';viewport:'desktop'|'mobile';url:string}>();
    if(canCapture){
      const finishCapture=store.timing.activity(task.id,'evidence');
      try{
        const okUrls=delivery.checks.filter(c=>c.ok).map(c=>c.url).slice(0,6);
        const targetUrls=okUrls.length?okUrls:[new URL(paths[0]||'/',delivery.target!.siteUrl).href];
        for(const targetUrl of targetUrls){
          const parsedTarget=new URL(targetUrl);
          const refUrl=new URL(parsedTarget.pathname+parsedTarget.search,delivery.sourceUrl).href;
          for(const viewport of ['desktop','mobile'] as const){
            for(const [role,url] of [['target',targetUrl],['reference',refUrl]] as const){
              signal.throwIfAborted();
              const obsList=existingObservations();
              const existingObs=obsList.find(o=>o.role===role&&o.viewport===viewport&&o.url===url&&o.file&&browser.artifacts.some(f=>f.name===o.file&&f.type==='image/png'));
              if(existingObs?.file){
                const absPath=resolve(work,'evidence',existingObs.file);
                if(existsSync(absPath))capturedSet.set(existingObs.file,{name:existingObs.file,absPath,role,viewport,url});
                continue;
              }
              const captured=await browser.capture({action:'screenshot',role,viewport,url}) as {file?:string;imagePath?:string;url?:string};
              if(captured?.file){
                const absPath=captured.imagePath||resolve(work,'evidence',captured.file);
                if(existsSync(absPath))capturedSet.set(captured.file,{name:captured.file,absPath,role,viewport,url:captured.url||url});
              }
            }
          }
        }
      }finally{finishCapture();}
    }
    const capturedImages=[...capturedSet.values()].slice(0,12);
    const sourceSummary=task.report?{
      quality:task.report.quality,
      scores:task.report.scores,
      summary:task.report.summary.slice(0,1200),
      issueTitles:task.report.issues.map(i=>`[${i.severity}] ${i.title}`).slice(0,20),
    }:null;
    writeFileSync(resolve(work,'task.json'),JSON.stringify(store.sanitize({scope:task.scope,sourceSummary,delivery,paths}),null,2),{mode:0o600});
    writeFileSync(resolve(work,'SKILL.md'),builtInHarnessSop('delivery.sop'),{mode:0o600});
    const client=(dependencies.createClient||codexClient)(vault,directory,{...browser.env,...usage.env});
    const options={model:vault.automation().evaluationModel,workingDirectory:work,skipGitRepoCheck:true,sandboxMode:'read-only' as const,networkAccessEnabled:false,approvalPolicy:'never' as const,webSearchMode:'disabled' as const};
    const thread=client.startThread(options);
    const outputSchema=z.toJSONSchema(verificationOutputSchema);
    const runTurn=async(promptText:string,attachImages:boolean)=>{
      const turnStartedAt=Date.now();
      const inputBlocks=attachImages&&capturedImages.length
        ?[{type:'text' as const,text:promptText},...capturedImages.map(img=>({type:'local_image' as const,path:img.absPath}))]
        :[{type:'text' as const,text:promptText}];
      const stream=await thread.runStreamed(inputBlocks,{signal,outputSchema});let final='';
      for await(const event of stream.events){signal.throwIfAborted();if(event.type==='thread.started'){delivery.verificationThreadId=event.thread_id;store.put(task);}else if(event.type==='turn.completed')usage!.fallback(event.usage as unknown as Record<string,unknown>,turnStartedAt);else if(event.type==='turn.failed')throw new Error(event.error.message);else if(event.type==='error')throw new Error(event.message);else if(event.type==='item.completed'&&event.item.type==='agent_message')final=event.item.text;}
      return final;
    };
    const validateVerification=(rawText:string)=>{
      const parsed=parseDeliveryVerification(JSON.parse(rawText));
      const files=browser.artifacts;
      if(parsed.evidence.some(name=>!files.some(f=>f.name===name)))throw new Error('交付核验引用了不存在的证据');
      for(const viewport of ['desktop','mobile'])for(const role of ['target','reference'])if(!files.some(f=>f.viewport===viewport&&f.role===role&&f.type==='image/png'&&parsed.evidence.includes(f.name)))throw new Error('交付核验缺少两端 PC / 移动端的截图证据');
      return {result:parsed,files};
    };
    const imageListText=capturedImages.length
      ?capturedImages.map(img=>`- ${img.name} (role=${img.role}, viewport=${img.viewport}, url=${img.url})`).join('\n')
      :'- （无预采集截图）';
    const checkSummaryText=delivery.checks.map(c=>`- ${c.url} -> status=${c.status??'null'} ok=${c.ok} (${c.detail})`).join('\n');
    const deliveryPrompt=[
      '你是独立跨环境交付核验 Checker，处于只读多模态评审模式。严禁运行任何 shell 命令、严禁探测文件或发起网络请求；所有内容必须使用简体中文输出。',
      '宿主已完成源站与目标站的可达性探测及双端截图预采集，并将截图作为 local_image 直接随本消息传入。请逐一对比目标站与源站双端视觉、导航、正文、图片及整体一致性。',
      '规则要求：',
      '1. 只核验迁移一致性，不重评源站原有轻微问题；不要把目标预览域自动注入的官方认领/推广浮层（如 launch.kooboo.nl/promo）判为迁移故障或写入 unverified。',
      '2. 正式域名、DNS、搜索引擎收录与未来权重、未要求的后台或无障碍审计等范围外事项写入 outOfScope，不要写入 unverified。',
      '3. evidence 数组每项必须严格选取下方本次预采集的单个裸文件名（uuid.png，禁止带 evidence/ 前缀或拼接），且必须覆盖 target 与 reference 在 desktop / mobile 下的截图（包括所有正常访问的目标路径）。',
      `任务范围：${task.scope} | 源站：${delivery.sourceUrl} | 目标站：${delivery.target!.siteUrl}`,
      `源站前置报告摘要：${sourceSummary?`quality=${sourceSummary.quality}, scores=${JSON.stringify(sourceSummary.scores)}, summary=${sourceSummary.summary}`:'无'}`,
      `HTTP 可达性核查：\n${checkSummaryText}`,
      `本轮已采集并传入的真实截图清单：\n${imageListText}`,
    ].join('\n\n');
    let validated:{result:ReturnType<typeof parseDeliveryVerification>;files:MaterialFile[]};
    const firstRaw=await runTurn(deliveryPrompt,true);
    try{
      validated=validateVerification(firstRaw);
    }catch(firstError){
      const errMsg=firstError instanceof Error?firstError.message:String(firstError);
      store.event(task.id,'交付核验输出修正 1/1：'+errMsg);
      const repairRaw=await runTurn(`上一次输出未通过校验：${errMsg}。\n请仅从下方本轮已采集清单中选择真实 PNG 裸文件名（每项一个 "uuid.png"，禁止拼接或加 evidence/ 前缀），并确保 evidence 同时覆盖 target 与 reference 的 desktop / mobile（含所有 ok 路径），用简体中文重新返回完整 JSON：\n${imageListText}`,false);
      validated=validateVerification(repairRaw);
    }
    const {result,files}=validated;
    for(const f of files)if(createHash('sha256').update(readFileSync(resolve(work,'evidence',f.name))).digest('hex')!==f.sha256)throw new Error('交付证据校验失败');
    const observations=files.filter(f=>f.type==='application/json'&&f.role==='target').flatMap(f=>{try{return [JSON.parse(readFileSync(resolve(work,'evidence',f.name),'utf8'))];}catch{return [];}});
    for(const check of delivery.checks.filter(c=>c.ok))for(const viewport of ['desktop','mobile'])if(!observations.some(o=>o.url===check.url&&o.viewport===viewport&&result.evidence.includes(o.file)))result.unverified.push(`${viewport} 尚缺少已评测路径的交付证据：${check.url}`);
    delivery.verification=result;delivery.artifacts=files;delivery.verifiedAt=Date.now();
    delivery.status=delivery.checks.every(c=>c.ok)&&!result.unverified.length&&!!result.verified.length?'completed':'failed';
    delivery.error=delivery.status==='failed'?'交付核验存在未通过或未验证项，请查看证据与明细。':'';
    writeFileSync(resolve(work,'verification.json'),JSON.stringify(result,null,2),{mode:0o600});
  }finally{await usage?.close();try{await browser.close();}catch{throw new UnconfirmedStop('交付核验浏览器停止状态未确认；请检查原执行后确认停止再恢复');}finally{store.put(task);}}
}
const TRACE_HEADER_NAMES = ['x-request-id', 'x-correlation-id', 'cf-ray', 'traceparent', 'x-trace-id', 'x-amzn-requestid'] as const;

function deliveryRedactor(vault: Vault, extraSecrets: string[] = []) {
  const config = vault.get();
  return exportRedactor([
    config.model.apiKey,
    config.updateSource?.token || '',
    vault.credentials.readToken,
    vault.credentials.ingestToken,
    ...config.environments.flatMap(env => [env.token, env.delivery?.token || '']),
    ...extraSecrets,
  ]);
}

function formatElapsedMs(elapsedMs: number): string {
  const ms = Math.max(0, Math.round(elapsedMs));
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function readBoundedBody(response: Response, maxBytes = 16384, timeoutMs = 5000): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        response.text(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('读取响应体超时')), timeoutMs);
          timer.unref();
        }),
      ]);
      const buf = Buffer.from(raw, 'utf8');
      if (buf.length > maxBytes) {
        return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, maxBytes)), truncated: true };
      }
      return { text: raw, truncated: false };
    } catch {
      return { text: '', truncated: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let truncated = false;
  let flushed = false;
  let timedOut = false;
  let text = '';
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  timer.unref();
  try {
    while (!timedOut) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: false });
          flushed = true;
        }
        total = maxBytes;
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
    if (!flushed) text += decoder.decode();
    if (timedOut && text) truncated = true;
    return { text, truncated };
  } catch {
    return { text: '', truncated: false };
  } finally {
    clearTimeout(timer);
  }
}

function extractTraceHeader(headers: Headers, redact: (value: string) => string): string | undefined {
  for (const name of TRACE_HEADER_NAMES) {
    const raw = headers.get(name);
    if (!raw) continue;
    const cleaned = redact(raw).replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    return `${name}=${cleaned.slice(0, 120)}`;
  }
  return undefined;
}

function summarizeErrorBody(raw: string, contentType: string, redactor: ReturnType<typeof exportRedactor>, maxChars: number): string {
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const trimmed = cleaned.trim();
  if (!trimmed) return '';
  let out = '';
  if (/^[\[{]/.test(trimmed)) {
    try {
      out = JSON.stringify(redactor.value(JSON.parse(trimmed)));
    } catch {
      out = redactor.text(cleaned).replace(/\s+/g, ' ');
    }
  } else if (contentType.toLowerCase().includes('html') || /^<(?:!doctype\s+html|html)\b/i.test(trimmed)) {
    const redactedHtml = redactor.text(cleaned);
    const titleMatch = redactedHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const bodyText = redactedHtml
      .replace(/<(script|style|title)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/<[^>]*$/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (title && bodyText) {
      out = bodyText.toLowerCase().startsWith(title.toLowerCase()) ? bodyText : `${title} | ${bodyText}`;
    } else {
      out = title || bodyText;
    }
  } else {
    out = redactor.text(cleaned).replace(/\s+/g, ' ');
  }
  const summary = out.trim();
  if (!summary) return '';
  if (summary.length <= maxChars) return summary;
  return summary.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

export function deliveryRequestUrl(endpoint: string, timeoutSeconds: number): string {
  const url = new URL(endpoint);
  const seconds = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? Math.trunc(timeoutSeconds) : 180;
  if (!url.searchParams.get('__engine_timeout__')?.trim()) {
    url.searchParams.set('__engine_timeout__', String(seconds));
  }
  return url.href;
}

export async function executeDelivery(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,verify=verifyDelivery){
  const delivery=task.delivery!;
  if(!delivery.target){
    if(delivery.attemptedAt)throw new Error('迁移发送结果不确定，禁止自动再次发送。请核查迁移服务 / 目标环境，取得 siteId 与 siteUrl 后补录回执。');
    const config=vault.get().environments.find(e=>e.id===delivery.sourceEnvironmentId)?.delivery;
    if(!config?.enabled||config.endpoint!==delivery.policy.endpoint||!config.token)throw new Error('原迁移配置不可用；请补齐同一连接的迁移令牌');
    const sourceClient=koobooClient({...task,environmentId:delivery.sourceEnvironmentId},vault,signal);
    const sourceList=await sourceClient.request('Site/List');const actualSource=(Array.isArray(sourceList)?sourceList:[]).find(s=>siteIdentity(s).toLowerCase()===delivery.sourceSiteId.toLowerCase());
    const sourceSite=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
    const sourceUrl=actualSource?await publicSiteUrl(sourceSite?.siteId.toLowerCase()===delivery.sourceSiteId.toLowerCase()?sourceSite:undefined,actualSource,sourceClient.request):undefined;
    if(typeof sourceUrl!=='string'||new URL(sourceUrl).origin!==new URL(delivery.sourceUrl).origin)throw new Error('源环境的站点身份 / 地址与评测记录不一致，禁止迁移；请核对生成站');
    const startedAt=Date.now();
    delivery.status='running';delivery.attemptedAt=startedAt;store.put(task);store.event(task.id,'正在迁移生成站至目标环境（不会删除源站）');
    const redactor=deliveryRedactor(vault,[config.token]);
    const timeoutSeconds=Number.isFinite(delivery.policy.timeoutSeconds)&&delivery.policy.timeoutSeconds>0?Math.trunc(delivery.policy.timeoutSeconds):180;
    const requestUrl=deliveryRequestUrl(delivery.policy.endpoint,timeoutSeconds);
    let eventDetail='';let errorSummary='';
    try{
      const response=await fetch(requestUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteUrl:new URL(delivery.sourceUrl).origin,token:config.token}),signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutSeconds*1000)]),redirect:'error'});
      const elapsed=formatElapsedMs(Date.now()-startedAt);
      const contentType=(response.headers.get('content-type')||'').split(';')[0]?.trim()||'';
      const traceHeader=extractTraceHeader(response.headers,redactor.text);
      if(!response.ok){
        const body=await readBoundedBody(response,16384,5000);
        const shortRaw=summarizeErrorBody(body.text,contentType,redactor,300);
        const fullRaw=summarizeErrorBody(body.text,contentType,redactor,2000);
        const shortBody=shortRaw&&body.truncated&&!shortRaw.endsWith('…')?shortRaw+'…':shortRaw;
        const fullBody=fullRaw&&body.truncated&&!fullRaw.endsWith('…')?fullRaw+'…':fullRaw;
        const parts=['耗时 '+elapsed,...(traceHeader?[traceHeader]:[]),shortBody?'响应：'+shortBody:'响应体为空'];
        errorSummary='迁移接口返回 HTTP '+response.status+'（'+parts.join('；')+'）';
        const eventParts=[`迁移接口返回 HTTP ${response.status}${response.statusText?' '+response.statusText:''}`,`耗时 ${elapsed}`,...(contentType?[`content-type=${contentType}`]:[]),...(traceHeader?[traceHeader]:[]),fullBody?`响应摘要：${fullBody}`:'响应体为空','已标记为不确定，禁止自动重发。'];
        eventDetail=eventParts.join('；');
        throw new Error(errorSummary);
      }
      const text=await response.text();
      if(text.length>100000){
        eventDetail=[`迁移回执超出读取限制（length=${text.length}）`,`耗时 ${elapsed}`,...(contentType?[`content-type=${contentType}`]:[]),...(traceHeader?[traceHeader]:[]),'已标记为不确定，禁止自动重发。'].join('；');
        throw new Error('迁移回执超出读取限制');
      }
      let target:ReturnType<typeof deliveryReceipt>;
      try{
        target=deliveryReceipt(JSON.parse(text));
      }catch(parseError){
        const bodySummary=summarizeErrorBody(text.slice(0,16384),contentType,redactor,500);
        const parseMessage=redactor.text(parseError instanceof Error?parseError.message:String(parseError));
        eventDetail=[`迁移回执解析或校验失败：${parseMessage}`,`耗时 ${elapsed}`,...(contentType?[`content-type=${contentType}`]:[]),...(traceHeader?[traceHeader]:[]),bodySummary?`响应摘要：${bodySummary}`:'响应体为空','已标记为不确定，禁止自动重发。'].join('；');
        throw parseError;
      }
      delivery.target=target;delivery.status='verifying';store.put(task);store.event(task.id,'目标站回执已保存；开始独立交付核验');
    }catch(error){
      const elapsed=formatElapsedMs(Date.now()-startedAt);
      const rawMessage=redactor.text(error instanceof Error?error.message:String(error));
      const headline=errorSummary?redactor.text(errorSummary):`${rawMessage}（耗时 ${elapsed}）`;
      delivery.status='uncertain';
      delivery.error=redactor.text(`${headline}；服务可能已经执行，禁止自动重发。请核查目标环境并补录回执。`);
      const finalEvent=redactor.text(eventDetail||`迁移请求异常：${rawMessage}；耗时 ${elapsed}；已标记为不确定，禁止自动重发。`);
      store.put(task);store.event(task.id,finalEvent);store.notice(task,'交付需要核查',delivery.error);return;
    }
  }
  await verify(task,store,vault,directory,signal);
}
