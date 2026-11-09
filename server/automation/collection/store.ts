import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AutomationTask, InputVersion, MaterialFile } from '../../../shared/automation.js';
import type { CollectionRun, CollectionSnapshot, CollectionObjective, CollectionStage } from '../../../shared/collection.js';
import type { AcceptedCollectionAssetGap } from '../../../shared/collection.js';
import type { AutomationStore } from '../store.js';
import { Conflict } from '../../lib/store.js';
import { collectionHash, safeCollectionPath, collectionEngineFingerprint } from './runtime.js';
import { acceptedAssetGapEvidencePath, acceptedAssetGapGuidance, acceptedAssetGapIndex, assertAcceptedAssetGapIndex, failedCollectionAssetEntries } from './accepted-gaps.js';
import { assertSourceRenderedEvidenceIndex, sourceRenderedGuidance } from './source-rendered.js';

export class CollectionStore {
 constructor(readonly store:AutomationStore,readonly directory:string){store.db.exec('CREATE TABLE IF NOT EXISTS auto_collections(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS auto_collection_snapshots(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL,json TEXT NOT NULL)');}
 get(id:string):CollectionRun|undefined{const row=this.store.db.prepare('SELECT json FROM auto_collections WHERE id=?').get(id);return row?JSON.parse(row.json):undefined;}
 forTask(task:AutomationTask){return task.collectionId?this.get(task.collectionId):undefined;}
 put(run:CollectionRun){run.updatedAt=Date.now();this.store.db.prepare('INSERT INTO auto_collections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(run.id,run.taskId,JSON.stringify(run));return run;}
 create(task:AutomationTask){const input=this.store.version(task.versionId)!;const run:CollectionRun={id:randomUUID(),taskId:task.id,inputVersionId:task.versionId,sourceUrl:input.contentUrl,scope:'site',status:'collecting',engineVersion:collectionEngineFingerprint(),baseEngineVersion:collectionEngineFingerprint(),createdAt:Date.now(),updatedAt:Date.now(),completed:[],options:{maxPages:300,maxDepth:6,maxAssets:5000,maxTotalBytes:2*1024**3,delay:0.3,retryFailed:true},operations:[],checks:[],reviewAttempt:0};this.put(run);task.collectionId=run.id;this.store.put(task);return run;}
 workspace(run:CollectionRun){return resolve(this.directory,'collection-runs',run.id,'package');}
 read(run:CollectionRun,path:string){return readFileSync(safeCollectionPath(this.workspace(run),path));}
 json(run:CollectionRun,path:string){return JSON.parse(this.read(run,path).toString());}
 inventory(run:CollectionRun,hashes=true){const root=this.workspace(run),files:{path:string;sha256:string;size:number}[]=[];const walk=(folder:string)=>{for(const name of readdirSync(safeCollectionPath(root,folder),{withFileTypes:true})){const path=folder+'/'+name.name;safeCollectionPath(root,path);if(name.isSymbolicLink())throw new Error('资料包含符号链接');if(name.isDirectory())walk(path);else if(name.isFile()){files.push({path:path.replace(/^\.\//,''),sha256:hashes?collectionHash(this.read(run,path)):'',size:statSync(safeCollectionPath(root,path)).size});}}};walk('.');return files.sort((a,b)=>a.path.localeCompare(b.path));}
 snapshot(id:string):CollectionSnapshot|undefined{const row=this.store.db.prepare('SELECT json FROM auto_collection_snapshots WHERE id=?').get(id);return row?JSON.parse(row.json):undefined;}
 reusableSnapshot(id:string,resourceId:string){
   const snapshot=this.snapshot(id),source=snapshot&&this.store.task(snapshot.taskId),run=snapshot&&this.get(snapshot.collectionId),input=snapshot&&this.store.version(snapshot.inputVersionId),origin=run&&this.store.task(run.taskId);
   if(!snapshot||!source||!run||!input||!origin||source.resourceId!==resourceId||origin.resourceId!==resourceId||input.resourceId!==resourceId||source.versionId!==snapshot.inputVersionId||run.inputVersionId!==snapshot.inputVersionId||input.contentUrl!==run.sourceUrl||source.kind!=='generation'||source.scope!=='site'||!['migration','upgrade'].includes(input.scenario))throw new Conflict('冻结采集快照不属于当前资源的全站生成来源及固定输入');
   try{this.verify(snapshot);}catch(error){throw new Conflict((error as Error).message);}
   return snapshot;
 }
 acceptCurrentAssetGaps(task:AutomationTask,reason:string,expectedStateHash:string,owns:(id:string)=>boolean){
   return this.store.db.transaction(()=>{
     const run=this.forTask(task);
     if(!run||run.taskId!==task.id||run.inputVersionId!==task.versionId||task.kind!=='generation'||task.scope!=='site')throw new Conflict('接受素材缺口必须对应本任务固定采集输入');
     if(!task.stopped||owns(task.id)||['running','following-up','cancelling'].includes(task.status)||run.operations.some(operation=>operation.status==='running'))throw new Conflict('请先确认任务及采集执行已停止');
     const related=this.store.tasks().filter(item=>item.collectionId===run.id);
     if(related.some(item=>!item.stopped||owns(item.id)))throw new Conflict('同一采集资料仍有活动执行，请等待停止');
     const submitted=(item:AutomationTask)=>Boolean(item.generatedSiteId||item.collectionVersionId||item.threadId||item.generation&&(item.generation.createAttempted||item.generation.legacySubmitted||item.generation.prepared||item.generation.conversationId||item.generation.runId||item.generation.deliveryId||item.generation.deliveryState));
     if(run.status==='ready'||run.materialVersionId||related.some(submitted))throw new Conflict('已冻结或已开始建站的任务不能修改素材接受条件');
     let bytes:Buffer;try{bytes=this.read(run,'.work/state.json');}catch{throw new Conflict('缺少当前采集状态，无法接受具体素材');}
     if(collectionHash(bytes)!==expectedStateHash)throw new Conflict('采集状态已变化，请重新核对当前state哈希');
     let state:any,entries:ReturnType<typeof failedCollectionAssetEntries>;
     try{state=JSON.parse(bytes.toString('utf8'));if(state.source!==run.sourceUrl)throw new Error('来源不符');entries=failedCollectionAssetEntries(state);}catch{throw new Conflict('当前素材状态无效或与固定来源不符');}
     if(!entries.length)throw new Conflict('当前没有可接受的已失败素材；超限、待处理和未归账对象不适用');
     try{assertAcceptedAssetGapIndex(run,path=>this.read(run,path));}catch{throw new Conflict('已有素材接受索引缺失或已变化，请先恢复原记录');}
     const id=collectionHash(JSON.stringify({taskId:task.id,collectionId:run.id,inputVersionId:task.versionId,stateHash:expectedStateHash,entries}));
     const previous=run.acceptedAssetGaps?.find(acceptance=>acceptance.id===id);
     if(previous)return {acceptance:previous,acceptedAssetGaps:run.acceptedAssetGaps!,evidencePath:acceptedAssetGapEvidencePath,idempotent:true};
     const acceptance:AcceptedCollectionAssetGap={id,taskId:task.id,collectionId:run.id,inputVersionId:task.versionId,actor:'human',acceptedAt:Date.now(),reason,stateHash:expectedStateHash,evidencePath:acceptedAssetGapEvidencePath,entries};
     run.acceptedAssetGaps=[...(run.acceptedAssetGaps||[]),acceptance];
     const path=safeCollectionPath(this.workspace(run),acceptedAssetGapEvidencePath);mkdirSync(resolve(path,'..'),{recursive:true,mode:0o700});
     writeFileSync(path,JSON.stringify(acceptedAssetGapIndex(run),null,2),{mode:0o600});
     // Record the new external condition without changing stage checks, history or budgets.
     this.put(run);task.message+='\n\n用户按当前素材继续（'+acceptance.id.slice(0,12)+'）：'+reason.slice(0,180)+'。'+acceptedAssetGapGuidance([acceptance]);this.store.put(task);
     this.store.event(task.id,'已记录本任务当前失败素材接受条件；仍需独立A1–A6复核：'+acceptedAssetGapEvidencePath);
     return {acceptance,acceptedAssetGaps:run.acceptedAssetGaps,evidencePath:acceptedAssetGapEvidencePath,idempotent:false};
   });
 }
 original(snapshot:CollectionSnapshot,path:string){
   const indexed=snapshot.originals.find(item=>item.path===path);if(!indexed)throw new Error('冻结索引未包含原件：'+path);
   const material=snapshot.files.find(file=>file.name==='collection/'+path);
   const archive=resolve(this.directory,'collection-snapshots',snapshot.id,'originals');
   const bytes=material?readFileSync(resolve(this.directory,'materials',material.id)):readFileSync(safeCollectionPath(archive,path));
   if(bytes.length!==indexed.size||collectionHash(bytes)!==indexed.sha256)throw new Error('冻结原件不完整或已变化：'+path);return bytes;
 }
 requestRevision(task:AutomationTask,objective:CollectionObjective&{operation:CollectionStage;options?:Partial<CollectionRun['options']>}){
   const run=this.forTask(task);if(!run||run.status!=='ready'||!run.materialVersionId)throw new Error('只有已冻结来源可安排补采新版本');
   const snapshot=this.snapshot(task.collectionVersionId||'');if(!snapshot||snapshot.collectionId!==run.id)throw new Error('补采目标与当前资料版本不一致');this.verify(snapshot);
   const order:CollectionStage[]=['plan','discover','fetch','extract','assets','data','render','verify'];
   run.completed=order.slice(0,order.indexOf(objective.operation));
   run.next={...objective};run.revisionTaskId=task.id;run.status='collecting';run.error=undefined;run.checks=[];run.review=undefined;this.put(run);return run;
 }
 freeze(run:CollectionRun,task:AutomationTask,manifestId:string){
   if(run.checks.length!==7||run.checks.some(check=>check.status!=='verified')||!run.review)throw new Error('A段检查和独立复核未全部通过');
   assertAcceptedAssetGapIndex(run,path=>this.read(run,path));
   assertSourceRenderedEvidenceIndex(run,path=>this.read(run,path));
   const originals=this.inventory(run),id=randomUUID(),files:MaterialFile[]=[],previous=this.snapshot(run.materialVersionId||'')?.files||[];
   // Freeze private originals as bytes, not only hashes into the mutable working tree.
   // Later collection revisions must never invalidate earlier reports.
   const archive=resolve(this.directory,'collection-snapshots',id,'originals');mkdirSync(archive,{recursive:true,mode:0o700});
   for(const item of originals.filter(item=>item.path.startsWith('.work/'))){const destination=safeCollectionPath(archive,item.path);mkdirSync(resolve(destination,'..'),{recursive:true,mode:0o700});writeFileSync(destination,this.read(run,item.path),{mode:0o600,flag:'wx'});}
   const materials=resolve(this.directory,'materials');mkdirSync(materials,{recursive:true,mode:0o700});
   this.store.db.exec('CREATE TABLE IF NOT EXISTS auto_files(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
   for(const item of originals.filter(f=>!f.path.startsWith('.work/')&&!f.path.endsWith('/.DS_Store'))){
     const extension=extname(item.path).toLowerCase(),type=({'.json':'application/json','.md':'text/markdown','.csv':'text/csv','.html':'text/html','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.css':'text/css'} as Record<string,string>)[extension]||'application/octet-stream';
     const file:MaterialFile={id:randomUUID(),name:'collection/'+item.path,type,size:item.size,sha256:item.sha256};
     const retained=previous.find(prior=>prior.name===file.name&&prior.type===file.type&&prior.size===file.size&&prior.sha256===file.sha256);
     if(retained){const priorPath=resolve(materials,retained.id);if(existsSync(priorPath)&&collectionHash(readFileSync(priorPath))===retained.sha256){files.push(retained);continue;}}
     writeFileSync(resolve(materials,file.id),this.read(run,item.path),{mode:0o600,flag:'wx'});files.push(file);
   }
   delete run.revisionTaskId;
   const base={id,collectionId:run.id,taskId:task.id,inputVersionId:task.versionId,engineVersion:run.engineVersion,createdAt:Date.now(),files,originals,checks:run.checks,review:run.review,manifestId,...(run.acceptedAssetGaps?.length?{acceptedAssetGaps:structuredClone(run.acceptedAssetGaps)}:{}),...(run.sourceRenderedEvidence?.length?{sourceRenderedEvidence:structuredClone(run.sourceRenderedEvidence)}:{})};
   const snapshot:CollectionSnapshot={...base,sha256:collectionHash(JSON.stringify(base))};
   this.store.db.transaction(()=>{for(const file of files)this.store.db.prepare('INSERT OR IGNORE INTO auto_files VALUES(?,?)').run(file.id,JSON.stringify(file));this.store.db.prepare('INSERT INTO auto_collection_snapshots VALUES(?,?,?)').run(id,run.id,JSON.stringify(snapshot));run.materialVersionId=id;run.files=files;run.manifestId=manifestId;run.snapshotHash=snapshot.sha256;run.status='ready';this.put(run);task.collectionVersionId=id;this.store.put(task);const workflow=this.store.root(task);if(workflow&&workflow.id!==task.id){workflow.collectionId=run.id;workflow.collectionVersionId=id;workflow.requirementsId=manifestId;this.store.put(workflow);}});return snapshot;
 }
 verify(snapshot:CollectionSnapshot){for(const file of snapshot.files){const path=resolve(this.directory,'materials',file.id);if(!existsSync(path)||statSync(path).size!==file.size||collectionHash(readFileSync(path))!==file.sha256)throw new Error('冻结采集资料不完整或已变化：'+file.name);}if(collectionHash(JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([key])=>key!=='sha256'))))!==snapshot.sha256)throw new Error('采集冻结索引校验失败');for(const original of snapshot.originals)this.original(snapshot,original.path);assertSourceRenderedEvidenceIndex({id:snapshot.collectionId,inputVersionId:snapshot.inputVersionId,engineVersion:snapshot.engineVersion,sourceRenderedEvidence:snapshot.sourceRenderedEvidence},path=>this.original(snapshot,path));}
}
/** InputVersion is immutable; collection attachments are pinned on the task. */
export function effectiveCollectionInput(task:AutomationTask,store:AutomationStore,directory:string):InputVersion|undefined{
 const input=store.version(task.versionId);if(!input||!task.collectionVersionId)return input;
 const collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId);
 if(!snapshot||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId)throw new Error('采集资料版本与任务固定输入不一致');
 collections.verify(snapshot);return {...input,files:[...input.files,...snapshot.files],description:input.description+'\n采集资料版本：'+snapshot.id+'；A段仅对约定范围通过，来源总数未知时保持未知。完整原件与复核保留在平台。'+(snapshot.acceptedAssetGaps?.length?'\n'+acceptedAssetGapGuidance(snapshot.acceptedAssetGaps):'')+(snapshot.sourceRenderedEvidence?.length?'\n'+sourceRenderedGuidance(snapshot):'')};
}
