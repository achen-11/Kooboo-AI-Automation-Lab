import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeInbox, type NoticeResponse } from '../frontend/src/lib/notice-inbox.js';
import type { CompactNotice, NoticePage } from '../shared/task-presentation.js';

const notice = (id: string, readAt: number | null = null): CompactNotice => ({ id, taskId: id, title: id, resourceName: 'Site', summary: 'Summary', tab: 'overview', createdAt: 1, readAt, superseded: false });
function response(page: number, items = [notice(page === 1 ? 'latest' : 'old')]): NoticePage { return { items, page, pages: 3, pageSize: 10, total: 25, unread: 18 }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(overrides: Partial<Parameters<typeof createNoticeInbox>[0]> = {}) {
  const announcements: string[] = [], errors: string[] = [];
  const inbox = createNoticeInbox({ fetchPage: async page => response(page), markRead: async () => ({ readAt: 10 }), markAllRead: async () => ({ readAt: 20 }),
    announce: item => announcements.push(item.id), reportError: message => errors.push(message), ...overrides });
  return { inbox, announcements, errors };
}

test('history navigation and polling preserve the page and only announce new arrivals on the latest page', async () => {
  let latest = [notice('latest')];
  const f = fixture({ fetchPage: async page => response(page, page === 1 ? latest : [notice('old')]) });
  await f.inbox.load(); await f.inbox.load(2);
  assert.equal(f.inbox.page.value, 2); assert.equal(f.inbox.items.value[0].id, 'old');
  assert.equal(f.inbox.unread.value, 18); assert.deepEqual(f.announcements, []);
  latest = [notice('new'), notice('already-read', 1), ...latest];
  await f.inbox.refresh(); await f.inbox.refresh();
  assert.deepEqual(f.announcements, ['new']); assert.equal(f.inbox.page.value, 2);
});

test('a stale polling response cannot undo a successful read or change its unread count', async () => {
  const pending = deferred<NoticePage>();
  let requests = 0;
  const f = fixture({ fetchPage: async page => ++requests === 1 ? response(page) : pending.promise });
  await f.inbox.load();
  const poll = f.inbox.refresh();
  assert.equal(await f.inbox.read(f.inbox.items.value[0]), true);
  assert.equal(f.inbox.unread.value, 17); assert.equal(f.inbox.items.value[0].readAt, 10);
  pending.resolve(response(1)); await poll;
  assert.equal(f.inbox.items.value[0].readAt, 10); assert.equal(f.inbox.unread.value, 17);
  assert.equal(f.inbox.busy.value, false);
});

test('bulk read updates every visible row and global count without treating history as new alerts', async () => {
  let read = false;
  const f = fixture({ fetchPage: async page => ({ ...response(page, [notice(String(page), read ? 20 : null)]), unread: read ? 0 : 18 }),
    markAllRead: async () => { read = true; return { readAt: 20 }; } });
  await f.inbox.load(2); assert.equal(await f.inbox.readAll(), true);
  assert.equal(f.inbox.items.value[0].readAt, 20); assert.equal(f.inbox.unread.value, 0);
  await f.inbox.load(3); assert.equal(f.inbox.items.value[0].readAt, 20); assert.equal(f.inbox.unread.value, 0);
  assert.deepEqual(f.announcements, []);
});

test('reading a desktop notification outside the visible page does not decrement unread twice', async () => {
  let writes = 0;
  const f = fixture({ markRead: async () => { writes++; return { readAt: 10 }; } });
  await f.inbox.load(2);
  const desktopItem = notice('latest');
  await f.inbox.read(desktopItem); await f.inbox.read(desktopItem);
  assert.equal(writes, 1); assert.equal(f.inbox.unread.value, 17);
  assert.equal(f.inbox.items.value[0].id, 'old'); assert.equal(f.inbox.items.value[0].readAt, null);
});

test('failed writes keep notifications unread and failed page loads retain content with a retryable error', async () => {
  let fail = false;
  const f = fixture({ fetchPage: async page => { if (fail) throw Error('offline'); return response(page); }, markRead: async () => { throw Error('offline'); }, markAllRead: async () => { throw Error('offline'); } });
  await f.inbox.load(); assert.equal(await f.inbox.read(f.inbox.items.value[0]), false);
  assert.equal(await f.inbox.readAll(), false); assert.equal(f.inbox.unread.value, 18); assert.equal(f.inbox.items.value[0].readAt, null); assert.equal(f.errors.length, 2);
  fail = true; await f.inbox.load(2);
  assert.equal(f.inbox.page.value, 1); assert.equal(f.inbox.items.value[0].id, 'latest'); assert.ok(f.inbox.error.value);
  fail = false; await f.inbox.load(2); assert.equal(f.inbox.error.value, ''); assert.equal(f.inbox.page.value, 2);
});

test('out-of-order page responses and unmounted inboxes cannot replace the current list', async () => {
  const old = deferred<NoticePage>();
  const f = fixture({ fetchPage: async page => page === 2 ? old.promise : response(page) });
  const previous = f.inbox.load(2); await f.inbox.load(3); old.resolve(response(2)); await previous;
  assert.equal(f.inbox.page.value, 3);
  const pending = deferred<NoticePage>(), g = fixture({ fetchPage: () => pending.promise });
  const loading = g.inbox.load(); g.inbox.dispose(); pending.resolve(response(1)); await loading;
  assert.deepEqual(g.inbox.items.value, []); assert.deepEqual(g.announcements, []);
});

test('legacy list-only responses provide concrete counts, local pagination and a durable read-all fallback', async () => {
  const saved = Array.from({ length: 25 }, (_, i) => notice(String(i), i < 7 ? 1 : null));
  let bulkCalls = 0;
  const writes: string[] = [];
  const f = fixture({ fetchPage: async () => ({ items: structuredClone(saved) }),
    markRead: async id => { writes.push(id); saved.find(item => item.id === id)!.readAt = 2; return {}; },
    markAllRead: async () => { bulkCalls++; throw Error('legacy endpoint unavailable'); } });
  await f.inbox.load();
  assert.equal(f.inbox.total.value, 25); assert.equal(f.inbox.unread.value, 18);
  assert.equal(f.inbox.page.value, 1); assert.equal(f.inbox.pages.value, 3); assert.equal(f.inbox.items.value.length, 10);
  await f.inbox.load(2); assert.equal(f.inbox.items.value[0].id, '10');
  assert.equal(await f.inbox.read(f.inbox.items.value[0]), true);
  assert.equal(typeof f.inbox.items.value[0].readAt, 'number'); assert.equal(f.inbox.unread.value, 17);
  await f.inbox.load(999); assert.equal(f.inbox.page.value, 3); assert.equal(f.inbox.items.value.length, 5);
  assert.equal(await f.inbox.readAll(), true); assert.equal(f.inbox.unread.value, 0);
  assert.equal(bulkCalls, 0); assert.equal(writes.length, 18); assert.equal(new Set(writes).size, 18);
  await f.inbox.load(1); assert.equal(f.inbox.unread.value, 0); assert.ok(f.inbox.items.value.every(item => item.readAt !== null));
  assert.deepEqual(f.announcements, []);
});

test('empty legacy responses keep a valid first page and legacy bulk failures retain the remaining unread items', async () => {
  const empty = fixture({ fetchPage: async () => ({ items: [] }) });
  await empty.inbox.load(9);
  assert.equal(empty.inbox.page.value, 1); assert.equal(empty.inbox.pages.value, 1);
  assert.equal(empty.inbox.total.value, 0); assert.equal(empty.inbox.unread.value, 0);
  let fail = true;
  const f = fixture({ fetchPage: async () => ({ items: [notice('ok'), notice('retry')] }),
    markRead: async id => { if (fail && id === 'retry') throw Error('offline'); return {}; } });
  await f.inbox.load(); assert.equal(await f.inbox.readAll(), false);
  assert.equal(f.inbox.unread.value, 1); assert.equal(f.inbox.items.value[1].readAt, null); assert.equal(f.errors.length, 1);
  fail = false; assert.equal(await f.inbox.readAll(), true); assert.equal(f.inbox.unread.value, 0);
});

test('incomplete pagination metadata never replaces valid counters with undefined values', async () => {
  let malformed = false;
  const f = fixture({ fetchPage: async page => malformed ? { items: [notice('bad')], total: undefined } as unknown as NoticeResponse : response(page) });
  await f.inbox.load(); malformed = true; await f.inbox.load(2);
  assert.equal(f.inbox.total.value, 25); assert.equal(f.inbox.page.value, 1); assert.equal(f.inbox.pages.value, 3);
  assert.equal(f.inbox.items.value[0].id, 'latest'); assert.ok(f.inbox.error.value);
});
