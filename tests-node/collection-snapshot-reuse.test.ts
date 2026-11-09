import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { Vault } from '../server/lib/vault.js';
import { Conflict } from '../server/lib/store.js';
import { AutomationStore } from '../server/automation/store.js';
import { registerAutomationApi } from '../server/automation/api.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { CollectionStore, effectiveCollectionInput } from '../server/automation/collection/store.js';
import { ensureSourceCollection } from '../server/automation/collection/orchestrator.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { executeGeneration } from '../server/automation/generator.js';
import { defaultAutomationSettings } from '../shared/automation.js';

function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'snapshot-reuse-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory),environmentId=randomUUID();
  vault.update({threshold:80,paused:true,model:{endpoint:'',name:''},environments:[{id:environmentId,name:'Fixture',origin:'https://kooboo.invalid',apiOrigin:'https://kooboo.invalid',token:'fixture'}]});
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof Conflict?409:error instanceof ZodError?400:500).send({error:error instanceof Error?error.message:String(error)}));
  registerAutomationApi(app,store,vault,directory,()=>{},()=>false);
  const resource=store.saveResource({name:'Frozen source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'Original version',files:[],externalSource:'',externalId:''});
  const source=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:'',optimization:{targetScore:90}},structuredClone(defaultAutomationSettings))[0];
  const collections=new CollectionStore(store,directory),run=collections.create(source),root=collections.workspace(run),manifests=new ManifestStore(store);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  write('.work/raw/u1.html','<html><head><title>Original</title></head><body><main><h1>Original</h1><p>Frozen complete source body</p></main></body></html>');
  write('.work/extract/u1.json',{url:'https://source.invalid/one',title:'Original',fullText:'Original\nFrozen complete source body',pageType:'page',links:[]});
  write('.work/state.json',{source:run.sourceUrl,urls:{u1:{id:'u1',url:'https://source.invalid/one',path:'/one',action:'keep',status:200,rawFile:'.work/raw/u1.html'}},assets:Array.from({length:81},(_,index)=>({url:'https://source.invalid/missing-'+index+'.png',status:'failed',note:'http-404'}))});
  collections.acceptCurrentAssetGaps(source,'按已取得素材继续，保留81项原始失败记录',collectionHash(collections.read(run,'.work/state.json')),()=>false);Object.assign(run,collections.get(run.id));
  const baseline=manifests.save(source,{sourceComplete:false,limitations:['原站公开总量未知；仅验证冻结范围'],items:[{id:'pages',kind:'page',title:'Frozen page',required:true,source:'frozen source',expectation:'Preserve whole page',paths:['/one'],expectedCount:1,viewports:['desktop','mobile']}],evidence:[]},'human');
  run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'fixture independent review',evidence:[]}));run.review={action:'ready'};
  const snapshot=collections.freeze(run,source,baseline.id);
  const payload={resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:'Independent source validation',collectionSnapshotId:snapshot.id};
  const create=(changes:Record<string,unknown>={},key=randomUUID())=>app.inject({method:'POST',url:'/api/automation/tasks',headers:{'idempotency-key':key},payload:{...payload,...changes}});
  const counts=()=>Object.fromEntries(['auto_tasks','auto_requirement_manifests','auto_events','auto_requests','auto_collections','auto_collection_snapshots','auto_sites'].map(table=>[table,db.prepare('SELECT COUNT(*) AS count FROM '+table).get().count]));
  return {directory,db,store,vault,app,resource,source,collections,run,root,manifests,baseline,snapshot,payload,create,write,counts,async close(){await app.close();db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('snapshot reuse creates an independent task and preserves source acceptance records and idempotent replay',async()=>{
  const f=fixture();try{
    f.source.generatedSiteId=randomUUID();f.source.threadId='old-conversation';f.source.context='old context';f.source.generation={prepared:true,conversationId:'old-conversation',runId:'old-run'};
    f.source.autonomy!.history.noProgress=7;f.store.scheduleFollowup(f.source,defaultAutomationSettings.followup);f.source.stopped=true;f.source.status='interrupted';f.store.put(f.source);
    const sourceBefore=JSON.stringify(f.store.task(f.source.id)),runBefore=JSON.stringify(f.collections.get(f.run.id)),snapshotBefore=JSON.stringify(f.collections.snapshot(f.snapshot.id)),acceptedBefore=f.collections.original(f.snapshot,'site/accepted-source-gaps.json');
    const key=randomUUID(),first=await f.create({optimization:{targetScore:95,maxRounds:3}},key);assert.equal(first.statusCode,201,first.body);
    const task=first.json().items[0],cloned=f.manifests.get(task.requirementsId)!;
    assert.notEqual(task.id,f.source.id);assert.equal(task.parentId,null);assert.equal(task.generatedSiteId,null);assert.equal(task.siteUrl,'');assert.equal(task.threadId,'');assert.equal(task.context,'');assert.equal(task.generation,undefined);assert.equal(task.followup,undefined);assert.equal(task.optimizationRootId,undefined);
    assert.equal(task.autonomy.history.noProgress,0);assert.deepEqual(task.autonomy.history.failures,[]);assert.equal(task.optimization.activeTaskId,task.id);assert.notEqual(task.optimization.currentRevision,f.source.optimization!.currentRevision);assert.equal(task.optimization.policy.targetScore,95);
    assert.equal(task.collectionId,f.run.id);assert.equal(task.collectionVersionId,f.snapshot.id);assert.equal(task.versionId,f.snapshot.inputVersionId);assert.equal(cloned.taskId,task.id);assert.notEqual(cloned.id,f.baseline.id);assert.deepEqual(cloned.items,f.baseline.items);assert.deepEqual(cloned.limitations,f.baseline.limitations);assert.equal(cloned.sourceComplete,false);
    assert.equal(JSON.stringify(f.store.task(f.source.id)),sourceBefore);assert.equal(JSON.stringify(f.collections.get(f.run.id)),runBefore);assert.equal(JSON.stringify(f.collections.snapshot(f.snapshot.id)),snapshotBefore);assert.deepEqual(f.collections.original(f.snapshot,'site/accepted-source-gaps.json'),acceptedBefore);assert.equal(f.snapshot.acceptedAssetGaps![0].entries.length,81);assert.equal(f.snapshot.acceptedAssetGaps![0].taskId,f.source.id);
    const counts=f.counts(),again=await f.create({optimization:{targetScore:95,maxRounds:3}},key);assert.equal(again.statusCode,201);assert.deepEqual(again.json(),first.json());assert.deepEqual(f.counts(),counts);
    const changed=await f.create({requirements:'Different intent'},key);assert.equal(changed.statusCode,409);assert.deepEqual(f.counts(),counts);
  }finally{await f.close();}
});

test('reuse pins old input and snapshot across newer resource and mutable collection revisions',async()=>{
  const f=fixture();try{
    const originalBytes=f.collections.original(f.snapshot,'.work/raw/u1.html');
    f.store.saveResource({...f.resource,description:'Later input'},f.resource.id,f.resource.revision);
    f.write('.work/raw/u1.html','<h1>Later collection body</h1>');f.collections.freeze(f.run,f.source,f.baseline.id);
    const reply=await f.create();assert.equal(reply.statusCode,201,reply.body);const task=f.store.task(reply.json().items[0].id)!;
    const mutable=f.collections.get(f.run.id)!;mutable.status='collecting';mutable.baseEngineVersion='later-engine';f.collections.put(mutable);const runBefore=JSON.stringify(f.collections.get(f.run.id));
    await ensureSourceCollection(task,f.store,f.vault,f.directory,AbortSignal.timeout(1000));
    assert.equal(task.collectionVersionId,f.snapshot.id);assert.equal(task.versionId,f.snapshot.inputVersionId);assert.notEqual(task.versionId,f.store.versions(f.resource.id)[0].id);assert.equal(JSON.stringify(f.collections.get(f.run.id)),runBefore);assert.deepEqual(f.collections.original(f.snapshot,'.work/raw/u1.html'),originalBytes);assert.match(effectiveCollectionInput(task,f.store,f.directory)!.description,/Original version/);
  }finally{await f.close();}
});

test('explicit saved manifest extensions are cloned with source evidence and frozen baseline intact',async()=>{
  const g=fixture();try{
    const owner=g.store.create({resourceIds:[g.resource.id],kind:'generation',scope:'site',environmentId:g.payload.environmentId,requirements:'Manifest extension',parentId:g.source.id,versionId:g.source.versionId},defaultAutomationSettings)[0];
    const extension=g.manifests.save(owner,{sourceComplete:false,limitations:[...g.baseline.limitations,'Retain extension provenance'],items:[...g.baseline.items,{id:'records',kind:'data',title:'Page records',required:true,source:'frozen',expectation:'All source pages',paths:[],expectedCount:1,expectedKeys:['https://source.invalid/one'],dataIdentity:{kind:'page'},viewports:['business']}],evidence:[]},'human');
    extension.sourceEvidence=[{taskId:owner.id,name:'source-proof.json',sha256:'a'.repeat(64)}];g.db.prepare('UPDATE auto_requirement_manifests SET json=? WHERE id=?').run(JSON.stringify(extension),extension.id);
    const response=await g.create({collectionManifestId:extension.id});assert.equal(response.statusCode,201,response.body);const task=response.json().items[0],cloned=g.manifests.get(task.requirementsId)!;
    assert.deepEqual(cloned.items,extension.items);assert.deepEqual(cloned.sourceEvidence,extension.sourceEvidence);assert.equal(cloned.taskId,task.id);assert.ok(cloned.revision>extension.revision);
  }finally{await g.close();}
});

test('an explicit recollection owner advances its run while independent reuse retains the frozen version',async()=>{
  const f=fixture();try{
    f.collections.requestRevision(f.source,{description:'Collect a concrete missing source page',affectedObjects:['https://source.invalid/missing'],evidence:['source-gap'],acceptance:'Freeze verified full text',operation:'discover'});
    assert.equal(f.collections.get(f.run.id)!.revisionTaskId,f.source.id);
    const response=await f.create();assert.equal(response.statusCode,201,response.body);const task=f.store.task(response.json().items[0].id)!;
    const runBefore=JSON.stringify(f.collections.get(f.run.id));await ensureSourceCollection(task,f.store,f.vault,f.directory,AbortSignal.timeout(1000));
    assert.equal(task.collectionVersionId,f.snapshot.id);assert.equal(JSON.stringify(f.collections.get(f.run.id)),runBefore);
    const revised=f.collections.get(f.run.id)!;revised.checks=f.snapshot.checks;revised.review=f.snapshot.review;
    const next=f.collections.freeze(revised,f.source,f.baseline.id);assert.notEqual(next.id,f.snapshot.id);assert.equal(f.collections.get(f.run.id)!.revisionTaskId,undefined);
    await ensureSourceCollection(task,f.store,f.vault,f.directory,AbortSignal.timeout(1000));assert.equal(task.collectionVersionId,f.snapshot.id);
  }finally{await f.close();}
});

test('invalid resource, site/parent semantics, manifest contract and snapshot tampering roll back atomically',async()=>{
  for(const mode of ['resource','scope','kind','site','parent','manifest-owner','manifest-narrow','manifest-unknown','hash','original','missing-archive'] as const){const f=fixture();try{
    const changes:Record<string,unknown>={};
    if(mode==='resource'){const other=f.store.saveResource({...f.resource,name:'Another resource',externalId:'',externalSource:''});changes.resourceIds=[other.id];}
    if(mode==='scope')changes.scope='homepage';if(mode==='kind')changes.kind='evaluation';if(mode==='site')changes.generatedSiteId=randomUUID();if(mode==='parent')changes.parentId=f.source.id;
    if(mode.startsWith('manifest-')){
      const owner=mode==='manifest-owner'?f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'site',environmentId:f.payload.environmentId,requirements:''},defaultAutomationSettings)[0]:f.source;
      const manifest={...f.baseline,id:randomUUID(),taskId:owner.id,revision:2,items:mode==='manifest-narrow'?[]:mode==='manifest-unknown'?[...f.baseline.items,{id:'unknown',kind:'data',title:'Unknown domain',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:null,viewports:['business']}]:f.baseline.items};
      f.db.prepare('INSERT INTO auto_requirement_manifests VALUES(?,?,?,?)').run(manifest.id,owner.id,2,JSON.stringify(manifest));changes.collectionManifestId=manifest.id;
    }
    if(mode==='hash')f.db.prepare('UPDATE auto_collection_snapshots SET json=? WHERE id=?').run(JSON.stringify({...f.snapshot,sha256:'f'.repeat(64)}),f.snapshot.id);
    if(mode==='original')writeFileSync(resolve(f.directory,'collection-snapshots',f.snapshot.id,'originals','.work/raw/u1.html'),'tampered frozen body');
    if(mode==='missing-archive')rmSync(resolve(f.directory,'collection-snapshots',f.snapshot.id,'originals'),{recursive:true});
    const before=f.counts(),response=await f.create(changes);assert.ok([400,409].includes(response.statusCode),mode+': '+response.body);assert.deepEqual(f.counts(),before,mode);
  }finally{await f.close();}}
});

test('generation preflight rejects an unverifiable manifest before creating or contacting a target site',async()=>{
  const f=fixture();try{
    f.source.requirementsId=f.manifests.save(f.source,{sourceComplete:false,limitations:['Unknown source identities'],items:[...f.baseline.items,{id:'unknown',kind:'data',title:'Unknown records',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:null,viewports:['business']}],evidence:[]},'human').id;f.store.put(f.source);
    const before=f.counts();await assert.rejects(executeGeneration(f.source,f.store,f.vault,f.directory,AbortSignal.timeout(1000)),/生成预检未通过/);
    assert.equal(f.source.generatedSiteId,null);assert.equal(f.source.generation,undefined);assert.deepEqual(f.counts(),before);
  }finally{await f.close();}
});
