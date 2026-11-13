import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.js';
import { BackgroundWorkers } from '../server/background.js';
import { Database } from '../server/runtime.js';
import { RequestBudget, retainRequestReservation } from '../server/automation/request-budget.js';
import { retainStoppedFollowupReservations, correctUnsentPlanningAttempts } from '../server/automation/budget-recovery.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { optimizationBudgetReason } from '../server/automation/optimization.js';
import { AutomationWorker, syncReflectionCandidates } from '../server/automation/worker.js';
import { reflectExperience } from '../server/automation/experience.js';

test('only proven unsent current planning attempts can be corrected after the missing evidence is fixed',async()=>{
  const f=await fixture();try{
    const task=f.store.task(f.task.id)!;task.stage='optimization';task.optimization!.state='planning';task.followup!.tokens=0;task.followup!.threadId='';task.followup!.startedAt=Date.now();task.followup!.attempts=5;
    const report=f.create(task.id);report.kind='evaluation';task.optimization!.reportId=report.id;
    assert.throws(()=>correctUnsentPlanningAttempts(task,f.store,f.directory),/有效报告/);assert.equal(task.followup!.attempts,5);
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    const path=join(f.directory,'automation-runs',report.id,'evidence');mkdirSync(path,{recursive:true});
    const artifacts=[];for(const viewport of ['desktop','mobile'] as const)for(const role of ['target','reference'] as const){const name=randomUUID()+'.png';writeFileSync(join(path,name),bytes);artifacts.push({id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role,viewport});}
    report.report={summary:'independent',quality:'unverified',scores:[],assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},artifacts};f.store.put(report);
    f.store.usage.record(task.id,{id:randomUUID(),source:'codex',stage:'followup',model:'test',endpoint:'https://test.invalid',startedAt:task.followup!.startedAt-100,endedAt:task.followup!.startedAt-10,status:'completed',basis:'request',raw:{input_tokens:1,output_tokens:1}});
    const before=structuredClone(task.followup);correctUnsentPlanningAttempts(task,f.store,f.directory);assert.equal(task.followup!.attempts,0);
    for(const key of ['budgetId','tokens','elapsedMs','startedAt'] as const)assert.equal(task.followup![key],before![key]);
    task.followup!.attempts=5;f.reserve();correctUnsentPlanningAttempts(task,f.store,f.directory);assert.equal(task.followup!.attempts,5,'unknown real request must never be erased');
  }finally{await f.close();}
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'budget-recovery-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const settings = f.vault.automation(), store = f.automationStore;
  const resource = store.saveResource({ name: 'Upgrade', scenario: 'upgrade', contentUrl: 'https://source.invalid', referenceUrl: 'https://reference.invalid', description: '', files: [], externalSource: '', externalId: '' });
  const create = (parentId?: string) => store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: '', requirements: '', parentId, optimization: parentId ? undefined : { targetScore: 85, maxRounds: 3, maxCostCny: null } }, settings)[0];
  const task = create();
  store.scheduleFollowup(task, settings.followup);
  task.status = 'interrupted'; task.stopped = true;
  task.followup!.tokens = 123; task.followup!.attempts = 2; task.followup!.elapsedMs = 456;
  task.followup!.threadId = 'original-followup';
  task.generation = { prepared: true, conversationId: randomUUID() };
  const site = { id: randomUUID(), resourceId: task.resourceId, versionId: task.versionId, environmentId: '', siteId: randomUUID(), name: 'Existing', url: 'https://generated.invalid/', createdAt: Date.now() };
  store.saveSite(site); task.generatedSiteId = site.id; task.siteUrl = site.url;
  store.put(task);
  const policy = { key: 'followup:' + task.followup!.budgetId, runKey: task.followup!.budgetId!, maxTokens: 1000000, maxRequests: 80 };
  const budget = new RequestBudget(store.db, policy);
  const reserve = (state: 'unknown' | 'active' = 'unknown') => {
    const id = randomUUID(); budget.reserve(id, Buffer.from('{}'));
    if (state === 'unknown') budget.complete(id, null);
    store.usage.record(task.id, { id, source: 'codex', stage: 'followup', model: 'test', endpoint: 'https://models.invalid', startedAt: 1, endedAt: 2, status: state === 'unknown' ? 'failed' : 'unknown', basis: 'request', raw: null });
    return id;
  };
  return { ...f, directory, store, task, headers, create, reserve, policy, budget, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('manual resume retains stopped unknown and orphaned active reservations and preserves task identity and budgets', async () => {
  for (const state of ['unknown', 'active'] as const) {
    const f = await fixture();
    try {
      const id = f.reserve(state), before = structuredClone(f.store.task(f.task.id)!), spent = f.budget.state().spent;
      const other = new RequestBudget(f.store.db, { ...f.policy, key: 'unrelated' });
      other.reserve('other', Buffer.from('{}')); other.complete('other', null);
      const result = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers });
      assert.equal(result.statusCode, 200, result.body);
      const saved = f.store.task(f.task.id)!;
      assert.equal(saved.status, 'following-up');
      for (const key of ['id', 'versionId', 'generatedSiteId', 'siteUrl', 'generation'] as const) assert.deepEqual(saved[key], before[key]);
      for (const key of ['budgetId', 'tokens', 'attempts', 'elapsedMs', 'threadId'] as const) assert.equal(saved.followup![key], before.followup![key]);
      assert.equal(f.store.db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get(id).state, 'retained');
      assert.equal(f.budget.state().spent, spent);
      assert.equal(f.budget.state().requests, 1); assert.equal(f.budget.state().unknown, 0);
      assert.equal(other.state().unknown, 1);
      const missing = f.store.usage.entries(f.task.id)[0]; assert.equal(missing.tokens, null); assert.equal(missing.cny, null);
      assert.match(f.store.events(f.task.id).map(e => e.message).join('\n'), /未知用量预占.*实际用量与费用仍待核算/);
      const events = f.store.events(f.task.id).length;
      assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers })).statusCode, 409);
      assert.equal(f.store.events(f.task.id).length, events);
      // The next relay/session can admit a new request, counting the old reservation.
      const next = new RequestBudget(f.store.db, f.policy); next.reserve('next', Buffer.from('{"input":"continue"}'));
      assert.ok(next.state().spent > spent); assert.equal(next.state().requests, 2);
    } finally { await f.close(); }
  }
});

test('manual resume also retains stopped planning requests without requiring a followup budget',async()=>{
  const f=await fixture();try{
    const task=f.store.task(f.task.id)!;delete task.followup;f.store.put(task);
    const budget=new RequestBudget(f.store.db,{key:'planning:'+task.id,runKey:task.id,maxTokens:1000000,maxRequests:80});
    const id=randomUUID();budget.reserve(id,Buffer.from('{}'));budget.complete(id,null);
    f.store.usage.record(task.id,{id,source:'codex',stage:'planning',model:'test',endpoint:'https://models.invalid',startedAt:1,endedAt:2,status:'failed',basis:'request',raw:null});
    const spent=budget.state().spent;
    const result=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/resume`,headers:f.headers});
    assert.equal(result.statusCode,200,result.body);assert.equal(budget.state().unknown,0);assert.equal(budget.state().spent,spent);assert.equal(f.store.usage.summary(task.id).missing,1);
  }finally{await f.close();}
});

test('resuming stopped template evaluation queues the executor without spending an exhausted followup window',async()=>{
  const f=await fixture();try{
    const task=f.store.task(f.task.id)!;task.kind='evaluation';task.scenario='site-template';task.followup!.attempts=task.followup!.policy.maxAttempts;f.store.put(task);
    const token=f.store.evaluations.begin(task.id);
    let result=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/resume`,headers:f.headers});assert.equal(result.statusCode,409);
    f.store.evaluations.finish(task.id,token,false);
    result=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/confirm-stopped`,headers:f.headers});assert.equal(result.statusCode,200,result.body);
    result=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/resume`,headers:f.headers});assert.equal(result.statusCode,200,result.body);
    const saved=f.store.task(task.id)!;assert.equal(saved.status,'queued');assert.equal(saved.followup!.attempts,saved.followup!.policy.maxAttempts);assert.equal(saved.followup!.tokens,123);assert.equal(saved.followup!.state,'resolved');
  }finally{await f.close();}
});

test('paused queue permits confirming an exited evaluation before its queued recovery guard has run',async()=>{
  const f=await fixture();try{
    const task=f.store.task(f.task.id)!;task.kind='evaluation';task.scenario='site-template';task.status='following-up';task.stopped=false;task.followup!.state='queued';task.followup!.executionStopped=false;
    const token=f.store.evaluations.begin(task.id);f.store.evaluations.finish(task.id,token,false);f.store.put(task);
    const confirmed=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/confirm-stopped`,headers:f.headers});assert.equal(confirmed.statusCode,200,confirmed.body);assert.equal(f.store.task(task.id)!.status,'interrupted');assert.equal(f.store.task(task.id)!.stopped,true);
    const resumed=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/resume`,headers:f.headers});assert.equal(resumed.statusCode,200,resumed.body);assert.equal(f.store.task(task.id)!.status,'queued');assert.equal(f.store.task(task.id)!.followup!.tokens,123);
  }finally{await f.close();}
});

test('retained estimates survive restart and still enforce token and request caps; real usage can reconcile them', () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-retained-')), path = join(directory, 'test.sqlite');
  let db = new Database(path);
  try {
    const policy = { key: 'followup', runKey: 'same', maxTokens: 10000, maxRequests: 1 };
    let budget = new RequestBudget(db, policy);
    budget.reserve('old', Buffer.from('{}')); budget.complete('old', null);
    const spent = budget.state().spent;
    retainRequestReservation(db, 'old'); retainRequestReservation(db, 'old');
    db.close(); db = new Database(path); budget = new RequestBudget(db, policy);
    assert.deepEqual(budget.state(), { spent, requests: 1, unknown: 0 });
    assert.throws(() => budget.reserve('extra', Buffer.from('{}')), /请求次数上限/);
    const capped = new RequestBudget(db, { ...policy, maxRequests: 10, maxTokens: spent });
    assert.throws(() => capped.reserve('extra', Buffer.from('{}')), /token 已达到预算上限/);
    budget.complete('old', { input_tokens: 100, output_tokens: 10 });
    assert.equal(budget.state().spent, 110);
    assert.equal(db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get('old').state, 'complete');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery rejects active execution and learning before altering reservations or optimization state', async () => {
  const f = await fixture();
  try {
    const id = f.reserve(), original = structuredClone(f.store.task(f.task.id)!);
    assert.throws(() => retainStoppedFollowupReservations(f.task, f.store, candidate => candidate === f.task.id), /已确认停止/);
    for (const activity of ['task', 'learning', 'delivery'] as const) {
      const sibling = f.create(f.task.id); sibling.stopped = activity !== 'task'; sibling.status = 'interrupted';
      if (activity === 'delivery') sibling.delivery = { stopped: false } as typeof sibling.delivery;
      f.store.put(sibling);
      const experiences = new ExperienceStore(f.store);
      const run = activity === 'learning' ? experiences.enqueue(f.task, 'followup', 'reflection', randomUUID()) : undefined;
      if (run) { run.status = 'running'; experiences.put(run); }
      const result = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(f.store.db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get(id).state, 'unknown');
      assert.deepEqual(f.store.task(f.task.id)!.optimization, original.optimization);
      sibling.stopped = true; if (sibling.delivery) sibling.delivery.stopped = true; f.store.put(sibling);
      if (run) { run.status = 'failed'; experiences.put(run); }
    }
    f.task.stopped = false; f.store.put(f.task);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers })).statusCode, 409);
  } finally { await f.close(); }
});

test('missing costs stay recorded without blocking approximate workflow spending', async () => {
  const f = await fixture();
  try {
    f.reserve();
    const task = f.store.task(f.task.id)!; assert.ok(task.optimization);
    task.optimization.policy.maxCostCny = 100; f.store.put(task);
    const result = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${task.id}/resume`, headers: f.headers });
    assert.equal(result.statusCode, 200);
    assert.equal(optimizationBudgetReason(f.store.task(task.id)!, f.store), '');
    assert.equal(f.store.usage.summary(task.id).missing, 1);
  } finally { await f.close(); }
});

test('cancelled tasks restart cleanly: never-started generations queue directly, delivered generations inspect via followup, and same-site conflicts or stale revisions reject', async () => {
  const f = await fixture();
  try {
    const fresh = f.store.create({ resourceIds: [f.task.resourceId], kind: 'generation', scope: 'homepage', environmentId: '', rootDomain: 'localkooboo.com', requirements: '' }, f.vault.automation())[0];
    const cancelled = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${fresh.id}/cancel`, headers: f.headers });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(f.store.task(fresh.id)!.status, 'cancelled');
    const restarted = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${fresh.id}/resume`, headers: f.headers });
    assert.equal(restarted.statusCode, 200, restarted.body);
    const savedFresh = f.store.task(fresh.id)!;
    assert.equal(savedFresh.status, 'queued');
    assert.equal(savedFresh.followup, undefined);
    assert.equal(savedFresh.generation?.rootDomain, 'localkooboo.com');

    // Delivered generation cancelled after stopping must go through followup inspection, never blind initial replay:
    const delivered = f.store.task(f.task.id)!;
    delivered.status = 'cancelled'; delivered.stopped = true;
    delivered.optimization!.state = 'stopped'; delivered.optimization!.stoppedAt = Date.now();
    delivered.generation = { prepared: true, createAttempted: true, deliveryId: randomUUID(), deliveryState: 'accepted', conversationId: randomUUID() };
    delete delivered.followup;
    f.store.put(delivered, true);

    // Conflict if another unstopped execution exists on the same site:
    const publishedRule = f.store.publish({ name: 'Rule', kind: 'site', scenarios: ['upgrade'], sop: 'check', references: '', criteria: [{ id: 'layout', label: 'Layout', weight: 100, instruction: 'check', required: true, viewports: ['desktop'], scopes: ['homepage'] }] });
    const blocker = f.store.create({ resourceIds: [f.task.resourceId], kind: 'evaluation', scope: 'homepage', environmentId: '', generatedSiteId: delivered.generatedSiteId!, ruleId: publishedRule.id, requirements: '' }, f.vault.automation())[0];
    blocker.status = 'running'; blocker.stopped = false; f.store.put(blocker);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${delivered.id}/resume`, headers: f.headers })).statusCode, 409);
    blocker.status = 'cancelled'; blocker.stopped = true; blocker.siteRevision = 'old-revision'; f.store.put(blocker);

    // Delivered generation resumes into following-up:
    const resumedDelivered = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${delivered.id}/resume`, headers: f.headers });
    assert.equal(resumedDelivered.statusCode, 200, resumedDelivered.body);
    assert.equal(f.store.task(delivered.id)!.status, 'following-up');
    const afterResume = f.store.task(delivered.id)!;
    afterResume.status = 'completed'; afterResume.stopped = true; afterResume.followup!.state = 'resolved';
    afterResume.optimization!.state = 'stopped'; afterResume.optimization!.stoppedAt = Date.now();
    afterResume.siteRevision = 'newer-revision'; f.store.beginSiteChange(afterResume); f.store.put(afterResume, true);

    // Stale cancelled evaluation cannot resume after siteRevision advanced:
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${blocker.id}/resume`, headers: f.headers })).statusCode, 409);
  } finally { await f.close(); }
});

test('resume detects running learning even without task reservations, and force resume or learning cancel interrupts and recovers', async () => {
  const f = await fixture();
  try {
    const experiences = new ExperienceStore(f.store);
    const run = experiences.enqueue(f.task, 'evaluation', 'reflection', randomUUID());
    run.status = 'running';
    experiences.put(run);

    // Summary surfaces active workflow learning:
    const summary = await f.app.inject({ method: 'GET', url: `/api/automation/tasks/${f.task.id}/summary`, headers: f.headers });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().workflowActive.learning, 1);

    // Normal resume detects running learning even though task has zero followup/planning reservations:
    const blocked = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.match(blocked.json().error, /同工作流仍有活动执行/);

    // Force resume interrupts running learning and resumes task:
    const forced = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${f.task.id}/resume`, headers: f.headers, payload: { force: true } });
    assert.equal(forced.statusCode, 200, forced.body);
    assert.equal(experiences.run(run.id)!.status, 'failed');
    assert.equal(f.store.task(f.task.id)!.status, 'following-up');

    // Individual learning cancel stops queued/running runs:
    const queued = experiences.enqueue(f.task, 'evaluation', 'reflection', randomUUID());
    const cancelled = await f.app.inject({ method: 'POST', url: `/api/automation/learning/${queued.id}/cancel`, headers: f.headers });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(experiences.run(queued.id)!.status, 'failed');
    assert.equal(cancelled.json().alreadyStopped, false);

    // Repeating cancel on an already-stopped run is idempotent instead of 409 erroring:
    const repeated = await f.app.inject({ method: 'POST', url: `/api/automation/learning/${queued.id}/cancel`, headers: f.headers });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().alreadyStopped, true);
  } finally { await f.close(); }
});

test('HTTP 402 billing failure interrupts immediately on attempt 1, skips automatic reflection without spawning workflow blockers, and deduplicates identical interruptions', async () => {
  const f = await fixture();
  try {
    const settings = f.vault.automation();
    f.vault.updateAutomation({ ...settings, enabled: true, autoEvaluate: false, learning: { ...settings.learning!, collect: true } });
    const experiences = new ExperienceStore(f.store);
    const homepageTask = f.store.create({
      resourceIds: [f.task.resourceId],
      kind: 'generation',
      scope: 'homepage',
      environmentId: '',
      requirements: '',
    }, f.vault.automation())[0];
    assert.equal(homepageTask.autonomy, undefined);

    let followupCalls = 0;
    let reflectionCalls = 0;
    const worker = new AutomationWorker(
      f.store,
      f.vault,
      f.directory,
      {
        generation: async () => { throw new Error('Kooboo 正在等待确认'); },
        evaluation: async () => {},
      },
      () => true,
      async () => {
        followupCalls++;
        throw new Error('模型服务拒绝请求（HTTP 402）；请检查模型账户余额、额度及服务配置后恢复。');
      },
      (async () => { reflectionCalls++; }) as typeof reflectExperience,
    );

    const waitIdle = async () => {
      for (let i = 0; i < 60; i++) {
        await worker.tick();
        if (!worker.ownedIds().length) {
          const cur = f.store.task(homepageTask.id)!;
          if (cur.stopped && !['queued', 'running', 'following-up'].includes(cur.status)) break;
        }
        await new Promise(r => setTimeout(r, 15));
      }
    };

    await waitIdle();
    const afterFirst402 = f.store.task(homepageTask.id)!;
    assert.equal(afterFirst402.status, 'interrupted');
    assert.equal(followupCalls, 1, 'must stop immediately on HTTP 402 instead of burning all 5 followup attempts');
    assert.equal(afterFirst402.followup!.attempts, 1);

    // Sync reflection candidates: automatic reflection must be recorded as skipped, never queued/running!
    syncReflectionCandidates(f.store, experiences);
    await worker.tick();
    assert.equal(reflectionCalls, 0, 'must not fire paid reflection model call on HTTP 402');
    const runs1 = experiences.runs(homepageTask.id, 1, 20).items.filter(r => r.kind === 'reflection');
    assert.equal(runs1.length, 1);
    assert.equal(runs1[0].status, 'completed');
    assert.match(runs1[0].reason, /^跳过复盘：/);

    // Summary must NOT report workflowActive:
    const summary = await f.app.inject({ method: 'GET', url: `/api/automation/tasks/${homepageTask.id}/summary`, headers: f.headers });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().workflowActive, undefined);

    // Even if re-interrupted at a later timestamp with the same reason, reflectionDataKey ignores volatile time:
    await new Promise(r => setTimeout(r, 5));
    f.store.interrupt(afterFirst402, {
      reason: afterFirst402.interruption!.reason,
      evidence: afterFirst402.interruption!.evidence,
      attempted: afterFirst402.interruption!.attempted,
      nextSteps: afterFirst402.interruption!.nextSteps,
      resumeFrom: afterFirst402.interruption!.resumeFrom,
    });
    syncReflectionCandidates(f.store, experiences);
    const runs2 = experiences.runs(homepageTask.id, 1, 20).items.filter(r => r.kind === 'reflection');
    assert.equal(runs2.length, 1, 'identical interruption with new timestamp must not spawn duplicate reflections');

    // Manual POST /reflect can still explicitly re-queue a skipped reflection after operator recharges:
    const manualReflect = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${homepageTask.id}/reflect`, headers: f.headers });
    assert.equal(manualReflect.statusCode, 200, manualReflect.body);
    assert.equal(manualReflect.json().queued, true);
    assert.equal(experiences.run(runs1[0].id)!.status, 'queued');
    await worker.stop();
  } finally { await f.close(); }
});

test('exhausted 5/5 non-autonomy homepage task with active + queued reflections recovers end-to-end via force resume without re-interrupting or spawning reflection loops', async () => {
  const f = await fixture();
  try {
    f.vault.updateAutomation({ ...f.vault.automation(), enabled: true, autoEvaluate: false });
    const experiences = new ExperienceStore(f.store);
    // Reproduce exact colleague state (Strips Outlet Utrecht: upgrade + generation + homepage, no autonomy, 5/5 attempts exhausted):
    const colleagueTask = f.store.create({
      resourceIds: [f.task.resourceId],
      kind: 'generation',
      scope: 'homepage',
      environmentId: '',
      requirements: '',
    }, f.vault.automation())[0];
    const site = { id: randomUUID(), resourceId: colleagueTask.resourceId, versionId: colleagueTask.versionId, environmentId: '', siteId: randomUUID(), name: 'StripsOutlet', url: 'https://strips.invalid/', createdAt: Date.now() };
    f.store.saveSite(site);
    colleagueTask.generatedSiteId = site.id;
    colleagueTask.siteUrl = site.url;
    colleagueTask.generation = { prepared: true, conversationId: randomUUID() };
    f.store.scheduleFollowup(colleagueTask, f.vault.automation().followup);
    const oldBudgetId = colleagueTask.followup!.budgetId!;
    colleagueTask.followup!.attempts = 5; // 5 / 5 exhausted!
    colleagueTask.followup!.elapsedMs = 36000;
    colleagueTask.followup!.tokens = 4800;
    colleagueTask.stopped = true;
    f.store.interrupt(colleagueTask, {
      reason: 'AI 跟进已达到配置的次数、时间或 token 预算，当前流程仍未完成。',
      evidence: [],
      attempted: [],
      nextSteps: ['查看 AI 跟进记录和原始问题；补齐条件或调整预算后点击“AI 接管 / 恢复”。'],
      resumeFrom: '沿用当前生成站、输入版本和已保存证据，从当前阶段继续。',
    });

    // Simulate 5 historical unknown requests in old followup budget + 1 running reflection + 2 queued reflections:
    const oldBudget = new RequestBudget(f.store.db, { key: 'followup:' + oldBudgetId, runKey: oldBudgetId, maxTokens: 10000000, maxRequests: 5 });
    for (let i = 0; i < 5; i++) {
      const reqId = randomUUID();
      oldBudget.reserve(reqId, Buffer.from(`{"attempt":${i}}`));
      oldBudget.complete(reqId, null);
      f.store.usage.record(colleagueTask.id, { id: reqId, source: 'codex', stage: 'followup', model: 'test', endpoint: 'https://models.invalid', startedAt: 1, endedAt: 2, status: 'failed', basis: 'request', raw: null, note: 'HTTP 402' });
    }
    const runningRef = experiences.enqueue(colleagueTask, 'followup', 'reflection', 'legacy-running-reflection');
    runningRef.status = 'running'; experiences.put(runningRef);
    const queuedRef1 = experiences.enqueue(colleagueTask, 'followup', 'reflection', 'legacy-queued-reflection-1');
    const queuedRef2 = experiences.enqueue(colleagueTask, 'followup', 'reflection', 'legacy-queued-reflection-2');
    const expBudget = new RequestBudget(f.store.db, { key: runningRef.budgetId, runKey: runningRef.id, maxTokens: 10000000, maxRequests: 20 });
    const expReqId = randomUUID();
    expBudget.reserve(expReqId, Buffer.from('{}'));

    // Summary reports 1 active learning blocker:
    const beforeSummary = await f.app.inject({ method: 'GET', url: `/api/automation/tasks/${colleagueTask.id}/summary`, headers: f.headers });
    assert.equal(beforeSummary.json().workflowActive.learning, 1);

    // Operator clicks 强制中断并恢复:
    const resumedRes = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${colleagueTask.id}/resume`,
      headers: f.headers,
      payload: { force: true },
    });
    assert.equal(resumedRes.statusCode, 200, resumedRes.body);

    // Running AND queued reflections in the workflow are all cancelled cleanly, and reservations are retained:
    assert.equal(experiences.run(runningRef.id)!.status, 'failed');
    assert.equal(experiences.run(queuedRef1.id)!.status, 'failed');
    assert.equal(experiences.run(queuedRef2.id)!.status, 'failed');
    assert.equal(f.store.db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get(expReqId).state, 'retained');

    // Cumulative counters are preserved while a new followup window is opened:
    const afterResume = f.store.task(colleagueTask.id)!;
    assert.equal(afterResume.status, 'following-up');
    assert.equal(afterResume.followup!.attempts, 5);
    assert.equal(afterResume.followup!.tokens, 4800);
    assert.equal(afterResume.followup!.elapsedMs, 36000);
    assert.notEqual(afterResume.followup!.budgetId, oldBudgetId);
    assert.equal(afterResume.followup!.window?.attemptsBase, 5);
    assert.equal(afterResume.followup!.window?.index, 1);

    // Now run the real AutomationWorker:
    // - Attempt 6 (1st in new window) fails transiently -> must NOT interrupt on attempts >= maxAttempts (old bug!), must retry in window!
    // - Attempt 7 (2nd in new window) returns retry -> generation runs and completes task!
    let windowFollowups = 0;
    let generationRuns = 0;
    let reflectionsRun = 0;
    const worker = new AutomationWorker(
      f.store,
      f.vault,
      f.directory,
      {
        generation: async (t, store) => {
          generationRuns++;
          t.generation = { ...t.generation, deliveryState: 'completed', state: 'completed' };
          store.put(t);
        },
        evaluation: async () => {},
      },
      () => true,
      async () => {
        windowFollowups++;
        if (windowFollowups === 1) throw new Error('偶发网络抖动，本轮窗口内应继续第 2 次跟进');
        return { action: 'retry', reason: 'API 额度已恢复，继续当前阶段生成', evidence: ['obs-1'] };
      },
      (async () => { reflectionsRun++; }) as typeof reflectExperience,
    );

    // Tick 1: runs followup attempt 6 (1st in new window), catches transient error, schedules waiting
    await worker.tick();
    for (let i = 0; i < 30 && worker.ownedIds().length; i++) await new Promise(r => setTimeout(r, 15));
    const midTask = f.store.task(colleagueTask.id)!;
    assert.equal(midTask.status, 'following-up', '1st transient failure in new window must stay following-up instead of interrupting at 6 >= 5');
    assert.equal(midTask.followup!.attempts, 6);
    midTask.followup!.nextAt = Date.now() - 1;
    f.store.put(midTask);

    // Tick 2+: runs followup attempt 7 -> queues generation -> completes generation!
    for (let i = 0; i < 60; i++) {
      await worker.tick();
      if (!worker.ownedIds().length && f.store.task(colleagueTask.id)!.status === 'completed') break;
      await new Promise(r => setTimeout(r, 15));
    }

    const completed = f.store.task(colleagueTask.id)!;
    assert.equal(completed.status, 'completed');
    assert.equal(completed.stopped, true);
    assert.equal(completed.followup!.attempts, 7);
    assert.equal(generationRuns, 1);
    assert.equal(reflectionsRun, 0);

    const finalSummary = await f.app.inject({ method: 'GET', url: `/api/automation/tasks/${colleagueTask.id}/summary`, headers: f.headers });
    assert.equal(finalSummary.json().workflowActive, undefined);
    await worker.stop();
  } finally { await f.close(); }
});

test('in-flight reflection owned by a live worker is aborted cleanly by both learning cancel and force resume, recording operator reason and alreadyStopped=false', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-live-cancel-'));
  let workerRef: AutomationWorker | undefined;
  const hangReflection = (async (run, _store, _vault, _dir, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    });
    run.status = 'completed';
  }) as typeof reflectExperience;
  const f = await createApp({
    directory,
    serveWeb: false,
    startWorker: false,
    createAutomationWorker: (store, vault, dir) => {
      workerRef = new AutomationWorker(
        store,
        vault,
        dir,
        { generation: async () => {}, evaluation: async () => {} },
        () => true,
        async () => ({ action: 'retry', reason: '继续', evidence: ['e1'] }),
        hangReflection,
      );
      return workerRef;
    },
  });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  try {
    const settings = f.vault.automation();
    f.vault.updateAutomation({ ...settings, enabled: true, autoEvaluate: false, learning: { ...settings.learning!, collect: true } });
    const store = f.automationStore, experiences = new ExperienceStore(store);
    const resource = store.saveResource({ name: 'LiveCancel', scenario: 'upgrade', contentUrl: 'https://source.invalid', referenceUrl: '', description: '', files: [], externalSource: '', externalId: '' });
    const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: '', requirements: '' }, f.vault.automation())[0];
    task.status = 'interrupted'; task.stopped = true;
    store.interrupt(task, { reason: '外部依赖暂时失败', evidence: [], attempted: [], nextSteps: ['恢复'], resumeFrom: '继续' });

    // 1) Let workerRef.tick() auto-enqueue and claim the real reflection, then cancel via /api/automation/learning/:id/cancel:
    await workerRef!.tick();
    const liveRuns = experiences.runs(task.id, 1, 10).items;
    assert.equal(liveRuns.length, 1);
    const liveRun1 = liveRuns[0];
    assert.equal(workerRef!.owns(liveRun1.id), true);
    assert.equal(experiences.run(liveRun1.id)!.status, 'running');

    const cancelRes = await f.app.inject({ method: 'POST', url: `/api/automation/learning/${liveRun1.id}/cancel`, headers });
    assert.equal(cancelRes.statusCode, 200, cancelRes.body);
    assert.equal(cancelRes.json().alreadyStopped, false);
    assert.equal(workerRef!.owns(liveRun1.id), false);
    assert.equal(experiences.run(liveRun1.id)!.status, 'failed');
    assert.equal(experiences.run(liveRun1.id)!.reason, '操作者已强制中断执行中的经验学习');

    // Subsequent tick must NOT re-enqueue a duplicate reflection for the same interruption:
    await workerRef!.tick();
    assert.equal(workerRef!.ownedIds().length, 0);

    // 2) Operator retries that reflection (/retry), worker claims it in-flight, then POST /tasks/:id/resume { force: true } aborts it and resumes task:
    const retryRes = await f.app.inject({ method: 'POST', url: `/api/automation/learning/${liveRun1.id}/retry`, headers, payload: { useCurrentPolicy: true } });
    assert.equal(retryRes.statusCode, 200, retryRes.body);
    await workerRef!.tick();
    assert.equal(workerRef!.owns(liveRun1.id), true);

    const forceRes = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${task.id}/resume`, headers, payload: { force: true } });
    assert.equal(forceRes.statusCode, 200, forceRes.body);
    assert.equal(workerRef!.owns(liveRun1.id), false);
    assert.equal(experiences.run(liveRun1.id)!.status, 'failed');
    assert.equal(experiences.run(liveRun1.id)!.reason, '操作者强制中断执行中的经验学习并恢复任务');
    assert.equal(store.task(task.id)!.status, 'following-up');
  } finally {
    await workerRef?.stop();
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('BackgroundWorkers IPC cancel awaits child-process settlement and immediately clears parent ownership before summary returns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-ipc-cancel-'));
  const entryPath = join(directory, 'mock-background-entry.mjs');
  writeFileSync(entryPath, `
    const owned = new Set(['ipc-learning-1']);
    const send = msg => { if (process.connected) process.send(msg); };
    send({ type: 'ownership', ids: [...owned] });
    send({ type: 'ready' });
    process.on('message', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'cancel') {
        setTimeout(() => {
          owned.delete(msg.id);
          send({ type: 'ownership', ids: [...owned] });
          if (msg.reqId) send({ type: 'cancelled', reqId: msg.reqId, ids: [...owned] });
        }, 60);
      }
      if (msg.type === 'stop') process.exit(0);
    });
  `);
  const f = await createApp({ directory, serveWeb: false, startWorker: true, backgroundEntry: pathToFileURL(entryPath) });
  try {
    assert.ok(f.automationWorker instanceof BackgroundWorkers);
    assert.equal(f.automationWorker.owns('ipc-learning-1'), true);
    await f.automationWorker.cancel('ipc-learning-1');
    assert.equal(f.automationWorker.owns('ipc-learning-1'), false, 'BackgroundWorkers.cancel must await IPC acknowledgement and update owned set');
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
