import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

// Exercise the actual Vue SFC template workflow components in Node without controlling a browser.
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'template-workflow-components-'));

let TemplateChecklistManager;
let TemplateWorkflowOverview;
let TemplateBaselinePanel;
let TemplateEvaluationView;

before(async () => {
  const entryFile = join(directory, 'entry.ts');
  const outfile = join(directory, 'bundle.cjs');
  const entrySource = [
    `export { default as TemplateChecklistManager } from ${JSON.stringify(resolve('frontend/src/views/automation/TemplateChecklistManager.vue'))};`,
    `export { default as TemplateWorkflowOverview } from ${JSON.stringify(resolve('frontend/src/views/automation/TemplateWorkflowOverview.vue'))};`,
    `export { default as TemplateBaselinePanel } from ${JSON.stringify(resolve('frontend/src/views/automation/TemplateBaselinePanel.vue'))};`,
    `export { default as TemplateEvaluationView } from ${JSON.stringify(resolve('frontend/src/views/automation/TemplateEvaluationView.vue'))};`,
  ].join('\n');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(entryFile, entrySource, 'utf8');

  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [
      {
        name: 'template-workflow-test-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
          builder.onResolve({ filter: /^@vue\/runtime-dom$/ }, () => ({ path: 'vue-runtime-dom', namespace: 'tw-mock' }));
          builder.onResolve({ filter: /\/template-workflow-client$/ }, () => ({
            path: 'template-workflow-client',
            namespace: 'tw-mock',
          }));
          builder.onResolve({ filter: /\/notifications$/ }, () => ({
            path: 'notifications',
            namespace: 'tw-mock',
          }));
          builder.onResolve({ filter: /\/api$/ }, () => ({
            path: 'api',
            namespace: 'tw-mock',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'tw-mock' }, args => {
            if (args.path === 'vue-runtime-dom') {
              return {
                contents: [
                  "export * from 'vue';",
                  'export const vModelText = { created(el, b) { el.value = b.value ?? ""; }, updated(el, b) { el.value = b.value ?? ""; } };',
                  'export const vModelCheckbox = { created(el, b) { el.checked = Boolean(b.value); }, updated(el, b) { el.checked = Boolean(b.value); } };',
                  'export const vModelDynamic = vModelText;',
                  'export const vShow = { beforeMount(el, b) { el.hidden = !b.value; }, updated(el, b) { el.hidden = !b.value; } };',
                ].join('\n'),
                loader: 'js',
              };
            }
            if (args.path === 'template-workflow-client') {
              return {
                contents: [
                  'export const fetchTemplateChecklists = (...a) => globalThis.__twMock.fetchChecklists(...a);',
                  'export const publishTemplateChecklist = (...a) => globalThis.__twMock.publishChecklist(...a);',
                  'export const fetchTaskTemplateWorkflow = (...a) => globalThis.__twMock.fetchWorkflow(...a);',
                ].join('\n'),
                loader: 'js',
              };
            }
            if (args.path === 'notifications') {
              return {
                contents: 'export const notify = (...a) => globalThis.__twMock.notify?.(...a);',
                loader: 'js',
              };
            }
            return {
              contents: 'export const api = async () => ({}); export const platform = { ready: true, online: true, error: "" }; export const formatDate = ts => `T:${ts}`; export const message = err => err?.message || String(err);',
              loader: 'js',
            };
          });
          builder.onLoad({ filter: /\.vue$/ }, args => {
            if (/(BaseSelect|TablePagination|EvidenceViewer)\.vue$/.test(args.path)) {
              return {
                contents: [
                  "import { h } from 'vue';",
                  'export default {',
                  "  props: ['modelValue', 'options', 'page', 'pages', 'taskId', 'artifacts'],",
                  "  emits: ['update:modelValue', 'change'],",
                  '  setup(props, { attrs, emit, expose }) {',
                  '    expose({ open: (...args) => globalThis.__twMock.openViewer?.(...args) });',
                  "    return () => h('div', { ...attrs, 'data-stub': 'true' });",
                  '  },',
                  '};',
                ].join('\n'),
                loader: 'js',
              };
            }
            const source = readFileSync(args.path, 'utf8');
            const { descriptor } = parse(source, { filename: args.path });
            const compiled = compileScript(descriptor, { id: args.path, inlineTemplate: true });
            return { contents: compiled.content, loader: 'ts', resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });

  const mod = require(outfile);
  TemplateChecklistManager = mod.TemplateChecklistManager;
  TemplateWorkflowOverview = mod.TemplateWorkflowOverview;
  TemplateBaselinePanel = mod.TemplateBaselinePanel;
  TemplateEvaluationView = mod.TemplateEvaluationView;
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
  getRootNode() {
    return globalThis.document;
  }
  scrollIntoView() {}
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
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
    node.children = [];
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _prev, value) {
    node.props[key] = value;
  },
});

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const textOf = node => (node.tag === '#comment' ? '' : node.text) + node.children.map(textOf).join('');

async function settle() {
  await new Promise(r => setImmediate(r));
  await nextTick();
  await new Promise(r => setImmediate(r));
  await nextTick();
}

function mountComponent(Component, props = {}, mocks = {}) {
  const container = new HostNode('root');
  class HostDocument {
    activeElement = null;
    visibilityState = 'visible';
    getElementById(id) {
      return descendants(container).find(n => n.props.id === id) || null;
    }
  }
  Object.defineProperty(globalThis, 'Document', { value: HostDocument, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: new HostDocument(), configurable: true });
  globalThis.__twMock = {
    fetchChecklists: async () => ({
      status: 'unavailable',
      reason: '当前运行服务尚未接入模板检查集接口',
    }),
    publishChecklist: async () => {
      throw new Error('未接入');
    },
    fetchWorkflow: async () => ({
      status: 'unavailable',
      reason: '当前运行服务尚未接入模板新流程接口',
    }),
    notify: { info() {}, success() {}, error() {} },
    ...mocks,
  };
  const app = renderer.createApp({ render: () => h(Component, props) });
  app.mount(container);
  return {
    container,
    text: () => textOf(container),
    nodes: pred => descendants(container).filter(pred),
    buttonContaining: label => descendants(container).find(n => n.tag === 'button' && textOf(n).includes(label)),
    unmount() {
      app.unmount();
    },
  };
}

const sampleChecklist = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  revision: 2,
  hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  createdAt: 1762920000000,
  name: 'AI Site 模板通用检查集',
  checks: [
    {
      id: 'content-gutter',
      title: '正文左右留白',
      enabled: true,
      kind: 'gutter',
      executor: 'script',
      instruction: '正文内容不应紧贴视口左右边缘。',
      scopes: ['homepage', 'site'],
      viewports: ['desktop', 'mobile'],
      required: true,
      severity: 'major',
      weight: 2,
      tolerancePx: 8,
      exceptions: '全出血背景图除外。',
    },
  ],
};

const sampleWorkflow = {
  supported: true,
  taskId: '11111111-2222-4333-8444-555555555555',
  rootTaskId: '00000000-2222-4333-8444-555555555555',
  version: 1,
  phase: 'repair',
  checklist: sampleChecklist,
  limitations: [],
  baseline: {
    id: '22222222-2222-4333-8444-555555555555',
    revision: 1,
    createdAt: 1762920100000,
    inputVersionId: 'input-v1-abcd1234',
    referenceUrl: 'https://ref.example.com',
    contentUrl: null,
    scope: 'homepage',
    contentMapping: '使用模板示例文案',
    limitations: ['联系表单提交后弹窗需交互触发，首轮未深采'],
    complete: true,
    checklistId: sampleChecklist.id,
    experienceGuidance: [
      {
        id: '99999999-2222-4333-8444-555555555555',
        revision: 3,
        guidance: '移动端区块容器保留至少 16px 内边距，避免文字贴边。',
        reason: '命中 AI Site 模板移动端留白高频问题',
      },
    ],
    evidence: [
      {
        name: '33333333-2222-4333-8444-555555555555.png',
        ownerTaskId: '00000000-2222-4333-8444-555555555555',
        role: 'reference',
        viewport: 'mobile',
        url: 'https://ref.example.com/',
        type: 'image/png',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        size: 18000,
        siteRevision: null,
        href: '/api/automation/tasks/11111111-2222-4333-8444-555555555555/template-workflow/artifacts/33333333-2222-4333-8444-555555555555.png',
      },
    ],
    pages: [
      {
        path: '/',
        title: '首页',
        views: [
          {
            id: 'contact',
            title: '联系我们',
            role: 'contact',
            required: true,
            layouts: [
              {
                viewport: 'mobile',
                selector: 'section.contact',
                evidence: ['33333333-2222-4333-8444-555555555555.png'],
                intent: '单列堆叠并保留 16px 左右留白',
                exceptions: '',
                constraints: [
                  {
                    id: 'c-1',
                    checkId: 'content-gutter',
                    expected: '左右内边距 >= 16px',
                    anchors: ['section.contact .inner'],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  evaluation: {
    taskId: '11111111-2222-4333-8444-555555555555',
    siteRevision: 'rev-target-01',
    baselineId: '22222222-2222-4333-8444-555555555555',
    checklistId: sampleChecklist.id,
    createdAt: 1762920600000,
    complete: true,
    quality: 'failed',
    scores: [
      { viewport: 'desktop', value: 96 },
      { viewport: 'mobile', value: 58 },
    ],
    captures: [
      {
        pagePath: '/',
        viewport: 'desktop',
        mode: 'inherited',
        selectors: [],
        reason: 'PC 端依赖未变，继承首轮有效证据',
        evidence: [],
        complete: true,
        sourceTaskId: '00000000-2222-4333-8444-555555555555',
        sourceRevision: 'rev-target-00',
      },
      {
        pagePath: '/',
        viewport: 'mobile',
        mode: 'regions',
        selectors: ['section.contact'],
        reason: '局部重采移动端联系区块',
        evidence: ['44444444-2222-4333-8444-555555555555.png'],
        complete: true,
      },
    ],
    checks: [
      {
        id: 'res-mobile-gutter',
        checkId: 'content-gutter',
        pagePath: '/',
        viewId: 'contact',
        viewport: 'mobile',
        status: 'failed',
        expected: '左右留白 >= 16px',
        actual: '实测左右留白 2px',
        reason: '文字紧贴移动端视口边缘',
        score: 58,
        measurements: { paddingLeft: 2, paddingRight: 2 },
        evidence: ['44444444-2222-4333-8444-555555555555.png'],
        provenance: 'measured',
        sourceTaskId: '11111111-2222-4333-8444-555555555555',
        sourceRevision: 'rev-target-01',
      },
    ],
    issues: [
      {
        id: 'issue-gutter-01',
        checkResultId: 'res-mobile-gutter',
        pagePath: '/',
        viewId: 'contact',
        viewport: 'mobile',
        title: '移动端联系区块左右留白不足',
        severity: 'major',
        expected: '左右留白 >= 16px',
        actual: '左右留白仅 2px',
        acceptance: '移动端联系区块左右留白恢复至 >= 16px（容差 8px）且无横向溢出',
        evidence: ['44444444-2222-4333-8444-555555555555.png'],
        status: 'open',
      },
    ],
    evidence: [
      {
        name: '44444444-2222-4333-8444-555555555555.png',
        ownerTaskId: '11111111-2222-4333-8444-555555555555',
        role: 'target',
        viewport: 'mobile',
        url: 'https://target.example.com/',
        type: 'image/png',
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        size: 19500,
        siteRevision: 'rev-target-01',
        href: '/api/automation/tasks/11111111-2222-4333-8444-555555555555/template-workflow/artifacts/44444444-2222-4333-8444-555555555555.png',
      },
    ],
  },
};

test('TemplateChecklistManager shows honest unavailable state when backend route is missing and renders versioned checks when available', async () => {
  const unavailableView = mountComponent(TemplateChecklistManager);
  await settle();
  try {
    assert.ok(unavailableView.text().includes('当前运行服务尚未接入模板检查集接口'));
    const createBtn = unavailableView.buttonContaining('创建检查集版本');
    assert.ok(createBtn);
    assert.equal(createBtn.props.disabled, true);
  } finally {
    unavailableView.unmount();
  }

  const readyView = mountComponent(
    TemplateChecklistManager,
    {},
    { fetchChecklists: async () => ({ status: 'ready', data: [sampleChecklist] }) },
  );
  await settle();
  try {
    assert.ok(readyView.text().includes('正文左右留白'));
    assert.ok(readyView.text().includes('不混入通用规则'));
    const editBtn = readyView.buttonContaining('编辑为新版本');
    assert.ok(editBtn);
    assert.equal(editBtn.props.disabled, false);
    editBtn.props.onClick();
    await settle();
    assert.ok(readyView.text().includes('编辑新检查集版本'));
    assert.ok(readyView.text().includes('暂存本地草稿'));
  } finally {
    readyView.unmount();
  }
});

test('TemplateWorkflowOverview and TemplateBaselinePanel render frozen baseline, limitations, imagePlaceholder policy, and experienceGuidance', async () => {
  const overview = mountComponent(TemplateWorkflowOverview, {
    workflow: sampleWorkflow,
    activeStatus: 'running',
    repairRoundCount: 1,
    createdAt: 1762920000000,
  });
  await settle();
  try {
    assert.ok(overview.text().includes('参考分析'));
    assert.ok(overview.text().includes('站点生成'));
    assert.ok(overview.text().includes('共享核验'));
    assert.ok(overview.text().includes('修复与局部复验'));
  } finally {
    overview.unmount();
  }

  const baselineView = mountComponent(TemplateBaselinePanel, { workflow: sampleWorkflow });
  await settle();
  try {
    const rendered = baselineView.text();
    assert.ok(rendered.includes('冻结参考分析与共同基线'));
    assert.ok(rendered.includes('imagePlaceholder'));
    assert.ok(rendered.includes('联系表单提交后弹窗需交互触发'));
    assert.ok(rendered.includes('单列堆叠并保留 16px 左右留白'));
    assert.ok(rendered.includes('生成前命中的简短适用经验（1 条）'));
  } finally {
    baselineView.unmount();
  }
});

test('TemplateEvaluationView renders server scores, capture scopes, stable issue tracker, drill-down, and paired reference+target comparison', async () => {
  let viewerCalls = [];
  const evalView = mountComponent(
    TemplateEvaluationView,
    { workflow: sampleWorkflow },
    { openViewer: (...args) => viewerCalls.push(args) },
  );
  await settle();
  try {
    const rendered = evalView.text();
    assert.ok(rendered.includes('96'));
    assert.ok(rendered.includes('58'));
    assert.ok(rendered.includes('#issue-gutter-01'));
    assert.ok(rendered.includes('待修复 · 待独立复验'));
    assert.ok(rendered.includes('继承 1'));
    assert.ok(rendered.includes('局部重采 1'));
    assert.ok(rendered.includes('本轮实测'));

    // Expand issue evidence and trigger comparison viewer
    const expandBtn = evalView.buttonContaining('查看相关证据（1）');
    assert.ok(expandBtn);
    expandBtn.props.onClick();
    await settle();

    const previewBtn = evalView.nodes(
      n => n.tag === 'button' && String(n.props['aria-label'] || '').includes('对比预览'),
    )[0];
    assert.ok(previewBtn);
    previewBtn.props.onClick();
    await settle();

    assert.equal(viewerCalls.length, 1);
    const [contexts, index, clickedFile, preferCompare] = viewerCalls[0];
    assert.equal(index, 0);
    assert.equal(clickedFile, '44444444-2222-4333-8444-555555555555.png');
    assert.equal(preferCompare, true);
    // Paired both target evidence and matching mobile reference baseline screenshot!
    assert.ok(contexts[0].evidence.includes('44444444-2222-4333-8444-555555555555.png'));
    assert.ok(contexts[0].evidence.includes('33333333-2222-4333-8444-555555555555.png'));
  } finally {
    evalView.unmount();
  }
});
