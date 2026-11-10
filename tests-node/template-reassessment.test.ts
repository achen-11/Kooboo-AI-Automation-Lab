import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { prepareTemplateReassessment, validateRechecks, finishTemplateReassessment } from '../server/automation/template-reassessment.js';
import { templateReviewBatches } from '../server/automation/template-review.js';
import { defaultAutomationSettings, type AutomationTask, type AutomationReport, type MaterialFile } from '../shared/automation.js';

function fixture(paths=['/about?lang=zh']){
  const directory=mkdtempSync(resolve(tmpdir(),'targeted-review-')),db=new Database(':memory:'),store=new AutomationStore(db),settings=structuredClone(defaultAutomationSettings);
  const resource=store.saveResource({name:'Template',scenario:'site-template',description:'test',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalSource:'',externalId:''});
  const root=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},settings)[0];root.generatedSiteId=randomUUID();store.put(root);
  store.saveSite({id:root.generatedSiteId,siteId:randomUUID(),environmentId:root.environmentId,resourceId:resource.id,versionId:root.versionId,name:'Target',url:'https://target.test/',createdAt:1});
  const baseline=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId:root.environmentId,generatedSiteId:root.generatedSiteId,parentId:root.id,optimizationRootId:root.id,requirements:''},settings)[0];
  baseline.siteRevision='old';baseline.rule={...baseline.rule!,criteria:[{id:'visual',label:'Visual',weight:100,instruction:'Compare',required:true,viewports:['desktop','mobile'],scopes:['site']}]};
  const manifest=new ManifestStore(store).save(baseline,{sourceComplete:true,limitations:[],evidence:[],items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'frozen',expectation:'dual viewport',paths,viewports:['desktop','mobile'],expectedCount:paths.length}]},'human');
  const repair=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:root.environmentId,generatedSiteId:root.generatedSiteId,parentId:root.id,optimizationRootId:root.id,requirements:''},settings)[0];repair.repairEvidence={reportId:baseline.id,files:[]};store.put(repair);
  const task=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId:root.environmentId,generatedSiteId:root.generatedSiteId,parentId:repair.id,optimizationRootId:root.id,requirements:''},settings)[0];task.siteRevision='new';task.rule=structuredClone(baseline.rule);task.requirementsId=manifest.id;
  const work=(t:AutomationTask)=>resolve(directory,'automation-runs',t.id);
  for(const t of [baseline,task]){mkdirSync(resolve(work(t),'evidence'),{recursive:true});t.artifacts=[];}
  const file=(t:AutomationTask,name:string,bytes:Buffer,meta:Partial<MaterialFile>)=>{const f={id:randomUUID(),name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),type:'application/json',...meta} as MaterialFile;writeFileSync(resolve(work(t),'evidence',name),bytes);t.artifacts!.push(f);store.put(t);return f.name;};
  const image=(t:AutomationTask,viewport:'desktop'|'mobile',pixels='same',extra:Record<string,unknown>={})=>{const name=randomUUID()+'.png';file(t,name,Buffer.from(pixels),{type:'image/png',role:'target',viewport});file(t,name.replace('.png','.json'),Buffer.from(JSON.stringify({file:name,role:'target',viewport,url:'https://target.test/about?lang=zh',text:'About',action:'navigate',navigationStatus:200,settlement:{settled:true},binding:{taskId:t.id,siteRevision:t.siteRevision,inputVersionId:t.versionId,capturePolicy:'test'},...extra})),{role:'target',viewport});return name;};
  const implementation=(t:AutomationTask,value:unknown,request={kind:'pages',page:1})=>file(t,'implementation-'+randomUUID()+'.json',Buffer.from(JSON.stringify({value,request,binding:{taskId:t.id,siteRevision:t.siteRevision}})),{role:'target'});
  const desktop=image(baseline,'desktop'),mobile=image(baseline,'mobile');image(task,'desktop');image(task,'mobile');
  baseline.report={summary:'baseline',assessments:['desktop','mobile'].map((viewport,index)=>({criterionId:'visual',viewport,score:90,passed:true,reason:'independent',evidence:[index?mobile:desktop]})),issues:[{severity:'major',title:'Clipped text',detail:'About mobile clipped',evidence:[mobile]}],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'failed',artifacts:baseline.artifacts!,completeness:{manifestId:manifest.id,manifestRevision:manifest.revision,sourceComplete:true,state:'complete',checks:[{id:'pages',status:'verified',reason:'inspected',evidence:[desktop,mobile],checkedViewports:['desktop','mobile'],actualCount:1,sampledPaths:['/about?lang=zh'],checkedKeys:[]}]}} as AutomationReport;store.put(baseline);store.put(task);
  const prepare=()=>prepareTemplateReassessment({task,store,directory,work:work(task),manifest,batches:templateReviewBatches(task,manifest),files:task.artifacts!,readImplementation:async request=>{const evidence=implementation(task,{list:[]},request as any);return {evidence,result:{value:{list:[]}}};},signal:new AbortController().signal});
  return {store,task,baseline,manifest,directory,work,image,file,implementation,prepare,cleanup(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('equal current evidence inherits passed judgments; only explicit old problems remain for AI review',async()=>{
  const f=fixture();try{const p=await f.prepare();assert.ok(p);assert.deepEqual(p.inheritedAssessments,['visual:desktop','visual:mobile']);assert.deepEqual(p.inheritedRequirements,['pages']);assert.deepEqual(p.batches.map(b=>b.id),['regression-issues']);assert.deepEqual(p.targets.map(t=>t.id),['issue-1']);
    assert.ok(p.seeds[0].assessments.every(a=>a.evidence.every(name=>f.task.artifacts!.some(file=>file.name===name))),'old target filenames are rebound to current files');
  }finally{f.cleanup();}
});

test('changed mobile pixels retest mobile and dependent pages, preserving unchanged desktop',async()=>{
  const f=fixture();try{f.task.artifacts=f.task.artifacts!.filter(file=>file.viewport!=='mobile');f.image(f.task,'mobile','changed');const p=await f.prepare();assert.ok(p);assert.deepEqual(p.inheritedAssessments,['visual:desktop']);assert.deepEqual(p.inheritedRequirements,[]);assert.deepEqual(p.batches.map(b=>b.id),['criteria-mobile','completeness-1','regression-issues']);
  }finally{f.cleanup();}
});

test('manual reassessment uses its parent report as the baseline and bounds inherited explanations',async()=>{
  const f=fixture();try{f.task.parentId=f.baseline.id;f.baseline.report!.completeness!.checks[0].reason='x'.repeat(12000);f.store.put(f.baseline);f.store.put(f.task);
    const p=(await f.prepare())!;assert.ok(p);assert.equal(p.baseline.id,f.baseline.id);assert.deepEqual(p.batches.map(b=>b.id),['regression-issues']);assert.equal(p.seeds[0].completeness!.checks[0].reason.length,12000);
  }finally{f.cleanup();}
});

test('failed and unknown judgments are always rechecked even when pixels are identical',async()=>{
  const f=fixture();try{f.baseline.report!.assessments[1].passed=false;f.baseline.report!.assessments[1].score=70;f.baseline.report!.completeness!.checks[0].status='unverified';f.store.put(f.baseline);const p=await f.prepare();assert.ok(p);assert.deepEqual(p.inheritedAssessments,['visual:desktop']);assert.deepEqual(p.inheritedRequirements,[]);
  }finally{f.cleanup();}
});

test('one changed path does not force every path in a merged static-page requirement back into AI review',async()=>{
  const f=fixture(['/about?lang=zh','/contact']);try{
    const evidence=['desktop','mobile'].map(viewport=>f.image(f.baseline,viewport as 'desktop'|'mobile','contact',{url:'https://target.test/contact'}));
    for(const viewport of ['desktop','mobile'] as const)f.image(f.task,viewport,'contact',{url:'https://target.test/contact'});
    f.baseline.report!.completeness!.checks[0].evidence.push(...evidence);f.baseline.report!.completeness!.checks[0].sampledPaths.push('/contact');f.baseline.report!.artifacts=f.baseline.artifacts!;f.store.put(f.baseline);
    f.task.artifacts=f.task.artifacts!.filter(file=>file.viewport!=='mobile');
    f.image(f.task,'mobile','changed');f.image(f.task,'mobile','contact',{url:'https://target.test/contact'});
    const p=(await f.prepare())!;assert.deepEqual(p.inheritedPagePaths,[{id:'pages',paths:['/contact']}]);assert.deepEqual(p.batches.find(b=>b.manifest)?.manifest!.items[0].paths,['/about?lang=zh']);assert.deepEqual(p.seeds[0].completeness!.checks[0].sampledPaths,['/contact']);
  }finally{f.cleanup();}
});

for(const mutation of ['rules','workflow','input','manifest','hash','http','binding','interaction'] as const)test('inheritance refuses mismatched '+mutation,async()=>{
  const f=fixture();try{
    if(mutation==='rules')f.task.rule!.references+=' changed';
    if(mutation==='workflow')f.task.optimizationRootId=f.task.id;
    if(mutation==='input')f.task.versionId=randomUUID();
    if(mutation==='manifest')f.manifest.items[0].expectation+=' changed';
    if(mutation==='hash')writeFileSync(resolve(f.work(f.task),'evidence',f.task.artifacts![0].name),'tampered');
    if(['http','binding','interaction'].includes(mutation)){
      f.task.artifacts=f.task.artifacts!.filter(file=>file.viewport!=='mobile');
      f.image(f.task,'mobile','same',mutation==='http'?{navigationStatus:503}:mutation==='binding'?{binding:{taskId:'other',siteRevision:'new',inputVersionId:f.task.versionId}}:{text:'state changed'});
      if(mutation==='interaction')f.manifest.items[0].kind='interaction';
    }
    f.store.put(f.task);const p=await f.prepare();
    if(['rules','workflow','input'].includes(mutation))assert.equal(p,undefined,'incompatible baseline uses initial evaluation');
    else{assert.ok(p);if(mutation!=='manifest')assert.ok(p.inheritedAssessments.length<2);assert.deepEqual(p.inheritedRequirements,[]);}
  }finally{f.cleanup();}
});

test('backend proof must contain the same concrete value; two missing values cannot certify equality',async()=>{
  for(const value of [{list:[]},undefined,null,{list:['changed']}] as const){const f=fixture();try{
    const name=f.implementation(f.baseline,value);f.baseline.report!.assessments[0].evidence.push(name);f.baseline.report!.artifacts=f.baseline.artifacts!;f.store.put(f.baseline);
    const p=await f.prepare();assert.ok(p);assert.equal(p.inheritedAssessments.includes('visual:desktop'),value!==undefined&&value!==null&&'list' in value&&value.list.length===0);
  }finally{f.cleanup();}}
});

test('every original issue needs an exact response and current path/query/viewport proof',async()=>{
  const f=fixture();try{const p=(await f.prepare())!,proof=f.task.artifacts!.find(file=>file.type==='image/png'&&file.viewport==='mobile')!.name;
    const raw={rechecks:[{id:'issue-1',status:'resolved' as const,reason:'Actual current proof',evidence:[proof]}]};
    assert.doesNotThrow(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task));
    for(const bad of [{rechecks:[]},{rechecks:[...raw.rechecks,...raw.rechecks]},{rechecks:[{...raw.rechecks[0],id:'other'}]},{rechecks:[{...raw.rechecks[0],evidence:f.baseline.report!.issues[0].evidence}]},{rechecks:[{...raw.rechecks[0],evidence:[f.task.artifacts![0].name]}]}])assert.throws(()=>validateRechecks(bad,p.targets,f.task.artifacts!,f.work(f.task),f.task));
    f.task.artifacts=f.task.artifacts!.filter(file=>file.viewport!=='mobile');const wrong=f.image(f.task,'mobile','same',{url:'https://target.test/about?lang=en'});
    assert.throws(()=>validateRechecks({rechecks:[{...raw.rechecks[0],evidence:[wrong]}]},p.targets,f.task.artifacts!,f.work(f.task),f.task),/路径/);
  }finally{f.cleanup();}
});

test('reference-only original problem maps to target; missing original location cannot be silently resolved',async()=>{
  const f=fixture();try{
    const name=f.baseline.report!.issues[0].evidence[0],json=f.baseline.artifacts!.find(file=>file.name===name.replace('.png','.json'))!;
    f.baseline.artifacts!.find(file=>file.name===name)!.role='reference';
    f.baseline.artifacts=f.baseline.artifacts!.filter(file=>file.name!==json.name);f.file(f.baseline,json.name,Buffer.from(JSON.stringify({file:name,role:'reference',viewport:'mobile',url:'https://source.test/about?lang=zh'})),{role:'reference',viewport:'mobile'});f.baseline.report!.artifacts=f.baseline.artifacts!;f.store.put(f.baseline);
    const p=(await f.prepare())!;assert.equal(p.targets[0].locations[0].url,'https://target.test/about?lang=zh');
    const evidence=[f.task.artifacts!.find(file=>file.type==='image/png'&&file.viewport==='mobile')!.name],raw={rechecks:[{id:'issue-1',status:'resolved' as const,reason:'Verified',evidence}]};
    assert.doesNotThrow(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task));p.targets[0].locations=[];
    assert.throws(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task),/定位/);
    raw.rechecks[0].status='unverified' as any;assert.doesNotThrow(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task));
  }finally{f.cleanup();}
});

test('stateful problems require a recorded current action, not a fresh static screenshot',async()=>{
  const f=fixture();try{const p=(await f.prepare())!;p.targets[0].locations[0].interaction=true;
    const proof=f.task.artifacts!.find(file=>file.type==='image/png'&&file.viewport==='mobile')!.name;
    const raw={rechecks:[{id:'issue-1',status:'resolved' as const,reason:'After action',evidence:[proof]}]};
    assert.throws(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task),/操作/);
    raw.rechecks[0].evidence=[f.image(f.task,'mobile','action result',{action:'click'})];assert.doesNotThrow(()=>validateRechecks(raw,p.targets,f.task.artifacts!,f.work(f.task),f.task));
  }finally{f.cleanup();}
});

test('remaining severity and uncertainty survive aggregation; resolved requires explicit status',async()=>{
  const f=fixture();try{const p=(await f.prepare())!,raw={issues:[] as AutomationReport['issues'],coverage:{verified:[],unverified:[],outOfScope:[]},rechecks:[{id:'issue-1',status:'remaining' as const,reason:'Still clipped',evidence:['current.png']}]};
    const remaining=finishTemplateReassessment(raw,p);assert.equal(remaining.issues.length,1);assert.equal(remaining.issues[0].severity,'major');assert.equal(remaining.review!.baselineTaskId,f.baseline.id);assert.equal(raw.issues.length,0);
    const unknown=finishTemplateReassessment({...raw,rechecks:[{...raw.rechecks[0],status:'unverified' as const}]},p);assert.equal(unknown.coverage.unverified.length,1);
    assert.throws(()=>finishTemplateReassessment({...raw,rechecks:[]},p),/闭环/);
  }finally{f.cleanup();}
});
