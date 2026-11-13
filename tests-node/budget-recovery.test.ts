import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Database } from '../server/runtime.js';
import { RequestBudget, retainRequestReservation } from '../server/automation/request-budget.js';
import { retainStoppedFollowupReservations, correctUnsentPlanningAttempts } from '../server/automation/budget-recovery.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { optimizationBudgetReason } from '../server/automation/optimization.js';

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
  } finally { await f.close(); }
});
