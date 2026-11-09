import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

// Render the actual SFCs in Node; no browser is launched or controlled.
const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'kooboo-login-components-'));
const LoginDialog = 'dialog', SettingsView = 'settings';
before(async () => {
  for (const [name, file] of [['dialog', 'components/KoobooLoginDialog.vue'], ['settings', 'views/SettingsView.vue']]) {
    const filename = resolve('frontend/src', file), { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const compiled = compileScript(descriptor, { id: `connection-${name}`, inlineTemplate: true }), outfile = join(directory, `${name}.cjs`);
    await build({ stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile,
      plugins: [{ name: 'connection-services', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
        builder.onResolve({ filter: /^\.\.\/api$/ }, () => ({ path: 'api', namespace: 'connection-test' }));
        builder.onResolve({ filter: /^\.\.\/lib\/notifications$/ }, () => ({ path: 'notifications', namespace: 'connection-test' }));
        builder.onResolve({ filter: /\.vue$/ }, args => ({ path: args.path, namespace: 'connection-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'connection-test' }, args => ({ contents:
          args.path === 'api' ? 'export const platform=globalThis.__connectionServices.platform; export const api=(...args)=>globalThis.__connectionServices.request(...args); export const saveSettings=input=>globalThis.__connectionServices.save(input); export const message=e=>e.message;'
          : args.path === 'notifications' ? 'export const notify={success:text=>globalThis.__connectionServices.success.push(text)};'
          : args.path.includes('KoobooLoginDialog') ? 'import {defineComponent} from "vue"; export default defineComponent({setup(_, {emit,expose}){expose({open:input=>globalThis.__connectionServices.opened={...input}});globalThis.__connectionServices.connected=result=>emit("connected",result);return()=>null;}});'
          : args.path.includes('Disclosure') ? 'import {defineComponent,h} from "vue";export default defineComponent({setup(_, {slots}){return()=>h("div",{},slots.default?.());}});'
          : 'import {defineComponent,h} from "vue";export default defineComponent({setup(){return()=>h("select");}});', loader: 'js' }));
      } }] });
  }
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; this.value = ''; this.open = false; }
  getRootNode() { return document; }
  focus() { document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.props.onClose?.(); }
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, previous, value) { node.props[key] = value; if (key === 'value' || key === 'type') node[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => node.text + node.children.map(text).join('');
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
const connection = () => ({ id: '11111111-1111-4111-8111-111111111111', name: '香港', origin: 'https://hk.test', apiOrigin: 'https://hk.test', hasToken: false });
function settings(environments = [connection()]) { return { threshold: 80, paused: true, model: { name: '', endpoint: '', hasApiKey: false }, environments, credentials: { ingestToken: 'ingest', readToken: 'read' } }; }

async function fixture(Component, services = {}, props = {}) {
  const previous = new Map(['document', 'Document', 'window', '__connectionServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class HostDocument { activeElement = null; }
  const service = { platform: { settings: settings() }, request: async () => {}, save: async input => { service.saved = JSON.parse(JSON.stringify(input)); }, success: [], ...services };
  for (const [key, value] of Object.entries({ document: new HostDocument(), Document: HostDocument, window: { location: { hash: '', origin: 'http://localhost:4180' } }, __connectionServices: service })) Object.defineProperty(globalThis, key, { value, configurable: true });
  // Bundled test modules capture the service object when required; clear and reload per fixture.
  const file = join(directory, Component === LoginDialog ? 'dialog.cjs' : 'settings.cjs'); delete require.cache[file]; const Actual = require(file).default;
  let view; const container = new HostNode('root'), app = renderer.createApp({ render: () => h(Actual, { ...props, ref: value => { view = value; } }) });
  app.mount(container); await settle();
  return { service, view, nodes: predicate => descendants(container).filter(predicate),
    async submit() { await descendants(container).find(node => node.tag === 'form').props.onSubmit({ preventDefault() {} }); await settle(); },
    close() { app.unmount(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } },
  };
}

test('login dialog completes verification, clears the password on close and emits no token', async () => {
  const calls = [], connected = [];
  const f = await fixture(LoginDialog, { request: async (path, options) => { assert.equal(path, '/environments/login'); calls.push(JSON.parse(options.body)); return calls.length === 1 ? { status: 'verification-required', method: 'otp' } : { status: 'connected', environment: { ...connection(), hasToken: true }, sites: 2 }; } }, { onConnected: result => connected.push(result) });
  try {
    await f.view.open(connection());
    let inputs = f.nodes(node => node.tag === 'input'); inputs[0].props['onUpdate:modelValue']('colleague'); inputs[1].props['onUpdate:modelValue']('temporary-password'); await nextTick();
    await f.submit(); inputs = f.nodes(node => node.tag === 'input'); assert.equal(inputs.length, 3); assert.equal(inputs[2].props.autocomplete, 'one-time-code');
    inputs[2].props['onUpdate:modelValue']('123456'); await f.submit();
    assert.equal(calls[1].password, 'temporary-password'); assert.equal(calls[1].code, '123456'); assert.equal(connected.length, 1); assert.equal('token' in connected[0], false);
    assert.equal(f.nodes(node => node.tag === 'dialog')[0].open, false);
    await f.view.open(connection()); assert.ok(f.nodes(node => node.tag === 'input').every(node => node.value === ''));
  } finally { f.close(); }
});

test('cloud environment choice requires another explicit login and failures remain in the form', async () => {
  const calls = [];
  const f = await fixture(LoginDialog, { request: async (_path, options) => { calls.push(JSON.parse(options.body)); if (calls.length === 1) return { status: 'environment-mismatch', origin: 'https://actual.kooboo.io' }; throw Error('账号或密码不正确'); } });
  try {
    await f.view.open(connection()); const inputs = f.nodes(node => node.tag === 'input'); inputs[0].props['onUpdate:modelValue']('user'); inputs[1].props['onUpdate:modelValue']('password'); await nextTick();
    await f.submit(); assert.equal(calls.length, 1);
    f.nodes(node => node.tag === 'button' && text(node).includes('使用此地址'))[0].props.onClick(); await settle(); assert.equal(calls.length, 1);
    await f.submit(); assert.equal(calls[1].origin, 'https://actual.kooboo.io'); assert.equal(calls[1].apiOrigin, 'https://actual.kooboo.io');
    assert.ok(f.nodes(node => node.props.role === 'alert').some(node => text(node).includes('账号或密码不正确'))); assert.equal(f.nodes(node => node.tag === 'dialog')[0].open, true);
  } finally { f.close(); }
});

test('settings preserve other unsaved fields when login saves one connection and remove the target selector', async () => {
  const f = await fixture(SettingsView, {}, { environmentsOnly: true });
  try {
    assert.equal(f.nodes(node => text(node).includes('目标环境') && node.tag === 'label').length, 0);
    const check = f.nodes(node => node.tag === 'input' && node.props.type === 'checkbox')[0]; check.props['onUpdate:modelValue'](true); await nextTick();
    f.service.connected({ status: 'connected', environment: { ...connection(), hasToken: true }, sites: 3 }); await settle();
    assert.equal(f.service.platform.settings.environments[0].hasToken, true);
    await f.submit(); assert.equal(f.service.saved.environments[0].delivery.enabled, true); assert.equal(f.service.saved.environments[0].hasToken, true); assert.equal(f.service.saved.environments[0].token, '');
    assert.equal(f.service.success.filter(value => value.includes('已连接')).length, 1);
  } finally { f.close(); }
});

test('a new connection saved by login does not leave a redundant pending save', async () => {
  const f = await fixture(SettingsView, { platform: { settings: settings([]) } }, { environmentsOnly: true });
  try {
    f.nodes(node => node.tag === 'button' && text(node).includes('添加环境'))[0].props.onClick(); await settle();
    const inputs = f.nodes(node => node.tag === 'input'); inputs[0].props['onUpdate:modelValue']('香港'); inputs[1].props.onInput({ target: { value: 'https://hk.test' } }); await settle();
    f.nodes(node => node.tag === 'button' && text(node).includes('登录连接'))[0].props.onClick();
    f.service.connected({ status: 'connected', environment: { id: f.service.opened.id, name: '香港', origin: 'https://hk.test', apiOrigin: 'https://hk.test', hasToken: true }, sites: 0 }); await settle();
    assert.equal(f.nodes(node => node.tag === 'button' && text(node).includes('保存设置'))[0].props.disabled, true);
  } finally { f.close(); }
});
