import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultFollowupSettings, defaultOptimizationPolicy } from '../shared/automation.js';
import type { GenerationDelivery } from '../shared/generation-delivery.js';
import { archiveDeliveryImages, GenerationDeliveryStore, readDeliveryImage } from '../server/automation/generation-delivery.js';
import { GenerationContextStore } from '../server/automation/generation-context.js';
import { executeGeneration } from '../server/automation/generator.js';
import { validateFollowupAction } from '../server/automation/followup.js';
import type { GenerationObservation, generationSession } from '../server/automation/generation-session.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'generation-delivery-'));
  const services = await createApp({ directory, startWorker: false, serveWeb: false });
  const store = services.automationStore, deliveries = new GenerationDeliveryStore(store), environmentId = randomUUID();
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  services.vault.update({ ...services.vault.get(), environments: [{ id: environmentId, name: 'Test', origin: 'https://kooboo.test', apiOrigin: 'https://kooboo.test', token: 'fixture-environment-token' }] });
  const resource = store.saveResource({ name: 'Site', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalId: '', externalSource: '' });
  const site = { id: randomUUID(), siteId: randomUUID(), resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId, name: 'Generated', url: '', createdAt: Date.now() };
  store.saveSite(site);
  const create = () => {
    const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId, generatedSiteId: site.id, requirements: '完整要求😀\n保留换行' }, structuredClone(defaultAutomationSettings))[0];
    task.requirementsEnabled = false; task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
    task.generation = { prepared: true, conversationId: randomUUID() }; store.put(task); return task;
  };
  const task = create();
  const record = (patch: Partial<GenerationDelivery> = {}): GenerationDelivery => ({ id: randomUUID(), taskId: task.id, versionId: task.versionId, siteId: site.siteId, conversationId: task.generation!.conversationId!, createdAt: Date.now(), kind: 'initial', state: 'prepared', text: '实际原文😀\n第二行', textBytes: Buffer.byteLength('实际原文😀\n第二行'), images: [], ...patch });
  const observation = (value: GenerationDelivery, patch: Partial<GenerationObservation> = {}): GenerationObservation => ({ version: 1, taskId: value.taskId, siteId: value.siteId, conversationId: value.conversationId, runId: 'new-run', ready: true, running: false, state: 'completed', observedAt: Date.now(), pending: null, context: [], delivery: { id: value.id, state: 'accepted', conversationId: value.conversationId }, outcome: { conversationId: value.conversationId, runId: 'new-run', status: 'completed', time: Date.now() }, ...patch });
  return { ...services, store, deliveries, directory, headers, task, create, record, observation, site, async close() { await services.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('immutable snapshots survive checkpoint and template edits; summaries omit payloads', async () => {
  const f = await fixture();
  try {
    const value = f.record(); f.deliveries.archive(value);
    const next = f.record({ kind: 'continue', text: '下一轮', createdAt: value.createdAt + 1 }); f.deliveries.archive(next);
    f.task.message = '后来更改的要求'; f.task.context = '只剩末尾摘要'; f.task.generation!.deliveryId = next.id; f.store.put(f.task);
    const reopened = new GenerationDeliveryStore(f.store);
    assert.equal(reopened.get(value.id)!.text, value.text);
    assert.throws(() => reopened.archive({ ...value, text: '覆盖历史' }), /不能覆盖/);
    assert.deepEqual(reopened.list(f.task.id).map(item => item.id), [next.id, value.id]);
    assert.equal('text' in reopened.list(f.task.id)[0], false);
    assert.equal('answer' in reopened.list(f.task.id)[0], false);
  } finally { await f.close(); }
});

test('uncertain delivery is reconciled only by matching receipts, and terminal history stays pinned to its run', async () => {
  const f = await fixture();
  try {
    const value = f.record({ previousRunId: 'old-run' }); f.deliveries.archive(value); f.deliveries.sending(value.id);
    assert.equal(f.deliveries.get(value.id)!.state, 'unknown');
    f.deliveries.observe(f.observation(value, { taskId: randomUUID() }));
    f.deliveries.observe(f.observation(value, { siteId: randomUUID() }));
    f.deliveries.observe(f.observation(value, { delivery: { id: randomUUID(), state: 'accepted', conversationId: value.conversationId } }));
    assert.equal(f.deliveries.get(value.id)!.state, 'unknown');
    f.deliveries.observe(f.observation(value, { runId: 'old-run', outcome: { conversationId: value.conversationId, runId: 'old-run', status: 'completed', time: 1 } }));
    assert.equal(f.deliveries.get(value.id)!.state, 'accepted', 'prior terminal run cannot finish a new delivery');
    f.deliveries.observe(f.observation(value));
    assert.equal(f.deliveries.get(value.id)!.state, 'completed'); assert.equal(f.deliveries.get(value.id)!.runId, 'new-run');
    f.deliveries.accept(value.id, value.conversationId);
    f.deliveries.observe(f.observation(value, { runId: 'unrelated-manual-run', state: 'failed', outcome: { conversationId: value.conversationId, runId: 'unrelated-manual-run', status: 'failed', time: 2 } }));
    assert.equal(f.deliveries.get(value.id)!.state, 'completed');
    assert.equal(f.deliveries.get(value.id)!.text, value.text);
  } finally { await f.close(); }
});

test('authenticated APIs separate summaries, exact payload and archived sections; legacy packages never fabricate a delivery', async () => {
  const f = await fixture();
  try {
    const registry = new GenerationContextStore(f.store), sections = { instructions: '原始完整要求', guidance: '执行约束', materials: [], manifest: { evidence: ['missing-source.json'], items: [{ id: 'home' }] } };
    const pkg = registry.archive(f.task, f.site.siteId, sections), base = `/api/automation/tasks/${f.task.id}`;
    let response = await f.app.inject({ url: base + '/generation-deliveries', headers: f.headers });
    assert.deepEqual(response.json().items, []); assert.equal(response.json().packages[0].id, pkg.id);
    assert.equal(response.json().packages[0].original, undefined);
    const value = f.record({ packageId: pkg.id }); f.deliveries.archive(value);
    response = await f.app.inject({ url: base + '/generation-deliveries', headers: f.headers });
    assert.equal(response.json().items[0].text, undefined);
    response = await f.app.inject({ url: base + '/generation-deliveries/' + value.id, headers: f.headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().text, value.text);
    response = await f.app.inject({ url: base + '/generation-context/' + pkg.id, headers: f.headers });
    assert.deepEqual(response.json().sections, sections);
    for (const path of ['/generation-deliveries', '/generation-deliveries/' + value.id, '/generation-context/' + pkg.id]) {
      assert.equal((await f.app.inject({ url: base + path })).statusCode, 401);
    }
    const other = f.create();
    for (const path of ['/generation-deliveries/' + value.id, '/generation-context/' + pkg.id]) {
      assert.equal((await f.app.inject({ url: `/api/automation/tasks/${other.id}` + path, headers: f.headers })).statusCode, 409);
    }
    assert.equal(f.deliveries.get(value.id)!.text, value.text);
  } finally { await f.close(); }
});

test('image snapshots preserve the exact bytes without base64 in API payloads and reject corruption or cross-task access', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const images = archiveDeliveryImages(f.directory, [{ uri: 'data:image/png;base64,' + bytes.toString('base64'), mediaType: 'image/png' }]);
    assert.deepEqual(archiveDeliveryImages(f.directory, [{ uri: 'data:image/png;base64,' + bytes.toString('base64'), mediaType: 'image/png' }]), images);
    const value = f.record({ images }); f.deliveries.archive(value);
    const path = `/api/automation/tasks/${f.task.id}/generation-deliveries/${value.id}/images/0`;
    const response = await f.app.inject({ url: path, headers: f.headers });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['content-type'], 'image/png'); assert.deepEqual(response.rawPayload, bytes);
    assert.equal(JSON.stringify(f.deliveries.get(value.id)).includes('base64'), false);
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path.replace(f.task.id, f.create().id), headers: f.headers })).statusCode, 409);
    writeFileSync(join(f.directory, 'generation-delivery-images', images[0].sha256 + '.png'), 'changed');
    assert.throws(() => readDeliveryImage(f.directory, images[0]), /校验失败/);
  } finally { await f.close(); }
});

test('optimization roots include child deliveries and their packages while child views remain scoped', async () => {
  const f = await fixture();
  try {
    const child = f.create(), pkg = new GenerationContextStore(f.store).archive(child, f.site.siteId, { instructions: '本轮修复' });
    const initial = f.record(), repair = f.record({ taskId: child.id, versionId: child.versionId, kind: 'repair', packageId: pkg.id, text: '修复原文', createdAt: initial.createdAt + 1 });
    f.deliveries.archive(initial); f.deliveries.archive(repair);
    f.task.optimization = { policy: defaultOptimizationPolicy, state: 'repairing', rounds: [{ number: 1, revision: 'revision', generationTaskId: child.id, startedAt: 1 }], activeTaskId: child.id, currentRevision: 'revision', reportId: null, noImprovement: 0, reason: '', nextSteps: [], recoveryPolicy: defaultFollowupSettings, threshold: 85 };
    f.store.put(f.task);
    const root = `/api/automation/tasks/${f.task.id}`, childBase = `/api/automation/tasks/${child.id}`;
    const list = (await f.app.inject({ url: root + '/generation-deliveries', headers: f.headers })).json();
    assert.deepEqual(list.items.map((item: GenerationDelivery) => item.id), [repair.id, initial.id]);
    assert.equal((await f.app.inject({ url: root + '/generation-deliveries/' + repair.id, headers: f.headers })).json().text, '修复原文');
    assert.equal((await f.app.inject({ url: root + '/generation-context/' + pkg.id, headers: f.headers })).json().sections.instructions, '本轮修复');
    assert.equal((await f.app.inject({ url: childBase + '/generation-deliveries/' + initial.id, headers: f.headers })).statusCode, 409);
  } finally { await f.close(); }
});

test('the real generator persists the exact send before transport and reconciles a failed accepted run after restart without replay', async () => {
  const f = await fixture();
  try {
    let delivered: Parameters<Awaited<ReturnType<typeof generationSession>>['deliver']>[0] | undefined, sends = 0;
    const session: typeof generationSession = async () => ({
      snapshot: async () => f.observation(f.record({ id: delivered?.id || randomUUID() }), delivered ? { state: 'failed', outcome: { conversationId: f.task.generation!.conversationId!, runId: 'new-run', status: 'failed', time: Date.now() } } : { runId: 'old-run', state: 'unknown', delivery: undefined, outcome: undefined }),
      deliver: async payload => {
        sends++; delivered = payload;
        const saved = f.deliveries.get(payload.id)!;
        assert.equal(saved.state, 'unknown'); assert.equal(saved.text, payload.text); assert.equal(saved.conversationId, payload.conversationId);
        assert.ok(saved.packageId); assert.ok(saved.attemptedAt);
        assert.equal(JSON.parse(new GenerationContextStore(f.store).packages(f.task.id)[0].original).instructions, f.task.message);
        throw new Error('connection lost after send');
      }, close: async () => {},
    });
    await assert.rejects(executeGeneration(f.task, f.store, f.vault, f.directory, AbortSignal.timeout(3000), session), /connection lost/);
    assert.equal(f.deliveries.get(delivered!.id)!.state, 'unknown');
    const restored = f.store.task(f.task.id)!;
    await assert.rejects(executeGeneration(restored, f.store, f.vault, f.directory, AbortSignal.timeout(3000), session), /结果为 failed/);
    assert.equal(sends, 1); assert.equal(f.deliveries.get(delivered!.id)!.state, 'failed');
    assert.equal(f.deliveries.get(delivered!.id)!.text, delivered!.text);
  } finally { await f.close(); }
});

test('pending tool answers are archived with call identity and never mislabeled as text prompts', async () => {
  const f = await fixture();
  try {
    const answer = { approved: true, fields: ['中文', 'two'] }, callId = randomUUID();
    f.task.generation = { prepared: true, conversationId: f.task.generation!.conversationId, deliveryId: randomUUID(), deliveryState: 'accepted', previousRunId: 'prior-run', next: { action: 'answer', reason: 'confirmed', evidence: [], answer, callId } };
    f.store.put(f.task);
    const session: typeof generationSession = async () => ({
      snapshot: async () => f.observation(f.record(), { state: 'waiting', pending: { callId, name: 'ask_user', args: {} }, outcome: undefined }),
      deliver: async payload => { const saved = f.deliveries.get(payload.id)!; assert.equal(saved.kind, 'answer'); assert.deepEqual(saved.answer, answer); assert.equal(saved.callId, callId); assert.equal(saved.text, undefined); assert.equal(saved.packageId, undefined); throw new Error('stop after inspection'); },
      close: async () => {},
    });
    await assert.rejects(executeGeneration(f.task, f.store, f.vault, f.directory, AbortSignal.timeout(3000), session), /stop after inspection/);
    assert.equal(f.deliveries.list(f.task.id).length, 1);
  } finally { await f.close(); }
});

test('pre-flight Conversation is not ready never leaves a deadlocked sending lock, while post-send disconnects keep anti-replay protection', async () => {
  const f = await fixture();
  try {
    const priorId = randomUUID(), callId = 'call_00_J1jm3Qb7Uq5YwaRkrzNL0679', answer = { useSandbox: true };
    f.task.generation = { prepared: true, conversationId: f.task.generation!.conversationId, deliveryId: priorId, deliveryState: 'accepted', previousRunId: 'run-1', next: { action: 'answer', reason: 'confirm sandbox', evidence: [], answer, callId } };
    f.store.put(f.task);

    // 1. Explicit canSend=false stops before archiving or mutating deliveryState.
    const blockedSession: typeof generationSession = async () => ({
      snapshot: async () => f.observation(f.record({ id: priorId }), { state: 'waiting', canSend: false, pending: { callId, name: 'ask_user_input', args: {} }, outcome: undefined }),
      deliver: async () => { throw new Error('must not be called when canSend=false'); },
      close: async () => {},
    });
    await assert.rejects(executeGeneration(f.task, f.store, f.vault, f.directory, AbortSignal.timeout(3000), blockedSession), /canSend=false/);
    assert.equal(f.task.generation.deliveryId, priorId);
    assert.equal(f.task.generation.deliveryState, 'accepted');
    assert.equal(f.task.generation.next?.action, 'answer');
    assert.equal(f.deliveries.list(f.task.id).length, 0);

    // 2. Race where bridge throws "Conversation is not ready" before saving localStorage rolls back cleanly.
    let raceAttempt = 0, acceptedId = '';
    const raceSession: typeof generationSession = async () => ({
      snapshot: async () => acceptedId
        ? f.observation(f.record({ id: acceptedId }), { runId: 'run-2', state: 'failed', canSend: true, outcome: { conversationId: f.task.generation!.conversationId!, runId: 'run-2', status: 'failed', time: Date.now() } })
        : f.observation(f.record({ id: priorId }), { state: 'waiting', canSend: true, pending: { callId, name: 'ask_user_input', args: {} }, outcome: undefined }),
      deliver: async payload => {
        if (++raceAttempt === 1) throw new Error('page.evaluate: Error: Conversation is not ready');
        acceptedId = payload.id;
        return { id: payload.id, state: 'accepted', conversationId: f.task.generation!.conversationId! };
      },
      close: async () => {},
    });
    await assert.rejects(executeGeneration(f.task, f.store, f.vault, f.directory, AbortSignal.timeout(3000), raceSession), /Conversation is not ready/);
    assert.equal(f.task.generation.deliveryId, priorId);
    assert.equal(f.task.generation.deliveryState, 'accepted');
    assert.equal(f.task.generation.next?.action, 'answer');
    const rejected = f.deliveries.list(f.task.id)[0];
    assert.equal(rejected.state, 'failed');
    assert.match(rejected.preSendRejectedError || '', /Conversation is not ready/);

    // Retry immediately delivers the preserved answer receipt.
    await assert.rejects(executeGeneration(f.task, f.store, f.vault, f.directory, AbortSignal.timeout(3000), raceSession), /结果为 failed/);
    assert.equal(f.task.generation.deliveryId, acceptedId);
    assert.equal(f.task.generation.deliveryState, 'accepted');

    // 3. Disconnect after send (without pre-send rejection) MUST NOT unlock sending even if bridge shows priorId and pending callId.
    const disconnectedTask = f.create();
    let disconnectSends = 0, uncertainId = '';
    disconnectedTask.generation = { prepared: true, conversationId: disconnectedTask.generation!.conversationId, deliveryId: priorId, deliveryState: 'accepted', previousRunId: 'run-1', next: { action: 'answer', reason: 'confirm sandbox', evidence: [], answer, callId } };
    f.store.put(disconnectedTask);
    const disconnectSession: typeof generationSession = async () => ({
      snapshot: async () => f.observation(f.record({ id: priorId, taskId: disconnectedTask.id, conversationId: disconnectedTask.generation!.conversationId! }), { state: 'waiting', canSend: true, pending: { callId, name: 'ask_user_input', args: {} }, outcome: undefined }),
      deliver: async payload => { disconnectSends++; uncertainId = payload.id; throw new Error('connection lost after send'); },
      close: async () => {},
    });
    await assert.rejects(executeGeneration(disconnectedTask, f.store, f.vault, f.directory, AbortSignal.timeout(3000), disconnectSession), /connection lost after send/);
    assert.equal(disconnectedTask.generation.deliveryId, uncertainId);
    assert.equal(disconnectedTask.generation.deliveryState, 'sending');
    assert.equal(f.deliveries.get(uncertainId)?.state, 'unknown');

    disconnectedTask.stopped = true;
    f.store.scheduleFollowup(disconnectedTask, defaultFollowupSettings);
    const obs = new Set(['obs-exec', 'obs-conv']);
    const liveExec = f.observation(f.record({ id: priorId, taskId: disconnectedTask.id, conversationId: disconnectedTask.generation.conversationId! }), { state: 'waiting', canSend: true, pending: { callId, name: 'ask_user_input', args: {} }, outcome: undefined });
    assert.throws(() => validateFollowupAction({ action: 'answer', reason: 'must stay blocked on uncertain send', evidence: ['obs-exec', 'obs-conv'], callId, answer }, disconnectedTask, {
      execution: liveExec,
      conversation: { conversationId: disconnectedTask.generation!.conversationId!, messageCount: 2, pendingCalls: [{ callId, name: 'ask_user_input' }], lastRole: 'assistant', finalText: '', messages: [] },
    }, obs), /原发送结果仍不确定/);
    await assert.rejects(executeGeneration(disconnectedTask, f.store, f.vault, f.directory, AbortSignal.timeout(3000), disconnectSession), /上一次发送结果不确定/);
    assert.equal(disconnectSends, 1);
    assert.equal(f.deliveries.get(uncertainId)?.state, 'unknown');
  } finally { await f.close(); }
});
