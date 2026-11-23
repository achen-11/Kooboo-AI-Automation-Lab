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
const directory = mkdtempSync(join(tmpdir(), 'task-detail-refactor-test-'));
let TaskOverviewHero;
let SiteReports;
let TaskReport;

before(async () => {
  const entries = [
    ['hero', 'frontend/src/views/automation/TaskOverviewHero.vue', /\/(TaskOverviewHero|TaskRecoveryActions)\.vue$/],
    ['siteReports', 'frontend/src/views/automation/SiteReports.vue', /\/(SiteReports|TaskReport|BaseSelect|Disclosure|TablePagination)\.vue$/],
    ['taskReport', 'frontend/src/views/automation/TaskReport.vue', /\/(TaskReport|Disclosure|TablePagination)\.vue$/],
  ];
  for (const [name, entry, realMatcher] of entries) {
    const outfile = join(directory, `${name}.cjs`);
    await build({
      entryPoints: [resolve(entry)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      plugins: [{
        name: `refactor-services-${name}`,
        setup(builder) {
          builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
          builder.onResolve({ filter: /^@lucide\/vue$/ }, () => ({ path: 'lucide', namespace: 'refactor-test' }));
          builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'refactor-test' }));
          builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'refactor-test' }));
          builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'refactor-test' }));
          builder.onLoad({ filter: /.*/, namespace: 'refactor-test' }, args => {
            if (args.path === 'lucide') {
              return {
                contents: "import { h } from 'vue'; const Icon = () => h('svg'); export const ArrowUpRight = Icon, ArrowLeft = Icon, Columns2 = Icon, Copy = Icon, ExternalLink = Icon, Upload = Icon, Check = Icon, Play = Icon, FileText = Icon, LoaderCircle = Icon, ChevronDown = Icon, ChevronRight = Icon, ChevronLeft = Icon, Search = Icon, Image = Icon, Download = Icon, ShieldCheck = Icon;",
                loader: 'js',
              };
            }
            if (args.path === 'api') {
              return {
                contents: 'export const api = (...args) => globalThis.__refactorServices.request(...args); export const message = e => e.message; export const formatDate = String; export const go = p => globalThis.__refactorServices.navigated.push(p); export const platform = { settings: { threshold: 80 } };',
                loader: 'js',
              };
            }
            if (args.path === 'notifications') {
              return {
                contents: 'export const notify = { success: t => globalThis.__refactorServices.notified.push({ type: "success", text: t }), error: t => globalThis.__refactorServices.notified.push({ type: "error", text: t }) };',
                loader: 'js',
              };
            }
            return {
              contents: "export const scopeName = s => s === 'homepage' ? '仅首页' : '全站';",
              loader: 'js',
            };
          });
          builder.onLoad({ filter: /\.vue$/ }, args => {
            if (!realMatcher.test(args.path)) {
              return {
                contents: "import { h } from 'vue'; export default { props: ['taskId', 'siteId', 'revision'], emits: ['open', 'change'], setup: (p, { slots }) => () => h('div', { 'data-stub': p.taskId || 'stub' }, slots.default?.()) };",
                loader: 'js',
              };
            }
            const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
            return {
              contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
              loader: 'ts',
              resolveDir: dirname(args.path),
            };
          });
        },
      }],
    });
    const loaded = require(outfile).default;
    if (name === 'hero') TaskOverviewHero = loaded;
    else if (name === 'siteReports') SiteReports = loaded;
    else TaskReport = loaded;
  }
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

function setupEnv({ hash = '#/tasks/gen-1', request }) {
  const previous = new Map(['window', 'document', '__refactorServices'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), {
    location: { hash },
    history: { replaceState() {} },
  });
  const notified = [];
  const navigated = [];
  const prevClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator || {}, 'clipboard');
  if (typeof globalThis.navigator === 'undefined') Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  let copied = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: async v => { copied = v; } },
    configurable: true,
  });
  for (const [k, v] of Object.entries({ window, document, __refactorServices: { request, notified, navigated } })) {
    Object.defineProperty(globalThis, k, { value: v, configurable: true });
  }
  return {
    notified,
    navigated,
    getCopied: () => copied,
    restore() {
      if (prevClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', prevClipboard);
      for (const [k, v] of previous) {
        if (v) Object.defineProperty(globalThis, k, v);
        else delete globalThis[k];
      }
    },
  };
}

test('TaskOverviewHero surfaces delivered URL, copy action, scores, total cost, and skips site request when siteId is null', async () => {
  const calls = [];
  const env = setupEnv({
    request: async path => {
      calls.push(path);
      if (path === '/automation/site-deliveries/site-1') {
        return {
          id: 'site-1',
          generatedSiteId: 'site-1',
          resourceId: 'res-1',
          resourceName: 'Coffee Shop',
          siteUrl: 'https://hk-coffee.kooboo.io/',
          environmentId: 'env-1',
          scenario: 'site-template',
          scope: 'site',
          detailTaskId: 'gen-1',
          state: 'ready',
          reason: '已达到交付标准并完成核验。',
          targetScore: 85,
          delivery: { taskId: 'eval-1', status: 'completed', targetUrl: 'https://de-coffee.kooboo.de/' },
          report: {
            id: 'eval-1',
            report: { quality: 'passed', scores: [{ viewport: 'desktop', value: 92 }, { viewport: 'mobile', value: 88 }], issueCount: 0, unverifiedCount: 0 },
          },
          usage: { priced: true, knownCny: 3.4567, missing: 0, requests: 10, input: 1000, output: 500, cached: 0 },
          stages: [],
          taskCount: 2,
          createdAt: 1,
          updatedAt: 2,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });

  const task = {
    id: 'gen-1',
    kind: 'generation',
    resourceId: 'res-1',
    resourceName: 'Coffee Shop',
    scenario: 'site-template',
    scope: 'site',
    environmentId: 'env-1',
    generatedSiteId: 'site-1',
    status: 'completed',
    stopped: true,
    createdAt: 1,
    updatedAt: 2,
    siteUrl: 'https://hk-coffee.kooboo.io/',
    usage: { priced: true, knownCny: 1.2, missing: 0, requests: 3, input: 300, output: 100, cached: 0 },
    report: null,
    attention: '',
    nextStep: '',
  };

  const c1 = new HostNode('root');
  const app1 = renderer.createApp({
    render: () => h(TaskOverviewHero, {
      task,
      current: task,
      siteId: 'site-1',
      revision: '1',
    }),
  });
  app1.mount(c1);
  await settle();

  try {
    assert.deepEqual(calls, ['/automation/site-deliveries/site-1']);
    const renderedText = text(c1);
    assert.ok(renderedText.includes('已交付'));
    assert.ok(renderedText.includes('https://de-coffee.kooboo.de/'));
    assert.ok(renderedText.includes('达到交付标准'));
    assert.ok(renderedText.includes('PC92'));
    assert.ok(renderedText.includes('移动端88'));
    assert.ok(renderedText.includes('¥ 3.4567'));
    assert.equal(descendants(c1).filter(n => n.tag === 'button' && text(n) === '打开交付站').length, 0);

    const copyBtn = descendants(c1).find(n => n.tag === 'button' && n.props['aria-label'] === '复制站点地址');
    assert.ok(copyBtn);
    await copyBtn.props.onClick();
    await settle();
    assert.equal(env.getCopied(), 'https://de-coffee.kooboo.de/');
    assert.deepEqual(env.notified, [{ type: 'success', text: '已复制站点地址' }]);

    // Without siteId, no /site-deliveries call is issued and blocked task stays concise without duplicating header recovery button
    calls.length = 0;
    const blockedTask = {
      ...task,
      generatedSiteId: null,
      status: 'interrupted',
      stopped: true,
      attention: '生成阶段连接超时',
      nextStep: '点击恢复重试当前阶段',
    };
    const c2 = new HostNode('root');
    const app2 = renderer.createApp({
      render: () => h(TaskOverviewHero, {
        task: blockedTask,
        current: blockedTask,
        siteId: null,
        revision: '1',
      }),
    });
    app2.mount(c2);
    await settle();
    try {
      assert.deepEqual(calls, []);
      assert.ok(text(c2).includes('已中断'));
      assert.ok(text(c2).includes('生成阶段连接超时'));
      assert.equal(descendants(c2).filter(n => n.tag === 'button' && text(n) === '恢复任务').length, 0);
    } finally {
      app2.unmount();
    }
  } finally {
    app1.unmount();
    env.restore();
  }
});

test('SiteReports defaults directly to current latest report unless view=history is requested', async () => {
  const reportPayload = {
    taskId: 'eval-2',
    report: {
      summary: '页面整体完成度高。',
      quality: 'passed',
      scores: [{ viewport: 'desktop', value: 91 }, { viewport: 'mobile', value: 89 }],
      assessments: [{ criterionId: 'visual', viewport: 'desktop', score: 91, reason: '布局整洁', evidence: [] }],
      issues: [{ severity: 'minor', title: '按钮间距略窄', detail: '移动端次级按钮间距偏小', evidence: [] }],
      coverage: { verified: ['/'], unverified: [], outOfScope: [] },
      artifacts: [],
      checksSnapshot: { hash: '1234567890abcdef', ruleCount: 4 },
    },
    rule: { criteria: [{ id: 'visual', label: '视觉还原' }] },
  };
  const reportsPagePayload = {
    currentReportId: 'eval-2',
    scope: 'site',
    targetScore: 85,
    items: [
      { id: 'eval-2', scope: 'site', createdAt: 20, status: 'completed', optimizationRound: 1, reportCurrent: true, report: { quality: 'passed', scores: [{ viewport: 'desktop', value: 91 }] } },
      { id: 'eval-1', scope: 'site', createdAt: 10, status: 'completed', optimizationRound: 0, reportCurrent: false, report: { quality: 'failed', scores: [{ viewport: 'desktop', value: 76 }] } },
    ],
    total: 2,
    pages: 1,
    page: 1,
    pageSize: 10,
  };

  const request = async path => {
    if (path.startsWith('/automation/site-deliveries/site-1/reports?')) return structuredClone(reportsPagePayload);
    if (path === '/automation/site-deliveries/site-1/reports/eval-2') return structuredClone(reportPayload);
    throw new Error(`Unexpected request: ${path}`);
  };

  // Default ?tab=report opens eval-2 directly without stopping on history table
  const env1 = setupEnv({ hash: '#/tasks/gen-1?tab=report', request });
  const c1 = new HostNode('root');
  const app1 = renderer.createApp({
    render: () => h(SiteReports, { taskId: 'gen-1', siteId: 'site-1', taskKind: 'generation', revision: '1', detailRevision: '1' }),
  });
  app1.mount(c1);
  await settle();
  try {
    const out = text(c1);
    assert.ok(out.includes('全部评测记录（2）'));
    assert.ok(out.includes('按钮间距略窄'));
    assert.equal(descendants(c1).filter(n => n.tag === 'button' && text(n) === '实时站点对比').length, 1);

    // Check CHECKS promote button moved inside Disclosure rather than top-level issue card
    const disclosures = descendants(c1).filter(n => n.tag === 'details');
    assert.ok(disclosures.length >= 2);
    const issueSection = descendants(c1).find(n => n.tag === 'article' && String(n.props.class || '').includes('report-issue'));
    assert.ok(issueSection);
    assert.ok(!text(issueSection).includes('沉淀为 CHECKS 规则'));
  } finally {
    app1.unmount();
    env1.restore();
  }

  // Explicit ?tab=report&view=history renders history table
  const env2 = setupEnv({ hash: '#/tasks/gen-1?tab=report&view=history', request });
  const c2 = new HostNode('root');
  const app2 = renderer.createApp({
    render: () => h(SiteReports, { taskId: 'gen-1', siteId: 'site-1', taskKind: 'generation', revision: '1', detailRevision: '1' }),
  });
  app2.mount(c2);
  await settle();
  try {
    assert.ok(text(c2).includes('评测记录'));
    assert.ok(text(c2).includes('当前结果'));
    assert.ok(text(c2).includes('历史报告'));
  } finally {
    app2.unmount();
    env2.restore();
  }
});
