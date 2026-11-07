import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { executionRecord } from '../shared/execution-log.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'execution-log-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const resource = f.automationStore.saveResource({ name: '执行记录', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalId: '', externalSource: '', files: [] });
  const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: 'local', requirements: '' }, defaultAutomationSettings)[0];
  const get = (query = '') => f.app.inject({ url: `/api/automation/tasks/${task.id}/execution-log${query}`, headers });
  return { ...f, task, get, headers, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('tool failures use recorded status, while command contents and unknown messages do not imply failure or success', () => {
  const event = (message: string) => executionRecord({ seq: 1, time: 1000, message });
  const content = 'python3 - <<\'PY\'\nprint("failed")\nPY';
  const completed = event('执行工具 completed：' + content);
  assert.equal(completed.status, 'completed'); assert.equal(completed.content, content); assert.equal(completed.command, true);
  assert.equal(completed.message, '执行工具 completed：' + content);
  assert.equal(event('跟进工具执行 failed：curl example.test\nconnection refused').status, 'failed');
  assert.equal(event('工具 browser/click：failed').status, 'failed');
  assert.equal(event('执行工具 in_progress：node browser.mjs').status, 'running');
  assert.equal(event('AI 工具失败：request failed').kind, 'tool');
  assert.equal(event('AI 跟进：发现历史记录里的 failed，不影响本次运行').status, 'unknown');
  assert.equal(event('遇到过错误，已恢复').status, 'unknown');
  assert.equal(event('遇到过错误，已恢复').content, '遇到过错误，已恢复');
  assert.equal(event('任务已中断：预算耗尽').status, 'failed');
  assert.equal(event('AI 评测：检查完成').kind, 'assistant');
  assert.equal(event('x'.repeat(1000)).preview.length, 241);
});

test('cursor history is chronological and prepending older pages stays complete and stable during new arrivals', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 47; i++) f.automationStore.event(f.task.id, 'record-' + i);
    f.automationStore.events = () => { throw new Error('unbounded history read'); };
    const first = (await f.get()).json();
    assert.equal(first.items.length, 20); assert.equal(first.total, 48); assert.equal(first.hasOlder, true);
    assert.equal(first.items.at(-1).message, 'record-46');
    assert.ok(first.items.every((item: any, index: number) => !index || item.seq > first.items[index - 1].seq));
    f.automationStore.event(f.task.id, 'new-arrival');
    const second = (await f.get(`?until=${first.snapshotSeq}&before=${first.items[0].seq}`)).json();
    const third = (await f.get(`?until=${first.snapshotSeq}&before=${second.items[0].seq}`)).json();
    const records = [...third.items, ...second.items, ...first.items];
    assert.equal(second.total, 48); assert.equal(third.hasOlder, false); assert.equal(records.length, 48);
    assert.equal(new Set(records.map((item: any) => item.seq)).size, 48);
    assert.ok(records.every((item: any) => item.message !== 'new-arrival'));
    const head = (await f.get('?head=1')).json(); assert.equal(head.total, 49); assert.ok(head.latestSeq > first.snapshotSeq); assert.ok(!('items' in head));
    const latest = (await f.get()).json(); assert.equal(latest.items.at(-1).message, 'new-arrival');
    const legacy = (await f.app.inject({ url: `/api/automation/tasks/${f.task.id}/sections/execution`, headers: f.headers })).json();
    assert.equal(legacy.items[0].message, 'new-arrival'); assert.equal(legacy.items.length, 20);
  } finally { await f.close(); }
});

test('search and event filters cover all persisted records before limiting, including literal wildcard characters', async () => {
  const f = await fixture();
  try {
    f.automationStore.event(f.task.id, '执行工具 failed：curl OLD_HIDDEN_COMMAND');
    f.automationStore.event(f.task.id, 'AI 跟进：OLD_HIDDEN_ASSISTANT');
    f.automationStore.event(f.task.id, '工具 browser/click：failed');
    f.automationStore.event(f.task.id, 'AI 工具失败：connection refused');
    for (let i = 0; i < 40; i++) f.automationStore.event(f.task.id, `执行工具 completed：echo "failed ${i}"`);
    f.automationStore.event(f.task.id, 'literal 100% _ value');
    assert.equal((await f.get('?q=old_hidden')).json().total, 2);
    assert.equal((await f.get('?q=OLD_HIDDEN&filter=assistant')).json().items[0].kind, 'assistant');
    const failed = (await f.get('?filter=error')).json(); assert.equal(failed.total, 3); assert.ok(failed.items.every((item: any) => item.status === 'failed'));
    assert.equal((await f.get('?filter=tool')).json().total, 43);
    assert.equal((await f.get('?q=%25')).json().total, 1);
    assert.equal((await f.get('?q=_')).json().total, 3);
    assert.equal((await f.get('?q=no-match')).json().items.length, 0);
  } finally { await f.close(); }
});

test('stage selection is restricted to the current workflow and endpoints require a local session', async () => {
  const f = await fixture();
  try {
    const site = { id: randomUUID(), resourceId: f.task.resourceId, versionId: f.task.versionId, environmentId: 'local', siteId: randomUUID(), name: 'Target', url: 'https://example.test', createdAt: Date.now() };
    f.automationStore.saveSite(site); f.task.generatedSiteId = site.id; f.task.siteUrl = site.url; f.task.status = 'completed'; f.automationStore.put(f.task);
    const child = f.automationStore.ensureEvaluation(f.task, defaultAutomationSettings);
    f.automationStore.event(child.id, 'child-event');
    const selected = (await f.get('?taskId=' + child.id)).json();
    assert.equal(selected.taskId, child.id); assert.equal(selected.items.at(-1).message, 'child-event'); assert.equal(selected.related.length, 2);
    assert.equal((await f.get('?taskId=' + randomUUID())).statusCode, 409);
    assert.equal((await f.app.inject({ url: `/api/automation/tasks/${f.task.id}/execution-log` })).statusCode, 401);
    for (const invalid of ['?before=-1', '?pageSize=0', '?pageSize=101', '?filter=invalid', '?until=1.2', '?q=' + 'x'.repeat(201)]) assert.equal((await f.get(invalid)).statusCode, 400, invalid);
  } finally { await f.close(); }
});
