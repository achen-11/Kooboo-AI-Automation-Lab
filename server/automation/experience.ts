import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AutomationTask } from '../../shared/automation.js';
import type { ExperienceStage, LearningRun } from '../../shared/experience.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { ExperienceStore, experienceInput } from './experience-store.js';
import { localDecision } from './local-decision.js';

const selection=z.object({reason:z.string().min(1).max(4000),selected:z.array(z.object({id:z.string(),revision:z.number().int(),reason:z.string().min(1).max(2000)}).strict()).max(5)}).strict();
const reflection=z.object({reason:z.string().min(1).max(4000),changes:z.array(z.object({id:z.string().optional(),revision:z.number().int().optional(),input:experienceInput,enabled:z.boolean(),reason:z.string().min(1).max(4000),evidence:z.array(z.string()).min(1).max(20)}).strict()).max(5),outcomes:z.array(z.object({experienceId:z.string(),revision:z.number().int(),state:z.enum(['applied-unverified','supported','counterexample','not-applied']),reason:z.string().min(1).max(4000),evidence:z.array(z.string()).min(1).max(20)}).strict()).max(30)}).strict();
function context(task:AutomationTask,store:AutomationStore){return {task:{id:task.id,scenario:task.scenario,scope:task.scope,stage:task.stage,message:task.message.slice(0,20000),error:task.error,interruption:task.interruption},input:store.version(task.versionId),report:task.report?{...task.report,artifacts:undefined}:undefined,events:store.events(task.id).slice(-20).map(e=>({id:'event:'+e.seq,time:e.time,message:e.message.slice(0,2000)}))};}
export function selectionKey(task:AutomationTask,phase:ExperienceStage){return `${task.id}:selection:${phase}:${phase==='followup'?task.followup?.budgetId||task.followup?.startedAt||'initial':'initial'}`;}
export function adoptedGuidance(task:AutomationTask,store:AutomationStore,phase:ExperienceStage){const run=new ExperienceStore(store).run(selectionKey(task,phase));return run?.status==='completed'&&run.adoptions.length?'\n\n本阶段采用的经验（补充建议，不改变原 SOP、范围和规则）：\n'+run.adoptions.map(e=>`[${e.title} v${e.revision}] ${e.guidance}\n适用依据：${e.reason}`).join('\n'):'';}
export async function selectExperience(task:AutomationTask,phase:ExperienceStage,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,decide:typeof localDecision=localDecision){
  if(!task.learningPolicy?.use)return;
  const experiences=new ExperienceStore(store),key=selectionKey(task,phase);if(experiences.run(key))return;
  const candidates=experiences.candidates(task,phase);if(!candidates.length)return;
  const run=experiences.enqueue(task,phase,'selection',key);run.status='running';experiences.put(run);
  try{await decide({task,store,vault,directory,id:run.id,stage:'experience',sop:run.policy.selectionSop+'\n需要更多候选时，可 read input={kind:"experiences",query:"关键词",page:1} 检索当前场景和阶段的启用经验。submit 结构：'+JSON.stringify(z.toJSONSchema(selection)),context:{...context(task,store),phase,candidates},policy:{key:run.budgetId,runKey:run.id,maxTokens:run.policy.maxTokens,maxRequests:run.policy.maxRequests},minutes:run.policy.maxMinutes,signal,read:async raw=>{const q=z.object({kind:z.literal('experiences'),query:z.string().max(200),page:z.number().int().min(1).max(1000).default(1)}).strict().parse(raw);const items=experiences.candidates(task,phase,q.query,q.page,20);for(const e of items)if(!candidates.some(c=>c.id===e.id&&c.revision===e.revision))candidates.push(e);return {items,page:q.page};},
    submit:raw=>{const value=selection.parse(raw);if(new Set(value.selected.map(s=>s.id)).size!==value.selected.length)throw new Error('经验选择不能重复');run.adoptions=value.selected.map(s=>{const e=candidates.find(e=>e.id===s.id&&e.revision===s.revision);if(!e||!experiences.get(e.id)?.enabled||experiences.get(e.id)?.revision!==e.revision)throw new Error('经验不存在、版本不匹配或已停用');return {experienceId:e.id,revision:e.revision,title:e.title,guidance:e.guidance,reason:s.reason};});run.status='completed';run.reason=value.reason;experiences.put(run);return {adoptions:run.adoptions};}});
  }catch(error){if(experiences.run(run.id)?.status==='completed')return;run.status='failed';run.reason=error instanceof Error?error.message:'经验选择失败';experiences.put(run);store.event(task.id,'经验选择未完成，沿用原 SOP：'+run.reason);}
}
export function queueReflection(task:AutomationTask,store:AutomationStore,manual=false){
  if(!manual&&!task.learningPolicy?.collect)return;
  if(!task.report&&!task.interruption)throw new Error('尚无独立评测或明确中断证据，不能复盘');
  const result=task.report?JSON.stringify(task.report):JSON.stringify(task.interruption);
  const fingerprint=createHash('sha256').update(result).digest('hex'),experiences=new ExperienceStore(store),key=`${task.id}:reflection:${fingerprint}`;
  // An evaluation stopped by its contract or preflight before any scoring call has no model behaviour to learn from.
  if(!manual&&task.kind==='evaluation'&&!task.report&&!experiences.run(key)&&!store.usage.entries(task.id).some(entry=>entry.stage!=='experience')){
    const run=experiences.enqueue(task,task.kind==='evaluation'?'evaluation':'followup','reflection',key);
    run.status='completed';run.reason='跳过复盘：任务在请求工作模型前已因契约或预检中断，没有可复盘的模型执行。';experiences.put(run);return run;
  }
  return experiences.enqueue(task,task.kind==='evaluation'?'evaluation':'followup','reflection',key);
}
export async function reflectExperience(run:LearningRun,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,decide:typeof localDecision=localDecision){
  const experiences=new ExperienceStore(store),task=store.task(run.taskId);if(!task)throw new Error('经验来源任务已不存在');
  const fullSource=context(task,store),source={...fullSource,events:fullSource.events.slice(-6).map(e=>({...e,message:e.message.slice(0,300),truncated:e.message.length>300}))},ancestors=[task];let current=task;const seen=new Set([task.id]);while(current.parentId&&!seen.has(current.parentId)){const parent=store.task(current.parentId);if(!parent)break;ancestors.push(parent);seen.add(parent.id);current=parent;}
  const adoptions=ancestors.flatMap(t=>experiences.runs(t.id,1,100).items).filter(r=>r.kind==='selection'&&r.status==='completed').flatMap(r=>r.adoptions);
  const evidence=new Set([...fullSource.events.map(e=>e.id),...(task.report?.artifacts||[]).map(f=>`report:${task.id}:${f.name}`),...(task.interruption?.evidence||[])]);
  const cited=new Set([...(task.report?.issues||[]).flatMap(i=>i.evidence),...(task.report?.assessments||[]).flatMap(a=>a.evidence)]);
  // Seed only cited evidence, not hundreds of unrelated capture identifiers. Full evidence stays paginated and host-owned.
  const initialEvidence=[...source.events.map(e=>e.id),...[...cited].filter(name=>(task.report?.artifacts||[]).some(f=>f.name===name)).slice(0,40).map(name=>`report:${task.id}:${name}`),...(task.interruption?.evidence||[])];
  const library=experiences.page(1,1);
  const checkEvidence=(names:string[])=>{if(names.some(e=>!evidence.has(e)))throw new Error('只能引用本次来源中存在的证据标识');};
  const read=async(raw:unknown)=>{
    if(raw&&typeof raw==='object'&&'kind' in raw&&raw.kind==='evidence'){
      const q=z.object({kind:z.literal('evidence'),page:z.number().int().min(1).max(1000).default(1)}).strict().parse(raw),files=task.report?.artifacts||[],pageSize=20;
      return {page:q.page,pages:Math.max(1,Math.ceil(files.length/pageSize)),total:files.length,items:files.slice((q.page-1)*pageSize,q.page*pageSize).map(f=>({id:`report:${task.id}:${f.name}`,name:f.name,type:f.type,role:f.role,viewport:f.viewport}))};
    }
    if(raw&&typeof raw==='object'&&'kind' in raw&&raw.kind==='experiences'){const q=z.object({kind:z.literal('experiences'),query:z.string().max(200),page:z.number().int().min(1).max(1000).default(1)}).strict().parse(raw);return experiences.page(q.page,20,q.query);}
    const {id}=z.object({id:z.string()}).strict().parse(raw);checkEvidence([id]);
    if(id.startsWith('event:'))return fullSource.events.find(e=>e.id===id);
    const file=task.report?.artifacts.find(f=>`report:${task.id}:${f.name}`===id);
    if(file){const path=resolve(directory,'automation-runs',task.id,'evidence',file.name),bytes=readFileSync(path);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('来源报告证据校验失败');return {evidenceId:id,sha256:file.sha256,...(file.type==='image/png'?{imagePath:path,note:'必须实际查看该截图再做视觉归因'}:{text:bytes.toString('utf8').slice(0,100000),truncated:bytes.length>100000})};}
    if(/^observation-[a-f0-9-]+$/.test(id))return {evidenceId:id,text:readFileSync(resolve(directory,'followup-runs',task.id,id+'.json'),'utf8').slice(0,100000)};
    throw new Error('此证据不能读取；请保留未验证状态');
  };
  try{await decide({task,store,vault,directory,id:run.id,stage:'experience',onThreadStarted:id=>{run.threadId=id;experiences.put(run);},sop:run.policy.reflectionSop+'\n先读上下文中的完整报告、来源覆盖及经验库总数。library.total=0 时全库为空，不需要再次搜索。报告足够支持具体经验时直接提交，不需要重新评测或遍历所有截图；报告结论与亲自看图要区分，未实际查看图片不得宣称亲眼确认视觉缺陷。最多选取少量最有价值的经验，不为凑数耗尽预算。\n仅在需要时通过 read input={kind:"experiences",query:"标题关键词",page:1} 查已有条目；通过 read input={kind:"evidence",page:1} 分页找其他报告证据。read input={id:证据标识} 读取真实证据或截图路径。只有已采用的经验可以做效果归因；supported/counterexample 必须有直接证据，整体分数改变不算因果证据。submit 结构：'+JSON.stringify(z.toJSONSchema(reflection)),context:{...source,adoptions,evidence:initialEvidence,evidenceTotal:evidence.size,library:{total:library.total},candidates:experiences.candidates(task,run.phase)},policy:{key:run.budgetId,runKey:run.id,maxTokens:run.policy.maxTokens,maxRequests:run.policy.maxRequests},minutes:run.policy.maxMinutes,signal,read,
    submit:raw=>store.db.transaction(()=>{
      const value=reflection.parse(raw);if(new Set(value.outcomes.map(o=>o.experienceId+':'+o.revision)).size!==value.outcomes.length)throw new Error('同一采用版本只能有一项效果判定');value.changes.forEach(c=>checkEvidence(c.evidence));value.outcomes.forEach(o=>{checkEvidence(o.evidence);if(!adoptions.some(a=>a.experienceId===o.experienceId&&a.revision===o.revision))throw new Error('效果判定必须对应实际采用版本');});
      const produced=value.changes.map(c=>experiences.save(c.input,{id:c.id,revision:c.revision,enabled:c.enabled,actor:'ai',reason:c.reason,taskId:task.id,evidence:c.evidence}));
      for(const outcome of value.outcomes){const current=experiences.get(outcome.experienceId);if(current&&!current.manualDisabled&&current.revision===outcome.revision&&['supported','counterexample'].includes(outcome.state))experiences.save({title:current.title,scenarios:current.scenarios,stages:current.stages,conditions:current.conditions,exclusions:current.exclusions,guidance:current.guidance},{id:current.id,revision:current.revision,actor:'ai',reason:outcome.reason,taskId:task.id,evidence:outcome.evidence,verdict:outcome.state as 'supported'|'counterexample'});}
      run.produced=produced.map(e=>e.id);run.outcomes=value.outcomes;run.reason=value.reason;run.status='completed';experiences.put(run);return {produced:run.produced};
    })});
  }catch(error){if(experiences.run(run.id)?.status==='completed')return;run.status='failed';run.reason=error instanceof Error?error.message:'经验复盘失败';experiences.put(run);store.event(task.id,'经验复盘未完成，不影响已发布报告：'+run.reason);}
}
