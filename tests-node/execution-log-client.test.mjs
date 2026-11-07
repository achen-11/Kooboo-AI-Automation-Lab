import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createRenderer, nextTick, ref } from 'vue';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'execution-log-client-'));
let useExecutionLog;
before(async () => {
  const outfile = join(directory, 'client.cjs');
  await build({ entryPoints: [resolve('frontend/src/lib/execution-log.ts')], bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'execution-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'execution-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'execution-test' }, () => ({ contents: 'export const api=(...args)=>globalThis.__executionRequest(...args); export const message=e=>e.message;', loader: 'js' }));
    } }] });
  ({ useExecutionLog } = require(outfile));
});
after(() => rmSync(directory, { recursive: true, force: true }));

const renderer = createRenderer({
  createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
});
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
function record(seq) { return { seq, time: 1000 + seq, message: 'record-' + seq, content: 'record-' + seq, preview: 'record-' + seq, title: '流程记录', kind: 'system', status: 'unknown', command: false }; }
const related = [{ id: 'root', label: '生成' }, { id: 'child', label: '评测' }];
function page(seqs = [3, 4], extra = {}) {
  return { taskId: 'root', items: seqs.map(record), total: 4, latestSeq: 4, snapshotSeq: 4, pageSize: 2, hasOlder: true, related, ...extra };
}
async function fixture() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__executionRequest');
  const requests = [], taskId = ref('root'), revision = ref(0);
  Object.defineProperty(globalThis, '__executionRequest', { configurable: true, value: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  let log;
  const app = renderer.createApp({ setup() { log = useExecutionLog(() => taskId.value, () => revision.value); return () => null; } });
  app.mount({});
  return { log, requests, taskId, revision,
    close() { app.unmount(); if (previous) Object.defineProperty(globalThis, '__executionRequest', previous); else delete globalThis.__executionRequest; } };
}

test('an in-flight live refresh cannot replace the history or inspector after the reader pauses', async () => {
  const f = await fixture();
  try {
    f.requests[0].resolve(page()); await settle();
    assert.deepEqual(f.log.records.value.map(item => item.seq), [4, 3]);
    const refresh = f.log.checkUpdates();
    f.requests[1].resolve({ taskId: 'root', latestSeq: 5, total: 5 }); await settle();
    assert.equal(f.requests.length, 3);
    const selected = f.log.data.value.items[0]; f.log.inspect(selected);
    f.requests[2].resolve(page([4, 5], { total: 5, latestSeq: 5, snapshotSeq: 5 })); await refresh;
    assert.deepEqual(f.log.data.value.items.map(item => item.seq), [3, 4]);
    assert.deepEqual(f.log.records.value.map(item => item.seq), [4, 3]);
    assert.equal(f.log.selected.value, selected); assert.equal(f.log.pending.value, 1); assert.equal(f.log.following.value, false);
    const latest = f.log.latest();
    f.requests[3].resolve(page([4, 5], { total: 5, latestSeq: 5, snapshotSeq: 5 })); await latest;
    assert.deepEqual(f.log.data.value.items.map(item => item.seq), [4, 5]);
    assert.deepEqual(f.log.records.value.map(item => item.seq), [5, 4]);
    assert.equal(f.log.selected.value, null); assert.equal(f.log.following.value, true); assert.equal(f.log.pending.value, 0);
  } finally { f.close(); }
});

test('loading older history preserves its snapshot and selected event while arrivals only change the pending count', async () => {
  const f = await fixture();
  try {
    f.requests[0].resolve(page()); await settle();
    const selected = f.log.data.value.items[0]; f.log.inspect(selected);
    const check = f.log.checkUpdates(); f.requests[1].resolve({ taskId: 'root', latestSeq: 6, total: 6 }); await check;
    assert.equal(f.requests.length, 2); assert.equal(f.log.pending.value, 2);
    const older = f.log.loadOlder();
    const params = new URL(f.requests[2].url, 'https://local.test').searchParams;
    assert.equal(params.get('until'), '4'); assert.equal(params.get('before'), '3');
    f.requests[2].resolve(page([1, 2], { hasOlder: false })); await older;
    assert.deepEqual(f.log.data.value.items.map(item => item.seq), [1, 2, 3, 4]);
    assert.deepEqual(f.log.records.value.map(item => item.seq), [4, 3, 2, 1]);
    assert.equal(f.log.data.value.total, 4); assert.equal(f.log.data.value.snapshotSeq, 4);
    assert.equal(f.log.pending.value, 2); assert.equal(f.log.selected.value, selected); assert.equal(f.log.data.value.hasOlder, false);
  } finally { f.close(); }
});

test('scope changes ignore late responses and keep the workflow selector available during loading', async () => {
  const f = await fixture();
  try {
    f.requests[0].resolve(page()); await settle();
    f.log.inspect(f.log.data.value.items[0]); f.log.stage.value = 'child'; await nextTick();
    assert.equal(f.log.selected.value, null); assert.equal(f.log.data.value, null); assert.deepEqual(f.log.related.value, related);
    f.log.query.value = 'previous error'; await nextTick();
    assert.equal(f.requests[1].options.signal.aborted, true);
    f.requests[2].resolve(page([8], { taskId: 'child', total: 1, hasOlder: false })); await settle();
    f.requests[1].resolve(page([7], { taskId: 'child' })); await settle();
    assert.deepEqual(f.log.data.value.items.map(item => item.seq), [8]);
    assert.ok(f.requests[2].url.includes('q=previous+error'));
    f.taskId.value = 'different-task'; await nextTick();
    assert.equal(f.log.stage.value, ''); assert.deepEqual(f.log.related.value, []);
    assert.ok(f.requests[3].url.includes('/different-task/')); assert.ok(!f.requests[3].url.includes('taskId=child'));
    f.requests[3].resolve(page([20], { taskId: 'different-task', related: [], total: 1, hasOlder: false })); await settle();
    assert.equal(f.log.data.value.taskId, 'different-task');
  } finally { f.close(); }
});

test('failed history requests keep the selected record and can be retried without losing the snapshot', async () => {
  const f = await fixture();
  try {
    f.requests[0].resolve(page()); await settle();
    const selected = f.log.data.value.items[0]; f.log.inspect(selected);
    const failed = f.log.loadOlder(); f.requests[1].reject(Error('连接失败')); await failed;
    assert.equal(f.log.error.value, '连接失败'); assert.equal(f.log.selected.value, selected);
    assert.deepEqual(f.log.data.value.items.map(item => item.seq), [3, 4]); assert.equal(f.log.olderLoading.value, false);
    const retry = f.log.loadOlder(); f.requests[2].resolve(page([1, 2], { hasOlder: false })); await retry;
    assert.equal(f.log.error.value, ''); assert.equal(f.log.selected.value, selected); assert.equal(f.log.data.value.items.length, 4);
  } finally { f.close(); }
});
