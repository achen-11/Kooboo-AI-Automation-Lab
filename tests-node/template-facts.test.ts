import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Requirement, RequirementManifest } from '../shared/completeness.js';
import type { AutomationTask, MaterialFile } from '../shared/automation.js';
import { templateRecordFacts, prepareTemplateFacts, applyTemplateFacts, type TemplateFacts } from '../server/automation/template-facts.js';
import { assertRequirementDataIdentityPreserved, manifestInput } from '../server/automation/completeness.js';

const item:Requirement={id:'cars',title:'Cars',kind:'data',required:true,source:'frozen',expectation:'all identities and nonempty names; semantics independently reviewed',paths:[],viewports:['business'],expectedCount:3,expectedKeys:['a','b','c'],records:{storage:'sqlite',container:'Cars',keyField:'SourceId',requiredFields:['Name']}};
const signal=()=>new AbortController().signal;
const read=(lists:unknown[][],options:{total?:number;pages?:number}={})=>async(raw:unknown)=>{const request=raw as {page:number};return {evidence:'implementation-'+randomUUID()+'.json',result:{value:{list:lists[request.page-1],pageNr:request.page,totalCount:options.total??lists.flat().length,totalPages:options.pages??lists.length}}};};

test('program reconciles every declared record page and keeps full identities outside the model response',async()=>{
  const calls:unknown[]=[],reader=read([[{SourceId:'a',Name:'A'},{SourceId:'b',Name:'B'}],[{SourceId:'c',Name:'C'}]]);
  const proof=await templateRecordFacts(item,async q=>{calls.push(q);return reader(q);},signal());
  assert.equal(proof.state,'verified');assert.equal(proof.actualCount,3);assert.deepEqual(proof.checkedKeys,['a','b','c']);assert.equal(proof.evidence.length,2);assert.deepEqual(calls,[{kind:'rows',table:'Cars',page:1},{kind:'rows',table:'Cars',page:2}]);
  const facts={records:[proof]} as TemplateFacts,raw={completeness:[{id:'cars',status:'unverified',reason:'Interaction not yet tested',evidence:[],actualCount:null,checkedKeys:[]}]};
  const merged=applyTemplateFacts(raw,facts) as typeof raw;
  assert.equal(merged.completeness[0].status,'unverified','program equality does not promote semantic uncertainty');assert.deepEqual(merged.completeness[0].checkedKeys,['a','b','c']);assert.deepEqual(raw.completeness[0].checkedKeys,[],'model record is not mutated');
});

test('missing, extra records and required fields are computed exactly and cannot be overridden by a model pass',async()=>{
  const proof=await templateRecordFacts(item,read([[{SourceId:'a',Name:'A'},{SourceId:'b',Name:''},{SourceId:'extra',Name:'X'}]]),signal());
  assert.equal(proof.state,'missing');assert.deepEqual(proof.missingKeys,['c']);assert.deepEqual(proof.unexpectedKeys,['extra']);assert.deepEqual(proof.emptyFields,[{key:'b',fields:['Name']}]);
  const merged=applyTemplateFacts({completeness:[{id:'cars',status:'verified',reason:'Looks complete',evidence:[]}]},{records:[proof]} as TemplateFacts) as any;
  assert.equal(merged.completeness[0].status,'partial');assert.equal(merged.completeness[0].actualCount,3);
});

test('unknown source counts and undeclared storage never trigger guessed backend queries',async()=>{
  let calls=0;const reader=async()=>{calls++;throw new Error('must not read');};
  assert.equal((await templateRecordFacts({...item,records:undefined},reader,signal())).state,'unverified');
  assert.equal((await templateRecordFacts({...item,expectedCount:null},reader,signal())).state,'unverified');
  assert.equal(calls,0);
});

test('real Kooboo SQLite cells, content textValues and commerce paging are reconciled without model counting',async()=>{
  const rows=[{SourceId:'a',Name:'A'},{SourceId:'b',Name:'B'},{SourceId:'c',Name:'C'}];
  const sqlite=await templateRecordFacts(item,read([rows.map(row=>Object.entries(row).map(([key,value])=>({key,value})))]),signal());assert.equal(sqlite.state,'verified');
  const content=await templateRecordFacts({...item,records:{...item.records!,storage:'content',container:randomUUID()}},read([rows.map(row=>({id:randomUUID(),textValues:row}))]),signal());assert.equal(content.state,'verified');
  const pages:number[]=[];
  const commerce=await templateRecordFacts({...item,records:{...item.records!,storage:'commerce',container:undefined}},async raw=>{const page=(raw as {page:number}).page;pages.push(page);return {evidence:'implementation-'+randomUUID()+'.json',result:{value:{list:rows.slice((page-1)*2,page*2),pageIndex:page,pageSize:2,count:3}}};},signal());
  assert.equal(commerce.state,'verified');assert.deepEqual(pages,[1,2]);assert.deepEqual(commerce.checkedKeys,['a','b','c']);
});

test('pagination errors, duplicate identities and interrupted reads stay unverified, never an empty pass',async()=>{
  for(const reader of [
    async()=>({evidence:'implementation-x.json',result:{value:[{SourceId:'a',Name:'A'}]}}),
    read([[{SourceId:'a',Name:'A'}]],{total:3}),
    read([[{SourceId:'a',Name:'A'},{SourceId:'a',Name:'A'},{SourceId:'c',Name:'C'}]]),
    async(raw:unknown)=>{const page=(raw as {page:number}).page;return {evidence:'implementation-x.json',result:{value:{list:[{SourceId:page,Name:'A'}],pageNr:page,totalPages:2,totalCount:page===1?2:3}}};},
  ]){const proof=await templateRecordFacts(item,reader,signal());assert.equal(proof.state,'unverified');}
  const controller=new AbortController();controller.abort(new Error('operator stop'));
  await assert.rejects(templateRecordFacts(item,read([[]]),controller.signal),/operator stop/);
});

test('record machine contracts are validated and cannot be silently changed after freezing',()=>{
  assert.doesNotThrow(()=>manifestInput.parse({sourceComplete:true,limitations:[],items:[item],evidence:[]}));
  assert.throws(()=>assertRequirementDataIdentityPreserved(item,{...item,records:undefined}),/程序记录/);
  assert.throws(()=>manifestInput.parse({sourceComplete:true,limitations:[],items:[{...item,records:{...item.records,container:undefined}}],evidence:[]}));
  assert.throws(()=>manifestInput.parse({sourceComplete:true,limitations:[],items:[{...item,kind:'implementation'}],evidence:[]}));
});

test('host page facts preserve source path queries, current revision, every viewport and honest unknown HTTP status',async()=>{
  const work=mkdtempSync(resolve(tmpdir(),'template-facts-'));mkdirSync(resolve(work,'evidence'));
  try{
    const task={id:randomUUID(),siteRevision:'now'} as AutomationTask,files:MaterialFile[]=[];
    const add=(revision:string,viewport:'desktop'|'mobile',status?:number)=>{const image=randomUUID()+'.png',name=image.replace('.png','.json'),value={file:image,role:'target',viewport,url:'https://target.test/about?lang=zh',capturedAt:1,navigationStatus:status,settlement:{settled:true},binding:{taskId:task.id,siteRevision:revision}};
      for(const [n,bytes,type] of [[image,Buffer.from('mock pixels'),'image/png'],[name,Buffer.from(JSON.stringify(value)),'application/json']] as const){writeFileSync(resolve(work,'evidence',n),bytes);files.push({id:randomUUID(),name:n,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,type,role:'target',viewport});}};
    add('now','desktop',404);add('old','mobile',200);
    const manifest={id:'manifest',items:[{...item,id:'pages',kind:'page',paths:['https://source.test/about?lang=zh'],viewports:['desktop','mobile'],records:undefined}]} as RequirementManifest;
    const facts=await prepareTemplateFacts({task,manifest,work,files,target:'https://target.test/',source:'https://source.test/',read:read([[]]),signal:signal()});
    assert.deepEqual(facts.pages[0].paths[0].viewports.map(v=>[v.viewport,v.state,v.navigationStatus]),[['desktop','captured',404],['mobile','missing',null]]);
    add('now','mobile');const next=await prepareTemplateFacts({task,manifest,work,files,target:'https://target.test/',source:'https://source.test/',read:read([[]]),signal:signal()});assert.equal(next.pages[0].paths[0].viewports[1].navigationStatus,null,'historical captures without status are never guessed HTTP200');
    const raw={completeness:[{id:'pages',status:'verified',reason:'Model pass',evidence:[],sampledPaths:[],checkedViewports:[]}]};
    const merged=applyTemplateFacts(raw,next,manifest) as typeof raw;assert.equal(merged.completeness[0].status,'partial','HTTP404 overrides a model pass');assert.deepEqual(merged.completeness[0].sampledPaths,['https://source.test/about?lang=zh']);assert.deepEqual(merged.completeness[0].checkedViewports,['desktop','mobile']);
    const missing=applyTemplateFacts(raw,facts,manifest) as typeof raw;assert.equal(missing.completeness[0].status,'partial');assert.deepEqual(missing.completeness[0].checkedViewports,['desktop']);
  }finally{rmSync(work,{recursive:true,force:true});}
});
