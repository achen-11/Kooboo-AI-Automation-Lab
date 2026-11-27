import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'task-delivery-component-'));
let TaskDelivery;

before(async () => {
  const filename = resolve('frontend/src/components/TaskDelivery.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'task-delivery-test', inlineTemplate: true });
  const outfile = join(directory, 'component.cjs');
  await build({
    stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [{
      name: 'task-delivery-services',
      setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
        builder.onResolve({ filter: /^@lucide\/vue$/ }, () => ({ path: 'lucide', namespace: 'task-delivery-test' }));
        builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'task-delivery-test' }));
        builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'task-delivery-test' }));
        builder.onResolve({ filter: /\.vue$/ }, args => ({ path: args.path, namespace: 'task-delivery-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'task-delivery-test' }, args => {
          if (args.path === 'lucide') {
            const icons = ['Send', 'RotateCw', 'ExternalLink', 'Copy', 'ChevronDown', 'ChevronRight'];
            return {
              contents: `import { h } from 'vue'; const Icon = () => h('svg'); export { ${icons.map(i => `Icon as ${i}`).join(', ')} };`,
              loader: 'js',
            };
          }
          if (args.path === 'api') {
            return {
              contents: 'export const api = (...args) => globalThis.__taskDeliveryServices.request(...args); export const message = e => e.message; export const platform = { settings: { environments: [{ id: "env-1", delivery: { enabled: true, verifyWithAi: false } }] } };',
              loader: 'js',
            };
          }
          if (args.path === 'notifications') {
            return {
              contents: 'export const notify = { success: t => globalThis.__taskDeliveryServices.notified.push({ type: "success", text: t }), error: t => globalThis.__taskDeliveryServices.notified.push({ type: "error", text: t }) };',
              loader: 'js',
            };
          }
          return {
            contents: "import { h } from 'vue'; export default { props: ['label', 'page', 'pages', 'total'], setup: (_, { slots }) => () => h('div', slots.default?.()) };",
            loader: 'js',
          };
        });
      },
    }],
  });
  TaskDelivery = require(outfile).default;
});

after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') {
    super();
    this.tag = tag;
    this.tagName = tag.toUpperCase();
    this.text = text;
    this.children = [];
    this.parent = null;
    this.props = {};
  }
}

const renderer = createRenderer({
  createElement: tag => new HostNode(tag),
  createText: text => new HostNode('#text', text),
  createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = parent.children.indexOf(anchor);
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await nextTick();
  }
}

function mountDelivery(props) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__taskDeliveryServices');
  const calls = [];
  const notified = [];
  Object.defineProperty(globalThis, '__taskDeliveryServices', {
    value: {
      notified,
      request(path, options = {}) {
        calls.push({ path, options });
        return Promise.resolve({});
      },
    },
    configurable: true,
  });
  const container = new HostNode('root');
  const app = renderer.createApp({ render: () => h(TaskDelivery, props) });
  app.mount(container);
  return {
    calls,
    notified,
    button: label => descendants(container).find(n => n.tag === 'button' && text(n) === label),
    text: () => text(container),
    close() {
      app.unmount();
      if (previous) Object.defineProperty(globalThis, '__taskDeliveryServices', previous);
      else delete globalThis.__taskDeliveryServices;
    },
  };
}

test('TaskDelivery renders force deliver button with inline confirmation for interrupted tasks', async () => {
  const m = mountDelivery({
    task: {
      id: 'gen-int-1',
      kind: 'generation',
      environmentId: 'env-1',
      status: 'interrupted',
      stopped: true,
      generatedSiteId: 'site-1',
      delivery: undefined,
      report: null,
    },
    canDeliver: false,
    canForceDeliver: true,
    forceDeliverReason: '站点生成尚未正常完成（任务已中断或未收尾），跳过完成态校验强制迁移当前源站。',
  });
  await settle();
  try {
    const forceBtn = m.button('强制交付');
    assert.ok(forceBtn, '强制交付 button should be rendered');
    forceBtn.props.onClick();
    await settle();

    assert.ok(m.text().includes('跳过完成态校验强制迁移当前源站'));
    const confirmBtn = m.button('确认强制交付');
    assert.ok(confirmBtn);
    await confirmBtn.props.onClick();
    await settle();

    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].path, '/automation/tasks/gen-int-1/delivery');
    assert.equal(m.calls[0].options.body, JSON.stringify({ force: true }));
  } finally {
    m.close();
  }
});

test('TaskDelivery renders force-retry flow for uncertain delivery without target receipt', async () => {
  const m = mountDelivery({
    task: {
      id: 'gen-uncertain-1',
      kind: 'generation',
      environmentId: 'env-1',
      status: 'completed',
      stopped: true,
      generatedSiteId: 'site-1',
      delivery: {
        id: 'del-1',
        policy: { enabled: true, endpoint: 'https://migrate.test', auto: false, requirePassed: false, verifyWithAi: false, timeoutSeconds: 180 },
        status: 'uncertain',
        forced: true,
        stopped: true,
        sourceEnvironmentId: 'env-1',
        sourceSiteId: 'remote-1',
        sourceUrl: 'https://source.test/',
        evaluationTaskId: '',
        attemptedAt: 123456,
        updatedAt: 123456,
        error: 'fetch failed',
        checks: [],
      },
      report: null,
    },
    canForceRetry: true,
  });
  await settle();
  try {
    assert.ok(m.text().includes('人工强制交付'));
    const retryBtn = m.button('已核查未建站，强制重发');
    assert.ok(retryBtn);
    retryBtn.props.onClick();
    await settle();

    const confirmBtn = m.button('确认强制重发');
    assert.ok(confirmBtn);
    await confirmBtn.props.onClick();
    await settle();

    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].path, '/automation/tasks/gen-uncertain-1/delivery/retry');
    assert.equal(m.calls[0].options.body, JSON.stringify({ force: true }));
  } finally {
    m.close();
  }
});
