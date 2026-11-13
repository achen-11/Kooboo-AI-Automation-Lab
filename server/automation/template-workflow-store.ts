import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AutomationTask } from '../../shared/automation.js';
import type { TemplateBaseline, TemplateChecklist, TemplateEvaluation, TemplateEvidence, TemplateWorkflowResponse } from '../../shared/template-workflow.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';
import { designerTemplateChecks } from '../../shared/template-design.js';

export const checklistInput = z.object({
  name: z.string().trim().min(1).max(200),
  checks: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), title: z.string().trim().min(1).max(200), enabled: z.boolean(),
    kind: z.enum(['presence','order','gutter','relation','line-count','spacing','visual','interaction']),
    executor: z.enum(['script','ai','hybrid']), instruction: z.string().trim().min(1).max(8000),
    scopes: z.array(z.enum(['homepage','site'])).min(1).max(2), viewports: z.array(z.enum(['desktop','mobile'])).min(1).max(2),
    required: z.boolean(), severity: z.enum(['critical','major','minor']), weight: z.number().finite().min(0).max(100),
    tolerancePx: z.number().finite().min(0).max(1000), exceptions: z.string().max(4000),
  }).strict()).min(1).max(100),
}).strict().superRefine((v,c)=>{
  if(new Set(v.checks.map(check=>check.id)).size!==v.checks.length)c.addIssue({code:'custom',message:'检查项 ID 不能重复'});
  if(!v.checks.some(check=>check.enabled))c.addIssue({code:'custom',message:'至少启用一个检查项'});
  for(const check of v.checks)if(new Set(check.scopes).size!==check.scopes.length||new Set(check.viewports).size!==check.viewports.length)c.addIssue({code:'custom',message:'适用范围与视口不能重复'});
});
const initial = checklistInput.parse({name:'AI Site 区块与设计规范 v2',checks:[
  ['view-presence','区块组成','presence','hybrid','按语义对应区块，必需区块缺失失败；匹配不确定保留未验证。'],
  ['view-order','区块顺序','order','script','比较已可靠匹配区块的可见顺序。'],
  ['content-gutter','正文留白','gutter','hybrid','比较正文边界；满宽背景、图片与横向轮播须声明例外。'],
  ['layout-relation','布局关系','relation','hybrid','比较文本组、控件等锚点的排列和对齐，分别检查双端。'],
  ['text-lines','文本换行','line-count','hybrid','仅内容与宽度条件允许时约束文本行数，合理文案替换不能机械判错。'],
  ['section-spacing','区块间距','spacing','hybrid','比较区块与相邻内容的间距，保留响应式例外。'],
  ['visual-review','视觉与清单外问题','visual','ai','实际查看对应区域，核对构图、层级、比例及清单未预见的明显问题。'],
  ['interaction-review','交互状态','interaction','ai','实际执行已声明安全可逆交互，缺少操作和前后证据时未验证。'],
].map(([id,title,kind,executor,instruction])=>({id,title,kind,executor,instruction,enabled:true,scopes:['homepage','site'],viewports:['desktop','mobile'],required:true,severity:'major',weight:1,tolerancePx:8,exceptions:''})).concat(designerTemplateChecks)});

export interface TemplateWorkflowRecord {
  rootTaskId: string; inputVersionId: string; checklistId: string;
  baseline: TemplateBaseline | null; analysisThreadId?: string;
  sourceEvidence: TemplateEvidence[]; sourceCaptures: Record<string,{files:string[];complete:boolean;gaps:string[]}>;
  limitations: string[];
}
export const templateHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TemplateWorkflowStore {
  constructor(readonly store: AutomationStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS auto_template_checklists(id TEXT PRIMARY KEY,revision INTEGER UNIQUE NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_template_workflows(root_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_template_evaluations(task_id TEXT PRIMARY KEY,root_id TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_template_batch_results(key TEXT PRIMARY KEY,json TEXT NOT NULL);`);
  }
  list(): TemplateChecklist[] { return this.store.db.prepare('SELECT json FROM auto_template_checklists ORDER BY revision DESC').all().map(row=>JSON.parse(row.json)); }
  checklist(id: string): TemplateChecklist | undefined { const row=this.store.db.prepare('SELECT json FROM auto_template_checklists WHERE id=?').get(id);return row?JSON.parse(row.json):undefined; }
  publish(raw: unknown): TemplateChecklist {
    const input=checklistInput.parse(raw);
    return this.store.db.transaction(()=>{const revision=Number(this.store.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS n FROM auto_template_checklists').get().n);
      const item={...input,id:randomUUID(),revision,hash:templateHash(input),createdAt:Date.now()};
      this.store.db.prepare('INSERT INTO auto_template_checklists VALUES(?,?,?)').run(item.id,revision,JSON.stringify(item));return item;});
  }
  current() { return this.list()[0]||this.publish(initial); }
  initialize(task: AutomationTask) {
    if(task.templateWorkflow||task.scenario!=='site-template'||task.kind!=='generation'||task.parentId||task.generatedSiteId)return;
    const checklist=this.current();
    task.templateWorkflow={version:1,rootTaskId:task.id,checklistId:checklist.id};
    this.put({rootTaskId:task.id,inputVersionId:task.versionId,checklistId:checklist.id,baseline:null,sourceEvidence:[],sourceCaptures:{},limitations:[]});
    this.store.put(task);
  }
  get(task: AutomationTask): TemplateWorkflowRecord | undefined {
    if(!task.templateWorkflow)return;
    const row=this.store.db.prepare('SELECT json FROM auto_template_workflows WHERE root_id=?').get(task.templateWorkflow.rootTaskId);
    if(!row)return;
    const record=JSON.parse(row.json) as TemplateWorkflowRecord;
    if(record.inputVersionId!==task.versionId||record.checklistId!==task.templateWorkflow.checklistId)throw new Conflict('模板流程输入或检查集绑定不一致');
    return record;
  }
  put(record: TemplateWorkflowRecord) {
    const row=this.store.db.prepare('SELECT json FROM auto_template_workflows WHERE root_id=?').get(record.rootTaskId);
    if(row){const old=JSON.parse(row.json) as TemplateWorkflowRecord;if(old.inputVersionId!==record.inputVersionId||old.checklistId!==record.checklistId||old.baseline&&templateHash(old.baseline)!==templateHash(record.baseline))throw new Conflict('已冻结模板基线及输入绑定不可覆盖');}
    this.store.db.prepare('INSERT INTO auto_template_workflows VALUES(?,?) ON CONFLICT(root_id) DO UPDATE SET json=excluded.json').run(record.rootTaskId,JSON.stringify(this.store.sanitize(record)));
  }
  evaluation(taskId: string): TemplateEvaluation | undefined { const row=this.store.db.prepare('SELECT json FROM auto_template_evaluations WHERE task_id=?').get(taskId);return row?JSON.parse(row.json):undefined; }
  previousEvaluation(task:AutomationTask):TemplateEvaluation|undefined {
    const record=this.get(task);if(!record)return;
    return this.store.db.prepare('SELECT json FROM auto_template_evaluations WHERE root_id=? AND task_id<>?').all(record.rootTaskId,task.id).map(row=>JSON.parse(row.json) as TemplateEvaluation).filter(value=>value.baselineId===record.baseline?.id&&value.checklistId===record.checklistId&&value.createdAt<=task.createdAt&&(()=>{const original=this.store.task(value.taskId);return original?.generatedSiteId===task.generatedSiteId&&original?.environmentId===task.environmentId&&original?.versionId===task.versionId&&original?.scope===task.scope;})()).sort((a,b)=>b.createdAt-a.createdAt)[0];
  }
  saveEvaluation(task: AutomationTask, value: TemplateEvaluation) {
    const record=this.get(task);if(!record?.baseline||value.baselineId!==record.baseline.id||value.checklistId!==record.checklistId||value.taskId!==task.id||value.siteRevision!==task.siteRevision)throw new Conflict('模板评测绑定不一致');
    if(task.generatedSiteId&&this.store.siteState(task.generatedSiteId)?.revision!==task.siteRevision)throw new Conflict('评测期间站点修订已变化，不能发布本结果');
    const old=this.evaluation(task.id);if(old&&templateHash(old)!==templateHash(value))throw new Conflict('已完成独立评测不可覆盖；请创建新的复验任务');
    this.store.db.prepare('INSERT INTO auto_template_evaluations VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET json=excluded.json').run(task.id,record.rootTaskId,JSON.stringify(this.store.sanitize(value)));
  }
  batch<T>(key: string): T | undefined {const row=this.store.db.prepare('SELECT json FROM auto_template_batch_results WHERE key=?').get(key);return row?JSON.parse(row.json):undefined;}
  saveBatch(key: string, value: unknown) {this.store.db.prepare('INSERT OR REPLACE INTO auto_template_batch_results VALUES(?,?)').run(key,JSON.stringify(this.store.sanitize(value)));}
  response(task: AutomationTask): TemplateWorkflowResponse {
    const record=this.get(task);
    if(!record)return {supported:false,taskId:task.id,rootTaskId:null,version:null,phase:null,checklist:null,baseline:null,evaluation:null,limitations:[]};
    const active=task.optimization?.activeTaskId?this.store.task(task.optimization.activeTaskId,false):task;
    const reportTask=task.kind==='evaluation'?task:this.store.currentReport(task);
    let evaluation=reportTask?this.evaluation(reportTask.id):undefined;
    const state=task.generatedSiteId?this.store.siteState(task.generatedSiteId):undefined;
    const stale=!!evaluation&&state?.revision!==evaluation.siteRevision;if(stale)evaluation=undefined;
    const phase=['failed','interrupted','cancelled'].includes(active?.status||'')?'interrupted':evaluation?.complete&&evaluation.quality==='passed'?'completed':!record.baseline?'analysis':active?.kind==='evaluation'?'evaluation':active?.repairEvidence?'repair':'generation';
    return {supported:true,taskId:task.id,rootTaskId:record.rootTaskId,version:1,phase,checklist:this.checklist(record.checklistId)||null,baseline:record.baseline,evaluation:evaluation||null,limitations:[...record.limitations,...(stale?['站点已有新修订，历史评测保留，但不能代表当前结果']:[])]};
  }
  evidence(task: AutomationTask, name: string) {
    const record=this.get(task);if(!record)return;
    const candidates=[...record.sourceEvidence,...this.store.db.prepare('SELECT json FROM auto_template_evaluations WHERE root_id=?').all(record.rootTaskId).flatMap(row=>(JSON.parse(row.json) as TemplateEvaluation).evidence)];
    return candidates.find(file=>file.name===name);
  }
}
export function readTemplateEvidence(directory: string, evidence: TemplateEvidence) {
  if(!/^[a-f0-9-]{36}(?:\.png|\.json)$/.test(evidence.name)||!/^[a-f0-9-]{36}$/.test(evidence.ownerTaskId))throw new Conflict('证据身份无效');
  const bytes=readFileSync(resolve(directory,'automation-runs',evidence.ownerTaskId,'evidence',evidence.name));
  if(bytes.length!==evidence.size||createHash('sha256').update(bytes).digest('hex')!==evidence.sha256)throw new Conflict('证据内容已变化');
  return bytes;
}
