import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, submission } from './native-fixture.js';
import { Store, Conflict, LostLease } from '../backend/lib/store.js';
import { listRules } from '../backend/lib/rules.js';
import { parameters } from '../backend/runtime.js';
import { dispatch } from '../backend/app.js';
import { Vault } from '../backend/lib/vault.js';
import { cropScript } from '../backend/lib/collector.js';
import { runInNewContext } from 'node:vm';

test('native SQL binding preserves literals and refuses parameter mismatch', () => {
  assert.deepEqual(parameters("SELECT '?', 'it''s ?', ?",['value']),{sql:"SELECT '?', 'it''s ?', @p0",params:{p0:'value'}});
  assert.throws(()=>parameters('SELECT ?',[]));
});
test('100 queued jobs survive reopening; concurrent claims and stale writes are fenced', () => {
  const dir=mkdtempSync(join(tmpdir(),'kooboo-evaluator-'));const file=join(dir,'queue.sqlite');
  let f=fixture(file);let store=new Store(file);
  for(let i=0;i<100;i++)store.accept(submission(`job-${i}`,i+1));
  f.db.close();f=fixture(file);store=new Store(file);
  assert.equal(store.list().length,100);
  const first=store.claim('old')!;assert.equal(store.claim('concurrent'),null);
  f.db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(Date.now()-1,first.run.id);
  const next=store.claim('new')!;assert.equal(next.run.id,first.run.id);
  assert.throws(()=>store.update(first.run.id,'old',{status:'failed'}),LostLease);
  store.update(next.run.id,'new',{status:'failed'});
  assert.ok(store.claim('next'));
  f.db.close();rmSync(dir,{recursive:true});
});
test('idempotency rejects mutated payload; domain identity preserves subdomains and history', () => {
  const f=fixture(),store=new Store('site');const input=submission();
  const a=store.accept(input,'https://ONE.example.test:8443/path');
  assert.equal(store.accept(input,'https://ONE.example.test:8443/path').evaluationId,a.evaluationId);
  assert.throws(()=>store.accept({...input,jobId:'other'},'https://ONE.example.test:8443/path'),Conflict);
  const b=store.accept(submission('second',input.occurredAt+1),'https://one.example.test/other');
  store.accept(submission('third',input.occurredAt+2),'https://two.example.test');
  assert.equal(store.list(80,true).length,2);assert.equal(store.siteHistory('one.example.test')[0].id,b.evaluationId);
  f.db.close();
});
test('native transaction rolls back failed rule publication and preserves published snapshots', () => {
  const f=fixture(),store=new Store('site');const seed=listRules()[0];store.registerRule(seed.rule.version,seed.hash,seed.rule);
  const draft=store.createDraft({...seed.rule,version:'visual-v2'});
  const changed=store.saveDraft(draft.id,draft.revision,{...draft.rule,name:'new'});
  assert.throws(()=>store.publishDraft(draft.id,draft.revision),Conflict);
  const execute=f.native.DB.sqlite.execute;
  f.native.DB.sqlite.execute=(sql:string,params:any)=>{if(sql.startsWith('UPDATE rule_drafts SET published_at'))throw new Error('injected storage failure');return execute(sql,params);};
  assert.throws(()=>store.publishDraft(changed.id,changed.revision));
  assert.equal(store.getRule('visual-v2'),null);assert.equal(store.draft(draft.id)!.publishedAt,null);
  f.native.DB.sqlite.execute=execute;
  store.publishDraft(changed.id,changed.revision);
  assert.equal(store.getRule('visual-v2')!.rule.name,'new');
  assert.throws(()=>store.saveDraft(changed.id,changed.revision,changed.rule),Conflict);f.db.close();
});
test('hosted API denies anonymous management and separates ingest/read permissions', () => {
  const f=fixture();dispatch();assert.equal(f.result().status,200);
  const vault=new Vault();const credentials=vault.credentials;
  f.native.account.isLogin=false;
  f.request('/api/settings');dispatch();assert.equal(f.result().status,401);
  f.request('/api/settings','GET',undefined,{authorization:`Bearer ${credentials.readToken}`});dispatch();assert.equal(f.result().status,401);
  const input=submission();
  f.request('/api/evaluations','POST',input,{authorization:`Bearer ${credentials.ingestToken}`,'idempotency-key':input.attemptId});dispatch();assert.equal(f.result().status,202);
  f.request('/api/evaluations','GET',undefined,{authorization:`Bearer ${credentials.ingestToken}`});dispatch();assert.equal(f.result().status,401);
  f.request('/api/evaluations','GET',undefined,{authorization:`Bearer ${credentials.readToken}`});dispatch();assert.equal(f.result().body.total,1);
  f.native.account.isLogin=true;
  f.request('/api/settings','PUT',{}, {origin:'https://evil.test'});dispatch();assert.equal(f.result().status,403);
  f.db.close();
});
test('logout requires an administrator and trusted origin, then ends the session', () => {
  const f=fixture(),vault=new Vault();
  f.native.account.isLogin=false;
  f.request('/api/logout','POST');dispatch();assert.equal(f.result().status,401);
  for(const token of [vault.credentials.ingestToken,vault.credentials.readToken]) {
    f.request('/api/logout','POST',undefined,{authorization:`Bearer ${token}`});dispatch();assert.equal(f.result().status,401);
  }
  f.native.account.isLogin=true;
  f.request('/api/logout','POST',undefined,{origin:'https://evil.test'});dispatch();assert.equal(f.result().status,403);
  assert.equal(f.native.account.isLogin,true);
  f.request('/api/logout','POST',undefined,{origin:'https://evaluator.test'});dispatch();assert.equal(f.result().status,200);
  assert.equal(f.result().body.ok,true);
  f.request('/api/session');dispatch();assert.equal(f.result().status,401);
  f.db.close();
});
test('model test requires saved settings and never creates evaluation records', () => {
  const f=fixture();f.request('/api/model/test','POST');dispatch();assert.equal(f.result().status,400);
  const vault=new Vault();vault.update({threshold:80,paused:false,model:{endpoint:'https://model.test/v1/chat/completions',name:'vision',apiKey:'secret-key'},environments:[]});
  let call:any;
  f.native.net={httpClient:{createJsonContent:(v:any)=>v,send:(_u:string,_m:string,body:any,headers:any,timeout:number)=>{call={body,headers,timeout};return {success:true,statusCode:200,bodyString:()=>JSON.stringify({choices:[{message:{content:'{"left":"red","right":"blue"}'}}]})};}}};
  f.request('/api/model/test','POST');dispatch();assert.equal(f.result().body.ok,true);assert.equal(call.timeout,50);
  assert.ok(call.body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(new Store('site').list().length,0);assert.equal(JSON.stringify(vault.public()).includes('secret-key'),false);
  assert.equal(String(f.db.prepare('SELECT payload FROM evaluator_vault').get()!.payload).includes('secret-key'),false);
  f.db.close();
});
test('slice pixels follow actual full image coordinates and collapse short-page duplicates', async () => {
  const calls:any[]=[];
  const context={Image:class {width=1440;height=3000;src='';decode(){return Promise.resolve();}},document:{createElement:()=>({width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage:(...args:any[])=>calls.push(args)}),toDataURL:()=> 'data:image/png;base64,abc'})}};
  const result=await runInNewContext(cropScript('png',1440,900,12000,3),context);
  assert.equal(result.length,3);assert.deepEqual(calls.map(x=>x[2]),[0,1050,2100]);
  context.Image=class {width=1440;height=800;src='';decode(){return Promise.resolve();}};
  assert.equal((await runInNewContext(cropScript('png',1440,900,12000,3),context)).length,1);
});
test('one-time configuration import preserves tokens and never overwrites subsequent edits', () => {
  const f=fixture();new Store('site');const vault=new Vault();
  const credentials={ingestToken:'a'.repeat(64),readToken:'b'.repeat(64)};
  const settings={threshold:75,paused:false,model:{endpoint:'https://model.test/chat',name:'vision',apiKey:'old-secret'},environments:[]};
  assert.equal(vault.importInitial(settings,credentials,'c'.repeat(64)).duplicate,false);
  assert.deepEqual(vault.credentials,credentials);
  vault.update({...settings,threshold:85});
  assert.equal(vault.importInitial(settings,credentials,'c'.repeat(64)).duplicate,true);
  assert.equal(vault.get().threshold,85);
  assert.throws(()=>vault.importInitial(settings,credentials,'d'.repeat(64)),Conflict);
  f.db.close();
});
