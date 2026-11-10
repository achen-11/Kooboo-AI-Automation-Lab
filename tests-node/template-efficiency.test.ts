import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings, type AutomationReport, type AutomationTask, type MaterialFile } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { captureTemplate, templateCapturePlan, templateSourceSnapshot, type CaptureSlot } from '../server/automation/template-capture.js';
import { evaluationCapturePolicy } from '../server/automation/browser.js';
import { templateReviewBatches, reviewTemplateBatches, mergeTemplateReports } from '../server/automation/template-review.js';
import { adaptRepairImages } from '../server/automation/repair-images.js';
import { validateResult } from '../server/automation/evaluator.js';
import { siteRetryBlocked, rememberSiteRetry } from '../server/automation/retry-guard.js';

const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){const directory=mkdtempSync(resolve(tmpdir(),'template-efficiency-')),db=new Database(':memory:'),store=new AutomationStore(db),resource=store.saveResource({name:'Template',scenario:'site-template',description:'',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalId:'',externalSource:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];task.kind='evaluation';task.siteRevision='r1';store.put(task);
  const manifest:RequirementManifest={id:randomUUID(),taskId:task.id,revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'frozen',expectation:'All pages',paths:['/','/about?x=1'],viewports:['desktop','mobile'],expectedCount:2},{id:'cars',title:'Cars',kind:'template',required:true,source:'frozen',expectation:'Boundary samples',paths:[],samples:['/cars/1','/cars/999'],viewports:['desktop','mobile'],expectedCount:2}]};
  const work=resolve(directory,'automation-runs',task.id);mkdirSync(resolve(work,'evidence'),{recursive:true});const artifacts:MaterialFile[]=[];
  return {directory,work,db,store,task,manifest,artifacts,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('template capture covers all static paths, boundary samples and viewports; source reuse never carries old target revisions',async()=>{
  const f=fixture();try{let calls=0;const capture=async(slot:CaptureSlot)=>{calls++;const name=randomUUID()+'.png',pixels=PNG.sync.write({width:1,height:1,data:Buffer.from([5,6,7,255])});const observation={file:name,url:slot.url,role:slot.role,viewport:slot.viewport,settlement:{settled:true},binding:{taskId:f.task.id,siteRevision:f.task.siteRevision,inputVersionId:f.task.versionId,sourceSnapshotId:f.task.id,capturePolicy:evaluationCapturePolicy}};
      for(const [file,bytes,type] of [[name,pixels,'image/png'],[name.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(f.work,'evidence',file),bytes);f.artifacts.push({id:randomUUID(),name:file,size:bytes.length,sha256:hash(bytes),type,role:slot.role,viewport:slot.viewport,settled:true});}return observation;};
    const input={...f,target:'https://target.test/',reference:'https://source.test/',signal:new AbortController().signal,capture,checkpoint:()=>{}};
    const first=await captureTemplate(input);assert.equal(first.slots.length,16);assert.equal(calls,16);assert.equal(first.progress.every(p=>p.state==='captured'),true);
    await captureTemplate(input);assert.equal(calls,16,'all registered bytes are reusable within the same task/revision');
    f.task.siteRevision='r2';await captureTemplate(input);assert.equal(calls,24,'new target revision recaptures every target slot and reuses only the frozen source');
    f.task.versionId=randomUUID();await captureTemplate(input);assert.equal(calls,40,'new input version invalidates source captures too');
    const plan=templateCapturePlan(f.task,{...f.manifest,items:[{...f.manifest.items[0],paths:['https://other.test/secret']}]},input.target,input.reference);assert.equal(plan.gaps.length,4);assert.equal(plan.slots.length,4,'foreign paths remain explicit gaps, never leave the task origins');
  }finally{f.close();}
});

test('capture errors remain visible rather than verified',async()=>{
  const f=fixture();try{const result=await captureTemplate({...f,target:'https://target.test/',reference:'https://source.test/',signal:new AbortController().signal,capture:async()=>{throw new Error('timeout');},checkpoint:()=>{}});assert.equal(result.progress.length,16);assert.equal(result.progress.every(p=>p.state==='unverified'),true);assert.match(readFileSync(resolve(f.work,'capture-plan.json'),'utf8'),/timeout/);
  }finally{f.close();}
});

test('source snapshot identities are stable within a workflow but never shared by unrelated tasks or changed input/URL',()=>{
  const f=fixture();try{const snapshot=templateSourceSnapshot(f.task,f.store,'https://source.test/');assert.equal(templateSourceSnapshot(f.task,f.store,'https://source.test/').id,snapshot.id);
    const other={...f.task,id:randomUUID()};f.store.put(other);assert.notEqual(templateSourceSnapshot(other,f.store,'https://source.test/').id,snapshot.id);assert.notEqual(templateSourceSnapshot(f.task,f.store,'https://changed.test/').id,snapshot.id);
    f.task.versionId=randomUUID();assert.notEqual(templateSourceSnapshot(f.task,f.store,'https://source.test/').id,snapshot.id);
  }finally{f.close();}
});

test('short review batches retain all frozen criteria and requirements, checkpoint validated results and invalidate on contract changes',async()=>{
  const f=fixture();try{const batches=templateReviewBatches(f.task,f.manifest),expected=f.task.rule!.criteria.filter(c=>c.scopes.includes(f.task.scope)).flatMap(c=>c.viewports.map(v=>c.id+':'+v)).sort();assert.deepEqual(batches.flatMap(b=>b.task.rule!.criteria.flatMap(c=>c.viewports.map(v=>c.id+':'+v))).sort(),expected);assert.deepEqual(batches.flatMap(b=>b.manifest?.items.map(i=>i.id)||[]),f.manifest.items.map(i=>i.id));
    let calls=0;const review=async(batch:typeof batches[number])=>{calls++;return {summary:batch.id,assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:null,passed:null,reason:'Needs visual review',evidence:[]}))),issues:[],coverage:{verified:[],unverified:['missing visual'],outOfScope:[]},quality:'unverified',scores:[],artifacts:[],...(batch.manifest?{completeness:{manifestId:f.manifest.id,manifestRevision:1,sourceComplete:true,state:'unverified',checks:batch.manifest.items.map(item=>({id:item.id,status:'unverified',reason:'not checked',evidence:[],checkedViewports:[],actualCount:null,sampledPaths:[],checkedKeys:[]}))}}:{})} as AutomationReport;};
    const validate=(raw:unknown)=>raw as AutomationReport;
    const input={...f,manifest:()=>f.manifest,review,validate,prepare:async()=>{}};
    const result=await reviewTemplateBatches(input);assert.equal(calls,batches.length);assert.equal(result.assessments.length,expected.length);assert.equal(result.completeness?.length,2);
    // The real evaluator converts and validates cached raw results; retain that shape in this harness.
    input.validate=(raw:unknown,batch?:unknown)=>{const r=raw as AutomationReport&{completeness?:any};return {...r,completeness:Array.isArray(r.completeness)?{checks:r.completeness}:r.completeness} as AutomationReport;};
    await reviewTemplateBatches(input);assert.equal(calls,batches.length);f.task.siteRevision='r2';await reviewTemplateBatches(input);assert.equal(calls,batches.length*2);assert.equal(mergeTemplateReports([],undefined).assessments.length,0);
  }finally{f.close();}
});

test('page chunks merge only after real per-batch validation and final full-scope validation rejects a missing path',async()=>{
  const f=fixture();try{f.task.rule={...f.task.rule!,criteria:[]};f.manifest={...f.manifest,items:[{...f.manifest.items[0],paths:Array.from({length:15},(_,i)=>'/page-'+i)}]};
    const observations:Record<string,{url:string;role:string;viewport:string}>={};for(const path of f.manifest.items[0].paths)for(const viewport of ['desktop','mobile'] as const){const name=randomUUID()+'.png';f.artifacts.push({id:randomUUID(),name,type:'image/png',size:1,sha256:'a'.repeat(64),role:'target',viewport});observations[name]={url:'https://target.test'+path,role:'target',viewport};}
    const validate=(raw:unknown,batch:{task:AutomationTask;manifest?:RequirementManifest})=>validateResult(raw,batch.task,f.artifacts,80,false,batch.manifest,observations,'https://target.test/');let calls=0;
    const result=await reviewTemplateBatches({...f,manifest:()=>f.manifest,validate,prepare:async()=>{},review:async batch=>{calls++;const raw={summary:'Reviewed chunk',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},completeness:batch.manifest!.items.map(item=>({id:item.id,status:'verified',reason:'Each path and viewport inspected',evidence:Object.entries(observations).filter(([,o])=>item.paths.includes(new URL(o.url).pathname)).map(([name])=>name),checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]}))};return validate(raw,batch);}});
    assert.equal(calls,3);assert.equal(result.completeness!.length,1);assert.equal(result.completeness![0].sampledPaths.length,15);const final=validateResult(result,f.task,f.artifacts,80,false,f.manifest,observations,'https://target.test/');assert.equal(final.completeness!.state,'complete');
    result.completeness![0].sampledPaths.pop();assert.throws(()=>validateResult(result,f.task,f.artifacts,80,false,f.manifest,observations,'https://target.test/'),/静态页面应覆盖/);
  }finally{f.close();}
});

test('manifest expansion re-prepares and reviews the new scope instead of publishing old partial batches',async()=>{
  const f=fixture();try{f.task.rule={...f.task.rule!,criteria:[]};let calls=0,prepared=0;
    const rawReport=(batch:ReturnType<typeof templateReviewBatches>[number])=>({summary:'Review',assessments:[],issues:[],coverage:{verified:[],unverified:['source unknown'],outOfScope:[]},scores:[],quality:'unverified',artifacts:[],completeness:{manifestId:batch.manifest!.id,manifestRevision:batch.manifest!.revision,sourceComplete:false,state:'unverified',checks:batch.manifest!.items.map(item=>({id:item.id,status:'unverified',reason:'not inspected',evidence:[],checkedViewports:[],sampledPaths:[],actualCount:null,checkedKeys:[]}))}} as AutomationReport);
    const result=await reviewTemplateBatches({...f,manifest:()=>f.manifest,prepare:async()=>{prepared++;},validate:raw=>raw as AutomationReport,review:async batch=>{calls++;if(calls===1)f.manifest={...f.manifest,id:randomUUID(),revision:2,items:[...f.manifest.items,{...f.manifest.items[0],id:'new-scope'}]};return rawReport(batch);}});
    assert.equal(prepared,1);assert.equal(calls,2);assert.deepEqual(result.completeness!.map(c=>c.id),['pages','cars','new-scope']);
  }finally{f.close();}
});

test('a static-page batch exposes only its assigned paths, preserving the complete frozen manifest for final validation',()=>{
  const f=fixture();try{
    const paths=Array.from({length:15},(_,i)=>'/page-'+i);f.manifest.items=[{...f.manifest.items[0],paths,expectedCount:15,expectedKeys:paths,samples:paths}];
    const before=structuredClone(f.manifest),parts=templateReviewBatches(f.task,f.manifest).flatMap(b=>b.manifest?.items||[]);
    assert.deepEqual(parts.flatMap(p=>p.paths),paths);assert.deepEqual(parts.map(p=>p.expectedCount),[6,6,3]);assert.ok(parts.every(p=>p.expectedKeys===undefined&&p.samples===undefined));assert.deepEqual(f.manifest,before);
  }finally{f.close();}
});

test('source URL mapping invalidates affected page checks while retaining independent criteria checkpoints',async()=>{
  const f=fixture();try{
    f.manifest.items=[{...f.manifest.items[0],paths:['https://source.test/']}];let calls=0;
    const validate=(raw:any)=>({...raw,completeness:Array.isArray(raw.completeness)?{checks:raw.completeness}:raw.completeness}) as AutomationReport;
    const review=async(batch:ReturnType<typeof templateReviewBatches>[number])=>{calls++;return {summary:batch.id,assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'unverified',artifacts:[],...(batch.manifest?{completeness:{checks:[{id:'pages',status:'unverified',reason:'pending',evidence:[],checkedViewports:[],sampledPaths:[],checkedKeys:[],actualCount:null}]}}:{})} as AutomationReport;};
    const input={...f,manifest:()=>f.manifest,validate,review,prepare:async()=>{}};
    const batches=templateReviewBatches(f.task,f.manifest);await reviewTemplateBatches(input);assert.equal(calls,batches.length);
    await reviewTemplateBatches({...input,sourceBaseUrl:'https://source.test/'});assert.equal(calls,batches.length+1);
    await reviewTemplateBatches({...input,sourceBaseUrl:'https://source.test/'});assert.equal(calls,batches.length+1,'mapped page result is also durable');
  }finally{f.close();}
});

test('long repair PNGs are decoded and tiled with complete pixel coverage and immutable original mapping',()=>{
  const f=fixture();try{const width=390,height=10075,data=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;data[i]=y%251;data[i+1]=x%251;data[i+3]=255;}
    const bytes=PNG.sync.write({width,height,data}),file:MaterialFile={id:randomUUID(),name:randomUUID()+'.png',size:bytes.length,sha256:hash(bytes),type:'image/png'};
    const result=adaptRepairImages([{file,bytes,reportId:f.task.id}],resolve(f.work,'adapted'));assert.equal(result.images.length,5);assert.equal(result.mapping.reduce((sum,m)=>sum+m.region.height,0),height);let y=0;
    for(const item of result.mapping){assert.equal(item.region.y,y);assert.equal(item.sourceHash,file.sha256);assert.ok(item.width<=2048&&item.height<=2048);const decoded=PNG.sync.read(readFileSync(resolve(f.work,'adapted',item.file)));assert.deepEqual(decoded.data,data.subarray(y*width*4,(y+item.region.height)*width*4));y+=item.region.height;}
    assert.equal(hash(bytes),file.sha256);assert.throws(()=>adaptRepairImages([{file:{...file,sha256:'0'.repeat(64)},bytes,reportId:f.task.id}],resolve(f.work,'bad')),/校验失败/);
    const corrupt=Buffer.from(bytes);corrupt[corrupt.length-5]^=1;assert.throws(()=>adaptRepairImages([{file:{...file,sha256:hash(corrupt)},bytes:corrupt,reportId:f.task.id}],resolve(f.work,'corrupt')),/无法解码/);
  }finally{f.close();}
});

test('repair evidence above one message limit is batched without losing regions or shrinking text',()=>{
  const f=fixture();try{
    const width=1,height=43009,bytes=PNG.sync.write({width,height,data:Buffer.alloc(width*height*4,255)}),file:MaterialFile={id:randomUUID(),name:randomUUID()+'.png',size:bytes.length,sha256:hash(bytes),type:'image/png'};
    const first=adaptRepairImages([{file,bytes,reportId:f.task.id}],resolve(f.work,'batches'));
    assert.deepEqual(first.batches.map(b=>b.images.length),[20,2]);assert.equal(first.mapping.reduce((n,m)=>n+m.region.height,0),height);
    assert.deepEqual(first.batches.flatMap(b=>b.mapping),first.mapping);assert.ok(first.mapping.every(m=>m.width===width));
    const second=adaptRepairImages([{file,bytes,reportId:f.task.id}],resolve(f.work,'batches'));assert.equal(first.planKey,second.planKey);
    assert.ok(first.batches.every(b=>b.images.reduce((n,i)=>n+Buffer.byteLength(i.uri.split(',')[1]),0)<=16*1024*1024));
  }finally{f.close();}
});

test('restart recovery trusts only a completed SDK and browser exit receipt and preserves unknown usage',()=>{
  const f=fixture();try{f.task.status='running';f.task.stopped=false;f.store.put(f.task);const first=f.store.evaluations.begin(f.task.id);f.store.evaluations.finish(f.task.id,first,false);f.store.recover();assert.equal(f.store.task(f.task.id)!.stopped,false);
    const next=f.store.evaluations.begin(f.task.id);f.store.evaluations.finish(f.task.id,first,true);assert.equal(f.store.evaluations.get(f.task.id)!.state,'running','stale cleanup cannot confirm a newer execution');f.store.evaluations.finish(f.task.id,next,true);f.store.recover();assert.equal(f.store.task(f.task.id)!.status,'queued');assert.equal(f.store.task(f.task.id)!.stopped,true);assert.equal(f.store.evaluations.observation(f.task.id).executor,'codex-evaluation');
  }finally{f.close();}
});

test('same failed run cannot repeat retry without a new checkpoint, while a new run or scenario remains eligible',()=>{
  const f=fixture();try{f.task.kind='generation';f.task.generation={runId:'run-1',state:'failed',conversationId:'conversation'};f.task.error='same failure';assert.equal(siteRetryBlocked(f.task,f.store),false);rememberSiteRetry(f.task,f.store);assert.equal(siteRetryBlocked(f.task,f.store),true);f.task.generation.runId='run-2';assert.equal(siteRetryBlocked(f.task,f.store),false);rememberSiteRetry(f.task,f.store);f.task.scenario='app-template';assert.equal(siteRetryBlocked(f.task,f.store),false);
  }finally{f.close();}
});
