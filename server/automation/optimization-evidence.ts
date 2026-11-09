import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';

export function readEvidence(directory: string, reportId: string, file: MaterialFile) {
  if(!/^[a-f0-9-]{36}$/i.test(reportId)||!/^[a-f0-9-]{36}\.png$/i.test(file.name)||file.type!=='image/png')throw new Error('修复图片必须来自有效报告 PNG');
  const path=resolve(directory,'automation-runs',reportId,'evidence',file.name),bytes=readFileSync(path);
  if(bytes.length!==file.size||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('修复图片内容或哈希校验失败');
  return {file,path,bytes,reportId};
}
/** A resumed planner thread already holds earlier pixels; only images new to the thread count against one request. */
export function planningImageInput<T extends {file:MaterialFile}>(selected:readonly T[],alreadySent:ReadonlySet<string>,limit=6*1024*1024) {
  const attached:T[]=[],previous:T[]=[];let bytes=0;
  for(const item of selected){
    if(alreadySent.has(item.file.name)){previous.push(item);continue;}
    if(bytes+item.file.size>limit)continue;
    attached.push(item);bytes+=item.file.size;
  }
  return {attached,previous,available:selected.filter(item=>attached.includes(item)||previous.includes(item)),bytes};
}
/** Send real pixels as SDK image input, with bounded context and explicit source labels. */
export function optimizationEvidence(task: AutomationTask, store: AutomationStore, directory: string) {
  const run=task.optimization!,current=store.task(run.reportId||'');
  if(!current?.report)throw new Error('缺少本轮有效报告');
  const previousId=run.rounds.at(-1)?.sourceReportId,previous=previousId?store.task(previousId):undefined;
  const selected:ReturnType<typeof readEvidence>[]=[],seen=new Set<string>();let bytes=0;
  const add=(report:AutomationTask,file:MaterialFile)=>{
    if(seen.has(file.name)||selected.length>=20||bytes+file.size>16*1024*1024)return;
    const item=readEvidence(directory,report.id,file);selected.push(item);seen.add(file.name);bytes+=file.size;
  };
  for(const report of [current,previous].filter((t):t is AutomationTask=>!!t?.report)){
    const files=report.report!.artifacts.filter(f=>f.type==='image/png');
    // Always include each available role/viewport before filling the remaining issue-focused images.
    for(const viewport of ['desktop','mobile'])for(const role of ['target','reference']){const file=files.find(f=>f.viewport===viewport&&f.role===role&&f.settled!==false)||files.find(f=>f.viewport===viewport&&f.role===role);if(file)add(report,file);}
  }
  const ordered=[...current.report.issues.toSorted((a,b)=>({critical:0,major:1,minor:2}[a.severity]-{critical:0,major:1,minor:2}[b.severity])).flatMap(i=>i.evidence),...current.report.assessments.toSorted((a,b)=>(a.score??0)-(b.score??0)).flatMap(a=>a.evidence)];
  for(const name of ordered){const file=current.report.artifacts.find(f=>f.name===name&&f.type==='image/png');if(file)add(current,file);}
  for(const viewport of ['desktop','mobile'])for(const role of ['target','reference'])if(!selected.some(i=>i.reportId===current.id&&i.file.viewport===viewport&&i.file.role===role))throw new Error(`优化缺少 ${viewport} / ${role} 的有效图片，需要先补齐独立取证`);
  return {current,previous,selected};
}
