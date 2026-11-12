import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { materialPath, uniqueMaterialPaths } from '../../shared/materials.js';
import { scenarios, defaultFollowupSettings, defaultOptimizationPolicy, supportsAutomaticOptimization } from '../../shared/automation.js';
import { stopOptimization } from './optimization.js';
import { Conflict } from '../lib/store.js';
import { queueDelivery, deliveryReceipt } from './delivery.js';
import { probeCodex } from './probe.js';
import { brief, compactNotice, taskExecuting, taskSummary, canAdjustTaskSiteNames } from '../../shared/task-presentation.js';
import { registerExecutionLogApi } from './execution-log.js';
import { completenessSettingsSchema } from './completeness.js';
import { registerLearningApi } from './learning-api.js';
import { learningSettingsSchema } from './experience-store.js';
import { executionTaskIds } from '../../shared/execution-log.js';
import { registerSiteDeliveryApi } from './site-delivery.js';
import { registerTimingApi } from './timing.js';
import { registerDashboardApi } from './dashboard.js';
import { registerMigrationApi } from './migration-api.js';
import { retainStoppedFollowupReservations, correctUnsentPlanningAttempts } from './budget-recovery.js';
import { trimTaskGenerationBrowserCache } from './generation-cache.js';
import { registerGenerationContextApi } from './generation-context-api.js';
import { registerCollectionApi } from './collection/api.js';
import { CollectionStore } from './collection/store.js';
import { ManifestStore, manifestInput } from './completeness.js';
import { preflightCollectionTarget } from './collection/target-verification.js';
import { registerResourceFolderApi } from './resource-folders.js';
import { registerDispositionApi } from './dispositions.js';
import { rootDomainSchema, siteNameSchema } from '../lib/validation.js';
import { clearSiteRetry } from './retry-guard.js';
import { registerSiteDomainApi } from './site-domains.js';
import { registerTaskNamingApi } from './site-naming-api.js';
import { taskSiteNaming } from './site-naming.js';

const url=z.union([z.literal(''),z.url().refine(v=>/^https?:/.test(v),'只支持 HTTP(S) 地址')]);
const uuid=z.string().uuid();
const logicalPath=z.string().min(1).max(300).refine(n=>{try{return materialPath(n)===n;}catch{return false;}},'附件路径不合法');
const file=z.object({id:uuid,name:logicalPath,type:z.string().max(200),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const resource=z.object({folderId:uuid.nullable().optional(),name:z.string().trim().min(1).max(200),scenario:z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]]),description:z.string().max(200000),contentUrl:url,referenceUrl:url,externalSource:z.string().max(200),externalId:z.string().max(200),files:z.array(file).max(1000),siteName:siteNameSchema.optional(),subDomain:siteNameSchema.optional(),rootDomain:rootDomainSchema.optional()}).superRefine((r,ctx)=>{
  if(['migration','upgrade','site-template'].includes(r.scenario)&&!r.contentUrl)ctx.addIssue({code:'custom',message:'当前场景需要内容站 URL',path:['contentUrl']});
  if(r.scenario==='upgrade'&&!r.referenceUrl)ctx.addIssue({code:'custom',message:'升级场景需要独立参考站',path:['referenceUrl']});
  try{uniqueMaterialPaths(r.files);}catch(error){ctx.addIssue({code:'custom',message:(error as Error).message,path:['files']});}
  if(Boolean(r.externalId)!==Boolean(r.externalSource))ctx.addIssue({code:'custom',message:'外部来源与记录标识需要一起填写'});
});
export const ruleInput=z.object({name:z.string().trim().min(1).max(200),kind:z.enum(['site','app']),scenarios:z.array(z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]])).min(1).max(5).optional(),sop:z.string().trim().min(1).max(100000),references:z.string().max(200000),criteria:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),label:z.string().trim().min(1).max(100),weight:z.number().min(0).max(100),instruction:z.string().trim().min(1).max(10000),required:z.boolean(),viewports:z.array(z.enum(['desktop','mobile','business'])).min(1).max(3).refine(v=>new Set(v).size===v.length),scopes:z.array(z.enum(['homepage','site'])).min(1).max(2).refine(v=>new Set(v).size===v.length)})).min(1).max(30)}).superRefine((r,ctx)=>{
  if(Math.abs(r.criteria.reduce((s,c)=>s+c.weight,0)-100)>0.00001)ctx.addIssue({code:'custom',message:'权重总和必须为 100%'});
  if(new Set(r.criteria.map(c=>c.id)).size!==r.criteria.length)ctx.addIssue({code:'custom',message:'指标 ID 不能重复'});
});
const prompt=z.string().min(1).max(30000);
const followupInput=z.object({enabled:z.boolean(),concurrency:z.number().int().min(1).max(3),maxAttempts:z.number().int().min(1).max(20),maxMinutes:z.number().int().min(1).max(120),maxTokens:z.number().int().min(1000).max(1000000000),maxRequests:z.number().int().min(1).max(1000).optional(),sop:z.string().trim().min(1).max(50000)});
const optimizationInput=z.object({targetScore:z.number().min(1).max(100),maxRounds:z.number().int().min(1).max(10),maxCostCny:z.number().positive().max(1000000).nullable()});
const settingsInput=z.object({showExecutionBrowser:z.boolean().optional(),completeness:completenessSettingsSchema.optional(),learning:learningSettingsSchema.optional(),optimization:optimizationInput.extend({sop:z.string().trim().min(1).max(50000)}).optional(),followup:followupInput.default(defaultFollowupSettings),enabled:z.boolean(),autoEvaluate:z.boolean().default(true),generationConcurrency:z.number().int().min(1).max(10),evaluationConcurrency:z.number().int().min(1).max(5),timeoutMinutes:z.number().int().min(1).max(240),evaluationModel:z.string().trim().min(1).max(100),evaluationEndpoint:url,prompts:z.object({materials:prompt,migration:prompt,upgrade:prompt,'site-template':prompt,'app-template':prompt})});
const taskInput=z.object({resourceIds:z.array(uuid).min(1).max(1000).refine(ids=>new Set(ids).size===ids.length,'资源不能重复'),kind:z.enum(['generation','evaluation']),scope:z.enum(['homepage','site']),environmentId:z.string().max(100),siteName:siteNameSchema.optional(),subDomain:siteNameSchema.optional(),rootDomain:rootDomainSchema.optional(),generatedSiteId:uuid.optional(),requirements:z.string().max(100000).default(''),ruleId:uuid.optional(),parentId:uuid.optional(),collectionSnapshotId:uuid.optional(),collectionManifestId:uuid.optional(),optimization:optimizationInput.partial({maxRounds:true,maxCostCny:true}).optional()}).superRefine((input,ctx)=>{
  if(input.rootDomain&&(input.kind!=='generation'||input.generatedSiteId))ctx.addIssue({code:'custom',message:'根域名仅用于新建生成站，已有站点沿用原域名',path:['rootDomain']});
  if((input.siteName||input.subDomain)&&(input.kind!=='generation'||input.generatedSiteId||input.resourceIds.length!==1))ctx.addIssue({code:'custom',message:'自定义站点名和子域名仅用于单资源新建生成站；批量任务请在各资源中分别指定',path:['subDomain']});
  if(input.collectionManifestId&&!input.collectionSnapshotId)ctx.addIssue({code:'custom',message:'选择来源清单必须同时指定冻结采集快照'});
  if(input.collectionSnapshotId&&(input.kind!=='generation'||input.scope!=='site'||input.resourceIds.length!==1||input.generatedSiteId||input.parentId))ctx.addIssue({code:'custom',message:'冻结快照复用仅支持单资源全站的新建生成任务，不可关联已有站点或父任务'});
});
const params=z.object({id:uuid});
const pageNumber=z.coerce.number().int().min(1).max(1000000),pageSizeNumber=z.coerce.number().int().min(1).max(100);
const pagination=z.object({page:pageNumber.default(1),pageSize:pageSizeNumber.default(20)});

export function registerAutomationApi(app:FastifyInstance,store:AutomationStore,vault:Vault,directory:string,cancel:(id:string)=>void,owns:(id:string)=>boolean){
  registerResourceFolderApi(app,store.resourceFolders);
  registerDispositionApi(app,store,()=>vault.get().threshold,cancel,owns);
  registerSiteDomainApi(app,store,vault,owns);
  registerTaskNamingApi(app,store,vault,owns);
  registerExecutionLogApi(app,store);
  registerLearningApi(app,store,vault,directory,owns);
  registerSiteDeliveryApi(app,store,()=>vault.get().threshold);
  registerTimingApi(app,store);
  registerDashboardApi(app,store);
  registerMigrationApi(app,store,vault,directory,owns);
  registerGenerationContextApi(app,store,vault,owns,directory);
  registerCollectionApi(app,store,directory,owns);
  let probing=false;
  const executionSettings=()=>({...vault.automation(),evaluationEndpoint:vault.automation().evaluationEndpoint||vault.get().model.endpoint});
  const files=resolve(directory,'materials');mkdirSync(files,{recursive:true,mode:0o700});
  store.db.exec(`CREATE TABLE IF NOT EXISTS auto_files(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS auto_files_content ON auto_files(json_extract(json,'$.name'),json_extract(json,'$.sha256'));`);
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,json TEXT NOT NULL)');
  function checkFiles(items:z.infer<typeof file>[]){for(const item of items){const saved=store.db.prepare('SELECT json FROM auto_files WHERE id=?').get(item.id);if(!saved||JSON.stringify(JSON.parse(saved.json))!==JSON.stringify(item))throw new Conflict('附件不存在或元数据不一致，请重新上传');}}
  function saveResource(input:z.infer<typeof resource>,id?:string,revision?:number){
    return store.db.transaction(()=>{
      const {folderId,...content}=input;
      const saved=store.saveResource(content,id,revision);
      if(folderId!==undefined)store.resourceFolders.move([saved.id],folderId);
      return store.resource(saved.id)!;
    });
  }
  app.get('/api/automation/overview',async(request)=>{
    const {view,statusOnly}=z.object({view:z.enum(['compact','status']).optional(),statusOnly:z.literal('1').optional()}).parse(request.query);
    const tasks=store.headers();
    const queue={generation:tasks.filter(t=>t.kind==='generation'&&taskExecuting(t)).length,evaluation:tasks.filter(t=>t.kind==='evaluation'&&taskExecuting(t)).length,queued:tasks.filter(t=>t.status==='queued').length};
    if(view==='status'||statusOnly==='1')return {queue,settings:vault.automation()};
    const byId=new Map(tasks.map(t=>[t.id,t]));
    const visible=tasks.filter(t=>!t.optimizationRootId||t.kind==='evaluation'&&byId.get(t.optimizationRootId)?.evaluationTaskId===t.id);
    return {resources:store.resources(),resourceFolders:store.resourceFolders.list(),sites:store.sites(),queue,tasks:view==='compact'?store.summaries(visible).map(value=>{if(value.kind==='evaluation'&&value.report)value.reportCurrent=Boolean(store.currentReportHeader(byId.get(value.id)!));return value;}):store.tasks(),settings:vault.automation()};
  });
  app.get('/api/automation/notifications',async(request)=>{
    const {view,page,pageSize}=z.object({view:z.enum(['compact']).optional(),page:pageNumber.optional(),pageSize:pageSizeNumber.optional()}).parse(request.query);
    if(page!==undefined||pageSize!==undefined){
      const result=store.noticePage(page??1,pageSize??10);
      return {...result,items:view==='compact'?result.items.map(n=>compactNotice(n,store.header(n.taskId)?.summary)):result.items};
    }
    return {items:view==='compact'?store.notices().map(n=>compactNotice(n,store.header(n.taskId)?.summary)):store.notices()};
  });
  app.post('/api/automation/notifications/:id/read',async(request,reply)=>{const{id}=params.parse(request.params);const notice=store.readNotice(id);return notice?{ok:true,readAt:notice.readAt}:reply.code(404).send({error:'通知不存在或已更新'});});
  app.post('/api/automation/notifications/read',async()=>({ok:true,readAt:store.readAllNotices()}));
  app.post('/api/automation/tasks/:id/resume',async(request)=>{
    const{id}=params.parse(request.params);
    return store.db.transaction(()=>{
      const task=store.task(id);
      if(!task||owns(id)||!task.stopped||!['pending','interrupted','failed','cancelled'].includes(task.status))throw new Conflict('只能恢复已确认停止的任务');
      if(store.dispositions.get('delivery',task.generatedSiteId||task.id))throw new Conflict('该任务或生成站已归档，请先移回在列后再恢复');
      const root=store.root(task);
      if(root?.optimization?.state==='completed')throw new Conflict('优化目标已达成');
      if(root?.optimization&&root.id!==task.id&&root.optimization.activeTaskId!==task.id)throw new Conflict('该任务已是历史优化轮次，请操作当前轮次');
      if(task.generatedSiteId&&(store.siteReserved(task)||store.headers(task.generatedSiteId).some(t=>t.id!==task.id&&(!t.stopped||owns(t.id)||t.delivery?.stopped===false))))throw new Conflict('同站仍有未停止的执行，请先等待结束后再恢复');
      if(task.kind==='evaluation'&&task.generatedSiteId&&task.siteRevision){
        const state=store.siteState(task.generatedSiteId);
        if(state&&state.revision!==task.siteRevision)throw new Conflict('目标站版本已变化，不能恢复旧版本的评测任务');
      }
      if(task.kind==='evaluation'&&task.scenario==='site-template'){
        const execution=store.evaluations.get(id);
        if(execution&&execution.state!=='stopped')throw new Conflict('原评测执行尚未确认停止，请核查后确认停止再恢复');
      }
      const wasCancelled=task.status==='cancelled';
      retainStoppedFollowupReservations(task,store,owns);
      if(task.autonomy){delete task.autonomy.stopReason;delete task.autonomy.checkpoint.nextAt;}
      const preCreateCollection=Boolean(task.autonomy&&!task.generatedSiteId&&task.collectionId);
      const neverStartedGeneration=wasCancelled&&task.kind==='generation'&&!task.followup&&!task.generatedSiteId&&!task.generation?.createAttempted&&!task.generation?.deliveryId&&!task.generation?.legacySubmitted;
      if(root?.optimization){
        const run=root.optimization;
        run.state=preCreateCollection||neverStartedGeneration?'waiting-evaluation':task.id===root.id?(run.reportId&&task.stage==='optimization'?'planning':'waiting-evaluation'):task.kind==='generation'?'repairing':'waiting-evaluation';
        run.reason='';run.nextSteps=[];delete run.stoppedAt;store.put(root,true);
        if(task.id===root.id)task.optimization=run;
      }
      if(preCreateCollection){task.status='queued';store.put(task);store.event(task.id,'按原输入和采集检查点恢复A段');return task;}
      if(neverStartedGeneration){
        task.status='queued';delete task.interruption;task.error='';
        store.put(task);store.event(id,'重新启动已取消的未建站任务，按原固定输入与规则排队执行。');return task;
      }
      // The user explicitly resumed a stopped evaluation. No AI decision is
      // needed to decide whether to retry, nor another spent followup window.
      if(task.kind==='evaluation'&&(task.scenario==='site-template'||wasCancelled&&!task.followup)){
        task.status='queued';delete task.interruption;task.error='';
        if(task.followup){task.followup.state='resolved';task.followup.executionStopped=true;}
        store.put(task);store.event(id,task.scenario==='site-template'?'按原输入、站点版本和已校验证据直接恢复独立评测；保留累计用量与跟进预算。':'重新启动已取消的独立评测任务，按原输入与站点版本排队执行。');return task;
      }
      if(task.scenario==='site-template'&&task.kind==='generation'&&task.generation?.next&&task.repairEvidence){
        task.status='queued';delete task.interruption;task.error='';
        if(task.followup)task.followup.state='resolved';
        store.put(task);store.event(id,'恢复已保存但尚未发出的修复委托；发送前重新校验图片批次与原会话状态。');return task;
      }
      correctUnsentPlanningAttempts(task,store,directory);
      // An explicit resume permits a fresh inspection after external conditions
      // change; a historical no-progress guard must not skip that inspection.
      clearSiteRetry(task,store);
      if(task.followup)task.followup.policy=structuredClone(root?.optimization?.recoveryPolicy||vault.automation().followup);
      store.scheduleFollowup(task,root?.optimization?.recoveryPolicy||vault.automation().followup);
      return task;
    });
  });
  app.get('/api/automation/resources',async()=>({items:store.resources()}));
  app.get('/api/automation/resources/:id',async(request,reply)=>{const {id}=params.parse(request.params);const item=store.resource(id);return item?{resource:item,versions:store.versions(id),sites:store.sites(id),tasks:store.tasks().filter(t=>t.resourceId===id)}:reply.code(404).send({error:'资源不存在'});});
  app.post('/api/automation/resources',{bodyLimit:4*1024*1024},async(request,reply)=>{const input=resource.parse(request.body);checkFiles(input.files);const key=request.headers['idempotency-key'];if(!key)return reply.code(201).send(saveResource(input));const id='resource:'+z.string().min(8).max(150).parse(key),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const result=store.db.transaction(()=>{const old=store.db.prepare('SELECT hash,json FROM auto_requests WHERE id=?').get(id);if(old){if(old.hash!==hash)throw new Conflict('同一个导入请求不能变更资料内容');return JSON.parse(old.json);}const value=saveResource(input);store.db.prepare('INSERT INTO auto_requests VALUES(?,?,?)').run(id,hash,JSON.stringify(value));return value;});return reply.code(201).send(result);});
  app.put('/api/automation/resources/:id',{bodyLimit:4*1024*1024},async(request)=>{const {id}=params.parse(request.params);const {revision,...input}=z.object({revision:z.number().int().positive()}).passthrough().parse(request.body);const value=resource.parse(input);checkFiles(value.files);return saveResource(value,id,revision);});
  app.post('/api/automation/files',{bodyLimit:24*1024*1024},async(request,reply)=>{
    const input=z.object({name:logicalPath,type:z.string().max(200),content:z.string().max(23*1024*1024).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).parse(request.body);
    const content=Buffer.from(input.content,'base64');if(content.length>16*1024*1024)return reply.code(413).send({error:'单个附件最多 16 MB'});
    const sha256=createHash('sha256').update(content).digest('hex');
    const candidates=store.db.prepare("SELECT json FROM auto_files WHERE json_extract(json,'$.name')=? AND json_extract(json,'$.sha256')=?").all(input.name,sha256);
    for(const row of candidates){const saved=JSON.parse(row.json);const path=resolve(files,saved.id);if(saved.type===input.type&&existsSync(path)&&createHash('sha256').update(readFileSync(path)).digest('hex')===sha256)return reply.code(201).send(saved);}
    const item={id:randomUUID(),name:input.name,type:input.type,size:content.length,sha256};
    writeFileSync(resolve(files,item.id),content,{mode:0o600,flag:'wx'});store.db.prepare('INSERT INTO auto_files VALUES(?,?)').run(item.id,JSON.stringify(item));return reply.code(201).send(item);
  });
  app.get('/api/automation/files/:id',async(request,reply)=>{const{id}=params.parse(request.params);const item=store.db.prepare('SELECT json FROM auto_files WHERE id=?').get(id);if(!item)return reply.code(404).send({error:'资料不存在'});reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(JSON.parse(item.json).name)}`).type('application/octet-stream');return readFileSync(resolve(files,id));});
  app.get('/api/automation/rules',async()=>({items:store.rules()}));
  app.post('/api/automation/rules',async(request,reply)=>reply.code(201).send(store.publish(ruleInput.parse(request.body))));
  app.get('/api/automation/settings',async()=>vault.automation());
  app.put('/api/automation/settings',async(request)=>vault.updateAutomation({...vault.automation(),...settingsInput.parse(request.body),learning:settingsInput.parse(request.body).learning||vault.automation().learning,completeness:settingsInput.parse(request.body).completeness||vault.automation().completeness}));
  app.get('/api/automation/prices',async()=>({items:store.usage.prices()}));
  app.post('/api/automation/prices',async(request,reply)=>{const rate=z.object({cached:z.number().min(0).max(100000),input:z.number().min(0).max(100000),output:z.number().min(0).max(100000)});const value=z.object({verifiedAt:z.number().int().positive(),effectiveFrom:z.number().int().min(Date.now()-60000).max(Date.now()+60000),source:url.refine(Boolean),currency:z.literal('CNY'),models:z.array(z.string().trim().min(1).max(200)).min(1).max(100),peak:rate,offpeak:rate,holidays:z.record(z.string().regex(/^20[0-9]{2}$/),z.array(z.string().regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/)).max(366))}).superRefine((v,ctx)=>{for(const[year,dates]of Object.entries(v.holidays))for(const date of dates)if(!date.startsWith(year)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)ctx.addIssue({code:'custom',message:'节假日日历含无效日期'});}).parse(request.body);return reply.code(201).send(store.usage.publish(value));});
  app.post('/api/automation/model/test',async(_request,reply)=>{
    if(probing)return reply.code(409).send({error:'已有 Codex 连接测试在执行'});
    probing=true;
    try{return await probeCodex(vault,directory);}
    catch(error){let detail=error instanceof Error?error.message:'Codex 测试失败';const key=vault.get().model.apiKey;if(key)detail=detail.replaceAll(key,'[已隐藏]');return reply.code(422).send({error:detail.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [已隐藏]').slice(0,2000)});}
    finally{probing=false;}
  });
  app.post('/api/automation/tasks',async(request,reply)=>{
    const input=taskInput.parse(request.body);
    if(input.kind==='generation'&&!input.generatedSiteId&&!vault.get().environments.some(e=>e.id===input.environmentId))throw new Conflict('请选择已保存的 Kooboo 环境');
    const key=z.string().min(8).max(150).parse(request.headers['idempotency-key']);
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result=store.db.transaction(()=>{
      const old=store.db.prepare('SELECT hash,json FROM auto_requests WHERE id=?').get(key);
      if(old){if(old.hash!==hash)throw new Conflict('同一个请求标识不能用于不同任务');return JSON.parse(old.json);}
      const collections=input.collectionSnapshotId?new CollectionStore(store,directory):undefined;
      const snapshot=collections?.reusableSnapshot(input.collectionSnapshotId!,input.resourceIds[0]);
      const manifests=snapshot?new ManifestStore(store):undefined;
      const sourceManifest=snapshot?manifests!.get(input.collectionManifestId||snapshot.manifestId):undefined;
      const baseline=snapshot?manifests!.get(snapshot.manifestId):undefined;
      if(snapshot){
        const owner=sourceManifest&&store.task(sourceManifest.taskId);
        if(!sourceManifest||!baseline||baseline.taskId!==snapshot.taskId||!owner||owner.resourceId!==input.resourceIds[0]||owner.versionId!==snapshot.inputVersionId||sourceManifest.id!==snapshot.manifestId&&(owner.collectionId!==snapshot.collectionId||owner.collectionVersionId!==snapshot.id))throw new Conflict('来源清单不属于所选冻结快照及固定输入');
      }
      // Resolve the default inside the idempotent transaction so retries keep the original choice.
      const defaultRootDomain=input.kind==='generation'&&!input.generatedSiteId
        ?vault.get().environments.find(e=>e.id===input.environmentId)?.defaultRootDomain||undefined:undefined;
      const value={items:store.create({...input,defaultRootDomain,...(snapshot?{versionId:snapshot.inputVersionId}:{})},executionSettings())};
      for(const task of value.items){
        if(snapshot&&sourceManifest&&baseline){
          task.collectionId=snapshot.collectionId;task.collectionVersionId=snapshot.id;task.requirementsEnabled=true;
          // Retain source evidence ownership. A new generation owns only its new manifest revision.
          const {sourceComplete,limitations,items,evidence,migration}=sourceManifest;
          const content=manifestInput.parse({sourceComplete,limitations,items,evidence,...(migration?{migration}:{})});
          const cloned={...content,id:randomUUID(),taskId:task.id,revision:Math.max(baseline.revision,sourceManifest.revision)+1,createdAt:Date.now(),actor:sourceManifest.actor,...(sourceManifest.sourceEvidence?{sourceEvidence:structuredClone(sourceManifest.sourceEvidence)}:{})};
          manifests!.store.db.prepare('INSERT INTO auto_requirement_manifests VALUES(?,?,?,?)').run(cloned.id,task.id,cloned.revision,JSON.stringify(cloned));
          task.requirementsId=cloned.id;store.put(task);
          const preflight=preflightCollectionTarget({task,manifest:cloned,store,directory});
          if(preflight.state==='blocked')throw new Conflict('冻结来源生成预检未通过：'+preflight.checks.filter(check=>check.failureClass==='contract-tool-defect').map(check=>check.reason).join('；').slice(0,1800));
          task.message+='\n\n复用固定采集快照 '+snapshot.id+'，沿用来源清单 '+sourceManifest.id+' 的完整范围；本任务独立创建新站，禁止重新全站采集。优先按 collection/site/ 与 collection/data/ 索引分批读取，禁止把全量正文或记录展开到聊天。';
          store.event(task.id,'已复用冻结来源快照及独立交付清单；生成前预检：'+preflight.state);
        }
        if(task.optimization)task.optimization.threshold=vault.get().threshold;
        store.put(task);
      }
      store.db.prepare('INSERT INTO auto_requests VALUES(?,?,?)').run(key,hash,JSON.stringify(value));return value;
    });return reply.code(201).send(result);
  });
  app.get('/api/automation/tasks/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?{task,usageEntries:store.usage.entries(id),childUsageEntries:task.evaluationTaskId?store.usage.entries(task.evaluationTaskId):[],events:store.events(id),version:store.version(task.versionId),site:task.generatedSiteId?store.site(task.generatedSiteId):null}:reply.code(404).send({error:'任务不存在'});});
  app.get('/api/automation/tasks/:id/summary',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.header(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    const evaluation=task.evaluationTaskId?store.header(task.evaluationTaskId):undefined;
    const latestId=task.optimization?.activeTaskId|| (task.status==='completed'&&evaluation?evaluation.id:id);
    const latest=store.db.prepare('SELECT seq,time,message FROM auto_events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(latestId);
    const active=task.optimization?.activeTaskId&&task.optimization.activeTaskId!==id?store.header(task.optimization.activeTaskId)||task:undefined;
    const summaries=new Map(store.summaries([...new Map([task,...(evaluation?[evaluation]:[]),...(active?[active]:[])].map(t=>[t.id,t])).values()]).map(t=>[t.id,t]));
    const disposition=store.dispositions.get('delivery',task.generatedSiteId||task.id),resourceDisposition=store.dispositions.get('resource',task.resourceId);
    return {task:summaries.get(task.id),evaluation:evaluation?summaries.get(evaluation.id):null,active:active?summaries.get(active.id):null,currentReportId:store.currentReportHeader(task)?.id||null,deliveryEnabled:Boolean((task.kind==='evaluation'||evaluation)&&vault.get().environments.find(e=>e.id===task.environmentId)?.delivery?.enabled||task.delivery||evaluation?.delivery),...(disposition?{disposition}:{}),...(resourceDisposition?{resourceDisposition}:{}),latest:latest?{...latest,message:brief(latest.message),taskId:latestId}:null};
  });
  app.get('/api/automation/tasks/:id/usage',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.task(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    const q=pagination.extend({stage:z.enum(['generation','repair','followup','evaluation','delivery','experience','planning']).optional()}).parse(request.query);
    const round=z.coerce.number().int().min(0).max(10).optional().parse((request.query as Record<string,unknown>).round);const selected=round===undefined?undefined:task.optimization?.rounds.find(r=>r.number===round);if(round!==undefined&&!selected)throw new Conflict('优化轮次不存在');const ids=selected?[selected.generationTaskId,...(selected.evaluationTaskId?[selected.evaluationTaskId]:[])]:store.workflowIds(task);return {...store.usage.page(ids[0],ids.slice(1),q.page,q.pageSize,q.stage),rounds:task.optimization?.rounds.map(r=>r.number)};
  });
  app.get('/api/automation/tasks/:id/sections/:section',async(request,reply)=>{
    const {id,section}=params.extend({section:z.enum(['execution','input','report','delivery'])}).parse(request.params),task=store.task(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    if(section==='input'){
      const version=store.version(task.versionId),site=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
      const roots=site?store.db.prepare("SELECT DISTINCT json_extract(json,'$.generation.rootDomain') AS root FROM auto_tasks WHERE site_key=? AND kind='generation' AND json_extract(json,'$.generation.rootDomain') IS NOT NULL").all(site.id).map(row=>String(row.root)):[];
      const defaultRoot=vault.get().environments.find(env=>env.id===task.environmentId)?.defaultRootDomain;
      if(defaultRoot)roots.push(defaultRoot);
      return {message:task.message,version,rule:task.rule,threadId:task.threadId,model:task.model,...taskSiteNaming(task,version,site,roots),optimization:task.optimization?{policy:task.optimization.policy}:undefined};
    }
    if(section==='execution'){
      const q=pagination.extend({taskId:uuid.optional()}).parse(request.query);if(q.taskId&&!executionTaskIds(task).includes(q.taskId))throw new Conflict('执行记录不属于本工作流');const selected=q.taskId?store.task(q.taskId)!:task;const total=Number(store.db.prepare('SELECT COUNT(*) AS total FROM auto_events WHERE task_id=?').get(selected.id).total),pages=Math.max(1,Math.ceil(total/q.pageSize)),page=Math.min(q.page,pages);
      const items=store.db.prepare('SELECT seq,time,message FROM auto_events WHERE task_id=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(selected.id,q.pageSize,(page-1)*q.pageSize);
      const canAdjustSiteNames=canAdjustTaskSiteNames(selected);
      const interruption=selected.interruption&&canAdjustSiteNames?{...selected.interruption,nextSteps:['点击“自动调整名称并继续”，检查可用的名称和子域名后恢复原任务。']}:selected.interruption;
      return {task:{id:selected.id,status:selected.status,stopped:selected.stopped,canAdjustSiteNames},context:selected.context,followup:selected.followup,interruption,error:selected.error,items,total,pages,page,pageSize:q.pageSize,related:task.optimization?store.workflowIds(task).map(taskId=>{const item=store.task(taskId)!;return {id:taskId,label:taskId===task.id?'总流程':(item.optimizationRound?'修复 '+item.optimizationRound:'初始')+' · '+(item.kind==='generation'?'生成':'评测')};}):undefined};
    }
    const source=task.kind==='evaluation'?task:task.evaluationTaskId?store.task(task.evaluationTaskId):undefined;
    if(section==='delivery')return {task:source?{id:source.id,kind:source.kind,environmentId:source.environmentId,status:source.status,delivery:source.delivery,report:source.report?{quality:source.report.quality}:null}:null};
    const round=z.coerce.number().int().min(0).max(10).optional().parse((request.query as Record<string,unknown>).round);const selected=round===undefined?undefined:task.optimization?.rounds.find(r=>r.number===round);if(round!==undefined&&!selected)throw new Conflict('优化轮次不存在');const current=selected?store.task(selected.evaluationTaskId||''):task.kind==='evaluation'?source:store.currentReport(task);return {taskId:current?.id||null,report:current?.report?{...current.report,...(current.report.completeness?{completeness:{...current.report.completeness,checks:[]}}:{})}:null,rule:task.rule||null,historical:round!==undefined,selectedRound:selected?{brief:selected.brief,progress:selected.progress}:undefined,optimization:task.optimization?{state:task.optimization.state,reason:task.optimization.reason,rounds:task.optimization.rounds.map(r=>{const evaluation=r.evaluationTaskId?store.task(r.evaluationTaskId):undefined;return {number:r.number,generationTaskId:r.generationTaskId,evaluationTaskId:r.evaluationTaskId,status:evaluation?.status||store.task(r.generationTaskId)?.status,scores:evaluation?.report?.scores||null,summary:brief(r.progress?.reason||evaluation?.report?.summary||'等待本轮独立复评')};})}:undefined};
  });
  app.post('/api/automation/tasks/:id/delivery',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task)throw new Conflict('任务不存在');if(store.dispositions.get('delivery',task.generatedSiteId||task.id))throw new Conflict('该生成站已归档，请先移回在列后再发起交付');return queueDelivery(task,store,vault);});
  app.post('/api/automation/tasks/:id/delivery/receipt',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task?.delivery||owns(id)||!['uncertain','failed'].includes(task.delivery.status))throw new Conflict('只能为已停止且待核查的交付补录回执');if(task.delivery.target)throw new Conflict('已有目标回执，请恢复核验；不能替换目标');task.delivery.target=deliveryReceipt(request.body);task.delivery.status='queued';task.delivery.attempts=0;task.delivery.nextAt=Date.now();task.delivery.error='';store.put(task);store.event(id,'操作者补录目标回执；仅核验目标环境，不重发迁移');return task;});
  app.post('/api/automation/tasks/:id/delivery/retry',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task?.delivery||owns(id)||task.delivery.target||task.delivery.status!=='failed'||task.delivery.attemptedAt)throw new Conflict('只有确认从未发出迁移请求的交付才可直接重试');task.delivery.status='queued';task.delivery.attempts=0;task.delivery.nextAt=Date.now();task.delivery.error='';store.put(task);store.event(id,'重新排队未发送过的迁移准备；保留源站与评测记录');return task;});
  app.post('/api/automation/tasks/:id/delivery/verify',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task?.delivery?.target||task.delivery.stopped===false||owns(id)||!['failed','completed'].includes(task.delivery.status))throw new Conflict('请先取得目标回执并等待本轮结束');task.delivery.status='queued';task.delivery.attempts=0;task.delivery.nextAt=Date.now();task.delivery.error='';store.put(task);store.event(id,'已安排恢复交付核验，保留原迁移目标');return task;});
  app.post('/api/automation/tasks/:id/delivery/confirm-stopped',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task?.delivery||owns(id)||task.delivery.stopped!==false||!['failed','uncertain'].includes(task.delivery.status))throw new Conflict('只能确认已中断且停止状态不明的交付');task.delivery.stopped=true;store.put(task);store.event(id,'操作者已确认原交付执行停止，可恢复原目标核验');return task;});
  app.post('/api/automation/tasks/:id/delivery/cancel',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task?.delivery||!['queued','running','verifying'].includes(task.delivery.status))throw new Conflict('当前没有可停止的交付');if(owns(id))cancel(id);else{task.delivery.status=task.delivery.attemptedAt&&!task.delivery.target?'uncertain':'failed';task.delivery.error='操作者已停止交付。源站及原报告保留。';store.put(task);}return task;});
  app.get('/api/v1/automation/reports/:id/delivery/artifacts/:file',async(request,reply)=>{const{id,file:name}=params.extend({file:z.string().regex(/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/)}).parse(request.params);const task=store.task(id),delivery=task?.delivery;const artifact=delivery?.artifacts?.find(f=>f.name===name);if(!artifact||!delivery)return reply.code(404).send({error:'交付证据不存在'});const bytes=readFileSync(resolve(directory,'automation-runs',id,'delivery',delivery.id,'evidence',name));if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw new Conflict('交付证据校验失败');return reply.type(artifact.type).send(bytes);});
  app.post('/api/automation/tasks/:id/cancel',async(request)=>{
    const{id}=params.parse(request.params);const task=store.task(id);if(!task)throw new Conflict('任务不存在');
    if(['completed','failed','cancelled','interrupted'].includes(task.status))throw new Conflict('任务已经结束');
    if(!task.stopped&&!owns(id))throw new Conflict('原执行状态未确认，请先检查并确认原执行已停止');
    task.status=task.stopped?'cancelled':'cancelling';store.put(task);store.event(id,task.stopped?'任务已取消':'已请求停止，确认执行端结束后释放名额');cancel(id);
    if(task.stopped&&task.kind==='generation')void trimTaskGenerationBrowserCache(directory,id);
    return task;
  });
  app.post('/api/automation/tasks/:id/optimization/stop',async(request)=>{
    const {id}=params.parse(request.params),root=store.task(id);if(!root?.optimization)throw new Conflict('任务未启用自动优化');
    const active=store.task(root.optimization.activeTaskId);
    if(active&&!active.stopped&&!owns(active.id))throw new Conflict('原执行状态未确认，请先检查并确认停止');
    if(active&&(!active.stopped||['queued','following-up'].includes(active.status))){active.status=active.stopped?'cancelled':'cancelling';store.put(active);cancel(active.id);if(active.stopped&&active.kind==='generation')void trimTaskGenerationBrowserCache(directory,active.id);}
    stopOptimization(root,store,'操作者停止了自动优化。',['查看当前版本状态与最后有效报告。']);return {ok:true};
  });
  app.post('/api/automation/tasks/:id/optimize',async(request)=>{
    const {id}=params.parse(request.params),task=store.task(id),policy=optimizationInput.parse(request.body);
    if(task&&store.dispositions.get('delivery',task.generatedSiteId||task.id))throw new Conflict('该生成站已归档，请先移回在列后再开启优化');
    if(task&&store.domainReserved(task.generatedSiteId))throw new Conflict('站点正在换绑域名，请稍后开启优化');
    if(!task||task.kind!=='generation'||!supportsAutomaticOptimization(task.scenario)||task.optimization||!task.stopped||task.status!=='completed'||!task.generation?.conversationId)throw new Conflict('只能为已完成且可继续原会话的 AI Site 模板、迁移与升级任务开启优化');
    const evaluation=store.currentReport(task);if(!evaluation?.report||!evaluation.rule||!evaluation.stopped||evaluation.status!=='completed')throw new Conflict('需要当前版本已完成且保留规则快照的独立评测报告');
    if(store.tasks().some(t=>t.id!==task.id&&t.generatedSiteId===task.generatedSiteId&&(!t.stopped||['queued','following-up'].includes(t.status))))throw new Conflict('请先等待该站点其他任务结束');
    store.db.transaction(()=>{
      evaluation.siteRevision ||= randomUUID();store.publishSiteReport(evaluation);store.put(evaluation);task.siteRevision=evaluation.siteRevision;
      task.rule=structuredClone(evaluation.rule);
      if(task.autonomy){task.autonomy.policy.hardMaxRounds=policy.maxRounds;if(policy.maxCostCny!==null)task.autonomy.policy.hardCostCny=policy.maxCostCny;}
      task.model=evaluation.model||{name:vault.automation().evaluationModel,endpoint:executionSettings().evaluationEndpoint};
      task.optimization={policy:{...(vault.automation().optimization||defaultOptimizationPolicy),...policy},state:'waiting-evaluation',rounds:[{number:0,revision:task.siteRevision,generationTaskId:task.id,evaluationTaskId:evaluation.id,startedAt:Date.now()}],activeTaskId:evaluation.id,currentRevision:task.siteRevision,reportId:evaluation.id,noImprovement:0,reason:'',nextSteps:[],recoveryPolicy:structuredClone(vault.automation().followup),threshold:vault.get().threshold};
      store.put(task);store.event(id,'操作者明确开启自动优化；原站、输入、规则与初评报告保留。');
    });return taskSummary(task);
  });
  app.post('/api/automation/tasks/:id/confirm-stopped',async(request)=>{
    const{id}=params.parse(request.params);const task=store.task(id);
    const queuedEvaluation=task?.kind==='evaluation'&&task.status==='following-up'&&task.followup?.state==='queued';
    if(!task||!['pending','interrupted'].includes(task.status)&&!queuedEvaluation||owns(id))throw new Conflict('只能确认服务中断且没有本机执行器运行的待跟进任务');
    if(task.kind==='evaluation')store.evaluations.confirmStopped(id);
    task.stopped=true;if(task.followup)task.followup.executionStopped=true;
    if(queuedEvaluation){task.status='interrupted';task.followup!.state='interrupted';}
    store.put(task);store.event(id,'操作者已确认原执行停止，允许重新排队和跟进');return task;
  });
  app.post('/api/automation/tasks/:id/reassess',async request=>{
    const {id}=params.parse(request.params);
    return store.db.transaction(()=>{
      const old=store.task(id),root=old&&store.root(old),run=root?.optimization,round=run?.rounds.at(-1);
      if(!old||old.kind!=='evaluation'||old.scenario!=='site-template'||old.status!=='completed'||!old.stopped||owns(id)||!old.report||!old.generatedSiteId||!root||!run||run.state!=='stopped'||!root.stopped||owns(root.id)||round?.evaluationTaskId!==id||old.siteRevision!==run.currentRevision)throw new Conflict('只能补评当前已停止优化流程的最新独立报告');
      if(store.headers().some(t=>t.generatedSiteId===old.generatedSiteId&&(!t.stopped||owns(t.id)||t.delivery?.stopped===false||['queued','following-up'].includes(t.status))))throw new Conflict('同站仍有活动执行，请等待停止后补评');
      const child=store.create({resourceIds:[old.resourceId],kind:'evaluation',scope:old.scope,environmentId:old.environmentId,generatedSiteId:old.generatedSiteId,versionId:old.versionId,parentId:old.id,ruleSnapshot:old.rule!,optimizationRootId:root.id,optimizationRound:round.number,requirements:'补齐原评测未验证的证据与评分，保持完整原范围和双端。复用经当前契约重新校验的检查点；不要修改目标站，不降低评分或完整性要求。按键操作使用 value 指定实际按键。'},executionSettings())[0];
      if(child.siteRevision!==run.currentRevision)throw new Conflict('目标站版本已变化，不能补评旧修订');
      child.model=old.model;store.put(child);
      const followup=root.followup;
      if(followup&&followup.tokens===0&&!store.usage.entries(root.id).some(e=>e.stage==='followup')){
        // Earlier versions counted host preflight failures as model attempts.
        // Correct only proven zero-request windows; never clear actual usage.
        store.event(root.id,`补评前纠正 ${followup.attempts} 次未发出模型请求的前置校验重试；历史事件保留，实际请求预算和用量不变。`);followup.attempts=0;
      }
      round.evaluationTaskId=child.id;root.evaluationTaskId=child.id;run.reportId=null;run.activeTaskId=child.id;run.state='waiting-evaluation';run.reason='';run.nextSteps=[];delete run.stoppedAt;
      root.status='completed';root.error='';delete root.interruption;if(followup)followup.state='resolved';store.put(root,true);
      store.event(root.id,`补评已排队：${child.id}；原报告 ${old.id} 完整保留。`);return child;
    });
  });
  app.post('/api/automation/tasks/:id/followup',async(request)=>{
    const{id}=params.parse(request.params);const input=z.object({requirements:z.string().trim().min(1).max(100000),kind:z.enum(['generation','evaluation']).optional()}).parse(request.body);const old=store.task(id);
    if(!old||!old.stopped||['queued','running','following-up','cancelling'].includes(old.status))throw new Conflict('请先等待原任务确认停止');
    if(!old.generatedSiteId)throw new Conflict('尚未绑定生成站，请从资源详情新建任务或关联实际站点后再跟进');
    return {items:store.create({resourceIds:[old.resourceId],kind:input.kind||old.kind,scope:old.scope,environmentId:old.environmentId,generatedSiteId:old.generatedSiteId,requirements:input.requirements,parentId:id,versionId:old.versionId,ruleSnapshot:old.rule||undefined},vault.automation())};
  });
  app.post('/api/automation/sites',async(request)=>{
    const input=z.object({resourceId:uuid,environmentId:uuid,siteId:uuid,name:z.string().min(1).max(200),url:z.url().refine(v=>/^https?:/.test(v))}).parse(request.body);
    if(!store.resource(input.resourceId)||!vault.get().environments.some(e=>e.id===input.environmentId))throw new Conflict('资源或环境不存在');
    const site={...input,id:randomUUID(),versionId:store.versions(input.resourceId)[0].id,createdAt:Date.now()};store.saveSite(site);return site;
  });
  app.post('/api/v1/resources/import',async(request)=>{
    const values=z.array(resource).min(1).max(1000).parse(request.body);values.forEach(v=>checkFiles(v.files));
    return store.db.transaction(()=>({items:values.map(v=>{const old=v.externalSource&&v.externalId?store.resources().find(r=>r.externalSource===v.externalSource&&r.externalId===v.externalId):undefined;return saveResource(v,old?.id,old?.revision);})}));
  });
  // Same persisted records are projected for local UI and external Admin consumers.
  app.get('/api/v1/automation/tasks/:id/result',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});
    const root=store.root(task)||task,current=store.currentReport(root),run=root.optimization;
    const finished=run?['completed','stopped'].includes(run.state):root.stopped&&root.status==='completed'&&(!root.evaluationTaskId||!!current&&current.status==='completed');
    const active=run?store.task(run.activeTaskId):undefined;const ready=finished&&!!current&&root.stopped&&(!active||active.stopped),source=store.version(root.versionId);
    return {taskId:root.id,generatedSiteId:root.generatedSiteId,siteUrl:root.siteUrl,revision:root.generatedSiteId?store.siteState(root.generatedSiteId)?.revision||root.siteRevision:null,externalSource:source?.externalSource||'',externalId:source?.externalId||'',ready,status:ready?'ready':finished?'unscored':'pending',reason:ready?(run?.reason||''):run?.reason||'当前版本尚未完成生成、修复或独立评测。',targetReached:run?run.state==='completed':null,reportId:ready?current!.id:null,report:ready?current!.report:null,evidenceBase:ready?`/api/v1/automation/reports/${current!.id}/artifacts/`:null};
  });
  app.get('/api/v1/automation/reports',async(request)=>{
    const q=z.object({externalSource:z.string().optional(),externalId:z.string().optional(),resourceId:uuid.optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    const items=store.tasks().filter(t=>t.kind==='evaluation').filter(t=>{const r=store.version(t.versionId);return (!q.externalSource||r?.externalSource===q.externalSource)&&(!q.externalId||r?.externalId===q.externalId)&&(!q.resourceId||t.resourceId===q.resourceId);});
    return {items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize};
  });
  app.get('/api/v1/automation/tasks',async(request)=>{
    const q=z.object({status:z.enum(['queued','running','pending','cancelling','cancelled','completed','failed','following-up','interrupted']).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    const tasks=store.tasks().filter(t=>!q.status||t.status===q.status);return {items:tasks.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:tasks.length,page:q.page,pageSize:q.pageSize};
  });
  app.get('/api/v1/automation/reports/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?.kind==='evaluation'?{task,usageEntries:store.usage.entries(id),workflow:(()=>{const root=store.root(task);if(root?.optimization)return {taskId:root.id,usage:root.usage,usageEntries:store.workflowIds(root).flatMap(taskId=>store.usage.entries(taskId))};return task.parentId&&store.task(task.parentId)?.evaluationTaskId===id?{taskId:task.parentId,usage:store.task(task.parentId)!.usage,usageEntries:[...store.usage.entries(task.parentId),...store.usage.entries(id)]}:null;})(),source:store.version(task.versionId),events:store.events(id)}:reply.code(404).send({error:'评测不存在'});});
  app.get('/api/v1/automation/reports/:id/artifacts/:file',async(request,reply)=>{
    const {id,file:name}=params.extend({file:z.string().regex(/^(?:(?:implementation|source-review)-)?[a-f0-9-]{36}\.[a-z0-9]{1,8}$/)}).parse(request.params);
    const {download}=z.object({download:z.literal('1').optional()}).parse(request.query);
    const task=store.task(id);const artifact=task?.report?.artifacts.find(f=>f.name===name);if(!artifact)return reply.code(404).send({error:'证据不存在'});
    const bytes=readFileSync(resolve(directory,'automation-runs',id,'evidence',name));if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)return reply.code(409).send({error:'证据校验失败'});
    const disposition=artifact.type==='image/png'&&!download?'inline':'attachment';
    return reply.header('Content-Disposition',`${disposition}; filename="${name}"`).type(artifact.type).send(bytes);
  });
}
