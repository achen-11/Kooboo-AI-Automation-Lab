import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { materialPath, uniqueMaterialPaths } from '../../shared/materials.js';
import { scenarios, defaultFollowupSettings } from '../../shared/automation.js';
import { Conflict } from '../lib/store.js';
import { queueDelivery, deliveryReceipt } from './delivery.js';
import { probeCodex } from './probe.js';
import { brief, compactNotice, taskSummary } from '../../shared/task-presentation.js';

const url=z.union([z.literal(''),z.url().refine(v=>/^https?:/.test(v),'只支持 HTTP(S) 地址')]);
const uuid=z.string().uuid();
const logicalPath=z.string().min(1).max(300).refine(n=>{try{return materialPath(n)===n;}catch{return false;}},'附件路径不合法');
const file=z.object({id:uuid,name:logicalPath,type:z.string().max(200),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const resource=z.object({name:z.string().trim().min(1).max(200),scenario:z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]]),description:z.string().max(200000),contentUrl:url,referenceUrl:url,externalSource:z.string().max(200),externalId:z.string().max(200),files:z.array(file).max(1000)}).superRefine((r,ctx)=>{
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
const followupInput=z.object({enabled:z.boolean(),concurrency:z.number().int().min(1).max(3),maxAttempts:z.number().int().min(1).max(20),maxMinutes:z.number().int().min(1).max(120),maxTokens:z.number().int().min(1000).max(2000000),sop:z.string().trim().min(1).max(50000)});
const settingsInput=z.object({followup:followupInput.default(defaultFollowupSettings),enabled:z.boolean(),autoEvaluate:z.boolean().default(true),generationConcurrency:z.number().int().min(1).max(10),evaluationConcurrency:z.number().int().min(1).max(5),timeoutMinutes:z.number().int().min(1).max(240),evaluationModel:z.string().trim().min(1).max(100),evaluationEndpoint:url,prompts:z.object({materials:prompt,migration:prompt,upgrade:prompt,'site-template':prompt,'app-template':prompt})});
const taskInput=z.object({resourceIds:z.array(uuid).min(1).max(1000).refine(ids=>new Set(ids).size===ids.length,'资源不能重复'),kind:z.enum(['generation','evaluation']),scope:z.enum(['homepage','site']),environmentId:z.string().max(100),generatedSiteId:uuid.optional(),requirements:z.string().max(100000).default(''),ruleId:uuid.optional(),parentId:uuid.optional()});
const params=z.object({id:uuid});

export function registerAutomationApi(app:FastifyInstance,store:AutomationStore,vault:Vault,directory:string,cancel:(id:string)=>void,owns:(id:string)=>boolean){
  let probing=false;
  const files=resolve(directory,'materials');mkdirSync(files,{recursive:true,mode:0o700});
  store.db.exec(`CREATE TABLE IF NOT EXISTS auto_files(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS auto_files_content ON auto_files(json_extract(json,'$.name'),json_extract(json,'$.sha256'));`);
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,json TEXT NOT NULL)');
  function checkFiles(items:z.infer<typeof file>[]){for(const item of items){const saved=store.db.prepare('SELECT json FROM auto_files WHERE id=?').get(item.id);if(!saved||JSON.stringify(JSON.parse(saved.json))!==JSON.stringify(item))throw new Conflict('附件不存在或元数据不一致，请重新上传');}}
  app.get('/api/automation/overview',async(request)=>{
    const {view}=z.object({view:z.enum(['compact']).optional()}).parse(request.query);
    return {resources:store.resources(),sites:store.sites(),tasks:view==='compact'?store.tasks().map(taskSummary):store.tasks(),settings:vault.automation()};
  });
  app.get('/api/automation/notifications',async(request)=>{
    const {view}=z.object({view:z.enum(['compact']).optional()}).parse(request.query);
    return {items:view==='compact'?store.notices().map(n=>compactNotice(n,store.task(n.taskId))):store.notices()};
  });
  app.post('/api/automation/notifications/:id/read',async(request)=>{const{id}=params.parse(request.params);store.readNotice(id);return {ok:true};});
  app.post('/api/automation/tasks/:id/resume',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task||owns(id)||!task.stopped||!['pending','interrupted','failed'].includes(task.status))throw new Conflict('只能恢复已确认停止的任务');store.scheduleFollowup(task,vault.automation().followup,true);return task;});
  app.get('/api/automation/resources',async()=>({items:store.resources()}));
  app.get('/api/automation/resources/:id',async(request,reply)=>{const {id}=params.parse(request.params);const item=store.resource(id);return item?{resource:item,versions:store.versions(id),sites:store.sites(id),tasks:store.tasks().filter(t=>t.resourceId===id)}:reply.code(404).send({error:'资源不存在'});});
  app.post('/api/automation/resources',{bodyLimit:4*1024*1024},async(request,reply)=>{const input=resource.parse(request.body);checkFiles(input.files);const key=request.headers['idempotency-key'];if(!key)return reply.code(201).send(store.saveResource(input));const id='resource:'+z.string().min(8).max(150).parse(key),hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');const result=store.db.transaction(()=>{const old=store.db.prepare('SELECT hash,json FROM auto_requests WHERE id=?').get(id);if(old){if(old.hash!==hash)throw new Conflict('同一个导入请求不能变更资料内容');return JSON.parse(old.json);}const value=store.saveResource(input);store.db.prepare('INSERT INTO auto_requests VALUES(?,?,?)').run(id,hash,JSON.stringify(value));return value;});return reply.code(201).send(result);});
  app.put('/api/automation/resources/:id',{bodyLimit:4*1024*1024},async(request)=>{const {id}=params.parse(request.params);const {revision,...input}=z.object({revision:z.number().int().positive()}).passthrough().parse(request.body);const value=resource.parse(input);checkFiles(value.files);return store.saveResource(value,id,revision);});
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
  app.put('/api/automation/settings',async(request)=>vault.updateAutomation(settingsInput.parse(request.body)));
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
      const value={items:store.create(input,vault.automation())};store.db.prepare('INSERT INTO auto_requests VALUES(?,?,?)').run(key,hash,JSON.stringify(value));return value;
    });return reply.code(201).send(result);
  });
  app.get('/api/automation/tasks/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?{task,usageEntries:store.usage.entries(id),childUsageEntries:task.evaluationTaskId?store.usage.entries(task.evaluationTaskId):[],events:store.events(id),version:store.version(task.versionId),site:task.generatedSiteId?store.site(task.generatedSiteId):null}:reply.code(404).send({error:'任务不存在'});});
  app.get('/api/automation/tasks/:id/summary',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.task(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    const evaluation=task.evaluationTaskId?store.task(task.evaluationTaskId):undefined;
    const latestId=task.status==='completed'&&evaluation?evaluation.id:id;
    const latest=store.db.prepare('SELECT seq,time,message FROM auto_events WHERE task_id=? ORDER BY seq DESC LIMIT 1').get(latestId);
    return {task:taskSummary(task),evaluation:evaluation?taskSummary(evaluation):null,deliveryEnabled:Boolean((task.kind==='evaluation'||evaluation)&&vault.get().environments.find(e=>e.id===task.environmentId)?.delivery?.enabled||task.delivery||evaluation?.delivery),latest:latest?{...latest,message:brief(latest.message),taskId:latestId}:null};
  });
  const pagination=z.object({page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)});
  app.get('/api/automation/tasks/:id/usage',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.task(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    const q=pagination.extend({stage:z.enum(['generation','followup','evaluation','delivery']).optional()}).parse(request.query);
    return store.usage.page(id,task.evaluationTaskId?[task.evaluationTaskId]:[],q.page,q.pageSize,q.stage);
  });
  app.get('/api/automation/tasks/:id/sections/:section',async(request,reply)=>{
    const {id,section}=params.extend({section:z.enum(['execution','input','report','delivery'])}).parse(request.params),task=store.task(id);
    if(!task)return reply.code(404).send({error:'任务不存在'});
    if(section==='input')return {message:task.message,version:store.version(task.versionId),rule:task.rule,threadId:task.threadId,model:task.model};
    if(section==='execution'){
      const q=pagination.parse(request.query),total=Number(store.db.prepare('SELECT COUNT(*) AS total FROM auto_events WHERE task_id=?').get(id).total),pages=Math.max(1,Math.ceil(total/q.pageSize)),page=Math.min(q.page,pages);
      const items=store.db.prepare('SELECT seq,time,message FROM auto_events WHERE task_id=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(id,q.pageSize,(page-1)*q.pageSize);
      return {context:task.context,followup:task.followup,interruption:task.interruption,error:task.error,items,total,pages,page,pageSize:q.pageSize};
    }
    const source=task.kind==='evaluation'?task:task.evaluationTaskId?store.task(task.evaluationTaskId):undefined;
    if(section==='delivery')return {task:source?{id:source.id,kind:source.kind,environmentId:source.environmentId,status:source.status,delivery:source.delivery,report:source.report?{quality:source.report.quality}:null}:null};
    return {taskId:source?.id||null,report:source?.report||null,rule:source?.rule||null};
  });
  app.post('/api/automation/tasks/:id/delivery',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task)throw new Conflict('任务不存在');return queueDelivery(task,store,vault);});
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
    task.status=task.stopped?'cancelled':'cancelling';store.put(task);store.event(id,task.stopped?'任务已取消':'已请求停止，确认执行端结束后释放名额');cancel(id);return task;
  });
  app.post('/api/automation/tasks/:id/confirm-stopped',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task||!['pending','interrupted'].includes(task.status)||owns(id))throw new Conflict('只能确认服务中断且没有本机执行器运行的待跟进任务');task.stopped=true;store.put(task);store.event(id,'操作者已确认原执行停止，允许重新排队和跟进');return task;});
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
    return store.db.transaction(()=>({items:values.map(v=>{const old=v.externalSource&&v.externalId?store.resources().find(r=>r.externalSource===v.externalSource&&r.externalId===v.externalId):undefined;return store.saveResource(v,old?.id,old?.revision);})}));
  });
  // Same persisted records are projected for local UI and external Admin consumers.
  app.get('/api/v1/automation/reports',async(request)=>{
    const q=z.object({externalSource:z.string().optional(),externalId:z.string().optional(),resourceId:uuid.optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    const items=store.tasks().filter(t=>t.kind==='evaluation').filter(t=>{const r=store.version(t.versionId);return (!q.externalSource||r?.externalSource===q.externalSource)&&(!q.externalId||r?.externalId===q.externalId)&&(!q.resourceId||t.resourceId===q.resourceId);});
    return {items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize};
  });
  app.get('/api/v1/automation/tasks',async(request)=>{
    const q=z.object({status:z.enum(['queued','running','pending','cancelling','cancelled','completed','failed','following-up','interrupted']).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    const tasks=store.tasks().filter(t=>!q.status||t.status===q.status);return {items:tasks.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:tasks.length,page:q.page,pageSize:q.pageSize};
  });
  app.get('/api/v1/automation/reports/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?.kind==='evaluation'?{task,usageEntries:store.usage.entries(id),workflow:task.parentId&&store.task(task.parentId)?.evaluationTaskId===id?{taskId:task.parentId,usage:store.task(task.parentId)!.usage,usageEntries:[...store.usage.entries(task.parentId),...store.usage.entries(id)]}:null,source:store.version(task.versionId),events:store.events(id)}:reply.code(404).send({error:'评测不存在'});});
  app.get('/api/v1/automation/reports/:id/artifacts/:file',async(request,reply)=>{
    const {id,file:name}=params.extend({file:z.string().regex(/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/)}).parse(request.params);
    const task=store.task(id);const artifact=task?.report?.artifacts.find(f=>f.name===name);if(!artifact)return reply.code(404).send({error:'证据不存在'});
    const bytes=readFileSync(resolve(directory,'automation-runs',id,'evidence',name));if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)return reply.code(409).send({error:'证据校验失败'});
    return reply.header('Content-Disposition',`attachment; filename="${name}"`).type(artifact.type).send(bytes);
  });
}
