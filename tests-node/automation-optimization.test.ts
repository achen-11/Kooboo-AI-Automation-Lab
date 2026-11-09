import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultOptimizationPolicy, type AutomationTask, type FollowupAction, type AutomationReport, type Scenario, type Scope } from '../shared/automation.js';
import { advanceOptimization, applyOptimizationAction, optimizationBudgetReason, targetReached } from '../server/automation/optimization.js';
import { optimizationEvidence } from '../server/automation/optimization-evidence.js';
import { executeFollowup, validateFollowupAction } from '../server/automation/followup.js';
import { AutomationWorker, type Execute } from '../server/automation/worker.js';
import { ManifestStore } from '../server/automation/completeness.js';

async function fixture(maxRounds=3, scenario:Scenario='site-template', scope:Scope='homepage') {
  const directory=mkdtempSync(join(tmpdir(),'optimization-'));
  const f=await createApp({directory,startWorker:false,serveWeb:false});const store=f.automationStore;
  const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
  const settings={...structuredClone(defaultAutomationSettings),enabled:true,evaluationEndpoint:'https://model.test/v1'};f.vault.updateAutomation(settings);
  const resource=store.saveResource({name:'Template',scenario,contentUrl:'https://reference.test',referenceUrl:'',description:'事实内容',files:[],externalSource:'admin',externalId:'sample'});
  const site={id:randomUUID(),resourceId:resource.id,versionId:store.versions(resource.id)[0].id,environmentId:randomUUID(),siteId:randomUUID(),name:'Original',url:'https://generated.test',createdAt:Date.now()};store.saveSite(site);
  const root=store.create({resourceIds:[resource.id],kind:'generation',scope,environmentId:site.environmentId,generatedSiteId:site.id,requirements:'',optimization:{...defaultOptimizationPolicy,maxRounds}},settings)[0];
  root.generation={prepared:true,conversationId:randomUUID(),deliveryState:'completed'};store.put(root);
  function report(task:AutomationTask,desktop=76,mobile=78):AutomationReport {return {summary:'独立报告',quality:desktop>=80&&mobile>=80?'passed':'failed',scores:[{viewport:'desktop',value:desktop},{viewport:'mobile',value:mobile}],assessments:task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:viewport==='desktop'?desktop:mobile,passed:true,reason:'截图证据',evidence:[]}))),issues:[],coverage:{verified:['本范围'],unverified:[],outOfScope:['内页']},artifacts:[]};}
  function finish(generation:AutomationTask,desktop=76,mobile=78){
    store.beginSiteChange(generation);generation.status='completed';generation.stopped=true;store.put(generation);
    const evaluation=store.ensureEvaluation(generation,settings);evaluation.status='completed';evaluation.stopped=true;evaluation.report=report(evaluation,desktop,mobile);store.publishSiteReport(evaluation);store.put(evaluation);return evaluation;
  }
  function advance(){const task=store.task(root.id)!;advanceOptimization(task,store,settings);return store.task(root.id)!;}
  const decision=(improved=true):FollowupAction=>({action:'repair',reason:'结构存在实际差距',evidence:['observation-test'],message:'首页 PC 与移动端：修复 Hero 构图与流程区层级；保留既有内容，遵循参考结构，检查共享样式回归，图片使用 imagePlaceholder。',imageEvidence:['image.png'],progress:{improved,reason:improved?'流程区层级已改善':'实际问题没有解决',resolved:improved?['层级']:[],remaining:['结构'],unverified:[],introduced:[]}});
  function repair(improved=true){const task=store.task(root.id)!;applyOptimizationAction(task,decision(improved),store,settings);const run=store.task(root.id)!.optimization!;return store.task(run.activeTaskId)!;}
  return {...f,store,directory,headers,settings,resource,site,root,report,finish,advance,repair,decision,async close(){await f.app.close();rmSync(directory,{recursive:true,force:true});}};
}

test('quality workflow keeps original site, frozen inputs/model/rules, independent reports and current-version truth',async()=>{
  const f=await fixture();try{
    const initial=f.finish(f.root);let root=f.advance();assert.equal(root.optimization!.state,'planning');assert.equal(root.optimization!.reportId,initial.id);
    const child=f.repair();root=f.store.task(f.root.id)!;
    assert.equal(child.generatedSiteId,f.root.generatedSiteId);assert.equal(child.versionId,f.root.versionId);assert.equal(child.rule!.hash,f.root.rule!.hash);assert.deepEqual(child.model,f.root.model);
    assert.equal(child.generation!.conversationId,f.root.generation!.conversationId);assert.equal(child.generation!.next!.action,'continue');assert.equal(root.optimization!.rounds.length,2);
    assert.equal(f.store.currentReport(root),undefined);assert.equal(f.store.task(initial.id)!.report!.scores[0].value,76);
    const pending=(await f.app.inject({url:`/api/v1/automation/tasks/${root.id}/result`,headers:f.headers})).json();assert.equal(pending.ready,false);assert.equal(pending.report,null);
    const final=f.finish(child,88,86);root=f.advance();assert.equal(root.optimization!.state,'completed');assert.equal(f.store.currentReport(root)!.id,final.id);
    const result=(await f.app.inject({url:`/api/v1/automation/tasks/${root.id}/result`,headers:f.headers})).json();assert.equal(result.ready,true);assert.equal(result.targetReached,true);assert.equal(result.reportId,final.id);assert.equal(result.report.scores[0].value,88);
    assert.equal(f.store.task(initial.id)!.report!.scores[0].value,76);assert.equal(f.store.tasks().filter(t=>t.kind==='evaluation').length,2);
    f.advance();assert.equal(f.store.tasks().length,4,'repeated ticks cannot schedule duplicate rounds');
  }finally{await f.close();}
});

test('each viewport and required evidence matter; scope-excluded uncertainty does not veto the objective',async()=>{
  const f=await fixture();try{
    const report=f.report(f.root,90,84);assert.equal(targetReached(f.root,report),false);report.scores[1].value=86;
    report.coverage.unverified=['全站动画不在本次范围'];assert.equal(targetReached(f.root,report),true);
    report.issues.push({severity:'major',title:'Broken CTA',detail:'证据',evidence:['x']});assert.equal(targetReached(f.root,report),false);report.issues=[];
    f.root.rule!.criteria[0].required=true;report.assessments[0].passed=null;assert.equal(targetReached(f.root,report),false);report.assessments[0].passed=true;
    report.assessments[0].score=null;assert.equal(targetReached(f.root,report),false);
  }finally{await f.close();}
});

test('repair inherits the independently expanded manifest instead of the stale root contract',async()=>{
  const f=await fixture(3,'migration','site');try{
    const manifests=new ManifestStore(f.store);
    const item={id:'records',kind:'data',title:'Source records',required:true,source:'fixed source',expectation:'Preserve all records',paths:[],viewports:['business'],expectedCount:null,expectedKeys:[]};
    const baseline=manifests.save(f.root,{sourceComplete:false,limitations:['Unknown source total'],evidence:[],items:[item]},'human');
    const evaluation=f.finish(f.root);
    const reviewed=manifests.save(evaluation,{sourceComplete:false,limitations:['Unknown source total'],evidence:[],items:[{...item,expectedCount:2,expectedKeys:['https://reference.test/a','https://reference.test/b'],dataIdentity:{kind:'page'}}]},'ai');
    f.advance();const child=f.repair(),adopted=manifests.get(child.requirementsId)!;
    assert.deepEqual(adopted.items,reviewed.items);
    assert.equal(adopted.taskId,child.id);
    assert.equal(f.store.task(f.root.id)!.requirementsId,adopted.id);
    assert.equal(manifests.get(baseline.id)!.items[0].expectedCount,null);
    assert.equal(f.store.task(evaluation.id)!.requirementsId,reviewed.id);
  }finally{await f.close();}
});

test('repair rejects a manifest owned by another workflow and rolls back the child task',async()=>{
  const f=await fixture(3,'migration','site');try{
    const manifests=new ManifestStore(f.store);
    const input={sourceComplete:false,limitations:['Unknown source total'],evidence:[],items:[{id:'records',kind:'data',title:'Source records',required:true,source:'fixed source',expectation:'Preserve all records',paths:[],viewports:['business'],expectedCount:null,expectedKeys:[]}]};
    manifests.save(f.root,input,'human');
    const evaluation=f.finish(f.root);
    const unrelated=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'site',environmentId:f.site.environmentId,requirements:''},f.settings)[0];
    evaluation.requirementsId=manifests.save(unrelated,input,'human').id;f.store.put(evaluation);
    f.advance();const count=f.store.tasks().length;
    assert.throws(()=>f.repair(),/独立评测的交付清单来源无效/);
    assert.equal(f.store.tasks().length,count);assert.equal(f.store.task(f.root.id)!.optimization!.state,'planning');
  }finally{await f.close();}
});

for (const scenario of ['migration', 'upgrade'] as const) {
  test(`${scenario} optimization preserves original content/session and requires full-site completeness and business checks`, async () => {
    const f = await fixture(3, scenario, 'site'); try {
      f.finish(f.root); let root = f.advance(); assert.equal(root.optimization!.state, 'planning');
      const child = f.repair(); assert.equal(child.generatedSiteId, root.generatedSiteId); assert.equal(child.generation!.conversationId, root.generation!.conversationId);
      assert.match(child.message, /保留内容站及资料包的真实内容和合法资源/);
      assert.doesNotMatch(child.message.split('\n\n')[0], /图片使用 imagePlaceholder/);
      const evaluation = f.finish(child, 92, 93); root = f.store.task(f.root.id)!;
      assert.equal(targetReached(root, evaluation.report!), false, 'high visual scores cannot bypass missing completeness');
      evaluation.report!.completeness = { manifestId: randomUUID(), manifestRevision: 2, sourceComplete: true, state: 'complete', checks: [] };
      const seo = evaluation.report!.assessments.find(item => item.criterionId === 'seo-migration')!;
      seo.passed = false; assert.equal(targetReached(root, evaluation.report!), false);
      seo.passed = true; f.store.put(evaluation); root = f.advance(); assert.equal(root.optimization!.state, 'completed');
      assert.equal(root.optimization!.rounds.length, 2); assert.equal(f.store.currentReport(root)!.id, evaluation.id);
    } finally { await f.close(); }
  });

  test(`completed ${scenario} tasks can explicitly enable bounded optimization without replacing the baseline`, async () => {
    const f = await fixture(3, scenario); try {
      const evaluation = f.finish(f.root), old = f.store.task(f.root.id)!; delete old.optimization; f.store.put(old);
      const response = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${old.id}/optimize`, headers: f.headers, payload: { targetScore: 87, maxRounds: 2, maxCostCny: null } });
      assert.equal(response.statusCode, 200); const root = f.store.task(old.id)!;
      assert.equal(root.optimization!.reportId, evaluation.id); assert.equal(root.optimization!.policy.maxRounds, 2);
      assert.equal(root.optimization!.policy.targetScore, 87); assert.equal(root.rule!.hash, evaluation.rule!.hash);
    } finally { await f.close(); }
  });
}

test('quality planning initializes its own recovery budget once and queue counts include hidden repair children',async()=>{
  const f=await fixture();try{
    f.finish(f.root);
    const old=f.store.task(f.root.id)!;
    f.store.scheduleFollowup(old,f.settings.followup,true);
    old.followup!.attempts=20;old.followup!.tokens=2000000;old.followup!.elapsedMs=99999999;
    old.followup!.state='resolved';old.status='completed';old.stopped=true;f.store.put(old);
    let root=f.advance();assert.equal(root.followup!.attempts,0);assert.equal(root.followup!.tokens,0);assert.equal(root.followup!.elapsedMs,0);
    root.followup!.attempts=1;root.followup!.tokens=123;root.followup!.elapsedMs=456;f.store.put(root);
    const child=f.repair();
    const overview=(await f.app.inject({url:'/api/automation/overview?view=compact',headers:f.headers})).json();
    assert.equal(overview.queue.queued,1);assert.equal(overview.tasks.some((t:AutomationTask)=>t.id===child.id),false);
    f.finish(child,80,81);root=f.advance();
    assert.equal(root.followup!.attempts,1);assert.equal(root.followup!.tokens,123);assert.equal(root.followup!.elapsedMs,456);
  }finally{await f.close();}
});

test('historical templates without generation rules pin their independent baseline rules when opting in',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root),old=f.store.task(f.root.id)!;
    delete old.optimization;old.rule=null;f.store.put(old);
    const response=await f.app.inject({method:'POST',url:`/api/automation/tasks/${old.id}/optimize`,headers:f.headers,payload:{targetScore:85,maxRounds:3,maxCostCny:null}});
    assert.equal(response.statusCode,200);
    const pinned=f.store.task(old.id)!;assert.equal(pinned.rule!.hash,evaluation.rule!.hash);
    const report=f.report(pinned,90,90);pinned.rule!.criteria[0].required=true;report.assessments[0].passed=false;
    assert.equal(targetReached(pinned,report),false,'missing historical rules must not bypass required checks');
    f.advance();const child=f.repair();assert.equal(child.rule!.hash,evaluation.rule!.hash);
  }finally{await f.close();}
});

test('round cap and two evidence-based no-improvement decisions stop without fabricating a pass',async()=>{
  const f=await fixture();try{
    f.finish(f.root);f.advance();let child=f.repair(false);f.finish(child,77,78);f.advance();child=f.repair(false);f.finish(child,76,78);f.advance();f.repair(false);
    const run=f.store.task(f.root.id)!.optimization!;assert.equal(run.state,'stopped');assert.equal(run.noImprovement,2);assert.equal(run.rounds.length,3);assert.match(run.reason,/连续两轮/);
  }finally{await f.close();}
  const cap=await fixture(1);try{
    cap.finish(cap.root);cap.advance();const child=cap.repair();cap.finish(child,83,84);const root=cap.advance();assert.equal(root.optimization!.state,'stopped');assert.match(root.optimization!.reason,/最多修复轮数/);assert.ok(cap.store.currentReport(root));
    const result=(await cap.app.inject({url:`/api/v1/automation/tasks/${root.id}/result`,headers:cap.headers})).json();assert.equal(result.ready,true);assert.equal(result.targetReached,false);assert.equal(result.report.scores[0].value,83);
  }finally{await cap.close();}
});

test('recovery keeps an incomplete round and site reservations; cancelled/failed re-evaluation never returns old scores',async()=>{
  const f=await fixture();try{
    const initial=f.finish(f.root);f.advance();const child=f.repair();child.status='running';child.stopped=false;f.store.put(child);f.store.recover();
    f.advance();assert.equal(f.store.task(f.root.id)!.optimization!.rounds.length,2);assert.equal(f.store.task(child.id)!.status,'pending');assert.equal(f.store.claim('evaluation',1),undefined);
    assert.throws(()=>f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'homepage',environmentId:f.site.environmentId,generatedSiteId:f.site.id,requirements:'parallel'},f.settings),/正在自动优化/);
    const resumed=f.store.task(child.id)!;resumed.status='completed';resumed.stopped=true;f.store.beginSiteChange(resumed);f.store.put(resumed);f.advance();
    const root=f.store.task(f.root.id)!,evaluation=f.store.task(root.optimization!.activeTaskId)!;assert.equal(evaluation.kind,'evaluation');
    evaluation.status='interrupted';evaluation.error='模型繁忙';evaluation.stopped=true;f.store.put(evaluation);f.advance();
    const result=(await f.app.inject({url:`/api/v1/automation/tasks/${root.id}/result`,headers:f.headers})).json();assert.equal(result.ready,false);assert.equal(result.status,'unscored');assert.equal(result.report,null);
    assert.equal(f.store.task(initial.id)!.report!.scores[0].value,76);assert.equal(f.store.task(f.root.id)!.optimization!.rounds.length,2);
  }finally{await f.close();}
});

test('workflow cost covers all unique rounds and unknown usage is not a free pass under a monetary cap',async()=>{
  const f=await fixture();try{
    const initial=f.finish(f.root);f.advance();const child=f.repair();const root=f.store.task(f.root.id)!;root.optimization!.policy.maxCostCny=0.001;f.store.put(root);
    const observation={id:'x',source:'codex' as const,stage:'evaluation' as const,endpoint:'https://api.deepseek.com',model:'deepseek-flash-1017',startedAt:Date.parse('2026-11-07T01:00:00Z'),endedAt:Date.parse('2026-11-07T01:00:01Z'),status:'completed' as const,basis:'request' as const,raw:{input_tokens:10000,output_tokens:10000,cached_input_tokens:0}};
    f.store.usage.record(initial.id,observation);f.store.usage.record(initial.id,observation);assert.equal(f.store.task(root.id)!.usage!.requests,1);assert.match(optimizationBudgetReason(child,f.store),/费用上限/);
    root.optimization!.policy.maxCostCny=100;f.store.put(root);f.store.usage.record(child.id,{...observation,id:'missing',raw:null});assert.match(optimizationBudgetReason(child,f.store),/未完整核算/);
    const page=(await f.app.inject({url:`/api/automation/tasks/${root.id}/usage?round=0`,headers:f.headers})).json();assert.equal(page.total,1);
  }finally{await f.close();}
});

test('real pixel inputs are hash checked, include both viewports/roles, and ordinary recovery cannot request quality repair',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root);const bytes=Buffer.from('89504e470d0a1a0a00000000','hex');const dir=join(f.directory,'automation-runs',evaluation.id,'evidence');mkdirSync(dir,{recursive:true});
    evaluation.report!.artifacts=['desktop','mobile'].flatMap(viewport=>['target','reference'].map(role=>{const name=randomUUID()+'.png';writeFileSync(join(dir,name),bytes);return {id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),viewport:viewport as 'desktop'|'mobile',role:role as 'target'|'reference'};}));f.store.put(evaluation);
    const root=f.advance(),images=optimizationEvidence(root,f.store,f.directory);assert.equal(images.selected.length,4);
    const decision={...f.decision(),imageEvidence:[images.selected[0].file.name]};const observations=new Set(['observation-test']);
    assert.equal(validateFollowupAction(decision,root,{optimizationImages:decision.imageEvidence},observations).action,'repair');
    assert.throws(()=>validateFollowupAction({...decision,imageEvidence:['invented.png']},root,{optimizationImages:decision.imageEvidence},observations),/实际输入/);
    assert.throws(()=>validateFollowupAction(decision,evaluation,{},observations),/普通恢复/);
    writeFileSync(images.selected[0].path,'tampered');assert.throws(()=>optimizationEvidence(root,f.store,f.directory),/校验失败/);
  }finally{await f.close();}
});

test('worker executes repair and independent evaluation serially without changing ordinary generation behavior',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;try{
    f.settings.autoEvaluate=false;f.vault.updateAutomation(f.settings);const calls:string[]=[];
    const generation:Execute=async(task,store)=>{calls.push('generation:'+task.optimizationRound);store.beginSiteChange(task);task.generation={...task.generation,prepared:true,conversationId:f.root.generation!.conversationId,deliveryState:'completed'};};
    const evaluation:Execute=async(task)=>{calls.push('evaluation:'+task.optimizationRound);task.report=f.report(task,task.optimizationRound?88:76,task.optimizationRound?87:78);};
    worker=new AutomationWorker(f.store,f.vault,f.directory,{generation,evaluation},()=>true,async task=>{calls.push('plan');return f.decision();});
    await worker.tick();for(let i=0;i<80&&f.store.task(f.root.id)!.optimization!.state!=='completed';i++){await new Promise(r=>setTimeout(r,10));await worker.tick();}
    assert.equal(f.store.task(f.root.id)!.optimization!.state,'completed',JSON.stringify({calls,events:f.store.events(f.root.id)}));assert.deepEqual(calls,['generation:undefined','evaluation:0','plan','generation:1','evaluation:1']);
    const root=f.store.task(f.root.id)!;assert.equal(root.optimization!.rounds.length,2);assert.equal(f.store.currentReport(root)!.report!.scores[0].value,88);
  }finally{await worker?.stop();await f.close();}
});

test('task API freezes optimization policy, rejects other scenarios and keeps old reports directly readable',async()=>{
  const f=await fixture();try{
    const headers={...f.headers,'idempotency-key':'optimization-new-root'},policy={targetScore:90,maxRounds:2,maxCostCny:20};
    const input={resourceIds:[f.resource.id],kind:'generation',scope:'homepage',environmentId:'',requirements:'',optimization:policy};
    // An existing generated site is deliberately not supplied: this task owns a separate future site.
    input.environmentId=f.site.environmentId;
    f.vault.update({threshold:82,paused:true,execution:{timeoutSeconds:300,captureAttempts:2},model:{endpoint:'https://model.test/v1',name:'test',apiKey:'test-only-key'},environments:[{id:f.site.environmentId,name:'Test',origin:'https://kooboo.test',apiOrigin:'https://kooboo.test',token:'test-only-token'}]});
    const created=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers,payload:input});assert.equal(created.statusCode,201);
    const newRoot=created.json().items[0];assert.equal(newRoot.optimization.policy.targetScore,90);assert.equal(newRoot.optimization.threshold,82);
    const retry=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers,payload:input});assert.deepEqual(retry.json(),created.json());
    f.vault.updateAutomation({...f.settings,optimization:{...defaultOptimizationPolicy,targetScore:95,maxRounds:8}});assert.equal(f.store.task(newRoot.id)!.optimization!.policy.maxRounds,2);
    const ordinary=f.store.saveResource({...f.resource,name:'Materials',scenario:'materials',externalId:'other'});
    const bad=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers:{...headers,'idempotency-key':'reject-materials'},payload:{...input,resourceIds:[ordinary.id]}});assert.equal(bad.statusCode,409);assert.match(bad.json().error,/仅支持 AI Site/);
    const initial=f.finish(f.root);f.advance();f.repair();
    const history=(await f.app.inject({url:`/api/automation/tasks/${f.root.id}/sections/report?round=0`,headers:f.headers})).json();assert.equal(history.historical,true);assert.equal(history.report.scores[0].value,76);
    const current=(await f.app.inject({url:`/api/automation/tasks/${f.root.id}/sections/report`,headers:f.headers})).json();assert.equal(current.report,null);assert.equal(current.optimization.rounds.length,2);
    const publicReport=await f.app.inject({url:`/api/v1/automation/reports/${initial.id}`,headers:{authorization:'Bearer '+f.vault.credentials.readToken}});assert.equal(publicReport.statusCode,200);assert.equal(publicReport.json().workflow.taskId,f.root.id);
    assert.equal((await f.app.inject({url:`/api/automation/tasks/${f.root.id}/sections/execution?taskId=${randomUUID()}`,headers:f.headers})).statusCode,409);
    assert.equal((await f.app.inject({url:`/api/v1/automation/tasks/${f.root.id}/result`,headers:{authorization:'Bearer '+f.vault.credentials.readToken}})).json().report,null);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${f.root.id}/optimization/stop`,headers:{authorization:'Bearer '+f.vault.credentials.readToken}})).statusCode,401);
  }finally{await f.close();}
});

test('stopping between planning attempts persists despite an old executor heartbeat',async()=>{
  const f=await fixture();try{
    f.finish(f.root);f.advance();const claimed=f.store.claimFollowup(1)!;assert.equal(claimed.id,f.root.id);
    // A service-owned active call can be cancelled; use the API with an ownership callback through the real worker mock below.
    claimed.stopped=true;claimed.followup!.state='waiting';f.store.put(claimed);
    const before=f.store.task(claimed.id)!;
    const response=await f.app.inject({method:'POST',url:`/api/automation/tasks/${claimed.id}/optimization/stop`,headers:f.headers});assert.equal(response.statusCode,200);
    f.store.put(before);assert.equal(f.store.task(claimed.id)!.optimization!.state,'stopped');
    const count=f.store.tasks().length;f.advance();assert.equal(f.store.tasks().length,count);
  }finally{await f.close();}
});

test('late results cannot be published for a different site revision',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root);f.advance();const child=f.repair();f.store.beginSiteChange(child);
    assert.throws(()=>f.store.publishSiteReport(evaluation),/版本发生变化/);assert.equal(f.store.currentReport(f.store.task(f.root.id)!),undefined);
  }finally{await f.close();}
});

test('quality followup sends actual pixel inputs and accepts only a host-observed repair decision',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),folder=join(f.directory,'automation-runs',evaluation.id,'evidence');mkdirSync(folder,{recursive:true});
    evaluation.report!.artifacts=['desktop','mobile'].flatMap(viewport=>['target','reference'].map(role=>{const name=randomUUID()+'.png';writeFileSync(join(folder,name),bytes);return {id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),viewport:viewport as 'desktop'|'mobile',role:role as 'target'|'reference'};}));f.store.put(evaluation);const root=f.advance();
    let pixels=0;
    const decision=await executeFollowup(root,f.store,f.vault,f.directory,new AbortController().signal,(_vault,_dir,env)=>{
      const client={runStreamed:async(input:unknown)=>({events:(async function*(){
        assert.ok(Array.isArray(input));pixels=input.filter(i=>i.type==='local_image').length;assert.equal(pixels,4);
        assert.match(input[0].text,/"tool":"act","decision":/);
        assert.match(input[0].text,/acceptedAssetGaps 中逐项精确匹配的 URL \/ 路径才可豁免/);
        assert.match(input[0].text,/source limitations、sourceGaps、源站缺原件、请求失败或已有豁免数量均不代表新增豁免/);
        const schema=JSON.parse(readFileSync(join(f.directory,'followup-runs',root.id,'tools-schema.json'),'utf8'));
        assert.ok(schema.properties.tool.enum.includes('get_report'));assert.ok(schema.properties.decision.properties.progress);
        const call=async(value:unknown)=>{const response=await fetch(env.FOLLOWUP_TOOLS_URL,{method:'POST',headers:{authorization:'Bearer '+env.FOLLOWUP_TOOLS_TOKEN,'content-type':'application/json'},body:JSON.stringify(value)});assert.equal(response.status,200);return response.json();};
        const task=await call({tool:'get_task'}),report=await call({tool:'get_report'});
        await call({tool:'act',decision:{...f.decision(),evidence:[task.evidenceId,report.evidenceId],imageEvidence:[evaluation.report!.artifacts[0].name]}});
        yield {type:'turn.completed' as const,usage:{input_tokens:100,output_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
      })()})};return {startThread:()=>client,resumeThread:()=>client};
    });
    assert.equal(decision.action,'repair');assert.equal(pixels,4);assert.equal(f.store.tasks().length,2,'the decision tool itself cannot mutate the site or schedule a repair');
  }finally{await f.close();}
});

test('cancelling a repair that already changed the site says the current version needs re-evaluation',async()=>{
  const f=await fixture();try{
    f.finish(f.root);f.advance();const child=f.repair();
    f.store.noteCancelledSiteChange(child);assert.equal(child.error,'','an untouched site keeps its current report');
    f.store.beginSiteChange(child);f.store.noteCancelledSiteChange(child);assert.match(child.error,/需要对当前版本发起复评/);
  }finally{await f.close();}
});

test('re-evaluation adopts the newest manifest of the same input and frozen material instead of the parent copy',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root);new ManifestStore(f.store);
    const manifest=(taskId:string,revision:number)=>{const id=randomUUID();f.store.db.prepare('INSERT INTO auto_requirement_manifests VALUES(?,?,?,?)').run(id,taskId,revision,JSON.stringify({id,taskId,revision,items:[]}));return id;};
    const parentManifest=manifest(f.root.id,1),reviewed=manifest(evaluation.id,2),foreign=manifest(randomUUID(),3);
    const root=f.store.task(f.root.id)!;root.optimization=undefined;root.requirementsId=parentManifest;f.store.put(root);
    evaluation.requirementsId=reviewed;f.store.put(evaluation);
    const create=()=>f.store.create({resourceIds:[f.resource.id],kind:'evaluation',scope:root.scope,environmentId:root.environmentId,generatedSiteId:f.site.id,requirements:'复评',parentId:root.id,versionId:root.versionId,ruleSnapshot:root.rule!},f.settings)[0];
    const other=create();other.status='cancelled';other.requirementsId=foreign;other.collectionVersionId='other-snapshot';f.store.put(other);
    const recheck=create();assert.equal(recheck.requirementsId,reviewed);assert.ok(f.store.events(recheck.id).some((e:any)=>String(e.message).includes(evaluation.id)));
    for(const task of [recheck,evaluation]){task.status='cancelled';task.collectionVersionId='other-snapshot';f.store.put(task);}assert.equal(create().requirementsId,parentManifest);
  }finally{await f.close();}
});

test('resumed planner threads do not resend pixels and oversized requests release the thread',async()=>{
  const f=await fixture();try{
    const evaluation=f.finish(f.root),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),folder=join(f.directory,'automation-runs',evaluation.id,'evidence');mkdirSync(folder,{recursive:true});
    evaluation.report!.artifacts=['desktop','mobile'].flatMap(viewport=>['target','reference'].map(role=>{const name=randomUUID()+'.png';writeFileSync(join(folder,name),bytes);return {id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),viewport:viewport as 'desktop'|'mobile',role:role as 'target'|'reference'};}));f.store.put(evaluation);const root=f.advance();
    const runs:{mode:string;pixels:number;resentLabels:number}[]=[];
    const attempt=(failure:string)=>executeFollowup(f.store.task(root.id)!,f.store,f.vault,f.directory,new AbortController().signal,()=>{
      const client=(mode:string)=>({runStreamed:async(input:unknown)=>({events:(async function*(){
        assert.ok(Array.isArray(input));runs.push({mode,pixels:input.filter(i=>i.type==='local_image').length,resentLabels:input.filter(i=>i.type==='text'&&/本次不重复发送/.test(i.text)).length});
        if(mode==='start')yield {type:'thread.started' as const,thread_id:'thread-'+runs.length};
        yield {type:'error' as const,message:failure};
      })()})});return {startThread:()=>client('start'),resumeThread:()=>client('resume')};
    });
    await assert.rejects(attempt('stream disconnected'),/stream disconnected/);
    await assert.rejects(attempt('unexpected status 413 Payload Too Large'),/413/);
    assert.equal(f.store.task(root.id)!.followup!.threadId,'');
    await assert.rejects(attempt('stream disconnected'),/stream disconnected/);
    assert.deepEqual(runs,[{mode:'start',pixels:4,resentLabels:0},{mode:'resume',pixels:0,resentLabels:4},{mode:'start',pixels:4,resentLabels:0}]);
  }finally{await f.close();}
});
