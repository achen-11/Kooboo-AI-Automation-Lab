import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

// Execute the actual component with Vue's renderer and plain API responses, without a browser.
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'billing-settings-component-'));
let BillingSettings;
before(async () => {
  const filename = resolve('frontend/src/components/BillingSettings.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'billing-test', inlineTemplate: true });
  const outfile = join(directory, 'component.cjs');
  await build({ stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'billing-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'billing-test' }));
      builder.onResolve({ filter: /^\.\.\/lib\/notifications$/ }, () => ({ path: 'notifications', namespace: 'billing-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'billing-test' }, args => ({ contents: args.path === 'api'
        ? 'export const api=(...args)=>globalThis.__billingServices.request(...args); export const message=e=>e.message; export const formatDate=String;'
        : 'export const notify={success:text=>globalThis.__billingServices.success.push(text)};', loader: 'js' }));
    } }] });
  BillingSettings = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; this.value = ''; }
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
  patchProp(node, key, previous, value) { node.props[key] = value; if (key === 'value' || key === 'type') node[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
function snapshot() {
  return { id: 'original-price', verifiedAt: 1, effectiveFrom: 1, source: 'https://example.test/prices', currency: 'CNY', models: ['test-model'],
    peak: { cached: 0.1, input: 1, output: 2 }, offpeak: { cached: 0.05, input: 0.5, output: 1 }, holidays: { 2026: ['2026-01-01'] } };
}
async function fixture(request) {
  const previous = new Map(['document', 'Document', '__billingServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const success = [];
  class HostDocument { activeElement = null; }
  Object.defineProperty(globalThis, 'Document', { value: HostDocument, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new HostDocument(), configurable: true });
  Object.defineProperty(globalThis, '__billingServices', { value: { request, success }, configurable: true });
  const container = new HostNode('root'), app = renderer.createApp({ render: () => h(BillingSettings) });
  app.mount(container); await settle();
  return { success, nodes: predicate => descendants(container).filter(predicate),
    close() { app.unmount(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } } };
}

test('billing settings load an editable draft without cloning Vue proxies and preserve the historical snapshot on publish', async () => {
  const original = snapshot(), saved = structuredClone(original), versions = [original];
  let published;
  const f = await fixture(async (path, options = {}) => {
    assert.equal(path, '/automation/prices');
    if (options.method === 'POST') { published = JSON.parse(options.body); versions.push({ ...published, id: 'new-price' }); return versions.at(-1); }
    return { items: versions };
  });
  try {
    const inputs = () => f.nodes(node => node.tag === 'input');
    assert.equal(inputs().length, 7); assert.equal(f.nodes(node => node.props.class === 'alert error').length, 0);
    assert.equal(inputs()[0].value, original.source);
    inputs()[0].props['onUpdate:modelValue']('https://example.test/new-prices');
    inputs()[1].props['onUpdate:modelValue'](9);
    const textareas = f.nodes(node => node.tag === 'textarea');
    textareas[0].props.onInput({ target: { value: 'new-model\nsecond-model' } });
    textareas[1].props['onUpdate:modelValue']('{"2026":["2026-02-17"]}');
    await nextTick();
    assert.deepEqual(original, saved);
    await f.nodes(node => node.tag === 'button')[0].props.onClick(); await settle();
    assert.equal(published.source, 'https://example.test/new-prices'); assert.equal(published.peak.cached, 9);
    assert.deepEqual(published.models, ['new-model', 'second-model']); assert.deepEqual(published.holidays, { 2026: ['2026-02-17'] });
    assert.equal('id' in published, false); assert.deepEqual(original, saved);
    assert.equal(f.success.length, 1); assert.equal(f.nodes(node => node.props.class === 'alert error').length, 0);
    assert.equal(inputs()[0].value, published.source);
  } finally { f.close(); }
});

test('a failed publish leaves the editable draft intact and reports the error without a success message', async () => {
  const f = await fixture(async (path, options = {}) => {
    if (options.method === 'POST') throw Error('保存失败');
    return { items: [snapshot()] };
  });
  try {
    const source = f.nodes(node => node.tag === 'input')[0];
    assert.ok(source);
    source.props['onUpdate:modelValue']('https://example.test/edited'); await nextTick();
    await f.nodes(node => node.tag === 'button')[0].props.onClick(); await settle();
    assert.equal(f.nodes(node => node.props.class === 'alert error')[0].text, '保存失败');
    assert.equal(f.nodes(node => node.tag === 'input')[0].value, 'https://example.test/edited');
    assert.equal(f.nodes(node => node.tag === 'button')[0].props.disabled, false); assert.equal(f.success.length, 0);
  } finally { f.close(); }
});

test('an empty price response does not attempt to clone a missing version', async () => {
  const f = await fixture(async () => ({ items: [] }));
  try { assert.equal(f.nodes(node => node.tag === 'input').length, 0); assert.equal(f.nodes(node => node.props.class === 'alert error').length, 0); }
  finally { f.close(); }
});
