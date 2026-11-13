import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ThreadEvent } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, type AutomationTask, type FollowupAction } from '../shared/automation.js';
import { AutomationWorker, type Execute } from '../server/automation/worker.js';
import { executeFollowup, validateFollowupAction, type FollowupExecute, type RecoveryInspection } from '../server/automation/followup.js';
import { httpRead, probeSite, siteIdentity, summarizeMessages } from '../server/automation/kooboo.js';
import { executeGeneration } from '../server/automation/generator.js';
import { codexClient, recoverEvaluationSession, reviewWithValidation } from '../server/automation/evaluator.js';
import { applyGenerationObservation, type GenerationObservation } from '../server/automation/generation-session.js';
import { FollowupRuntimeError, UnconfirmedStop } from '../server/automation/errors.js';
import { createAutonomousExecution } from '../shared/autonomy.js';
import { followupRequestPolicy } from '../server/automation/autonomy.js';
import { ModelBudgetExceeded, RequestBudget } from '../server/automation/request-budget.js';
import { rememberSiteRetry, siteRetryBlocked } from '../server/automation/retry-guard.js';

const input={name:'Sample',scenario:'site-template' as const,description:'Build homepage',contentUrl:'https://content.test',referenceUrl:'',externalSource:'',externalId:'',files:[]};
const decision=(action:FollowupAction['action'],extra:Partial<FollowupAction>={}):FollowupAction=>({action,reason:'已依据实际证据决定下一步',evidence:['observed'],...extra});
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'followup-test-'));
  const services=await createApp({directory,serveWeb:false,startWorker:false});
  const login=await services.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]},environmentId=randomUUID();
  const settings=structuredClone({...defaultAutomationSettings,enabled:true,generationConcurrency:1,evaluationConcurrency:1});
  services.vault.update({threshold:80,paused:true,execution:{timeoutSeconds:300,captureAttempts:2},model:{endpoint:'https://model.test/v1',name:'test',apiKey:'test-only-key'},environments:[{id:environmentId,name:'Test',origin:'https://kooboo.test',apiOrigin:'https://kooboo.test',token:'test-only-token'}]});
  services.vault.updateAutomation(settings);
  const resource=services.automationStore.saveResource(input);
  const create=(kind:'generation'|'evaluation'='generation',siteId?:string)=>services.automationStore.create({resourceIds:[resource.id],kind,scope:'homepage',environmentId,generatedSiteId:siteId,requirements:''},settings)[0];
  const attach=(task:AutomationTask)=>{
    const site={id:randomUUID(),resourceId:resource.id,versionId:task.versionId,environmentId,siteId:randomUUID(),name:'Existing result',url:'https://generated.test',createdAt:Date.now()};
    services.automationStore.saveSite(site);task.generatedSiteId=site.id;task.siteUrl=site.url;task.generation={prepared:true,conversationId:randomUUID(),deliveryId:randomUUID(),deliveryState:'accepted'};services.automationStore.put(task);return site;
  };
  return {...services,directory,headers,settings,resource,environmentId,create,attach,async close(){await services.app.close();rmSync(directory,{recursive:true,force:true});}};
}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error('state did not settle');await new Promise(r=>setTimeout(r,5));}}
const idle:Execute=async()=>{};

test('followup may pass five minutes but still stops at its original cumulative remaining time',async(context)=>{
  const f=await fixture();let worker:AutomationWorker|undefined,signal:AbortSignal|undefined;
  try{
    const task=f.create();task.learningPolicy={...task.learningPolicy!,use:false,collect:false};
    f.automationStore.scheduleFollowup(task,{...f.settings.followup,maxMinutes:20});task.followup!.elapsedMs=2*60000;task.followup!.tokens=123;f.automationStore.put(task);
    context.mock.timers.enable({apis:['setTimeout']});
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async(_task,_store,_vault,_directory,activeSignal)=>{
      signal=activeSignal;return await new Promise<FollowupAction>((_resolve,reject)=>{activeSignal.addEventListener('abort',()=>reject(activeSignal.reason),{once:true});});
    });
    await worker.tick();await new Promise<void>(done=>setImmediate(done));assert.ok(signal);
    context.mock.timers.tick(6*60000);assert.equal(signal.aborted,false,'an undocumented five-minute cutoff must not restart the analysis');
    context.mock.timers.tick(12*60000);assert.equal(signal.aborted,true);assert.match(signal.reason.message,/累计时间预算/);
    await new Promise<void>(done=>setImmediate(done));const saved=f.automationStore.task(task.id)!;assert.equal(saved.followup!.policy.maxMinutes,20);assert.equal(saved.followup!.tokens,123);assert.equal(saved.followup!.attempts,1);
  }finally{context.mock.timers.reset();if(worker)await worker.stop();await f.close();}
});

test('evaluation validation returns all missing screenshot roles to the same model session and bounds repairs',async()=>{
  const f=await fixture();
  try{
    const parent=f.create(),site=f.attach(parent),task=f.create('evaluation',site.id);
    const files=(['desktop','mobile'] as const).flatMap(viewport=>(['target','reference'] as const).map(role=>({id:randomUUID(),name:`${role}-${viewport}.png`,type:'image/png',size:1,sha256:'a'.repeat(64),role,viewport})));
    const valid={summary:'真实证据支撑的结果',assessments:task.rule!.criteria.filter(c=>c.scopes.includes(task.scope)).flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:80,passed:true,reason:'已比对对应画面',evidence:[`target-${viewport}.png`,`reference-${viewport}.png`]}))),issues:[],coverage:{verified:['homepage'],unverified:[],outOfScope:[]}};
    const invalid=structuredClone(valid);for(const row of invalid.assessments)if(row.criterionId==='structure')row.evidence=row.evidence.filter(name=>name.startsWith('target'));
    const prompts:string[]=[],repairs:string[]=[];
    const report=await reviewWithValidation({prompt:'初次评测',task,files:()=>files,threshold:80,referenceRequired:true,onRepair:message=>{repairs.push(message);},run:async prompt=>{prompts.push(prompt);return JSON.stringify(prompts.length===1?invalid:valid);}});
    assert.equal(prompts.length,2);assert.equal(repairs.length,1);assert.match(prompts[1],/structure \/ desktop 缺少 reference PNG/);assert.match(prompts[1],/structure \/ mobile 缺少 reference PNG/);assert.match(prompts[1],/evidence-manifest\.json/);assert.match(prompts[1],/不修改站点/);assert.equal(report.quality,'passed');assert.deepEqual(report.assessments,valid.assessments);
    let calls=0,feedback=0;
    await assert.rejects(()=>reviewWithValidation({prompt:'retry',task,files:()=>files,threshold:80,referenceRequired:true,onRepair:()=>{feedback++;},run:async()=>{calls++;return JSON.stringify(invalid);}}),/structure \/ desktop.*structure \/ mobile/);
    assert.equal(calls,3);assert.equal(feedback,2);assert.equal(task.report,null);
  }finally{await f.close();}
});

test('Kooboo inspection preserves the independent evaluation thread and context',async()=>{
  const f=await fixture();
  try{
    const parent=f.create(),site=f.attach(parent),evaluation=f.create('evaluation',site.id);
    const state:GenerationObservation={version:1,taskId:evaluation.id,siteId:site.siteId,conversationId:'kooboo-chat',runId:'kooboo-run',ready:true,running:false,state:'completed',observedAt:Date.now(),pending:null,context:['Kooboo context']};
    evaluation.threadId='codex-evaluation';evaluation.context='evaluation context';
    applyGenerationObservation(evaluation,state);
    assert.equal(evaluation.threadId,'codex-evaluation');assert.equal(evaluation.context,'evaluation context');
    assert.equal(evaluation.generation?.conversationId,'kooboo-chat');assert.equal(evaluation.generation?.runId,'kooboo-run');
    applyGenerationObservation(parent,{...state,taskId:parent.id,conversationId:parent.generation!.conversationId!});
    assert.equal(parent.threadId,parent.generation!.conversationId);assert.equal(parent.context,JSON.stringify(state.context));
  }finally{await f.close();}
});

test('unresumable evaluation sessions release only their thread and retain evidence, site and frozen rules',async()=>{
  const f=await fixture();
  try{
    const parent=f.create(),site=f.attach(parent),task=f.create('evaluation',site.id);
    task.threadId='old-evaluation-thread';task.artifacts=[{id:randomUUID(),name:'retained.png',type:'image/png',size:1,sha256:'a'.repeat(64)}];
    const before=structuredClone(task);
    for(const message of ['unexpected status 413 Payload Too Large: Unknown error','Error: thread/resume failed: no rollout found for thread id old-evaluation-thread (code -32600)','context_length_exceeded']){
      task.threadId='old-evaluation-thread';assert.equal(recoverEvaluationSession(task,f.automationStore,new Error(message)),true);
      const saved=f.automationStore.task(task.id)!;assert.equal(saved.threadId,'');assert.deepEqual(saved.artifacts,before.artifacts);assert.equal(saved.generatedSiteId,site.id);assert.deepEqual(saved.rule,before.rule);assert.equal(saved.versionId,before.versionId);
    }
    task.threadId='working-thread';assert.equal(recoverEvaluationSession(task,f.automationStore,new Error('temporary network timeout')),false);assert.equal(task.threadId,'working-thread');
    parent.threadId='kooboo-chat';assert.equal(recoverEvaluationSession(parent,f.automationStore,new Error('413 Payload Too Large')),false);assert.equal(parent.threadId,'kooboo-chat');
  }finally{await f.close();}
});

test('transient generation failure is followed by AI retry and exactly one evaluation with original input/rule',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create();let generation=0,evaluation=0,follows=0;
    const execute:Execute=async(task)=>{generation++;if(!task.generatedSiteId)f.attach(task);if(generation===1)throw new Error('temporary disconnect');};
    const follow:FollowupExecute=async(task)=>{follows++;task.followup!.tokens+=123;return decision('retry');};
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:execute,evaluation:async()=>{evaluation++;}},()=>true,follow);
    await worker.tick();await until(()=>f.automationStore.tasks().some(t=>t.kind==='evaluation'&&t.status==='completed'));
    assert.equal(generation,2);assert.equal(evaluation,1);assert.equal(follows,1);
    const done=f.automationStore.task(t.id)!,child=f.automationStore.task(done.evaluationTaskId!)!;
    assert.equal(done.status,'completed');assert.equal(done.followup?.tokens,123);assert.equal(done.followup?.attempts,1);
    assert.equal(child.versionId,t.versionId);assert.equal(child.scope,t.scope);assert.deepEqual(child.rule,t.rule);assert.equal(child.generatedSiteId,done.generatedSiteId);
    f.automationStore.ensureEvaluation(done,f.settings);assert.equal(f.automationStore.tasks().filter(x=>x.kind==='evaluation').length,1);
    assert.equal(f.automationStore.notices().at(0)?.title,'评测报告已完成');
  }finally{if(worker)await worker.stop();await f.close();}
});

test('AI continue and answer queue the same generation task and retain target, scope and input version',async()=>{
  for(const action of [decision('continue',{message:'在已完成内容上收尾'}),decision('answer',{answer:{choice:'continue'},callId:'call-1'})]){
    const f=await fixture();let worker:AutomationWorker|undefined;
    try{
      const t=f.create(),site=f.attach(t);f.automationStore.scheduleFollowup(t,f.settings.followup);
      let observed:AutomationTask|undefined;
      worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:async task=>{observed=structuredClone(task);},evaluation:idle},()=>true,async()=>action);
      await worker.tick();await until(()=>!!observed);
      assert.equal(observed!.id,t.id);assert.equal(observed!.generatedSiteId,site.id);assert.equal(observed!.versionId,t.versionId);assert.equal(observed!.scope,'homepage');assert.deepEqual(observed!.generation?.next,action);
    }finally{if(worker)await worker.stop();await f.close();}
  }
});

test('handoff recovery skips generation and uses the frozen rule even after a new rule is published',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create();f.attach(t);t.stage='handoff';f.automationStore.scheduleFollowup(t,f.settings.followup);
    const {id,hash,createdAt,...base}=t.rule!;f.automationStore.publish({...base,name:'new revision'});
    let generated=0;
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:async()=>{generated++;},evaluation:idle},()=>true,async()=>decision('evaluate'));
    await worker.tick();await until(()=>f.automationStore.tasks().some(x=>x.kind==='evaluation'&&x.status==='completed'));
    const children=f.automationStore.tasks().filter(x=>x.kind==='evaluation');assert.equal(generated,0);assert.equal(children.length,1);assert.equal(children[0].rule?.id,t.rule?.id);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('evaluation retry retains original evidence and thread, without generating a site',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const parent=f.create(),site=f.attach(parent),t=f.create('evaluation',site.id);let evaluation=0,generated=0;
    const artifact={id:randomUUID(),name:'evidence.png',type:'image/png',size:8,sha256:'a'.repeat(64)};
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:async()=>{generated++;},evaluation:async task=>{evaluation++;if(evaluation===1){task.artifacts=[artifact];task.threadId='eval-thread';throw new Error('collector interrupted');}assert.deepEqual(task.artifacts,[artifact]);assert.equal(task.threadId,'eval-thread');}},()=>true,async()=>decision('retry'));
    parent.status='cancelled';f.automationStore.put(parent);
    await worker.tick();await until(()=>f.automationStore.task(t.id)?.status==='completed');assert.equal(evaluation,2);assert.equal(generated,0);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('AI interruption persists reason, attempts, next steps and a renewable unread notice',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create();f.automationStore.scheduleFollowup(t,f.settings.followup);
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>decision('interrupt',{reason:'内容站已经不可访问',nextSteps:['恢复内容站访问或更新地址后重新接管']}));
    await worker.tick();await until(()=>f.automationStore.task(t.id)?.status==='interrupted');
    const done=f.automationStore.task(t.id)!;assert.equal(done.stopped,true);assert.match(done.interruption!.reason,/内容站/);assert.ok(done.interruption?.resumeFrom);assert.equal(done.followup?.attempts,1);
    const notice=f.automationStore.notices()[0];f.automationStore.readNotice(notice.id);f.automationStore.notice(done,'任务已中断','第二次原因');assert.equal(f.automationStore.notices().length,1);assert.equal(f.automationStore.notices()[0].readAt,null);assert.notEqual(f.automationStore.notices()[0].id,notice.id);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('AI wait retains site reservation and token/attempt/time budgets produce an explicit interruption',async()=>{
  for(const budget of ['attempts','tokens','time']){
    const f=await fixture();let worker:AutomationWorker|undefined;
    try{
      const t=f.create(),site=f.attach(t);const policy={...f.settings.followup,maxAttempts:budget==='attempts'?1:5};f.automationStore.scheduleFollowup(t,policy);
      let follows=0;
      worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async task=>{follows++;if(budget==='tokens')task.followup!.tokens=policy.maxTokens;return decision('wait',{waitSeconds:60});});
      await worker.tick();await until(()=>f.automationStore.task(t.id)?.followup?.state==='waiting');
      const waiting=f.automationStore.task(t.id)!;assert.equal(waiting.stopped,true);f.create('evaluation',site.id);assert.equal(f.automationStore.claim('evaluation',1),undefined);
      waiting.followup!.nextAt=0;if(budget==='time')waiting.followup!.elapsedMs=policy.maxMinutes*60000+1;f.automationStore.put(waiting);
      await worker.tick();await until(()=>f.automationStore.task(t.id)?.status==='interrupted');assert.equal(follows,1);assert.match(f.automationStore.task(t.id)!.error,/预算/);
    }finally{if(worker)await worker.stop();await f.close();}
  }
});

test('cancellation while Agent is deciding cannot requeue the task',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create();f.automationStore.scheduleFollowup(t,f.settings.followup);let release:((a:FollowupAction)=>void)|undefined;
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>new Promise(r=>release=r));
    await worker.tick();await until(()=>!!release);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/cancel`,headers:f.headers})).statusCode,409,'fixture API worker does not own separate test worker');
    const current=f.automationStore.task(t.id)!;current.status='cancelling';f.automationStore.put(current);worker.cancel(t.id);release!(decision('retry'));
    await until(()=>f.automationStore.task(t.id)?.status==='cancelled');assert.equal(f.automationStore.task(t.id)?.stopped,true);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('unknown execution stop cannot unlock the site, and followup cleanup uncertainty stays interrupted',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create(),site=f.attach(t);t.stopped=false;f.automationStore.scheduleFollowup(t,f.settings.followup);
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,async()=>{throw new UnconfirmedStop('browser still owned');});
    await worker.tick();await until(()=>f.automationStore.task(t.id)?.status==='interrupted');assert.equal(f.automationStore.task(t.id)?.stopped,false);
    f.create('evaluation',site.id);assert.equal(f.automationStore.claim('evaluation',1),undefined);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/resume`,headers:f.headers})).statusCode,409);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/confirm-stopped`,headers:f.headers})).statusCode,200);
    const resumed=await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/resume`,headers:f.headers});assert.equal(resumed.statusCode,200);assert.equal(resumed.json().id,t.id);assert.equal(resumed.json().versionId,t.versionId);assert.equal(resumed.json().generatedSiteId,site.id);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('old settings get followup defaults and report tokens cannot modify notices or resume',async()=>{
  const f=await fixture();try{
    const {followup,...old}=f.settings;
    assert.equal((await f.app.inject({method:'PUT',url:'/api/automation/settings',headers:f.headers,payload:old})).statusCode,200);assert.deepEqual(f.vault.automation().followup,defaultAutomationSettings.followup);
    const t=f.create();f.automationStore.notice(t,'test','test');const headers={authorization:`Bearer ${f.vault.credentials.readToken}`};
    for(const url of [`/api/automation/notifications/${f.automationStore.notices()[0].id}/read`,`/api/automation/tasks/${t.id}/resume`])assert.equal((await f.app.inject({method:'POST',url,headers})).statusCode,401);
    t.context='old history';t.threadId='original-conversation';f.attach(t);delete t.generation;f.automationStore.scheduleFollowup(t,f.settings.followup);const recovered=f.automationStore.task(t.id)!;assert.equal(recovered.generation?.legacySubmitted,true);assert.equal(recovered.generation?.conversationId,'original-conversation');
  }finally{await f.close();}
});

test('host validation rejects invented evidence, uncertain sends, wrong phases, pending calls and missing readiness',async()=>{
  const f=await fixture();try{
    const t=f.create();f.attach(t);f.automationStore.scheduleFollowup(t,f.settings.followup);const evidence=new Set(['observed']);
    const validate=(a:FollowupAction,inspection:RecoveryInspection={})=>validateFollowupAction(a,t,inspection,evidence);
    assert.throws(()=>validate({...decision('retry'),evidence:['invented']}),/不存在/);
    t.followup!.executionStopped=false;assert.throws(()=>validate(decision('retry')),/停止/);t.followup!.executionStopped=true;
    assert.throws(()=>validate(decision('interrupt')),/下一步/);assert.throws(()=>validate(decision('evaluate')),/probe_site/);
    assert.throws(()=>validate(decision('evaluate'),{siteReady:true}),/交付/);
    const execution={version:1,taskId:t.id,siteId:'site',conversationId:t.generation!.conversationId!,runId:'run',ready:true,running:false,state:'waiting',observedAt:Date.now(),pending:null,context:[]};
    assert.equal(validate(decision('continue',{message:'continue'}),{execution}).action,'continue');
    execution.pending={callId:'call',name:'ask_user_input',args:{}} as any;
    assert.throws(()=>validate(decision('continue',{message:'continue'}),{execution}),/answer/);
    assert.throws(()=>validate(decision('answer',{callId:'other',answer:{choice:'a'}}),{execution}),/当前待输入/);
    assert.equal(validate(decision('answer',{callId:'call',answer:{choice:'a'}}),{execution}).action,'answer');
    assert.equal(validate(decision('interrupt',{reason:'参考站 Sandbox 与外部截图均失败，等待用户上传参考截图或刷新重试',nextSteps:['在 Kooboo 会话上传参考站截图或检查截图服务后恢复任务']}),{execution}).action,'interrupt');
    execution.pending={callId:'call',name:'ask_user_input',args:{kind:'upload',upload:{target:'mediaLibrary'}}} as any;
    assert.throws(()=>validate(decision('answer',{callId:'call',answer:{value:[]}}),{execution}),/kind=upload.*interrupt/);
    assert.equal(validate(decision('interrupt',{reason:'需用户手动上传参考站截图',nextSteps:['上传参考站截图至媒体库后恢复任务']}),{execution}).action,'interrupt');
    execution.pending={callId:'call',name:'ask_user_input',args:{}} as any;
    t.generation!.deliveryState='sending';assert.throws(()=>validate(decision('answer',{callId:'call',answer:{}}),{execution}),/不确定/);
    t.kind='evaluation';assert.throws(()=>validate(decision('continue',{message:'edit'}),{execution}),/不能直接改站/);assert.equal(validate(decision('retry')).action,'retry');
  }finally{await f.close();}
});

test('retry of a confirmed failed delivery becomes a new same-conversation delivery, while uncertain executions cannot be replayed',async()=>{
  const f=await fixture();try{
    const task=f.create(),site=f.attach(task);f.automationStore.scheduleFollowup(task,f.settings.followup);
    const runId=randomUUID();task.generation!.runId=runId;task.generation!.state='failed';
    const state:GenerationObservation={version:1,taskId:task.id,siteId:site.siteId,conversationId:task.generation!.conversationId!,runId,ready:true,running:false,state:'failed',observedAt:Date.now(),pending:null,context:[{role:'assistant',text:'Insufficient Balance'}],delivery:{id:task.generation!.deliveryId!,state:'accepted',conversationId:task.generation!.conversationId!},outcome:{conversationId:task.generation!.conversationId!,runId,status:'failed',time:Date.now()-3600000}};
    const retry=decision('retry',{reason:'用户已确认充值完成，重新执行未完成的原任务'});
    const validate=(execution?:GenerationObservation)=>validateFollowupAction(retry,task,{execution},new Set(['observed']));
    assert.throws(()=>validate(),/inspect_execution/);
    assert.throws(()=>validate({...state,running:true}),/仍在执行/);
    assert.throws(()=>validate({...state,pending:{callId:'call',name:'ask_user',args:{}}}),/answer/);
    for(const invalid of [
      {...state,outcome:undefined},
      {...state,runId:randomUUID()},
      {...state,taskId:randomUUID()},
      {...state,delivery:{...state.delivery!,id:randomUUID()}},
      {...state,outcome:{...state.outcome!,conversationId:randomUUID()}},
    ])assert.throws(()=>validate(invalid),/不匹配/);
    const before=structuredClone(task),action=validate(state);
    assert.equal(action.action,'continue');assert.match(action.message!,/充值完成/);
    assert.deepEqual(action.retryOf,{deliveryId:task.generation!.deliveryId,runId});assert.deepEqual(task,before);
    assert.equal(validate({...state,state:'interrupted',outcome:{...state.outcome!,status:'interrupted'}}).action,'continue');
    task.generation!.deliveryState='sending';
    assert.throws(()=>validate({...state,delivery:undefined}),/不确定/);
    assert.equal(validate(state).action,'continue','an accepted matching receipt resolves the sending uncertainty');
  }finally{await f.close();}
});

test('manual resume clears the historical retry guard and retains the original execution and budgets',async()=>{
  const f=await fixture();try{
    const task=f.create();f.attach(task);task.generation!.runId=randomUUID();task.generation!.state='failed';task.error='旧失败';
    f.automationStore.scheduleFollowup(task,f.settings.followup);task.followup!.attempts=2;task.followup!.tokens=123;
    task.status='interrupted';task.stopped=true;f.automationStore.put(task);rememberSiteRetry(task,f.automationStore);
    assert.equal(siteRetryBlocked(task,f.automationStore),true);
    const response=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/resume`,headers:f.headers});
    assert.equal(response.statusCode,200);const saved=f.automationStore.task(task.id)!;
    assert.equal(saved.status,'following-up');assert.equal(siteRetryBlocked(saved,f.automationStore),false);
    assert.deepEqual(saved.generation,task.generation);assert.equal(saved.followup!.attempts,2);assert.equal(saved.followup!.tokens,123);
  }finally{await f.close();}
});

test('site identity and conversation summaries handle Kooboo contracts without embedding image payloads',()=>{
  assert.equal(siteIdentity({siteId:'actual',id:'wrong'}),'actual');assert.equal(siteIdentity({SiteId:'upper'}),'upper');
  const summary=summarizeMessages([{role:'assistant',contents:[{$type:'functionCall',callId:'one',name:'ask_user_input',arguments:{x:1}},{$type:'image',url:'data:image/png;base64,PRIVATE_PIXELS'}]},{role:'tool',contents:[{$type:'functionResult',callId:'one',result:'ok'}]},{role:'assistant',contents:[{$type:'text',text:'Homepage complete'}]}]);
  assert.deepEqual(summary.pendingCalls,[]);assert.equal(summary.finalText,'Homepage complete');assert.ok(!JSON.stringify(summary).includes('PRIVATE_PIXELS'));
});

test('native HTTP helper reads JSON and readiness redirects without sending credentials',async()=>{
  const server=createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);if(req.url==='/redirect'){res.writeHead(302,{Location:'/ok'});res.end();}else if(req.url==='/missing'){res.writeHead(404);res.end();}else{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number},origin=`http://127.0.0.1:${address.port}`;
  try{const response=await httpRead(new URL('/ok',origin),{signal:AbortSignal.timeout(1000)});assert.deepEqual(JSON.parse(response.body),{ok:true});assert.equal((await probeSite(origin+'/redirect',AbortSignal.timeout(1000))).url,origin+'/ok');await assert.rejects(()=>probeSite(origin+'/missing',AbortSignal.timeout(1000)),/404/);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});


test('followup harness executes the generated helper, validates real observations and persists session usage',async()=>{
  const f=await fixture();try{
    const t=f.create();f.automationStore.event(t.id,'历史工具故障：connect EPERM 127.0.0.1:54321');f.automationStore.scheduleFollowup(t,f.settings.followup);let env:Record<string,string>={};
    const run=async(payload:unknown)=>{try{return JSON.parse((await promisify(execFile)(process.execPath,[join(f.directory,'followup-runs',t.id,'tools.mjs'),JSON.stringify(payload)],{env:{...process.env,...env}})).stdout);}catch(error){const stdout=(error as {stdout?:string}).stdout;if(stdout)throw new Error(JSON.parse(stdout).error);throw error;}};
    const stream=async function*():AsyncGenerator<ThreadEvent>{
      yield {type:'thread.started',thread_id:'followup-session'};
      const unauth=await fetch(env.FOLLOWUP_TOOLS_URL,{method:'POST',body:'{}'});assert.equal(unauth.status,401);
      const observation=await run({tool:'get_task'});assert.equal(observation.result.task.id,t.id);assert.ok(observation.evidenceId);
      const historical=JSON.stringify(observation);assert.match(historical,/connect EPERM/);
      yield {type:'item.completed',item:{id:'successful-observation',type:'command_execution',status:'completed',exit_code:0,command:"node tools.mjs '{\"tool\":\"get_task\"}'",aggregated_output:historical}};
      yield {type:'item.completed',item:{id:'business-error-with-history',type:'command_execution',status:'failed',exit_code:1,command:"node tools.mjs '{\"tool\":\"act\"}'",aggregated_output:JSON.stringify({error:'行动尚未通过校验',history:observation})}};
      await assert.rejects(()=>run({tool:'act',decision:decision('retry',{evidence:['fabricated']})}),/不存在/);
      const action=decision('interrupt',{evidence:[observation.evidenceId],nextSteps:['修正输入后恢复']});
      const accepted=await run({tool:'act',decision:action});assert.equal(accepted.accepted,true);
      assert.equal((await run({tool:'act',decision:action})).accepted,true);
      await assert.rejects(()=>run({tool:'act',decision:{...action,reason:'changed'}}),/已经提交/);
      yield {type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:10,cache_write_input_tokens:0,reasoning_output_tokens:0,output_tokens:5}};
    };
    const thread={runStreamed:async()=>({events:stream()})};
    const action=await executeFollowup(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(10000),(_vault,_dir,extra)=>{env=extra;return {startThread:options=>{assert.equal(options.sandboxMode,'workspace-write');assert.equal(options.networkAccessEnabled,true);return thread;},resumeThread:()=>thread};});
    assert.equal(action.action,'interrupt');const saved=f.automationStore.task(t.id)!;assert.equal(saved.followup?.threadId,'followup-session');assert.equal(saved.followup?.tokens,25);assert.equal(saved.followup?.observations.length,1);
    assert.ok(!JSON.stringify(f.automationStore.events(t.id)).includes(env.FOLLOWUP_TOOLS_TOKEN));
    await assert.rejects(()=>fetch(env.FOLLOWUP_TOOLS_URL,{signal:AbortSignal.timeout(1000)}));
  }finally{await f.close();}
});

test('accepted actions survive relay disconnects while cancellation, timeout and model budgets still stop dispatch',async()=>{
  for(const mode of ['disconnect','disconnect-stream-failed','cleanup-disconnect','no-action','cancel-before','cancel-after','timeout-after','persisted-cancel-after','persisted-cancelled-after','budget-before','budget-after','thrown-budget'] as const){
    const f=await fixture(),controller=new AbortController();let env:Record<string,string>={},chosen:FollowupAction|undefined;
    const disconnect=['disconnect','disconnect-stream-failed','cleanup-disconnect','no-action'].includes(mode);
    const upstream=createServer(async(req,res)=>{
      for await(const _chunk of req){};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      if(disconnect)res.write('data: '+JSON.stringify({type:'response.created',response:{id:'incomplete'}})+'\n\n');
      else res.end('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:20,output_tokens:5}}})+'\n\n');
    });
    await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
    try{
      f.vault.updateAutomation({...f.settings,evaluationEndpoint:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`});
      const task=f.create();task.autonomy=createAutonomousExecution('Synthetic followup');f.automationStore.put(task);
      f.automationStore.scheduleFollowup(task,{...f.settings.followup,maxRequests:1});
      const run=async(payload:unknown)=>{
        try{return JSON.parse((await promisify(execFile)(process.execPath,[join(f.directory,'followup-runs',task.id,'tools.mjs'),JSON.stringify(payload)],{env:{...process.env,...env}})).stdout);}
        catch(error){const stdout=(error as {stdout?:string}).stdout;if(stdout)throw new Error(JSON.parse(stdout).error);throw error;}
      };
      const request=()=>fetch(env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers:{Authorization:'Bearer '+env.EVALUATOR_MODEL_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'test',input:'Synthetic followup request'})});
      const stream=async function*():AsyncGenerator<ThreadEvent>{
        const response=await request();assert.equal(response.status,200);
        const reader=disconnect?response.body!.getReader():undefined;
        if(reader)await reader.read();else await response.text();
        const seen=await run({tool:'get_task'});
        chosen=decision('interrupt',{evidence:[seen.evidenceId],nextSteps:['Inspect synthetic result']});
        if(mode==='cancel-before')controller.abort(new Error('任务已请求取消'));
        if(mode==='budget-before'){const denied=await request();assert.equal(denied.status,429);await denied.text();}
        if(['cancel-before','budget-before'].includes(mode)){
          await assert.rejects(()=>run({tool:'act',decision:chosen}),/取消|请求次数上限/);
        }else if(mode!=='no-action')assert.equal((await run({tool:'act',decision:chosen})).accepted,true);
        if(mode==='cancel-after')controller.abort(new Error('任务已请求取消'));
        if(mode==='timeout-after')controller.abort(new Error('AI 跟进达到本轮时间预算'));
        if(mode==='persisted-cancel-after'){const current=f.automationStore.task(task.id)!;current.status='cancelling';f.automationStore.put(current);}
        if(mode==='persisted-cancelled-after'){const current=f.automationStore.task(task.id)!;current.status='cancelled';f.automationStore.put(current);return;}
        if(mode==='budget-after'){
          const denied=await request();assert.equal(denied.status,429);await denied.text();
          await assert.rejects(()=>run({tool:'act',decision:chosen}),/请求次数上限/);
        }
        if(reader&&mode!=='cleanup-disconnect'){
          await reader.cancel();await until(()=>f.automationStore.usage.entries(task.id)[0]?.status==='failed');
        }
        if(mode==='disconnect-stream-failed')throw new Error('SDK stream ended after accepting action');
        if(mode==='thrown-budget')throw new ModelBudgetExceeded('Synthetic model budget stop');
        yield {type:'turn.completed',usage:{input_tokens:999,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0,output_tokens:999}};
      };
      const thread={runStreamed:async()=>({events:stream()})};
      const result=executeFollowup(task,f.automationStore,f.vault,f.directory,controller.signal,(_v,_d,extra)=>{env=extra;return {startThread:()=>thread,resumeThread:()=>thread};});
      if(['disconnect','disconnect-stream-failed','cleanup-disconnect'].includes(mode))assert.deepEqual(await result,chosen,mode);
      else if(mode==='no-action')await assert.rejects(()=>result,/SDK 已关闭模型连接/);
      else if(mode.startsWith('budget')||mode==='thrown-budget')await assert.rejects(()=>result,ModelBudgetExceeded);
      else await assert.rejects(()=>result,/取消|时间预算/);
      assert.deepEqual(f.automationStore.task(task.id)!.followup!.lastAction,['cancel-before','budget-before','no-action'].includes(mode)?undefined:chosen,mode);
      if(mode==='persisted-cancelled-after')assert.equal(f.automationStore.task(task.id)!.status,'cancelled');
      const entries=f.automationStore.usage.entries(task.id);assert.equal(entries.length,1,'SDK totals must not replace relay accounting');
      if(disconnect){
        assert.equal(entries[0].tokens,null);assert.equal(task.followup!.tokens,0);assert.match(entries[0].note,/预占保留/);
        const budget=new RequestBudget(f.automationStore.db,followupRequestPolicy(task));assert.ok(budget.state().spent>0);
        assert.equal(f.automationStore.db.prepare('SELECT state FROM auto_model_requests WHERE account_id=?').get(budget.policy.key)!.state,'retained');
      }else assert.equal(task.followup!.tokens,25);
    }finally{upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));await f.close();}
  }
});

test('loopback permission denial is a runtime failure and never spends the remaining followup attempts',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;
  try{
    const t=f.create();f.automationStore.scheduleFollowup(t,f.settings.followup);let attempts=0;
    const follow:FollowupExecute=async(task,store,vault,directory,signal)=>{
      attempts++;let env:Record<string,string>={};
      const stream=async function*():AsyncGenerator<ThreadEvent>{
        yield {type:'thread.started',thread_id:'blocked-session'};
        yield {type:'item.completed',item:{id:'denied-tool',type:'command_execution',status:'failed',exit_code:1,command:"node tools.mjs '{\"tool\":\"get_task\"}'",aggregated_output:JSON.stringify({kind:'followup_tool_transport_error',code:'EPERM',hostname:'127.0.0.1',detail:env.FOLLOWUP_TOOLS_TOKEN})}};
      };
      const thread={runStreamed:async()=>({events:stream()})};
      try{return await executeFollowup(task,store,vault,directory,signal,(_v,_d,extra)=>{env=extra;return {startThread:()=>thread,resumeThread:()=>thread};});}
      catch(error){assert.ok(error instanceof FollowupRuntimeError);assert.ok(!JSON.stringify(store.events(task.id)).includes(env.FOLLOWUP_TOOLS_TOKEN));throw error;}
    };
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:idle,evaluation:idle},()=>true,follow);
    await worker.tick();await until(()=>f.automationStore.task(t.id)?.status==='interrupted');
    await worker.tick();const saved=f.automationStore.task(t.id)!;
    assert.equal(attempts,1);assert.equal(saved.followup?.attempts,1);assert.equal(saved.stopped,true);
    assert.match(saved.interruption!.reason,/本机工具服务/);assert.match(saved.interruption!.nextSteps.join(' '),/workspace-write/);
    assert.ok(!saved.interruption!.reason.includes('预算'));
    assert.ok(f.automationStore.events(t.id).some(e=>e.message.includes('followup_tool_transport_error')));
  }finally{if(worker)await worker.stop();await f.close();}
});

test('real Codex sandbox reproduces read-only denial and submits a host-validated action with network enabled', {skip:process.env.AUTOMATION_CODEX_SANDBOX_TEST!=='1',timeout:30000},async()=>{
  const f=await fixture();let requests=0,failed:Error|undefined;
  // A deterministic Responses stub instructs the actual CLI to execute the helper.
  // No external model, real task, Kooboo connection, or browser is involved.
  const script=`const {execFileSync}=require('node:child_process');const run=p=>{try{return JSON.parse(execFileSync(process.execPath,['tools.mjs',JSON.stringify(p)],{encoding:'utf8'}));}catch(e){process.stdout.write(e.stdout||'');process.exit(1);}};const seen=run({tool:'get_task'});console.log(JSON.stringify(run({tool:'act',decision:{action:'interrupt',reason:'Synthetic sandbox channel verified',evidence:[seen.evidenceId],nextSteps:['Synthetic task only']}})));`;
  const command=process.execPath+" -e '"+script.replaceAll("'","'\\''")+"'";
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);assert.ok(req.url?.endsWith('/responses'));
      const isCall=++requests===1;
      if(isCall)assert.ok(body.tools.some((tool:{name?:string})=>tool.name==='exec_command'));
      const item=isCall?{type:'function_call',id:'fc_local',call_id:'call_local',name:'exec_command',arguments:JSON.stringify({cmd:command,yield_time_ms:1000,max_output_tokens:2000})}:{type:'message',id:'msg_local',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic action submitted.',annotations:[]}]};
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: '+JSON.stringify({type:'response.output_item.done',output_index:0,item})+'\n\n');
      res.end('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_local_'+requests,object:'response',status:'completed',model:'local-harness-test',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0}}}})+'\n\n');
    }catch(error){failed=error as Error;res.writeHead(500);res.end('Local stub failed');}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    f.vault.updateAutomation({...f.settings,evaluationModel:'local-harness-test',evaluationEndpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`});
    const blocked=f.create();f.automationStore.scheduleFollowup(blocked,f.settings.followup);
    await assert.rejects(()=>executeFollowup(blocked,f.automationStore,f.vault,f.directory,AbortSignal.timeout(12000),(...args)=>{
      const client=codexClient(...args);
      return {startThread:options=>client.startThread({...options,sandboxMode:'read-only'}),resumeThread:(id,options)=>client.resumeThread(id,{...options,sandboxMode:'read-only'})};
    }),FollowupRuntimeError);
    assert.equal(requests,1);assert.equal(f.automationStore.task(blocked.id)!.followup!.observations.length,0);
    requests=0;
    const t=f.create();f.automationStore.scheduleFollowup(t,f.settings.followup);
    const action=await executeFollowup(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(25000),codexClient);
    if(failed)throw failed;
    assert.equal(action.action,'interrupt');assert.equal(action.reason,'Synthetic sandbox channel verified');
    assert.equal(f.automationStore.task(t.id)!.followup!.observations.length,1);
    assert.ok(f.automationStore.events(t.id).some(e=>e.message.startsWith('AI 决策：')));
    assert.equal(requests,2);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('followup tool server closes if SDK client startup fails',async()=>{
  const f=await fixture();try{
    const t=f.create();f.automationStore.scheduleFollowup(t,f.settings.followup);let url='';
    await assert.rejects(()=>executeFollowup(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(1000),(_v,_d,extra)=>{url=extra.FOLLOWUP_TOOLS_URL;throw new Error('SDK unavailable');}),/SDK unavailable/);
    await assert.rejects(()=>fetch(url,{signal:AbortSignal.timeout(1000)}));
  }finally{await f.close();}
});


test('real generator handoff refreshes camel-case siteId and probes homepage without opening a browser',async()=>{
  const f=await fixture();const t=f.create(),site=f.attach(t);let origin='';const paths:string[]=[];
  const server=createServer((req,res)=>{paths.push(req.url||'');res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/_api/v2/Site/List')){assert.equal(req.headers.authorization,'Bearer test-only-token');res.end(JSON.stringify([{siteId:site.siteId,homePageLink:origin+'/home'}]));}else{assert.equal(req.headers.authorization,undefined);res.end('homepage');}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const runtime=f.vault.get();f.vault.update({...runtime,environments:runtime.environments.map(e=>({...e,origin,apiOrigin:origin}))});
    site.url='';f.automationStore.saveSite(site);t.siteUrl='';t.generation!.deliveryState='completed';
    await executeGeneration(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(1000));assert.equal(t.siteUrl,origin+'/home');assert.equal(t.stage,'handoff');assert.deepEqual(paths,['/_api/v2/Site/List','/home']);
    paths.length=0;
    t.generatedSiteId=null;t.generation={createAttempted:true};
    await assert.rejects(()=>executeGeneration(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(1000)),/禁止重复创建/);
    assert.deepEqual(paths,['/_api/v2/Site/List']);
    t.generatedSiteId=site.id;t.scenario='upgrade';t.generation={createAttempted:true};
    await assert.rejects(()=>executeGeneration(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(1000)),/克隆未返回任务标识/);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
});

test('failed generation retry sends once, ignores the previous run and consumes only the new terminal receipt',async()=>{
  for(const result of ['completed','failed','lost-receipt','changed-execution','answer'] as const){
    const f=await fixture(),task=f.create(),site=f.attach(task),runId=randomUUID();let origin='',sent=0,reads=0,closed=0;
    const server=createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      if(req.url?.startsWith('/_api/v2/Site/List'))res.end(JSON.stringify([{siteId:site.siteId,homePageLink:origin+'/home'}]));
      else if(req.url==='/home')res.end('homepage');
      else{res.statusCode=500;res.end('{}');}
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try{
      f.vault.update({...f.vault.get(),environments:[{id:f.environmentId,name:'Test',origin,apiOrigin:origin,token:'test-only-token'}]});
      task.generation!.runId=runId;task.generation!.state='failed';task.learningPolicy={...task.learningPolicy!,use:false,collect:false};
      f.automationStore.scheduleFollowup(task,f.settings.followup);
      const conversationId=task.generation!.conversationId!,oldDelivery=task.generation!.deliveryId!;
      const old:GenerationObservation={version:1,taskId:task.id,siteId:site.siteId,conversationId,runId,ready:true,running:false,state:'failed',observedAt:Date.now(),pending:null,context:[{role:'assistant',text:'Insufficient Balance'}],delivery:{id:oldDelivery,state:'accepted',conversationId},outcome:{conversationId,runId,status:'failed',time:Date.now()-3600000}};
      if(result==='answer'){
        old.state='waiting';old.pending={callId:'pending-call',name:'ask_user',args:{}};delete old.outcome;
        task.generation!.next=validateFollowupAction(decision('answer',{callId:'pending-call',answer:{approved:true}}),task,{execution:old},new Set(['observed']));
      }else task.generation!.next=validateFollowupAction(decision('retry',{reason:'余额已补充，重新执行'}),task,{execution:old},new Set(['observed']));
      const newRun=result==='answer'?runId:randomUUID(),outcome=result==='failed'?'failed':'completed';let currentDelivery=oldDelivery;
      const openSession:typeof import('../server/automation/generation-session.js').generationSession=async(current)=>({
        snapshot:async()=>{
          let state=structuredClone(old);
          if(result==='changed-execution'&&!sent){state.runId=newRun;state.outcome!.runId=newRun;}
          if(sent){
            reads++;
            if(reads===1&&result!=='answer')state.delivery!.error='old delivery error';
            if(reads>=2)state.delivery!.id=currentDelivery;
            if(reads>=3||result==='lost-receipt'||result==='answer')state={...state,runId:newRun,state:outcome,pending:null,delivery:{id:currentDelivery,state:'accepted',conversationId},outcome:{conversationId,runId:newRun,status:outcome,time:Date.now()}};
          }
          applyGenerationObservation(current,state);f.automationStore.put(current);return state;
        },
        deliver:async input=>{
          sent++;assert.equal(input.conversationId,conversationId);
          if(result==='answer'){assert.equal(input.callId,'pending-call');assert.deepEqual(input.answer,{approved:true});}
          else assert.match(input.text!,/余额已补充/);
          assert.notEqual(input.id,oldDelivery);currentDelivery=input.id;
          const saved=f.automationStore.task(task.id)!;assert.equal(saved.generation!.previousRunId,result==='answer'?undefined:runId);assert.equal(saved.generation!.deliveryState,'sending');assert.equal(saved.generation!.next,undefined);
          if(result==='lost-receipt')throw new Error('connection lost after acceptance');
          return {id:input.id,state:'accepted',conversationId};
        },
        close:async()=>{closed++;},
      });
      const execute=(value:AutomationTask)=>executeGeneration(value,f.automationStore,f.vault,f.directory,AbortSignal.timeout(8000),openSession);
      if(result==='changed-execution'){
        await assert.rejects(()=>execute(task),/回执已变化/);assert.equal(sent,0);
      }else if(result==='lost-receipt'){
        await assert.rejects(()=>execute(task),/connection lost/);
        const recovered=f.automationStore.task(task.id)!;assert.equal(recovered.generation!.deliveryState,'sending');
        await execute(recovered);assert.equal(recovered.generation!.deliveryState,'completed');assert.equal(sent,1);assert.equal(closed,2);
      }else{
        if(result==='failed')await assert.rejects(()=>execute(task),/结果为 failed/);
        else{await execute(task);assert.equal(task.stage,'handoff');assert.equal(task.siteUrl,origin+'/home');assert.equal(task.generation!.deliveryState,'completed');}
        assert.equal(sent,1);assert.ok(reads>=(result==='answer'?1:3));assert.equal(task.generation!.runId,newRun);
      }
      assert.equal(task.generatedSiteId,site.id);assert.equal(task.versionId,f.automationStore.versions(f.resource.id)[0].id);assert.equal(task.generation!.conversationId,conversationId);
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.close();}
  }
});
