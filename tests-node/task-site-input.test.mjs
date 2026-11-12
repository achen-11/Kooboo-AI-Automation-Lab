import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'task-site-input-'));
before(async () => {
  for (const name of ['CreateTaskDialog', 'TaskInput']) {
    const outfile = join(directory, name + '.cjs');
    await build({ entryPoints: [resolve(`frontend/src/views/automation/${name}.vue`)], bundle: true, platform: 'node', format: 'cjs', outfile,
      plugins: [{ name: 'task-input-services', setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
        builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'task-input-test' }));
        builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'task-input-test' }));
        builder.onResolve({ filter: /^\.\/use-task-section$/ }, () => ({ path: 'section', namespace: 'task-input-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'task-input-test' }, args => ({ contents: args.path === 'api'
          ? 'export const platform=globalThis.__taskInput.platform;export const api=(...args)=>globalThis.__taskInput.request(...args);export const message=e=>e.message;export const go=()=>{};'
          : args.path === 'common'
            ? 'export const workspace={settings:{enabled:false,optimization:{},prompts:{materials:"生成资料站"}}};export const refresh=async()=>{};export const scopeName=()=>"全站";'
            : 'import {ref} from "vue";export const useTaskSection=()=>({data:ref(globalThis.__taskInput.input),loading:ref(false),error:ref(""),load:()=>{}});', loader: 'js' }));
        builder.onLoad({ filter: /\.vue$/ }, args => {
          if (!/(CreateTaskDialog|TaskInput)\.vue$/.test(args.path)) return { contents: /KoobooRootDomainSelect/.test(args.path)
            ? 'import {h,onMounted} from "vue";export default {props:["modelValue"],emits:["ready"],setup(p,{emit}){onMounted(()=>emit("ready",true));return()=>h("span",p.modelValue);}};'
            : 'export default {render:()=>null};', loader: 'js' };
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(args.path) };
        });
      } }],
    });
  }
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; }
  showModal() {}
  close() {}
  getRootNode() { return globalThis.document; }
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert(child, parent, anchor = null) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); },
  setText(child, text) { child.text = text; }, setElementText(child, text) { child.text = text; child.children = []; },
  parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  patchProp(child, key, _previous, value) { child.props[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => (node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('');
async function settle() { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
const resource = (patch = {}) => ({ id: 'resource', name: '资料站', scenario: 'materials', description: '', files: [], siteName: 'salon', subDomain: 'salon_public', rootDomain: '-shawnchen-hk.kooboo.io', ...patch });
async function fixture(name, props, input) {
  const previous = new Map(['document', 'Document', '__taskInput'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const calls = [];
  class HostDocument { activeElement = null; }
  globalThis.Document = HostDocument;
  globalThis.document = new HostDocument();
  globalThis.__taskInput = { input, platform: { settings: { environments: [{ id: 'env', defaultRootDomain: 'default.test' }] } }, request: async (path, options) => {
    calls.push({ path, options }); return { items: path.endsWith('/rules') ? [] : [{ id: 'task' }] };
  } };
  const filename = join(directory, name + '.cjs'); delete require.cache[filename];
  const Component = require(filename).default;
  let exposed;
  const container = new HostNode('root'), app = renderer.createApp({ render: () => h(Component, { ...props, ref: value => { exposed = value; } }) });
  app.mount(container); await settle();
  if (name === 'CreateTaskDialog') { await exposed.open(); await settle(); }
  return { calls, nodes: () => descendants(container), text: () => text(container),
    submit: () => descendants(container).find(node => node.tag === 'button' && text(node).includes('加入队列')),
    close() { app.unmount(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } },
  };
}

test('creation defaults to imported names and accepts Hong Kong root hyphens', async () => {
  const f = await fixture('CreateTaskDialog', { resources: [resource()] });
  try {
    assert.equal(f.submit().props.disabled, false); assert.ok(f.text().includes('-shawnchen-hk.kooboo.io'));
    await f.nodes().find(node => node.tag === 'form').props.onSubmit({ preventDefault() {} });
    const body = JSON.parse(f.calls.find(call => call.path === '/automation/tasks').options.body);
    assert.equal(body.siteName, 'salon'); assert.equal(body.subDomain, 'salon_public'); assert.equal(body.rootDomain, '-shawnchen-hk.kooboo.io');
  } finally { f.close(); }
});

test('creation blocks hyphenated input immediately and permits correction', async () => {
  const f = await fixture('CreateTaskDialog', { resources: [resource()] });
  try {
    const input = f.nodes().find(node => node.tag === 'input' && node.props.placeholder === '留空使用站点名称或自动生成');
    input.props['onUpdate:modelValue']('bad-name'); await settle();
    assert.equal(f.submit().props.disabled, true); assert.ok(f.text().includes('子域名不能包含连字符'));
    input.props['onUpdate:modelValue']('fixed_name'); await settle();
    assert.equal(f.submit().props.disabled, false);
  } finally { f.close(); }
});

test('batch creation validates each inherited subdomain', async () => {
  const f = await fixture('CreateTaskDialog', { resources: [resource(), resource({ id: 'bad', name: '旧资料', subDomain: 'old-name' })] });
  try { assert.equal(f.submit().props.disabled, true); assert.ok(f.text().includes('旧资料：子域名不能包含连字符')); }
  finally { f.close(); }
});

test('input shows frozen imported values and resolved creation names without opening disclosures', async () => {
  const f = await fixture('TaskInput', { taskId: 'task', resourceId: 'resource', kind: 'generation', scope: 'site' }, {
    message: '', version: { ...resource(), revision: 1, externalSource: 'admin', externalId: 'external_123' }, siteName: 'salon_1', subDomain: 'salon_public_2', rootDomain: '-shawnchen-hk.kooboo.io', rule: null,
  });
  try {
    const facts = f.nodes().filter(node => node.tag === 'dd').map(text);
    for (const value of ['salon', 'salon_public', 'salon_1', 'salon_public_2', '-shawnchen-hk.kooboo.io', 'admin', 'external_123']) assert.ok(facts.includes(value), value);
  } finally { f.close(); }
});
