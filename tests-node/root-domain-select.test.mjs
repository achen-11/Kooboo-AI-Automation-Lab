import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick, ref } from 'vue';

// Exercise the real selector's asynchronous behavior with a Vue renderer in Node.
const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'root-domain-select-'));
const output = join(directory, 'selector.cjs');
before(async () => {
  const filename = resolve('frontend/src/components/KoobooRootDomainSelect.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'root-domains', inlineTemplate: true });
  await build({ stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: output,
    plugins: [{ name: 'root-domain-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'domain-test' }));
      builder.onResolve({ filter: /BaseSelect\.vue$/ }, () => ({ path: 'select', namespace: 'domain-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'domain-test' }, args => ({ contents: args.path === 'api'
        ? 'export const platform=globalThis.__domainServices.platform; export const api=(...args)=>globalThis.__domainServices.request(...args);export const message=e=>e.message;'
        : 'import {defineComponent,h} from "vue";export default defineComponent({props:["modelValue","options","loading","disabled","required"],emits:["update:modelValue"],setup(props,{emit}){return()=>h("select",{...props,onChange:e=>emit("update:modelValue",e.target.value)});}});', loader: 'js' }));
    } }] });
});
after(() => rmSync(directory, { recursive: true, force: true }));

function node(tag, text = '') { return { tag, text, children: [], parent: null, props: {} }; }
const renderer = createRenderer({
  createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(child, parent, anchor = null) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); },
  setText(child, text) { child.text = text; }, setElementText(child, text) { child.text = text; child.children = []; },
  parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  patchProp(child, key, _previous, value) { child.props[key] = value; },
});
const descendants = parent => parent.children.flatMap(child => [child, ...descendants(child)]);
const text = parent => parent.text + parent.children.map(text).join('');
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
const roots = [{ domainName: 'first.test', sudDomainUseDash: false }, { domainName: 'chosen.test', sudDomainUseDash: true }];
async function fixture({ request = async () => ({ items: roots }), model = '', required = true, autoSelect = true } = {}) {
  const service = { platform: { settings: { environments: [{ id: 'one', hasToken: true, defaultRootDomain: 'chosen.test' }, { id: 'two', hasToken: true, defaultRootDomain: 'second.test' }] } }, request };
  globalThis.__domainServices = service; delete require.cache[output]; const Component = require(output).default;
  const value = ref(model), environmentId = ref('one'), ready = ref(false), container = node('root');
  const app = renderer.createApp({ render: () => h(Component, { environmentId: environmentId.value, required, autoSelect, modelValue: value.value, 'onUpdate:modelValue': selected => { value.value = selected; }, onReady: value => { ready.value = value; } }) });
  app.mount(container); await settle();
  return { value, environmentId, ready, service, select: () => descendants(container).find(child => child.tag === 'select'), text: () => text(container),
    async choose(value) { this.select().props.onChange({ target: { value } }); await settle(); },
    close() { app.unmount(); delete globalThis.__domainServices; } };
}

test('selector loads the environment default, preserves dot/dash labels and permits a task override', async () => {
  const f = await fixture(); try {
    assert.equal(f.value.value, '-chosen.test'); assert.equal(f.ready.value, true);
    assert.deepEqual(f.select().props.options.slice(1).map(option => option.label), ['.first.test', '-chosen.test']);
    await f.choose('first.test'); assert.equal(f.value.value, 'first.test'); assert.equal(f.ready.value, true);
  } finally { f.close(); }
});

test('a missing configured default remains visible and blocks submission until another root is chosen', async () => {
  const f = await fixture({ request: async () => ({ items: [roots[0]] }) }); try {
    assert.equal(f.value.value, 'chosen.test'); assert.equal(f.ready.value, false); assert.match(f.text(), /已不可用/);
    await f.choose('first.test'); assert.equal(f.ready.value, true); assert.doesNotMatch(f.text(), /已不可用/);
  } finally { f.close(); }
});

test('selector reconciles an older saved Hong Kong root with its leading-separator form', async () => {
  const f = await fixture({ model: 'shawnchen-hk.kooboo.io', request: async () => ({ items: [{ domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true }] }) }); try {
    assert.equal(f.value.value, '-shawnchen-hk.kooboo.io');
    assert.equal(f.ready.value, true);
    assert.equal(f.select().props.options[1].label, '-shawnchen-hk.kooboo.io');
    assert.doesNotMatch(f.text(), /已不可用/);
  } finally { f.close(); }
});

test('selector retains the Hong Kong dash in its submitted value when the server returns separator metadata', async () => {
  const f = await fixture({ model: '-shawnchen-hk.kooboo.io', request: async () => ({ items: [{ domainName: 'shawnchen-hk.kooboo.io', sudDomainUseDash: true }] }) }); try {
    assert.equal(f.value.value, '-shawnchen-hk.kooboo.io');
    assert.equal(f.select().props.options[1].value, '-shawnchen-hk.kooboo.io');
    assert.equal(f.ready.value, true);
    assert.doesNotMatch(f.text(), /已不可用/);
  } finally { f.close(); }
});

test('settings can retain an empty default while a failed domain request keeps a new task blocked', async () => {
  const settings = await fixture({ autoSelect: false, required: false }); try { assert.equal(settings.value.value, ''); } finally { settings.close(); }
  const failed = await fixture({ request: async () => { throw new Error('连接失败'); } }); try {
    assert.equal(failed.ready.value, false); assert.match(failed.text(), /连接失败/);
  } finally { failed.close(); }
});

test('switching environments discards a late response from the previous environment', async () => {
  const pending = new Map();
  const f = await fixture({ request: path => new Promise(resolve => pending.set(path, resolve)) }); try {
    assert.equal(f.ready.value, false);
    f.environmentId.value = 'two'; await settle();
    pending.get('/environments/two/domains')({ items: [{ domainName: 'second.test', sudDomainUseDash: false }] }); await settle();
    assert.equal(f.value.value, 'second.test'); assert.equal(f.ready.value, true);
    pending.get('/environments/one/domains')({ items: roots }); await settle();
    assert.equal(f.value.value, 'second.test'); assert.equal(f.ready.value, true);
    assert.deepEqual(f.select().props.options.slice(1).map(option => option.value), ['second.test']);
  } finally { f.close(); }
});
