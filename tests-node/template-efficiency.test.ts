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
import { EvaluationSliceYield } from '../server/automation/errors.js';
import { AutomationWorker, syncReflectionCandidates } from '../server/automation/worker.js';
import { Vault } from '../server/lib/vault.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { defaultLearningSettings } from '../shared/experience.js';

const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){const directory=mkdtempSync(resolve(tmpdir(),'template-efficiency-')),db=new Database(':memory:'),store=new AutomationStore(db),resource=store.saveResource({name:'Template',scenario:'site-template',description:'',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalId:'',externalSource:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];task.kind='evaluation';task.siteRevision='r1';store.put(task);
  const manifest:RequirementManifest={id:randomUUID(),taskId:task.id,revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'frozen',expectation:'All pages',paths:['/','/about?x=1'],viewports:['desktop','mobile'],expectedCount:2},{id:'cars',title:'Cars',kind:'template',required:true,source:'frozen',expectation:'Boundary samples',paths:[],samples:['/cars/1','/cars/999'],viewports:['desktop','mobile'],expectedCount:2}]};
  const work=resolve(directory,'automation-runs',task.id);mkdirSync(resolve(work,'evidence'),{recursive:true});const artifacts:MaterialFile[]=[];
  return {directory,work,db,store,task,manifest,artifacts,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('template capture covers all static paths, boundary samples and viewports; source reuse never carries old target revisions',async()=>{
  const f=fixture();try{let calls=0;const capture=async(slot:CaptureSlot)=>{calls++;const name=randomUUID()+'.png',pixels=PNG.sync.write({width:1,height:1,data:Buffer.from([5,6,7,255])});const observation={action:'take_page_screenshots',file:name,url:slot.url,role:slot.role,viewport:slot.viewport,settlement:{settled:true},position:{url:slot.url,scrollX:0,scrollY:0,documentHeight:1000,viewportWidth:1440,viewportHeight:1000},capture:{id:randomUUID(),index:1,scope:'page',policy:evaluationCapturePolicy},binding:{taskId:f.task.id,siteRevision:f.task.siteRevision,inputVersionId:f.task.versionId,sourceSnapshotId:f.task.id,capturePolicy:evaluationCapturePolicy}};
      for(const [file,bytes,type] of [[name,pixels,'image/png'],[name.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(f.work,'evidence',file),bytes);f.artifacts.push({id:randomUUID(),name:file,size:bytes.length,sha256:hash(bytes),type,role:slot.role,viewport:slot.viewport,settled:true});}return {action:'take_page_screenshots',status:'complete',coverageComplete:true,screenshots:[observation],gaps:[],nextStartY:null,nextSelectorIndex:null};};
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

test('viewport prefixes resume after interruption; all frame pairs are retained and legacy single-image caches are rejected',async()=>{
  const f=fixture();try{
    const requests:string[]=[];let interrupt=true;
    const capture=async(slot:CaptureSlot,startY:number)=>{
      requests.push(slot.viewport+':'+startY);
      const height=slot.viewport==='mobile'?844:1000,step=Math.round(height*.85);
      if(slot.viewport==='desktop'&&startY===step&&interrupt){interrupt=false;throw new Error('interrupted continuation');}
      const name=randomUUID()+'.png',pixels=PNG.sync.write({width:1,height:1,data:Buffer.from([1,2,3,255])});
      const observation={action:'take_page_screenshots',file:name,url:slot.url,role:slot.role,viewport:slot.viewport,settlement:{settled:true},position:{url:slot.url,scrollX:0,scrollY:startY,documentHeight:height+step,viewportWidth:slot.viewport==='mobile'?390:1440,viewportHeight:height},capture:{id:randomUUID(),index:1,scope:'page',policy:evaluationCapturePolicy},binding:{taskId:f.task.id,siteRevision:f.task.siteRevision,inputVersionId:f.task.versionId,sourceSnapshotId:f.task.id,capturePolicy:evaluationCapturePolicy}};
      for(const [file,bytes,type] of [[name,pixels,'image/png'],[name.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(f.work,'evidence',file),bytes);f.artifacts.push({id:randomUUID(),name:file,size:bytes.length,sha256:hash(bytes),type,role:slot.role,viewport:slot.viewport,settled:true});}
      return {action:'take_page_screenshots',status:startY?'complete':'partial',coverageComplete:startY>0,screenshots:[observation],gaps:[],nextStartY:startY?null:step,nextSelectorIndex:null};
    };
    const input={...f,manifest:undefined,target:'https://target.test/',reference:'',signal:new AbortController().signal,capture,checkpoint:()=>{}};
    const first=await captureTemplate(input);assert.equal(first.progress[0].state,'unverified');assert.equal(first.progress[0].files.length,2);assert.equal(first.progress[0].nextStartY,850);
    assert.equal(first.progress[1].coverageComplete,true);assert.equal(first.progress[1].files.length,4);
    const second=await captureTemplate(input);assert.equal(second.progress[0].coverageComplete,true);assert.equal(second.progress[0].files.length,4);assert.equal(second.progress[1].state,'reused');
    assert.deepEqual(requests,['desktop:0','desktop:850','mobile:0','mobile:717','desktop:850']);
    await captureTemplate(input);assert.equal(requests.length,5,'verified multi-frame caches are reused');
    const key=second.slots[0].key,row=f.db.prepare('SELECT json FROM auto_template_captures WHERE key=?').get(key)!;
    const saved=JSON.parse(row.json);f.db.prepare('UPDATE auto_template_captures SET json=? WHERE key=?').run(JSON.stringify(saved.files.slice(0,2)),key);
    await captureTemplate(input);assert.deepEqual(requests.slice(-2),['desktop:0','desktop:850'],'legacy pair cannot stand in for page coverage');
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

test('criteria-desktop and criteria-mobile checkpoints stay cached when extend_manifest expands manifest during completeness review',async()=>{
  const f=fixture();try{
    f.manifest={...f.manifest,items:[{...f.manifest.items[0],paths:Array.from({length:8},(_,i)=>'/p-'+i)},f.manifest.items[1]]};
    const executed:string[]=[];let prepared=0,expanded=false;
    const validate=(raw:any)=>({...raw,completeness:Array.isArray(raw.completeness)?{checks:raw.completeness}:raw.completeness}) as AutomationReport;
    const review=async(batch:ReturnType<typeof templateReviewBatches>[number])=>{
      executed.push(batch.id);
      if(batch.id==='completeness-1'&&!expanded){
        expanded=true;
        f.manifest={...f.manifest,id:randomUUID(),revision:2,items:[...f.manifest.items,{id:'faq',title:'FAQ',kind:'page',required:true,source:'extended',expectation:'FAQ page',paths:['/faq'],viewports:['desktop','mobile'],expectedCount:1}]};
      }
      return {
        summary:batch.id,
        assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:90,passed:true,reason:'Reviewed',evidence:[]}))),
        issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},quality:'passed',scores:[],artifacts:[],
        ...(batch.manifest?{completeness:{manifestId:batch.manifest.id,manifestRevision:batch.manifest.revision,sourceComplete:true,state:'complete',checks:batch.manifest.items.map(item=>({id:item.id,status:'verified',reason:'Checked',evidence:[],checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]}))}}:{})
      } as AutomationReport;
    };
    const result=await reviewTemplateBatches({...f,manifest:()=>f.manifest,prepare:async()=>{prepared++;},validate,review});
    assert.equal(prepared,1);
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1','completeness-1','completeness-2','completeness-3'],'criteria-desktop and criteria-mobile checkpoints are NOT re-executed when completeness-1 extends manifest');
    assert.deepEqual(result.completeness!.map(c=>c.id),['pages','cars','faq']);
    assert.equal(result.assessments.length,f.task.rule!.criteria.filter(c=>c.scopes.includes(f.task.scope)).flatMap(c=>c.viewports).length);

    // Also verify unaffected earlier completeness chunks stay cached when a later completeness batch extends manifest.
    f.task.siteRevision='r2';executed.length=0;prepared=0;let expandedLate=false;
    await reviewTemplateBatches({...f,manifest:()=>f.manifest,prepare:async()=>{prepared++;},validate,review:async batch=>{
      if(batch.id==='completeness-3'&&!expandedLate){
        expandedLate=true;
        f.manifest={...f.manifest,id:randomUUID(),revision:3,items:[...f.manifest.items,{id:'contact',title:'Contact',kind:'page',required:true,source:'extended',expectation:'Contact page',paths:['/contact'],viewports:['desktop','mobile'],expectedCount:1}]};
      }
      return review(batch);
    }});
    assert.equal(prepared,1);
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1','completeness-2','completeness-3','completeness-3']);
  }finally{f.close();}
});

test('extend_manifest invalidates cached batches carrying stale coverage.unverified, outOfScope or completeness issues while keeping clean checkpoints cached',async()=>{
  // Case A: criteria-desktop records coverage.unverified under manifest v1, criteria-mobile is clean; completeness-1 extends manifest to v2 adding /faq.
  const a=fixture();try{
    a.manifest={...a.manifest,sourceComplete:false,limitations:['FAQ 待核实'],items:[a.manifest.items[0]]};
    const observations:Record<string,{url:string;role:string;viewport:string}>={};
    const registerPaths=(paths:string[])=>{
      for(const path of paths)for(const viewport of ['desktop','mobile'] as const){
        const url='https://target.test'+path;
        if(Object.values(observations).some(o=>o.url===url&&o.viewport===viewport))continue;
        const name=randomUUID()+'.png';
        a.artifacts.push({id:randomUUID(),name,type:'image/png',size:1,sha256:'a'.repeat(64),role:'target',viewport,settled:true});
        observations[name]={url,role:'target',viewport};
      }
    };
    registerPaths(['/','/about?x=1']);
    const validate=(raw:unknown,batch:{task:AutomationTask;manifest?:RequirementManifest})=>validateResult(raw,batch.task,a.artifacts,80,false,batch.manifest,observations,'https://target.test/');
    const executed:string[]=[];let expanded=false;
    const merged=await reviewTemplateBatches({
      ...a,manifest:()=>a.manifest,prepare:async()=>{registerPaths(['/faq']);},validate,
      review:async batch=>{
        executed.push(batch.id);
        if(batch.id==='completeness-1'&&!expanded){
          expanded=true;
          a.manifest={...a.manifest,id:randomUUID(),revision:2,sourceComplete:true,limitations:[],items:[...a.manifest.items,{id:'faq',title:'FAQ',kind:'page',required:true,source:'extended',expectation:'FAQ page',paths:['/faq'],viewports:['desktop','mobile'],expectedCount:1}]};
        }
        const raw={
          summary:batch.id,
          assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({
            criterionId:c.id,viewport,score:90,passed:true,reason:'Reviewed',
            evidence:viewport==='business'?[a.artifacts[0].name]:Object.entries(observations).filter(([,o])=>o.viewport===viewport).slice(0,1).map(([name])=>name)
          }))),
          issues:[],
          coverage:batch.id==='criteria-desktop'&&!expanded
            ?{verified:['hero checked'],unverified:['FAQ 未纳入清单'],outOfScope:[]}
            :batch.id==='criteria-mobile'
            ?{verified:['mobile hero checked'],unverified:[],outOfScope:[]}
            :{verified:['scope verified'],unverified:[],outOfScope:[]},
          ...(batch.manifest?{completeness:batch.manifest.items.map(item=>({
            id:item.id,status:'verified' as const,reason:'Checked',
            evidence:Object.entries(observations).filter(([,o])=>item.paths.some(p=>new URL(o.url).pathname+new URL(o.url).search===p)).map(([name])=>name),
            checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]
          }))}:{})
        };
        return validate(raw,batch);
      }
    });
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1','criteria-desktop','completeness-1'],'criteria-mobile stays cached while stale criteria-desktop is invalidated and re-reviewed under manifest v2');
    assert.deepEqual(merged.coverage.unverified,[]);
    const finalReport=validateResult(merged,a.task,a.artifacts,80,false,a.manifest,observations,'https://target.test/');
    assert.deepEqual(finalReport.coverage.unverified,[]);
    assert.equal(finalReport.completeness!.state,'complete');
    assert.equal(finalReport.quality,'passed');
  }finally{a.close();}

  // Case B: earlier completeness-1 chunk (with unchanged items between v1 and v2) records coverage.unverified under v1 before completeness-2 adds faq into completeness-2.
  const b=fixture();try{
    const mkPage=(id:string,path:string)=>({id,title:id,kind:'page' as const,required:true,source:'frozen',expectation:id,paths:[path],viewports:['desktop','mobile'] as ('desktop'|'mobile')[],expectedCount:1});
    b.manifest={...b.manifest,sourceComplete:true,limitations:[],items:[mkPage('p1','/p1'),mkPage('p2','/p2'),mkPage('p3','/p3'),mkPage('p4','/p4'),mkPage('p5','/p5')]};
    const observations:Record<string,{url:string;role:string;viewport:string}>={};
    const registerPaths=(paths:string[])=>{
      for(const path of paths)for(const viewport of ['desktop','mobile'] as const){
        const url='https://target.test'+path;
        if(Object.values(observations).some(o=>o.url===url&&o.viewport===viewport))continue;
        const name=randomUUID()+'.png';
        b.artifacts.push({id:randomUUID(),name,type:'image/png',size:1,sha256:'b'.repeat(64),role:'target',viewport,settled:true});
        observations[name]={url,role:'target',viewport};
      }
    };
    registerPaths(['/p1','/p2','/p3','/p4','/p5']);
    const validate=(raw:unknown,batch:{task:AutomationTask;manifest?:RequirementManifest})=>validateResult(raw,batch.task,b.artifacts,80,false,batch.manifest,observations,'https://target.test/');
    const executed:string[]=[];let expanded=false;
    const merged=await reviewTemplateBatches({
      ...b,manifest:()=>b.manifest,prepare:async()=>{registerPaths(['/faq']);},validate,
      review:async batch=>{
        executed.push(batch.id);
        if(batch.id==='completeness-2'&&!expanded){
          expanded=true;
          b.manifest={...b.manifest,id:randomUUID(),revision:2,sourceComplete:true,limitations:[],items:[...b.manifest.items,mkPage('faq','/faq')]};
        }
        const raw={
          summary:batch.id,
          assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({
            criterionId:c.id,viewport,score:92,passed:true,reason:'Reviewed',
            evidence:viewport==='business'?[b.artifacts[0].name]:Object.entries(observations).filter(([,o])=>o.viewport===viewport).slice(0,1).map(([name])=>name)
          }))),
          issues:[],
          coverage:batch.id==='completeness-1'&&!expanded
            ?{verified:['p1..p4 checked'],unverified:['FAQ 未纳入清单'],outOfScope:[]}
            :{verified:['clean'],unverified:[],outOfScope:[]},
          ...(batch.manifest?{completeness:batch.manifest.items.map(item=>({
            id:item.id,status:'verified' as const,reason:'Checked',
            evidence:Object.entries(observations).filter(([,o])=>item.paths.includes(new URL(o.url).pathname)).map(([name])=>name),
            checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]
          }))}:{})
        };
        return validate(raw,batch);
      }
    });
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1','completeness-2','completeness-1','completeness-2'],'completeness-1 is invalidated and re-reviewed in pass=1 when it carried stale coverage.unverified from manifest v1');
    assert.deepEqual(merged.coverage.unverified,[]);
    assert.deepEqual(merged.completeness!.map(c=>c.id),['p1','p2','p3','p4','p5','faq']);
    const finalReport=validateResult(merged,b.task,b.artifacts,80,false,b.manifest,observations,'https://target.test/');
    assert.deepEqual(finalReport.coverage.unverified,[]);
    assert.equal(finalReport.completeness!.state,'complete');
    assert.equal(finalReport.quality,'passed');

    // Also verify outOfScope on criteria and issues on completeness chunks invalidate across manifest expansion while clean criteria stay cached.
    b.task.siteRevision='r2';executed.length=0;let expandedR2=false;
    const mergedR2=await reviewTemplateBatches({
      ...b,manifest:()=>b.manifest,prepare:async()=>{registerPaths(['/terms']);},validate,
      review:async batch=>{
        executed.push(batch.id);
        if(batch.id==='completeness-2'&&!expandedR2){
          expandedR2=true;
          b.manifest={...b.manifest,id:randomUUID(),revision:3,sourceComplete:true,limitations:[],items:[...b.manifest.items,mkPage('terms','/terms')]};
        }
        const raw={
          summary:batch.id,
          assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({
            criterionId:c.id,viewport,score:92,passed:true,reason:'Reviewed',
            evidence:viewport==='business'?[b.artifacts[0].name]:Object.entries(observations).filter(([,o])=>o.viewport===viewport).slice(0,1).map(([name])=>name)
          }))),
          issues:batch.id==='completeness-1'&&!expandedR2?[{severity:'minor' as const,title:'Terms link',detail:'Terms not in manifest yet',evidence:[b.artifacts[0].name]}]:[],
          coverage:batch.id==='criteria-desktop'&&!expandedR2
            ?{verified:['desktop'],unverified:[],outOfScope:['Terms 不在当前清单范围']}
            :{verified:['clean'],unverified:[],outOfScope:[]},
          ...(batch.manifest?{completeness:batch.manifest.items.map(item=>({
            id:item.id,status:'verified' as const,reason:'Checked',
            evidence:Object.entries(observations).filter(([,o])=>item.paths.includes(new URL(o.url).pathname)).map(([name])=>name),
            checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]
          }))}:{})
        };
        return validate(raw,batch);
      }
    });
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1','completeness-2','criteria-desktop','completeness-1','completeness-2']);
    assert.deepEqual(mergedR2.coverage.outOfScope,[]);
    assert.deepEqual(mergedR2.issues,[]);
  }finally{b.close();}
});

test('reviewTemplateBatches yields via EvaluationSliceYield at batch boundaries and AutomationWorker re-queues without followup while renewing timeouts on batch progress',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;try{
    const executed:string[]=[];
    const validate=(raw:any)=>({...raw,completeness:Array.isArray(raw.completeness)?{checks:raw.completeness}:raw.completeness}) as AutomationReport;
    const input={...f,maxSliceMs:0,manifest:()=>f.manifest,prepare:async()=>{},validate,review:async(batch:ReturnType<typeof templateReviewBatches>[number])=>{
      executed.push(batch.id);
      return {
        summary:batch.id,
        assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:88,passed:true,reason:'Checked',evidence:[]}))),
        issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},quality:'passed',scores:[],artifacts:[],
        ...(batch.manifest?{completeness:{checks:batch.manifest.items.map(item=>({id:item.id,status:'verified',reason:'Checked',evidence:[],checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:item.paths,checkedKeys:[]}))}}:{})
      } as AutomationReport;
    }};
    await assert.rejects(reviewTemplateBatches(input),EvaluationSliceYield);
    assert.deepEqual(executed,['criteria-desktop']);
    await assert.rejects(reviewTemplateBatches(input),EvaluationSliceYield);
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile']);
    const merged=await reviewTemplateBatches(input);
    assert.deepEqual(executed,['criteria-desktop','criteria-mobile','completeness-1']);
    assert.equal(merged.completeness?.length,2);

    f.task.status='completed';f.task.stopped=true;f.store.put(f.task);
    const vault=new Vault(resolve(f.directory,'vault'));
    const siteId=randomUUID();
    f.store.saveSite({id:siteId,resourceId:f.task.resourceId,versionId:f.task.versionId,environmentId:f.task.environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:1});
    const settings={...structuredClone(defaultAutomationSettings),enabled:true,timeoutMinutes:1.35/60,followup:{...defaultAutomationSettings.followup,enabled:true}};
    vault.updateAutomation(settings);
    const evalTask=f.store.create({resourceIds:[f.task.resourceId],kind:'evaluation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:siteId,requirements:''},settings)[0];
    evalTask.siteRevision='rev-slice';f.store.put(evalTask);
    let runs=0,followupCalls=0;
    worker=new AutomationWorker(f.store,vault,f.directory,{
      generation:async()=>{},
      evaluation:async(task,store,_vault,_dir,signal)=>{
        runs++;
        store.db.exec('CREATE TABLE IF NOT EXISTS auto_template_review_batches(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,json TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0)');
        if(runs===1){
          store.db.prepare('INSERT OR REPLACE INTO auto_template_review_batches(key,task_id,json,updated_at) VALUES(?,?,?,?)').run('b1',task.id,'{}',Date.now());
          vault.updateAutomation({...settings,enabled:false});
          throw new EvaluationSliceYield('已完成本时间片评测批次并保存检查点，自动接续剩余批次');
        }
        await new Promise(r=>setTimeout(r,600));
        signal.throwIfAborted();
        store.db.prepare('INSERT OR REPLACE INTO auto_template_review_batches(key,task_id,json,updated_at) VALUES(?,?,?,?)').run('b2',task.id,'{}',Date.now());
        await new Promise(r=>setTimeout(r,950));
        signal.throwIfAborted();
        task.report={summary:'Done',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'passed',artifacts:[]};
      }
    },()=>true,async()=>{followupCalls++;return {action:'interrupt',reason:'unexpected followup',evidence:['e']};});

    await worker.tick();
    while(worker.owns(evalTask.id))await new Promise(r=>setTimeout(r,20));
    const yielded=f.store.task(evalTask.id)!;
    assert.equal(yielded.status,'queued','EvaluationSliceYield re-queues task directly without scheduling followup');
    assert.equal(yielded.stopped,true);
    assert.equal(yielded.error,'');
    assert.equal(yielded.followup,undefined);
    assert.equal(followupCalls,0);

    vault.updateAutomation({...settings,enabled:true});
    await worker.tick();
    while(worker.owns(evalTask.id))await new Promise(r=>setTimeout(r,20));
    const completed=f.store.task(evalTask.id)!;
    assert.equal(runs,2);
    assert.equal(completed.status,'completed','progress-aware timeout renewal prevents mid-batch abort when checkpoints advance');
    assert.equal(followupCalls,0);
  }finally{await worker?.stop();f.close();}
});

test('intermediate optimization round evaluations defer reflection while active and record skipped runs once superseded',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;try{
    const vault=new Vault(resolve(f.directory,'vault'));
    const learning={...defaultLearningSettings,collect:true,use:false};
    const settings={...structuredClone(defaultAutomationSettings),enabled:true,learning};
    vault.updateAutomation(settings);
    const siteId=randomUUID();
    f.store.saveSite({id:siteId,resourceId:f.task.resourceId,versionId:f.task.versionId,environmentId:f.task.environmentId,siteId:randomUUID(),name:'OptTarget',url:'https://target.test/',createdAt:1});
    const root=f.store.create({resourceIds:[f.task.resourceId],kind:'generation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:siteId,requirements:'',optimization:{targetScore:90,maxRounds:3}},settings)[0];
    root.learningPolicy=structuredClone(learning);root.status='completed';root.stopped=true;f.store.put(root);

    const makeEval=(round:number,summary:string)=>{
      const ev=f.store.create({resourceIds:[f.task.resourceId],kind:'evaluation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:siteId,requirements:'',parentId:root.id,optimizationRootId:root.id,optimizationRound:round},settings)[0];
      ev.learningPolicy=structuredClone(learning);ev.siteRevision=`rev-${round}`;ev.status='completed';ev.stopped=true;
      ev.report={summary,assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[{viewport:'desktop',value:70+round*10},{viewport:'mobile',value:70+round*10}],quality:round===2?'passed':'failed',artifacts:[]};
      f.store.put(ev);return ev;
    };

    const eval0=makeEval(0,'Round 0 report');
    const eval1=makeEval(1,'Round 1 report');
    root.optimization!.rounds=[
      {number:0,revision:'rev-0',generationTaskId:root.id,evaluationTaskId:eval0.id,startedAt:1},
      {number:1,revision:'rev-1',generationTaskId:root.id,evaluationTaskId:eval1.id,startedAt:2},
    ];
    root.optimization!.state='planning';
    root.optimization!.reportId=eval1.id;
    f.store.put(root);

    const experiences=new ExperienceStore(f.store);
    const reflected:string[]=[];
    worker=new AutomationWorker(f.store,vault,f.directory,{generation:async()=>{},evaluation:async()=>{}},()=>true,undefined,async run=>{
      reflected.push(run.taskId);
      run.status='completed';run.reason='Reflected final report';experiences.put(run);
    });

    syncReflectionCandidates(f.store,experiences);
    assert.equal(experiences.runs(eval0.id).total,0,'active optimization defers reflection queueing');
    assert.equal(experiences.runs(eval1.id).total,0,'active optimization defers reflection queueing');
    assert.equal(experiences.claim(),undefined);

    const eval2=makeEval(2,'Round 2 final report');
    root.optimization!.rounds.push({number:2,revision:'rev-2',generationTaskId:root.id,evaluationTaskId:eval2.id,startedAt:3});
    root.optimization!.state='completed';
    root.optimization!.reportId=eval2.id;
    root.optimization!.stoppedAt=Date.now();
    f.store.put(root);

    syncReflectionCandidates(f.store,experiences);
    const run0=experiences.runs(eval0.id).items[0]!;
    const run1=experiences.runs(eval1.id).items[0]!;
    const run2=experiences.runs(eval2.id).items[0]!;
    assert.equal(run0.status,'completed');assert.match(run0.reason,/跳过复盘/);
    assert.equal(run1.status,'completed');assert.match(run1.reason,/跳过复盘/);
    assert.equal(run2.status,'queued');
    assert.deepEqual(f.store.reflectionCandidates(),[]);

    await worker.tick();
    while(worker.owns(run2.id))await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(reflected,[eval2.id],'only the final evaluation report is claimed for reflectExperience');
    assert.equal(experiences.claim(),undefined);
  }finally{await worker?.stop();f.close();}
});
