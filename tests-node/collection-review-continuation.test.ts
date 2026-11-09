import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { reviewCollection } from '../server/automation/collection/orchestrator.js';
import { CollectionBlocked } from '../server/automation/collection/errors.js';
import { sourceRenderedEvidencePath, type captureSourceRenderedEvidence } from '../server/automation/collection/source-rendered.js';
import { localDecision, LocalDecisionInterrupted, type LocalDecisionOptions } from '../server/automation/local-decision.js';
import { RequestBudget } from '../server/automation/request-budget.js';
import type { codexClient } from '../server/automation/codex-client.js';

const rawPath='.work/raw/one.html',body='<html>prefix 原始来源正文 source evidence verified suffix outside receipt</html>';
function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'review-continuation-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory),settings=structuredClone(defaultAutomationSettings);
  settings.completeness!.maxMinutes=5;settings.learning!.use=false;
  vault.update({threshold:80,paused:true,model:{endpoint:'https://models.invalid',name:'test',apiKey:'fake-key'},environments:[]});
  const resource=store.saveResource({name:'Source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'Source',files:[],externalSource:'',externalId:''});
  const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},settings)[0],collections=new CollectionStore(store,directory);
  let run=collections.create(task);
  const write=(path:string,value:unknown)=>{const file=resolve(collections.workspace(run),path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  write('.work/state.json',{source:run.sourceUrl,siteHosts:['source.invalid'],urls:{one:{id:'one',url:'https://source.invalid/one',action:'keep',status:200,rawFile:rawPath}}});
  write(rawPath,body);write('.work/extract/one.json',{fullText:'原始来源正文 source evidence verified'});write('site/a-checklist.json',{findings:[]});
  run.completed=['plan','discover','fetch','extract','assets','data','render','verify'];collections.put(run);
  return {directory,db,store,vault,task,collections,write,get run(){return run;},reload(){run=collections.get(run.id)!;},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
type ReviewOptions=LocalDecisionOptions<unknown>;
const signal=()=>new AbortController().signal;
const interrupted=()=>new LocalDecisionInterrupted('window',new Error('本地 AI 决策已达到活动时间上限'));
function review(f:Fixture,decide:(options:ReviewOptions)=>Promise<unknown>,captureRendered?:typeof captureSourceRenderedEvidence){return reviewCollection(f.task,f.store,f.vault,f.directory,f.collections,f.run,signal(),{decide:decide as typeof localDecision,captureRendered});}
function blocked(quote='source evidence verified'){return {action:'blocked',reason:'根据已核验原件，等待具体外部条件补齐',evidence:[{path:rawPath,sha256:collectionHash(body),quote}],nextSteps:['补齐原始来源的具体缺口后恢复。']};}

test('soft windows preserve the thread, work directory, exact read spans, budgets and failure history',async()=>{
  const f=fixture();try{
    let first!:ReviewOptions;const history=JSON.stringify(f.task.autonomy!.history);
    await assert.rejects(review(f,async options=>{first=options;assert.equal(options.minutes,5);options.onThreadStarted!('same-thread');await options.read!({kind:'file',path:rawPath,offset:body.indexOf('source'),limit:24},signal());await options.read!({kind:'requirements',limit:40},signal());const budget=new RequestBudget(f.db,options.policy);budget.reserve('paid',Buffer.from('{}'));budget.complete('paid',{input_tokens:500,output_tokens:100});throw interrupted();}),LocalDecisionInterrupted);
    const original=f.run.reviewContinuation!;assert.equal(original.resumable,true);assert.equal(original.threadId,'same-thread');assert.equal(original.readReceipts.length,2);f.reload();
    await review(f,async options=>{assert.equal(options.resumeThreadId,'same-thread');assert.equal(options.workId,first.workId);assert.notEqual(options.id,first.id);assert.deepEqual(options.policy,first.policy);assert.equal(options.minutes,5);assert.equal(new RequestBudget(f.db,options.policy).state().spent,600);assert.equal(new RequestBudget(f.db,options.policy).state().requests,1);const context=options.context as any;assert.equal(context.reviewContinuation.resumed,true);assert.equal(context.reviewContinuation.readReceipts.length,2);assert.throws(()=>options.submit(blocked('outside receipt')),/实际读取/);return options.submit(blocked());});
    assert.equal(f.run.reviewContinuation,undefined);assert.equal(f.run.reviewAttempt,2);assert.equal(JSON.stringify(f.task.autonomy!.history),history);assert.equal((f.run.review as any).action,'blocked');
    const receipts=JSON.parse(readFileSync(resolve(f.directory,'collection-reviews',f.run.id,first.workId!,'read-receipts.json'),'utf8'));assert.equal(receipts[0].offset,body.indexOf('source'));assert.equal(receipts[0].chars,24);
  }finally{f.close();}
});

for(const change of ['input','engine','state','checklist','already-read-file','options','collection-action'] as const){
  test(`a changed ${change} starts an independent review and cannot reuse old read permission`,async()=>{
    const f=fixture();try{
      let firstWork='';await assert.rejects(review(f,async options=>{firstWork=options.workId!;options.onThreadStarted!('old-thread');await options.read!({kind:'file',path:rawPath},signal());throw interrupted();}),LocalDecisionInterrupted);
      if(change==='input')f.task.message+=' changed input';
      if(change==='engine')f.run.engineVersion='changed-engine';
      if(change==='state')f.write('.work/state.json',{...f.collections.json(f.run,'.work/state.json'),newCondition:true});
      if(change==='checklist')f.write('site/a-checklist.json',{findings:[],revision:2});
      if(change==='already-read-file')f.write(rawPath,body+' changed');
      if(change==='options')f.run.options.maxPages++;
      if(change==='collection-action')f.run.operations.push({id:'new-collection',operation:'assets',status:'completed',startedAt:1});
      await assert.rejects(review(f,async options=>{assert.equal(options.resumeThreadId,undefined);assert.notEqual(options.workId,firstWork);assert.equal((options.context as any).reviewContinuation.readReceipts.length,0);assert.throws(()=>options.submit(blocked()),/实际读取|哈希/);throw new Error('independent fixture ended');}),/independent fixture ended/);
      assert.equal(f.run.reviewContinuation,undefined);
    }finally{f.close();}
  });
}

test('only a recognized interruption is resumable; a validated collection action clears the continuation',async()=>{
  const f=fixture();try{
    await assert.rejects(review(f,async options=>{options.onThreadStarted!('broken-thread');throw new Error('invalid SDK configuration');}),/invalid SDK configuration/);assert.equal(f.run.reviewContinuation,undefined);
    await assert.rejects(review(f,async options=>{options.onThreadStarted!('kept-thread');await options.read!({kind:'file',path:rawPath},signal());throw new LocalDecisionInterrupted('connection',new Error('SDK connection closed'));}),LocalDecisionInterrupted);
    await review(f,async options=>{assert.equal(options.resumeThreadId,'kept-thread');return options.submit({action:'continue',operation:'verify',objective:{description:'针对已核验原文继续来源验证',affectedObjects:['one'],evidence:[rawPath],acceptance:'原件和提取逐项一致并满足全部检查'}});});assert.equal(f.run.reviewContinuation,undefined);
  }finally{f.close();}
});

for(const state of ['active','unknown'])test(`a historical ${state} request blocks a new window without clearing the ledger`,async()=>{
  const f=fixture();try{
    await assert.rejects(review(f,async options=>{options.onThreadStarted!('same-thread');const budget=new RequestBudget(f.db,options.policy);budget.reserve('unsettled',Buffer.from('{}'));if(state==='unknown')budget.complete('unsettled',null);throw interrupted();}),LocalDecisionInterrupted);
    const before=f.db.prepare('SELECT * FROM auto_model_requests WHERE id=?').get('unsettled');let calls=0;
    await assert.rejects(review(f,async()=>{calls++;return null;}),CollectionBlocked);assert.equal(calls,0);assert.deepEqual(f.db.prepare('SELECT * FROM auto_model_requests WHERE id=?').get('unsettled'),before);
  }finally{f.close();}
});

test('host-rendered additions rebind the current review but do not make an updated index already read',async()=>{
  const f=fixture();try{
    f.write(sourceRenderedEvidencePath,{version:1});let original='';
    const capture=(async()=>{f.write(sourceRenderedEvidencePath,{version:2});return {id:'new-render',pageId:'one',url:'https://source.invalid/one',observationPath:'new.json',screenshotPath:'new.png'};}) as unknown as typeof captureSourceRenderedEvidence;
    await assert.rejects(review(f,async options=>{original=options.workId!;options.onThreadStarted!('render-thread');await options.read!({kind:'file',path:sourceRenderedEvidencePath},signal());await options.read!({kind:'file',path:rawPath},signal());await options.read!({kind:'rendered',url:'https://source.invalid/one'},signal());throw interrupted();},capture),LocalDecisionInterrupted);
    assert.equal(f.run.reviewContinuation!.readReceipts.some(receipt=>receipt.path===sourceRenderedEvidencePath),false);f.reload();
    await review(f,async options=>{assert.equal(options.workId,original);assert.equal(options.resumeThreadId,'render-thread');assert.equal((options.context as any).reviewContinuation.readReceipts.length,1);return options.submit(blocked());});
  }finally{f.close();}
});

test('reusing an unchanged rendered index preserves its existing quote permission',async()=>{
  const f=fixture();try{
    const text='unchanged rendered evidence';f.write(sourceRenderedEvidencePath,text);
    const capture=(async()=>({id:'cached-render',pageId:'one',url:'https://source.invalid/one',observationPath:'cached.json',screenshotPath:'cached.png'})) as unknown as typeof captureSourceRenderedEvidence;
    await review(f,async options=>{options.onThreadStarted!('render-thread');await options.read!({kind:'file',path:sourceRenderedEvidencePath},signal());await options.read!({kind:'rendered',url:'https://source.invalid/one'},signal());return options.submit({...blocked(),evidence:[{path:sourceRenderedEvidencePath,sha256:collectionHash(text),quote:text}]});},capture);
    assert.equal((f.run.review as any).action,'blocked');assert.equal(f.run.reviewContinuation,undefined);
  }finally{f.close();}
});

test('local decision resumes with fresh tools in the same work directory while keeping separate activity clocks',async()=>{
  const f=fixture();try{
    const policy={key:'shared-review',runKey:'shared-review',maxTokens:100000,maxRequests:10};let calls=0,firstToken='',firstWork='';
    const createClient=((_vault:unknown,_directory:string,env:Record<string,string>)=>({
      startThread:(options:any)=>{assert.equal(calls++,0);firstWork=options.workingDirectory;firstToken=env.DECISION_TOOLS_TOKEN;return {runStreamed:async()=>({events:(async function*(){yield {type:'thread.started',thread_id:'persistent-sdk-thread'};throw new Error('SDK connection closed');})()})};},
      resumeThread:(threadId:string,options:any)=>{assert.equal(calls++,1);assert.equal(threadId,'persistent-sdk-thread');assert.equal(options.workingDirectory,firstWork);assert.notEqual(env.DECISION_TOOLS_TOKEN,firstToken);return {runStreamed:async(prompt:string)=>{assert.match(prompt,/接着上次未完成/);assert.match(prompt,/不能仅因换窗口再次capture/);return {events:(async function*(){const response=await fetch(env.DECISION_TOOLS_URL,{method:'POST',headers:{authorization:'Bearer '+env.DECISION_TOOLS_TOKEN,'content-type':'application/json'},body:JSON.stringify({tool:'submit',result:{ok:true}})});assert.equal(response.status,200);yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};})()};}};},
    })) as unknown as typeof codexClient;
    const base={task:f.task,store:f.store,vault:f.vault,directory:f.directory,stage:'planning' as const,workId:'persistent-work',sop:'fixture',context:{},policy,minutes:5,signal:signal(),createClient,submit:(raw:unknown)=>{assert.deepEqual(raw,{ok:true});return true;}};
    await assert.rejects(localDecision({...base,id:'window-one'}),LocalDecisionInterrupted);
    f.db.prepare('UPDATE auto_decision_clock SET elapsed_ms=? WHERE id=?').run(300000,'window-one');
    assert.equal(await localDecision({...base,id:'window-two',resumeThreadId:'persistent-sdk-thread'}),true);
    const clocks=f.db.prepare('SELECT id,elapsed_ms FROM auto_decision_clock ORDER BY id').all();assert.equal(clocks.length,2);assert.equal(clocks[0].elapsed_ms,300000);assert.ok(Number(clocks[1].elapsed_ms)<300000);
    await assert.rejects(localDecision({...base,id:'window-one',resumeThreadId:'persistent-sdk-thread'}),/恢复不会重置计时/);
  }finally{f.close();}
});
