import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'task-recovery-component-'));
let TaskDetail;
before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({ entryPoints: [resolve('frontend/src/views/automation/TaskDetail.vue')], bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'recovery-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'recovery-test' }));
      builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'recovery-test' }));
      builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'recovery-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'recovery-test' }, args => ({ contents: args.path === 'api'
        ? 'export const api=(...args)=>globalThis.__recoveryServices.request(...args); export const message=e=>e.message; export const formatDate=String; export const go=()=>{};'
        : args.path === 'common' ? 'export const workspace={settings:{}}; export const scopeName=()=>"全站";'
        : 'export const notify={success:()=>{}};', loader: 'js' }));
      builder.onLoad({ filter: /\.vue$/ }, args => {
        if (args.path.endsWith('/ExecutionLog.vue')) return { contents: "import {h} from 'vue';export default {emits:['stage-change'],setup:(_, {emit})=>()=>h('button',{'data-stage':true,onClick:()=>emit('stage-change','child')},'选择评测轮次')};", loader: 'js' };
        if (!/\/(TaskDetail|TaskExecution|TaskRecoveryActions)\.vue$/.test(args.path)) return { contents: "import {h} from 'vue';export default {setup:(_, {slots})=>()=>h('div',slots.default?.())};", loader: 'js' };
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(args.path) };
      });
    } }],
  });
  TaskDetail = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; }
  removeAttribute(name) { delete this.props[name]; }
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }
const summary = (id, kind = 'evaluation') => ({ id, kind, resourceId: 'resource', resourceName: 'Car Repair', scenario: 'site-template', scope: 'site', environmentId: '', generatedSiteId: 'site', status: 'interrupted', stopped: false, createdAt: 1, updatedAt: 1, siteUrl: '', report: null, attention: '原评测执行尚未确认停止', nextStep: '确认停止后恢复' });
async function fixture({ pair = false, fail = false, legacy = false, cancelled = false } = {}) {
  const previous = new Map(['window', 'document', '__recoveryServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { location: { hash: cancelled ? '#/tasks/root' : '#/tasks/root?tab=execution' }, history: { replaceState() {} } });
  const root = summary('root', pair || cancelled ? 'generation' : 'evaluation'), child = summary('child');
  if (pair) Object.assign(root, { status: 'completed', stopped: true, attention: '', evaluationTaskId: child.id });
  if (cancelled) Object.assign(root, { generatedSiteId: null, status: 'cancelled', stopped: true, attention: '', nextStep: '' });
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    if (options.method === 'POST') {
      if (fail) throw Error('执行器仍有占用');
      const task = path.includes('/child/') ? child : root;
      if (path.endsWith('/confirm-stopped')) task.stopped = true;
      if (path.endsWith('/resume')) { task.status = 'queued'; task.attention = ''; }
      task.updatedAt++;
      return structuredClone(task);
    }
    if (path.endsWith('/summary')) return structuredClone({ task: path.includes('/child/') ? child : root, evaluation: pair ? child : null, active: null, deliveryEnabled: false, latest: null });
    if (path.includes('/sections/execution')) {
      const task = path.includes('taskId=child') ? child : root;
      return structuredClone({ task: legacy ? undefined : { id: task.id, status: task.status, stopped: task.stopped }, context: '', error: '', interruption: task.status === 'interrupted' ? { reason: task.attention, nextSteps: ['先确认停止再恢复'], resumeFrom: '保留证据', attempted: [] } : undefined });
    }
    throw Error(`Unexpected request ${path}`);
  };
  for (const [key, value] of Object.entries({ window, document, __recoveryServices: { request } })) Object.defineProperty(globalThis, key, { value, configurable: true });
  const container = new HostNode('root'), app = renderer.createApp({ render: () => h(TaskDetail, { id: root.id }) });
  app.mount(container); await settle();
  return { calls, root, child, text: () => text(container), nodes: () => descendants(container),
    buttons: label => descendants(container).filter(n => n.tag === 'button' && text(n) === label),
    close() { app.unmount(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } },
  };
}

test('direct execution links expose stop confirmation in both header and interruption details, then recovery', async () => {
  const f = await fixture();
  try {
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    assert.equal(f.buttons('恢复任务').length, 0);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/root/confirm-stopped']);
    assert.equal(f.buttons('已检查并确认原执行停止').length, 0);
    assert.equal(f.buttons('恢复任务').length, 2);
    await f.buttons('恢复任务')[1].props.onClick(); await settle();
    assert.equal(f.calls.filter(c => c.method === 'POST').at(-1).path, '/automation/tasks/root/resume');
    assert.equal(f.buttons('恢复任务').length, 0, 'historical interruption must not leave an actionable recovery button');
  } finally { f.close(); }
});

test('confirmation is available across tabs and a selected evaluation uses its own task identity', async () => {
  const f = await fixture({ pair: true });
  try {
    assert.equal(f.buttons('已检查并确认原执行停止').length, 1, 'header operates on the interrupted evaluation');
    f.nodes().find(n => n.props['data-stage']).props.onClick(); await settle();
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/child/confirm-stopped']);
    assert.equal(f.root.status, 'completed');
    f.buttons('输入与配置')[0].props.onClick(); await settle();
    assert.equal(f.buttons('恢复任务').length, 1, 'shared header remains available outside Overview');
  } finally { f.close(); }
});

test('rejected confirmation keeps the action available and displays the server error without resuming', async () => {
  const f = await fixture({ fail: true });
  try {
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.ok(f.text().includes('执行器仍有占用'));
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    assert.equal(f.buttons('恢复任务').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  } finally { f.close(); }
});

test('an older running server supports selected-round recovery through compact task metadata', async () => {
  const f = await fixture({ pair: true, legacy: true });
  try {
    f.nodes().find(n => n.props['data-stage']).props.onClick(); await settle();
    assert.ok(f.calls.some(c => c.path === '/automation/tasks/child/summary'));
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/child/confirm-stopped']);
    assert.equal(f.buttons('恢复任务').length, 2);
  } finally { f.close(); }
});

test('cancelled tasks expose restart button in header and execution tab and queue via resume', async () => {
  const f = await fixture({ cancelled: true });
  try {
    assert.equal(f.buttons('重新启动').length, 1, 'header exposes restart on Overview');
    await f.buttons('执行记录')[0].props.onClick(); await settle();
    assert.equal(f.buttons('重新启动').length, 2, 'both header and execution panel expose restart');
    assert.ok(f.text().includes('任务已取消'));
    await f.buttons('重新启动')[0].props.onClick(); await settle();
    assert.equal(f.calls.filter(c => c.method === 'POST').at(-1).path, '/automation/tasks/root/resume');
    assert.equal(f.buttons('重新启动').length, 0);
  } finally { f.close(); }
});
