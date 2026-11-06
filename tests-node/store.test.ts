import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as Thread } from 'node:worker_threads';
import { Store, Conflict, LostLease } from '../server/lib/store.js';
import { hashRule, listRules } from '../server/lib/rules.js';
import type { Submission } from '../shared/types.js';

function submission(id = 'attempt', occurredAt = 1): Submission {
  return { schemaVersion: 1, attemptId: id, requestId: id, jobId: 'batch-job', trigger: 'chat_stopped', occurredAt, target: { koobooOrigin: 'https://kooboo.test', siteId: 'generated-site' }, inputs: { referenceUrl: 'https://reference.test/' }, scope: 'homepage' };
}

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'evaluator-store-test-'));
  return { path, file: join(path, 'database.sqlite'), close() { rmSync(path, { recursive: true, force: true }); } };
}

/** Independent SQLite connections race across real threads after both finish initialization. */
function claimant(file: string, owner: string, gate: SharedArrayBuffer) {
  let ready!: () => void, failedReady!: (error: Error) => void;
  let completed!: (value: { owner: string; runId: string | null }) => void, failed!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failedReady = reject; });
  const result = new Promise<{ owner: string; runId: string | null }>((resolve, reject) => { completed = resolve; failed = reject; });
  const thread = new Thread(`
    const { workerData, parentPort } = require('node:worker_threads');
    require('tsx/cjs');
    const { Store } = require(workerData.module);
    const store = new Store(workerData.file);
    const gate = new Int32Array(workerData.gate);
    parentPort.postMessage({ type: 'ready' });
    Atomics.wait(gate, 0, 0);
    const job = store.claim(workerData.owner);
    store.close();
    parentPort.postMessage({ type: 'claimed', owner: workerData.owner, runId: job ? job.run.id : null });
  `, { eval: true, workerData: { file, owner, gate, module: fileURLToPath(new URL('../server/lib/store.ts', import.meta.url)) } });
  thread.on('message', message => { if (message.type === 'ready') ready(); else if (message.type === 'claimed') completed(message); });
  thread.on('error', error => { failedReady(error); failed(error); });
  thread.on('exit', code => { if (code) { const error = new Error(`claim thread exited with ${code}`); failedReady(error); failed(error); } });
  return { thread, started, result };
}

test('100 queued jobs survive reopening; simultaneous claims and stale owners are fenced', { timeout: 15000 }, async () => {
  const f = directory();
  let store: Store | undefined = new Store(f.file);
  const threads: Thread[] = [];
  try {
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push(store.accept(submission(`attempt-${i}`, i + 1)).evaluationId);
    store.close(); store = new Store(f.file);
    const jobs = store.list();
    assert.equal(jobs.length, 100); assert.ok(jobs.every(job => job.run.status === 'queued'));
    assert.deepEqual(jobs.map(job => job.submission.occurredAt), Array.from({ length: 100 }, (_, i) => 100 - i));

    const shared = new SharedArrayBuffer(4), gate = new Int32Array(shared);
    const first = claimant(f.file, 'concurrent-a', shared), second = claimant(f.file, 'concurrent-b', shared);
    threads.push(first.thread, second.thread);
    await Promise.all([first.started, second.started]);
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    const claims = await Promise.all([first.result, second.result]);
    const winners = claims.filter(claim => claim.runId !== null);
    assert.equal(winners.length, 1);
    const winner = winners[0], oldRun = store.get(ids[0])!.run;
    assert.equal(winner.runId, oldRun.id); assert.equal(oldRun.status, 'collecting');
    assert.equal(store.claim('third-owner'), null);

    store.db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(Date.now() - 1, oldRun.id);
    assert.equal(store.heartbeat(oldRun.id, winner.owner), false);
    const recovered = store.claim('recovery-owner')!;
    assert.equal(recovered.run.id, oldRun.id);
    assert.throws(() => store!.update(oldRun.id, winner.owner, { status: 'failed' }), LostLease);
    assert.equal(store.heartbeat(oldRun.id, winner.owner), false);
    assert.equal(store.heartbeat(oldRun.id, 'recovery-owner'), true);
    assert.ok(store.events(oldRun.id).some(event => event.message.includes('租约过期')));
    store.update(oldRun.id, 'recovery-owner', { status: 'completed' });
    const next = store.claim('next-owner')!;
    assert.equal(next.evaluation.id, ids[1]); assert.notEqual(next.run.id, oldRun.id);
    assert.equal(store.list().length, 100);
  } finally {
    await Promise.all(threads.map(thread => thread.terminate()));
    store?.close(); f.close();
  }
});

test('three lost leases stop automatic recovery and fence every previous owner', () => {
  const store = new Store(':memory:');
  try {
    const { evaluationId } = store.accept(submission());
    const first = store.claim('owner-1')!;
    for (let claim = 2; claim <= 3; claim++) {
      store.db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(Date.now() - 1, first.run.id);
      assert.equal(store.claim(`owner-${claim}`)!.run.id, first.run.id);
    }
    store.db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(Date.now() - 1, first.run.id);
    assert.equal(store.claim('owner-4'), null);
    const exhausted = store.get(evaluationId)!.run;
    assert.equal(exhausted.status, 'failed'); assert.match(exhausted.error!, /连续三次/);
    for (let owner = 1; owner <= 3; owner++) assert.throws(() => store.update(first.run.id, `owner-${owner}`, { status: 'completed' }), LostLease);
  } finally { store.close(); }
});

test('idempotency accepts exact duplicates and rejects changed submission or generated URL', () => {
  const store = new Store(':memory:');
  try {
    const input = submission(), url = 'https://ONE.example.test:8443/path';
    const first = store.accept(input, url), duplicate = store.accept(structuredClone(input), url);
    assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.evaluationId, first.evaluationId);
    assert.throws(() => store.accept({ ...input, jobId: 'different-job' }, url), Conflict);
    assert.throws(() => store.accept(input, 'https://different-generated.test/'), Conflict);
    assert.equal(store.list().length, 1); assert.equal(store.history(first.evaluationId).length, 1);
  } finally { store.close(); }
});

test('generated domain identity keeps same-domain history and separate generated subdomains', () => {
  const store = new Store(':memory:');
  try {
    const first = store.accept(submission('first', 1), 'https://ONE.example.test:8443/path');
    const second = store.accept(submission('second', 2), 'https://one.example.test/another-path');
    const third = store.accept(submission('third', 3), 'https://two.example.test/');
    assert.equal(store.get(first.evaluationId)!.siteDomain, 'one.example.test');
    assert.equal(store.list().length, 3); assert.equal(store.list(80, true).length, 2);
    assert.deepEqual(store.siteHistory('ONE.example.test.').map(job => job.id), [second.evaluationId, first.evaluationId]);
    assert.deepEqual(store.siteHistory('two.example.test').map(job => job.id), [third.evaluationId]);
    assert.equal(store.siteHistory('reference.test').length, 0);
    const job = store.claim('owner')!;
    assert.throws(() => store.bindSite(job.evaluation.id, 'different.example.test', job.run.id, 'owner'), Conflict);
    assert.equal(store.get(first.evaluationId)!.siteDomain, 'one.example.test');
  } finally { store.close(); }
});

test('draft revisions reject stale edits/publication and publication rolls back atomically on SQL failure', () => {
  const store = new Store(':memory:'), seed = listRules()[0];
  try {
    store.registerRule(seed.rule.version, seed.hash, seed.rule);
    const draft = store.createDraft({ ...seed.rule, version: 'visual-next' });
    const changed = store.saveDraft(draft.id, draft.revision, { ...draft.rule, name: 'Updated draft' });
    assert.equal(changed.revision, draft.revision + 1);
    assert.throws(() => store.saveDraft(draft.id, draft.revision, draft.rule), Conflict);
    assert.throws(() => store.publishDraft(draft.id, draft.revision), Conflict);
    assert.equal(store.draft(draft.id)!.rule.name, 'Updated draft');

    store.db.exec(`CREATE TRIGGER fail_publication BEFORE UPDATE OF published_at ON rule_drafts
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
    assert.throws(() => store.publishDraft(changed.id, changed.revision), /injected publication failure/);
    assert.equal(store.getRule('visual-next'), null);
    const rolledBack = store.draft(draft.id)!;
    assert.equal(rolledBack.publishedAt, null); assert.equal(rolledBack.revision, changed.revision);
    assert.equal(store.rules().length, 1);
    store.db.exec('DROP TRIGGER fail_publication');

    const published = store.publishDraft(changed.id, changed.revision);
    assert.equal(published.rule.name, 'Updated draft');
    assert.equal(published.hash, hashRule(published.rule));
    assert.equal(store.getRule('visual-next')!.rule.name, 'Updated draft');
    const finished = store.draft(draft.id)!;
    assert.notEqual(finished.publishedAt, null); assert.equal(finished.revision, changed.revision + 1);
    assert.equal(store.drafts().some(item => item.id === draft.id), false);
    assert.throws(() => store.saveDraft(finished.id, finished.revision, finished.rule), Conflict);
    assert.throws(() => store.publishDraft(finished.id, finished.revision), Conflict);
  } finally { store.close(); }
});

test('published versions cannot be overwritten and duplicate-version publication leaves its draft intact', () => {
  const store = new Store(':memory:'), seed = listRules()[0];
  try {
    store.registerRule(seed.rule.version, seed.hash, seed.rule);
    const changed = { ...seed.rule, name: 'Attempted replacement' };
    assert.throws(() => store.registerRule(seed.rule.version, hashRule(changed), changed), Conflict);
    assert.deepEqual(store.getRule(seed.rule.version), seed);
    const draft = store.createDraft(changed);
    assert.throws(() => store.publishDraft(draft.id, draft.revision), Conflict);
    assert.equal(store.draft(draft.id)!.publishedAt, null);
    assert.equal(store.draft(draft.id)!.revision, draft.revision);
    assert.deepEqual(store.getRule(seed.rule.version), seed);
    const detached = store.getRule(seed.rule.version)!;
    detached.rule.dimensions[0].instruction = 'Mutated caller object';
    assert.equal(store.getRule(seed.rule.version)!.hash, seed.hash);
    assert.deepEqual(store.getRule(seed.rule.version)!.rule, seed.rule);
  } finally { store.close(); }
});
