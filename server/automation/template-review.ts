import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationReport, AutomationTask } from '../../shared/automation.js';
import type { RequirementManifest } from '../../shared/completeness.js';
import type { Requirement, RequirementCheck } from '../../shared/completeness.js';
import type { AutomationStore } from './store.js';

export interface TemplateReviewBatch { id:string; task:AutomationTask; manifest?:RequirementManifest }
export function templateReviewBatches(task:AutomationTask,manifest?:RequirementManifest):TemplateReviewBatch[]{
  if(!task.rule)throw new Error('模板分批评测缺少固定规则');
  const batches:TemplateReviewBatch[]=[];
  for(const viewport of ['desktop','mobile','business'] as const){
    const criteria=task.rule.criteria.filter(c=>c.scopes.includes(task.scope)&&c.viewports.includes(viewport)).map(c=>({...c,viewports:[viewport]}));
    if(criteria.length)batches.push({id:`criteria-${viewport}`,task:{...task,rule:{...task.rule,criteria}}});
  }
  const parts:Requirement[][]=[];let small:Requirement[]=[];
  for(const item of manifest?.items||[]){
    if(item.kind==='page'&&item.paths.length>6){if(small.length){parts.push(small);small=[];}for(let index=0;index<item.paths.length;index+=6)parts.push([{...item,paths:item.paths.slice(index,index+6)}]);}
    else{small.push(item);if(small.length===4){parts.push(small);small=[];}}
  }
  if(small.length)parts.push(small);
  for(const [index,items] of parts.entries())batches.push({id:`completeness-${index+1}`,task:{...task,rule:{...task.rule,criteria:[]}},manifest:{...manifest!,items}});
  return batches;
}

export function rawBatchReport(report:AutomationReport){return {summary:report.summary,assessments:report.assessments,issues:report.issues,coverage:report.coverage,...(report.completeness?{completeness:report.completeness.checks}:{})};}
export function mergeTemplateReports(reports:AutomationReport[],manifest?:RequirementManifest){
  const unique=(values:string[])=>[...new Set(values)];
  const grouped=new Map<string,RequirementCheck[]>();for(const check of reports.flatMap(report=>report.completeness?.checks||[])){const values=grouped.get(check.id)||[];values.push(check);grouped.set(check.id,values);}
  const checks=[...grouped].map(([id,parts]):RequirementCheck=>{if(parts.length===1)return parts[0];if(manifest?.items.find(item=>item.id===id)?.kind!=='page')throw new Error('非静态页面项不能重复汇总：'+id);
    const status=parts.every(p=>p.status==='verified')?'verified':parts.some(p=>['missing','partial'].includes(p.status))?'partial':parts.every(p=>p.status==='excluded')?'excluded':'unverified';
    return {id,status,reason:parts.map((part,index)=>`分段${index+1}：${part.reason}`).join('\n').slice(0,12000),evidence:unique(parts.flatMap(p=>p.evidence)),checkedViewports:[...new Set(parts.flatMap(p=>p.checkedViewports))],actualCount:null,sampledPaths:unique(parts.flatMap(p=>p.sampledPaths)),checkedKeys:[]};
  });
  return {summary:reports.map(report=>report.summary).join('\n\n').slice(0,20000),assessments:reports.flatMap(report=>report.assessments),issues:[...new Map(reports.flatMap(report=>report.issues).map(issue=>[JSON.stringify(issue),issue])).values()],coverage:{verified:unique(reports.flatMap(report=>report.coverage.verified)),unverified:unique(reports.flatMap(report=>report.coverage.unverified)),outOfScope:unique(reports.flatMap(report=>report.coverage.outOfScope))},...(manifest?{completeness:checks}:{})};
}

/** Only host-validated batch results are checkpointed. Any change of the frozen contract invalidates them. */
export async function reviewTemplateBatches(input:{task:AutomationTask;store:AutomationStore;work:string;evidenceBinding?:string;manifest:()=>RequirementManifest|undefined;validate:(raw:unknown,batch:TemplateReviewBatch)=>AutomationReport;review:(batch:TemplateReviewBatch)=>Promise<AutomationReport>;prepare:()=>Promise<void>}){
  const {task,store,work}=input;
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_review_batches(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL)');
  for(let pass=0;pass<3;pass++){
    const manifest=input.manifest(),contract=JSON.stringify(['template-batches-v2',input.evidenceBinding,task.id,task.versionId,task.siteRevision,task.scope,task.rule,manifest]);
    const batches=templateReviewBatches(task,manifest),reports:AutomationReport[]=[],progress:{id:string;state:string;assessments:number;requirements:number}[]=[];
    const save=()=>writeFileSync(resolve(work,'review-batches.json'),JSON.stringify({version:1,siteRevision:task.siteRevision,manifestId:manifest?.id,pass,progress},null,2),{mode:0o600});save();
    let changed=false;
    for(const batch of batches){
      const key=createHash('sha256').update(contract+batch.id).digest('hex');let report:AutomationReport|undefined;
      const saved=store.db.prepare('SELECT json FROM auto_template_review_batches WHERE key=? AND task_id=?').get(key,task.id);
      if(saved)try{report=input.validate(JSON.parse(saved.json),batch);}catch{/* Recheck bytes and binding on every resume. */}
      const reused=!!report;
      if(!report)report=await input.review(batch);
      if(input.manifest()?.id!==manifest?.id){changed=true;store.event(task.id,'评测独立补充了清单；保留取证并按新完整范围重新分批，不发布旧范围的部分结果。');await input.prepare();break;}
      const raw=rawBatchReport(report);input.validate(raw,batch);
      store.db.prepare('INSERT OR REPLACE INTO auto_template_review_batches VALUES(?,?,?)').run(key,task.id,JSON.stringify(raw));
      reports.push(report);progress.push({id:batch.id,state:reused?'reused':'validated',assessments:report.assessments.length,requirements:report.completeness?.checks.length||0});save();
      store.event(task.id,`分批评测 ${progress.length}/${batches.length} ${batch.id}：${reused?'复用经当前证据重新校验的结果':'已保存独立结果检查点'}`);
    }
    if(!changed)return mergeTemplateReports(reports,manifest);
  }
  throw new Error('独立评测连续补充清单，已保留新范围与取证；本次未发布部分报告，请按最新清单恢复');
}
