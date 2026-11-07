import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick, ref } from 'vue';

// A Vue host simulator exercises component events without launching or controlling a browser.
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'base-select-component-'));
let BaseSelect;
before(async () => {
  const filename = resolve('frontend/src/components/BaseSelect.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'select-test', inlineTemplate: true });
  const outfile = join(directory, 'component.cjs');
  await build({ stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'shared-vue', setup(builder) { builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true })); } }] });
  BaseSelect = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.text = text; this.children = []; this.parent = null; this.props = {}; this.style = {}; this.value = ''; }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  querySelector(selector) { const id = selector.match(/^\[id="(.+)"\]$/)?.[1]; return descendants(this).find(node => node.props.id === id) || null; }
  getBoundingClientRect() { return this.tag === 'button' ? { left: 100, top: 100, bottom: 142, width: 240, height: 42 } : { height: 200 }; }
  showPopover() { this.showing = true; }
  hidePopover() { this.showing = false; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function insert(node, parent, anchor = null) {
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
  node.parent = parent; const index = parent.children.indexOf(anchor);
  parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert, remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, previous, value) {
    node.props[key] = value;
    if (/^on[A-Z]/.test(key) && !key.startsWith('onUpdate:')) {
      const name = key.slice(2).toLowerCase();
      if (previous) node.removeEventListener(name, previous);
      if (value) node.addEventListener(name, value);
    } else if (key === 'value') node.value = value == null ? '' : String(value);
  },
});
const settle = async () => { await nextTick(); await nextTick(); };
async function event(node, type, values = {}) {
  const value = new Event(type, { cancelable: true, bubbles: true });
  for (const [key, item] of Object.entries({ target: node, ...values })) Object.defineProperty(value, key, { value: item });
  let stopped = false;
  const stop = value.stopPropagation.bind(value);
  value.stopPropagation = () => { stopped = true; stop(); };
  for (let current = node; current; current = stopped ? null : current.parent) current.dispatchEvent(value);
  await settle(); return value;
}
function fixture(options, initial, extra = {}) {
  const saved = Object.fromEntries(['Node', 'document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'Node', { value: HostNode, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'window', { value: Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 }), configurable: true });
  const model = ref(initial), choices = ref(options), disabled = ref(false), changes = [], updates = [];
  const container = new HostNode('root');
  const app = renderer.createApp({ setup: () => () => h(BaseSelect, { ...extra, disabled: disabled.value, modelValue: model.value, options: choices.value,
    'onUpdate:modelValue': value => { model.value = value; updates.push(value); }, onChange: value => changes.push(value) }) });
  app.mount(container);
  const nodes = predicate => descendants(container).filter(predicate);
  return { model, choices, disabled, changes, updates, container, nodes, trigger: () => nodes(node => node.tag === 'button')[0], menu: () => nodes(node => node.props.popover)[0], rows: () => nodes(node => node.props.role === 'option'),
    close() { app.unmount(); for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } } };
}

test('custom select opens a popover, skips disabled options and emits numeric values through its form bridge', async () => {
  const f = fixture([{ value: '', label: '请选择', disabled: true }, { value: 0, label: 'Zero' }, { value: 1, label: 'Disabled', disabled: true }, { value: 2, label: 'Two' }], 0);
  try {
    assert.equal(f.trigger().props.type, 'button');
    await event(f.trigger(), 'keydown', { key: 'ArrowDown' });
    assert.equal(f.menu().showing, true); assert.equal(f.trigger().props['aria-expanded'], true);
    await event(f.trigger(), 'keydown', { key: 'ArrowDown' });
    await event(f.trigger(), 'keydown', { key: 'Enter' });
    assert.equal(f.model.value, 2); assert.deepEqual(f.updates, [2]); assert.equal(f.changes[0].target.tag, 'select');
    assert.equal(f.trigger().props['aria-expanded'], false); assert.equal(document.activeElement, f.trigger());
  } finally { f.close(); }
});

test('Escape and Tab close without changing selection; pointer dismissal retains the outside focus', async () => {
  const f = fixture([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], 'a');
  try {
    await event(f.trigger(), 'click'); await event(f.trigger(), 'keydown', { key: 'ArrowDown' });
    const escape = await event(f.trigger(), 'keydown', { key: 'Escape' });
    assert.equal(escape.defaultPrevented, true); assert.equal(f.model.value, 'a'); assert.equal(f.menu(), undefined);
    await event(f.trigger(), 'click');
    const tab = await event(f.trigger(), 'keydown', { key: 'Tab' });
    assert.equal(tab.defaultPrevented, false); assert.equal(f.menu(), undefined); assert.deepEqual(f.updates, []);
    await event(f.trigger(), 'click');
    const outside = new HostNode('button'); outside.focus();
    await event(document, 'pointerdown', { target: outside });
    assert.equal(f.menu(), undefined); assert.equal(document.activeElement, outside);
  } finally { f.close(); }
});

test('long option lists search live, show an empty state and keep polling from resetting keyboard navigation', async () => {
  const options = Array.from({ length: 12 }, (_, value) => ({ value, label: value === 7 ? '生产环境' : '测试 ' + value }));
  const f = fixture(options, 0);
  try {
    await event(f.trigger(), 'click');
    const search = f.nodes(node => node.tag === 'input')[0]; assert.ok(search); assert.equal(document.activeElement, search);
    search.value = '生产'; await event(search, 'input'); assert.equal(f.rows().length, 1);
    await event(search, 'keydown', { key: 'Enter' }); assert.equal(f.model.value, 7);
    await event(f.trigger(), 'click');
    const input = f.nodes(node => node.tag === 'input')[0]; input.value = 'missing'; await event(input, 'input');
    assert.equal(f.rows().length, 0); assert.ok(f.nodes(node => node.text === '没有匹配的选项').length);
    input.value = ''; await event(input, 'input');
    await event(input, 'keydown', { key: 'ArrowDown' });
    const activeId = input.props['aria-activedescendant'];
    f.choices.value = options.map(option => ({ ...option })); await settle();
    assert.equal(input.props['aria-activedescendant'], activeId);
    await event(input, 'keydown', { key: 'Enter' }); assert.equal(f.model.value, 8);
  } finally { f.close(); }
});

test('disabled state closes menus; invalid form events focus the custom trigger and model updates clear the error', async () => {
  const f = fixture([{ value: '', label: '选择环境', disabled: true }, { value: 'a', label: '环境 A' }], '', { required: true, name: 'environment' });
  try {
    const native = f.nodes(node => node.tag === 'select')[0];
    assert.equal(native.props.required, true); assert.equal(native.props.name, 'environment'); assert.equal(native.props['aria-hidden'], 'true');
    await event(native, 'invalid'); assert.equal(f.trigger().props['aria-invalid'], true); assert.equal(document.activeElement, f.trigger());
    f.model.value = 'a'; await settle(); assert.ok(!f.trigger().props['aria-invalid']);
    await event(f.trigger(), 'click'); f.disabled.value = true; await settle();
    assert.equal(f.menu(), undefined); assert.equal(f.trigger().props.disabled, true); assert.equal(native.props.disabled, true);
    await event(f.trigger(), 'click'); assert.equal(f.menu(), undefined);
  } finally { f.close(); }
});
