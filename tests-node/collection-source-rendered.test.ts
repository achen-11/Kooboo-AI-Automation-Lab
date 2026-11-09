import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { Requirement } from '../shared/completeness.js';
import { CollectionStore, effectiveCollectionInput } from '../server/automation/collection/store.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { collectionProgress, checkCollectionMechanics } from '../server/automation/collection/orchestrator.js';
import { captureSourceRenderedEvidence, assertSourceRenderedEvidenceIndex, sourceRenderedEvidencePath, assertSourceRenderedManifest } from '../server/automation/collection/source-rendered.js';
import type { evaluationBrowser } from '../server/automation/browser.js';

const pageUrl='https://source.invalid/cn/map';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'source-rendered-test-')),db=new Database(':memory:'),store=new AutomationStore(db);
  const resource=store.saveResource({name:'Rendered source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'original source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},structuredClone(defaultAutomationSettings))[0];
  const collections=new CollectionStore(store,directory),run=collections.create(task),root=collections.workspace(run);
  const write=(path:string,value:unknown)=>{const file=resolve(root,path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
  write('.work/state.json',{source:run.sourceUrl,siteHosts:['source.invalid'],urls:{map:{id:'map',url:pageUrl,action:'keep',status:200,rawFile:'.work/raw/map.html'}}});
  write('.work/raw/map.html','<html><head><title>地图展示</title></head><body><main id="map"></main><script>renderMap("Do not add script text to fullText")</script></body></html>');
  write('.work/extract/map.json',{title:'地图展示',fullText:'地图展示',body:'',words:4,images:[],forms:[]});
  write('site/a-checklist.json',{findings:[{severity:'gap',kind:'content',url:pageUrl,reason:'empty-content'}]});
  return {directory,db,store,task,collections,run,root,write,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
function mockBrowser(options:{url?:string;text?:string;framesComplete?:boolean;textTruncated?:boolean;frames?:{url:string;text:string}[]}={}){
  let directory='',opens=0,requests=0,closes=0;
  const open=(async(urls:any,path:string)=>{opens++;directory=path;assert.deepEqual(urls,{target:'',reference:'',content:pageUrl});return {artifacts:[],capture:async()=>{throw new Error('此测试不调用程序取证');},env:{EVALUATION_BROWSER_URL:'http://127.0.0.1:1',EVALUATION_BROWSER_TOKEN:'ephemeral-test-token'},close:async()=>{closes++;}};}) as typeof evaluationBrowser;
  const request:typeof fetch=async(_url,init)=>{
    requests++;assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
    assert.deepEqual(JSON.parse(String(init?.body)),{action:'snapshot',role:'content',viewport:'desktop',fullPage:false});
    const file=randomUUID()+'.png',observation={action:'snapshot',role:'content',viewport:'desktop',url:options.url??pageUrl,title:'地图展示',capturedAt:Date.now(),file,snapshot:'- region "地图"\n  - button "放大"',text:requests===1?'':options.text??'漫威智能影音\n公司实际地址\n放大 缩小',frames:options.frames??[],framesComplete:options.framesComplete??true,textTruncated:options.textTruncated??false};
    writeFileSync(resolve(directory,'evidence',file),png);writeFileSync(resolve(directory,'evidence',file.replace('.png','.json')),JSON.stringify(observation));
    return new Response(JSON.stringify(observation),{headers:{'content-type':'application/json'}});
  };
  return {options:{openBrowser:open,request,settleMs:0,signal:AbortSignal.timeout(5000)},counts:()=>({opens,requests,closes})};
}

test('precise source capture takes two read-only snapshots, saves true bytes and closes only matching empty-content',async()=>{
  const f=fixture(),browser=mockBrowser({frames:[{url:'https://maps.example/embed',text:'可见地图标注'}]});
  try{
    const beforeRaw=f.collections.read(f.run,'.work/raw/map.html'),beforeExtract=f.collections.read(f.run,'.work/extract/map.json'),beforeChecklist=f.collections.read(f.run,'site/a-checklist.json'),beforeProgress=collectionProgress(f.run);
    assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(check=>check.id==='A5')?.status,'failed');
    const evidence=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,browser.options);
    assert.deepEqual(browser.counts(),{opens:1,requests:2,closes:1});assert.equal(evidence.rawSha256,collectionHash(beforeRaw));assert.equal(evidence.extractSha256,collectionHash(beforeExtract));
    assert.equal(evidence.screenshotSha256,collectionHash(png));assert.deepEqual(f.collections.read(f.run,evidence.screenshotPath),png);
    assert.ok(evidence.visibleText.includes('可见地图标注'));assert.ok(!evidence.visibleText.includes('Do not add script'));
    assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(check=>check.id==='A5')?.status,'unverified');
    assert.notEqual(collectionProgress(f.run),beforeProgress);assertSourceRenderedEvidenceIndex(f.run,path=>f.collections.read(f.run,path));
    assert.deepEqual(f.collections.read(f.run,'.work/raw/map.html'),beforeRaw);assert.deepEqual(f.collections.read(f.run,'.work/extract/map.json'),beforeExtract);assert.deepEqual(f.collections.read(f.run,'site/a-checklist.json'),beforeChecklist);
    assert.equal(f.collections.get(f.run.id)?.sourceRenderedEvidence?.[0].id,evidence.id);
    assert.equal(f.collections.json(f.run,sourceRenderedEvidencePath).evidence[0].id,evidence.id);
  }finally{f.close();}
});

test('unknown, non-keep and non-success page URLs are rejected before browser creation',async()=>{
  for(const mode of ['unknown','not-keep','failed']){
    const f=fixture(),browser=mockBrowser();
    try{
      const state=f.collections.json(f.run,'.work/state.json');if(mode==='not-keep')state.urls.map.action='failed';if(mode==='failed')state.urls.map.status=403;f.write('.work/state.json',state);
      await assert.rejects(captureSourceRenderedEvidence(f.collections,f.run,mode==='unknown'?pageUrl+'?unknown=1':pageUrl,browser.options),/精确URL/);
      assert.equal(browser.counts().opens,0);assert.equal(f.run.sourceRenderedEvidence,undefined);
    }finally{f.close();}
  }
});

test('final URL changes, empty text, truncated text and incomplete frames never publish capture evidence',async()=>{
  for(const options of [{url:'https://source.invalid/other-page'},{text:''},{textTruncated:true},{framesComplete:false}]){
    const f=fixture(),browser=mockBrowser(options);
    try{
      await assert.rejects(captureSourceRenderedEvidence(f.collections,f.run,pageUrl,browser.options));
      assert.equal(f.run.sourceRenderedEvidence,undefined);assert.equal(existsSync(resolve(f.root,sourceRenderedEvidencePath)),false);assert.equal(browser.counts().closes,1);
      assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(check=>check.id==='A5')?.status,'failed');
    }finally{f.close();}
  }
});

test('rendered evidence cannot close other content failures, other URLs or changed original hashes',async()=>{
  const f=fixture(),browser=mockBrowser();
  try{
    await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,browser.options);
    for(const finding of [{severity:'gap',kind:'content',url:pageUrl,reason:'missing-required-paragraph'},{severity:'gap',kind:'content',url:'https://source.invalid/other',reason:'empty-content'}]){
      f.write('site/a-checklist.json',{findings:[finding]});assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(check=>check.id==='A5')?.status,'failed');
    }
    f.write('site/a-checklist.json',{findings:[{severity:'gap',kind:'content',url:pageUrl,reason:'empty-content'}]});
    f.write('.work/extract/map.json',{fullText:'changed static contract'});
    assert.throws(()=>assertSourceRenderedEvidenceIndex(f.run,path=>f.collections.read(f.run,path)),/哈希已变化/);
    assert.equal(checkCollectionMechanics(f.collections,f.run).checks.find(check=>check.id==='A5')?.status,'failed');
  }finally{f.close();}
});

test('unchanged exact source evidence is reused without opening another browser',async()=>{
  const f=fixture(),first=mockBrowser(),second=mockBrowser();
  try{
    const one=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,first.options),before=collectionProgress(f.run);
    const two=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,second.options);
    assert.equal(two,one);assert.equal(two.id,one.id);assert.deepEqual(second.counts(),{opens:0,requests:0,closes:0});
    assert.equal(collectionProgress(f.run),before);assert.equal(f.run.sourceRenderedEvidence?.length,1);
    assertSourceRenderedEvidenceIndex(f.run,path=>f.collections.read(f.run,path));
  }finally{f.close();}
});

test('changed extraction recaptures one active page pointer while preserving old observation bytes',async()=>{
  const f=fixture();
  try{
    const one=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,mockBrowser().options);
    f.write('.work/extract/map.json',{...f.collections.json(f.run,'.work/extract/map.json'),revised:true});
    const browser=mockBrowser(),two=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,browser.options);
    assert.notEqual(one.id,two.id);assert.equal(f.run.sourceRenderedEvidence?.length,1);assert.equal(f.run.sourceRenderedEvidence![0].id,two.id);
    assert.deepEqual(browser.counts(),{opens:1,requests:2,closes:1});
    assert.ok(existsSync(resolve(f.root,one.observationPath)));assertSourceRenderedEvidenceIndex(f.run,path=>f.collections.read(f.run,path));
  }finally{f.close();}
});

test('rendered page needs required page and interaction manifest entries for its exact path',async()=>{
  const f=fixture();
  try{
    await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,mockBrowser().options);
    const page:Requirement={id:'map-page',title:'地图展示',kind:'page',required:true,source:sourceRenderedEvidencePath,expectation:'公司名称和地址实际可见',paths:['/cn/map'],expectedCount:null,viewports:['desktop','mobile']},interaction:Requirement={...page,id:'map-interaction',kind:'interaction',expectation:'地图加载、缩放和平移功能应实际验证'};
    assert.throws(()=>assertSourceRenderedManifest(f.run,[page]),/required page.*和interaction/);assert.throws(()=>assertSourceRenderedManifest(f.run,[interaction]),/required page.*和interaction/);
    assert.throws(()=>assertSourceRenderedManifest(f.run,[page,{...interaction,required:false}]),/required page.*和interaction/);
    assert.throws(()=>assertSourceRenderedManifest(f.run,[page,{...interaction,paths:['/other']}]),/required page.*和interaction/);
    assert.throws(()=>assertSourceRenderedManifest(f.run,[{...page,viewports:['desktop']},interaction]),/required page.*和interaction/);
    assertSourceRenderedManifest(f.run,[page,interaction]);
  }finally{f.close();}
});

test('freeze pins source rendered evidence and materials independently of later mutable changes',async()=>{
  const f=fixture();
  try{
    const evidence=await captureSourceRenderedEvidence(f.collections,f.run,pageUrl,mockBrowser().options);
    f.run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'independent review',evidence:[]}));f.run.review={action:'ready'};
    const snapshot=f.collections.freeze(f.run,f.task,'manifest');assert.equal(snapshot.sourceRenderedEvidence?.[0].id,evidence.id);f.collections.verify(snapshot);
    const input=effectiveCollectionInput(f.task,f.store,f.directory)!;assert.ok(input.files.some(file=>file.name==='collection/'+evidence.screenshotPath));assert.ok(input.description.includes('collection/'+sourceRenderedEvidencePath));
    f.run.sourceRenderedEvidence=[];f.collections.put(f.run);f.write('.work/raw/map.html','later source revision');f.write(evidence.screenshotPath,'later changed working capture');
    f.collections.verify(snapshot);assert.equal(f.collections.original(snapshot,evidence.screenshotPath).equals(png),true);
    const material=snapshot.files.find(file=>file.name==='collection/'+evidence.screenshotPath)!;writeFileSync(resolve(f.directory,'materials',material.id),'corrupt frozen evidence');assert.throws(()=>f.collections.verify(snapshot),/不完整或已变化/);
  }finally{f.close();}
});
