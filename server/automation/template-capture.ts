import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type { RequirementManifest } from '../../shared/completeness.js';
import type { AutomationStore } from './store.js';
import { evaluationCapturePolicy } from './browser.js';
import { templateTargetPath } from './template-path.js';
import { screenshotRangeCovered, type PageScreenshotsReceipt, type ScreenshotReceipt } from './page-screenshots.js';

export interface CaptureSlot { key:string; role:'target'|'reference'; viewport:'desktop'|'mobile'; url:string; requirements:string[] }
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function templateSourceSnapshot(task:AutomationTask,store:AutomationStore,reference:string){
  const root=store.root(task)?.id||(task.kind==='evaluation'?task.parentId:null)||task.id;
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_source_snapshots(key TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const key=hash(JSON.stringify([root,task.versionId,reference,evaluationCapturePolicy])),row=store.db.prepare('SELECT json FROM auto_template_source_snapshots WHERE key=?').get(key);
  if(row)return JSON.parse(row.json) as {id:string;createdAt:number;inputVersionId:string;reference:string;policy:string};
  const snapshot={id:randomUUID(),createdAt:Date.now(),inputVersionId:task.versionId,reference,policy:evaluationCapturePolicy};store.db.prepare('INSERT INTO auto_template_source_snapshots VALUES(?,?)').run(key,JSON.stringify(snapshot));return snapshot;
}
export function templateCapturePlan(task:AutomationTask,manifest:RequirementManifest|undefined,target:string,reference:string,sourceSnapshotId=task.id){
  const slots=new Map<string,CaptureSlot>(),gaps:string[]=[];
  const add=(path:string,viewport:CaptureSlot['viewport'],requirement:string)=>{
    for(const role of ['target','reference'] as const){const base=role==='target'?target:reference;if(!base)continue;
      try{const url=new URL(role==='target'?templateTargetPath(path,target,reference):path,base);if(url.origin!==new URL(base).origin||url.username||url.password||!['https:','http:'].includes(url.protocol))throw new Error('outside origin');url.hash='';
        const key=hash(JSON.stringify([evaluationCapturePolicy,task.versionId,sourceSnapshotId,role==='target'?[task.id,task.siteRevision]:null,role,viewport,url.href]));
        const slot=slots.get(key)||{key,role,viewport,url:url.href,requirements:[]};if(!slot.requirements.includes(requirement))slot.requirements.push(requirement);slots.set(key,slot);
      }catch{gaps.push(`${requirement} / ${role} / ${viewport}：路径无法在固定站点内解析：${path}`);}
    }
  };
  // The entry point is always reviewed on both viewports. Every declared static path and template boundary follows.
  for(const viewport of ['desktop','mobile'] as const)add('',viewport,'entry');
  for(const item of manifest?.items||[]){if(!['page','template'].includes(item.kind))continue;
    const paths=item.kind==='page'?item.paths:item.samples||[];
    if(!paths.length)gaps.push(`${item.id}：缺少${item.kind==='page'?'页面路径':'模板样本与边界'}，程序不能推断范围`);
    for(const path of paths)for(const viewport of item.viewports)if(viewport!=='business')add(path,viewport,item.id);
  }
  return {policy:evaluationCapturePolicy,inputVersionId:task.versionId,sourceSnapshotId,manifestId:manifest?.id||null,slots:[...slots.values()],gaps};
}

/** Host-owned capture registry. A new target revision never reuses old target pixels. */
export async function captureTemplate(input:{task:AutomationTask;manifest?:RequirementManifest;store:AutomationStore;directory:string;work:string;target:string;reference:string;sourceSnapshotId?:string;artifacts:MaterialFile[];signal:AbortSignal;capture:(slot:CaptureSlot,startY:number)=>Promise<unknown>;checkpoint:()=>void}){
  const {task,store,directory,work,artifacts,signal}=input,plan=templateCapturePlan(task,input.manifest,input.target,input.reference,input.sourceSnapshotId);
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_captures(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL)');
  type SavedCapture={files:MaterialFile[];screenshots:ScreenshotReceipt[];coverageComplete:boolean;nextStartY:number|null;gaps:string[]};
  const progress:{slot:CaptureSlot;state:'captured'|'reused'|'unverified';files:string[];coverageComplete:boolean;nextStartY:number|null;gaps:string[];error?:string}[]=[];
  const save=()=>writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({...plan,progress},null,2),{mode:0o600});save();
  for(const slot of plan.slots){signal.throwIfAborted();
    let saved:SavedCapture={files:[],screenshots:[],coverageComplete:false,nextStartY:0,gaps:[]};
    const row=store.db.prepare('SELECT task_id,json FROM auto_template_captures WHERE key=?').get(slot.key);
    const verify=(record:SavedCapture,owner:string)=>{
      const files=record.files;
      if(!record.screenshots?.length||files.length!==record.screenshots.length*2||new Set(files.map(f=>f.name)).size!==files.length)throw new Error('viewport pairs');
      for(const file of files){if(!/^[a-f0-9-]{36}\.(png|json)$/.test(file.name)||file.role!==slot.role||file.viewport!==slot.viewport)throw new Error('identity');const bytes=readFileSync(resolve(directory,'automation-runs',owner,'evidence',file.name));if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw new Error('hash');}
      for(const frame of record.screenshots){
        if(!files.some(f=>f.name===frame.file&&f.type==='image/png')||!files.some(f=>f.name===frame.file.replace(/\.png$/,'.json')&&f.type==='application/json'))throw new Error('frame pair');
        const observation=JSON.parse(readFileSync(resolve(directory,'automation-runs',owner,'evidence',frame.file.replace(/\.png$/,'.json')),'utf8'));
        if(observation.action!=='take_page_screenshots'||observation.url!==slot.url||observation.position?.url!==slot.url||observation.role!==slot.role||observation.viewport!==slot.viewport||observation.binding?.inputVersionId!==task.versionId||observation.binding?.sourceSnapshotId!==plan.sourceSnapshotId||observation.binding?.capturePolicy!==evaluationCapturePolicy||observation.file!==frame.file||observation.capture?.scope!=='page'||observation.capture?.policy!==evaluationCapturePolicy||JSON.stringify(observation.position)!==JSON.stringify(frame.position))throw new Error('binding');
        if(slot.role==='target'&&(observation.binding?.taskId!==task.id||observation.binding?.siteRevision!==task.siteRevision))throw new Error('revision');
        if(!observation.settlement?.settled||!frame.settlement?.settled)throw new Error('unsettled');
      }
      if(record.coverageComplete&&(!screenshotRangeCovered(record.screenshots.map(s=>s.position))||record.gaps.length))throw new Error('incomplete viewport intervals');
    };
    if(row){try{const cached=JSON.parse(row.json) as SavedCapture;verify(cached,row.task_id);
      if(!cached.coverageComplete&&(cached.nextStartY===null||cached.gaps.length))throw new Error('not resumable');
      for(const file of cached.files){if(row.task_id!==task.id)copyFileSync(resolve(directory,'automation-runs',row.task_id,'evidence',file.name),resolve(work,'evidence',file.name));if(!artifacts.some(existing=>existing.name===file.name))artifacts.push(file);}
      saved=cached;input.checkpoint();
      if(saved.coverageComplete){progress.push({slot,state:'reused',files:saved.files.map(f=>f.name),coverageComplete:true,nextStartY:null,gaps:[]});save();continue;}
    }catch{/* Legacy full-page pairs and changed bytes require fresh viewport evidence. */}}
    try{
      const started=Date.now();let batches=0;
      while(!saved.coverageComplete&&saved.nextStartY!==null&&batches++<4&&Date.now()-started<120000){
        const startY=saved.nextStartY,result=await input.capture(slot,startY) as PageScreenshotsReceipt;
        if(result.action!=='take_page_screenshots'||!Array.isArray(result.screenshots)||!Array.isArray(result.gaps))throw new Error('采集必须返回 take_page_screenshots 逐屏回执，不接受 fullPage 单图');
        const names=result.screenshots.flatMap(s=>[s.file,s.file.replace(/\.png$/,'.json')]),files=artifacts.filter(f=>names.includes(f.name));
        if(!names.length||files.length!==names.length)throw new Error('采集未返回已登记的逐屏截图和观察文件');
        saved={files:[...saved.files,...files],screenshots:[...saved.screenshots,...result.screenshots],coverageComplete:result.coverageComplete,nextStartY:result.nextStartY,gaps:[...saved.gaps,...result.gaps]};
        if(saved.coverageComplete&&!screenshotRangeCovered(saved.screenshots.map(s=>s.position))){saved.coverageComplete=false;saved.gaps.push('实际截图区间未连续覆盖页面');}
        if(saved.gaps.length||saved.screenshots.some(s=>s.url!==slot.url||!s.settlement?.settled)){saved.coverageComplete=false;saved.nextStartY=null;}
        // Validate identities and bytes before checkpointing even a resumable prefix.
        if(!saved.gaps.length)verify(saved,task.id);
        store.db.prepare('INSERT OR REPLACE INTO auto_template_captures VALUES(?,?,?)').run(slot.key,task.id,JSON.stringify(saved));input.checkpoint();
        if(saved.coverageComplete||saved.gaps.length||saved.nextStartY===null)break;
        if(saved.nextStartY<=startY)throw new Error('续采位置没有前进');
      }
      progress.push({slot,state:saved.coverageComplete?'captured':'unverified',files:saved.files.map(f=>f.name),coverageComplete:saved.coverageComplete,nextStartY:saved.nextStartY,gaps:saved.gaps,...(!saved.coverageComplete?{error:'逐屏采集尚未完整或存在未稳定画面；已保存截图不代表通过'}:{})});
    }catch(error){signal.throwIfAborted();progress.push({slot,state:'unverified',files:saved.files.map(f=>f.name),coverageComplete:false,nextStartY:saved.nextStartY,gaps:saved.gaps,error:store.sanitize(error instanceof Error?error.message:'程序取证失败')});}
    save();
  }
  store.event(task.id,`程序取证矩阵：${progress.filter(p=>p.state==='captured').length} 项新取证，${progress.filter(p=>p.state==='reused').length} 项复用，${progress.filter(p=>p.state==='unverified').length+plan.gaps.length} 项待核实；未自动生成评分。`);
  return {...plan,progress};
}
