import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

// Exercise the actual summary, timing and composition components without controlling a browser.
const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'task-usage-component-'));
let TaskUsage;
before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({ entryPoints: [resolve('frontend/src/components/TaskUsage.vue')], bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'usage-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'usage-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'usage-test' }, () => ({ contents: 'export const api=(...args)=>globalThis.__usageServices.request(...args); export const message=e=>e.message; export const formatDate=String;', loader: 'js' }));
      builder.onLoad({ filter: /\.vue$/ }, args => {
        if (/(BaseSelect|TablePagination)\.vue$/.test(args.path)) return { contents: "import {h} from 'vue';export default {props:['modelValue','options'],emits:['update:modelValue'],setup:(p,{attrs,emit})=>()=>h('select',{...attrs,value:p.modelValue,onChange:value=>emit('update:modelValue',value)})};", loader: 'js' };
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(args.path) };
      });
    } }],
  });
  TaskUsage = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; }
  getRootNode() { return document; }
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
const text = node => (node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('');
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
const usage = overrides => ({ requests: 2, priced: 1, input: 100, cached: 20, output: 30, knownCny: 3, missing: 1, estimated: true, children: [], ...overrides });
const timing = overrides => ({ elapsedMs: 60000, recordedMs: 60000, modelMs: 45000, complete: true, active: false, unknownRequests: 3,
  stages: [{ stage: 'generation', recordedMs: 60000, modelMs: 30000, requests: 1 }, { stage: 'evaluation', recordedMs: 20000, modelMs: 15000, requests: 1 }, { stage: 'prepare', recordedMs: 0, modelMs: 0, requests: 0 }], ...overrides });
async function fixture({ props = {}, response = timing() } = {}) {
  const previous = new Map(['document', 'Document', '__usageServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class HostDocument { activeElement = null; visibilityState = 'visible'; }
  Object.defineProperty(globalThis, 'Document', { value: HostDocument, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new HostDocument(), configurable: true });
  const calls = [];
  Object.defineProperty(globalThis, '__usageServices', { configurable: true, value: { request: async path => {
    calls.push(path);
    if (path.endsWith('/timing')) return typeof response === 'function' ? response() : response;
    return { items: [], page: 1, pages: 1, total: 0 };
  } } });
  const container = new HostNode('root'), app = renderer.createApp({ render: () => h(TaskUsage, { taskId: 'task-1', siteId: 'site-1', summary: usage(), stageCosts: [
    { stage: 'generation', usage: usage() }, { stage: 'evaluation', usage: usage({ knownCny: 1 }) },
  ], ...props }) });
  app.mount(container); await settle();
  return { calls, nodes: predicate => descendants(container).filter(predicate), text: () => text(container),
    button: label => descendants(container).find(node => node.tag === 'button' && text(node) === label),
    close() { app.unmount(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } },
  };
}

test('cost and timing switch within one panel and use normalized stage shares despite overlapping intervals', async () => {
  const f = await fixture();
  try {
    assert.equal(f.nodes(n => n.tag === 'section').length, 2, 'one summary and one request-detail panel');
    assert.equal(f.button('费用').props['aria-pressed'], true);
    assert.ok(f.text().includes('¥ 3.0000'));
    assert.deepEqual(f.nodes(n => n.props.class === 'composition-segment').map(n => n.props.style.flexGrow), [.75, .25]);
    assert.ok(!f.calls.some(path => path.endsWith('/timing') || path.endsWith('/budget')));
    assert.ok(!/待核算|待核查|金额尚不完整/.test(f.text()));
    f.nodes(n => n.props['aria-label'] === '按执行阶段筛选用量')[0].props.onChange('evaluation'); await settle();
    f.button('耗时').props.onClick(); await settle();
    assert.equal(f.button('耗时').props['aria-pressed'], true);
    assert.equal(f.nodes(n => n.tag === 'section').length, 2);
    assert.ok(f.calls.includes('/automation/site-deliveries/site-1/timing'));
    assert.ok(f.text().includes('流程跨度1 分 0 秒'));
    assert.ok(f.text().includes('模型请求耗时45 秒'));
    assert.deepEqual(f.nodes(n => n.props.class === 'composition-segment').map(n => n.props.style.flexGrow), [.75, .25]);
    assert.ok(f.text().includes('75.0%')); assert.ok(f.text().includes('25.0%'));
    assert.ok(!f.text().includes('尚未确认结束'));
    const before = f.calls.length;
    f.nodes(n => n.props['aria-label'] === '刷新耗时')[0].props.onClick(); await settle();
    assert.equal(f.calls.length, before + 1);
    f.button('费用').props.onClick(); await settle();
    assert.ok(f.text().includes('¥ 3.0000'));
    assert.equal(f.nodes(n => n.props['aria-label'] === '按执行阶段筛选用量')[0].props.value, 'evaluation');
  } finally { f.close(); }
});

test('unpriced usage and historical model-only timing show empty composition without inventing cost or stage duration', async () => {
  const f = await fixture({ props: { siteId: undefined, summary: usage({ priced: 0, knownCny: 0 }), stageCosts: [{ stage: 'generation', usage: usage({ priced: 0, knownCny: 0 }) }] },
    response: timing({ elapsedMs: null, recordedMs: 0, complete: false, stages: [{ stage: 'generation', recordedMs: 0, modelMs: 45000, requests: 2 }] }) });
  try {
    assert.ok(!f.text().includes('¥ 0')); assert.ok(f.text().includes('暂无费用占比数据'));
    f.button('耗时').props.onClick(); await settle();
    assert.ok(f.calls.includes('/automation/tasks/task-1/timing'));
    assert.ok(f.text().includes('暂无阶段耗时占比数据'));
    assert.ok(f.text().includes('模型请求耗时45 秒'));
    assert.equal(f.nodes(n => n.props.class === 'composition-segment').length, 0);
    assert.ok(!/NaN|Infinity|100\.0%|待核算/.test(f.text()));
  } finally { f.close(); }
});

test('timing failure can be retried and cost view remains available', async () => {
  let attempt = 0;
  const f = await fixture({ response: () => { if (!attempt++) throw Error('耗时加载失败'); return timing(); } });
  try {
    f.button('耗时').props.onClick(); await settle();
    assert.ok(f.text().includes('耗时加载失败'));
    f.button('重试').props.onClick(); await settle();
    assert.ok(!f.text().includes('耗时加载失败'));
    assert.equal(f.nodes(n => n.props.class === 'composition-segment').length, 2);
    f.button('费用').props.onClick(); await settle(); assert.ok(f.text().includes('估算金额'));
  } finally { f.close(); }
});

test('cost and timing compositions distinguish initial generation from repair generation', async () => {
  const f = await fixture({props:{stageCosts:[{stage:'generation',usage:usage({knownCny:1})},{stage:'repair',usage:usage({knownCny:3})}]},
    response:timing({stages:[{stage:'generation',recordedMs:10000,modelMs:5000,requests:1},{stage:'repair',recordedMs:30000,modelMs:20000,requests:2}]})});
  try {
    assert.ok(f.text().includes('首次生成')); assert.ok(f.text().includes('修复生成'));
    const segments = () => f.nodes(n => n.props.class === 'composition-segment');
    assert.deepEqual(segments().map(n=>n.props.style.flexGrow), [.25,.75]);
    const colors = segments().map(n=>n.props.style.backgroundColor);
    assert.notEqual(colors[0], colors[1]);
    f.nodes(n => n.props['aria-label'] === '按执行阶段筛选用量')[0].props.onChange('repair'); await settle();
    assert.ok(f.calls.some(path=>path.includes('stage=repair')));
    f.button('耗时').props.onClick(); await settle();
    assert.ok(f.text().includes('首次生成')); assert.ok(f.text().includes('修复生成'));
    assert.deepEqual(segments().map(n=>n.props.style.backgroundColor),colors);
    assert.deepEqual(segments().map(n=>n.props.style.flexGrow), [.25,.75]);
  } finally { f.close(); }
});
