import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { scenarios } from '../../shared/automation.js';
import { Conflict } from '../lib/store.js';
import { probeCodex } from './probe.js';

const url=z.union([z.literal(''),z.url().refine(v=>/^https?:/.test(v),'只支持 HTTP(S) 地址')]);
const uuid=z.string().uuid();
const file=z.object({id:uuid,name:z.string().min(1).max(300),type:z.string().max(200),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const resource=z.object({name:z.string().trim().min(1).max(200),scenario:z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]]),description:z.string().max(200000),contentUrl:url,referenceUrl:url,externalSource:z.string().max(200),externalId:z.string().max(200),files:z.array(file).max(1000)}).superRefine((r,ctx)=>{
  if(['migration','upgrade','site-template'].includes(r.scenario)&&!r.contentUrl)ctx.addIssue({code:'custom',message:'当前场景需要内容站 URL',path:['contentUrl']});
  if(r.scenario==='upgrade'&&!r.referenceUrl)ctx.addIssue({code:'custom',message:'升级场景需要独立参考站',path:['referenceUrl']});
  if(Boolean(r.externalId)!==Boolean(r.externalSource))ctx.addIssue({code:'custom',message:'外部来源与记录标识需要一起填写'});
});
export const ruleInput=z.object({name:z.string().trim().min(1).max(200),kind:z.enum(['site','app']),scenarios:z.array(z.enum(Object.keys(scenarios) as [keyof typeof scenarios,...(keyof typeof scenarios)[]])).min(1).max(5).optional(),sop:z.string().trim().min(1).max(100000),references:z.string().max(200000),criteria:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),label:z.string().trim().min(1).max(100),weight:z.number().min(0).max(100),instruction:z.string().trim().min(1).max(10000),required:z.boolean(),viewports:z.array(z.enum(['desktop','mobile','business'])).min(1).max(3).refine(v=>new Set(v).size===v.length),scopes:z.array(z.enum(['homepage','site'])).min(1).max(2).refine(v=>new Set(v).size===v.length)})).min(1).max(30)}).superRefine((r,ctx)=>{
  if(Math.abs(r.criteria.reduce((s,c)=>s+c.weight,0)-100)>0.00001)ctx.addIssue({code:'custom',message:'权重总和必须为 100%'});
  if(new Set(r.criteria.map(c=>c.id)).size!==r.criteria.length)ctx.addIssue({code:'custom',message:'指标 ID 不能重复'});
});
const prompt=z.string().min(1).max(30000);
const settingsInput=z.object({enabled:z.boolean(),autoEvaluate:z.boolean().default(true),generationConcurrency:z.number().int().min(1).max(10),evaluationConcurrency:z.number().int().min(1).max(5),timeoutMinutes:z.number().int().min(1).max(240),evaluationModel:z.string().trim().min(1).max(100),evaluationEndpoint:url,prompts:z.object({materials:prompt,migration:prompt,upgrade:prompt,'site-template':prompt,'app-template':prompt})});
const taskInput=z.object({resourceIds:z.array(uuid).min(1).max(1000).refine(ids=>new Set(ids).size===ids.length,'资源不能重复'),kind:z.enum(['generation','evaluation']),scope:z.enum(['homepage','site']),environmentId:z.string().max(100),generatedSiteId:uuid.optional(),requirements:z.string().max(100000).default(''),ruleId:uuid.optional(),parentId:uuid.optional()});
const params=z.object({id:uuid});

export function registerAutomationApi(app:FastifyInstance,store:AutomationStore,vault:Vault,directory:string,cancel:(id:string)=>void,owns:(id:string)=>boolean){
  let probing=false;
  const files=resolve(directory,'materials');mkdirSync(files,{recursive:true,mode:0o700});
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_files(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,json TEXT NOT NULL)');
  function checkFiles(items:z.infer<typeof file>[]){for(const item of items){const saved=store.db.prepare('SELECT json FROM auto_files WHERE id=?').get(item.id);if(!saved||JSON.stringify(JSON.parse(saved.json))!==JSON.stringify(item))throw new Conflict('附件不存在或元数据不一致，请重新上传');}}
  app.get('/api/automation/overview',async()=>({resources:store.resources(),sites:store.sites(),tasks:store.tasks(),settings:vault.automation()}));
  app.get('/api/automation/resources',async()=>({items:store.resources()}));
  app.get('/api/automation/resources/:id',async(request,reply)=>{const {id}=params.parse(request.params);const item=store.resource(id);return item?{resource:item,versions:store.versions(id),sites:store.sites(id),tasks:store.tasks().filter(t=>t.resourceId===id)}:reply.code(404).send({error:'资源不存在'});});
  app.post('/api/automation/resources',async(request,reply)=>{const input=resource.parse(request.body);checkFiles(input.files);return reply.code(201).send(store.saveResource(input));});
  app.put('/api/automation/resources/:id',async(request)=>{const {id}=params.parse(request.params);const {revision,...input}=z.object({revision:z.number().int().positive()}).passthrough().parse(request.body);const value=resource.parse(input);checkFiles(value.files);return store.saveResource(value,id,revision);});
  app.post('/api/automation/files',{bodyLimit:24*1024*1024},async(request,reply)=>{
    const input=z.object({name:z.string().min(1).max(300).refine(n=>!n.startsWith('/')&&!n.split(/[\\/]/).includes('..'),'文件名包含不合法路径'),type:z.string().max(200),content:z.string().max(23*1024*1024).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).parse(request.body);
    const content=Buffer.from(input.content,'base64');if(content.length>16*1024*1024)return reply.code(413).send({error:'单个附件最多 16 MB'});
    const item={id:randomUUID(),name:input.name,type:input.type,size:content.length,sha256:createHash('sha256').update(content).digest('hex')};
    writeFileSync(resolve(files,item.id),content,{mode:0o600,flag:'wx'});store.db.prepare('INSERT INTO auto_files VALUES(?,?)').run(item.id,JSON.stringify(item));return reply.code(201).send(item);
  });
  app.get('/api/automation/files/:id',async(request,reply)=>{const{id}=params.parse(request.params);const item=store.db.prepare('SELECT json FROM auto_files WHERE id=?').get(id);if(!item)return reply.code(404).send({error:'资料不存在'});reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(JSON.parse(item.json).name)}`).type('application/octet-stream');return readFileSync(resolve(files,id));});
  app.get('/api/automation/rules',async()=>({items:store.rules()}));
  app.post('/api/automation/rules',async(request,reply)=>reply.code(201).send(store.publish(ruleInput.parse(request.body))));
  app.get('/api/automation/settings',async()=>vault.automation());
  app.put('/api/automation/settings',async(request)=>vault.updateAutomation(settingsInput.parse(request.body)));
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
  app.get('/api/automation/tasks/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?{task,events:store.events(id),version:store.version(task.versionId),site:task.generatedSiteId?store.site(task.generatedSiteId):null}:reply.code(404).send({error:'任务不存在'});});
  app.post('/api/automation/tasks/:id/cancel',async(request)=>{
    const{id}=params.parse(request.params);const task=store.task(id);if(!task)throw new Conflict('任务不存在');
    if(['completed','failed','cancelled'].includes(task.status))throw new Conflict('任务已经结束');
    if(!task.stopped&&!owns(id))throw new Conflict('原执行状态未确认，请先检查并确认原执行已停止');
    task.status=task.stopped?'cancelled':'cancelling';store.put(task);store.event(id,task.stopped?'任务已取消':'已请求停止，确认执行端结束后释放名额');cancel(id);return task;
  });
  app.post('/api/automation/tasks/:id/confirm-stopped',async(request)=>{const{id}=params.parse(request.params);const task=store.task(id);if(!task||task.status!=='pending'||owns(id))throw new Conflict('只能确认服务中断且没有本机执行器运行的待跟进任务');task.stopped=true;store.put(task);store.event(id,'操作者已确认原执行停止，允许重新排队和跟进');return task;});
  app.post('/api/automation/tasks/:id/followup',async(request)=>{
    const{id}=params.parse(request.params);const input=z.object({requirements:z.string().trim().min(1).max(100000),kind:z.enum(['generation','evaluation']).optional()}).parse(request.body);const old=store.task(id);
    if(!old||!old.stopped||old.status==='queued')throw new Conflict('请先等待原任务确认停止');
    if(!old.generatedSiteId)throw new Conflict('尚未绑定生成站，请从资源详情新建任务或关联实际站点后再跟进');
    return {items:store.create({resourceIds:[old.resourceId],kind:input.kind||old.kind,scope:old.scope,environmentId:old.environmentId,generatedSiteId:old.generatedSiteId,requirements:input.requirements,parentId:id},vault.automation())};
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
    const q=z.object({status:z.enum(['queued','running','pending','cancelling','cancelled','completed','failed']).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    const tasks=store.tasks().filter(t=>!q.status||t.status===q.status);return {items:tasks.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:tasks.length,page:q.page,pageSize:q.pageSize};
  });
  app.get('/api/v1/automation/reports/:id',async(request,reply)=>{const{id}=params.parse(request.params);const task=store.task(id);return task?.kind==='evaluation'?{task,source:store.version(task.versionId),events:store.events(id)}:reply.code(404).send({error:'评测不存在'});});
  app.get('/api/v1/automation/reports/:id/artifacts/:file',async(request,reply)=>{
    const {id,file:name}=params.extend({file:z.string().regex(/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/)}).parse(request.params);
    const task=store.task(id);const artifact=task?.report?.artifacts.find(f=>f.name===name);if(!artifact)return reply.code(404).send({error:'证据不存在'});
    const bytes=readFileSync(resolve(directory,'automation-runs',id,'evidence',name));if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)return reply.code(409).send({error:'证据校验失败'});
    return reply.header('Content-Disposition',`attachment; filename="${name}"`).type(artifact.type).send(bytes);
  });
}
