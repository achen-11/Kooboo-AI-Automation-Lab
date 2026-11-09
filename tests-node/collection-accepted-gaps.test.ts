import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { CollectionStore, effectiveCollectionInput } from '../server/automation/collection/store.js';
import { checkCollectionMechanics, collectionProgress, reviewContext } from '../server/automation/collection/orchestrator.js';
import { acceptedAssetGapEvidencePath, acceptedAssetGapGuidance, failedCollectionAssetEntries } from '../server/automation/collection/accepted-gaps.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { createApp } from '../server/app.js';
import { recordAutonomousAttempt } from '../server/automation/autonomy.js';

function prepare(store:AutomationStore,directory:string) {
  const resource=store.saveResource({name:'Source',scenario:'migration',description:'Original source',contentUrl:'https://source.invalid/',referenceUrl:'',externalSource:'',externalId:'',files:[]});
  const task=store.create({resourceIds:[resource.id],environmentId:'',kind:'generation',scope:'site',requirements:''},defaultAutomationSettings)[0];
  const collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const good=Buffer.from('existing saved image bytes');
  const state={source:run.sourceUrl,siteHosts:['source.invalid'],urls:{one:{id:'u00001',url:run.sourceUrl,path:'/',action:'keep',status:200,rawFile:'.work/raw/u00001.html'}},
    assets:[{url:'https://cdn.invalid/missing.png?size=1&v=2',status:'failed',note:'http-404',localPath:'',bytes:0,hash:''},{url:'https://source.invalid/good.png',status:'saved',note:'',localPath:'images/good.png',bytes:good.length,hash:createHash('sha1').update(good).digest('hex')}],
    files:[{url:'https://source.invalid/missing.pdf',status:'failed',note:'timeout'}],stylesheets:[{url:'https://cdn.invalid/common.css',status:'failed',note:'http-403 / not-css'}]};
  const findings=()=>failedCollectionAssetEntries(state).map(entry=>({severity:'gap',kind:entry.kind,url:entry.url,reason:entry.note||entry.status}));
  const saveState=()=>{write('.work/state.json',state);write('site/a-checklist.json',{findings:findings()});};
  saveState();write('.work/raw/u00001.html','<html><body><p>Visible original source body for testing</p></body></html>');
  write('.work/extract/u00001.json',{fullText:'Visible original source body for testing'});write('images/good.png',good);
  const hash=()=>collectionHash(readFileSync(resolve(root,'.work/state.json')));
  const accept=()=>{const result=collections.acceptCurrentAssetGaps(task,'用户明确按当前已取得素材继续，接受已核对的失效原资源',hash(),()=>false);Object.assign(run,collections.get(run.id));return result;};
  const check=(id:string)=>checkCollectionMechanics(collections,run).checks.find(check=>check.id===id)!;
  return {store,directory,task,collections,run,root,state,write,saveState,hash,accept,check};
}
function fixture(){const directory=mkdtempSync(resolve(tmpdir(),'accepted-gaps-')),db=new Database(':memory:');return {...prepare(new AutomationStore(db),directory),close(){db.close();rmSync(directory,{recursive:true,force:true});}};}

test('unaccepted failures block; acceptance is exact, human-bound and idempotent without changing source/checks/budgets',()=>{
  const f=fixture();try{
    f.task.autonomy!.history.noProgress=4;f.task.autonomy!.history.strategyReturns=2;
    f.store.scheduleFollowup(f.task,defaultAutomationSettings.followup);f.task.status='interrupted';f.task.stopped=true;
    Object.assign(f.task.followup!,{tokens:123456,attempts:4,elapsedMs:987});f.store.put(f.task);
    const history=structuredClone(f.task.autonomy!.history),followup=structuredClone(f.task.followup),status=f.run.status;
    const source=f.collections.read(f.run,'.work/state.json'),checklist=f.collections.read(f.run,'site/a-checklist.json'),progress=collectionProgress(f.run),message=f.task.message;
    assert.equal(f.check('A6').status,'failed');
    const first=f.accept();assert.equal(first.idempotent,false);assert.equal(first.acceptance.actor,'human');
    assert.equal(first.acceptance.stateHash,f.hash());assert.equal(first.acceptance.inputVersionId,f.task.versionId);assert.equal(first.acceptance.entries.length,3);
    assert.ok(first.acceptance.entries.some(entry=>entry.url==='https://cdn.invalid/missing.png?size=1&v=2'&&entry.note==='http-404'&&entry.collection==='assets'));
    assert.equal(f.check('A6').status,'unverified');assert.equal(f.run.status,status);assert.deepEqual(f.run.checks,[]);assert.equal(f.run.review,undefined);
    assert.notEqual(collectionProgress(f.run),progress);assert.deepEqual(f.task.autonomy!.history,history);assert.deepEqual(f.task.followup,followup);
    assert.deepEqual(f.collections.read(f.run,'.work/state.json'),source);assert.deepEqual(f.collections.read(f.run,'site/a-checklist.json'),checklist);
    assert.ok(f.task.message.length-message.length<1000);assert.match(f.task.message,/禁止重新全站抓取/);
    const saved=f.collections.read(f.run,acceptedAssetGapEvidencePath),events=f.store.events(f.task.id).length,updatedMessage=f.task.message;
    const again=f.accept();assert.equal(again.idempotent,true);assert.equal(f.run.acceptedAssetGaps!.length,1);assert.equal(f.task.message,updatedMessage);assert.equal(f.store.events(f.task.id).length,events);assert.deepEqual(f.collections.read(f.run,acceptedAssetGapEvidencePath),saved);
    const context=reviewContext(f.collections,f.run,f.task);assert.equal(context.acceptedAssetGaps?.evidencePath,acceptedAssetGapEvidencePath);assert.ok(context.index.paths.includes(acceptedAssetGapEvidencePath));assert.match(context.sourceContractNotice,/脚本文本或坐标不是静态可见正文/);
  }finally{f.close();}
});

test('new failed URLs and changed errors for the same URL remain blocked even with an old checklist',()=>{
  for(const mode of ['new-url','changed-note','changed-status'] as const){const f=fixture();try{
    f.accept();
    if(mode==='new-url')f.state.assets.push({...f.state.assets[0],url:'https://source.invalid/new.png'});
    else if(mode==='changed-note')f.state.assets[0].note='http-502';
    else f.state.assets[0].status='over-limit';
    f.write('.work/state.json',f.state);
    assert.equal(f.check('A6').status,'failed',mode);
  }finally{f.close();}}
});

test('a new explicit acceptance changes recovery progress without erasing earlier failure evidence',()=>{
  const f=fixture();try{
    const previous=collectionProgress(f.run),autonomy=f.task.autonomy!;
    autonomy.checkpoint.progressKey=previous;autonomy.history.strategyReturns=2;autonomy.history.noProgress=6;autonomy.history.strategies=['collection:withdraw','collection:continue:assets'];
    autonomy.history.failures=[{fingerprint:'old',progressKey:previous,strategy:'collection:withdraw',at:1,reason:'old source condition'}];
    f.accept();const progress=collectionProgress(f.run);
    assert.equal(autonomy.history.failures.length,1);assert.equal(autonomy.history.strategyReturns,2);
    assert.equal(recordAutonomousAttempt(f.task,'collection:withdraw','针对新授权条件恢复正文证据',2,progress),'');
    assert.equal(autonomy.history.failures.length,2);assert.equal(autonomy.history.failures[0].progressKey,previous);assert.equal(autonomy.history.strategyReturns,0);
    f.state.assets[0].note='http-502';f.saveState();assert.equal(f.check('A6').status,'failed');
    const second=f.accept();assert.equal(second.idempotent,false);assert.equal(f.run.acceptedAssetGaps!.length,2);assert.equal(f.check('A6').status,'unverified');
    assert.ok(f.run.acceptedAssetGaps![0].entries.some(entry=>entry.note==='http-404'));
    assert.ok(f.run.acceptedAssetGaps![1].entries.some(entry=>entry.note==='http-502'));
  }finally{f.close();}
});

test('acceptance cannot hide unaccounted resources, unrelated findings, page errors or content errors',()=>{
  for(const finding of [
    {severity:'gap',kind:'asset',url:'https://source.invalid/new.png',reason:'planned-but-unaccounted'},
    {severity:'gap',kind:'asset',url:'https://cdn.invalid/missing.png?size=1&v=2',reason:'different-error'},
    {severity:'gap',kind:'page',url:'https://source.invalid/',reason:'page-failed'},
    {severity:'gap',kind:'content',url:'https://source.invalid/',reason:'empty-content'},
  ]){const f=fixture();try{f.accept();f.write('site/a-checklist.json',{findings:[finding]});const id=finding.kind==='page'?'A4':finding.kind==='content'?'A5':'A6';assert.equal(f.check(id).status,'failed');}finally{f.close();}}
});

test('saved assets still require actual bytes and matching length/hash after accepting other failures',()=>{
  for(const mode of ['missing','empty','same-size-corruption','wrong-length','no-path'] as const){const f=fixture();try{
    f.accept();const file=resolve(f.root,'images/good.png');
    if(mode==='missing')rmSync(file);
    else if(mode==='empty')writeFileSync(file,'');
    else if(mode==='same-size-corruption')writeFileSync(file,Buffer.alloc(f.state.assets[1].bytes,120));
    else if(mode==='wrong-length')writeFileSync(file,'unexpected longer file');
    else{f.state.assets[1].localPath='';f.write('.work/state.json',f.state);}
    assert.equal(f.check('A6').status,'failed',mode);
  }finally{f.close();}}
});

test('over-limit and unaccounted-only states cannot be accepted as failed downloads',()=>{
  const f=fixture();try{
    f.state.assets[0].status='over-limit';f.state.files=[];f.state.stylesheets=[];f.saveState();
    assert.throws(()=>f.accept(),/没有可接受/);assert.equal(f.run.acceptedAssetGaps,undefined);
  }finally{f.close();}
});

test('missing or altered acceptance evidence blocks mechanics and freeze',()=>{
  const f=fixture();try{
    f.accept();f.write(acceptedAssetGapEvidencePath,{version:1,acceptances:[]});
    assert.equal(f.check('A6').status,'failed');
    f.run.review={action:'ready'};f.run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'test independent review',evidence:[]}));
    assert.throws(()=>f.collections.freeze(f.run,f.task,'manifest'),/索引/);
    assert.throws(()=>f.accept(),/索引/);
  }finally{f.close();}
});

test('freezing pins exact acceptance records and input guidance to immutable material bytes',()=>{
  const f=fixture();try{
    f.accept();assert.throws(()=>f.collections.freeze(f.run,f.task,'manifest'),/检查/);
    f.run.review={action:'ready'};f.run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:id==='A6'?'约定素材范围通过':'independent evidence',evidence:[acceptedAssetGapEvidencePath]}));
    const snapshot=f.collections.freeze(f.run,f.task,'manifest'),frozen=structuredClone(snapshot.acceptedAssetGaps);
    assert.equal(snapshot.acceptedAssetGaps!.length,1);assert.ok(snapshot.files.some(file=>file.name==='collection/'+acceptedAssetGapEvidencePath));
    f.run.acceptedAssetGaps![0].reason='mutable later reason';f.write(acceptedAssetGapEvidencePath,{modified:true});
    assert.deepEqual(snapshot.acceptedAssetGaps,frozen);assert.deepEqual(f.collections.snapshot(snapshot.id)!.acceptedAssetGaps,frozen);
    assert.equal(JSON.parse(f.collections.original(snapshot,acceptedAssetGapEvidencePath).toString()).acceptances[0].reason,frozen![0].reason);
    const input=effectiveCollectionInput(f.task,f.store,f.directory)!;assert.match(input.description,/确切3项/);assert.match(input.description,/collection\/site\/accepted-source-gaps.json/);assert.match(input.description,/正文.*照常核验/);
    assert.equal(acceptedAssetGapGuidance(undefined),'');assert.equal(acceptedAssetGapGuidance([]),'');
    assert.throws(()=>f.collections.acceptCurrentAssetGaps(f.task,'明确接受已核对的失败原资源',f.hash(),()=>false),/已冻结/);
  }finally{f.close();}
});

test('local authenticated API rejects stale, running, owned, frozen and site-created tasks without mutating acceptance',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'accepted-gaps-api-')),f=await createApp({directory,serveWeb:false,startWorker:false});
  try{
    const p=prepare(f.automationStore,directory),endpoint=`/api/automation/tasks/${p.task.id}/collection/accept-current-assets`;
    const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
    const payload={reason:'用户明确接受已核对的失效原素材，按当前材料继续',expectedStateHash:p.hash()};
    assert.equal((await f.app.inject({method:'POST',url:endpoint,payload})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload:{...payload,expectedStateHash:'0'.repeat(64)}})).statusCode,409);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload:{...payload,reason:'ok'}})).statusCode,400);
    p.task.status='running';p.task.stopped=false;p.store.put(p.task);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload})).statusCode,409);
    p.task.status='interrupted';p.task.stopped=true;p.store.put(p.task);
    const owns=f.automationWorker.owns;f.automationWorker.owns=()=>true;
    try{assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload})).statusCode,409);}finally{f.automationWorker.owns=owns;}
    p.task.generation={createAttempted:true};p.store.put(p.task);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload})).statusCode,409);
    delete p.task.generation;p.task.generatedSiteId=randomUUID();p.store.put(p.task);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload})).statusCode,409);
    p.task.generatedSiteId=null;p.store.put(p.task);p.run.materialVersionId=randomUUID();p.collections.put(p.run);
    assert.equal((await f.app.inject({method:'POST',url:endpoint,headers,payload})).statusCode,409);
    delete p.run.materialVersionId;p.collections.put(p.run);
    assert.equal(p.collections.get(p.run.id)!.acceptedAssetGaps,undefined);
    const accepted=await f.app.inject({method:'POST',url:endpoint,headers,payload});assert.equal(accepted.statusCode,200);assert.equal(accepted.json().acceptance.entries.length,3);
    const duplicate=await f.app.inject({method:'POST',url:endpoint,headers,payload});assert.equal(duplicate.statusCode,200);assert.equal(duplicate.json().idempotent,true);assert.equal(p.store.task(p.task.id)!.status,'interrupted');
  }finally{await f.app.close();rmSync(directory,{recursive:true,force:true});}
});
