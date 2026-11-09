import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import type { AcceptedCollectionAssetGap } from '../shared/collection.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { COLLECTION_TARGET_VERIFIER_VERSION, verifyCollectionTarget, collectionTargetGate, latestCollectionTargetReport, frozenCollectionAssetGapGuidance, frozenCollectionSourceInventory, preflightCollectionTarget, type VerifyCollectionTargetOptions } from '../server/automation/collection/target-verification.js';
import { acceptedAssetGapIndex } from '../server/automation/collection/accepted-gaps.js';
import { collectionHash } from '../server/automation/collection/runtime.js';

interface Page {path:string;title?:string;body?:string;type?:string;links?:string[]}
function fixture(pages:Page[]=[{path:'/123.aspx?q=2'}],dynamic:string[]=[]){
  const directory=mkdtempSync(resolve(tmpdir(),'collection-target-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory);
  const resource=store.saveResource({name:'Frozen migration',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},structuredClone(defaultAutomationSettings))[0];
  const manifest:RequirementManifest={id:randomUUID(),taskId:task.id,revision:1,createdAt:Date.now(),sourceComplete:true,limitations:[],items:dynamic.length?[{id:'records',title:'Records',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:dynamic.length,expectedKeys:dynamic,viewports:['business']}]:[],evidence:[],actor:'human'};
  task.requirementsId=manifest.id;
  const collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  const docs=new Map<string,string>(),records:Record<string,unknown>={};
  pages.forEach((p,index)=>{const id='u'+index,title=p.title||'Page '+index,body=p.body||'Full original body '+index,links=p.links||[];
    const document='<html><head><title>'+title+'</title></head><body><main><h1>'+title+'</h1><p>'+body+'</p>'+links.map((link,n)=>'<a href="https://source.invalid'+link+'">Record '+n+'</a>').join('')+'</main></body></html>';
    docs.set(p.path,document);write('.work/raw/'+id+'.html',document);write('.work/extract/'+id+'.json',{url:'https://source.invalid'+p.path,title,fullText:[title,body,...links.map((_,n)=>'Record '+n)].join('\n'),pageType:p.type||'page',links:links.map((link,n)=>({url:'https://source.invalid'+link,text:'Record '+n,where:'content'}))});
    records[id]={id,url:'https://source.invalid'+p.path,path:p.path,action:'keep',status:200,rawFile:'.work/raw/'+id+'.html'};
  });
  write('.work/state.json',{source:run.sourceUrl,urls:records});write('site/pages.json',pages);
  run.review={action:'ready',discoveryBasis:'frozen originals'};run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'reviewed',evidence:[]}));
  collections.freeze(run,task,manifest.id);task.generatedSiteId=randomUUID();task.siteUrl='https://target.invalid';
  store.saveSite({id:task.generatedSiteId,resourceId:task.resourceId,versionId:task.versionId,environmentId:'environment',siteId:'physical-site',name:'Target',url:task.siteUrl,createdAt:Date.now()});store.beginSiteChange(task);
  const requests:string[]=[],inspections:any[]=[];
  let transform=(body:string,_path:string)=>body.replaceAll('https://source.invalid','https://target.invalid');
  let implementation=(spec:any):unknown=>{if(spec.kind==='folders'||spec.kind==='tables')return [];throw new Error('unexpected '+JSON.stringify(spec));};
  const options:VerifyCollectionTargetOptions={task,manifest,store,vault,directory,signal:AbortSignal.timeout(20000),dependencies:{readHttp:async(uri)=>{const path=uri.pathname+uri.search;requests.push(uri.href);const source=docs.get(path);return source?{status:200,body:transform(source,path)}:{status:404,body:'missing'};},inspect:async(_task,_store,_vault,_signal,spec)=>{inspections.push(spec);return {request:spec as any,value:implementation(spec),capturedAt:Date.now(),note:''};}}};
  return {directory,db,store,task,manifest,collections,run,root,write,requests,inspections,options,docs,setTransform(value:typeof transform){transform=value;},setImplementation(value:typeof implementation){implementation=value;},verify(){return verifyCollectionTarget(options);},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const pagination=(list:unknown[],page=1,totalCount=list.length,totalPages=1,extra={})=>({list,pageNr:page,totalCount,totalPages,...extra});
const sqlite=(id:string|number,sourceUrl:string)=>[{key:'id',value:id},{key:'sourceUrl',value:sourceUrl}];

function acceptedGapBatch(f:ReturnType<typeof fixture>,paths:string[]):AcceptedCollectionAssetGap {
  return {id:randomUUID(),taskId:f.task.id,collectionId:f.run.id,inputVersionId:f.task.versionId,actor:'human',acceptedAt:Date.now(),reason:'按当前已取得素材继续',stateHash:collectionHash(f.collections.read(f.run,'.work/state.json')),evidencePath:'site/accepted-source-gaps.json',entries:paths.map(path=>({collection:'files',kind:'asset',url:'https://source.invalid'+path,status:'failed',note:'http-403'}))};
}
function freezeAcceptedGaps(f:ReturnType<typeof fixture>,paths:string[]) {
  f.run.acceptedAssetGaps=[acceptedGapBatch(f,paths)];
  f.write('site/accepted-source-gaps.json',acceptedAssetGapIndex(f.run));
  return f.collections.freeze(f.run,f.task,f.manifest.id);
}

test('static pages verify actual titles, full text, all paths and mapped links without inspecting backends',async()=>{const f=fixture([{path:'/123.aspx?q=2',links:['/456']},{path:'/456'}]);try{const report=await f.verify();assert.equal(report.state,'complete');assert.equal(collectionTargetGate(report,f.task,f.manifest),true);assert.deepEqual(f.requests,['https://target.invalid/123.aspx?q=2','https://target.invalid/456']);assert.equal(f.inspections.length,0);assert.ok(report.artifacts.every(file=>file.sha256&&file.size));assert.equal(latestCollectionTargetReport(f.store,f.task,f.manifest)?.id,report.id);}finally{f.close();}});

test('unaccepted asset hyperlinks remain required even if the mutable run later accepts them',async()=>{
  const f=fixture([{path:'/1',links:['/file.pdf?v=1']}]);
  try{
    f.setTransform(body=>body.replaceAll('https://source.invalid','https://target.invalid').replace('href="https://target.invalid/file.pdf?v=1"',''));
    f.run.acceptedAssetGaps=[acceptedGapBatch(f,['/file.pdf?v=1'])];f.collections.put(f.run);
    const report=await f.verify();assert.equal(report.state,'incomplete');assert.equal(report.checks.find(check=>check.kind==='page')?.status,'missing');
    assert.equal(frozenCollectionAssetGapGuidance(f.task,f.store,f.directory),'');
    assert.ok(!report.limitations.some(item=>item.includes('accepted-source-gaps')));
  }finally{f.close();}
});

test('only exact frozen accepted asset links may be absent; later run changes cannot expand or erase acceptance',async()=>{
  for(const otherMissing of [false,true]){
    const f=fixture([{path:'/1',links:['/file.pdf?v=1','/file.pdf?v=2']}]);
    try{
      freezeAcceptedGaps(f,['/file.pdf?v=1']);
      f.run.acceptedAssetGaps=otherMissing?[acceptedGapBatch(f,['/file.pdf?v=1','/file.pdf?v=2'])]:[];f.collections.put(f.run);
      f.setTransform(body=>{let result=body.replaceAll('https://source.invalid','https://target.invalid').replace('href="https://target.invalid/file.pdf?v=1"','');if(otherMissing)result=result.replace('href="https://target.invalid/file.pdf?v=2"','');return result;});
      const report=await f.verify();assert.equal(report.state,otherMissing?'incomplete':'complete');
      assert.match(frozenCollectionAssetGapGuidance(f.task,f.store,f.directory),/确切1项/);
      assert.ok(report.limitations.some(item=>item.includes('共 1 项（1 批）')));
      const diff=report.artifacts.find(file=>file.name.includes('page-difference'))!;
      const evidence=JSON.parse(readFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',diff.name),'utf8'));
      assert.deepEqual(evidence.acceptedMissingLinks.map((link:any)=>link.url),['https://source.invalid/file.pdf?v=1']);
      assert.deepEqual(evidence.missingLinks.map((link:any)=>link.url),otherMissing?['https://source.invalid/file.pdf?v=2']:[]);
      assert.equal(f.requests.length,1); // Acceptance does not trigger target asset probes.
    }finally{f.close();}
  }
});

test('asset/non-html discovery records may be accepted while true source page links stay required',async()=>{
  for(const reason of ['asset','non-html','http-403']){
    const f=fixture([{path:'/1',links:['/download.pdf']}]);
    try{
      const state=f.collections.json(f.run,'.work/state.json');state.urls.extra={id:'extra',url:'https://source.invalid/download.pdf',action:'exclude',reason};f.write('.work/state.json',state);
      freezeAcceptedGaps(f,['/download.pdf']);
      f.setTransform(body=>body.replaceAll('https://source.invalid','https://target.invalid').replace('href="https://target.invalid/download.pdf"',''));
      assert.equal((await f.verify()).state,reason==='http-403'?'incomplete':'complete',reason);
    }finally{f.close();}
  }
  const f=fixture([{path:'/1',links:['/2']},{path:'/2'}]);
  try{
    const state=f.collections.json(f.run,'.work/state.json');state.urls.u1.reason='asset';f.write('.work/state.json',state);
    freezeAcceptedGaps(f,['/2']);f.setTransform(body=>body.replaceAll('https://source.invalid','https://target.invalid').replace('href="https://target.invalid/2"',''));
    assert.equal((await f.verify()).state,'incomplete');
  }finally{f.close();}
});

test('accepted material gaps never excuse missing source title or body',async()=>{
  for(const missing of ['Page 0','Full original body 0']){
    const f=fixture([{path:'/1',links:['/download.pdf']}]);
    try{
      freezeAcceptedGaps(f,['/download.pdf']);f.setTransform(body=>body.replaceAll('https://source.invalid','https://target.invalid').replace('href="https://target.invalid/download.pdf"','').replaceAll(missing,'unrelated'));
      assert.equal((await f.verify()).state,'incomplete');
    }finally{f.close();}
  }
});

test('frozen acceptance guidance rejects changed snapshot hashes or task input bindings',()=>{
  const f=fixture();
  try{
    const snapshot=freezeAcceptedGaps(f,['/download.pdf']);assert.match(frozenCollectionAssetGapGuidance(f.task,f.store,f.directory),/确切1项/);
    assert.throws(()=>frozenCollectionAssetGapGuidance({...f.task,versionId:'another-input'},f.store,f.directory),/不一致/);
    snapshot.acceptedAssetGaps![0].entries.push({...snapshot.acceptedAssetGaps![0].entries[0],url:'https://source.invalid/new.pdf'});
    f.db.prepare('UPDATE auto_collection_snapshots SET json=? WHERE id=?').run(JSON.stringify(snapshot),snapshot.id);
    assert.throws(()=>frozenCollectionAssetGapGuidance(f.task,f.store,f.directory),/冻结.*校验失败/);
  }finally{f.close();}
});

test('HTTP 200 with wrong body or wrong title is a known failure',async()=>{for(const replacement of ['Full original body 0','Page 0']){const f=fixture();try{f.setTransform(body=>body.replaceAll(replacement,'unrelated'));const report=await f.verify();assert.equal(report.state,'incomplete');assert.equal(report.checks.find(c=>c.kind==='page')?.status,'missing');assert.equal(collectionTargetGate(report,f.task,f.manifest),false);}finally{f.close();}}});

test('frozen full text retains hidden source records while visible source text cannot be hidden in the target',async()=>{
  for(const mode of ['same','drop-hidden','hide-visible']){
    const f=fixture([{path:'/1'}]);try{
      const raw=f.docs.get('/1')!.replace('</main>','<p hidden>Hidden archive record</p></main>');
      f.write('.work/raw/u0.html',raw);f.docs.set('/1',raw);
      const extracted=f.collections.json(f.run,'.work/extract/u0.json');extracted.fullText+='\nHidden archive record';f.write('.work/extract/u0.json',extracted);f.collections.freeze(f.run,f.task,f.manifest.id);
      if(mode==='drop-hidden')f.setTransform(body=>body.replace('<p hidden>Hidden archive record</p>',''));
      if(mode==='hide-visible')f.setTransform(body=>body.replace('<p>Full original body 0</p>','<p hidden>Full original body 0</p>'));
      assert.equal((await f.verify()).state,mode==='same'?'complete':'incomplete',mode);
    }finally{f.close();}
  }
});

test('target text cannot merge or split source numeric tokens at inline boundaries',async()=>{
  for(const [body,replacement] of [['1 2','12'],['<span>1</span><span>2</span>','1 2']]){
    const f=fixture([{path:'/1'}]);try{
      const raw=f.docs.get('/1')!.replace('Full original body 0',body);f.write('.work/raw/u0.html',raw);f.docs.set('/1',raw);
      const extracted=f.collections.json(f.run,'.work/extract/u0.json');extracted.fullText=extracted.fullText.replace('Full original body 0',body==='1 2'?'1 2':'1\n2');f.write('.work/extract/u0.json',extracted);f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setTransform(value=>value.replace(body,replacement));assert.equal((await f.verify()).state,'incomplete');
    }finally{f.close();}
  }
});

test('same-size lists must preserve entity identity and order on every query page',async()=>{const f=fixture([{path:'/list.aspx?page=1',type:'list',links:['/101','/102']},{path:'/list.aspx?page=2',type:'list',links:['/103']},{path:'/101'},{path:'/102'},{path:'/103'}]);try{f.setTransform((body,path)=>{const mapped=body.replaceAll('https://source.invalid','https://target.invalid');return path.includes('page=1')?mapped.replaceAll('/101','/swap').replaceAll('/102','/101').replaceAll('/swap','/102'):mapped;});const report=await f.verify();assert.equal(report.checks.find(c=>c.id==='listing:/list.aspx?page=1')?.status,'missing');assert.equal(report.checks.find(c=>c.id==='listing:/list.aspx?page=2')?.status,'verified');assert.equal(report.expectedPages,5);}finally{f.close();}});

test('legacy list membership uses original regions while every extracted navigation href remains required',async()=>{
  for(const mode of ['same','missing-navigation','missing-member','wrong-order']){
    const f=fixture([{path:'/list',type:'list',links:['/navigation','/1','/2']},{path:'/navigation'},{path:'/1'},{path:'/2'}]);try{
      const anchor='<a href="https://source.invalid/navigation">Record 0</a>',raw=f.docs.get('/list')!.replace(anchor,'<nav>'+anchor+'</nav>');f.docs.set('/list',raw);f.write('.work/raw/u0.html',raw);
      // The legacy extract still says content for this URL; the immutable HTML is authoritative.
      assert.equal(f.collections.json(f.run,'.work/extract/u0.json').links[0].where,'content');f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setTransform((body,path)=>{let mapped=body.replaceAll('https://source.invalid','https://target.invalid');if(path!=='/list')return mapped;if(mode==='missing-navigation')mapped=mapped.replace('href="https://target.invalid/navigation"','');if(mode==='missing-member')mapped=mapped.replace('href="https://target.invalid/2"','');if(mode==='wrong-order')mapped=mapped.replace('href="https://target.invalid/1"','href="https://target.invalid/swap"').replace('href="https://target.invalid/2"','href="https://target.invalid/1"').replace('href="https://target.invalid/swap"','href="https://target.invalid/2"');return mapped;});
      const report=await f.verify(),listing=report.checks.find(check=>check.id==='listing:/list');assert.deepEqual(listing?.expectedKeys,['https://target.invalid/1','https://target.invalid/2'],mode);
      assert.equal(listing?.status,['same','missing-navigation'].includes(mode)?'verified':'missing',mode);assert.equal(report.checks.find(check=>check.id==='page:/list')?.status,mode==='same'?'verified':'missing',mode);assert.equal(report.state,mode==='same'?'complete':'incomplete',mode);
    }finally{f.close();}
  }
});

test('extracted-only required hrefs cannot invent original list members',async()=>{
  const f=fixture([{path:'/list',type:'list',links:['/1']},{path:'/1'},{path:'/extracted-only'}]);try{
    const extract=f.collections.json(f.run,'.work/extract/u0.json');extract.links.unshift({url:'https://source.invalid/extracted-only',text:'Legacy hint',where:'content'});f.write('.work/extract/u0.json',extract);f.collections.freeze(f.run,f.task,f.manifest.id);
    const report=await f.verify(),listing=report.checks.find(check=>check.id==='listing:/list');assert.equal(listing?.status,'verified');assert.deepEqual(listing?.expectedKeys,['https://target.invalid/1']);assert.equal(report.checks.find(check=>check.id==='page:/list')?.status,'missing');
  }finally{f.close();}
});

test('a list containing only pagination links remains unverified',async()=>{const f=fixture([{path:'/list?page=1',type:'list',links:['/list?page=2']},{path:'/list?page=2',type:'list',links:['/list?page=1']}]);try{const report=await f.verify();assert.equal(report.state,'unverified');assert.ok(report.checks.filter(c=>c.kind==='listing').every(c=>c.status==='unverified'));}finally{f.close();}});

test('changed archived originals and public materials cannot replace frozen expected evidence',async()=>{for(const raw of [true,false]){const f=fixture();try{if(raw)writeFileSync(resolve(f.directory,'collection-snapshots',f.task.collectionVersionId!,'originals','.work/extract/u0.json'),'tampered');else{const snapshot=f.collections.snapshot(f.task.collectionVersionId!)!;writeFileSync(resolve(f.directory,'materials',snapshot.files[0].id),'tampered');}const report=await f.verify();assert.equal(report.state,'unverified');assert.equal(f.requests.length,0);assert.ok(report.checks.some(c=>c.kind==='binding'&&c.status==='unverified'));}finally{f.close();}}});

test('later mutable collection work cannot invalidate an earlier frozen original',async()=>{const f=fixture();try{f.write('.work/extract/u0.json',{title:'new revision',fullText:'new revision'});f.write('.work/raw/u0.html','changed working copy');assert.equal((await f.verify()).state,'complete');}finally{f.close();}});

test('real bundled Python records-object parts and legacy array parts preserve frozen identities and counts',async()=>{
  for(const shape of ['python-records','legacy-array']){
    const f=fixture([{path:'/1'},{path:'/2'}],['group:101','group:102']);try{
      const records=[{sourceId:'101',url:'https://source.invalid/1',path:'/1'},{sourceId:'102',url:'https://source.invalid/2',path:'/2'}];mkdirSync(resolve(f.root,'data'),{recursive:true});
      const parts=JSON.parse(execFileSync('python3',['-c','import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom siteharvest.dataset import _write_parts\nprint(json.dumps(_write_parts(sys.argv[2], "group", json.loads(sys.argv[3]))))',resolve('engines/site-harvest'),resolve(f.root,'data'),JSON.stringify(records)],{encoding:'utf8'}));
      assert.ok(parts.length);for(const part of parts){const payload=JSON.parse(readFileSync(resolve(f.root,part.file),'utf8'));assert.ok(Array.isArray(payload.records));assert.equal(part.count,payload.records.length);if(shape==='legacy-array')f.write(part.file,payload.records);}
      f.write('data/page-groups.json',{source:f.run.sourceUrl,pageGroups:[{id:'group',status:'ready',count:2,dataFile:'data/group.json'}]});f.write('data/group.json',{pageGroup:'group',source:f.run.sourceUrl,count:2,parts});f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Records']:pagination([sqlite('one','https://source.invalid/1'),sqlite('two','https://source.invalid/2')]));
      const report=await f.verify();assert.equal(report.state,'complete',shape);assert.equal(report.checkedPages,2,shape);assert.equal(report.checks.find(check=>check.id==='data:records')?.status,'verified',shape);
      assert.deepEqual(report.checks.find(check=>check.id==='data:records')?.actualKeys,f.manifest.items[0].expectedKeys,shape);
    }finally{f.close();}
  }
});

test('dataset part compatibility does not waive frozen counts, references or source identities',async()=>{
  for(const mode of ['part-count','group-count','index-count','missing-part','duplicate-part','invalid-shape','foreign-record','wrong-path','duplicate-url','duplicate-source-id','wrong-index-source','wrong-index-group']){
    const f=fixture([{path:'/1'},{path:'/2'}]);try{
      const records=[{sourceId:'101',url:'https://source.invalid/1',path:'/1'},{sourceId:'102',url:'https://source.invalid/2',path:'/2'}];
      if(mode==='foreign-record')records[1].url='https://foreign.invalid/2';if(mode==='wrong-path')records[1].path='/wrong';if(mode==='duplicate-url'){records[1].url=records[0].url;records[1].path=records[0].path;}if(mode==='duplicate-source-id')records[1].sourceId=records[0].sourceId;
      const part={file:mode==='missing-part'?'data/absent.json':'data/group.part-01.json',count:mode==='part-count'?3:2};
      f.write('data/page-groups.json',{source:f.run.sourceUrl,pageGroups:[{id:'group',count:mode==='group-count'?3:2,dataFile:'data/group.json'}]});f.write('data/group.json',{source:mode==='wrong-index-source'?'https://foreign.invalid/':f.run.sourceUrl,pageGroup:mode==='wrong-index-group'?'invented':'group',count:mode==='index-count'?3:2,parts:mode==='duplicate-part'?[part,part]:[part]});f.write('data/group.part-01.json',mode==='invalid-shape'?{items:records}:{records});f.collections.freeze(f.run,f.task,f.manifest.id);
      const report=await f.verify();assert.equal(report.state,'unverified',mode);assert.equal(report.checkedPages,0,mode);assert.equal(f.requests.length,0,mode);assert.ok(report.checks.some(check=>check.id==='binding-error'),mode);
    }finally{f.close();}
  }
});

test('Content reads all folders, all pages and each full contentItem before matching unique source identities',async()=>{const f=fixture([{path:'/1'},{path:'/2'},{path:'/3'}],['/1','/2','/3']),folders=[randomUUID(),randomUUID()],ids=[randomUUID(),randomUUID(),randomUUID()];try{f.setImplementation((spec)=>{if(spec.kind==='folders')return [{id:folders[0],children:[{id:folders[1]}]}];if(spec.kind==='tables')return [];if(spec.kind==='content'){const selected=spec.id===folders[0]?[{id:ids[spec.page-1]}]:[{id:ids[2]}];return pagination(selected,spec.page,spec.id===folders[0]?2:1,spec.id===folders[0]?2:1);}if(spec.kind==='contentItem')return {properties:[{name:'sourceUrl',values:{en:'https://source.invalid/'+(ids.indexOf(spec.id)+1)}},{name:'body',values:{en:'full body'}}]};throw new Error('unexpected');});const report=await f.verify();assert.equal(report.state,'complete');assert.equal(f.inspections.filter(spec=>spec.kind==='content').length,3);assert.equal(f.inspections.filter(spec=>spec.kind==='contentItem').length,3);}finally{f.close();}});

test('truncated Content summaries cannot substitute for full contentItem mappings',async()=>{const f=fixture([{path:'/1'}],['/1']),folder=randomUUID(),id=randomUUID();try{f.setImplementation(spec=>spec.kind==='folders'?[{id:folder}]:spec.kind==='tables'?[]:spec.kind==='content'?pagination([{id,sourceUrl:'https://source.invalid/1'}]):{properties:[{name:'body',values:{en:'without mapping'}}]});const report=await f.verify();assert.equal(report.state,'unverified');assert.equal(report.checks.find(c=>c.id==='data:records')?.status,'unverified');}finally{f.close();}});

test('SQLite cell records enumerate every table and page; same count with wrong or duplicate identities remains unverified',async()=>{for(const mode of ['valid','wrong','duplicate']){const f=fixture([{path:'/1'},{path:'/2'}],['/1','/2']);try{f.setImplementation(spec=>{if(spec.kind==='folders')return [];if(spec.kind==='tables')return ['Records','Other'];if(spec.table==='Other')return pagination([],1,0,0,{primaryKey:'id'});const suffix=mode==='wrong'?'99':mode==='duplicate'?'1':String(spec.page);return pagination([sqlite(spec.page,'https://source.invalid/'+suffix)],spec.page,2,2,{primaryKey:'id'});});const report=await f.verify();assert.equal(report.state,mode==='valid'?'complete':'unverified');assert.equal(f.inspections.filter(spec=>spec.kind==='rows').length,3);}finally{f.close();}}});

test('changing or repeated pagination cannot establish inventory completeness',async()=>{for(const repeated of [true,false]){const f=fixture([{path:'/1'},{path:'/2'}],['/1','/2']);try{f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Records']:pagination([sqlite(repeated?1:spec.page,'https://source.invalid/'+(repeated?1:spec.page))],spec.page,spec.page===2&&!repeated?3:2,2,{primaryKey:'id'}));const report=await f.verify();assert.equal(report.state,'unverified');assert.equal(report.checks.find(c=>c.id==='inventory:sqlite')?.status,'unverified');}finally{f.close();}}});

test('a container without real primary keys cannot starve later tables or certify global inventory',async()=>{
  const f=fixture([{path:'/1'}],['/1']);try{
    f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['CatItem','ShowRecord','PageIndex']:spec.table==='CatItem'?pagination([[{key:'sourceUrl',value:'https://source.invalid/1'}]],1,1,1,{primaryKey:''}):pagination([sqlite(1,'https://source.invalid/1')],1,1,1,{primaryKey:'id'}));
    const report=await f.verify();assert.deepEqual(f.inspections.filter(spec=>spec.kind==='rows').map(spec=>spec.table),['CatItem','ShowRecord','PageIndex']);
    assert.equal(report.checks.find(check=>check.id==='inventory:sqlite:CatItem')?.failureClass,'contract-tool-defect');assert.equal(report.checks.find(check=>check.id==='data:records')?.status,'unverified');assert.equal(report.state,'unverified');
    assert.equal(report.issues.length,0);const errors=report.artifacts.filter(file=>file.name.includes('implementation-error'));assert.ok(errors.some(file=>readFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',file.name),'utf8').includes('CatItem')));
  }finally{f.close();}
});

test('failed Content and declaration containers retain gaps while subsequent folders and tables are read',async()=>{
  const f=fixture([{path:'/1'}],['/1']),folders=[randomUUID(),randomUUID()],record=randomUUID();try{
    f.setImplementation(spec=>{
      if(spec.kind==='tables')return ['CollectionRecordBindings','CollectionRelationBindings','Records'];if(spec.table==='CollectionRecordBindings')return pagination([[{key:'sourceUrl',value:'https://source.invalid/1'}]],1,1,1,{primaryKey:''});
      if(spec.table==='CollectionRelationBindings')return pagination([],1,0,0);if(spec.table==='Records')return pagination([sqlite(1,'https://source.invalid/1')]);
      if(spec.kind==='folders')return folders.map(id=>({id}));if(spec.kind==='content'){if(spec.id===folders[0])throw new Error('temporary network failure');return pagination([{id:record}]);}if(spec.kind==='contentItem')return {sourceUrl:'https://source.invalid/1'};throw new Error('unexpected');
    });
    const report=await f.verify();assert.ok(f.inspections.some(spec=>spec.table==='CollectionRelationBindings'));assert.ok(f.inspections.some(spec=>spec.table==='Records'));assert.ok(f.inspections.some(spec=>spec.kind==='contentItem'&&spec.id===record));
    assert.equal(report.checks.find(check=>check.id==='inventory:sqlite:CollectionRecordBindings')?.failureClass,'contract-tool-defect');assert.equal(report.checks.find(check=>check.id==='inventory:content:'+folders[0])?.failureClass,'transient-incomplete');assert.equal(report.state,'unverified');
  }finally{f.close();}
});

test('independent source mappings must point to an actual unique inventory record',async()=>{for(const valid of [true,false]){const f=fixture([{path:'/1'}],['/1']);try{f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Records','Mapping']:spec.table==='Records'?pagination([{id:'record-1',body:'actual'}],1,1,1,{primaryKey:'id'}):pagination([{id:'mapping-1',sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Records',targetId:valid?'record-1':'missing'}],1,1,1,{primaryKey:'id'}));assert.equal((await f.verify()).state,valid?'complete':'unverified');}finally{f.close();}}});

test('canonical declarations select actual records over duplicate page indexes and skip unrelated body tables only with full frozen coverage',async()=>{
  for(const duplicateDeclaration of [false,true]){
    const f=fixture([{path:'/1'}],['/1']);try{
      const binding={id:'b1',requirementId:'records',sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Canonical',targetId:'one'};
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];
        if(spec.kind==='tables')return ['SitePage','Canonical','Mapping','Paragraph','CollectionRecordBindings'];
        if(spec.table==='CollectionRecordBindings')return pagination(duplicateDeclaration?[binding,{...binding,id:'b2'}]:[binding]);
        if(spec.table==='Canonical')return pagination([{id:'one',oldUrl:'https://source.invalid/1'}]);
        throw new Error('unrelated table must not be read: '+spec.table);
      });
      const report=await f.verify();assert.equal(report.state,'complete');
      assert.deepEqual(f.inspections.filter(spec=>spec.kind==='rows').map(spec=>spec.table),['CollectionRecordBindings','Canonical']);
      assert.ok(report.checks.find(check=>check.id==='data:records')?.evidence.length);
    }finally{f.close();}
  }
});

test('canonical bindings reject forged, ambiguous, foreign and wrong actual pointers',async()=>{
  for(const mode of ['missing-record','wrong-container','wrong-kind','actual-unmapped','actual-foreign','actual-extra-foreign','binding-foreign','unknown-requirement','ambiguous','incomplete-index']){
    const f=fixture([{path:'/1'}],['/1']);try{
      const binding={id:'b1',requirementId:mode==='unknown-requirement'?'invented':'records',sourceUrl:mode==='binding-foreign'?'https://foreign.invalid/1':'https://source.invalid/1',targetKind:mode==='wrong-kind'?'content':'sqlite',targetContainer:mode==='wrong-container'?'Missing':'Canonical',targetId:mode==='missing-record'?'missing':'one'};
      const record:any={id:'one',sourceUrl:mode==='actual-foreign'?'https://foreign.invalid/1':'https://source.invalid/1'};
      if(mode==='actual-unmapped')delete record.sourceUrl;
      if(mode==='actual-extra-foreign')record.oldUrl='https://foreign.invalid/1';
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];
        if(spec.kind==='tables')return ['Canonical','SitePage','CollectionRecordBindings'];
        if(spec.table==='Canonical')return pagination([record,{id:'other',sourceUrl:'https://source.invalid/1'}]);
        if(spec.table==='SitePage')return pagination([{id:'page',sourceUrl:'https://source.invalid/1'}]);
        return mode==='incomplete-index'?pagination([binding],1,2,1):pagination(mode==='ambiguous'?[binding,{...binding,id:'b2',targetId:'other'}]:[binding]);
      });
      const report=await f.verify();assert.equal(report.state,'unverified',mode);assert.equal(collectionTargetGate(report,f.task,f.manifest),false,mode);
      if(['binding-foreign','unknown-requirement'].includes(mode))assert.equal(report.checks.find(check=>check.id==='record-bindings')?.failureClass,'contract-tool-defect',mode);
      if(!['binding-foreign','unknown-requirement'].includes(mode))assert.equal(report.checks.find(check=>check.id==='data:records')?.status,'unverified',mode);
    }finally{f.close();}
  }
});

test('legacy duplicate indexes pointing to the same actual record merge evidence; different records remain ambiguous',async()=>{
  for(const distinct of [false,true]){
    const f=fixture([{path:'/1'}],['/1']);try{
      f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Canonical','Mapping']:spec.table==='Canonical'?pagination([{id:'one',sourceUrl:'https://source.invalid/1'},...(distinct?[{id:'two',sourceUrl:'https://source.invalid/1'}]:[])]):pagination(['a','b'].map(id=>({id,sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Canonical',targetId:'one'}))));
      assert.equal((await f.verify()).state,distinct?'unverified':'complete');
    }finally{f.close();}
  }
});

test('partial canonical declarations preserve full enumeration and cannot hide duplicate undeclared records',async()=>{
  const f=fixture([{path:'/1'},{path:'/2'}],['/1','/2']);try{
    f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Canonical','SitePage','Paragraph','CollectionRecordBindings']:spec.table==='CollectionRecordBindings'?pagination([{id:'b1',requirementId:'records',sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Canonical',targetId:'one'}]):spec.table==='Canonical'?pagination([{id:'one',sourceUrl:'https://source.invalid/1'},{id:'two',sourceUrl:'https://source.invalid/2'}]):spec.table==='SitePage'?pagination([{id:'page1',sourceUrl:'https://source.invalid/1'},{id:'page2',sourceUrl:'https://source.invalid/2'}]):pagination([]));
    const report=await f.verify();assert.equal(report.state,'unverified');assert.ok(f.inspections.some(spec=>spec.kind==='rows'&&spec.table==='Paragraph'));
  }finally{f.close();}
});

test('canonical selection remains explicit when partial coverage requires reading competing indexes',async()=>{
  const f=fixture([{path:'/1'},{path:'/static'}],['/1']);try{
    f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Canonical','SitePage','Mapping','CollectionRecordBindings']:spec.table==='CollectionRecordBindings'?pagination([{id:'b1',requirementId:'records',sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Canonical',targetId:'one'}]):spec.table==='Canonical'?pagination([{id:'one',sourceUrl:'https://source.invalid/1'}]):spec.table==='SitePage'?pagination([{id:'page1',sourceUrl:'https://source.invalid/1'}]):pagination(['m1','m2'].map(id=>({id,sourceUrl:'https://source.invalid/1',targetKind:'sqlite',targetContainer:'Canonical',targetId:'one'}))));
    assert.equal((await f.verify()).state,'complete');assert.ok(f.inspections.some(spec=>spec.table==='SitePage'));assert.ok(f.inspections.some(spec=>spec.table==='Mapping'));
  }finally{f.close();}
});

test('canonical narrowing retains relation parents, child records and declared join table',async()=>{
  const f=fixture([{path:'/category?page=2',type:'list',links:['/1','/2']},{path:'/1'},{path:'/2'}],['/1','/2']);try{
    f.setImplementation(spec=>{
      if(spec.kind==='folders')return [];
      if(spec.kind==='tables')return ['Canonical','CollectionRecordBindings','CollectionRelationBindings','Joins','Paragraph'];
      if(spec.table==='CollectionRecordBindings')return pagination(['/category?page=2','/1','/2'].map((path,index)=>({id:'b'+index,requirementId:'records',sourceUrl:'https://source.invalid'+path,targetKind:'sqlite',targetContainer:'Canonical',targetId:['category','one','two'][index]})));
      if(spec.table==='CollectionRelationBindings')return pagination([{id:'r1',sourcePath:'/category?page=2',tableName:'Joins',parentField:'parent',childField:'child',orderField:'position'}]);
      if(spec.table==='Canonical')return pagination([sqlite('category','https://source.invalid/category?page=2'),sqlite('one','https://source.invalid/1'),sqlite('two','https://source.invalid/2')]);
      if(spec.table==='Joins')return pagination([{id:'j1',parent:'category',child:'one',position:1},{id:'j2',parent:'category',child:'two',position:2}]);
      throw new Error('unrelated table read');
    });
    const report=await f.verify();assert.equal(report.state,'complete');assert.equal(report.checks.find(check=>check.kind==='relations')?.status,'verified');assert.ok(!f.inspections.some(spec=>spec.table==='Paragraph'));
  }finally{f.close();}
});

test('explicit relation identity verifies source numeric keys and per-page scope even when pagination is not typed list',async()=>{
  for(const mode of ['valid','missing','extra','duplicate','order','duplicate-order','target-order','wrong-parent','foreign-scope','missing-identity','missing-scope','missing-child-field','missing-order','duplicate-identity','manifest-mismatch','fake-extracted-link']){
    const f=fixture([{path:'/category',type:mode==='target-order'?'page':'list',links:['/1','/2']},{path:'/category?page=2',type:'page',links:['/3']},{path:'/1'},{path:'/2'},{path:'/3'}],['/1','/2','/3']);try{
      const parentPaths=['/category','/category?page=2'],pairs=[['/category','/1'],['/category','/2'],['/category?page=2','/3']].map(([parent,child])=>JSON.stringify(['https://source.invalid'+parent,'https://source.invalid'+child]));
      f.manifest.items.push({id:'parents',title:'Parent routes',kind:'page',required:true,source:'frozen',expectation:'all',paths:parentPaths,expectedCount:2,viewports:['desktop','mobile']},{id:'edges',title:'Relationships',kind:'data',required:true,source:'frozen',expectation:'all ordered edges',paths:[],expectedCount:3,expectedKeys:mode==='manifest-mismatch'?[pairs[0],pairs[1],JSON.stringify(['https://source.invalid/category?page=2','https://source.invalid/2'])]:pairs,viewports:['business'],dataIdentity:{kind:'relations',parentRequirementIds:['parents'],childRequirementIds:['records']}});
      if(mode==='fake-extracted-link'){const extracted=f.collections.json(f.run,'.work/extract/u1.json');extracted.links.push({url:'https://source.invalid/2',text:'',where:'content'});f.write('.work/extract/u1.json',extracted);}
      f.collections.freeze(f.run,f.task,f.manifest.id);
      if(mode==='target-order')f.setTransform((body,path)=>{const mapped=body.replaceAll('https://source.invalid','https://target.invalid');return path==='/category'?mapped.replaceAll('href="https://target.invalid/1"','href="https://target.invalid/swap"').replaceAll('href="https://target.invalid/2"','href="https://target.invalid/1"').replaceAll('href="https://target.invalid/swap"','href="https://target.invalid/2"'):mapped;});
      const canonical=[{id:'p1',sourceUrl:'https://source.invalid/category',categoryId:'7'},{id:'p2',sourceUrl:'https://source.invalid/category?page=2',categoryId:'7'},...[1,2,3].map(id=>({id:'surrogate-'+id,sourceUrl:'https://source.invalid/'+id,sourceId:mode==='duplicate-identity'&&id===2?'1':String(id)}))];
      if(mode==='missing-identity')delete (canonical[2] as any).sourceId;
      const joins:any[]=[{id:'j1',categoryId:'7',showId:'1',sourcePath:'/category',position:1},{id:'j2',categoryId:'7',showId:'2',sourcePath:'/category',position:2},{id:'j3',categoryId:'7',showId:'3',sourcePath:'/category?page=2',position:1}];
      if(mode==='missing')joins.pop();if(mode==='extra')joins.push({id:'j4',categoryId:'7',showId:'3',sourcePath:'/category',position:3});if(mode==='duplicate')joins.push({...joins[0],id:'j4'});if(mode==='order'){joins[0].position=2;joins[1].position=1;}if(mode==='duplicate-order')joins[1].position=1;if(mode==='wrong-parent')joins[2].categoryId='99';if(mode==='foreign-scope')joins[2].sourcePath='https://foreign.invalid/category';
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];
        if(spec.kind==='tables')return ['Canonical','Joins','Paragraph','CollectionRecordBindings','CollectionRelationBindings'];
        if(spec.table==='CollectionRecordBindings')return pagination(canonical.map((row,index)=>({id:'b'+index,requirementId:index<2?'parents':'records',sourceUrl:row.sourceUrl,targetKind:'sqlite',targetContainer:'Canonical',targetId:row.id,...(index>=2?{identityKeyField:'sourceId'}:{})})));
        if(spec.table==='CollectionRelationBindings')return pagination(parentPaths.map((path,index)=>({id:'r'+index,sourcePath:path,tableName:'Joins',parentField:'categoryId',childField:mode==='missing-child-field'?'invented':'showId',...(mode==='missing-order'?{}:{orderField:'position'}),parentIdentityField:'categoryId',childIdentityField:'sourceId',...(mode==='missing-scope'?{}:{sourcePathField:'sourcePath'})})));
        if(spec.table==='Canonical')return pagination(canonical);
        if(spec.table==='Joins')return pagination(joins);
        throw new Error('unrelated body table must not be read');
      });
      const report=await f.verify(),relation=report.checks.find(check=>check.id==='data:edges');
      const expected=['valid','fake-extracted-link'].includes(mode)?'verified':['missing-identity','missing-scope','missing-child-field','missing-order','duplicate-identity','manifest-mismatch'].includes(mode)?'unverified':'missing';
      assert.equal(relation?.status,expected,mode);assert.equal(relation?.kind,'relations',mode);
      if(mode!=='manifest-mismatch')assert.ok(report.checks.some(check=>check.requirementId==='edges'&&check.sourcePath==='/category?page=2'),mode);
      assert.ok(!f.inspections.some(spec=>spec.table==='Paragraph'),mode);
      if(mode==='valid')assert.deepEqual(relation?.actualKeys,pairs);
      assert.ok(!report.checks.some(check=>check.id==='relations:/category'),mode);
    }finally{f.close();}
  }
});

test('explicit relation parent scope owns membership while missing members and wrong order still fail',async()=>{
  for(const mode of ['same','missing-output-member','wrong-output-order','missing-backend-member','wrong-backend-order']){
    const f=fixture([{path:'/parent',type:'list',links:['/navigation','/1','/2']},{path:'/navigation'},{path:'/1'},{path:'/2'}],['/1','/2']);try{
      const pairs=[1,2].map(id=>JSON.stringify(['https://source.invalid/parent','https://source.invalid/'+id]));
      f.manifest.items.push({id:'parents',title:'Parent scope',kind:'page',required:true,source:'frozen',expectation:'all',paths:['/parent'],expectedCount:1,viewports:['desktop','mobile']},{id:'edges',title:'Fixed child domain',kind:'data',required:true,source:'frozen',expectation:'ordered child records',paths:[],expectedCount:2,expectedKeys:pairs,viewports:['business'],dataIdentity:{kind:'relations',parentRequirementIds:['parents'],childRequirementIds:['records']}});f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setTransform((body,path)=>{let mapped=body.replaceAll('https://source.invalid','https://target.invalid');if(path!=='/parent')return mapped;const anchor='<a href="https://target.invalid/navigation">Record 0</a>';mapped=mapped.replace(anchor,'<nav>'+anchor+'</nav>');if(mode==='missing-output-member')mapped=mapped.replace('href="https://target.invalid/2"','');if(mode==='wrong-output-order')mapped=mapped.replace('href="https://target.invalid/1"','href="https://target.invalid/swap"').replace('href="https://target.invalid/2"','href="https://target.invalid/1"').replace('href="https://target.invalid/swap"','href="https://target.invalid/2"');return mapped;});
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];if(spec.kind==='tables')return ['Records','Joins'];if(spec.table==='Records')return pagination([{id:'parent',sourceUrl:'https://source.invalid/parent'},{id:'one',sourceUrl:'https://source.invalid/1'},{id:'two',sourceUrl:'https://source.invalid/2'}]);
        const joins=[{id:'j1',parent:'parent',child:'one',sourcePath:'/parent',position:mode==='wrong-backend-order'?2:1},{id:'j2',parent:'parent',child:'two',sourcePath:'/parent',position:mode==='wrong-backend-order'?1:2}];return pagination(mode==='missing-backend-member'?joins.slice(0,1):joins);
      });
      const report=await verifyCollectionTarget({...f.options,relationBindings:[{sourcePath:'/parent',table:'Joins',parentField:'parent',childField:'child',orderField:'position',sourcePathField:'sourcePath'}]}),relation=report.checks.find(check=>check.id==='data:edges');
      assert.equal(report.verifierVersion,4);assert.ok(!report.checks.some(check=>check.id==='listing:/parent'));assert.equal(relation?.status,mode==='same'?'verified':'missing',mode);assert.equal(report.checks.find(check=>check.id==='relations:edges:/parent')?.status,mode==='same'?'verified':'missing',mode);assert.equal(report.state,mode==='same'?'complete':'incomplete',mode);
    }finally{f.close();}
  }
});

test('relations domain rejects unsupported references, alias duplication and noncanonical source edge keys',async()=>{
  for(const mode of ['missing-ref','optional-ref','duplicate-alias','count-null','foreign-key','relative-key']){
    const f=fixture([{path:'/parent',links:['/1']},{path:'/1'}],['/1']);try{
      if(mode==='optional-ref')f.manifest.items[0].required=false;
      if(mode==='duplicate-alias'){f.manifest.items[0].expectedKeys=['/1','u1'];f.manifest.items[0].expectedCount=2;}
      const key=JSON.stringify([mode==='foreign-key'?'https://foreign.invalid/parent':mode==='relative-key'?'/parent':'https://source.invalid/parent','https://source.invalid/1']);
      f.manifest.items.push({id:'parents',title:'Parent',kind:'page',required:true,source:'frozen',expectation:'all',paths:['/parent'],expectedCount:1,viewports:['desktop','mobile']},{id:'edges',title:'Edges',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:mode==='count-null'?null:1,expectedKeys:[key],viewports:['business'],dataIdentity:{kind:'relations',parentRequirementIds:['parents'],childRequirementIds:[mode==='missing-ref'?'unknown':'records']}});f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?[]:pagination([]));
      assert.equal((await f.verify()).checks.find(check=>check.id==='data:edges')?.status,'unverified',mode);
    }finally{f.close();}
  }
});

test('zero source edges inspect target output and only explicit per-page storage scope can prove zero backend edges',async()=>{
  for(const mode of ['no-declaration','other-page-only','target-extra','scoped-zero','scoped-extra','missing-field','nonempty-unbound','source-missing']){
    const f=fixture([{path:'/list',type:'page',links:['/1']},{path:'/empty',type:'page'},{path:'/1'}],['/1']);try{
      f.manifest.items.push({id:'all-pages',title:'All frozen paths',kind:'page',required:true,source:'frozen',expectation:'all',paths:['/list','/empty','/1'],expectedCount:3,viewports:['desktop','mobile']},{id:'edges',title:'Edges',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:1,expectedKeys:[JSON.stringify(['https://source.invalid/list','https://source.invalid/1'])],viewports:['business'],dataIdentity:{kind:'relations',parentRequirementIds:['all-pages'],childRequirementIds:['records']}});const snapshot=f.collections.freeze(f.run,f.task,f.manifest.id);
      if(mode==='source-missing')rmSync(resolve(f.directory,'collection-snapshots',snapshot.id,'originals','.work/raw/u1.html'));
      if(mode==='target-extra')f.setTransform((body,path)=>body.replaceAll('https://source.invalid','https://target.invalid').replace('</main>',path==='/empty'?'<a href="https://target.invalid/1">Extra child</a></main>':'</main>'));
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];
        if(spec.kind==='tables')return ['Records','Joins','CollectionRelationBindings'];
        if(spec.table==='Records')return pagination([{id:'parent',sourceUrl:'https://source.invalid/list'},{id:'one',sourceUrl:'https://source.invalid/1'}]);
        if(spec.table==='Joins')return pagination([{id:'j1',parent:'parent',child:'one',sourcePath:'/list',position:1},...(mode==='scoped-extra'?[{id:'j2',parent:'unmapped-empty-parent',child:'one',sourcePath:'/empty',position:1}]:[])]);
        const paths=[...(mode==='nonempty-unbound'?[]:['/list']),...(['scoped-zero','scoped-extra','missing-field'].includes(mode)?['/empty']:[])];
        return pagination(paths.map((sourcePath,index)=>({id:'r'+index,sourcePath,tableName:'Joins',parentField:'parent',childField:mode==='missing-field'&&sourcePath==='/empty'?'invented':'child',orderField:'position',sourcePathField:'sourcePath'})));
      });
      const report=await f.verify();if(mode==='source-missing'){assert.equal(report.checkedPages,0);assert.ok(report.checks.some(check=>check.id==='binding-error'));assert.ok(!report.checks.some(check=>check.sourcePath==='/empty'));continue;}
      const empty=report.checks.find(check=>check.id==='relations:edges:/empty');assert.equal(empty?.status,mode==='scoped-zero'?'verified':['target-extra','scoped-extra'].includes(mode)?'missing':'unverified',mode);
      if(['no-declaration','other-page-only'].includes(mode))assert.match(empty!.reason,/原件与目标正文已确认零边.*不能从其他页声明/);
      if(mode==='scoped-zero')assert.ok(!f.inspections.some(spec=>spec.kind==='contentItem')); // No invented parent record is required.
      if(mode==='nonempty-unbound')assert.equal(report.checks.find(check=>check.id==='relations:edges:/list')?.status,'unverified');
      assert.equal(report.checks.find(check=>check.id==='relations:edges:/1')?.status,'unverified'); // Other-page declarations never establish global zero-edge coverage.
    }finally{f.close();}
  }
});

test('explicit asset identity uses frozen bytes and unique target digests while retaining missing CSS originals as source gaps',async()=>{
  for(const mode of ['valid','wrong-bytes','wrong-material','foreign-target','empty-keys','missing-css','unknown-binding']){
    const f=fixture([{path:'/1'}]);try{
      const bytes=Buffer.from([0,255,128,34,10]),path='images/frozen.bin',keys=['https://source.invalid/a.bin','https://cdn.invalid/b.bin'];
      mkdirSync(resolve(f.root,'images'),{recursive:true});writeFileSync(resolve(f.root,path),bytes);
      const state=f.collections.json(f.run,'.work/state.json');state.assets=keys.map(url=>({url,status:'saved',localPath:path,hash:collectionHash(bytes),bytes:bytes.length}));if(mode==='missing-css')state.stylesheets=[{url:'https://source.invalid/site.css',status:'read'}];f.write('.work/state.json',state);
      f.manifest.items=[{id:'assets',title:'Assets',kind:'data',required:true,source:'frozen',expectation:'all source assets and acquired CSS',paths:[],expectedCount:mode==='empty-keys'?null:2,expectedKeys:mode==='empty-keys'?[]:keys,viewports:['business'],dataIdentity:{kind:'assets'}}];f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setImplementation(spec=>{
        if(spec.kind==='tables')return ['CollectionAssetBindings','Paragraph'];
        if(spec.table==='CollectionAssetBindings')return pagination([...keys.map((sourceUrl,index)=>({id:'a'+index,sourceUrl,materialPath:mode==='wrong-material'?'images/invented.bin':path,targetUrl:mode==='foreign-target'?'https://foreign.invalid/a.bin':'https://target.invalid/a.bin'})),...(mode==='unknown-binding'?[{id:'extra',sourceUrl:'https://invented.invalid/a.bin',materialPath:path,targetUrl:'https://target.invalid/a.bin'}]:[])]);
        throw new Error('assets must not enumerate unrelated backend data');
      });
      const digestRequests:string[]=[];f.options.dependencies!.readAsset=async(targetUrl)=>{digestRequests.push(targetUrl);return {url:targetUrl,finalUrl:targetUrl,status:200,sha256:collectionHash(mode==='wrong-bytes'?Buffer.from('wrong'):bytes),size:bytes.length};};
      const report=await f.verify(),asset=report.checks.find(check=>check.id==='data:assets');
      assert.equal(asset?.status,mode==='wrong-bytes'?'missing':['wrong-material','foreign-target','empty-keys'].includes(mode)?'unverified':'verified',mode);
      assert.equal(report.state,mode==='valid'?'complete':mode==='wrong-bytes'?'incomplete':'unverified',mode);
      assert.ok(f.inspections.every(spec=>spec.kind==='tables'||spec.table==='CollectionAssetBindings'),mode);
      assert.equal(digestRequests.length,['wrong-material','foreign-target','empty-keys'].includes(mode)?0:1,mode);
      if(mode==='missing-css')assert.equal(report.checks.find(check=>check.id==='assets:stylesheets')?.status,'unverified');
      if(mode==='unknown-binding')assert.equal(report.checks.find(check=>check.id==='asset-bindings')?.status,'unverified');
    }finally{f.close();}
  }
});

test('asset digests resume within the exact revision binding and never persist binary response bodies',async()=>{
  const f=fixture([{path:'/1'}]);try{
    const keys=['https://source.invalid/a.bin','https://source.invalid/b.bin'],paths=['images/a.bin','images/b.bin'],bytes=paths.map((_,index)=>Buffer.from([0,255,index]));mkdirSync(resolve(f.root,'images'),{recursive:true});paths.forEach((path,index)=>writeFileSync(resolve(f.root,path),bytes[index]));
    const state=f.collections.json(f.run,'.work/state.json');state.assets=keys.map((url,index)=>({url,status:'saved',localPath:paths[index],hash:collectionHash(bytes[index]),bytes:bytes[index].length}));f.write('.work/state.json',state);
    f.manifest.items=[{id:'assets',title:'Assets',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:2,expectedKeys:keys,viewports:['business'],dataIdentity:{kind:'assets'}}];f.collections.freeze(f.run,f.task,f.manifest.id);
    f.setImplementation(spec=>spec.kind==='tables'?['CollectionAssetBindings']:pagination(keys.map((sourceUrl,index)=>({id:'a'+index,sourceUrl,materialPath:paths[index],targetUrl:'https://target.invalid/'+(index?'b':'a')+'.bin'}))));
    const requests:string[]=[];f.options.dependencies!.readAsset=async(targetUrl)=>{requests.push(targetUrl);const index=targetUrl.endsWith('/b.bin')?1:0;return {url:targetUrl,finalUrl:targetUrl,status:200,sha256:collectionHash(bytes[index]),size:bytes[index].length};};f.options.maxRequests=1;
    let report=await f.verify(),rounds=1;while(report.state==='pending'&&rounds++<10)report=await f.verify();assert.equal(report.state,'complete');assert.equal(requests.length,2);assert.equal(f.requests.length,1);await f.verify();assert.equal(requests.length,2);
    for(const file of report.artifacts.filter(file=>file.name.includes('observation'))){const value=JSON.parse(readFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',file.name),'utf8'));if(String(value.key).startsWith('asset:')){assert.deepEqual(Object.keys(value.value).sort(),['finalUrl','sha256','size','status','url']);}}
    f.task.siteRevision=randomUUID();f.store.beginSiteChange(f.task);f.options.maxRequests=50;assert.equal((await f.verify()).state,'complete');assert.equal(requests.length,4);
  }finally{f.close();}
});

test('page output does not prove backend relations; explicit SQLite joins must match frozen members',async()=>{for(const mode of ['absent','correct','wrong']){const f=fixture([{path:'/category',type:'list',links:['/1','/2']},{path:'/1'},{path:'/2'}],['/1','/2']);try{f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Records','Joins']:spec.table==='Records'?pagination([sqlite('category','https://source.invalid/category'),sqlite('one','https://source.invalid/1'),sqlite('two','https://source.invalid/2')],1,3,1,{primaryKey:'id'}):pagination([{id:'j1',parent:'category',child:'one',position:1},{id:'j2',parent:'category',child:mode==='wrong'?'other':'two',position:2}],1,2,1,{primaryKey:'id'}));if(mode!=='absent')f.options.relationBindings=[{sourcePath:'/category',table:'Joins',parentField:'parent',childField:'child',orderField:'position'}];const report=await f.verify();assert.equal(report.checks.find(c=>c.kind==='relations')?.status,mode==='correct'?'verified':mode==='wrong'?'missing':'unverified');assert.equal(report.state,mode==='correct'?'complete':mode==='wrong'?'incomplete':'unverified');}finally{f.close();}}});

test('soft windows resume full coverage without rereading cached responses; a new target revision rereads all',async()=>{const f=fixture([{path:'/1'},{path:'/2'},{path:'/3'}],['/1','/2','/3']);try{f.options.maxRequests=1;f.setImplementation(spec=>spec.kind==='folders'?[]:spec.kind==='tables'?['Records']:pagination([sqlite(1,'https://source.invalid/1'),sqlite(2,'https://source.invalid/2'),sqlite(3,'https://source.invalid/3')],1,3,1,{primaryKey:'id'}));let report=await f.verify(),rounds=1;assert.equal(report.state,'pending');while(report.state==='pending'&&rounds++<15)report=await f.verify();assert.equal(report.state,'complete');assert.equal(f.requests.length,3);assert.equal(f.inspections.length,3);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM auto_collection_target_reports').get().count,rounds);await f.verify();assert.equal(f.requests.length,3);f.task.siteRevision=randomUUID();f.store.beginSiteChange(f.task);f.options.maxRequests=50;assert.equal((await f.verify()).state,'complete');assert.equal(f.requests.length,6);assert.equal(f.inspections.length,6);}finally{f.close();}});

test('cached evidence requires an unchanged file hash and failed server responses need an explicit retry',async()=>{const f=fixture();try{const first=await f.verify();const observation=first.artifacts.find(file=>file.name.includes('-observation-'))!;writeFileSync(resolve(f.directory,'automation-runs',f.task.id,'evidence',observation.name),'corrupt');assert.equal((await f.verify()).state,'complete');assert.equal(f.requests.length,2);}finally{f.close();}const g=fixture();try{let count=0;g.options.dependencies!.readHttp=async()=>++count===1?{status:503,body:'down'}:{status:200,body:g.docs.values().next().value!};assert.equal((await g.verify()).state,'unverified');assert.equal((await g.verify()).state,'unverified');assert.equal(count,1);g.options.retryTransientFailures=true;assert.equal((await g.verify()).state,'complete');assert.equal(count,2);}finally{g.close();}});

test('gate rejects pending, stale input, manifest, snapshot and target revision bindings',async()=>{const f=fixture();try{const report=await f.verify();assert.equal(collectionTargetGate(report,f.task,f.manifest),true);for(const changed of [{versionId:'other'},{collectionVersionId:'other'},{collectionId:'other'},{generatedSiteId:'other'},{siteRevision:'other'}])assert.equal(collectionTargetGate(report,{...f.task,...changed},f.manifest),false);assert.equal(collectionTargetGate({...report,state:'pending'},f.task,f.manifest),false);assert.equal(collectionTargetGate(report,f.task,{...f.manifest,revision:2}),false);assert.equal(collectionTargetGate({...report,checks:[...report.checks,{id:'unknown',kind:'binding',status:'unverified',reason:'unknown',evidence:[]}]},f.task,f.manifest),false);}finally{f.close();}});

test('reports from older verifier algorithms remain readable but cannot open gates or be reused',async()=>{
  const f=fixture();try{const report=await f.verify();assert.equal(report.verifierVersion,COLLECTION_TARGET_VERIFIER_VERSION);
    for(const version of [undefined,COLLECTION_TARGET_VERIFIER_VERSION-1]){const old={...report,verifierVersion:version};assert.equal(collectionTargetGate(old,f.task,f.manifest),false);f.store.db.prepare('UPDATE auto_collection_target_reports SET json=? WHERE id=?').run(JSON.stringify(old),old.id);assert.equal(latestCollectionTargetReport(f.store,f.task,f.manifest),undefined);}
    f.store.db.prepare('UPDATE auto_collection_target_reports SET json=? WHERE id=?').run(JSON.stringify(report),report.id);assert.equal(latestCollectionTargetReport(f.store,f.task,f.manifest)?.id,report.id);
  }finally{f.close();}
});

test('append-only manifest extensions keep frozen baseline; deletion, narrower paths and missing baseline fail closed',async()=>{for(const mode of ['extend','delete','narrow','unknown']){const f=fixture();try{const baseline={...f.manifest,items:[{id:'original',kind:'page' as const,title:'Original',required:true,source:'frozen',expectation:'whole page',paths:['/123.aspx?q=2'],expectedCount:1,viewports:['desktop' as const,'mobile' as const],expectedKeys:['/123.aspx?q=2'],samples:['/123.aspx?q=2']}]};new ManifestStore(f.store);if(mode!=='unknown')f.db.prepare('INSERT INTO auto_requirement_manifests VALUES(?,?,?,?)').run(baseline.id,f.task.id,1,JSON.stringify(baseline));const current={...baseline,id:randomUUID(),revision:2,items:mode==='delete'?[]:mode==='narrow'?baseline.items.map(item=>({...item,paths:[]})):[...baseline.items,{...baseline.items[0],id:'additional'}]};f.task.requirementsId=current.id;f.store.put(f.task);f.options.manifest=current;const report=await f.verify();assert.equal(report.state,mode==='extend'?'complete':'unverified');if(mode==='extend')assert.equal(collectionTargetGate(report,f.task,current),true);}finally{f.close();}}});

test('raw originals independently enforce body and links omitted from extraction',async()=>{const f=fixture([{path:'/1'}]);try{const raw=f.collections.read(f.run,'.work/raw/u0.html').toString().replace('</main>','<p>Original tail omitted by extractor</p><a href="/required">Original link</a></main>');f.write('.work/raw/u0.html',raw);f.collections.freeze(f.run,f.task,f.manifest.id);const report=await f.verify();assert.equal(report.state,'incomplete');assert.equal(report.checks.find(c=>c.kind==='page')?.status,'missing');}finally{f.close();}});

test('redirects and mid-read manifest changes remain unverified',async()=>{const f=fixture();try{f.options.dependencies!.readHttp=async()=>({status:302,body:''});assert.equal((await f.verify()).state,'unverified');}finally{f.close();}const g=fixture();try{g.options.dependencies!.readHttp=async()=>{const changed={...g.task,requirementsId:randomUUID()};g.store.put(changed);return {status:200,body:g.docs.values().next().value!};};const report=await g.verify();assert.equal(report.state,'unverified');assert.ok(report.checks.some(c=>c.id==='binding-changed'));}finally{g.close();}});

test('default SQLite CollectionRelationBindings declarations select actual fields but cannot replace frozen members',async()=>{
  for(const mode of ['correct','wrong-member','missing-table','missing-field','duplicate','wrong-path','tied-order']){
    const f=fixture([{path:'/category?page=2',type:'list',links:['/1','/2']},{path:'/1'},{path:'/2'}],['/1','/2']);
    try{
      f.setImplementation(spec=>{
        if(spec.kind==='folders')return [];
        if(spec.kind==='tables')return ['Records','Joins','CollectionRelationBindings'];
        if(spec.table==='Records')return pagination([sqlite('category','https://source.invalid/category?page=2'),sqlite('one','https://source.invalid/1'),sqlite('two','https://source.invalid/2')],1,3,1,{primaryKey:'id'});
        if(spec.table==='Joins')return pagination([{id:'j1',parent:'category',child:'one',position:1},{id:'j2',parent:'category',child:mode==='wrong-member'?'other':'two',position:mode==='tied-order'?1:2}],1,2,1,{primaryKey:'id'});
        const declaration={id:'binding-1',sourcePath:mode==='wrong-path'?'/category':'/category?page=2',tableName:mode==='missing-table'?'Invented':'Joins',parentField:'parent',childField:mode==='missing-field'?'invented':'child',orderField:'position',expectedKeys:['one','other']};
        const declarations=mode==='duplicate'?[declaration,{...declaration,id:'binding-2'}]:[declaration];
        return pagination(declarations.map(record=>Object.entries(record).map(([key,value])=>({key,value}))),1,declarations.length,1,{primaryKey:'id'});
      });
      assert.equal(f.options.relationBindings,undefined);
      const report=await f.verify(),expected=mode==='correct'?'verified':['wrong-member','tied-order'].includes(mode)?'missing':'unverified';
      assert.equal(report.checks.find(check=>check.kind==='relations')?.status,expected,mode);
      assert.equal(report.state,mode==='correct'?'complete':['wrong-member','tied-order'].includes(mode)?'incomplete':'unverified',mode);
      assert.ok(f.inspections.some(spec=>spec.kind==='rows'&&spec.table==='CollectionRelationBindings'));
    }finally{f.close();}
  }
});

test('real offline Python extraction verifies content regions, pageType, inline text, base URLs and uncapped raw titles',async()=>{
  const captured=JSON.parse(readFileSync(new URL('./fixtures/collection-target-python.json',import.meta.url),'utf8'));
  const list=captured.pages[0];
  assert.equal(list.extracted.pageType,'list');
  assert.equal(list.extracted.links.filter((link:any)=>link.where==='content').length,12);
  assert.equal(list.discovered.filter((link:any)=>link.where==='body').length,12);
  assert.ok(list.discovered.some((link:any)=>link.where==='nav'));
  assert.ok(list.extracted.links.some((link:any)=>link.where==='footer'));
  assert.ok(list.extracted.fullText.includes('Navigation 101\nArchive listings'));
  assert.equal(captured.pages.at(-1).extracted.title.length,300);
  for(const changed of [false,true]){
    const f=fixture(captured.pages.map((page:any)=>({path:page.path})));
    try{
      captured.pages.forEach((page:any,index:number)=>{f.write('.work/raw/u'+index+'.html',page.raw);f.write('.work/extract/u'+index+'.json',page.extracted);f.docs.set(page.path,page.raw);});
      f.collections.freeze(f.run,f.task,f.manifest.id);
      if(changed)f.setTransform((body,path)=>path===list.path?body.replaceAll('https://source.invalid','https://target.invalid').replace('href="102.aspx"','href="103.aspx"').replace('Record 102','Record 103'):body.replaceAll('https://source.invalid','https://target.invalid'));
      const report=await f.verify();
      assert.equal(report.state,changed?'incomplete':'complete');
      assert.equal(report.expectedPages,13);
      assert.equal(report.checks.find(check=>check.id==='listing:'+list.path)?.status,changed?'missing':'verified');
      assert.equal(report.checks.find(check=>check.id==='page:/archive/112.aspx')?.status,'verified');
    }finally{f.close();}
  }
});

test('source inventory builds identities and relation keys only from frozen originals without target access',()=>{
  const f=fixture([{path:'/parent',links:['/1']},{path:'/1'},{path:'/2'}],['group:101']);
  try{
    f.write('data/page-groups.json',{source:f.run.sourceUrl,pageGroups:[{id:'group',count:1,dataFile:'data/group.json'}]});
    f.write('data/group.json',{source:f.run.sourceUrl,pageGroup:'group',count:1,parts:[{file:'data/group.part-01.json',count:1}]});
    f.write('data/group.part-01.json',{records:[{sourceId:'101',url:'https://source.invalid/1',path:'/1'}]});
    const extracted=JSON.parse(readFileSync(resolve(f.root,'.work/extract/u0.json'),'utf8'));extracted.links.push({url:'https://source.invalid/2',where:'content'});f.write('.work/extract/u0.json',extracted);
    f.manifest.items.push({id:'parents',title:'Parents',kind:'page',required:true,source:'frozen',expectation:'all',paths:['/parent'],expectedCount:1,viewports:['desktop']},{id:'edges',title:'Edges',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:1,expectedKeys:[JSON.stringify(['https://source.invalid/parent','https://source.invalid/1'])],dataIdentity:{kind:'relations',parentRequirementIds:['parents'],childRequirementIds:['records']},viewports:['business']});
    f.collections.freeze(f.run,f.task,f.manifest.id);
    const inventory=frozenCollectionSourceInventory(f.task,f.store,f.directory);
    assert.deepEqual(inventory.pages[0].memberUrls,['https://source.invalid/1']);
    assert.ok(inventory.pages[1].aliases.includes('group:101'));
    assert.equal(inventory.coverage.universe,'frozen-originals');
    assert.equal(preflightCollectionTarget(f.options).state,'passed');
    const evaluation={...f.task,id:randomUUID(),kind:'evaluation' as const};f.store.put(evaluation);
    assert.equal(preflightCollectionTarget({...f.options,task:evaluation}).state,'passed');
    f.write('.work/raw/u1.html','later mutable change');
    assert.deepEqual(frozenCollectionSourceInventory(f.task,f.store,f.directory),inventory);
    assert.equal(f.requests.length,0);assert.equal(f.inspections.length,0);
  }finally{f.close();}
});

test('deterministic preflight blocks malformed identity contracts before target requests',async()=>{
  for(const mode of ['duplicate-alias','wrong-count','missing-key']){
    const f=fixture([{path:'/1'}],['/1']);try{
      f.manifest.items[0].expectedKeys=mode==='duplicate-alias'?['/1','u0']:mode==='missing-key'?['/invented']:['/1'];
      f.manifest.items[0].expectedCount=2;
      const preflight=preflightCollectionTarget(f.options);assert.equal(preflight.state,'blocked',mode);
      assert.ok(preflight.checks.some(check=>check.failureClass==='contract-tool-defect'),mode);
      const report=await f.verify();assert.equal(report.state,'unverified',mode);assert.equal(report.expectedPages,1,mode);
      assert.equal(f.requests.length,0,mode);assert.equal(f.inspections.length,0,mode);assert.deepEqual(report.issues,[],mode);
    }finally{f.close();}
  }
});

test('missing frozen CSS bytes remain a source limitation while independent page defects are checked',async()=>{
  const f=fixture([{path:'/1'}]);try{
    const bytes=Buffer.from('original'),path='images/a.bin',key='https://source.invalid/a.bin';mkdirSync(resolve(f.root,'images'),{recursive:true});writeFileSync(resolve(f.root,path),bytes);
    const state=f.collections.json(f.run,'.work/state.json');state.assets=[{url:key,status:'saved',localPath:path,bytes:bytes.length,hash:collectionHash(bytes)}];state.stylesheets=[{url:'https://source.invalid/style.css',status:'read'}];f.write('.work/state.json',state);
    f.manifest.items=[{id:'assets',title:'Assets',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:1,expectedKeys:[key],dataIdentity:{kind:'assets'},viewports:['business']}];f.collections.freeze(f.run,f.task,f.manifest.id);
    f.setTransform(body=>body.replace('Full original body 0','Changed target body'));
    f.setImplementation(spec=>spec.kind==='tables'?['CollectionAssetBindings']:pagination([{id:'a',sourceUrl:key,materialPath:path,targetUrl:'https://target.invalid/a.bin'}]));
    f.options.dependencies!.readAsset=async(targetUrl)=>({url:targetUrl,finalUrl:targetUrl,status:200,size:bytes.length,sha256:collectionHash(bytes)});
    assert.equal(preflightCollectionTarget(f.options).state,'limited');
    const report=await f.verify();assert.equal(report.state,'incomplete');assert.equal(f.requests.length,1);
    assert.ok(report.summary!.failures['source-limitation']>0);assert.ok(report.summary!.failures['confirmed-target-defect']>0);
    assert.ok(report.issues.every(issue=>issue.title.includes('page:/1')));
    const sample=report.summary!.samples.find(sample=>sample.id==='page:/1')!;
    assert.ok(sample.differences?.missingTextFragments.includes('Full original body 0'));assert.ok(sample.evidence.length);
  }finally{f.close();}
});

test('difference artifacts are reused across windows while manifest content changes invalidate checkpoints',async()=>{
  const f=fixture([{path:'/1'},{path:'/2'},{path:'/3'}]);try{
    f.options.maxRequests=1;
    assert.equal((await f.verify()).state,'pending');assert.equal((await f.verify()).state,'pending');assert.equal((await f.verify()).state,'complete');
    const evidence=resolve(f.directory,'automation-runs',f.task.id,'evidence');
    const differenceFiles=()=>readdirSync(evidence).filter(name=>name.includes('page-difference'));
    assert.equal(differenceFiles().length,3);const old=[...differenceFiles()];assert.equal(f.requests.length,3);
    const complete=await f.verify();assert.equal(complete.state,'complete');assert.deepEqual(differenceFiles(),old);assert.equal(f.requests.length,3);
    // Same ID/revision cannot reuse the previous contract's target observations.
    f.manifest.limitations.push('The fixed contract content changed');
    assert.equal(collectionTargetGate(complete,f.task,f.manifest),false);assert.equal(latestCollectionTargetReport(f.store,f.task,f.manifest),undefined);
    const changed=await f.verify();assert.notEqual(changed.binding,complete.binding);assert.equal(changed.state,'pending');assert.equal(f.requests.length,4);
  }finally{f.close();}
});

test('permission and transient page failures remain verification gaps without repair issues',async()=>{
  for(const status of [401,403,408,429,500]){
    const f=fixture();try{f.options.dependencies!.readHttp=async()=>({status,body:'unavailable'});const report=await f.verify();assert.equal(report.state,'unverified');assert.deepEqual(report.issues,[]);assert.equal(report.summary!.failures['confirmed-target-defect'],0);assert.ok(report.summary!.failures['transient-incomplete']>0);}finally{f.close();}
  }
});

test('failed prefix pages never starve later windows and explicit retries only reread failed objects',async()=>{
  for(const mode of ['http','throw']){
    const f=fixture(Array.from({length:7},(_,index)=>({path:'/'+index})));try{
      f.options.maxRequests=2;const reads:string[]=[];let recovered=false;
      f.options.dependencies!.readHttp=async(uri)=>{reads.push(uri.pathname);if(!recovered&&Number(uri.pathname.slice(1))<5){if(mode==='throw')throw new Error('socket read unavailable');return {status:503,body:'busy'};}return {status:200,body:f.docs.get(uri.pathname)!};};
      let report=await f.verify(),windows=1;
      while(report.state==='pending'&&windows++<8)report=await f.verify();
      assert.equal(windows,4,mode);assert.equal(report.state,'unverified',mode);assert.equal(report.checks.filter(check=>check.kind==='page').length,7,mode);
      assert.deepEqual(reads,['/0','/1','/2','/3','/4','/5','/6'],mode);assert.deepEqual(report.issues,[],mode);assert.equal(report.summary!.failures['confirmed-target-defect'],0,mode);
      assert.equal(report.checks.find(check=>check.id==='page:/6')?.status,'verified',mode);
      assert.equal((await f.verify()).state,'unverified',mode);assert.equal(reads.length,7,mode);
      recovered=true;f.options.retryTransientFailures=true;report=await f.verify();let retries=1;
      while(report.state==='pending'&&retries++<8)report=await f.verify();
      assert.equal(retries,3,mode);assert.equal(report.state,'complete',mode);assert.deepEqual(reads.slice(7),['/0','/1','/2','/3','/4'],mode);
    }finally{f.close();}
  }
});

test('failed backend reads are checkpointed without certifying the implementation inventory',async()=>{
  const f=fixture([{path:'/1'}],['/1']);try{
    let inspections=0;f.options.maxRequests=1;f.setImplementation(()=>{inspections++;throw new Error('backend unavailable');});
    let report=await f.verify(),windows=1;while(report.state==='pending'&&windows++<8)report=await f.verify();
    assert.equal(report.state,'unverified');assert.equal(windows,3);assert.equal(inspections,2);assert.deepEqual(report.issues,[]);
    await f.verify();assert.equal(inspections,2);
  }finally{f.close();}
});

test('failed asset reads advance through all targets and remain transient until explicit retry',async()=>{
  for(const mode of ['http','throw']){
    const f=fixture([{path:'/1'}]);try{
      const bytes=Buffer.from('source asset'),path='images/asset.bin',keys=Array.from({length:3},(_,index)=>'https://source.invalid/asset-'+index+'.bin');mkdirSync(resolve(f.root,'images'),{recursive:true});writeFileSync(resolve(f.root,path),bytes);
      const state=f.collections.json(f.run,'.work/state.json');state.assets=keys.map(url=>({url,status:'saved',localPath:path,bytes:bytes.length,hash:collectionHash(bytes)}));f.write('.work/state.json',state);
      f.manifest.items=[{id:'assets',title:'Assets',kind:'data',required:true,source:'frozen',expectation:'all',paths:[],expectedCount:3,expectedKeys:keys,dataIdentity:{kind:'assets'},viewports:['business']}];f.collections.freeze(f.run,f.task,f.manifest.id);
      f.setImplementation(spec=>spec.kind==='tables'?['CollectionAssetBindings']:pagination(keys.map((sourceUrl,index)=>({id:String(index),sourceUrl,materialPath:path,targetUrl:'https://target.invalid/asset-'+index+'.bin'}))));
      const reads:string[]=[];let recovered=false;f.options.maxRequests=2;
      f.options.dependencies!.readAsset=async(targetUrl)=>{reads.push(targetUrl);if(!recovered&&!targetUrl.endsWith('2.bin')){if(mode==='throw')throw new Error('asset connection unavailable');return {url:targetUrl,finalUrl:targetUrl,status:503,sha256:collectionHash(Buffer.from('busy')),size:4};}return {url:targetUrl,finalUrl:targetUrl,status:200,sha256:collectionHash(bytes),size:bytes.length};};
      let report=await f.verify(),windows=1;while(report.state==='pending'&&windows++<8)report=await f.verify();
      assert.equal(report.state,'unverified',mode);assert.equal(windows,3,mode);assert.equal(reads.length,3,mode);assert.deepEqual(report.issues,[],mode);
      assert.equal(report.checks.find(check=>check.id==='data:assets')?.failureClass,'transient-incomplete',mode);
      recovered=true;f.options.retryTransientFailures=true;report=await f.verify();assert.equal(report.state,'complete',mode);assert.equal(reads.length,5,mode);
    }finally{f.close();}
  }
});
