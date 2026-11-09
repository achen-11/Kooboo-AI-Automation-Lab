import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import type { SourceRenderedEvidence } from '../shared/collection.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { sourceRenderedEvidenceIndex, sourceRenderedEvidencePath } from '../server/automation/collection/source-rendered.js';
import { collectionTargetGate, frozenCollectionRenderedTargets, verifyCollectionTarget } from '../server/automation/collection/target-verification.js';
import { sourceRenderedEvaluationContract } from '../server/automation/evaluator.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
const sourceUrl='https://source.invalid/map.aspx?branch=2',targetUrl='https://target.invalid/map.aspx?branch=2';
const visible='Acme Company\nAddress: 123 Main Street\nCopyright External Map Provider';

function fixture(options:{rendered?:boolean;fullText?:string;frames?:{url:string;text:string}[]}={}){
  const directory=mkdtempSync(resolve(tmpdir(),'rendered-target-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory);
  const resource=store.saveResource({name:'Map source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'Map',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},defaultAutomationSettings)[0];
  const collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
  const raw='<html><head><title>Map display</title></head><body><div id="map"></div><script>const company="Acme Company";const address="Address: 123 Main Street";</script></body></html>';
  write('.work/state.json',{source:run.sourceUrl,urls:{map:{id:'map',url:sourceUrl,path:'/map.aspx?branch=2',action:'keep',status:200,rawFile:'.work/raw/map.html'}}});
  write('.work/raw/map.html',raw);write('.work/extract/map.json',{title:'Map display',fullText:options.fullText||'',links:[],pageType:'page'});
  const manifest:RequirementManifest={id:randomUUID(),taskId:task.id,revision:1,createdAt:Date.now(),sourceComplete:true,limitations:[],items:[],evidence:[],actor:'human'};
  if(options.rendered!==false){
    const id=randomUUID(),folder='site/source-rendered/'+id,frames=options.frames||[],text=frames.length?'Map content':visible;
    const observation={action:'snapshot',role:'content',viewport:'desktop',url:sourceUrl,title:'Map display',text,snapshot:'- application: Map content',file:randomUUID()+'.png',capturedAt:100,frames,framesComplete:true,textTruncated:false};
    write(folder+'/observation.json',observation);write(folder+'/screenshot.png',png);
    const entry:SourceRenderedEvidence={id,collectionId:run.id,inputVersionId:task.versionId,engineVersion:run.engineVersion,pageId:'map',url:sourceUrl,rawPath:'.work/raw/map.html',rawSha256:collectionHash(collections.read(run,'.work/raw/map.html')),extractPath:'.work/extract/map.json',extractSha256:collectionHash(collections.read(run,'.work/extract/map.json')),observationPath:folder+'/observation.json',observationSha256:collectionHash(collections.read(run,folder+'/observation.json')),screenshotPath:folder+'/screenshot.png',screenshotSha256:collectionHash(png),capturedAt:100,viewport:'desktop',text,visibleText:[text,...frames.map(frame=>frame.text)].join('\n'),frames,framesComplete:true,textTruncated:false};
    run.sourceRenderedEvidence=[entry];write(sourceRenderedEvidencePath,sourceRenderedEvidenceIndex(run));
  }
  task.requirementsId=manifest.id;run.review={action:'ready'};run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'independent evidence',evidence:[]}));
  const snapshot=collections.freeze(run,task,manifest.id);
  task.generatedSiteId=randomUUID();task.siteUrl='https://target.invalid';
  store.saveSite({id:task.generatedSiteId,resourceId:task.resourceId,versionId:task.versionId,environmentId:'test-environment',siteId:'test-site',name:'Map target',url:task.siteUrl,createdAt:Date.now()});store.beginSiteChange(task);
  const work=resolve(directory,'automation-runs',task.id,'evidence');mkdirSync(work,{recursive:true});
  const observe=(changes:Record<string,unknown>={},settings:{image?:Buffer;jsonHash?:string;jsonName?:string;imageRole?:'target'|'reference'}={})=>{
    const stem=randomUUID(),imageName=stem+'.png',jsonName=settings.jsonName||stem+'.json',bytes=settings.image||png;
    const observation={action:'snapshot',role:'target',viewport:'desktop',url:targetUrl,title:'Map display',text:visible,snapshot:'- application: Map target',frames:[],framesComplete:true,textTruncated:false,file:imageName,capturedAt:Date.now(),binding:{taskId:task.id,siteRevision:task.siteRevision},...changes};
    const json=Buffer.from(JSON.stringify(observation));writeFileSync(resolve(work,imageName),bytes);writeFileSync(resolve(work,jsonName),json);
    const files:MaterialFile[]=[{id:randomUUID(),name:jsonName,type:'application/json',size:json.length,sha256:settings.jsonHash||collectionHash(json),role:'target',viewport:'desktop'},{id:randomUUID(),name:imageName,type:'image/png',size:bytes.length,sha256:collectionHash(bytes),role:settings.imageRole||'target',viewport:'desktop'}];
    task.artifacts=files;store.put(task);return {observation,files};
  };
  let target=raw;
  return {directory,db,store,task,collections,run,root,snapshot,manifest,work,write,observe,setTarget(value:string){target=value;},verify(){return verifyCollectionTarget({task,store,vault,directory,manifest,signal:AbortSignal.timeout(10000),dependencies:{readHttp:async()=>({status:200,body:target})}});},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('frozen rendered text supplements an empty static page only with bound current real target observations',async()=>{
  const f=fixture();try{
    assert.equal((await f.verify()).state,'unverified');
    const proof=f.observe();const report=await f.verify();assert.equal(report.state,'complete');assert.equal(collectionTargetGate(report,f.task,f.manifest),true);
    assert.equal(report.checks.find(check=>check.id==='rendered:/map.aspx?branch=2')?.status,'verified');
    assert.ok(proof.files.every(file=>report.artifacts.some(item=>item.name===file.name)));
    assert.match(report.checks.find(check=>check.id.startsWith('rendered:'))!.reason,/交互仍须独立实际操作/);
  }finally{f.close();}
});

test('target script strings and HTTP success cannot replace visible text or static source proof',async()=>{
  const f=fixture();try{f.observe({text:'Map loading'});assert.equal((await f.verify()).state,'incomplete');}finally{f.close();}
  const g=fixture({fullText:'Acme Company'});try{g.observe();const report=await g.verify();assert.equal(report.state,'unverified');assert.ok(report.checks.some(check=>/全文不能逐段回指/.test(check.reason)));}finally{g.close();}
});

test('missing frozen rendering cannot be filled from a later mutable run or arbitrary target screenshots',async()=>{
  const f=fixture({rendered:false});try{f.observe();f.run.sourceRenderedEvidence=[{url:sourceUrl} as SourceRenderedEvidence];f.collections.put(f.run);assert.equal((await f.verify()).state,'unverified');}finally{f.close();}
  const g=fixture();try{g.observe();g.run.sourceRenderedEvidence=[];g.collections.put(g.run);g.write('.work/raw/map.html','mutable modified raw');g.write(sourceRenderedEvidencePath,{evidence:[]});assert.equal((await g.verify()).state,'complete');}finally{g.close();}
});

test('stale task/revision, other URL/query, role or viewport observations cannot make rendered pages green',async()=>{
  for(const changes of [{binding:{taskId:'other',siteRevision:'old'}},{binding:{taskId:'same-but-no-revision'}},{binding:undefined},{url:'https://target.invalid/map.aspx?branch=3'},{url:'https://other.invalid/map.aspx?branch=2'},{role:'content'},{viewport:'mobile'}]){
    const f=fixture();try{f.observe(changes);assert.equal((await f.verify()).state,'unverified',JSON.stringify(changes));}finally{f.close();}
  }
  const f=fixture();try{f.observe();f.task.siteRevision=randomUUID();f.store.beginSiteChange(f.task);assert.equal((await f.verify()).state,'unverified');}finally{f.close();}
});

test('incomplete text, incomplete frames, corrupt JSON or absent/malformed PNG remain unverified',async()=>{
  for(const mode of ['text-truncated','frames-incomplete','bad-json-hash','corrupt-json','missing-png','non-png','wrong-role-png','unregistered-json'] as const){
    const f=fixture();try{
      const proof=f.observe(mode==='text-truncated'?{textTruncated:true}:mode==='frames-incomplete'?{framesComplete:false}:{},mode==='bad-json-hash'?{jsonHash:'0'.repeat(64)}:mode==='non-png'?{image:Buffer.from('not png')}:mode==='wrong-role-png'?{imageRole:'reference'}:mode==='unregistered-json'?{jsonName:'model-written-observation.json'}:{});
      if(mode==='corrupt-json')writeFileSync(resolve(f.work,proof.files[0].name),'tampered');
      if(mode==='missing-png')rmSync(resolve(f.work,proof.files[1].name));
      assert.equal((await f.verify()).state,'unverified',mode);
    }finally{f.close();}
  }
});

test('new complete rendered observations supersede old invalid observations in either artifact order',async()=>{
  for(const mode of ['incomplete-frames','bad-json-hash','missing-png'])for(const reversed of [false,true]){
    const f=fixture();try{
      const older=f.observe({capturedAt:100,...(mode==='incomplete-frames'?{framesComplete:false}:{})},mode==='bad-json-hash'?{jsonHash:'0'.repeat(64)}:{});
      if(mode==='missing-png')rmSync(resolve(f.work,older.files[1].name));
      const newer=f.observe({capturedAt:200});
      f.task.artifacts=reversed?[...newer.files,...older.files]:[...older.files,...newer.files];f.store.put(f.task);
      const report=await f.verify();assert.equal(report.state,'complete',mode+' '+reversed);
      const rendered=report.checks.find(check=>check.id.startsWith('rendered:'))!;assert.ok(rendered.evidence.includes(newer.files[0].name));assert.ok(!rendered.evidence.includes(older.files[0].name));
    }finally{f.close();}
  }
});

test('a newer incomplete rendered observation cannot fall back to an older complete success',async()=>{
  const f=fixture();try{
    const older=f.observe({capturedAt:100}),newer=f.observe({capturedAt:200,framesComplete:false});
    f.task.artifacts=[...older.files,...newer.files];f.store.put(f.task);
    assert.equal((await f.verify()).state,'unverified');
  }finally{f.close();}
});

test('only exact frozen source-frame URL mappings may contribute target visible text',async()=>{
  for(const external of [false,true])for(const correct of [false,true]){
    const frameUrl=external?'https://map-provider.invalid/widget?lang=en':'https://source.invalid/map-frame.aspx?branch=2';
    const f=fixture({frames:[{url:frameUrl,text:visible}]});try{
      f.observe({text:'Map content',frames:[{url:correct?(external?frameUrl:'https://target.invalid/map-frame.aspx?branch=2'):'https://wrong.invalid/frame',text:visible}]});
      assert.equal((await f.verify()).state,correct?'complete':'incomplete');
    }finally{f.close();}
  }
});

test('frozen source observation, PNG and index tampering never creates valid target expectations',async()=>{
  for(const kind of ['observation','screenshot','snapshot'] as const){const f=fixture();try{
    f.observe();const entry=f.snapshot.sourceRenderedEvidence![0];
    if(kind==='snapshot'){const snapshot=structuredClone(f.snapshot);snapshot.sourceRenderedEvidence![0].visibleText='forged';f.db.prepare('UPDATE auto_collection_snapshots SET json=? WHERE id=?').run(JSON.stringify(snapshot),snapshot.id);}
    else{const path=kind==='observation'?entry.observationPath:entry.screenshotPath,file=f.snapshot.files.find(file=>file.name==='collection/'+path)!;writeFileSync(resolve(f.directory,'materials',file.id),'corrupt');}
    assert.equal((await f.verify()).state,'unverified');
  }finally{f.close();}}
});

test('frozen target index and evaluator instructions preserve queries and require actual interaction observations',()=>{
  const f=fixture();try{
    const targets=frozenCollectionRenderedTargets(f.task,f.store,f.directory);assert.equal(targets.length,1);assert.equal(targets[0].targetUrl,targetUrl);assert.equal(targets[0].sourceUrl,sourceUrl);
    const contract=sourceRenderedEvaluationContract(targets);assert.match(contract,/必须主动用 browser\.mjs navigate/);assert.match(contract,/缩放\/平移/);assert.match(contract,/unverified/);assert.match(contract,/HTTP成功.*不能代替渲染与功能验收/);
    assert.equal(sourceRenderedEvaluationContract([]),'');
    const file=f.snapshot.files.find(file=>file.name==='collection/'+sourceRenderedEvidencePath)!;assert.ok(readFileSync(resolve(f.directory,'materials',file.id)).length>0);
  }finally{f.close();}
});
