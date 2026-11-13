import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import type { AutomationTask } from '../../shared/automation.js';
import { ExperienceStore, experienceInput } from './experience-store.js';
import { queueReflection } from './experience.js';
import { ManifestStore, manifestInput } from './completeness.js';
import { Conflict } from '../lib/store.js';
import { retainRequestReservation } from './request-budget.js';
import { assertWorkflowStopped, retainStoppedLearningReservations, retainWorkflowLearningReservations } from './budget-recovery.js';

const params=z.object({id:z.string().uuid()}),pagination=z.object({page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)});
export function registerLearningApi(app:FastifyInstance,store:AutomationStore,vault:Vault,directory:string,owns:(id:string)=>boolean,cancel:(id:string)=>void|Promise<void>=()=>{}){
  const experiences=new ExperienceStore(store),manifests=new ManifestStore(store);
  const budgetTaskIds=(task:AutomationTask)=>{
    const workflowId=experiences.workflow(task).id;
    return store.tasks().filter(candidate=>experiences.workflow(candidate).id===workflowId).map(candidate=>candidate.id);
  };
  app.get('/api/automation/experiences',async req=>{const q=pagination.extend({search:z.string().max(200).default(''),enabled:z.enum(['true','false']).optional(),scenario:experienceInput.shape.scenarios.element.optional(),stage:experienceInput.shape.stages.element.optional()}).parse(req.query);return experiences.page(q.page,q.pageSize,q.search,q.enabled===undefined?undefined:q.enabled==='true',q.scenario,q.stage);});
  app.get('/api/automation/experiences/:id',async(req,reply)=>{const{id}=params.parse(req.params),item=experiences.get(id);return item?{item}:reply.code(404).send({error:'经验不存在'});});
  app.get('/api/automation/experiences/:id/history',async req=>{const{id}=params.parse(req.params),q=pagination.parse(req.query);return experiences.history(id,q.page,q.pageSize);});
  app.post('/api/automation/experiences',async req=>{const{input,reason}=z.object({input:experienceInput,reason:z.string().min(1).max(4000)}).parse(req.body);return experiences.save(input,{actor:'human',reason});});
  app.put('/api/automation/experiences/:id',async req=>{const{id}=params.parse(req.params),body=z.object({input:experienceInput,revision:z.number().int().positive(),enabled:z.boolean(),reason:z.string().min(1).max(4000)}).parse(req.body);return experiences.save(body.input,{id,revision:body.revision,enabled:body.enabled,actor:'human',reason:body.reason});});
  app.post('/api/automation/experiences/:id/restore',async req=>{
    const{id}=params.parse(req.params),body=z.object({revision:z.number().int().positive(),from:z.number().int().positive(),reason:z.string().min(1).max(4000)}).parse(req.body),row=store.db.prepare('SELECT json FROM auto_experience_revisions WHERE id=? AND revision=?').get(id,body.from);if(!row)throw new Conflict('历史版本不存在');
    const old=JSON.parse(row.json).experience;return experiences.save({title:old.title,scenarios:old.scenarios,stages:old.stages,conditions:old.conditions,exclusions:old.exclusions,guidance:old.guidance},{id,revision:body.revision,actor:'human',enabled:experiences.get(id)?.enabled,reason:body.reason});
  });
  app.get('/api/automation/tasks/:id/learning',async(req,reply)=>{
    const{id}=params.parse(req.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});const q=pagination.extend({kind:z.enum(['selection','reflection']).optional()}).parse(req.query);
    // Task view includes its direct handoff and optimization children, with SQL pagination.
    const ids=store.workflowIds(task),where=`json_extract(json,'$.taskId') IN (${ids.map(()=>'?').join(',')})${q.kind?" AND json_extract(json,'$.kind')=?":''}`,args=[...ids,...(q.kind?[q.kind]:[])],total=Number(store.db.prepare('SELECT COUNT(*) n FROM auto_learning_runs WHERE '+where).get(...args).n),pages=Math.max(1,Math.ceil(total/q.pageSize)),page=Math.min(q.page,pages);
    return {page,pages,total,items:store.db.prepare('SELECT json FROM auto_learning_runs WHERE '+where+' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...args,q.pageSize,(page-1)*q.pageSize).map(r=>JSON.parse(r.json))};
  });
  app.post('/api/automation/tasks/:id/reflect',async req=>{const{id}=params.parse(req.params),task=store.task(id);if(!task||!task.stopped||owns(id))throw new Conflict('请等待任务停止后复盘');const source=task.report?task:store.currentReport(task)||task;if(!source.report&&!source.interruption)throw new Conflict('没有可复盘的新报告或明确中断证据');const run=queueReflection(source,store,true)!;if(!source.learningPolicy&&run.status==='queued'){run.policy=structuredClone(vault.automation().learning!);experiences.put(run);}return {run,enabled:vault.automation().enabled,queued:run.status==='queued'||run.status==='running'};});
  app.post('/api/automation/learning/:id/cancel',async req=>{
    const{id}=params.parse(req.params),run=experiences.run(id);
    if(!run)throw new Conflict('经验学习记录不存在');
    const wasOwned=owns(id);
    if(!['queued','running'].includes(run.status)&&!wasOwned)return {run,alreadyStopped:true};
    const wasQueued=run.status==='queued'&&!wasOwned;
    if(wasOwned)await Promise.resolve(cancel(id));
    return store.db.transaction(()=>{
      const current=experiences.run(id);if(!current)throw new Conflict('经验学习记录不存在');
      let alreadyStopped=false;
      if(['queued','running'].includes(current.status)||(wasOwned&&current.status!=='completed')){
        current.status='failed';
        current.reason=wasQueued?'操作者已取消排队的经验学习':'操作者已强制中断执行中的经验学习';
        experiences.put(current);store.event(current.taskId,current.reason);
      }else alreadyStopped=true;
      const otherRunning=store.db.prepare("SELECT id FROM auto_learning_runs WHERE json_extract(json,'$.workflowId')=? AND status='running'").all(current.workflowId).some(r=>String(r.id)!==current.id);
      if(!otherRunning&&!owns(id))retainWorkflowLearningReservations(current.workflowId,current.taskId,store,'中断经验学习');
      return {run:experiences.run(id)!,alreadyStopped};
    });
  });
  app.post('/api/automation/learning/:id/retry',async req=>{
    const{id}=params.parse(req.params),run=experiences.run(id);
    if(!run||run.kind!=='reflection'||run.status!=='failed'||owns(id))throw new Conflict('只能恢复已停止的经验复盘');
    const {useCurrentPolicy}=z.object({useCurrentPolicy:z.boolean().default(false)}).parse(req.body||{});
    return store.db.transaction(()=>{
      const retained=retainStoppedLearningReservations(run,store,owns);
      if(useCurrentPolicy)run.policy=structuredClone(vault.automation().learning!);
      run.status='queued';run.reason='人工恢复原复盘，沿用已有版本、请求记录与累计预算';
      experiences.put(run);store.event(run.taskId,run.reason);
      return {run,enabled:vault.automation().enabled,retained};
    });
  });
  app.get('/api/automation/tasks/:id/manifest',async(req,reply)=>{const{id}=params.parse(req.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});return {manifest:manifests.get(task.requirementsId)||null,editable:task.stopped&&!owns(id)&&!task.report&&(task.status==='queued'||task.status==='interrupted')&&!task.generation?.deliveryId};});
  app.get('/api/automation/tasks/:id/manifest/items',async(req,reply)=>{
    const{id}=params.parse(req.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});const q=pagination.parse(req.query),manifest=manifests.get(task.requirementsId),total=manifest?.items.length||0,pages=Math.max(1,Math.ceil(total/q.pageSize)),page=Math.min(q.page,pages);
    return {manifest:manifest?{...manifest,items:undefined}:null,items:manifest?.items.slice((page-1)*q.pageSize,page*q.pageSize)||[],page,pages,total,editable:task.stopped&&!owns(id)&&!task.report&&['queued','interrupted'].includes(task.status)&&!task.generation?.deliveryId};
  });
  app.put('/api/automation/tasks/:id/manifest/items/:itemId',async req=>{
    const{id,itemId}=params.extend({itemId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}).parse(req.params),task=store.task(id),body=z.object({expectedId:z.string(),input:manifestInput.shape.items.element,reason:z.string().min(1).max(4000)}).parse(req.body);
    if(!task||!task.stopped||owns(id)||task.report||!['queued','interrupted'].includes(task.status)||task.generation?.deliveryId)throw new Conflict('只能修改尚未委托的停止任务清单');if(body.input.id!==itemId)throw new Conflict('条目标识不匹配');
    const old=manifests.get(task.requirementsId),items=old?.items||[],input={sourceComplete:old?.sourceComplete||false,limitations:old?.limitations||['人工清单，来源完整覆盖尚待独立核对'],evidence:old?.evidence||[],items:items.some(i=>i.id===itemId)?items.map(i=>i.id===itemId?body.input:i):[...items,body.input]};
    const manifest=manifests.save(task,input,'human',body.expectedId);store.event(id,'人工调整交付清单：'+body.reason);return {manifest};
  });
  app.get('/api/automation/tasks/:id/completeness',async(req,reply)=>{
    const{id}=params.parse(req.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});const q=pagination.parse(req.query),source=task.report?task:store.currentReport(task),report=source?.report?.completeness,manifest=manifests.get(report?.manifestId),total=report?.checks.length||0,pages=Math.max(1,Math.ceil(total/q.pageSize)),page=Math.min(q.page,pages);
    return {taskId:source?.id,report:report?{...report,checks:undefined}:null,limitations:manifest?.limitations||[],items:report?.checks.slice((page-1)*q.pageSize,page*q.pageSize).map(c=>({...c,requirement:manifest?.items.find(i=>i.id===c.id)}))||[],page,pages,total};
  });
  app.put('/api/automation/tasks/:id/manifest',async req=>{
    const{id}=params.parse(req.params),task=store.task(id),body=z.object({expectedId:z.string(),input:manifestInput}).parse(req.body);
    if(!task||!task.stopped||owns(id)||task.report||!['queued','interrupted'].includes(task.status)||task.generation?.deliveryId)throw new Conflict('清单仅可在尚未委托生成或评测的停止状态编辑；历史报告快照不可覆盖');
    return {manifest:manifests.save(task,body.input,'human',body.expectedId)};
  });
  app.get('/api/automation/tasks/:id/manifest/evidence/:name',async(req,reply)=>{
    const{id,name}=params.extend({name:z.string().regex(/^source-(?:review-)?[a-f0-9-]+\.json$/)}).parse(req.params),task=store.task(id),manifest=manifests.get(task?.requirementsId);
    if(!manifest?.evidence.includes(name))return reply.code(404).send({error:'来源证据不存在'});
    const source=manifest.sourceEvidence?.find(f=>f.name===name);if(!source)return reply.code(404).send({error:'来源证据缺少校验记录'});const file=resolve(directory,'manifest-runs',source.taskId,'evidence',name);if(!existsSync(file))return reply.code(404).send({error:'来源证据文件缺失'});const bytes=readFileSync(file);if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new Conflict('来源证据校验失败');return reply.type('application/json').send(bytes);
  });
  app.get('/api/automation/tasks/:id/budget',async(req,reply)=>{const{id}=params.parse(req.params),task=store.task(id);if(!task)return reply.code(404).send({error:'任务不存在'});const table=store.db.prepare("SELECT name FROM sqlite_master WHERE name='auto_model_requests'").get();if(!table)return {items:[]};const ids=budgetTaskIds(task);return {items:store.db.prepare(`SELECT r.id,r.account_id AS accountId,r.state,r.charged,u.task_id AS taskId,json_extract(u.json,'$.note') AS reason FROM auto_model_requests r JOIN auto_usage u ON u.event_id=r.id AND u.source='codex' WHERE u.task_id IN (${ids.map(()=>'?').join(',')}) AND r.state IN ('active','unknown') ORDER BY r.rowid DESC LIMIT 100`).all(...ids)};});
  app.post('/api/automation/tasks/:id/budget/acknowledge',async req=>{
    const{id}=params.parse(req.params),task=store.task(id),body=z.object({requestId:z.string().uuid(),reason:z.string().trim().min(1).max(4000)}).parse(req.body);
    if(!task||!task.stopped||owns(id))throw new Conflict('先停止相关任务再核查用量');
    const row=store.db.prepare("SELECT r.*,u.task_id AS taskId FROM auto_model_requests r JOIN auto_usage u ON u.event_id=r.id AND u.source='codex' WHERE r.id=?").get(body.requestId);
    if(!row||!budgetTaskIds(task).includes(row.taskId))throw new Conflict('预算记录不属于当前工作流');
    assertWorkflowStopped(task,store,owns);
    retainRequestReservation(store.db,body.requestId);store.event(task.id,`人工确认保留未知用量预占 ${row.charged} token（不清零、不当作已知实际费用）：${body.reason}`);return {ok:true,retainedTokens:row.charged};
  });
}
