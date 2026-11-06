import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Artifacts } from '../server/lib/artifacts.js';
import type { Report } from '../shared/types.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'public-evaluator-test-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const headers = { authorization: `Bearer ${f.vault.credentials.readToken}` };
  const seed = (jobId: string, target = 'https://generated.test/', occurredAt = Date.now()) => f.store.accept({
    schemaVersion: 1, attemptId: randomUUID(), requestId: `request-${jobId}`, jobId, trigger: 'manual', occurredAt,
    target: { koobooOrigin: 'https://admin.test', siteId: 'manual-public-url' }, inputs: {}, scope: 'homepage',
  }, target);
  return { ...f, headers, seed, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('public API requires read scope, refuses mutations, host spoofing and untrusted origins', async () => {
  const f = await fixture();
  try {
    for (const headers of [{}, { authorization: `Bearer ${f.vault.credentials.ingestToken}` }]) {
      assert.equal((await f.app.inject({ url: '/api/v1/evaluations', headers })).statusCode, 401);
    }
    assert.equal((await f.app.inject({ url: '/api/v1/evaluations', headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/v1/evaluations', headers: { ...f.headers, host: 'evil.test' } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/v1/evaluations', headers: { ...f.headers, origin: 'https://admin.test' } })).statusCode, 403);
    assert.equal((await f.app.inject({ url: '/api/settings', headers: f.headers })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/evaluations', headers: f.headers, payload: {} })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/v1/evaluations', headers: f.headers })).headers['cache-control'], 'no-store');
  } finally { await f.close(); }
});

test('summary, report and full preserve null scores, snapshots, evidence provenance and paged history', async () => {
  const f = await fixture();
  try {
    const { evaluationId: id } = f.seed('report');
    const job = f.store.claim('fixture')!;
    const runId = job.run.id, sourceRunId = randomUUID();
    const png = Buffer.from('fixture-image').toString('base64');
    const coverage = { requested: 'site' as const, actual: 'homepage' as const, complete: false, captureComplete: true, note: 'only homepage' };
    const report: Report = { fidelityScore: 77, completionScore: null, confidence: 'medium', summary: 'test', dimensions: [], issues: [], health: 'ok', model: { name: 'fixture', usage: null }, coverage, stable: true, referenceStatus: 'available', calibrated: false };
    f.store.update(runId, 'fixture', { status: 'completed', report, snapshot: {
      rule: f.store.rules()[0].rule, ruleHash: 'fixture-hash', model: { endpoint: 'https://private-model.test/secret', name: 'fixture' },
    }, evidence: { targetUrl: 'https://generated.test/', targetTitle: 'test', text: 'body', readme: null, health: 'ok', issues: [], fingerprint: 'hash', stable: true, coverage,
      screenshots: [{ id: 'target', role: 'target', viewport: 'desktop', region: 'top', file: 'target.png', url: 'https://generated.test/', capturedAt: 1, width: 1, height: 1, sourceRunId }] } });
    new Artifacts(f.store.db).save(id, sourceRunId, 'target.png', png);
    const get = (url: string) => f.app.inject({ url, headers: f.headers });
    const summary = (await get('/api/v1/evaluations')).json().items[0];
    assert.equal(summary.scoringStatus, 'scored'); assert.equal(summary.completionScore, null);
    assert.equal(summary.coverage.complete, false); assert.ok(!('report' in summary)); assert.ok(!('evidence' in summary));
    assert.equal((await get('/api/v1/evaluations?detail=full')).json().items[0].evidence.screenshots.length, 1);
    const result = (await get(`/api/v1/evaluations/${id}`)).json();
    assert.equal(result.report.fidelityScore, 77); assert.ok(!('evidence' in result));
    const full = (await get(`/api/v1/evaluations/${id}?detail=full`)).json();
    assert.equal(full.evidence.screenshots[0].sourceRunId, sourceRunId);
    assert.ok(!JSON.stringify(full).includes('private-model')); assert.ok(!('pipeline' in full));
    assert.ok(!JSON.stringify(full).includes(f.vault.credentials.readToken));
    const artifact = await get(full.evidence.screenshots[0].artifactUrl);
    assert.equal(artifact.statusCode, 200); assert.equal(artifact.body, 'fixture-image');
    assert.equal((await get(`/api/v1/evaluations/${randomUUID()}/runs/${runId}/artifacts/target.png`)).statusCode, 404);
    const reportResult = await get(`/api/v1/evaluations/${id}/runs/${runId}/report`);
    assert.equal(reportResult.json().report.fidelityScore, 77); assert.ok(!reportResult.body.includes('private-model'));
    const oldUpdatedAt = full.updatedAt;
    f.store.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?)').run(randomUUID(), runId, 'rework', 'review', oldUpdatedAt + 1000);
    const reviewed = (await get(`/api/v1/evaluations?updatedSince=${oldUpdatedAt + 1}&needsReview=true`)).json();
    assert.equal(reviewed.items[0].review.note, 'review');
    assert.equal(reviewed.items[0].updatedAt, oldUpdatedAt + 1000);
    const next = f.store.rerun(id, { mode: 'all', sourceRunId: runId });
    const history = (await get(`/api/v1/evaluations/${id}/runs?detail=report&pageSize=1`)).json();
    assert.equal(history.total, 2); assert.equal(history.hasMore, true); assert.equal(history.items[0].runId, next);
    const second = (await get(`/api/v1/evaluations/${id}/runs?detail=full&pageSize=1&page=2`)).json();
    assert.equal(second.items[0].runId, runId); assert.equal(second.items[0].evidence.screenshots.length, 1);
    const events = (await get(`/api/v1/evaluations/${id}/runs/${runId}/events?pageSize=1`)).json();
    assert.equal(events.items.length, 1);
    const after = (await get(`/api/v1/evaluations/${id}/runs/${runId}/events?afterSeq=${events.items[0].seq}`)).json();
    assert.ok(after.items.every((event: { seq: number }) => event.seq > events.items[0].seq));
    assert.equal((await get(`/api/v1/evaluations/${id}`)).json().scoringStatus, 'pending');
    assert.equal((await get(`/api/v1/evaluations/${randomUUID()}`)).statusCode, 404);
  } finally { await f.close(); }
});

test('strict filters, both boolean values, latest-per-site semantics and deterministic pagination', async () => {
  const f = await fixture();
  try {
    f.seed('old', 'https://generated.test/', 1);
    const newest = f.seed('new', 'https://generated.test/', 3);
    f.seed('other', 'https://other.test/', 2);
    const get = (query: string) => f.app.inject({ url: `/api/v1/evaluations?${query}`, headers: f.headers });
    const first = (await get('pageSize=1&order=asc')).json();
    const second = (await get('pageSize=1&order=asc&page=2')).json();
    assert.equal(first.total, 3); assert.equal(first.hasMore, true); assert.notEqual(first.items[0].evaluationId, second.items[0].evaluationId);
    assert.equal((await get('latestPerSite=true')).json().total, 2);
    assert.equal((await get('latestPerSite=true&jobId=old')).json().total, 0);
    const byDomain = (await get('domain=GENERATED.TEST&latestPerSite=true&jobId=new')).json();
    assert.equal(byDomain.items[0].evaluationId, newest.evaluationId);
    assert.equal((await get('needsReview=true')).json().total, 0);
    assert.equal((await get('needsReview=false')).json().total, 3);
    assert.equal((await get('scoringStatus=pending&status=queued')).json().total, 3);
    assert.equal((await get('fidelityBelow=80')).json().total, 0);
    const changedAt = first.items[0].updatedAt;
    assert.ok((await get(`updatedSince=${changedAt}`)).json().items.some((item: { evaluationId: string }) => item.evaluationId === first.items[0].evaluationId));
    assert.equal((await get('updatedBefore=1')).json().total, 0);
    assert.equal((await get('createdFrom=1&createdBefore=2')).json().total, 0);
    for (const invalid of ['unknown=1', 'needsReview=1', 'page=0', 'pageSize=101', 'detail=invalid', 'detail=full&pageSize=11', 'updatedSince=9&updatedBefore=8', 'domain=%2F%2F', 'updatedSince=NaN']) {
      assert.equal((await get(invalid)).statusCode, 400, invalid);
    }
  } finally { await f.close(); }
});
