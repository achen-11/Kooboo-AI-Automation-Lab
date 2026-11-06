import test from 'node:test';
import assert from 'node:assert/strict';
import { newDimension } from '../frontend/src/lib/rule-editor.js';
import type { RuleDraft } from '../shared/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';

test('extension manual evaluations require ingestion scope, retain idempotency and expose exact attempt to read scope', async () => {
  const f = await fixture();
  try {
    const submission = { schemaVersion: 1, attemptId: 'manual-extension-attempt', requestId: 'batch-request', jobId: 'batch-job', trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: 'https://kooboo.test', siteId: 'site-1' }, inputs: { referenceUrl: 'https://reference.test/' }, scope: 'homepage' };
    const headers = { authorization: `Bearer ${f.vault.credentials.ingestToken}`, 'idempotency-key': submission.attemptId, origin: 'chrome-extension://fixture' };
    const first = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: submission });
    assert.equal(first.statusCode, 202);
    const again = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: submission });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().evaluationId, first.json().evaluationId);
    const detail = await f.app.inject({ url: `/api/evaluations/${first.json().evaluationId}`, headers: { authorization: `Bearer ${f.vault.credentials.readToken}`, origin: headers.origin } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().attemptId, submission.attemptId);
    assert.equal(detail.json().fidelityScore, null);
    assert.equal(detail.json().status, 'queued');
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: { ...headers, authorization: `Bearer ${f.vault.credentials.readToken}` }, payload: submission })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/manual-evaluations', headers, payload: { jobId: 'arbitrary-url', targetUrl: 'https://example.test/' } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { ...submission, trigger: 'unknown' } })).statusCode, 400);
    const next = { ...submission, attemptId: 'intentional-new-evaluation' };
    const recheck = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: { ...headers, 'idempotency-key': next.attemptId }, payload: next });
    assert.equal(recheck.statusCode, 202);
    assert.notEqual(recheck.json().evaluationId, first.json().evaluationId);
  } finally { await f.close(); }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'evaluator-api-test-'));
  const { app, store, vault } = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await app.inject({ method: 'POST', url: '/api/login' });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  return { app, store, vault, cookie, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('editing adds a fifth custom item, publishing changes defaults and old tasks keep their version', async () => {
  const f = await fixture();
  const headers = { cookie: f.cookie };
  const manual = (jobId: string, ruleSetVersion?: string) => f.app.inject({ method: 'POST', url: '/api/manual-evaluations', headers, payload: { jobId, targetUrl: 'https://target.test/', ruleSetVersion } });
  try {
    const old = (await manual('before-publication')).json();
    const created = await f.app.inject({ method: 'POST', url: '/api/rule-drafts', headers, payload: { sourceVersion: 'agent-ui-v1' } });
    assert.equal(created.statusCode, 201);
    let draft = created.json() as RuleDraft;
    draft.rule.dimensions = draft.rule.dimensions.slice(0, 4).map(d => ({ ...d, weight: 20 }));
    const added = newDimension(draft.rule.dimensions);
    Object.assign(added, { label: '内容完整性', weight: 20, instruction: '逐模块检查参考站可见内容是否缺失' });
    draft.rule.dimensions.push(added);
    const save = await f.app.inject({ method: 'PUT', url: `/api/rule-drafts/${draft.id}`, headers, payload: { revision: draft.revision, rule: draft.rule } });
    assert.equal(save.statusCode, 200);
    draft = save.json();
    assert.equal(f.store.getRule(draft.rule.version), null, 'draft is not available to scoring');
    assert.equal((await f.app.inject({ url: '/api/rules', headers })).json().defaultVersion, 'agent-ui-v1');
    const published = await f.app.inject({ method: 'POST', url: `/api/rule-drafts/${draft.id}/publish`, headers, payload: { revision: draft.revision } });
    assert.equal(published.statusCode, 200);
    assert.deepEqual(published.json().rule.dimensions, draft.rule.dimensions);
    const listed = (await f.app.inject({ url: '/api/rules', headers })).json();
    assert.equal(listed.defaultVersion, draft.rule.version);
    assert.equal(f.store.get(old.evaluationId)!.submission.ruleSetVersion, 'agent-ui-v1');
    const current = (await manual('after-publication')).json();
    assert.equal(f.store.get(current.evaluationId)!.submission.ruleSetVersion, draft.rule.version);
    const pinned = (await manual('explicit-old-version', 'agent-ui-v1')).json();
    assert.equal(f.store.get(pinned.evaluationId)!.submission.ruleSetVersion, 'agent-ui-v1');

    const submission = { schemaVersion: 1, attemptId: 'published-default', requestId: 'r', jobId: 'j', trigger: 'chat_stopped', occurredAt: Date.now(), target: { koobooOrigin: 'https://kooboo.test', siteId: 'site' }, inputs: {}, scope: 'homepage' };
    const ingest = { authorization: `Bearer ${f.vault.credentials.ingestToken}`, 'idempotency-key': submission.attemptId };
    const received = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: ingest, payload: submission });
    assert.equal(received.statusCode, 202);
    assert.equal(f.store.get(received.json().evaluationId)!.submission.ruleSetVersion, draft.rule.version);
    const next = f.store.createDraft({ ...draft.rule, version: 'agent-ui-next', dimensions: draft.rule.dimensions.slice(0, 4).map(d => ({ ...d, weight: 25 })) });
    f.store.publishDraft(next.id, next.revision);
    const redelivered = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: ingest, payload: submission });
    assert.equal(redelivered.statusCode, 200);
    assert.equal(redelivered.json().evaluationId, received.json().evaluationId);
    assert.equal(f.store.get(received.json().evaluationId)!.submission.ruleSetVersion, draft.rule.version);
    assert.equal(f.store.getRule(draft.rule.version)!.rule.dimensions.length, 5);
    assert.equal(f.store.getRule(next.rule.version)!.rule.dimensions.length, 4);
  } finally { await f.close(); }
});

test('local session requires entry, guards Host/Origin and invalidates cookie on logout', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/settings')).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/settings', headers: { cookie: f.cookie } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'https://untrusted.test' } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/login', headers: { host: 'untrusted.test' } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'chrome-extension://fixture' } })).statusCode, 403);
    await f.app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: f.cookie } });
    assert.equal((await f.app.inject({ url: '/api/settings', headers: { cookie: f.cookie } })).statusCode, 401);
  } finally { await f.close(); }
});

test('editable model settings preserve masked key and save execution limits', async () => {
  const f = await fixture();
  try {
    const input = { ...f.vault.get(), execution: { timeoutSeconds: 900, captureAttempts: 3 }, model: { endpoint: 'https://gateway.test/custom/chat/completions', name: 'configured-model', apiKey: 'private-api-test-key' } };
    const saved = await f.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: f.cookie }, payload: input });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().model.hasApiKey, true);
    assert.ok(!saved.body.includes('private-api-test-key'));
    const masked = saved.json();
    const updated = await f.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: f.cookie }, payload: { ...masked, model: { ...masked.model, name: 'changed-model', apiKey: '' } } });
    assert.equal(updated.statusCode, 200); assert.equal(f.vault.get().model.apiKey, input.model.apiKey);
    assert.deepEqual(f.vault.get().execution, input.execution);
    assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: f.cookie }, payload: { ...input, execution: { timeoutSeconds: 1801, captureAttempts: 1 } } })).statusCode, 400);
  } finally { await f.close(); }
});

test('plugin ingestion and Admin read tokens retain their separate scopes and generated domain identity', async () => {
  const f = await fixture();
  try {
    const submission = { schemaVersion: 1, attemptId: 'attempt-api-1', requestId: 'request-api-1', jobId: 'job-api-1', trigger: 'chat_stopped', occurredAt: Date.now(), target: { koobooOrigin: 'https://kooboo.test', siteId: 'generated-site' }, inputs: { referenceUrl: 'https://original.test/' }, scope: 'homepage' };
    const ingest = { authorization: `Bearer ${f.vault.credentials.ingestToken}`, 'idempotency-key': submission.attemptId, origin: 'chrome-extension://fixture' };
    const accepted = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: ingest, payload: submission });
    assert.equal(accepted.statusCode, 202);
    const duplicate = await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: ingest, payload: submission });
    assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().evaluationId, accepted.json().evaluationId);
    const owner = 'test-owner', job = f.store.claim(owner)!;
    f.store.bindSite(job.evaluation.id, 'generated.example.test', job.run.id, owner);
    f.store.update(job.run.id, owner, { status: 'failed', error: 'diagnostic' });
    const read = { authorization: `Bearer ${f.vault.credentials.readToken}` };
    const history = await f.app.inject({ url: '/api/sites/generated.example.test/evaluations/latest', headers: read });
    assert.equal(history.statusCode, 200); assert.equal(history.json().siteDomain, 'generated.example.test');
    assert.equal((await f.app.inject({ url: '/api/settings', headers: read })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/evaluations', headers: { ...read, 'idempotency-key': submission.attemptId }, payload: submission })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/evaluations/${job.evaluation.id}/runs`, headers: { cookie: f.cookie }, payload: { mode: 'invalid' } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/evaluations/${job.evaluation.id}/runs`, headers: { cookie: f.cookie }, payload: { mode: 'failed', sourceRunId: crypto.randomUUID() } })).statusCode, 409);
  } finally { await f.close(); }
});

test('new plugin deliveries freeze agent rule default while historical redeliveries retain original idempotency',async()=>{
  const f=await fixture();
  try{
    const submission={schemaVersion:1 as const,attemptId:'old-delivery',requestId:'old-request',jobId:'old-job',trigger:'chat_stopped' as const,occurredAt:Date.now(),target:{koobooOrigin:'https://kooboo.test',siteId:'site'},inputs:{},scope:'homepage' as const};
    const old=f.store.accept(submission);
    const headers={authorization:`Bearer ${f.vault.credentials.ingestToken}`,'idempotency-key':submission.attemptId};
    const redelivered=await f.app.inject({method:'POST',url:'/api/evaluations',headers,payload:submission});
    assert.equal(redelivered.statusCode,200);assert.equal(redelivered.json().evaluationId,old.evaluationId);
    assert.equal(f.store.get(old.evaluationId)!.submission.ruleSetVersion,undefined);
    const accepted=await f.app.inject({method:'POST',url:'/api/evaluations',headers:{...headers,'idempotency-key':'new-delivery'},payload:{...submission,attemptId:'new-delivery'}});
    assert.equal(accepted.statusCode,202);assert.equal(f.store.get(accepted.json().evaluationId)!.submission.ruleSetVersion,'agent-ui-v1');
  }finally{await f.close();}
});
