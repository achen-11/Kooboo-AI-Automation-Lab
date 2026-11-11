import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { AutomationWorker, type Execute } from '../server/automation/worker.js';
import { Pending, UnconfirmedStop } from '../server/automation/errors.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { defaultAutomationSettings, defaultOptimizationPolicy, type AutomationReport, type AutomationTask, type FollowupAction } from '../shared/automation.js';
import { createAutonomousExecution } from '../shared/autonomy.js';
import { autonomousWindowRemaining, followupRequestPolicy, nextAutonomousWindow, recordAutonomousAttempt, retainStoppedFollowupReservations } from '../server/automation/autonomy.js';
import { RequestBudget } from '../server/automation/request-budget.js';
import { advanceOptimization, applyOptimizationAction, optimizationBudgetReason } from '../server/automation/optimization.js';

function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'autonomous-recovery-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory);
  const settings=structuredClone({...defaultAutomationSettings,enabled:true,autoEvaluate:false,generationConcurrency:1,evaluationConcurrency:1});
  settings.learning!.collect=false;
  vault.updateAutomation(settings);
  const resource=store.saveResource({name:'Autonomous task',scenario:'site-template',contentUrl:'https://source.invalid/',referenceUrl:'',description:'',files:[],externalSource:'',externalId:''});
  const create=(autonomous=true)=>{const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'homepage',environmentId:'',requirements:''},settings)[0];if(autonomous)task.autonomy=createAutonomousExecution('Finish original objective');store.put(task);return task;};
  const attach=(task:AutomationTask)=>{const site={id:randomUUID(),resourceId:resource.id,versionId:task.versionId,environmentId:'',siteId:randomUUID(),name:'Original',url:'https://generated.invalid/',createdAt:Date.now()};store.saveSite(site);task.generatedSiteId=site.id;task.siteUrl=site.url;task.generation={prepared:true,conversationId:'original-conversation',deliveryId:'original-delivery',deliveryState:'completed'};store.put(task);};
  return {directory,db,store,vault,settings,resource,create,attach,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
const idle:Execute=async()=>{};
const action=(kind:FollowupAction['action']):FollowupAction=>({action:kind,reason:'Actual inspected state',evidence:['host-observation'],nextSteps:['Check retained evidence'],waitSeconds:5});
async function settled(worker:AutomationWorker,id:string) {const end=Date.now()+3000;while(worker.owns(id)){if(Date.now()>end)throw new Error('worker did not settle');await new Promise(r=>setTimeout(r,2));}}
function due(task:AutomationTask) {if(task.autonomy)task.autonomy.checkpoint.nextAt=0;if(task.followup)task.followup.nextAt=0;}

test('new soft windows preserve cumulative followup counters; historical tasks keep their hard budget',async()=>{
  for(const autonomous of [true,false]){
    const f=fixture();let worker:AutomationWorker|undefined;
    try{
      const task=f.create(autonomous);f.store.scheduleFollowup(task,f.settings.followup);
      const followup=task.followup!;followup.attempts=followup.policy.maxAttempts;followup.tokens=followup.policy.maxTokens;followup.elapsedMs=followup.policy.maxMinutes*60000;f.store.put(task);
      let decisions=0;worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>{decisions++;return action('interrupt');});
      await worker.tick();await settled(worker,task.id);
      const saved=f.store.task(task.id)!;
      assert.equal(decisions,autonomous?1:0);assert.equal(saved.followup!.attempts,followup.policy.maxAttempts+(autonomous?1:0));assert.equal(saved.followup!.tokens,followup.policy.maxTokens);assert.ok(saved.followup!.elapsedMs!>=followup.policy.maxMinutes*60000);
      if(autonomous){assert.equal(saved.autonomy!.window.index,1);assert.equal(saved.autonomy!.window.tokensBase,followup.policy.maxTokens);}else assert.match(saved.interruption!.reason,/次数、时间或 token 预算/);
    }finally{await worker?.stop();f.close();}
  }
});

test('a confirmed execution timeout resumes from its checkpoint after durable backoff; legacy recovery is unchanged',async()=>{
  for(const autonomous of [true,false]){
    const f=fixture();let worker:AutomationWorker|undefined;
    try{
      const task=f.create(autonomous);let executions=0,decisions=0;
      const execute:Execute=async current=>{executions++;current.generation={importedMaterials:{one:'verified-sha'}};throw new Pending('本轮执行达到时限，需要接续');};
      worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true,async()=>{decisions++;return action('interrupt');});
      await worker.tick();await settled(worker,task.id);const saved=f.store.task(task.id)!;
      assert.equal(executions,1);assert.deepEqual(saved.generation?.importedMaterials,{one:'verified-sha'});
      if(autonomous){assert.equal(saved.status,'queued');assert.equal(saved.stopped,true);assert.ok(saved.autonomy!.checkpoint.nextAt!>Date.now());await worker.tick();assert.equal(executions,1);assert.equal(decisions,0);}else{assert.equal(decisions,1);assert.equal(saved.status,'interrupted');}
    }finally{await worker?.stop();f.close();}
  }
});

test('identical failed work is bounded, whereas independently saved content progress permits continuation',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();let calls=0;const execute:Execute=async()=>{calls++;throw new Error('ECONNRESET');};
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true);
    for(let i=0;i<4;i++){const saved=f.store.task(task.id)!;due(saved);f.store.put(saved);await worker.tick();await settled(worker,task.id);}
    assert.equal(calls,4);assert.equal(f.store.task(task.id)!.status,'interrupted');assert.match(f.store.task(task.id)!.interruption!.reason,/重复失败/);
    const progressing=f.create();for(let i=0;i<20;i++){progressing.generation={importedMaterials:Object.fromEntries(Array.from({length:i+1},(_,j)=>['item-'+j,'hash-'+j]))};assert.equal(recordAutonomousAttempt(progressing,'collect','temporary timeout',i),'');}
    assert.equal(progressing.autonomy!.history.failures.length,20);assert.equal(progressing.autonomy!.history.noProgress,0);
    const oscillating=f.create();for(const strategy of ['A','B','A','B'])recordAutonomousAttempt(oscillating,strategy,'same unchanged outcome');assert.match(oscillating.autonomy!.stopReason!,/策略反复回转/);
    const recollected=f.create();for(let i=0;i<4;i++){recollected.artifacts=[{id:randomUUID(),name:randomUUID()+'.png',sha256:String(i).repeat(64),type:'image/png',role:'target',viewport:'desktop',size:100}];recordAutonomousAttempt(recollected,'evaluate','same validation failure');}assert.match(recollected.autonomy!.stopReason!,/重复失败/,'random filenames and replacement pixels cannot manufacture progress');
  }finally{await worker?.stop();f.close();}
});

test('uncertain generation delivery is retained for inspection without another generation request',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();f.attach(task);task.generation!.deliveryState='sending';f.store.put(task);let calls=0,inspections=0;
    const execute:Execute=async()=>{calls++;throw new Pending('委托是否被接受尚未确认');};
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true,async current=>{inspections++;assert.equal(current.generation!.deliveryId,'original-delivery');return action('wait');});
    await worker.tick();await settled(worker,task.id);let saved=f.store.task(task.id)!;assert.equal(saved.status,'following-up');assert.equal(inspections,0);
    due(saved);f.store.put(saved);await worker.tick();await settled(worker,task.id);saved=f.store.task(task.id)!;
    assert.equal(calls,1);assert.equal(inspections,1);assert.equal(saved.generation!.deliveryState,'sending');assert.equal(saved.generation!.conversationId,'original-conversation');assert.equal(saved.generatedSiteId,task.generatedSiteId);
  }finally{await worker?.stop();f.close();}
});

test('cancellation wins over automatic retry even when a timeout arrives during shutdown',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();let started=false,calls=0;const execute:Execute=async(_task,_store,_vault,_dir,signal)=>{calls++;started=true;await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Pending('本轮达到时限')),{once:true}));};
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true);await worker.tick();assert.equal(started,true);
    const cancelling=f.store.task(task.id)!;cancelling.status='cancelling';f.store.put(cancelling);worker.cancel(task.id);await settled(worker,task.id);await worker.tick();assert.equal(calls,1);assert.equal(f.store.task(task.id)!.status,'cancelled');
  }finally{await worker?.stop();f.close();}
});

test('confirmed live collection polling persists nextAt without generic Kooboo recovery or false failure loops',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();let calls=0,followups=0;
    const execute:Execute=async()=>{calls++;const error=new Pending('采集批次仍在执行');Object.assign(error,{name:'CollectionPending',safeToRetry:true,waiting:true,nextAt:Date.now()+5000,progressKey:'same-host-checkpoint'});throw error;};
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true,async()=>{followups++;return action('interrupt');});
    for(let i=0;i<6;i++){const current=f.store.task(task.id)!;due(current);f.store.put(current);await worker.tick();await settled(worker,task.id);}
    const saved=f.store.task(task.id)!;assert.equal(calls,6);assert.equal(followups,0);assert.equal(saved.status,'queued');assert.equal(saved.autonomy!.history.failures.length,0);assert.ok(saved.autonomy!.checkpoint.nextAt!>Date.now());
  }finally{await worker?.stop();f.close();}
});

function shutdownCollection(f:ReturnType<typeof fixture>){
  const resource=f.store.saveResource({name:'Collection',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'',files:[],externalSource:'',externalId:''});
  const task=f.store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},f.settings)[0],collections=new CollectionStore(f.store,f.directory),run=collections.create(task);
  run.completed=['plan','discover','fetch','extract','assets'];run.operations=[{id:'registered-data-operation',operation:'data',status:'running',pid:123456,startedAt:Date.now()}];collections.put(run);return {task,collections,run};
}

test('service stop preserves pre-create collection checkpoints in the durable queue without recovery decisions or failure counts',async()=>{
  for(const operationState of ['failed','running'] as const){const f=fixture();let worker:AutomationWorker|undefined,resumed:AutomationWorker|undefined;
    try{const {task,collections,run}=shutdownCollection(f);let calls=0,decisions=0;
      const execute:Execute=async(_task,_store,_vault,_directory,signal)=>{calls++;await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{const retained=collections.get(run.id)!;retained.operations[0].status=operationState;if(operationState==='failed')retained.operations[0].error='interrupted by service shutdown';collections.put(retained);reject(signal.reason);},{once:true}));};
      worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:execute,evaluation:idle},()=>true,async()=>{decisions++;return action('interrupt');});await worker.tick();assert.equal(calls,1);await worker.stop();
      const saved=f.store.task(task.id)!;assert.equal(saved.status,'queued');assert.equal(saved.stopped,true);assert.equal(saved.followup,undefined);assert.equal(saved.generatedSiteId,null);assert.equal(saved.autonomy!.history.failures.length,0);assert.equal(saved.autonomy!.history.noProgress,0);assert.equal(decisions,0);assert.equal(collections.get(run.id)!.operations[0].status,operationState);assert.equal(collections.get(run.id)!.operations[0].pid,123456);assert.deepEqual(collections.get(run.id)!.completed,run.completed);
      resumed=new AutomationWorker(f.store,f.vault,f.directory,{generation:async current=>{calls++;assert.equal(current.collectionId,run.id);const pending=new Pending('resumed original operation receipt');Object.assign(pending,{name:'CollectionPending',safeToRetry:true,waiting:true,nextAt:Date.now()+5000});throw pending;},evaluation:idle},()=>true,async()=>{decisions++;return action('interrupt');});await resumed.tick();await settled(resumed,task.id);assert.equal(calls,2);assert.equal(decisions,0);assert.equal(f.store.task(task.id)!.status,'queued');assert.equal(f.store.task(task.id)!.autonomy!.history.failures.length,0);
    }finally{await resumed?.stop();await worker?.stop();f.close();}
  }
});

test('service-stop shortcut cannot requeue a cancelled, uncertain-stop, created or submitted generation',async()=>{
  for(const mode of ['cancelled','uncertain-stop','create-attempted','delivery-id','delivery-state','legacy','site'] as const){const f=fixture();let worker:AutomationWorker|undefined;
    try{const {task}=shutdownCollection(f);if(mode==='create-attempted')task.generation={createAttempted:true};if(mode==='delivery-id')task.generation={deliveryId:'uncertain-send'};if(mode==='delivery-state')task.generation={deliveryState:'sending'};if(mode==='legacy')task.generation={legacySubmitted:true};if(mode==='site')f.attach(task);f.store.put(task);
      worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:async(_task,_store,_vault,_dir,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(mode==='uncertain-stop'?new UnconfirmedStop('original execution is not confirmed stopped'):signal.reason),{once:true})),evaluation:idle},()=>true,async()=>action('interrupt'));
      await worker.tick();if(mode==='cancelled'){const current=f.store.task(task.id)!;current.status='cancelling';f.store.put(current);}await worker.stop();const saved=f.store.task(task.id)!;assert.notEqual(saved.status,'queued',mode);if(mode==='cancelled')assert.equal(saved.status,'cancelled');if(mode==='uncertain-stop')assert.equal(saved.stopped,false);
    }finally{await worker?.stop();f.close();}
  }
});

test('stopping an existing pre-create collection followup returns to collection while preserving consumed decision usage',async()=>{const f=fixture();let worker:AutomationWorker|undefined;try{
  const {task}=shutdownCollection(f);f.store.scheduleFollowup(task,f.settings.followup);task.followup!.tokens=125;task.followup!.elapsedMs=321;f.store.put(task);let decisions=0;
  worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async(_task,_store,_vault,_dir,signal)=>{decisions++;await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return action('interrupt');});await worker.tick();assert.equal(decisions,1);await worker.stop();const saved=f.store.task(task.id)!;assert.equal(saved.status,'queued');assert.equal(saved.followup!.state,'resolved');assert.equal(saved.followup!.attempts,1);assert.equal(saved.followup!.tokens,125);assert.ok(saved.followup!.elapsedMs!>=321);assert.equal(saved.autonomy!.history.failures.length,0);
}finally{await worker?.stop();f.close();}});

test('window rotation retains ledger usage and historical missing usage estimates',()=>{
  const f=fixture();try{
    const task=f.create();f.store.scheduleFollowup(task,f.settings.followup);const policy=followupRequestPolicy(task),budget=new RequestBudget(f.db,policy);
    budget.reserve('old-request',Buffer.from('{}'));budget.complete('old-request',null);const spent=budget.state().spent;
    f.store.usage.record(task.id,{id:'old-request',source:'codex',stage:'followup',model:'test',endpoint:'https://model.invalid',startedAt:1,endedAt:2,status:'failed',basis:'request',raw:null});
    retainStoppedFollowupReservations(task,f.store,new Set());assert.equal(budget.state().unknown,1);
    retainStoppedFollowupReservations(task,f.store,new Set(['old-request']));assert.equal(budget.state().unknown,0);assert.equal(budget.state().spent,spent);
    task.followup!.attempts=7;task.followup!.tokens=999;task.followup!.elapsedMs=456;nextAutonomousWindow(task);f.store.put(task);
    assert.equal(task.followup!.attempts,7);assert.equal(task.followup!.tokens,999);assert.equal(task.followup!.elapsedMs,456);assert.equal(autonomousWindowRemaining(task).attempts,task.followup!.policy.maxAttempts);assert.notEqual(followupRequestPolicy(task).key,policy.key);
    assert.equal(f.store.usage.entries(task.id).length,1);assert.equal(f.store.usage.entries(task.id)[0].tokens,null);assert.equal(budget.state().spent,spent);assert.equal(f.store.usage.summary(task.id).missing,1);
  }finally{f.close();}
});

test('missing usage does not prevent the worker from continuing the same followup account',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();f.store.scheduleFollowup(task,f.settings.followup);
    const budget=new RequestBudget(f.db,followupRequestPolicy(task));budget.reserve('ended',Buffer.from('{}'));budget.complete('ended',null);
    f.store.usage.record(task.id,{id:'ended',source:'codex',stage:'followup',model:'test',endpoint:'https://model.invalid',startedAt:1,endedAt:2,status:'failed',basis:'request',raw:null});
    const original=task.followup!.budgetId,spent=budget.state().spent;f.store.put(task);let calls=0;
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>{calls++;return action('interrupt');});
    await worker.tick();await settled(worker,task.id);
    assert.equal(calls,1);assert.equal(f.store.task(task.id)!.followup!.budgetId,original);assert.equal(budget.state().spent,spent);
    assert.equal(f.store.usage.summary(task.id).missing,1);assert.equal(budget.activeRequests(),0);
  }finally{await worker?.stop();f.close();}
});

test('an exhausted window cannot bypass an active historical request',async()=>{
  const f=fixture();let worker:AutomationWorker|undefined;
  try{
    const task=f.create();f.store.scheduleFollowup(task,f.settings.followup);const budget=new RequestBudget(f.db,followupRequestPolicy(task));budget.reserve('orphan',Buffer.from('{}'));
    task.followup!.attempts=task.followup!.policy.maxAttempts;task.followup!.tokens=task.followup!.policy.maxTokens;const original=task.followup!.budgetId;f.store.put(task);let calls=0;
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>{calls++;return action('wait');});await worker.tick();await settled(worker,task.id);
    const saved=f.store.task(task.id)!;assert.equal(calls,0);assert.equal(saved.status,'interrupted');assert.equal(saved.followup!.budgetId,original);assert.equal(saved.autonomy!.window.index,0);assert.equal(budget.state().unknown,1);
  }finally{await worker?.stop();f.close();}
});

function optimizationFixture(autonomous=true,hardMaxRounds?:number) {
  const f=fixture(),task=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'homepage',environmentId:'',requirements:'',optimization:{...defaultOptimizationPolicy,maxRounds:1}},f.settings)[0];
  if(autonomous)task.autonomy=createAutonomousExecution('Complete migration',{hardMaxRounds});f.attach(task);
  const report=(issues:string[]):AutomationReport=>({summary:'Independent observed report',quality:'failed',scores:[{viewport:'desktop',value:70},{viewport:'mobile',value:70}],assessments:task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:70,passed:true,reason:'Observed actual page',evidence:['actual.png']}))),issues:issues.map(title=>({title,severity:'major',detail:title,evidence:['actual.png']})),coverage:{verified:['homepage'],unverified:[],outOfScope:[]},artifacts:[]});
  const finish=(generation:AutomationTask,issues:string[])=>{generation.status='completed';generation.stopped=true;f.store.beginSiteChange(generation);f.store.put(generation);const evaluation=f.store.ensureEvaluation(generation,f.settings);evaluation.status='completed';evaluation.stopped=true;evaluation.report=report(issues);f.store.put(evaluation);return evaluation;};
  const repair=(message='Fix actual issue'):FollowupAction=>({action:'repair',reason:'Actual report evidence',evidence:['host-observation'],message,imageEvidence:['actual.png'],progress:{improved:true,reason:'Claim alone must not count',resolved:[],remaining:['issue'],unverified:[],introduced:[]}});
  const advance=()=>{const root=f.store.task(task.id)!;advanceOptimization(root,f.store,f.settings);return f.store.task(task.id)!;};
  return {...f,task,report,finish,repair,advance};
}

test('independent progress can continue beyond a soft round default; legacy and explicit hard caps still stop',()=>{
  for(const mode of ['soft','legacy','explicit'] as const){const f=optimizationFixture(mode!=='legacy',mode==='explicit'?1:undefined);try{
    f.finish(f.task,['a','b','c']);let root=f.advance();applyOptimizationAction(root,f.repair(),f.store,f.settings);root=f.store.task(f.task.id)!;
    const child=f.store.task(root.optimization!.activeTaskId)!;assert.equal(child.generation!.conversationId,'original-conversation');f.finish(child,['b','c']);root=f.advance();
    assert.equal(root.optimization!.state,mode==='soft'?'planning':'stopped');assert.equal(root.generatedSiteId,f.task.generatedSiteId);
    if(mode==='soft'){applyOptimizationAction(root,f.repair('Fix remaining b'),f.store,f.settings);assert.equal(f.store.task(f.task.id)!.optimization!.rounds.length,3);assert.equal(f.store.task(f.task.id)!.optimization!.noImprovement,0);}
  }finally{f.close();}}
});

test('two unchanged repairs enter finite diagnosis instead of trusting improved=true forever',()=>{
  const f=optimizationFixture();try{
    f.finish(f.task,['same major issue']);let root=f.advance();applyOptimizationAction(root,f.repair('method A'),f.store,f.settings);
    for(let i=1;i<=2;i++){root=f.store.task(f.task.id)!;f.finish(f.store.task(root.optimization!.activeTaskId)!,['same major issue']);root=f.advance();applyOptimizationAction(root,f.repair('method '+String.fromCharCode(65+i)),f.store,f.settings);}
    root=f.store.task(f.task.id)!;assert.equal(root.optimization!.state,'planning');assert.equal(root.autonomy!.checkpoint.diagnosticRequired,true);assert.equal(root.optimization!.noImprovement,2);
    applyOptimizationAction(root,f.repair('method C'),f.store,f.settings);assert.equal(f.store.task(f.task.id)!.optimization!.state,'stopped');assert.match(f.store.task(f.task.id)!.optimization!.reason,/已失败的相同修复路径/);
  }finally{f.close();}
});

test('a different diagnosed repair can run, but repeated independent failure exhausts finite diagnosis',()=>{
  const f=optimizationFixture();try{
    f.finish(f.task,['same major issue']);let root=f.advance();applyOptimizationAction(root,f.repair('method A'),f.store,f.settings);
    for(let i=1;i<=2;i++){root=f.store.task(f.task.id)!;f.finish(f.store.task(root.optimization!.activeTaskId)!,['same major issue']);root=f.advance();applyOptimizationAction(root,f.repair('method '+String.fromCharCode(65+i)),f.store,f.settings);}
    root=f.store.task(f.task.id)!;applyOptimizationAction(root,f.repair('diagnosed method D'),f.store,f.settings);root=f.store.task(f.task.id)!;assert.equal(root.optimization!.state,'repairing');assert.equal(root.optimization!.rounds.length,4);
    f.finish(f.store.task(root.optimization!.activeTaskId)!,['same major issue']);root=f.advance();applyOptimizationAction(root,f.repair('diagnosed method E'),f.store,f.settings);root=f.store.task(f.task.id)!;assert.equal(root.optimization!.state,'stopped');assert.match(root.optimization!.reason,/有限诊断与换策后仍无实质改善/);
  }finally{f.close();}
});

test('missing fees remain recorded without blocking approximate cost limits across windows',()=>{
  const f=optimizationFixture();try{
    f.task.autonomy!.policy.hardCostCny=1;f.store.put(f.task);f.store.usage.record(f.task.id,{id:'missing-cost',source:'codex',stage:'followup',model:'test',endpoint:'https://model.invalid',startedAt:1,endedAt:2,status:'failed',basis:'request',raw:null});
    assert.equal(optimizationBudgetReason(f.task,f.store),'');
    delete f.task.autonomy!.policy.hardCostCny;f.store.put(f.task);assert.equal(optimizationBudgetReason(f.task,f.store),'');assert.equal(f.store.usage.summary(f.task.id).missing,1);
  }finally{f.close();}
});
