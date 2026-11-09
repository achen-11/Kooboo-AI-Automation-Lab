import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { ManifestStore, assertRequirementDataIdentityPreserved, manifestInput, validateCompleteness } from '../server/automation/completeness.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import type { Requirement, RequirementCheck, RequirementManifest } from '../shared/completeness.js';

const parent='https://source.invalid/category/100_3.aspx',child='https://source.invalid/show/950';
const edge=JSON.stringify([parent,child]);
const record=(id:string,keys:string[]):Requirement=>({id,title:id,kind:'data',required:true,source:'frozen source',expectation:'all source identities',paths:[],expectedCount:keys.length,expectedKeys:keys,viewports:['business']});
const relation=():Requirement=>({...record('relations',[edge]),dataIdentity:{kind:'relations',parentRequirementIds:['parents'],childRequirementIds:['children']}});
const input=(items:Requirement[])=>({sourceComplete:true,limitations:[],evidence:[],items});
const related=():Requirement[]=>[record('parents',[parent]),record('children',[child]),relation()];
const frozen=(item:Requirement):RequirementManifest=>({...input([item]),id:'manifest',taskId:'task',revision:1,createdAt:1,actor:'human'});
const backend:MaterialFile={id:'proof',name:'implementation-proof.json',type:'application/json',size:1,sha256:'proof',role:'target'};
const verified=(item:Requirement):RequirementCheck=>({id:item.id,status:'verified',reason:'independently reconciled',evidence:[backend.name],checkedViewports:['business'],actualCount:item.expectedCount,checkedKeys:item.expectedKeys,sampledPaths:[]});

test('data identity keeps legacy records and distinguishes page members from source assets',()=>{
  assert.equal(manifestInput.parse(input([record('legacy',['950'])])).items[0].dataIdentity,undefined);
  const items=related();
  items[0]={...items[0],kind:'page',paths:['/category/100_3.aspx'],expectedKeys:[],viewports:['desktop','mobile']};
  items.push({...record('assets',['https://source.invalid/a.png','https://source.invalid/alias.png']),dataIdentity:{kind:'assets'}});
  const parsed=manifestInput.parse(input(items));
  assert.deepEqual(parsed.items[2].dataIdentity,relation().dataIdentity);
  assert.equal(parsed.items[3].expectedCount,2); // Two source URLs can refer to the same physical file.
  const unresolved=related();unresolved[2]={...unresolved[2],expectedCount:1044,expectedKeys:[]};
  unresolved.push({...record('assets',[]),dataIdentity:{kind:'assets'},expectedCount:null});
  assert.doesNotThrow(()=>manifestInput.parse(input(unresolved)));
});

test('relations reject ambiguous, cross-origin, noncanonical and out-of-domain keys',()=>{
  for(const invalid of [
    JSON.stringify(['/category/100_3.aspx',child]),
    JSON.stringify([parent,'https://other.invalid/show/950']),
    JSON.stringify([parent,'https://SOURCE.invalid/show/950']),
    JSON.stringify([parent,'https://source.invalid/show/950#content']),
    JSON.stringify([parent,'https://user:pass@source.invalid/show/950']),
    JSON.stringify([parent,'https://source.invalid/show/951']),
    JSON.stringify([parent,child,null]),
    '["'+parent+'", "'+child+'"]',
  ]){
    const items=related();items[2].expectedKeys=[invalid];
    assert.equal(manifestInput.safeParse(input(items)).success,false,invalid);
  }
  const items=related();items[2].expectedKeys=[edge,edge];
  assert.equal(manifestInput.safeParse(input(items)).success,false);
});

test('relation references require whole required page domains and reject self or cyclic references',()=>{
  for(const mutate of [
    (items:Requirement[])=>{items[0].required=false;},
    (items:Requirement[])=>{items[0].expectedKeys=[];},
    (items:Requirement[])=>{items[0].dataIdentity={kind:'assets'};},
    (items:Requirement[])=>{items[0]={...items[0],kind:'template',paths:['/category/100_3.aspx'],viewports:['desktop','mobile']};},
    (items:Requirement[])=>{items[2].dataIdentity={kind:'relations',parentRequirementIds:['unknown'],childRequirementIds:['children']};},
    (items:Requirement[])=>{items[2].dataIdentity={kind:'relations',parentRequirementIds:['relations'],childRequirementIds:['children']};},
    (items:Requirement[])=>{items[0].dataIdentity={kind:'relations',parentRequirementIds:['relations'],childRequirementIds:['children']};},
    (items:Requirement[])=>{items[2].dataIdentity={kind:'relations',parentRequirementIds:['parents','parents'],childRequirementIds:['children']};},
    (items:Requirement[])=>{items[2]={...items[2],kind:'implementation'};},
  ]){
    const items=related();mutate(items);assert.equal(manifestInput.safeParse(input(items)).success,false);
  }
});

test('explicit identity cannot be removed, changed or have its parent or child reference sets narrowed',()=>{
  const old=relation();
  assert.doesNotThrow(()=>assertRequirementDataIdentityPreserved({...old,dataIdentity:undefined},old));
  for(const next of [
    {...old,dataIdentity:undefined},
    {...old,dataIdentity:{kind:'page' as const}},
    {...old,dataIdentity:{kind:'assets' as const}},
    {...old,dataIdentity:{kind:'relations' as const,parentRequirementIds:[],childRequirementIds:['children']}},
    {...old,dataIdentity:{kind:'relations' as const,parentRequirementIds:['parents'],childRequirementIds:[]}},
  ])assert.throws(()=>assertRequirementDataIdentityPreserved(old,next),/计量域/);
  assert.doesNotThrow(()=>assertRequirementDataIdentityPreserved(old,{...old,dataIdentity:{kind:'relations',parentRequirementIds:['extra','parents'],childRequirementIds:['children','other']}}));
  assert.throws(()=>assertRequirementDataIdentityPreserved({...old,dataIdentity:{kind:'page'}},old),/计量域/);
});

test('formal manifest extension clarifies unknown domains and preserves all frozen required scope',()=>{
  const db=new Database(':memory:');
  try{
    const store=new AutomationStore(db),manifests=new ManifestStore(store);
    const resource=store.saveResource({name:'source',scenario:'migration',description:'',contentUrl:'https://source.invalid',referenceUrl:'',externalSource:'',externalId:'',files:[]});
    const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'env',requirements:''},defaultAutomationSettings)[0];
    const items=related();items[2]={...items[2],dataIdentity:undefined,expectedKeys:[],paths:['/category/100_3.aspx'],samples:['/category/100_3.aspx']};
    items.push({...record('assets',[]),expectedCount:null});
    const original=manifests.save(task,input(items),'human');
    const extended=structuredClone(items);extended[2].dataIdentity=relation().dataIdentity;extended[2].expectedKeys=[edge];extended[3]={...extended[3],dataIdentity:{kind:'assets'},expectedCount:1,expectedKeys:['https://source.invalid/a.png']};
    const next=manifests.save(task,input(extended),'ai',original.id);
    assert.equal(next.revision,2);assert.deepEqual(manifests.get(original.id),original);
    for(const mutate of [
      (i:Requirement[])=>{i.splice(2,1);},
      (i:Requirement[])=>{i[2].required=false;},
      (i:Requirement[])=>{i[2].kind='implementation';i[2].dataIdentity=undefined;},
      (i:Requirement[])=>{i[2].paths=[];},
      (i:Requirement[])=>{i[2].viewports=['desktop'];},
      (i:Requirement[])=>{i[2].expectedCount=0;},
      (i:Requirement[])=>{i[2].expectedKeys=[];},
      (i:Requirement[])=>{i[2].samples=[];},
      (i:Requirement[])=>{i[2].dataIdentity=undefined;},
      (i:Requirement[])=>{i[3].dataIdentity={kind:'page'};},
    ]){
      const reduced=structuredClone(extended);mutate(reduced);
      assert.throws(()=>manifests.save(task,input(reduced),'ai'),/不得/);
      assert.equal(store.task(task.id)!.requirementsId,next.id);
    }
  }finally{db.close();}
});

test('all data domains still need exact source keys, full counts and implementation evidence',()=>{
  for(const identity of [undefined,{kind:'page' as const},{kind:'relations' as const,parentRequirementIds:['parents'],childRequirementIds:['children']},{kind:'assets' as const}]){
    const item={...record('data',[identity?.kind==='relations'?edge:'source-key']),dataIdentity:identity};
    const manifest=frozen(item),check=verified(item);
    assert.equal(validateCompleteness([check],manifest,[backend]).state,'complete');
    for(const incomplete of [{...check,checkedKeys:[]},{...check,actualCount:2},{...check,actualCount:null}])assert.throws(()=>validateCompleteness([incomplete],manifest,[backend]),/全部记录标识/);
    for(const unresolved of [{...item,expectedCount:null},{...item,expectedKeys:[]}])assert.throws(()=>validateCompleteness([check],frozen(unresolved),[backend]),/全部记录标识/);
    const image={...backend,name:'screenshot.png',type:'image/png'};
    assert.throws(()=>validateCompleteness([{...check,evidence:[image.name]}],manifest,[image]),/只读后台证据/);
    assert.equal(validateCompleteness([{...check,status:'unverified'}],manifest,[backend]).state,'unverified');
  }
});
