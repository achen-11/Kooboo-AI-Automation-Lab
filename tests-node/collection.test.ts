import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { CollectionStore, effectiveCollectionInput } from '../server/automation/collection/store.js';
import { checkCollectionMechanics } from '../server/automation/collection/orchestrator.js';
import { safeCollectionPath, collectionHash } from '../server/automation/collection/runtime.js';
import { executeGeneration } from '../server/automation/generator.js';
import { CollectionBlocked } from '../server/automation/collection/errors.js';
import { collectionReviewHistory } from '../server/automation/collection/review-history.js';

function fixture(){const directory=mkdtempSync(resolve(tmpdir(),'collection-test-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory),settings=structuredClone(defaultAutomationSettings);const resource=store.saveResource({name:'Migration',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'Original',files:[],externalSource:'',externalId:''});const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},settings)[0],collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);const write=(path:string,value:unknown)=>{const target=resolve(root,path);mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,typeof value==='string'?value:JSON.stringify(value));};return {directory,db,store,vault,task,collections,run,root,write,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
function source(f:ReturnType<typeof fixture>){f.write('.work/state.json',{source:f.run.sourceUrl,siteHosts:['source.invalid'],urls:{one:{id:'u00001',url:'https://source.invalid/123.aspx?page=2',path:'/123.aspx?page=2',action:'keep',status:200,rawFile:'.work/raw/u00001.html'}}});f.write('.work/raw/u00001.html','<html><h1>Original source body</h1></html>');f.write('.work/extract/u00001.json',{fullText:'Original source body'});f.write('site/pages/one.md','Original source body');f.write('site/a-checklist.json',{findings:[]});}

test('review history distinguishes executed operations from blocked proposals without resetting counters',()=>{const f=fixture();try{
  f.run.operations=Array.from({length:12},(_,i)=>({id:'op-'+i,operation:'assets',status:i===11?'failed' as const:'completed' as const,startedAt:i,finishedAt:i+1,error:i===11?'x'.repeat(2000):undefined}));
  const history=f.task.autonomy!.history;history.noProgress=6;history.strategyReturns=2;
  history.failures=Array.from({length:12},(_,i)=>({fingerprint:String(i),progressKey:'unchanged',strategy:'collection:continue:assets',at:i,reason:'r'.repeat(2000)}));
  const before=JSON.stringify({task:f.task,run:f.run}),result=collectionReviewHistory(f.collections,f.run,f.task);
  assert.deepEqual(result.operationTotals.assets,{completed:11,failed:1,running:0});assert.equal(result.operations.length,8);assert.equal(result.attempts?.length,8);assert.equal(result.attempts?.[0].at,4);assert.equal(result.attempts?.[0].reason.length,500);assert.equal(result.operations.at(-1)?.evidencePath,undefined);
  assert.deepEqual(result.counters,{noProgress:6,strategyReturns:2});assert.equal(JSON.stringify({task:f.task,run:f.run}),before);
}finally{f.close();}});

test('review diagnostic index accepts only current input metadata and ignores malformed or escaped entries',()=>{const f=fixture();try{
  const binding={collectionId:f.run.id,inputVersionId:f.run.inputVersionId};
  f.write('.work/diagnostics/current/metadata.json',{binding,status:403,outcome:'response',summary:'bucket referer policy',startedAt:'2026-11-08T00:00:00Z'});
  f.write('.work/diagnostics/other/metadata.json',{binding:{...binding,inputVersionId:'other'},status:200});
  f.write('.work/diagnostics/broken/metadata.json','not json');
  symlinkSync(f.directory,resolve(f.root,'.work/diagnostics/escape'));
  const result=collectionReviewHistory(f.collections,f.run,f.task);
  assert.equal(result.diagnostics.length,1);assert.equal(result.diagnostics[0].metadataPath,'.work/diagnostics/current/metadata.json');assert.equal(result.diagnostics[0].status,403);
  assert.equal(f.run.checks.length,0);assert.equal(f.task.autonomy!.history.noProgress,0);
}finally{f.close();}});

test('review diagnostics return at most eight references and truncate summaries',()=>{const f=fixture();try{
  for(let i=0;i<12;i++)f.write(`.work/diagnostics/diag-${i}/metadata.json`,{binding:{collectionId:f.run.id,inputVersionId:f.run.inputVersionId},status:404,summary:'x'.repeat(1000)});
  const result=collectionReviewHistory(f.collections,f.run,f.task);assert.equal(result.diagnostics.length,8);assert.ok(result.diagnostics.every(d=>d.summary.length===400));
}finally{f.close();}});

test('new migration flags are inherited without changing an immutable input version or historical tasks',()=>{const f=fixture();try{assert.equal(f.task.autonomy?.mode,'completion-first');const before=JSON.stringify(f.store.version(f.task.versionId));const child=f.store.create({resourceIds:[f.task.resourceId],kind:'generation',scope:'site',environmentId:'',requirements:'Specific repair',parentId:f.task.id,versionId:f.task.versionId},defaultAutomationSettings)[0];assert.equal(child.collectionId,f.run.id);assert.equal(JSON.stringify(child.autonomy?.policy),JSON.stringify(f.task.autonomy?.policy));assert.equal(JSON.stringify(f.store.version(f.task.versionId)),before);const homepage=f.store.create({resourceIds:[f.task.resourceId],kind:'generation',scope:'homepage',environmentId:'',requirements:''},defaultAutomationSettings)[0];assert.equal(homepage.autonomy,undefined);}finally{f.close();}});
test('A stage failure prevents target environment access and site creation',async()=>{const f=fixture();try{await assert.rejects(executeGeneration(f.task,f.store,f.vault,f.directory,AbortSignal.timeout(1000)),CollectionBlocked);assert.equal(f.store.sites().length,0);assert.equal(f.task.generation?.createAttempted,undefined);assert.equal(f.task.generatedSiteId,null);}finally{f.close();}});
test('mechanical success remains unverified; limits, missing originals and planned failures cannot become green',()=>{const f=fixture();try{source(f);let result=checkCollectionMechanics(f.collections,f.run);assert.ok(result.checks.every(c=>c.status==='unverified'));f.write('.work/state.json',{source:f.run.sourceUrl,siteHosts:['source.invalid'],urls:{one:{id:'u00001',action:'over-limit',url:'https://source.invalid/123.aspx?page=2'}}});result=checkCollectionMechanics(f.collections,f.run);assert.equal(result.checks.find(c=>c.id==='A2')?.status,'failed');f.write('site/a-checklist.json',{findings:[{severity:'gap',kind:'asset',reason:'missing image'}]});assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(c=>c.id==='A6')?.status,'failed');}finally{f.close();}});
test('frozen collection pins materials and review together; corrupted attachments fail closed',()=>{const f=fixture();try{source(f);assert.throws(()=>f.collections.freeze(f.run,f.task,'manifest'),/检查/);f.run.review={action:'ready',discoveryBasis:'Reviewed source evidence'};f.run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'fixed evidence',evidence:['raw']}));const before=JSON.stringify(f.store.version(f.task.versionId)),snapshot=f.collections.freeze(f.run,f.task,'manifest');assert.ok(snapshot.originals.some(o=>o.path==='.work/raw/u00001.html'));const input=effectiveCollectionInput(f.task,f.store,f.directory)!;assert.equal(JSON.stringify(f.store.version(f.task.versionId)),before);assert.ok(input.files.some(o=>o.name==='collection/site/pages/one.md'));const old=f.task.collectionVersionId;f.run.status='reviewing';const second=f.collections.freeze(f.run,f.task,'manifest-2');assert.notEqual(second.id,old);assert.ok(f.collections.snapshot(old!));writeFileSync(resolve(f.directory,'materials',second.files[0].id),'tampered');assert.throws(()=>effectiveCollectionInput(f.task,f.store,f.directory),/不完整或已变化/);}finally{f.close();}});
test('collection evidence path traversal and symlink escapes are rejected',()=>{const f=fixture();try{mkdirSync(f.root,{recursive:true});assert.throws(()=>safeCollectionPath(f.root,'../master.key'),/越界/);assert.throws(()=>safeCollectionPath(f.root,'/etc/passwd'),/相对路径/);symlinkSync(f.directory,resolve(f.root,'escape'));assert.throws(()=>safeCollectionPath(f.root,'escape/anything'),/符号链接/);}finally{f.close();}});
test('restart requeues only registered pre-create collection and preserves uncertain generation',()=>{const f=fixture();try{f.task.status='running';f.task.stopped=false;f.store.put(f.task);f.store.recover();const recovered=f.store.task(f.task.id)!;assert.equal(recovered.status,'queued');assert.equal(recovered.stopped,true);assert.equal(recovered.collectionId,f.run.id);recovered.status='running';recovered.stopped=false;recovered.generation={createAttempted:true};f.store.put(recovered);f.store.recover();assert.equal(f.store.task(f.task.id)!.status,'pending');assert.equal(f.store.task(f.task.id)!.stopped,false);}finally{f.close();}});
test('recollection keeps prior frozen originals and updates only the current workflow material pointer',()=>{const f=fixture();try{
  source(f);f.run.review={action:'ready'};f.run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'reviewed',evidence:[]}));const first=f.collections.freeze(f.run,f.task,'first-manifest');
  const original=f.collections.original(first,'.work/raw/u00001.html').toString();f.collections.requestRevision(f.task,{description:'Fetch an independently identified missing page',affectedObjects:['/456'],evidence:['report-source-gap'],acceptance:'The page has a saved original and independent A checks',operation:'fetch',options:{seedUrls:['https://source.invalid/456']}});
  f.write('.work/raw/u00001.html','<h1>Later source changed</h1>');assert.equal(f.collections.original(first,'.work/raw/u00001.html').toString(),original);assert.equal(f.collections.snapshot(first.id)?.manifestId,'first-manifest');
  const child=f.store.create({resourceIds:[f.task.resourceId],kind:'generation',scope:'site',environmentId:'',parentId:f.task.id,optimizationRootId:f.task.id,versionId:f.task.versionId,requirements:'Targeted source repair'},defaultAutomationSettings)[0];const run=f.collections.get(f.run.id)!;run.review={action:'ready'};run.checks=first.checks;const second=f.collections.freeze(run,child,'second-manifest');
  assert.equal(f.store.task(f.task.id)?.collectionVersionId,second.id);assert.equal(f.store.task(f.task.id)?.requirementsId,'second-manifest');assert.equal(f.collections.snapshot(first.id)?.manifestId,'first-manifest');assert.equal(f.collections.original(first,'.work/raw/u00001.html').toString(),original);assert.equal(second.files.find(file=>file.name==='collection/site/pages/one.md')?.id,first.files.find(file=>file.name==='collection/site/pages/one.md')?.id);
}finally{f.close();}});
