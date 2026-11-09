import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { frozenCollectionPageAliases } from '../server/automation/collection/target-verification.js';
import { validateCompleteness } from '../server/automation/completeness.js';
import { validateResult } from '../server/automation/evaluator.js';

const source='https://source.invalid/',target='https://target.invalid/',one='/products/123.aspx?category=2',two='/products/456.aspx?category=3';
function fixture(extra:Record<string,unknown>={}){
  const directory=mkdtempSync(resolve(tmpdir(),'page-aliases-')),db=new Database(':memory:'),store=new AutomationStore(db);
  const resource=store.saveResource({name:'Pages',scenario:'migration',contentUrl:source,referenceUrl:'',description:'Source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},defaultAutomationSettings)[0],collections=new CollectionStore(store,directory),run=collections.create(task);
  const write=(path:string,value:unknown)=>{const file=resolve(collections.workspace(run),path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  const state={source,urls:{one:{id:'u0001',url:new URL(one,source).href,action:'keep',status:200},two:{id:'u0002',url:new URL(two,source).href,action:'keep',status:200},...extra}};
  write('.work/state.json',state);run.review={action:'ready'};run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'Verified original identities',evidence:[]}));
  const snapshot=collections.freeze(run,task,'frozen-manifest');
  const files:MaterialFile[]=[{id:randomUUID(),name:'implementation-'+randomUUID()+'.json',type:'application/json',size:2,sha256:'0'.repeat(64),role:'target'}];
  const observations:Record<string,{url:string;role:string;viewport:string}>={};
  for(const [index,path] of [one,two].entries())for(const viewport of ['desktop','mobile'] as const){const file:MaterialFile={id:randomUUID(),name:`page-${index}-${viewport}.png`,type:'image/png',size:1,sha256:'0'.repeat(64),role:'target',viewport};files.push(file);observations[file.name]={url:new URL(path,target).href,role:'target',viewport};}
  const manifest:RequirementManifest={id:randomUUID(),taskId:task.id,revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'ai',items:[{id:'product-template',kind:'template',title:'Product template',required:true,source:'Frozen pages',expectation:'Both boundary samples are present',paths:['/products'],samples:['u0001','u0002'],viewports:['desktop','mobile'],expectedCount:null}]};
  const check={id:'product-template',status:'verified',reason:'Checked both boundary samples and backend template',evidence:files.map(file=>file.name),checkedViewports:['desktop','mobile'],sampledPaths:['u0001','u0002'],actualCount:null,checkedKeys:[]};
  return {directory,db,store,task,collections,run,snapshot,state,write,files,observations,manifest,check,aliases(){return frozenCollectionPageAliases(task,store,directory);},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('frozen page IDs resolve to exact paths and queries after mutable collection state changes',()=>{
  const f=fixture();try{
    assert.deepEqual(f.aliases(),{u0001:one,u0002:two});
    f.write('.work/state.json',{source,urls:{one:{id:'u0001',url:source+'changed',action:'keep',status:200}}});assert.deepEqual(f.aliases(),{u0001:one,u0002:two});
  }finally{f.close();}
});

test('template samples and checked paths accept either frozen IDs or exact mapped URLs without changing fixed requirements',()=>{
  const f=fixture();try{
    const aliases=f.aliases(),before=JSON.stringify(f.manifest);
    for(const sampledPaths of [['u0001','u0002'],[one,two],[new URL(one,target).href,new URL(two,target).href]])assert.equal(validateCompleteness([{...f.check,sampledPaths}],f.manifest,f.files,f.observations,target,aliases).state,'complete');
    const assessments=f.task.rule!.criteria.filter(criterion=>criterion.scopes.includes(f.task.scope)).flatMap(criterion=>criterion.viewports.map(viewport=>({criterionId:criterion.id,viewport,score:90,passed:true,reason:'Actual mapped target page reviewed',evidence:[(viewport==='business'?f.files[0]:f.files.find(file=>file.viewport===viewport)!).name]})));
    const report=validateResult({summary:'Alias-aware template review',assessments,issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},completeness:[f.check]},f.task,f.files,80,false,f.manifest,f.observations,target,aliases);
    assert.equal(report.completeness?.state,'complete');assert.equal(JSON.stringify(f.manifest),before);assert.deepEqual(report.completeness?.checks[0].sampledPaths,['u0001','u0002']);
  }finally{f.close();}
});

test('unknown IDs cannot be treated as relative URL paths even when screenshots use those names',()=>{
  const f=fixture();try{
    const manifest={...f.manifest,items:[{...f.manifest.items[0],samples:['u9999']}]};
    const observations=Object.fromEntries(f.files.filter(file=>file.viewport).map(file=>[file.name,{url:target+'u9999',role:'target',viewport:file.viewport!}]));
    assert.throws(()=>validateCompleteness([{...f.check,sampledPaths:['u9999']}],manifest,f.files,observations,target,f.aliases()),/未知或歧义/);
    assert.throws(()=>validateCompleteness([f.check],f.manifest,f.files,f.observations,target,{}),/未知或歧义/);
  }finally{f.close();}
});

test('ambiguous IDs, out-of-origin URLs and unkept pages do not become trusted aliases',()=>{
  const f=fixture({duplicate:{id:'u0001',url:source+'another',action:'keep',status:200},external:{id:'u0003',url:'https://different.invalid/third',action:'keep',status:200},failed:{id:'u0004',url:source+'failed',action:'failed',status:500}});try{
    assert.deepEqual(f.aliases(),{u0002:two});assert.throws(()=>validateCompleteness([f.check],f.manifest,f.files,f.observations,target,f.aliases()),/未知或歧义/);
  }finally{f.close();}
});

test('aliases cannot remove required samples or loosen target origin and query matching',()=>{
  const f=fixture();try{
    const aliases=f.aliases();assert.throws(()=>validateCompleteness([{...f.check,sampledPaths:['u0001']}],f.manifest,f.files,f.observations,target,aliases),/边界路径/);
    const first=f.files.find(file=>file.viewport==='desktop')!;
    for(const wrong of ['https://different.invalid'+one,target+'products/123.aspx?category=9'])assert.throws(()=>validateCompleteness([f.check],f.manifest,f.files,{...f.observations,[first.name]:{url:wrong,role:'target',viewport:'desktop'}},target,aliases),/缺少对应 desktop/);
    const literalManifest={...f.manifest,items:[{...f.manifest.items[0],samples:[one,two]}]};assert.equal(validateCompleteness([{...f.check,sampledPaths:[one,two]}],literalManifest,f.files,f.observations,target,aliases).state,'complete');
  }finally{f.close();}
});

for(const mode of ['input','collection','missing-snapshot','tampered-snapshot','tampered-archive','missing-archive'] as const)test(`${mode} cannot supply frozen aliases or fall back to mutable state`,()=>{
  const f=fixture();try{
    if(mode==='input')f.task.versionId=randomUUID();if(mode==='collection')f.task.collectionId=randomUUID();if(mode==='missing-snapshot')f.task.collectionVersionId=randomUUID();
    if(mode==='tampered-snapshot'){const snapshot={...f.snapshot,inputVersionId:randomUUID()};f.db.prepare('UPDATE auto_collection_snapshots SET json=? WHERE id=?').run(JSON.stringify(snapshot),snapshot.id);}
    const archive=resolve(f.directory,'collection-snapshots',f.snapshot.id,'originals','.work/state.json');
    if(mode==='tampered-archive')writeFileSync(archive,JSON.stringify({...f.state,source:'https://different.invalid/'}));if(mode==='missing-archive')rmSync(archive);
    assert.throws(()=>f.aliases());
  }finally{f.close();}
});
