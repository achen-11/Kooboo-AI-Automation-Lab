import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'queue-component-'));
let Component;
before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({ entryPoints: [resolve('frontend/src/views/automation/QueueDiagnostics.vue')], bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'queue-test-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /\/(api|lib\/notifications)$/ }, args => ({ path: args.path.endsWith('/api') ? 'api' : 'notifications', namespace: 'queue-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'queue-test' }, args => ({ contents: args.path === 'api'
        ? 'export const api=(...args)=>globalThis.__queueServices.request(...args);export const message=e=>e.message;export const formatDate=String;'
        : 'export const notify={success:t=>globalThis.__queueServices.notified.push(t)};', loader: 'js' }));
      builder.onLoad({ filter: /\.vue$/ }, args => {
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(args.path) };
      });
    } }],
  });
  Component = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));
class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; }
  showModal() { this.props.open = true; }
  close() { this.props.open = false; }
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const content = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(content).join('')).trim();
async function flush() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }
async function fixture({ delivery = false, workerReady = true, rejectConfirmation = false } = {}) {
  const previous = new Map(['document', '__queueServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const task = { id: 'old-task', resourceName: 'Original homepage', kind: 'generation', status: 'pending', updatedAt: 123, target: delivery ? 'delivery' : 'task', canConfirmStopped: true };
  const diagnostic = { checkedAt: 1000, enabled: true, workerReady, maintenance: false, capacity: { generation: { executing: 0, occupied: 1, unconfirmed: 1, limit: 1 }, evaluation: { executing: 0, occupied: 0, unconfirmed: 0, limit: 1 } }, reservations: { items: [task], total: 1, page: 1, pages: 1, pageSize: 10 }, waiting: { items: [{ ...task, id: 'waiting-task', resourceName: 'Waiting homepage', scope: 'homepage', reason: { code: 'capacity', message: '并发名额被原任务占用', blockers: [task], blockingCount: 1 } }], total: 1, page: 1, pages: 1, pageSize: 10 } };
  const calls = [], notified = []; let changed = 0;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === 'POST') {
      if (rejectConfirmation) throw new Error('任务状态已变化，请刷新队列诊断后重新核实');
      diagnostic.reservations.items = []; diagnostic.reservations.total = 0; diagnostic.capacity.generation.occupied = 0; diagnostic.capacity.generation.unconfirmed = 0;
      return {};
    }
    const result = structuredClone(diagnostic);
    if (path.includes('summaryOnly=1')) { result.waiting.items = []; result.reservations.items = []; }
    return result;
  };
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  Object.defineProperty(globalThis, '__queueServices', { value: { request, notified }, configurable: true });
  const root = new HostNode('root'), app = renderer.createApp({ render: () => h(Component, { onChanged: () => changed++ }) });
  app.mount(root); await flush();
  const nodes = () => descendants(root), button = name => nodes().find(node => node.tag === 'button' && content(node) === name);
  const click = async node => { assert.ok(node, 'expected button'); assert.ok(!node.props.disabled, 'button must be enabled'); await node.props.onClick(); await flush(); };
  await click(nodes().find(node => node.tag === 'button' && content(node).startsWith('队列诊断')));
  return { root, nodes, button, click, calls, notified, changed: () => changed, text: () => content(root), verify: async () => { nodes().find(node => node.tag === 'input').props['onUpdate:modelValue'](true); await nextTick(); }, close() { app.unmount(); for (const [key, value] of previous) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } };
}

test('queue dialog shows blocking task links and requires explicit stop verification before one confirmation', async () => {
  const f = await fixture(); try {
    assert.ok(f.text().includes('已占用 1 / 1')); assert.ok(f.text().includes('并发名额被原任务占用'));
    assert.ok(f.nodes().some(node => node.props.href === '#/tasks/old-task?tab=execution'));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    await f.click(f.button('确认已停止'));
    assert.equal(f.button('确认并释放占位').props.disabled, true);
    await f.verify(); await f.click(f.button('确认并释放占位'));
    const posts = f.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/automation/tasks/old-task/confirm-stopped'); assert.deepEqual(JSON.parse(posts[0].body), { expectedUpdatedAt: 123 });
    assert.equal(f.changed(), 1); assert.equal(f.notified.length, 1); assert.equal(f.button('确认已停止'), undefined);
    assert.ok(!f.calls.some(call => /resume|cancel/.test(call.path)), 'stop confirmation never resumes or cancels unrelated tasks');
  } finally { f.close(); }
});

test('stale stop confirmation is shown as a persistent error and requires verification again', async () => {
  const f = await fixture({ rejectConfirmation: true }); try {
    await f.click(f.button('确认已停止')); await f.verify(); await f.click(f.button('确认并释放占位'));
    assert.ok(f.text().includes('任务状态已变化')); assert.equal(f.changed(), 0); assert.deepEqual(f.notified, []);
    assert.equal(f.button('确认并释放占位'), undefined);
    await f.click(f.button('重新检查')); await f.click(f.button('确认已停止'));
    assert.equal(f.button('确认并释放占位').props.disabled, true);
  } finally { f.close(); }
});

test('delivery confirmation uses the original delivery endpoint and explains the retained unknown receipt', async () => {
  const f = await fixture({ delivery: true }); try {
    await f.click(f.button('确认已停止')); assert.ok(f.text().includes('仍保留同站执行权'));
    await f.verify(); await f.click(f.button('确认交付已停止'));
    assert.equal(f.calls.find(call => call.method === 'POST').path, '/automation/tasks/old-task/delivery/confirm-stopped');
  } finally { f.close(); }
});

test('worker unavailable is visible independently of queue preferences', async () => {
  const f = await fixture({ workerReady: false }); try {
    assert.ok(f.text().includes('后台执行服务未就绪')); assert.ok(f.text().includes('页面在线不代表后台正在执行'));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  } finally { f.close(); }
});
