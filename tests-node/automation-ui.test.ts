import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { initialTaskTab } from '../shared/task-presentation.js';
import type { UsageObservation } from '../shared/billing.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'automation-ui-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const resource = f.automationStore.saveResource({ name: 'UI test', scenario: 'materials', description: '資料', contentUrl: '', referenceUrl: '', externalId: '', externalSource: '', files: [] });
  const site = { id: randomUUID(), resourceId: resource.id, versionId: f.automationStore.versions(resource.id)[0].id, environmentId: randomUUID(), siteId: randomUUID(), name: 'Target', url: 'https://generated.test', createdAt: Date.now() };
  f.automationStore.saveSite(site);
  const parent = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: site.environmentId, generatedSiteId: site.id, requirements: '' }, defaultAutomationSettings)[0];
  parent.status = 'completed'; f.automationStore.put(parent);
  const child = f.automationStore.ensureEvaluation(parent, defaultAutomationSettings);
  return { ...f, headers, parent, child, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function usage(id: string, stage: UsageObservation['stage'] = 'generation', time = 0): UsageObservation {
  return { id, source: 'codex', stage, endpoint: 'https://api.deepseek.com', model: 'deepseek-flash-1017', startedAt: Date.parse('2026-11-07T01:00:00Z') + time, endedAt: Date.parse('2026-11-07T01:00:00Z') + time + 1, status: 'completed', basis: 'request', raw: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 500 } };
}

test('usage pagination combines only the automatic child, filters stages and keeps totals independent of page', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 205; i++) f.automationStore.usage.record(f.parent.id, usage('parent-' + i, i % 2 ? 'generation' : 'followup', i));
    for (let i = 0; i < 13; i++) f.automationStore.usage.record(f.child.id, usage('child-' + i, 'evaluation', 300 + i));
    f.automationStore.usage.record(randomUUID(), usage('unrelated', 'evaluation', 999));
    // The new UI must not deserialize every ledger entry to calculate a summary or page.
    f.automationStore.usage.entries = () => { throw new Error('unbounded ledger read'); };
    const get = (query: string) => f.app.inject({ url: `/api/automation/tasks/${f.parent.id}/usage${query}`, headers: f.headers });
    const first = (await get('?page=1&pageSize=20')).json();
    const second = (await get('?page=2&pageSize=20')).json();
    assert.equal(first.total, 218); assert.equal(first.pages, 11); assert.equal(first.items.length, 20);
    assert.equal(first.items[0].id, 'child-12'); assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 40);
    const last = (await get('?page=999&pageSize=20')).json(); assert.equal(last.page, 11); assert.equal(last.items.length, 18);
    const filtered = (await get('?stage=evaluation')).json(); assert.equal(filtered.total, 13); assert.ok(filtered.items.every((x: any) => x.taskId === f.child.id));
    const summary = (await f.app.inject({ url: `/api/automation/tasks/${f.parent.id}/summary`, headers: f.headers })).json();
    assert.equal(summary.task.usage.requests, 218); assert.equal(summary.task.usage.input, 218000); assert.equal(summary.evaluation.usage.requests, 13);
    for (const query of ['?page=0', '?pageSize=101', '?page=1.5', '?stage=invalid']) assert.equal((await get(query)).statusCode, 400);
    const child = (await f.app.inject({ url: `/api/automation/tasks/${f.child.id}/usage`, headers: f.headers })).json(); assert.equal(child.total, 13);
  } finally { await f.close(); }
});

test('summary omits heavy evidence, prompts, logs and raw usage while report and input sections preserve frozen data', async () => {
  const f = await fixture();
  try {
    const child = f.child;
    child.status = 'completed'; child.context = 'LONG_CONTEXT'.repeat(10000); child.message = 'FULL_PROMPT'.repeat(1000);
    child.report = { summary: 'QUALITY_SUMMARY', scores: [{ viewport: 'desktop', value: 76 }], quality: 'failed', assessments: [], issues: [{ severity: 'major', title: 'Layout', detail: 'LONG_ISSUE'.repeat(1000), evidence: [] }], coverage: { verified: [], unverified: ['Animation'], outOfScope: [] }, artifacts: [] };
    f.automationStore.put(child);
    const before = JSON.stringify(f.automationStore.task(child.id));
    const snapshot = await f.app.inject({ url: `/api/automation/tasks/${f.parent.id}/summary`, headers: f.headers });
    assert.equal(snapshot.statusCode, 200); assert.ok(snapshot.body.length < 5000);
    for (const text of ['LONG_CONTEXT', 'FULL_PROMPT', 'LONG_ISSUE', 'usageEntries', 'artifacts', 'assessments', 'sop']) assert.ok(!snapshot.body.includes(text), text);
    assert.equal(snapshot.json().evaluation.report.quality, 'failed'); assert.equal(snapshot.json().evaluation.report.issueCount, 1); assert.equal(snapshot.json().deliveryEnabled, false);
    const overview = await f.app.inject({ url: '/api/automation/overview?view=compact', headers: f.headers });
    for (const text of ['LONG_CONTEXT', 'FULL_PROMPT', 'LONG_ISSUE', 'artifacts']) assert.ok(!overview.body.includes(text), text);
    const report = (await f.app.inject({ url: `/api/automation/tasks/${f.parent.id}/sections/report`, headers: f.headers })).json();
    assert.equal(report.taskId, child.id); assert.equal(report.report.issues[0].detail, child.report.issues[0].detail); assert.equal(report.rule.hash, child.rule!.hash);
    const input = (await f.app.inject({ url: `/api/automation/tasks/${child.id}/sections/input`, headers: f.headers })).json(); assert.equal(input.message, child.message); assert.equal(input.rule.hash, child.rule!.hash);
    const delivery = (await f.app.inject({ url: `/api/automation/tasks/${f.parent.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(delivery.task.id, child.id); assert.ok(!('context' in delivery.task)); assert.ok(!('artifacts' in delivery.task.report));
    assert.equal(JSON.stringify(f.automationStore.task(child.id)), before);
    assert.equal((await f.app.inject({ url: `/api/automation/tasks/${randomUUID()}/summary`, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: `/api/automation/tasks/${child.id}/summary`, headers: { authorization: 'Bearer ' + f.vault.credentials.readToken } })).statusCode, 401);
  } finally { await f.close(); }
});

test('execution history is paginated newest first and compact notices retain history without long Agent diagnostics', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 42; i++) f.automationStore.event(f.parent.id, 'event-' + i);
    const url = `/api/automation/tasks/${f.parent.id}/sections/execution`;
    const first = (await f.app.inject({ url, headers: f.headers })).json();
    const second = (await f.app.inject({ url: url + '?page=2', headers: f.headers })).json();
    assert.equal(first.items.length, 20); assert.equal(first.items[0].message, 'event-41'); assert.ok(first.items.at(-1).seq > second.items[0].seq);
    f.automationStore.notice(f.parent, '任务已中断', 'FULL_DIAGNOSTIC internal-thread-id '.repeat(1000));
    const compact = (await f.app.inject({ url: '/api/automation/notifications?view=compact', headers: f.headers })).json().items[0];
    assert.equal(compact.resourceName, 'UI test'); assert.equal(compact.title, '任务已中断'); assert.equal(compact.superseded, true); assert.equal(compact.currentStatus, 'completed'); assert.ok(!('message' in compact));
    const legacy = (await f.app.inject({ url: '/api/automation/notifications', headers: f.headers })).json().items[0]; assert.ok(legacy.message.includes('FULL_DIAGNOSTIC'));
    f.child.status = 'interrupted'; f.automationStore.put(f.child); f.automationStore.notice(f.child, '任务已中断', 'details');
    const notices = (await f.app.inject({ url: '/api/automation/notifications?view=compact', headers: f.headers })).json().items;
    assert.equal(notices.find((x: any) => x.taskId === f.child.id).superseded, false);
  } finally { await f.close(); }
});

test('report and notification deep links select the requested section, default task entry stays on overview', () => {
  assert.equal(initialTaskTab(''), 'overview'); assert.equal(initialTaskTab('tab=report'), 'report'); assert.equal(initialTaskTab('tab=usage'), 'usage'); assert.equal(initialTaskTab('tab=invalid'), 'overview');
});
