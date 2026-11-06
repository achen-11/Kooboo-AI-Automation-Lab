import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../server/worker.js';
import { Store } from '../server/lib/store.js';
import { Vault } from '../server/lib/vault.js';
import { Artifacts } from '../server/lib/artifacts.js';
import { listRules } from '../server/lib/rules.js';
import { collectorVersion, type CollectionInput } from '../server/lib/collector.js';
import { scoringReadiness, type scoreEvidence } from '../server/lib/scorer.js';
import { loadSop } from '../server/lib/sop.js';
import type { Evidence, Pipeline, Report, RuntimeSettings } from '../shared/types.js';

type Role = 'target' | 'reference';
type CaptureCall = { role: Role; viewport: string; runId: string };
type ScoreCall = { runId: string; model: RuntimeSettings['model']; evidence: Evidence; calledModel: boolean };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'evaluator-worker-test-'));
  const store = new Store(join(directory, 'database.sqlite'));
  const vault = new Vault(directory), artifacts = new Artifacts(store.db);
  vault.update({ ...vault.get(), execution: { timeoutSeconds: 30, captureAttempts: 1 }, model: { endpoint: 'https://model.test/v1', name: 'initial-model', apiKey: 'private-test-key' } });
  const { rule, hash } = listRules()[0]; store.registerRule(rule.version, hash, rule);
  const { evaluationId } = store.accept({ schemaVersion: 1, attemptId: 'attempt', requestId: 'request', jobId: 'job', trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: 'https://kooboo.test', siteId: 'site' }, inputs: { referenceUrl: 'https://reference.test/' }, scope: 'homepage', ruleSetVersion: rule.version }, 'https://generated.test/');
  const calls: CaptureCall[] = [], scores: ScoreCall[] = [], inspected: string[] = [];
  let resolutions = 0;
  const failures = new Set<string>();
  const state = { hang: undefined as ((input: CollectionInput) => Promise<Evidence>) | undefined };
  const collect = async (input: CollectionInput): Promise<Evidence> => {
    const role = input.roles![0], viewport = input.rule.viewports[0];
    calls.push({ role, viewport: viewport.id, runId: input.runId });
    if (state.hang) return state.hang(input);
    if (failures.has(role) || failures.has(`${role}-${viewport.id}`)) throw new Error(`${role} ${viewport.id} simulated timeout`);
    return collected(input);
  };
  const collected = async (input: CollectionInput): Promise<Evidence> => {
    const role = input.roles![0], viewport = input.rule.viewports[0], id = `${role}-${viewport.id}-top`, file = `${id}.png`;
    const content = Buffer.from(`saved pixels ${input.runId} ${id}`).toString('base64');
    input.artifacts.save(input.evaluationId, input.runId, file, content);
    const evidence: Evidence = {
      targetUrl: input.targetUrl, targetTitle: 'Rendered page', text: 'Actual rendered content', readme: null,
      screenshots: [{ id, file, role, viewport: viewport.id, region: 'top', url: role === 'target' ? input.targetUrl : input.referenceUrl!, capturedAt: Date.now(), width: viewport.width, height: viewport.height, captureMethod: 'playwright' }],
      health: 'ok', issues: [], fingerprint: 'stable-page', stable: true,
      coverage: { requested: 'homepage', actual: 'homepage', complete: true, note: 'Full page' },
    };
    if (input.review) assert.equal((await input.review(evidence)).usable, true);
    input.onCheckpoint?.();
    input.onProgress?.(`${role} ${viewport.id} checkpoint saved`, evidence);
    return evidence;
  };
  const score: typeof scoreEvidence = async (evidence, selectedRule, model, id, runId, _timeout, files): Promise<Report> => {
    const ready = scoringReadiness(evidence, selectedRule);
    scores.push({ runId, model: structuredClone(model), evidence: structuredClone(evidence), calledModel: ready.willCallModel });
    if (ready.willCallModel) for (const shot of evidence.screenshots) assert.ok(files.get(id, shot.sourceRunId || runId, shot.file), 'scorer must be able to resolve original PNG artifacts');
    return {
      fidelityScore: ready.willCallModel ? 88 : null, completionScore: null, confidence: ready.willCallModel ? 'high' : 'low',
      summary: ready.willCallModel ? 'Model scored available evidence' : 'Missing evidence; no model request',
      dimensions: ready.willCallModel ? selectedRule.dimensions.map(dimension => ({ id: dimension.id, score: 88, reason: 'Compared evidence', evidence: evidence.screenshots.map(shot => shot.id) })) : [],
      issues: evidence.issues, health: evidence.health, coverage: evidence.coverage, stable: evidence.stable,
      referenceStatus: ready.referenceStatus, model: { name: ready.willCallModel ? model.name : '未调用', usage: null }, calibrated: false,
    };
  };
  const dependencies = {
    collect, score,
    inspect: async (evidence: Evidence) => { inspected.push(evidence.screenshots[0].id); return { usable: true, reason: 'Expected visible page', retry: null }; },
    resolve: async () => { resolutions++; return { targetUrl: 'https://generated.test/', readme: null, warnings: [] }; },
  };
  return { directory, store, vault, artifacts, evaluationId, calls, scores, inspected, failures, state, dependencies, collected,
    resolutions: () => resolutions,
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('failed-stage retry collects only failed reference captures and preserves successful target artifacts', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  try {
    f.failures.add('reference');
    await worker.tick();
    const first = f.store.get(f.evaluationId)!.run;
    assert.equal(first.status, 'failed');
    assert.equal(first.pipeline!.steps.find(step => step.id === 'reference')!.status, 'failed');
    assert.equal(first.pipeline!.steps.find(step => step.id === 'score')!.status, 'blocked');
    assert.equal(first.report!.fidelityScore, null);
    assert.equal(f.scores.filter(score => score.calledModel).length, 0);
    assert.deepEqual(f.calls.map(call => `${call.role}-${call.viewport}`), ['target-desktop', 'target-mobile', 'reference-desktop', 'reference-mobile']);

    f.failures.clear(); f.calls.length = 0;
    const retryId = f.store.rerun(f.evaluationId, { mode: 'failed', sourceRunId: first.id });
    await worker.tick();
    const retried = f.store.get(f.evaluationId)!.run;
    assert.equal(retried.id, retryId); assert.equal(retried.status, 'completed');
    assert.deepEqual(f.calls.map(call => `${call.role}-${call.viewport}`), ['reference-desktop', 'reference-mobile']);
    assert.equal(f.resolutions(), 1);
    const targets = retried.pipeline!.captures.filter(capture => capture.role === 'target');
    assert.equal(targets.length, 2);
    assert.ok(targets.every(capture => capture.status === 'reused' && capture.sourceRunId === first.id));
    assert.ok(retried.evidence!.screenshots.filter(shot => shot.role === 'target').every(shot => shot.sourceRunId === first.id));
    assert.equal(f.scores.filter(score => score.calledModel).length, 1);
    assert.equal(f.store.history(f.evaluationId).find(run => run.id === first.id)!.status, 'failed');
  } finally { await worker.stop(); f.close(); }
});

test('score-only retry keeps image sourceRunId, avoids capture/review, and uses updated model configuration', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  try {
    await worker.tick();
    const first = f.store.get(f.evaluationId)!.run;
    assert.equal(first.status, 'completed'); assert.equal(f.calls.length, 4); assert.equal(f.inspected.length, 4);
    const settings = f.vault.get();
    f.vault.update({ ...settings, model: { endpoint: 'https://alternative-model.test/v1', name: 'configured-alternative-model', apiKey: 'new-private-key' } });
    f.calls.length = 0; f.inspected.length = 0;
    const retryId = f.store.rerun(f.evaluationId, { mode: 'score' });
    await worker.tick();
    const retried = f.store.get(f.evaluationId)!.run;
    assert.equal(retried.status, 'completed'); assert.equal(f.calls.length, 0); assert.equal(f.inspected.length, 0); assert.equal(f.resolutions(), 1);
    assert.equal(f.scores.length, 2); assert.equal(f.scores[1].runId, retryId);
    assert.equal(f.scores[1].model.name, 'configured-alternative-model');
    assert.equal(f.scores[1].model.endpoint, 'https://alternative-model.test/v1');
    assert.equal(retried.snapshot!.model.name, 'configured-alternative-model');
    assert.equal(retried.snapshot!.collector, collectorVersion);
    assert.ok(retried.evidence!.screenshots.every(shot => shot.sourceRunId === first.id));
    for (const shot of retried.evidence!.screenshots) {
      assert.ok(f.artifacts.get(f.evaluationId, first.id, shot.file));
      assert.equal(f.artifacts.get(f.evaluationId, retryId, shot.file), null);
    }
  } finally { await worker.stop(); f.close(); }
});

test('stop aborts an in-flight collector, queues the run, and disk-backed restart reuses completed viewports', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  let enter!: () => void, aborted = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.state.hang = async input => {
    if (input.roles![0] !== 'target' || input.rule.viewports[0].id !== 'mobile') return f.collected(input);
    enter();
    return new Promise<Evidence>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason); }, { once: true });
    });
  };
  let reopened: Store | undefined, restarted: Worker | undefined, originalClosed = false;
  try {
    const running = worker.tick();
    await entered;
    const runningRun = f.store.get(f.evaluationId)!.run;
    assert.equal(runningRun.status, 'collecting');
    assert.equal(runningRun.pipeline!.captures.find(capture => capture.viewport === 'desktop')!.status, 'completed');
    await worker.stop(); await running;
    assert.equal(aborted, true);
    const stopped = f.store.get(f.evaluationId)!.run;
    assert.equal(stopped.status, 'queued'); assert.equal(stopped.id, runningRun.id);
    const lease = f.store.db.prepare('SELECT lease_owner,lease_until,claims FROM runs WHERE id=?').get(stopped.id);
    assert.equal(lease.lease_owner, null); assert.equal(lease.lease_until, null); assert.equal(lease.claims, 0);
    assert.ok(f.store.events(stopped.id).some(event => event.message.includes('启动后继续执行')));

    f.store.close(); originalClosed = true;
    reopened = new Store(join(f.directory, 'database.sqlite'));
    const files = new Artifacts(reopened.db), persistedVault = new Vault(f.directory);
    f.state.hang = undefined;
    const previousCalls = f.calls.length;
    restarted = new Worker(reopened, persistedVault, files, f.directory, f.dependencies);
    await restarted.tick();
    const resumed = reopened.get(f.evaluationId)!.run;
    assert.equal(resumed.id, stopped.id); assert.equal(resumed.status, 'completed');
    assert.deepEqual(f.calls.slice(previousCalls).map(call => `${call.role}-${call.viewport}`), ['target-mobile', 'reference-desktop', 'reference-mobile']);
    assert.equal(f.calls.filter(call => call.role === 'target' && call.viewport === 'desktop').length, 1);
    assert.equal(f.resolutions(), 1); assert.equal(f.scores.filter(score => score.calledModel).length, 1);
    assert.ok(files.get(f.evaluationId, resumed.id, 'target-desktop-top.png'));
  } finally {
    await worker.stop(); await restarted?.stop(); reopened?.close();
    if (originalClosed) rmSync(f.directory, { recursive: true, force: true }); else f.close();
  }
});

test('legacy collector snapshot invalidates all reused captures before a score-only retry', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  try {
    await worker.tick();
    const first = f.store.get(f.evaluationId)!.run;
    assert.equal(first.status, 'completed');
    f.store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify({ ...first.snapshot, collector: 'kooboo-native-v1' }), first.id);
    f.calls.length = 0;
    const retryId = f.store.rerun(f.evaluationId, { mode: 'score' });
    await worker.tick();
    const retried = f.store.get(f.evaluationId)!.run;
    assert.equal(retried.status, 'completed'); assert.equal(retried.snapshot!.collector, collectorVersion);
    assert.deepEqual(f.calls.map(call => `${call.role}-${call.viewport}`), ['target-desktop', 'target-mobile', 'reference-desktop', 'reference-mobile']);
    assert.equal(f.resolutions(), 2); assert.ok(f.calls.every(call => call.runId === retryId));
    assert.equal(retried.pipeline!.retryMode, 'all');
    assert.ok(retried.evidence!.screenshots.every(shot => !shot.sourceRunId || shot.sourceRunId === retryId));
    assert.ok(f.store.events(retryId).some(event => event.message.includes('采集器已变化')));
    assert.ok(f.artifacts.get(f.evaluationId, first.id, 'target-desktop-top.png'));
    assert.ok(f.artifacts.get(f.evaluationId, retryId, 'target-desktop-top.png'));
  } finally { await worker.stop(); f.close(); }
});

test('rule hash changes still invalidate preparation and all screenshot checkpoints', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  try {
    await worker.tick();
    const first = f.store.get(f.evaluationId)!.run;
    f.store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify({ ...first.snapshot, ruleHash: 'outdated-rule-hash' }), first.id);
    f.calls.length = 0;
    const retryId = f.store.rerun(f.evaluationId, { mode: 'score', sourceRunId: first.id });
    await worker.tick();
    const retried = f.store.get(f.evaluationId)!.run;
    assert.equal(retried.status, 'completed');
    assert.equal(f.resolutions(), 2);
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(call => call.runId === retryId));
    assert.equal(retried.pipeline!.retryMode, 'all');
    assert.notEqual(retried.snapshot!.ruleHash, 'outdated-rule-hash');
    assert.equal(f.store.history(f.evaluationId).find(run => run.id === first.id)!.snapshot!.ruleHash, 'outdated-rule-hash');
  } finally { await worker.stop(); f.close(); }
});

test('SOP-only changes retain original artifacts and preparation but reset reviews, downstream checkpoints and accepted report', { timeout: 5000 }, async () => {
  const f = fixture(), worker = new Worker(f.store, f.vault, f.artifacts, f.directory, f.dependencies);
  try {
    await worker.tick();
    const first = f.store.get(f.evaluationId)!.run;
    const pipeline = first.pipeline!;
    pipeline.agent = { version: 1, iterations: 3, calls: [], usage: { total_tokens: 100 }, artifacts: [],
      captureAttempts: { 'target-desktop': 1 }, reviews: { 'target-desktop': {
        usable: true, reason: 'Old SOP observation', evidence: [first.evidence!.screenshots[0].id],
      } } };
    f.store.db.prepare('UPDATE runs SET snapshot=?,pipeline=? WHERE id=?').run(
      JSON.stringify({ ...first.snapshot, sop: { version: 'old-sop', hash: 'outdated-sop-hash' } }),
      JSON.stringify(pipeline), first.id,
    );
    const retryId = f.store.rerun(f.evaluationId, { mode: 'report', sourceRunId: first.id });
    const queued = f.store.get(f.evaluationId)!.run;
    assert.ok(queued.pipeline!.scoredReport, 'report retry initially carries accepted output');
    assert.ok(Object.keys(queued.pipeline!.agent!.reviews).length);
    let snapshotPipeline: Pipeline | undefined;
    const update = f.store.update.bind(f.store);
    f.store.update = (id, owner, patch) => {
      if (id === retryId && patch.snapshot) snapshotPipeline = structuredClone(patch.pipeline!);
      return update(id, owner, patch);
    };
    f.calls.length = 0;
    f.inspected.length = 0;
    await worker.tick();
    assert.ok(snapshotPipeline);
    assert.equal(snapshotPipeline.scoredReport, null);
    assert.deepEqual(snapshotPipeline.agent!.reviews, {});
    assert.equal(snapshotPipeline.retryMode, 'check', 'new SOP requires review before regenerating a report');
    assert.deepEqual(snapshotPipeline.prepared, queued.pipeline!.prepared);
    assert.deepEqual(snapshotPipeline.captures, queued.pipeline!.captures);
    assert.deepEqual(snapshotPipeline.agent!.captureAttempts, queued.pipeline!.agent!.captureAttempts);
    for (const step of snapshotPipeline.steps.filter(step => ['check', 'score', 'report'].includes(step.id))) {
      assert.equal(step.status, 'pending');
      assert.equal(step.startedAt, null);
      assert.equal(step.finishedAt, null);
      assert.equal(step.sourceRunId, undefined);
    }
    const retried = f.store.get(f.evaluationId)!.run;
    assert.equal(retried.status, 'completed');
    assert.equal(f.resolutions(), 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.scores.length, 2, 'stale report cannot bypass scoring under new SOP');
    assert.equal(retried.snapshot!.sop!.hash, loadSop().hash);
    assert.ok(retried.evidence!.screenshots.every(shot => shot.sourceRunId === first.id));
    assert.ok(f.store.events(retryId).some(event => event.message.includes('保留资料与截图')));
    assert.equal(f.store.history(f.evaluationId).find(run => run.id === first.id)!.snapshot!.sop!.hash, 'outdated-sop-hash');
  } finally { await worker.stop(); f.close(); }
});
