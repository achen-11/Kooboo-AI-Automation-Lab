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
const directory = mkdtempSync(join(tmpdir(), 'site-delivery-list-component-'));
let SiteDeliveryList;

before(async () => {
  const filename = resolve('frontend/src/views/automation/SiteDeliveryList.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'site-delivery-list-test', inlineTemplate: true });
  const outfile = join(directory, 'component.cjs');
  await build({
    stdin: { contents: compiled.content, resolveDir: dirname(filename), loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [{
      name: 'site-delivery-list-services',
      setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
        builder.onResolve({ filter: /^@lucide\/vue$/ }, () => ({ path: 'lucide', namespace: 'site-delivery-test' }));
        builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'site-delivery-test' }));
        builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'site-delivery-test' }));
        builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'site-delivery-test' }));
        builder.onResolve({ filter: /\.vue$/ }, args => ({ path: args.path, namespace: 'site-delivery-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'site-delivery-test' }, args => {
          if (args.path === 'lucide') {
            const icons = ['ArrowUpRight', 'Check', 'Columns2', 'Copy', 'ExternalLink', 'Search', 'RefreshCw', 'Play', 'Clock3', 'LoaderCircle', 'RotateCcw', 'Trash2', 'X'];
            return {
              contents: `import { h } from 'vue'; const Icon = () => h('svg'); export { ${icons.map(i => `Icon as ${i}`).join(', ')} };`,
              loader: 'js',
            };
          }
          if (args.path === 'api') {
            return {
              contents: 'export const api = (...args) => globalThis.__siteDeliveryServices.request(...args); export const message = e => e.message; export const formatDate = String;',
              loader: 'js',
            };
          }
          if (args.path === 'notifications') {
            return {
              contents: 'export const notify = { success: t => globalThis.__siteDeliveryServices.notified.push({ type: "success", text: t }), info: t => globalThis.__siteDeliveryServices.notified.push({ type: "info", text: t }), warning: t => globalThis.__siteDeliveryServices.notified.push({ type: "warning", text: t }), error: t => globalThis.__siteDeliveryServices.notified.push({ type: "error", text: t }) };',
              loader: 'js',
            };
          }
          if (args.path === 'common') {
            return {
              contents: "import { reactive } from 'vue'; export const workspace = reactive({ settingsLoaded: false, settings: { enabled: true, generationConcurrency: 1, evaluationConcurrency: 1 }, queue: null }); export const refresh = async () => {}; export const refreshStatus = async () => {}; export const scopeName = s => s === 'homepage' ? '仅首页' : '全站';",
              loader: 'js',
            };
          }
          if (args.path.includes('BaseSelect')) {
            return {
              contents: "import { h } from 'vue'; export default { props: ['modelValue', 'options'], emits: ['update:modelValue'], setup: (p, { attrs, emit }) => () => h('select', { ...attrs, value: p.modelValue, options: p.options, onUpdate: v => emit('update:modelValue', v) }) };",
              loader: 'js',
            };
          }
          if (args.path.includes('TablePagination')) {
            return {
              contents: "import { h } from 'vue'; export default { props: ['page', 'pages', 'total', 'busy'], emits: ['change'], setup: (p, { emit }) => () => h('pagination', { page: p.page, pages: p.pages, total: p.total, onChange: v => emit('change', v) }) };",
              loader: 'js',
            };
          }
          return {
            contents: "import { h } from 'vue'; export default { setup: (_, { slots }) => () => h('div', slots.default?.()) };",
            loader: 'js',
          };
        });
      },
    }],
  });
  SiteDeliveryList = require(outfile).default;
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
  patchProp(node, key, _previous, value) {
    node.props[key] = value;
    if (key === 'value' || key === 'checked' || key === 'type') node[key] = value;
  },
});

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await nextTick();
  }
}

function pageResponse(path, attentionMissingAddress = 2) {
  const params = new URL('http://local' + path).searchParams;
  const page = Number(params.get('page') || 1);
  return {
    items: [{
      id: 'site-1',
      generatedSiteId: 'site-1',
      resourceId: 'res-1',
      resourceName: 'Demo Site',
      siteUrl: '',
      environmentId: 'env-1',
      scenario: 'site-template',
      scope: 'site',
      detailTaskId: 'task-1',
      state: 'attention',
      reason: '需要处理',
      targetScore: 85,
      report: null,
      usage: { priced: false, knownCny: 0, missing: 0, requests: 0, input: 0, output: 0, cached: 0 },
      stages: [],
      taskCount: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
    page,
    pages: 3,
    pageSize: 20,
    total: 45,
    activeTotal: 45,
    attentionMissingAddress,
  };
}

async function fixture(customResponder) {
  const previous = new Map(['document', 'window', '__siteDeliveryServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: { location: { hash: '#/tasks' } }, configurable: true });
  const calls = [], notified = [];
  Object.defineProperty(globalThis, '__siteDeliveryServices', {
    value: {
      notified,
      request(path, options = {}) {
        calls.push({ path, options });
        if (customResponder) return Promise.resolve(customResponder(path, options));
        return Promise.resolve(pageResponse(path));
      },
    },
    configurable: true,
  });
  const container = new HostNode('root');
  const app = renderer.createApp({ render: () => h(SiteDeliveryList) });
  app.mount(container);
  await settle();
  return {
    calls,
    notified,
    text: () => text(container),
    nodes: predicate => descendants(container).filter(predicate),
    quickMissingButton: () => descendants(container).find(n => n.tag === 'button' && String(n.props.class || '').includes('quick-attention-filter')),
    select: ariaLabel => descendants(container).find(n => n.tag === 'select' && n.props['aria-label'] === ariaLabel),
    button: label => descendants(container).find(n => n.tag === 'button' && text(n) === label),
    buttonStartsWith: prefix => descendants(container).find(n => n.tag === 'button' && text(n).startsWith(prefix)),
    close() {
      app.unmount();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test('SiteDeliveryList shows address select under attention state and resets when leaving attention', async () => {
  const f = await fixture();
  try {
    assert.equal(f.select('可访问地址'), undefined);

    // Selecting state=attention reveals address BaseSelect
    f.select('交付状态').props.onUpdate('attention');
    await settle();
    const addressSelect = f.select('可访问地址');
    assert.ok(addressSelect);
    assert.deepEqual(
      addressSelect.props.options.map(option => ({ value: option.value, label: option.label })),
      [
        { value: '', label: '全部需要处理' },
        { value: 'missing', label: '尚无可访问地址' },
        { value: 'accessible', label: '已有可访问地址' },
      ],
    );

    // Selecting missing resets page=1 and includes state=attention & address=missing
    f.nodes(n => n.tag === 'pagination')[0].props.onChange(2);
    await settle();
    assert.equal(new URL('http://local' + f.calls.at(-1).path).searchParams.get('page'), '2');

    addressSelect.props.onUpdate('missing');
    await settle();
    const activeCall = f.calls.filter(c => !c.options?.signal?.aborted).at(-1);
    let params = new URL('http://local' + activeCall.path).searchParams;
    assert.equal(params.get('state'), 'attention');
    assert.equal(params.get('address'), 'missing');
    assert.equal(params.get('page'), '1');

    // Leaving state=attention clears address and hides selector
    f.select('交付状态').props.onUpdate('running');
    await settle();
    assert.equal(f.select('可访问地址'), undefined);
    params = new URL('http://local' + f.calls.filter(c => !c.options?.signal?.aborted).at(-1).path).searchParams;
    assert.equal(params.get('state'), 'running');
    assert.equal(params.get('address'), null);
  } finally {
    f.close();
  }
});

test('SiteDeliveryList 1-click quick filter toggles attention+missing and syncs toolbar selects', async () => {
  const f = await fixture();
  try {
    const quick = () => f.quickMissingButton();
    assert.ok(quick());
    assert.equal(text(quick()), '需处理 · 尚无可访问地址2');
    assert.equal(quick().props['aria-pressed'], false);

    // Clicking from page 2 directly sets state=attention, address=missing, page=1
    f.nodes(n => n.tag === 'pagination')[0].props.onChange(2);
    await settle();
    quick().props.onClick();
    await settle();

    assert.equal(quick().props['aria-pressed'], true);
    assert.equal(f.select('交付状态').props.value, 'attention');
    assert.equal(f.select('可访问地址').props.value, 'missing');
    let params = new URL('http://local' + f.calls.at(-1).path).searchParams;
    assert.equal(params.get('state'), 'attention');
    assert.equal(params.get('address'), 'missing');
    assert.equal(params.get('page'), '1');

    // Clicking again toggles back to all
    quick().props.onClick();
    await settle();
    assert.equal(quick().props['aria-pressed'], false);
    assert.equal(f.select('交付状态').props.value, '');
    assert.equal(f.select('可访问地址'), undefined);
    params = new URL('http://local' + f.calls.at(-1).path).searchParams;
    assert.equal(params.get('state'), null);
    assert.equal(params.get('address'), null);
  } finally {
    f.close();
  }
});

test('SiteDeliveryList batch resume resumes resume + adjust-site-names rows without force and reloads cleanly', async () => {
  const rowTemplate = (id, name, recovery) => ({
    id,
    generatedSiteId: null,
    resourceId: `res-${id}`,
    resourceName: name,
    siteUrl: '',
    environmentId: 'env-1',
    scenario: 'site-template',
    scope: 'site',
    detailTaskId: recovery.taskId,
    state: 'attention',
    reason: '需要处理',
    targetScore: 85,
    recovery,
    report: null,
    usage: { priced: false, knownCny: 0, missing: 0, requests: 0, input: 0, output: 0, cached: 0 },
    stages: [],
    taskCount: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const f = await fixture((path, options) => {
    if (options.method === 'POST') return { ok: true };
    const res = pageResponse(path);
    res.items = [
      rowTemplate('row-1', 'Alpha', { action: 'resume', taskId: 'task-alpha' }),
      rowTemplate('row-2', 'Beta', { action: 'adjust-site-names', taskId: 'task-beta' }),
    ];
    res.total = 2;
    return res;
  });
  try {
    const selectAll = f.nodes(n => n.tag === 'input' && n.props['aria-label'] === '选择本页全部生成站')[0];
    selectAll.props.onChange({ target: { checked: true } });
    await settle();

    const batchBtn = f.button('一键恢复');
    assert.ok(batchBtn);
    batchBtn.props.onClick();
    await settle();

    const posts = f.calls.filter(c => c.options?.method === 'POST');
    assert.deepEqual(posts.map(c => c.path), [
      '/automation/tasks/task-alpha/resume',
      '/automation/tasks/task-beta/adjust-site-names',
    ]);
    assert.ok(posts.every(c => !c.options.body), 'batch resume never sends force: true');
    assert.deepEqual(f.notified, [{ type: 'success', text: '已提交恢复 2 项任务' }]);
    assert.equal(f.nodes(n => n.props.class === 'selection-bar').length, 0);
    assert.ok(f.calls.at(-1).path.startsWith('/automation/site-deliveries?'));
  } finally {
    f.close();
  }
});

test('SiteDeliveryList batch resume skips confirm-stopped, reports per-item issues, and shows hint when none are resumable', async () => {
  const rowTemplate = (id, name, recovery) => ({
    id,
    generatedSiteId: null,
    resourceId: `res-${id}`,
    resourceName: name,
    siteUrl: '',
    environmentId: 'env-1',
    scenario: 'site-template',
    scope: 'site',
    detailTaskId: recovery.taskId,
    state: 'attention',
    reason: '需要处理',
    targetScore: 85,
    recovery,
    report: null,
    usage: { priced: false, knownCny: 0, missing: 0, requests: 0, input: 0, output: 0, cached: 0 },
    stages: [],
    taskCount: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  let mode = 'mixed';
  const f = await fixture((path, options) => {
    if (options.method === 'POST') {
      if (path.includes('/task-fail/')) return Promise.reject(new Error('同站仍有未停止的执行，请先等待结束后再恢复'));
      return { ok: true };
    }
    const res = pageResponse(path);
    res.items = mode === 'mixed'
      ? [
          rowTemplate('row-ok', 'Site OK', { action: 'resume', taskId: 'task-ok' }),
          rowTemplate('row-fail', 'Site Conflict', { action: 'resume', taskId: 'task-fail' }),
          rowTemplate('row-unconfirmed', 'Site Unconfirmed', { action: 'confirm-stopped', taskId: 'task-unconfirmed' }),
        ]
      : [
          rowTemplate('row-unconfirmed', 'Site Unconfirmed', { action: 'confirm-stopped', taskId: 'task-unconfirmed' }),
        ];
    res.total = res.items.length;
    return res;
  });
  try {
    const selectAll = f.nodes(n => n.tag === 'input' && n.props['aria-label'] === '选择本页全部生成站')[0];
    selectAll.props.onChange({ target: { checked: true } });
    await settle();

    const batchBtn = f.button('一键恢复 (2)');
    assert.ok(batchBtn);
    batchBtn.props.onClick();
    await settle();

    const posts = f.calls.filter(c => c.options?.method === 'POST');
    assert.deepEqual(posts.map(c => c.path), [
      '/automation/tasks/task-ok/resume',
      '/automation/tasks/task-fail/resume',
    ]);
    assert.ok(!posts.some(c => c.path.includes('task-unconfirmed')));
    assert.deepEqual(f.notified, [{ type: 'warning', text: '已提交恢复 1 项任务，另有 2 项未恢复' }]);

    const selectionText = text(f.nodes(n => n.props.class === 'selection-bar')[0]);
    assert.ok(selectionText.includes('已选 2 项'));
    const issuesText = text(f.nodes(n => n.props.class === 'batch-issues')[0]);
    assert.ok(issuesText.includes('Site Unconfirmed'));
    assert.ok(issuesText.includes('尚未确认停止'));
    assert.ok(issuesText.includes('Site Conflict'));
    assert.ok(issuesText.includes('同站仍有未停止的执行'));

    mode = 'only-unconfirmed';
    f.button('清空选择').props.onClick();
    await settle();
    f.nodes(n => n.tag === 'button' && n.props['aria-label'] === '刷新生成站')[0].props.onClick();
    await settle();
    f.nodes(n => n.tag === 'input' && n.props['aria-label'] === '选择本页全部生成站')[0].props.onChange({ target: { checked: true } });
    await settle();
    assert.equal(f.buttonStartsWith('一键恢复'), undefined);
    assert.ok(f.text().includes('所选任务尚未确认原执行停止，请进入详情核查确认后再恢复'));
  } finally {
    f.close();
  }
});

test('SiteDeliveryList prioritizes DE delivery URL alongside source HK URL even while verifying and keeps plain HK sites unbadged', async () => {
  const f = await fixture((path) => {
    const res = pageResponse(path);
    res.items = [
      {
        ...res.items[0],
        id: 'site-delivered',
        generatedSiteId: 'site-delivered',
        resourceName: 'Delivered DE Site',
        siteUrl: 'https://hk-source.kooboo.io/',
        state: 'ready',
        reason: '已完成跨环境交付并通过核验。',
        delivery: { taskId: 'eval-delivered', status: 'completed', targetUrl: 'https://demo.kooboo.de/' },
      },
      {
        ...res.items[0],
        id: 'site-verifying',
        generatedSiteId: 'site-verifying',
        resourceName: 'Verifying Site',
        siteUrl: 'https://hk-verifying.kooboo.io/',
        state: 'running',
        reason: '正在迁移交付或核验目标环境。',
        delivery: { taskId: 'eval-verifying', status: 'verifying', targetUrl: 'https://pending.kooboo.de/' },
      },
      {
        ...res.items[0],
        id: 'site-plain',
        generatedSiteId: 'site-plain',
        resourceName: 'Plain HK Site',
        siteUrl: 'https://hk-plain.kooboo.io/',
        state: 'ready',
        reason: '尚未跨环境交付。',
      },
    ];
    res.total = 3;
    return res;
  });
  try {
    const primaryLinks = f.nodes(n => n.tag === 'a' && String(n.props.class || '').includes('site-address') && !String(n.props.class || '').includes('site-address-secondary'));
    assert.equal(primaryLinks.length, 3);
    assert.equal(primaryLinks[0].props.href, 'https://demo.kooboo.de/');
    assert.ok(String(primaryLinks[0].props.class).includes('site-address-delivered'));
    assert.ok(text(primaryLinks[0]).includes('已交付'));
    assert.ok(text(primaryLinks[0]).includes('https://demo.kooboo.de/'));

    assert.equal(primaryLinks[1].props.href, 'https://pending.kooboo.de/');
    assert.ok(!String(primaryLinks[1].props.class).includes('site-address-delivered'));
    assert.ok(String(primaryLinks[1].props.class).includes('site-address-delivery-pending'));
    assert.ok(text(primaryLinks[1]).includes('核验中'));
    assert.ok(text(primaryLinks[1]).includes('https://pending.kooboo.de/'));
    const pendingBadge = f.nodes(n => n.tag === 'span' && String(n.props.class || '').includes('delivery-link-badge') && String(n.props.class || '').includes('pending'));
    assert.equal(pendingBadge.length, 1);

    assert.equal(primaryLinks[2].props.href, 'https://hk-plain.kooboo.io/');
    assert.ok(!String(primaryLinks[2].props.class).includes('site-address-delivered'));
    assert.ok(!String(primaryLinks[2].props.class).includes('site-address-delivery-pending'));
    assert.equal(text(primaryLinks[2]), 'https://hk-plain.kooboo.io/');

    const secondaryLinks = f.nodes(n => n.tag === 'a' && String(n.props.class || '').includes('site-address-secondary'));
    assert.equal(secondaryLinks.length, 2);
    assert.equal(secondaryLinks[0].props.href, 'https://hk-source.kooboo.io/');
    assert.ok(text(secondaryLinks[0]).includes('源站：https://hk-source.kooboo.io/'));
    assert.equal(secondaryLinks[1].props.href, 'https://hk-verifying.kooboo.io/');
    assert.ok(text(secondaryLinks[1]).includes('源站：https://hk-verifying.kooboo.io/'));

    const statusLinks = f.nodes(n => n.tag === 'a' && String(n.props.class || '').includes('delivery-status-link'));
    assert.equal(statusLinks.length, 1);
    assert.equal(statusLinks[0].props.href, '#/tasks/eval-verifying?tab=delivery');
    assert.ok(text(statusLinks[0]).includes('交付核验中'));
  } finally {
    f.close();
  }
});

test('SiteDeliveryList quick views sync filters, surface row reason, support single-row safe resume, and copy site address', async () => {
  const rowTemplate = (id, name, extra = {}) => ({
    id,
    generatedSiteId: `site-${id}`,
    resourceId: `res-${id}`,
    resourceName: name,
    siteUrl: `https://${id}.kooboo.io/`,
    environmentId: 'env-1',
    scenario: 'site-template',
    scope: 'site',
    detailTaskId: `task-${id}`,
    state: 'ready',
    reason: `${name} 已完成`,
    targetScore: 85,
    report: null,
    usage: { priced: true, knownCny: 1.25, missing: 0, requests: 2, input: 100, output: 50, cached: 0 },
    stages: [],
    taskCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
  let copied = '';
  const prevClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator || {}, 'clipboard');
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async textVal => { copied = textVal; } },
    configurable: true,
  });

  const f = await fixture((path, options) => {
    if (options.method === 'POST') return { ok: true };
    const res = pageResponse(path);
    res.items = [
      rowTemplate('alpha', 'Alpha Blocked', {
        state: 'attention',
        reason: '缺少官网产品图片素材，等待补充。',
        recovery: { action: 'resume', taskId: 'task-alpha' },
      }),
      rowTemplate('beta', 'Beta Unconfirmed', {
        state: 'attention',
        reason: '原浏览器会话尚未确认停止。',
        recovery: { action: 'confirm-stopped', taskId: 'task-beta' },
      }),
      rowTemplate('gamma', 'Gamma Ready', {
        state: 'ready',
        reason: '已完成跨环境交付并通过核验。',
        delivery: { taskId: 'eval-gamma', status: 'completed', targetUrl: 'https://gamma.kooboo.de/' },
      }),
    ];
    res.total = 3;
    return res;
  });

  try {
    // Reason text is rendered directly in the row without needing hover
    assert.ok(f.text().includes('缺少官网产品图片素材，等待补充。'));

    // Single-row resume button is shown for resumable row (alpha), NOT for confirm-stopped (beta)
    const resumeButtons = f.nodes(n => n.tag === 'button' && text(n) === '恢复');
    assert.equal(resumeButtons.length, 1);
    const compareButtons = f.nodes(n => n.tag === 'button' && text(n) === '对比');
    assert.equal(compareButtons.length, 2);

    await resumeButtons[0].props.onClick();
    await settle();
    const posts = f.calls.filter(c => c.options?.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, '/automation/tasks/task-alpha/resume');
    assert.ok(!posts[0].options.body, 'single-row resume never sends force: true');
    assert.deepEqual(f.notified.at(-1), { type: 'success', text: '已提交恢复 Alpha Blocked' });

    // Copy address button uses delivery URL first (or primary site URL) and notifies
    const copyBtns = f.nodes(n => n.tag === 'button' && n.props['aria-label'] === '复制站点地址');
    assert.equal(copyBtns.length, 3);
    await copyBtns[2].props.onClick();
    await settle();
    assert.equal(copied, 'https://gamma.kooboo.de/');
    assert.deepEqual(f.notified.at(-1), { type: 'success', text: '已复制站点地址' });

    // Quick view switch updates state and reloads
    const quickReady = f.button('可交付');
    assert.ok(quickReady);
    quickReady.props.onClick();
    await settle();
    const lastParams = new URL('http://local' + f.calls.at(-1).path).searchParams;
    assert.equal(lastParams.get('state'), 'ready');
    assert.equal(lastParams.get('disposition'), 'active');
  } finally {
    if (prevClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', prevClipboard);
    f.close();
  }
});
