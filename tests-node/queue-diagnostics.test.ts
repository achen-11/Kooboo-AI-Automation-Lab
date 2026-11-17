import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { diagnoseQueue } from '../server/automation/queue-diagnostics.js';
import { defaultAutomationSettings, defaultDeliveryPolicy, defaultOptimizationPolicy, type AutomationTask } from '../shared/automation.js';
import { createAutonomousExecution } from '../shared/autonomy.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'queue-diagnostics-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const headers = { cookie: String((await f.app.inject({ method: 'POST', url: '/api/login' })).headers['set-cookie']).split(';')[0] };
  const environmentId = randomUUID(), settings = { ...defaultAutomationSettings, enabled: true, generationConcurrency: 1 };
  f.vault.update({threshold:80,paused:true,execution:{timeoutSeconds:300,captureAttempts:2},model:{endpoint:'https://model.invalid/v1',name:'fixture',apiKey:'synthetic-key'},environments:[{id:environmentId,name:'Fixture',origin:'https://kooboo.invalid',apiOrigin:'https://kooboo.invalid',token:'synthetic-token'}]});
  f.vault.updateAutomation(settings);
  const resource = f.automationStore.saveResource({ name: 'Synthetic homepage', scenario: 'materials', description: 'PRIVATE_INPUT_DO_NOT_RETURN', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
  const create = (extra: Partial<AutomationTask> = {}) => {
    const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId, requirements: 'PRIVATE_INPUT_DO_NOT_RETURN' }, settings)[0];
    Object.assign(task, extra); f.automationStore.put(task); return f.automationStore.task(task.id, false)!;
  };
  const inspect = (options: Partial<Parameters<typeof diagnoseQueue>[2]> = {}) => diagnoseQueue(f.automationStore, settings, { workerReady: true, maintenance: false, owns: () => false, page: 1, reservationPage: 1, pageSize: 10, ...options });
  return { ...f, directory, headers, environmentId, settings, resource, create, inspect, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('diagnostics reveal hidden global reservations and targeted confirmation releases capacity without replay', async () => {
  const f = await fixture();
  try {
    const old = f.create({ status: 'running', stopped: false, generation: { conversationId: 'original-chat', deliveryId: 'original-delivery', deliveryState: 'accepted' } });
    const waiting = f.create(); f.automationStore.recover();
    const before = f.automationStore.task(old.id, false)!;
    const tasksBefore = f.store.db.prepare('SELECT json FROM auto_tasks ORDER BY id').all();
    const key = readFileSync(join(f.directory, 'master.key')), settings = readFileSync(join(f.directory, 'settings.enc'));
    const value = f.inspect();
    assert.deepEqual(value.capacity.generation, { executing: 0, occupied: 1, unconfirmed: 1, limit: 1 });
    assert.equal(value.waiting.items[0].id, waiting.id); assert.equal(value.waiting.items[0].reason.code, 'capacity');
    assert.equal(value.waiting.items[0].reason.blockers[0].id, old.id);
    assert.equal(value.reservations.items[0].canConfirmStopped, true);
    assert.deepEqual(f.store.db.prepare('SELECT json FROM auto_tasks ORDER BY id').all(), tasksBefore);
    assert.deepEqual(readFileSync(join(f.directory, 'master.key')), key); assert.deepEqual(readFileSync(join(f.directory, 'settings.enc')), settings);
    assert.equal(f.automationStore.claim('generation', 1), undefined);
    const response = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${old.id}/confirm-stopped`, headers: f.headers, payload: { expectedUpdatedAt: before.updatedAt } });
    assert.equal(response.statusCode, 200, response.body);
    const after = f.automationStore.task(old.id, false)!;
    assert.equal(after.status, 'pending'); assert.equal(after.stopped, true); assert.deepEqual(after.generation, before.generation);
    assert.equal(after.versionId, before.versionId); assert.equal(after.scope, 'homepage');
    assert.equal(f.automationStore.tasks().length, 2); assert.equal(f.inspect().reservations.total, 0);
    assert.equal(f.automationStore.task(waiting.id, false)!.status, 'queued', 'confirmation does not itself claim or submit work');
    assert.equal(f.automationStore.claim('generation', 1)?.id, waiting.id);
  } finally { await f.close(); }
});

test('confirmation rejects stale snapshots and locally owned or running executions, while legacy calls remain valid', async () => {
  const f = await fixture();
  try {
    const task = f.create({ status: 'interrupted', stopped: false });
    const confirm = (payload?: {expectedUpdatedAt:number}) => f.app.inject({ method: 'POST', url: `/api/automation/tasks/${task.id}/confirm-stopped`, headers: f.headers, ...(payload === undefined ? {} : { payload }) });
    assert.equal((await confirm({ expectedUpdatedAt: task.updatedAt - 1 })).statusCode, 409);
    assert.equal(f.automationStore.task(task.id, false)!.stopped, false);
    f.automationWorker.owns = () => true;
    assert.equal(f.inspect({ owns: () => true }).reservations.total, 0);
    assert.equal((await confirm({ expectedUpdatedAt: task.updatedAt })).statusCode, 409);
    f.automationWorker.owns = () => false;
    task.status = 'running'; f.automationStore.put(task);
    assert.equal((await confirm()).statusCode, 409);
    const offline = f.inspect({workerReady:false});
    assert.equal(offline.capacity.generation.executing,0);assert.equal(offline.reservations.items[0].canConfirmStopped,false);
    task.status = 'interrupted'; f.automationStore.put(task);
    assert.equal((await confirm()).statusCode, 200);
  } finally { await f.close(); }
});

test('large reservation sets stay paginated and blocker links remain bounded', async () => {
  const f=await fixture();try{
    for(let i=0;i<13;i++)f.create({status:'interrupted',stopped:false});
    f.create();
    const value=f.inspect({reservationPage:2});
    assert.equal(value.reservations.total,13);assert.equal(value.reservations.items.length,3);
    assert.equal(value.waiting.items[0].reason.blockingCount,13);assert.equal(value.waiting.items[0].reason.blockers.length,10);
    assert.equal(f.inspect({reservationPage:99}).reservations.page,2);
  }finally{await f.close();}
});

test('readiness distinguishes pause, worker failure, maintenance, deferred retry and autonomy stop', async () => {
  const f = await fixture();
  try {
    const task = f.create(), code = (value: ReturnType<typeof f.inspect>) => value.waiting.items[0].reason.code;
    f.settings.enabled = false; assert.equal(code(f.inspect()), 'paused'); f.settings.enabled = true;
    assert.equal(code(f.inspect({ workerReady: false })), 'worker-unavailable');
    assert.equal(code(f.inspect({ maintenance: true })), 'maintenance');
    task.autonomy = createAutonomousExecution('Synthetic objective'); task.autonomy.checkpoint.nextAt = 2000; f.automationStore.put(task);
    assert.equal(code(f.inspect({ now: 1000 })), 'retry-delay'); assert.equal(f.inspect({ now: 1000 }).waiting.items[0].reason.nextAt, 2000);
    assert.equal(code(f.inspect({ now: 2000 })), 'ready');
    task.autonomy.stopReason = 'No progress'; f.automationStore.put(task);
    assert.equal(code(f.inspect({ now: 3000 })), 'autonomy-stopped');
    assert.equal(f.automationStore.claim('generation', 1, t => !t.autonomy?.stopReason), undefined);
  } finally { await f.close(); }
});

test('same-site locks and delivery reservations explain blocking without holding unrelated global capacity', async () => {
  const f = await fixture();
  try {
    const site = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.environmentId, siteId: randomUUID(), name: 'Fixture', url: 'https://fixture.invalid', createdAt: Date.now() };
    f.automationStore.saveSite(site);
    const task = f.create({ generatedSiteId: site.id, siteUrl: site.url });
    f.store.db.prepare('INSERT INTO auto_site_domain_locks VALUES(?,?,?)').run(site.id, 'fixture-owner', Date.now() + 60000);
    assert.equal(f.inspect().waiting.items[0].reason.code, 'domain'); assert.equal(f.automationStore.claim('generation', 1), undefined);
    f.store.db.prepare('DELETE FROM auto_site_domain_locks').run();
    f.store.db.prepare('INSERT INTO auto_migration_read_locks VALUES(?,?,?)').run(site.id, 'fixture-workflow', Date.now() + 60000);
    assert.equal(f.inspect().waiting.items[0].reason.code, 'migration-read'); assert.equal(f.automationStore.claim('generation', 1), undefined);
    f.store.db.prepare('DELETE FROM auto_migration_read_locks').run();
    const root=f.create({status:'completed',generatedSiteId:site.id});
    root.optimization={policy:defaultOptimizationPolicy,state:'planning',rounds:[{number:0,revision:'fixture-revision',generationTaskId:root.id,startedAt:Date.now()}],activeTaskId:root.id,currentRevision:'fixture-revision',reportId:null,noImprovement:0,reason:'',nextSteps:[],recoveryPolicy:f.settings.followup,threshold:80};
    f.automationStore.put(root);
    assert.equal(f.inspect().waiting.items[0].reason.code,'optimization');assert.equal(f.automationStore.claim('generation',1),undefined);
    root.optimization.state='stopped';f.automationStore.put(root);
    const delivery = f.create({ status: 'completed', generatedSiteId: site.id, delivery: { status: 'uncertain', stopped: false, policy: defaultDeliveryPolicy, error: 'Synthetic uncertainty' } as AutomationTask['delivery'] });
    const diagnostic = f.inspect();
    assert.equal(diagnostic.capacity.generation.occupied, 0); assert.equal(diagnostic.waiting.items[0].reason.code, 'site-busy');
    assert.equal(diagnostic.waiting.items[0].reason.blockers[0].id, delivery.id);
    assert.equal(diagnostic.reservations.items[0].target, 'delivery'); assert.equal(diagnostic.reservations.items[0].canConfirmStopped, true);
    assert.equal(f.automationStore.claim('generation', 1), undefined);
    const stale = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${delivery.id}/delivery/confirm-stopped`, headers: f.headers, payload: { expectedUpdatedAt: delivery.updatedAt - 1 } });
    assert.equal(stale.statusCode, 409); assert.equal(f.automationStore.task(delivery.id, false)!.delivery!.stopped, false);
    const confirm = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${delivery.id}/delivery/confirm-stopped`, headers: f.headers, payload: { expectedUpdatedAt: delivery.updatedAt } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(f.automationStore.task(delivery.id, false)!.delivery!.status, 'uncertain', 'confirmation must not resend an unknown migration');
    assert.equal(f.inspect().waiting.items[0].id, task.id); assert.equal(f.inspect().waiting.items[0].reason.code, 'site-busy', 'unknown migration receipt remains a site reservation even after local stop confirmation');
  } finally { await f.close(); }
});

test('diagnostics paginate compact data, omit private inputs, and summary polling never loads full tasks', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 13; i++) f.create();
    const original = f.automationStore.task.bind(f.automationStore); let reads = 0;
    f.automationStore.task = (...args) => { reads++; return original(...args); };
    const summary = f.inspect({ summaryOnly: true });
    assert.equal(reads, 0); assert.equal(summary.waiting.total, 13); assert.deepEqual(summary.waiting.items, []);
    const second = f.inspect({ page: 2 }); assert.equal(second.waiting.items.length, 3); assert.equal(reads, 3);
    assert.equal(f.inspect({ page: 99 }).waiting.page, 2);
    assert.equal(JSON.stringify(second).includes('PRIVATE_INPUT_DO_NOT_RETURN'), false);
    const response = await f.app.inject({ url: '/api/automation/queue-diagnostics?summaryOnly=1', headers: f.headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.json().workerReady, false);
    assert.equal((await f.app.inject({ url: '/api/automation/queue-diagnostics' })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/automation/queue-diagnostics', headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    for (const query of ['page=0', 'pageSize=101', 'reservationPage=-1', 'summaryOnly=yes']) assert.equal((await f.app.inject({ url: '/api/automation/queue-diagnostics?' + query, headers: f.headers })).statusCode, 400);
    const first=f.inspect().waiting.items[0].id;
    f.automationStore.task=(...args)=>args[0]===first?{...original(...args),status:'running' as const}:original(...args);
    assert.equal(f.inspect().waiting.items[0].reason.code,'state-changed');
  } finally { await f.close(); }
});

test('new materials and upgrade homepage tasks keep the stable release workflow and idempotency', async () => {
  const f = await fixture();
  try {
    for (const scenario of ['materials', 'upgrade'] as const) {
      const resource = f.automationStore.saveResource({ name: 'Synthetic ' + scenario, scenario, description: '', contentUrl: scenario === 'upgrade' ? 'https://source.invalid' : '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
      const headers = { ...f.headers, 'idempotency-key': randomUUID() }, payload = { resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, ...(scenario === 'upgrade' ? { optimization: { targetScore: 85, maxRounds: 2 } } : {}) };
      const a = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
      const b = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
      assert.equal(a.statusCode, 201, a.body); assert.deepEqual(a.json(), b.json());
      const task = a.json().items[0]; assert.equal(task.scope, 'homepage'); assert.equal(task.coordination, undefined);
      assert.equal(task.optimization?.policy.maxRounds, scenario === 'upgrade' ? 2 : undefined);
    }
    assert.equal(f.automationStore.tasks().length, 2);
  } finally { await f.close(); }
});
