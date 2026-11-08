import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Database } from '../server/runtime.js';
import { RequestBudget, retainRequestReservation } from '../server/automation/request-budget.js';
import { retainStoppedFollowupReservations } from '../server/automation/budget-recovery.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { optimizationBudgetReason } from '../server/automation/optimization.js';

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
  return { ...f, store, task, headers, create, reserve, policy, budget, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
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

test('retaining unknown requests never hides missing costs or bypasses a workflow monetary cap', async () => {
  const f = await fixture();
  try {
    f.reserve();
    const task = f.store.task(f.task.id)!; assert.ok(task.optimization);
    task.optimization.policy.maxCostCny = 100; f.store.put(task);
    const result = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${task.id}/resume`, headers: f.headers });
    assert.equal(result.statusCode, 200);
    assert.match(optimizationBudgetReason(f.store.task(task.id)!, f.store), /费用尚未完整核算/);
    assert.equal(f.store.usage.summary(task.id).missing, 1);
  } finally { await f.close(); }
});
