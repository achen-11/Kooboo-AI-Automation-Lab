import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Artifacts } from '../server/lib/artifacts.js';
import { repairPayload, repairTargets } from '../server/lib/issue-repair.js';
import { Store } from '../server/lib/store.js';
import type { Evidence, Report, Screenshot } from '../shared/types.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'evaluator-issue-test-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const cookie = String((await f.app.inject({ method: 'POST', url: '/api/login' })).headers['set-cookie']).split(';')[0];
  const accepted = f.store.accept({ schemaVersion: 1, attemptId: randomUUID(), requestId: randomUUID(), jobId: 'fixture', trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: 'https://admin.test', siteId: 'manual-public-url' }, inputs: { referenceUrl: 'https://reference.test/' }, scope: 'homepage' }, 'https://generated.test/');
  const owner = 'fixture', job = f.store.claim(owner)!;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const sourceRunId = randomUUID();
  const shot = (id: string, role: Screenshot['role']): Screenshot => ({ id, role, viewport: 'desktop', region: 'top', file: `${id}.png`, width: 1, height: 1, capturedAt: Date.now(), url: `https://${role}.test/`, sourceRunId, sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') });
  const screenshots = [shot('ref', 'reference'), shot('target', 'target')];
  const issues: Report['issues'] = [{ severity: 'major', dimension: 'layout', title: '间距', detail: '核实间距', evidence: ['target'] }, { severity: 'minor', dimension: 'layout', title: '边距', detail: '核实边距', evidence: ['target'] }];
  const report: Report = { fidelityScore: 77.6, completionScore: null, confidence: 'medium', summary: 'fixture', dimensions: [], issues, health: 'ok', model: { name: 'fixture', usage: null }, coverage: { requested: 'homepage', actual: 'homepage', complete: true, note: 'fixture' }, stable: true, referenceStatus: 'available', calibrated: false, pairings: [{ name: '首屏', target: ['target'], reference: ['ref'] }] };
  const evidence: Evidence = { targetUrl: 'https://generated.test/', targetTitle: 'fixture', text: '', readme: null, screenshots, issues: [], health: 'ok', fingerprint: 'fixture', stable: true, coverage: report.coverage };
  f.store.update(job.run.id, owner, { status: 'completed', report, evidence });
  const artifacts = new Artifacts(f.store.db);
  for (const image of screenshots) artifacts.save(accepted.evaluationId, sourceRunId, image.file, png);
  const target = { environmentId: randomUUID(), environmentName: 'fixture', origin: 'https://admin.test', siteId: randomUUID(), siteName: '生成站' };
  return { ...f, directory, cookie, id: accepted.evaluationId, runId: job.run.id, artifacts, png, report, target, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('ignore/restore persists per immutable run without changing score; invalid decisions rejected', async () => {
  const f = await fixture();
  try {
    const post = (indices: number[], ignored: boolean) => f.app.inject({ method: 'POST', url: `/api/evaluations/${f.id}/issue-decisions`, headers: { cookie: f.cookie }, payload: { runId: f.runId, indices, ignored } });
    assert.equal((await post([0], true)).statusCode, 200);
    assert.deepEqual(f.store.issueActions(f.runId).ignored, [0]);
    assert.deepEqual(f.store.get(f.id)!.run.report, f.report);
    const reopened = new Store(join(f.directory, 'database.sqlite'));
    assert.deepEqual(reopened.issueActions(f.runId).ignored, [0]); reopened.close();
    assert.equal((await post([4], true)).statusCode, 409);
    assert.equal((await post([0,0], true)).statusCode, 409);
    const detail = await f.app.inject({ url: `/api/evaluations/${f.id}`, headers: { cookie: f.cookie } });
    assert.deepEqual(detail.json().issueActions[f.runId].ignored, [0]);
    assert.equal((await post([0], false)).statusCode, 200);
    assert.deepEqual(f.store.issueActions(f.runId).ignored, []);
    const next = f.store.rerun(f.id, { mode: 'all', sourceRunId: f.runId });
    await post([1], true);
    assert.deepEqual(f.store.issueActions(next).ignored, []);
  } finally { await f.close(); }
});

test('repair uses verified source-run PNGs, includes actual counterpart, excludes ignored issues and stale runs', async () => {
  const f = await fixture();
  try {
    const payload = repairPayload(f.store, f.artifacts, f.id, f.runId, [0], f.target, randomUUID());
    assert.deepEqual(payload.images.map(i => i.id), ['ref','target']);
    assert.ok(payload.images.every(i => i.uri === `data:image/png;base64,${f.png}`));
    assert.ok(payload.text.includes('问题 1：间距')); assert.ok(!payload.text.includes('问题 2：边距'));
    f.store.decideIssues(f.id, f.runId, [0], true);
    assert.throws(() => repairPayload(f.store, f.artifacts, f.id, f.runId, [0], f.target, randomUUID()), /已忽略/);
    f.store.rerun(f.id, { mode: 'all', sourceRunId: f.runId });
    assert.throws(() => repairPayload(f.store, f.artifacts, f.id, f.runId, [1], f.target, randomUUID()), /已更新/);
  } finally { await f.close(); }
});

test('missing/corrupted evidence cannot prepare a repair handoff', async () => {
  const f = await fixture();
  try {
    const shot = f.store.get(f.id)!.run.evidence!.screenshots[0];
    f.artifacts.save(f.id, shot.sourceRunId!, shot.file, Buffer.from('changed bytes').toString('base64'));
    assert.throws(() => repairPayload(f.store, f.artifacts, f.id, f.runId, [0], f.target, randomUUID()), /校验失败/);
    assert.equal(f.store.issueActions(f.runId).handoffs.length, 0);
  } finally { await f.close(); }
});

test('handoff is idempotent, receipts cannot downgrade acceptance or report repairs complete', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    f.store.prepareIssueHandoff(f.id, f.runId, [0], f.target, id);
    f.store.prepareIssueHandoff(f.id, f.runId, [0], f.target, id);
    assert.equal(f.store.issueActions(f.runId).handoffs.length, 1);
    assert.throws(() => f.store.prepareIssueHandoff(f.id, f.runId, [1], f.target, id), /编号/);
    assert.throws(() => f.store.finishIssueHandoff(f.id, f.runId, id, f.target.siteId, 'accepted'), /会话/);
    const sessionId = randomUUID();
    f.store.finishIssueHandoff(f.id, f.runId, id, f.target.siteId, 'unknown');
    f.store.finishIssueHandoff(f.id, f.runId, id, f.target.siteId, 'accepted', sessionId);
    f.store.finishIssueHandoff(f.id, f.runId, id, f.target.siteId, 'failed');
    assert.equal(f.store.issueActions(f.runId).handoffs[0].status, 'accepted');
    assert.equal(f.store.issueActions(f.runId).handoffs[0].sessionId, sessionId);
    assert.equal(f.store.get(f.id)!.run.report!.fidelityScore, 77.6);
    assert.throws(() => f.store.finishIssueHandoff(f.id, f.runId, id, randomUUID(), 'accepted', sessionId));
  } finally { await f.close(); }
});

test('domain resolver matches public hostname and real UUID without exposing environment credentials', async () => {
  const f = await fixture(), original = globalThis.fetch;
  try {
    const environment = { id: f.target.environmentId, name: 'fixture', origin: f.target.origin, apiOrigin: f.target.origin, token: 'secret-fixture-token' };
    f.vault.update({ ...f.vault.get(), environments: [environment] });
    globalThis.fetch = (async (_url, options) => {
      assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer secret-fixture-token');
      assert.equal(options!.redirect, 'manual');
      return Response.json([{ siteId: randomUUID(), homePageLink: 'https://generated.test.evil/' }, { siteId: f.target.siteId, siteDisplayName: '正确站点', homePageLink: 'https://generated.test/home' }, { siteId: 'invalid', homePageLink: 'https://generated.test/' }]);
    }) as typeof fetch;
    const resolved = await repairTargets(f.store.get(f.id)!, f.vault.get());
    assert.equal(resolved.items.length, 1); assert.equal(resolved.items[0].siteId, f.target.siteId);
    assert.ok(!JSON.stringify(resolved).includes('secret-fixture-token'));
    const read = { authorization: `Bearer ${f.vault.credentials.readToken}` };
    assert.equal((await f.app.inject({ url: `/api/evaluations/${f.id}/repair-targets`, headers: read })).statusCode, 403);
    const id = randomUUID();
    const response = await f.app.inject({ method: 'POST', url: `/api/evaluations/${f.id}/issue-handoffs`, headers: { cookie: f.cookie, origin: 'http://localhost:4180' }, payload: { id, runId: f.runId, indices: [0], environmentId: environment.id, siteId: f.target.siteId } });
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().url);
    assert.equal(url.origin, f.target.origin); assert.equal(url.searchParams.get('evaluationOrigin'), 'http://localhost:4180');
    assert.equal(url.searchParams.get('SiteId'), f.target.siteId);
    assert.ok(!url.href.includes('base64')); assert.ok(!response.body.includes('secret-fixture-token'));
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/evaluations/${f.id}/issue-handoffs`, headers: read, payload: {} })).statusCode, 401);
  } finally { globalThis.fetch = original; await f.close(); }
});
