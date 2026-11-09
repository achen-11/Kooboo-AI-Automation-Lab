import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { RequirementCheck } from '../shared/completeness.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { collectionProgramEvidence, collectionProgramArtifacts, checkpointCollectionProgramReview, pendingCollectionProgramReview, clearCollectionProgramReview, mergeCollectionTargetReport, checkpointCollectionReport, finishPendingCollectionReport } from '../server/automation/collection/report.js';
import { collectionEvaluationManifest, dataIdentityEvaluationContract, prepareCollectionProgramEvaluation, reviewWithValidation, validatedEvaluationEvidence, validateResult } from '../server/automation/evaluator.js';
import { CollectionBlocked, CollectionPending } from '../server/automation/collection/errors.js';
import { COLLECTION_TARGET_VERIFIER_VERSION, type VerifyCollectionTargetOptions } from '../server/automation/collection/target-verification.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { sourceRenderedEvidenceIndex, sourceRenderedEvidencePath } from '../server/automation/collection/source-rendered.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
function fixture(options:{sourceComplete?:boolean;visualData?:boolean;staticPage?:boolean;rendered?:boolean}={}){
  const directory=mkdtempSync(resolve(tmpdir(),'collection-program-evaluation-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory);
  const resource=store.saveResource({name:'Frozen source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},structuredClone(defaultAutomationSettings))[0];
  task.rule!.criteria=[{id:'business',label:'Semantics',weight:100,instruction:'Independent semantic review',required:true,viewports:['business'],scopes:['site']}];
  const keys=['https://source.invalid/1','https://source.invalid/2'];
  const manifest=new ManifestStore(store).save(task,{sourceComplete:options.sourceComplete??true,limitations:options.sourceComplete===false?['Unknown source coverage']:[],evidence:[],items:[{id:'records',title:'Records',kind:'data',required:true,source:'frozen',expectation:'Full record identity set',paths:[],expectedCount:keys.length,expectedKeys:keys,viewports:options.visualData?['business','desktop','mobile']:['business']},...(options.staticPage?[{id:'static',title:'Static',kind:'page' as const,required:true,source:'frozen',expectation:'Both actual viewports',paths:['/1'],expectedCount:1,viewports:['desktop' as const,'mobile' as const]}]:[])]},'human');
  const collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const documents=new Map<string,string>(),urls:Record<string,unknown>={};
  keys.forEach((url,index)=>{const id='u'+index,path=new URL(url).pathname,title='Original '+index,body='Frozen full body '+index,html=`<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;documents.set(path,html);write('.work/raw/'+id+'.html',html);write('.work/extract/'+id+'.json',{url,title,fullText:title+'\n'+body,pageType:'detail',links:[]});urls[id]={id,url,path,action:'keep',status:200,rawFile:'.work/raw/'+id+'.html'};});
  write('.work/state.json',{source:run.sourceUrl,urls});write('site/pages.json',[]);
  if(options.rendered){
    const id=randomUUID(),folder='site/source-rendered/'+id,text='Original 0\nFrozen full body 0';
    write(folder+'/observation.json',{action:'snapshot',role:'content',viewport:'desktop',url:keys[0],title:'Original 0',text,snapshot:'- main: Original',file:randomUUID()+'.png',capturedAt:1,frames:[],framesComplete:true,textTruncated:false});write(folder+'/screenshot.png',png);
    run.sourceRenderedEvidence=[{id,collectionId:run.id,inputVersionId:task.versionId,engineVersion:run.engineVersion,pageId:'u0',url:keys[0],rawPath:'.work/raw/u0.html',rawSha256:collectionHash(collections.read(run,'.work/raw/u0.html')),extractPath:'.work/extract/u0.json',extractSha256:collectionHash(collections.read(run,'.work/extract/u0.json')),observationPath:folder+'/observation.json',observationSha256:collectionHash(collections.read(run,folder+'/observation.json')),screenshotPath:folder+'/screenshot.png',screenshotSha256:collectionHash(png),capturedAt:1,viewport:'desktop',text,visibleText:text,frames:[],framesComplete:true,textTruncated:false}];write(sourceRenderedEvidencePath,sourceRenderedEvidenceIndex(run));
  }
  run.review={action:'ready',discoveryBasis:'frozen originals'};run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'reviewed',evidence:[]}));collections.freeze(run,task,manifest.id);
  task.generatedSiteId=randomUUID();task.siteUrl='https://target.invalid/';store.saveSite({id:task.generatedSiteId,resourceId:task.resourceId,versionId:task.versionId,environmentId:'environment',siteId:'physical',name:'Target',url:task.siteUrl,createdAt:1});store.beginSiteChange(task);
  let inventoryComplete=true;const httpRequests:string[]=[],backendRequests:unknown[]=[];
  const verify:VerifyCollectionTargetOptions={task,manifest,store,vault,directory,signal:AbortSignal.timeout(20000),dependencies:{readHttp:async url=>{httpRequests.push(url.href);return {status:200,body:documents.get(url.pathname)!};},inspect:async(_task,_store,_vault,_signal,raw)=>{const spec=raw as any;backendRequests.push(spec);const value=spec.kind==='folders'?[]:spec.kind==='tables'?['Records']:spec.kind==='rows'?{list:keys.map((sourceUrl,index)=>[{key:'id',value:index+1},{key:'sourceUrl',value:sourceUrl}]),pageNr:1,totalPages:1,totalCount:inventoryComplete?keys.length:keys.length+1}:undefined;if(value===undefined)throw new Error('Unexpected read');return {request:spec,value,capturedAt:1,note:''};}}};
  const raw=(evidence:string,checks:RequirementCheck[]=[])=>({summary:'Independent semantic review',assessments:[{criterionId:'business',viewport:'business',score:90,passed:true,reason:'Actual evidence reviewed',evidence:[evidence]}],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},completeness:checks});
  return {directory,db,store,vault,task,manifest,keys,verify,httpRequests,backendRequests,raw,setIncomplete(){inventoryComplete=false;},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('model omits all data keys while trusted host proof supplies the complete identity set',async()=>{
  const f=fixture();try{
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);assert.equal(program.target.state,'complete');
    const files=collectionProgramArtifacts(program.evidence,f.task),trusted=validatedEvaluationEvidence(f.task,files,resolve(f.directory,'automation-runs',f.task.id,'evidence'),f.task.siteUrl,f.store.site(f.task.generatedSiteId!),program.evidence);
    assert.equal(trusted.files.length,files.length);let calls=0;
    const report=await reviewWithValidation({prompt:dataIdentityEvaluationContract(true),task:f.task,files:()=>trusted.files,manifest:f.manifest,threshold:80,referenceRequired:false,programEvidence:program.evidence,onRepair:()=>assert.fail('No full-key repair should be needed'),run:async prompt=>{calls++;assert.match(prompt,/不要重建或抄写全部/);return JSON.stringify(f.raw(files[0].name));}});
    assert.equal(calls,1);assert.equal(report.quality,'passed');assert.deepEqual(report.completeness!.checks[0].checkedKeys,f.keys);assert.equal(report.completeness!.checks[0].actualCount,f.keys.length);assert.deepEqual(report.completeness!.checks[0].checkedViewports,['business']);
  }finally{f.close();}
});

test('program windows stop before a paid review and resume cached HTTP rather than repeating it',async()=>{
  const f=fixture();try{
    let paid=0;await assert.rejects(async()=>{await prepareCollectionProgramEvaluation({...f.verify,maxRequests:1});paid++;},error=>error instanceof CollectionPending);assert.equal(paid,0);assert.equal(f.httpRequests.length,1);
    await assert.rejects(prepareCollectionProgramEvaluation({...f.verify,maxRequests:1}),error=>error instanceof CollectionPending);assert.equal(f.httpRequests.length,2);
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.equal(program?.target.state,'complete');assert.equal(f.httpRequests.length,2);
  }finally{f.close();}
});

test('contract blockers stop before target reads and model calls, without claiming target defects',async()=>{
  const f=fixture();try{f.manifest.items[0].expectedCount=999;let paid=0;await assert.rejects(async()=>{await prepareCollectionProgramEvaluation(f.verify);paid++;},error=>error instanceof CollectionBlocked&&error.nextSteps.some(reason=>/数量/.test(reason)));assert.equal(paid,0);assert.equal(f.httpRequests.length,0);assert.equal(f.backendRequests.length,0);}finally{f.close();}
});

test('unregistered or changed program reports and forged capabilities cannot certify data',async()=>{
  const f=fixture();try{
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);const files=program.target.artifacts;
    assert.throws(()=>validateResult(f.raw(files[0].name),f.task,files,80,false,f.manifest,{},f.task.siteUrl,{},JSON.parse(JSON.stringify(program.evidence))),/不是宿主签发/);
    assert.throws(()=>collectionProgramEvidence(f.task,f.manifest,f.store,f.directory,{...program.target,id:randomUUID()}),/不一致/);
    assert.throws(()=>collectionProgramEvidence(f.task,f.manifest,f.store,f.directory,{...program.target,checks:[]}),/不一致/);
    const path=resolve(f.directory,'automation-runs',f.task.id,'evidence',files[0].name);writeFileSync(path,readFileSync(path).toString()+' ');
    assert.throws(()=>validateResult(f.raw(files[0].name),f.task,files,80,false,f.manifest,{},f.task.siteUrl,{},program.evidence),/字节已变化/);
  }finally{f.close();}
});

test('source coverage uncertainty and independent AI uncertainty are never promoted by a passing B check',async()=>{
  for(const sourceComplete of [true,false]){const f=fixture({sourceComplete});try{
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);const files=program.target.artifacts;
    const uncertain:RequirementCheck={id:'records',status:'unverified',reason:'Record semantics remain unverified',evidence:[],checkedViewports:[],actualCount:null,sampledPaths:[],checkedKeys:[]};
    const report=validateResult(f.raw(files[0].name,sourceComplete?[uncertain]:[]),f.task,files,80,false,f.manifest,{},f.task.siteUrl,{},program.evidence);mergeCollectionTargetReport(report,program.target);assert.equal(report.quality,'unverified');assert.equal(report.completeness!.state,'unverified');if(sourceComplete)assert.equal(report.completeness!.checks[0].status,'unverified');
  }finally{f.close();}}
});

test('incomplete backend proof stays unverified even if the model claims data verified',async()=>{
  const f=fixture();try{f.setIncomplete();const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);const files=program.target.artifacts;const ai:RequirementCheck={id:'records',status:'verified',reason:'Model says complete',evidence:[files[0].name],checkedViewports:['business'],actualCount:2,sampledPaths:[],checkedKeys:[]};const report=validateResult(f.raw(files[0].name,[ai]),f.task,files,80,false,f.manifest,{},f.task.siteUrl,{},program.evidence);assert.equal(report.completeness!.checks[0].status,'unverified');assert.equal(report.quality,'unverified');assert.equal(program.target.issues.length,0);}finally{f.close();}
});

test('host data completion does not fabricate desktop/mobile visual coverage or relax static page checks',async()=>{
  const f=fixture({visualData:true});try{const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);const files=program.target.artifacts,report=validateResult(f.raw(files[0].name),f.task,files,80,false,f.manifest,{},f.task.siteUrl,{},program.evidence);assert.equal(report.completeness!.checks[0].status,'unverified');assert.ok(!report.completeness!.checks[0].checkedViewports.includes('desktop'));assert.ok(!report.completeness!.checks[0].checkedViewports.includes('mobile'));}finally{f.close();}
  const g=fixture({staticPage:true});try{const program=await prepareCollectionProgramEvaluation(g.verify);assert.ok(program);const files=program.target.artifacts;assert.throws(()=>validateResult(g.raw(files[0].name),g.task,files,80,false,g.manifest,{},g.task.siteUrl,{},program.evidence),/逐项对应冻结清单/);const page:RequirementCheck={id:'static',status:'verified',reason:'Claimed screenshot review',evidence:[files[0].name],checkedViewports:['desktop','mobile'],actualCount:1,sampledPaths:['/1'],checkedKeys:[]};assert.throws(()=>validateResult(g.raw(files[0].name,[page]),g.task,files,80,false,g.manifest,{},g.task.siteUrl,{},program.evidence),/真实截图/);}finally{g.close();}
});

test('host model-response checkpoint survives store reload and rejects changed input, rule or site',()=>{
  const f=fixture();try{const raw=f.raw('actual.json');checkpointCollectionProgramReview(f.task,f.store,raw);assert.deepEqual(pendingCollectionProgramReview(f.store.task(f.task.id)!,f.store),raw);for(const changed of [{versionId:'other'},{collectionVersionId:'other'},{siteRevision:'other'},{requirementsId:'other'},{rule:{...f.task.rule!,hash:'other'}}])assert.equal(pendingCollectionProgramReview({...f.task,...changed},f.store),undefined);clearCollectionProgramReview(f.task,f.store);assert.equal(pendingCollectionProgramReview(f.task,f.store),undefined);}finally{f.close();}
});

test('legacy verifier reports and model checkpoints cannot certify a new verifier algorithm',async()=>{
  const f=fixture();try{
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);const old={...program.target,verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION-1};
    f.store.db.prepare('UPDATE auto_collection_target_reports SET json=? WHERE id=?').run(JSON.stringify(old),old.id);
    assert.throws(()=>collectionProgramEvidence(f.task,f.manifest,f.store,f.directory,old),/不一致/);
    const raw=f.raw('actual.json');checkpointCollectionProgramReview(f.task,f.store,raw);
    const legacyBinding=collectionHash(JSON.stringify({task:f.task.id,input:f.task.versionId,collection:f.task.collectionId,snapshot:f.task.collectionVersionId,manifest:new ManifestStore(f.store).get(f.task.requirementsId),site:f.task.generatedSiteId,physicalSite:f.store.site(f.task.generatedSiteId||'')?.siteId,revision:f.task.siteRevision,rule:f.task.rule?.hash}));
    for(const binding of [legacyBinding,collectionHash(JSON.stringify({verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION-1,task:f.task.id,input:f.task.versionId,collection:f.task.collectionId,snapshot:f.task.collectionVersionId,manifest:new ManifestStore(f.store).get(f.task.requirementsId),site:f.task.generatedSiteId,physicalSite:f.store.site(f.task.generatedSiteId||'')?.siteId,revision:f.task.siteRevision,rule:f.task.rule?.hash}))]){f.store.db.prepare('UPDATE auto_collection_program_reviews SET binding=? WHERE task_id=?').run(binding,f.task.id);assert.equal(pendingCollectionProgramReview(f.task,f.store),undefined);}
  }finally{f.close();}
});

test('default manifest context omits repetitive data paths and keys while preserving all static paths and template samples',()=>{
  const f=fixture({staticPage:true});try{f.manifest.items[0].paths=['/1','/2'];f.manifest.items[1].expectedKeys=['/1'];f.manifest.items.push({id:'template',title:'Template',kind:'template',required:true,source:'frozen',expectation:'Actual boundary views',paths:[],expectedCount:2,expectedKeys:[...f.keys],samples:['u0','/2'],viewports:['desktop','mobile']});const before=structuredClone(f.manifest),compact=collectionEvaluationManifest(f.manifest,{u0:'/1',u1:'/2'});assert.equal(compact.manifest.items[0].paths,undefined);assert.equal(compact.manifest.items[0].pathCount,2);assert.equal(compact.manifest.items[0].expectedKeys,undefined);assert.deepEqual(compact.manifest.items[1].paths,['/1']);assert.equal(compact.manifest.items[1].expectedKeys,undefined);assert.deepEqual(compact.manifest.items[2].samples,['u0','/2']);assert.deepEqual(compact.pageAliases,{u0:'/1'});assert.deepEqual(f.manifest,before);}finally{f.close();}
});

test('missing rendered observations allow independent review and final B rechecks new proof without a manifest change or repeated HTTP',async()=>{
  const f=fixture({rendered:true});try{
    const program=await prepareCollectionProgramEvaluation(f.verify);assert.ok(program);assert.equal(program.target.state,'unverified');assert.equal(program.target.checks.find(check=>check.id==='rendered:/1')?.status,'unverified');
    const work=resolve(f.directory,'automation-runs',f.task.id,'evidence');f.task.artifacts=[...program.target.artifacts];f.store.put(f.task);
    let paid=0;
    const report=await reviewWithValidation({prompt:dataIdentityEvaluationContract(true),task:f.task,files:()=>validatedEvaluationEvidence(f.task,f.task.artifacts!,work,f.task.siteUrl,f.store.site(f.task.generatedSiteId!),program.evidence).files,manifest:f.manifest,threshold:80,referenceRequired:false,programEvidence:program.evidence,onRepair:()=>assert.fail('No scoring retry is needed'),run:async()=>{
      paid++;const stem=randomUUID(),imageName=stem+'.png',jsonName=stem+'.json',json=Buffer.from(JSON.stringify({action:'snapshot',role:'target',viewport:'desktop',url:'https://target.invalid/1',title:'Original 0',text:'Original 0\nFrozen full body 0',snapshot:'- main: Original',frames:[],framesComplete:true,textTruncated:false,file:imageName,capturedAt:Date.now(),binding:{taskId:f.task.id,siteRevision:f.task.siteRevision}}));
      writeFileSync(resolve(work,imageName),png);writeFileSync(resolve(work,jsonName),json);
      const files:MaterialFile[]=[{id:randomUUID(),name:imageName,type:'image/png',size:png.length,sha256:collectionHash(png),role:'target',viewport:'desktop'},{id:randomUUID(),name:jsonName,type:'application/json',size:json.length,sha256:collectionHash(json),role:'target',viewport:'desktop'}];f.task.artifacts!.push(...files);f.store.put(f.task);
      return JSON.stringify({...f.raw(program.target.artifacts[0].name),coverage:{verified:[],unverified:['Interaction effects still require independent testing'],outOfScope:[]}});
    }});
    assert.equal(paid,1);assert.equal(checkpointCollectionReport(f.task,report,f.store),true);
    assert.equal(await finishPendingCollectionReport(f.task,f.store,f.vault,f.directory,f.verify.signal,f.verify.dependencies),true);
    assert.equal(f.task.report!.collectionTarget!.binding,program.target.binding);assert.equal(f.task.report!.collectionTarget!.manifestId,f.manifest.id);assert.equal(f.task.report!.collectionTarget!.state,'complete');assert.equal(f.task.report!.collectionTarget!.checks.find(check=>check.id==='rendered:/1')?.status,'verified');assert.equal(f.httpRequests.length,2);assert.equal(paid,1);assert.equal(f.task.report!.quality,'unverified');assert.ok(f.task.report!.coverage.unverified.includes('Interaction effects still require independent testing'));
  }finally{f.close();}
});

test('evaluation retries only failed reads after a completed scan and pending windows retain their scan progress',async()=>{
  const f=fixture();try{
    const originalRead=f.verify.dependencies!.readHttp!;let recovered=false;
    f.verify.dependencies!.readHttp=async(url,options)=>{if(url.pathname==='/1'&&!recovered){f.httpRequests.push(url.href);return {status:503,body:'Temporarily unavailable'};}return originalRead(url,options);};
    const boundedScan=async()=>{for(let window=0;window<10;window++){try{return await prepareCollectionProgramEvaluation({...f.verify,maxRequests:1,retryTransientFailures:true});}catch(error){if(!(error instanceof CollectionPending))throw error;}}assert.fail('Bounded scan did not progress to an outcome');};
    const first=await boundedScan();assert.equal(first?.target.state,'unverified');assert.deepEqual(f.httpRequests,['https://target.invalid/1','https://target.invalid/2']);
    assert.equal((await prepareCollectionProgramEvaluation(f.verify))?.target.state,'unverified');assert.equal(f.httpRequests.length,2);
    assert.ok(first);const independent=validateResult(f.raw(first.target.artifacts[0].name),f.task,first.target.artifacts,80,false,f.manifest,{},f.task.siteUrl,{},first.evidence);checkpointCollectionReport(f.task,independent,f.store);
    await finishPendingCollectionReport(f.task,f.store,f.vault,f.directory,f.verify.signal,f.verify.dependencies);assert.equal(f.task.report!.collectionTarget!.state,'unverified');assert.equal(f.httpRequests.length,2);
    recovered=true;
    // Match the entry's explicit retry flag on every bounded continuation, using only injected fixture reads.
    const current=await boundedScan();assert.equal(current?.target.state,'complete');
    assert.deepEqual(f.httpRequests,['https://target.invalid/1','https://target.invalid/2','https://target.invalid/1']);
    assert.equal(current?.target.binding,first?.target.binding);assert.equal((await prepareCollectionProgramEvaluation(f.verify))?.target.state,'complete');assert.equal(f.httpRequests.length,3);
  }finally{f.close();}
});
