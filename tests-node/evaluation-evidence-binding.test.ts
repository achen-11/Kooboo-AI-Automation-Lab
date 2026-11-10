import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import type { Page } from 'playwright';
import type { MaterialFile } from '../shared/automation.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { visibleFrameElement, visibleFrames, evaluationCapturePolicy } from '../server/automation/browser.js';
import { validatedEvaluationEvidence, validateResult } from '../server/automation/evaluator.js';
import { validateCompleteness } from '../server/automation/completeness.js';
import { inspectionTools } from '../server/automation/inspection-tools.js';
import { Vault } from '../server/lib/vault.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
const base='https://target.invalid/',path='/about?section=company',url=new URL(path,base).href;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'evaluation-binding-')),db=new Database(':memory:'),store=new AutomationStore(db);
  const resource=store.saveResource({name:'Evidence',scenario:'site-template',contentUrl:'https://source.invalid/',referenceUrl:'',description:'Source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];task.siteRevision='current-site-revision';task.generatedSiteId=randomUUID();
  const site={id:task.generatedSiteId,resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId:randomUUID(),name:'Target',url:base,createdAt:1};store.saveSite(site);store.put(task);
  const binding=()=>({kind:'implementation',version:1,taskId:task.id,inputVersionId:task.versionId,resourceId:task.resourceId,siteRevision:task.siteRevision,generatedSiteId:site.id,siteId:site.siteId,environmentId:site.environmentId,generatedSiteVersionId:site.versionId,targetUrl:base});
  const files:MaterialFile[]=[];
  const write=(name:string,bytes:Buffer,properties:Partial<MaterialFile>={})=>{writeFileSync(resolve(directory,name),bytes);const file:MaterialFile={id:randomUUID(),name,type:'application/json',size:bytes.length,sha256:hash(bytes),...properties};files.push(file);return file;};
  const pair=(changes:Record<string,unknown>={},viewport:'desktop'|'mobile'='desktop')=>{
    const id=randomUUID(),image=write(id+'.png',png,{type:'image/png',role:'target',viewport});
    const observation={role:'target',viewport,url,file:image.name,binding:{taskId:task.id,siteRevision:task.siteRevision},...changes};
    const json=write(id+'.json',Buffer.from(JSON.stringify(observation)),{role:'target',viewport});return {image,json,observation};
  };
  const implementation=(changes:Record<string,unknown>={})=>write('implementation-'+randomUUID()+'.json',Buffer.from(JSON.stringify({request:{kind:'pages',page:1},value:[],binding:binding(),...changes})),{role:'target'});
  return {directory,db,store,task,site,files,write,pair,binding,implementation,trusted(){return validatedEvaluationEvidence(task,files,directory,base,site);},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('trusted evaluation evidence keeps only current JSON/PNG pairs and preserves reference/content reuse',()=>{
  const f=fixture();try{
    const proof=f.pair(),reference=f.write('reference.json',Buffer.from('{"oldRevision":true}'),{role:'reference'}),content=f.write('source.json',Buffer.from('source bytes'),{role:'content'});
    const trusted=f.trusted();assert.deepEqual(trusted.files,f.files);assert.deepEqual(trusted.observations[proof.image.name],{url,role:'target',viewport:'desktop'});
    f.task.siteRevision='new-revision';const stale=f.trusted();assert.deepEqual(stale.files,[reference,content]);assert.deepEqual(stale.observations,{});
  }finally{f.close();}
});

test('template reference pixels require the same source snapshot, input, policy, origin and settled observation',()=>{
  const f=fixture();try{const snapshotId=randomUUID(),name=randomUUID()+'.png',image=f.write(name,png,{type:'image/png',role:'reference',viewport:'desktop'}),observation={role:'reference',viewport:'desktop',url:'https://source.invalid/',file:name,binding:{sourceSnapshotId:snapshotId,inputVersionId:f.task.versionId,capturePolicy:evaluationCapturePolicy},settlement:{settled:true}},json=f.write(name.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),{role:'reference',viewport:'desktop'});
    const binding={snapshotId,inputVersionId:f.task.versionId,referenceUrl:'https://source.invalid/'};
    const read=(source=binding)=>validatedEvaluationEvidence(f.task,f.files,f.directory,base,f.site,undefined,source).files;
    assert.deepEqual(read(),[image,json]);assert.deepEqual(read({...binding,snapshotId:randomUUID()}),[]);assert.deepEqual(read({...binding,inputVersionId:randomUUID()}),[]);assert.deepEqual(read({...binding,referenceUrl:'https://other.invalid/'}),[]);
    const changed=Buffer.from(JSON.stringify({...observation,settlement:{settled:false}}));writeFileSync(resolve(f.directory,json.name),changed);json.size=changed.length;json.sha256=hash(changed);assert.deepEqual(read(),[]);
  }finally{f.close();}
});

for(const mode of ['other-task','old-revision','missing-binding','wrong-origin','credentials','wrong-json-viewport','wrong-observed-viewport','wrong-observed-role','wrong-image-viewport','wrong-json-hash','wrong-png-hash','wrong-json-size','wrong-png-size','missing-json','missing-png','forged-png','mismatched-pair','duplicate-name'] as const){
  test(`target evidence with ${mode} cannot enter scoring or URL observations`,()=>{
    const f=fixture();try{
      const changes:Record<string,unknown>=mode==='other-task'?{binding:{taskId:'other',siteRevision:f.task.siteRevision}}:mode==='old-revision'?{binding:{taskId:f.task.id,siteRevision:'old'}}:mode==='missing-binding'?{binding:undefined}:mode==='wrong-origin'?{url:'https://different.invalid'+path}:mode==='credentials'?{url:'https://someone:password@target.invalid'+path}:mode==='wrong-observed-viewport'?{viewport:'business'}:mode==='wrong-observed-role'?{role:'content'}:mode==='mismatched-pair'?{file:randomUUID()+'.png'}:{};
      const proof=f.pair(changes);
      if(mode==='wrong-json-viewport')proof.json.viewport='mobile';if(mode==='wrong-image-viewport')proof.image.viewport='mobile';
      if(mode==='wrong-json-hash')proof.json.sha256='0'.repeat(64);if(mode==='wrong-png-hash')proof.image.sha256='0'.repeat(64);
      if(mode==='wrong-json-size')proof.json.size++;if(mode==='wrong-png-size')proof.image.size++;
      if(mode==='missing-json')f.files.splice(f.files.indexOf(proof.json),1);if(mode==='missing-png')f.files.splice(f.files.indexOf(proof.image),1);
      if(mode==='forged-png'){const bytes=Buffer.from('not a real PNG');writeFileSync(resolve(f.directory,proof.image.name),bytes);proof.image.sha256=hash(bytes);proof.image.size=bytes.length;}
      if(mode==='duplicate-name')f.files.push({...proof.image,id:randomUUID()});
      assert.deepEqual(f.trusted(),{files:[],observations:{}});
    }finally{f.close();}
  });
}

test('bound implementation evidence survives recovery while historical unbound files cannot bypass binding',()=>{
  const f=fixture();try{
    const valid=f.implementation();f.implementation({binding:undefined});
    assert.deepEqual(f.trusted(),{files:[valid],observations:{}});
    assert.deepEqual(validatedEvaluationEvidence(f.task,f.files,f.directory,base).files,[]);
    assert.deepEqual(validatedEvaluationEvidence(f.task,f.files,f.directory,base,true as never).files,[]);
    f.task.versionId='new-input-version';assert.deepEqual(f.trusted().files,[]);
  }finally{f.close();}
});

for(const field of ['kind','version','taskId','inputVersionId','resourceId','siteRevision','generatedSiteId','siteId','environmentId','generatedSiteVersionId','targetUrl'] as const){
  test(`implementation evidence rejects a stale or forged ${field} binding`,()=>{
    const f=fixture();try{f.implementation({binding:{...f.binding(),[field]:'different'}});assert.deepEqual(f.trusted(),{files:[],observations:{}});}finally{f.close();}
  });
}

for(const mode of ['wrong-hash','wrong-size','unregistered','duplicate-name','wrong-name','missing-revision','different-site','different-environment','different-resource','different-site-version','different-target-url'] as const){
  test(`implementation evidence rejects ${mode}`,()=>{
    const f=fixture();try{
      const file=f.implementation();
      if(mode==='wrong-hash')writeFileSync(resolve(f.directory,file.name),'changed bytes');
      if(mode==='wrong-size')file.size++;
      if(mode==='unregistered')f.files.length=0;
      if(mode==='duplicate-name')f.files.push({...file,id:randomUUID()});
      if(mode==='wrong-name'){const bytes=readFileSync(resolve(f.directory,file.name));f.files.length=0;f.write('implementation-forged.json',bytes,{role:'target'});}
      if(mode==='missing-revision')f.task.siteRevision='';
      if(mode==='different-site')f.site.siteId=randomUUID();
      if(mode==='different-environment')f.site.environmentId=randomUUID();
      if(mode==='different-resource')f.site.resourceId=randomUUID();
      if(mode==='different-site-version')f.site.versionId=randomUUID();
      if(mode==='different-target-url')f.site.url='https://different.invalid/';
      assert.deepEqual(f.trusted(),{files:[],observations:{}});
    }finally{f.close();}
  });
}

test('host inspection persists binding independently of remote payload and refuses a target changed during the request',async()=>{
  const f=fixture();let mutate=()=>{};const requestedSites:string[]=[];
  const server=createServer((req,res)=>{requestedSites.push(new URL(req.url!,'http://localhost').searchParams.get('SiteId')!);mutate();res.setHeader('content-type','application/json');res.end(JSON.stringify({list:[{id:'page-one'}],binding:{taskId:'forged',siteId:'forged'}}));});
  let inspection:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});const address=server.address();assert.ok(address&&typeof address!=='string');const endpoint=`http://127.0.0.1:${address.port}`;
    const vault=new Vault(resolve(f.directory,'vault'));vault.update({...vault.get(),environments:[{id:f.task.environmentId,name:'test',origin:endpoint,apiOrigin:endpoint,token:'fake-test-token'}]});
    const work=resolve(f.directory,'work');inspection=await inspectionTools(f.task,f.store,vault,f.directory,work,f.files,new AbortController().signal);
    const call=(input:unknown)=>fetch(inspection!.env.INSPECTION_URL,{method:'POST',headers:{authorization:'Bearer '+inspection!.env.INSPECTION_TOKEN,'content-type':'application/json'},body:JSON.stringify({tool:'implementation',input})});
    assert.equal((await call({kind:'pages',binding:f.binding()})).status,400);assert.equal(requestedSites.length,0);
    const result=await call({kind:'pages'});assert.equal(result.status,200);const record=await result.json();const saved=JSON.parse(readFileSync(resolve(work,'evidence',record.evidence),'utf8'));
    assert.deepEqual(saved.binding,f.binding());assert.equal(saved.value.binding.taskId,'forged');assert.deepEqual(requestedSites,[f.site.siteId]);assert.deepEqual(record.result.binding,saved.binding);
    const registered=f.store.task(f.task.id)!.artifacts!;assert.equal(registered.length,1);
    assert.deepEqual(JSON.parse(readFileSync(resolve(work,'evidence-manifest.json'),'utf8')),registered,'first-pass implementation evidence is indexed before final submission');
    assert.deepEqual(validatedEvaluationEvidence(f.store.task(f.task.id)!,registered,resolve(work,'evidence'),base,f.store.site(f.site.id)).files,registered);
    assert.equal((await call({page:1,kind:'pages'})).status,200);assert.equal(requestedSites.length,1,'same bound request reuses registered bytes independent of property order');
    assert.equal((await call({kind:'pages',binding:f.binding()})).status,400,'cache cannot bypass request schema validation');
    mutate=()=>{const current=f.store.site(f.site.id)!;current.siteId=randomUUID();f.store.saveSite(current);};
    const stale=await call({kind:'pages',page:2});assert.equal(stale.status,400);assert.match((await stale.json()).error,/期间任务或站点已变化/);assert.equal(f.files.length,1);
    mutate=()=>{};f.store.saveSite(f.site);mutate=()=>{const current=f.store.task(f.task.id)!;current.siteRevision='replaced-revision';f.store.put(current);};
    const changed=await call({kind:'pages',page:3});assert.equal(changed.status,400);assert.match((await changed.json()).error,/期间任务或站点已变化/);assert.equal(f.files.length,1);assert.equal(f.store.task(f.task.id)!.siteRevision,'replaced-revision');
    f.store.put(f.task);mutate=()=>{f.store.db.prepare('INSERT INTO auto_site_state VALUES(?,?,NULL)').run(f.site.id,'new-site-revision');};
    const revised=await call({kind:'pages',page:4});assert.equal(revised.status,400);assert.match((await revised.json()).error,/期间任务或站点已变化/);assert.equal(f.files.length,1);
  }finally{await inspection?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));f.close();}
});

test('stateful implementation cache expires after a recorded action or changed evidence bytes',async()=>{
  const f=fixture();let requests=0;
  const server=createServer((_req,res)=>{requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({list:[],pageNr:1,totalPages:0,totalCount:0}));});
  let inspection:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,vault=new Vault(resolve(f.directory,'vault'));
    vault.update({...vault.get(),environments:[{id:f.task.environmentId,name:'mock',origin,apiOrigin:origin,token:'fake'}]});const work=resolve(f.directory,'work');
    inspection=await inspectionTools(f.task,f.store,vault,f.directory,work,f.files,new AbortController().signal);
    const request={kind:'rows',table:'Cars'};
    const first=await inspection.readImplementation(request);assert.equal((await inspection.readImplementation(request)).evidence,first.evidence);assert.equal(requests,1);
    const name=randomUUID()+'.json',bytes=Buffer.from(JSON.stringify({action:'click',binding:{taskId:f.task.id,siteRevision:f.task.siteRevision}}));
    writeFileSync(resolve(work,'evidence',name),bytes);f.files.push({id:randomUUID(),name,type:'application/json',role:'target',size:bytes.length,sha256:hash(bytes)});
    const second=await inspection.readImplementation(request);assert.notEqual(second.evidence,first.evidence);assert.equal(requests,2);assert.equal((await inspection.readImplementation(request)).evidence,second.evidence);
    writeFileSync(resolve(work,'evidence',second.evidence),'tampered');assert.notEqual((await inspection.readImplementation(request)).evidence,second.evidence);assert.equal(requests,3);
  }finally{await inspection?.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));f.close();}
});

test('draft preflight uses the host validator without creating evidence, reports or remote requests',async()=>{
  const f=fixture();let inspection:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    const vault=new Vault(resolve(f.directory,'vault')),work=resolve(f.directory,'work');
    let calls=0;
    inspection=await inspectionTools(f.task,f.store,vault,f.directory,work,f.files,new AbortController().signal,name=>{
      calls++;if(name!=='current-result.json')throw new Error('只能检查当前提交');
    });
    const call=(resultFile:unknown)=>fetch(inspection!.env.INSPECTION_URL,{method:'POST',headers:{authorization:'Bearer '+inspection!.env.INSPECTION_TOKEN,'content-type':'application/json'},body:JSON.stringify({tool:'validate_result',resultFile})});
    assert.equal((await call('../stale-result.json')).status,400);
    const valid=await call('current-result.json');assert.equal(valid.status,200);assert.equal((await valid.json()).valid,true);
    assert.equal(calls,2);assert.equal(f.files.length,0);assert.equal(f.store.task(f.task.id)!.report,null);
    for(let i=0;i<5;i++)assert.equal((await call('current-result.json')).status,200);
    const limited=await call('current-result.json');assert.equal(limited.status,400);assert.match((await limited.json()).error,/调用上限/);
  }finally{await inspection?.close();f.close();}
});

test('page completeness uses the trusted target origin and exact path/query with both viewports',()=>{
  const f=fixture();try{
    const desktop=f.pair(),mobile=f.pair({},'mobile');
    const manifest:RequirementManifest={id:randomUUID(),taskId:f.task.id,revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',items:[{id:'about',kind:'page',title:'About',required:true,source:'Source',expectation:'The exact page exists',paths:[path],viewports:['desktop','mobile'],expectedCount:null}]};
    const checks=[{id:'about',status:'verified',reason:'Both exact pages reviewed',evidence:[desktop.image.name,mobile.image.name],checkedViewports:['desktop','mobile'],actualCount:null,sampledPaths:[path],checkedKeys:[]}];
    const trusted=f.trusted();assert.equal(validateCompleteness(checks,manifest,trusted.files,trusted.observations,base).state,'complete');
    for(const replacement of ['https://different.invalid'+path,base+'about?section=other']){
      const observations={...trusted.observations,[desktop.image.name]:{url:replacement,role:'target',viewport:'desktop'}};
      assert.throws(()=>validateCompleteness(checks,manifest,trusted.files,observations,base),/缺少对应 desktop/);
    }
    const wrongManifest={...manifest,items:[{...manifest.items[0],paths:['https://different.invalid'+path]}]};
    assert.throws(()=>validateCompleteness([{...checks[0],sampledPaths:wrongManifest.items[0].paths}],wrongManifest,trusted.files,trusted.observations,base),/缺少对应/);
  }finally{f.close();}
});

test('strict scored visuals need target URL observations while legacy validateResult callers stay compatible',()=>{
  const f=fixture();try{
    const desktop=f.pair(),mobile=f.pair({},'mobile'),trusted=f.trusted();
    const assessments=f.task.rule!.criteria.filter(criterion=>criterion.scopes.includes(f.task.scope)).flatMap(criterion=>criterion.viewports.map(viewport=>({criterionId:criterion.id,viewport,score:90,passed:true,reason:'Reviewed current evidence',evidence:[viewport==='mobile'?mobile.image.name:desktop.image.name]})));
    const result={summary:'Current independent review',assessments,issues:[],coverage:{verified:[],unverified:[],outOfScope:[]}};
    assert.equal(validateResult(result,f.task,trusted.files,80,false,undefined,trusted.observations,base).quality,'passed');
    assert.throws(()=>validateResult(result,f.task,trusted.files,80,false,undefined,{},base),/真实截图证据/);
    assert.equal(validateResult(result,f.task,trusted.files,80).quality,'passed');
  }finally{f.close();}
});

interface FakeElement { parentElement:FakeElement|null; style:Record<string,string>; getRootNode:()=>object }
function element(style:Record<string,string>={},parentElement:FakeElement|null=null):FakeElement{return {parentElement,style:{display:'block',visibility:'visible',opacity:'1',...style},getRootNode:()=>({})};}
function visible(element:FakeElement){return runInNewContext('('+visibleFrameElement.toString()+')(element)',{element,getComputedStyle:(node:FakeElement)=>node.style});}

test('iframe visibility rejects zero opacity on itself, DOM ancestors and shadow hosts',()=>{
  assert.equal(visible(element({opacity:'0'})),false);assert.equal(visible(element({},element({opacity:'0'}))),false);
  const shadowElement=element();shadowElement.getRootNode=()=>({host:element({opacity:'0'})});assert.equal(visible(shadowElement),false);
  assert.equal(visible(element({display:'none'})),false);assert.equal(visible(element({},element({visibility:'hidden'}))),false);assert.equal(visible(element({opacity:'0.5'},element({opacity:'0.2'}))),true);
});

test('transparent parent frames cannot contribute nested text and visible frame text stays separately attributed',async()=>{
  const main={} as any;let reads=0;
  const frame=(parent:any,dom:FakeElement,url:string)=>({parentFrame:()=>parent,frameElement:async()=>({isVisible:async()=>true,evaluate:async()=>visible(dom),dispose:async()=>{}}),url:()=>url,locator:()=>({innerText:async()=>{reads++;return 'actual iframe body';}})});
  const hidden=frame(main,element({},element({opacity:'0'})),'https://source.invalid/parent'),nested=frame(hidden,element(),'https://source.invalid/nested'),shown=frame(main,element({opacity:'0.5'}),'https://source.invalid/shown');
  const page={frames:()=>[main,hidden,nested,shown],mainFrame:()=>main} as unknown as Page;
  assert.deepEqual(await visibleFrames(page),{frames:[{url:'https://source.invalid/shown',text:'actual iframe body'}],framesComplete:true});assert.equal(reads,1);
});
