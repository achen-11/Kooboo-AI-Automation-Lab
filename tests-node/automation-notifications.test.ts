import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { NoticePage } from '../shared/task-presentation.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'automation-notifications-'));
  const services = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const resource = services.automationStore.saveResource({ name: 'Notification test', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalId: '', externalSource: '', files: [] });
  const task = services.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: randomUUID(), requirements: '' }, defaultAutomationSettings)[0];
  return { ...services, task, headers, directory,
    async close() { await services.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('notification pages cover all history, use stable ordering and count unread outside the current page', async () => {
  const f = await fixture();
  try {
    const get = (query: string) => f.app.inject({ url: `/api/automation/notifications${query}`, headers: f.headers });
    assert.deepEqual((await get('')).json(), { items: [] });
    assert.deepEqual((await get('?view=compact&page=1')).json(), { items: [], total: 0, unread: 0, page: 1, pages: 1, pageSize: 10 });
    for (let i = 0; i < 215; i++) {
      f.automationStore.notice(f.task, `Notice ${i}`, 'Full historical message');
      f.automationStore.db.prepare("UPDATE auto_notifications SET json=json_set(json,'$.createdAt',?,'$.readAt',?) WHERE title=?").run(Math.floor(i / 2), i < 7 ? 1 : null, `Notice ${i}`);
    }
    // Paginated access must not load the old, capped history list.
    f.automationStore.notices = () => { throw new Error('unbounded notice read'); };
    const ids: string[] = [];
    for (let page = 1; page <= 22; page++) {
      const response = await get(`?view=compact&page=${page}&pageSize=10`);
      assert.equal(response.statusCode, 200);
      const result = response.json<NoticePage>();
      assert.equal(result.total, 215); assert.equal(result.unread, 208); assert.equal(result.pages, 22);
      assert.equal(result.items.length, page === 22 ? 5 : 10);
      assert.ok(!response.body.includes('Full historical message'));
      ids.push(...result.items.map(item => item.id));
    }
    assert.equal(new Set(ids).size, 215);
    const expected = f.automationStore.db.prepare("SELECT id FROM auto_notifications ORDER BY json_extract(json,'$.createdAt') DESC,id DESC").all().map(row => row.id);
    assert.deepEqual(ids, expected);
    const last = (await get('?view=compact&page=999&pageSize=10')).json<NoticePage>();
    assert.equal(last.page, 22); assert.equal(last.items.length, 5);
    for (const query of ['?page=0', '?pageSize=101', '?page=1.5', '?pageSize=0', '?page=bad']) assert.equal((await get(query)).statusCode, 400);
  } finally { await f.close(); }
});

test('single and bulk read are durable, idempotent and preserve new arrivals and replacement notices', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 205; i++) f.automationStore.notice(f.task, `Notice ${i}`, 'message');
    const get = () => f.app.inject({ url: '/api/automation/notifications?view=compact&page=1&pageSize=10', headers: f.headers });
    const first = (await get()).json<NoticePage>().items[0];
    const read = () => f.app.inject({ method: 'POST', url: `/api/automation/notifications/${first.id}/read`, headers: f.headers });
    const single = (await read()).json();
    assert.equal(typeof single.readAt, 'number'); assert.deepEqual((await read()).json(), single);
    assert.equal((await get()).json<NoticePage>().unread, 204);
    const all = await f.app.inject({ method: 'POST', url: '/api/automation/notifications/read', headers: f.headers });
    assert.equal(all.statusCode, 200);
    assert.equal((await get()).json<NoticePage>().unread, 0);
    assert.equal(f.automationStore.readNotice(first.id)?.readAt, single.readAt);
    const last = f.automationStore.noticePage(999, 10);
    assert.ok(last.items.every(item => item.readAt !== null));
    f.automationStore.notice(f.task, 'New arrival', 'message');
    f.automationStore.notice(f.task, first.title, 'New occurrence');
    const updated = (await get()).json<NoticePage>();
    assert.equal(updated.total, 206); assert.equal(updated.unread, 2);
    assert.equal((await read()).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/notifications/${randomUUID()}/read`, headers: f.headers })).statusCode, 404);
    for (const url of ['/api/automation/notifications/read', `/api/automation/notifications/${updated.items[0].id}/read`]) {
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    }
    assert.equal((await get()).json<NoticePage>().unread, 2);
  } finally { await f.close(); }
});
