import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'workflow-graph-component-'));
let TaskWorkflowGraph;

before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({
    entryPoints: [resolve('frontend/src/views/automation/TaskWorkflowGraph.vue')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [
      {
        name: 'workflow-graph-test-services',
        setup(builder) {
          builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
          builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'wf-test' }));
          builder.onLoad({ filter: /.*/, namespace: 'wf-test' }, () => ({
            contents: `
              export const sessionFetch = (...args) => globalThis.__wfTest.fetch(...args);
              export const message = e => e?.message || String(e);
              export const formatDate = () => '01-01 12:00';
              export const platform = {};
            `,
            loader: 'js',
          }));
          builder.onLoad({ filter: /\.vue$/ }, (args) => {
            const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
            return {
              contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
              loader: 'ts',
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  TaskWorkflowGraph = require(outfile).default;
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
  focus() {}
  scrollTo() {}
}

const renderer = createRenderer({
  createElement: (tag) => new HostNode(tag),
  createText: (text) => new HostNode('#text', text),
  createComment: (text) => new HostNode('#comment', text),
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
  insertStaticContent(content, parent, anchor = null) {
    const node = new HostNode('#static', content);
    node.parent = parent;
    const index = parent.children.indexOf(anchor);
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    return [node, node];
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
const text = (node) => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
    await nextTick();
  }
}

function sampleGraph() {
  return {
    taskId: 't-1',
    rootTaskId: 't-1',
    viewingTaskId: 't-1',
    scenario: 'materials',
    scope: 'site',
    kind: 'generation',
    overallStatus: 'attention',
    overallLabel: '卡住待处理',
    headline: '资料建站 · 当前卡在「AI 生成建站」：AI 需要人工确认或补充资料后才能继续',
    currentNodeId: 'generation',
    blocker: {
      nodeId: 'generation',
      nodeTitle: 'AI 生成建站',
      taskId: 't-1',
      severity: 'error',
      category: 'need-human-input',
      headline: 'AI 需要人工确认或补充资料后才能继续',
      explanation: 'Kooboo AI 正在等待您补充公司 Logo 文件后继续。',
      actions: ['点击补充资料并上传文件', '确认后点击恢复任务'],
      canSupplement: true,
      recoveryAction: 'resume',
      needsStopConfirm: false,
    },
    targetScore: 85,
    totalRecordedMs: 14000,
    timingComplete: false,
    updatedAt: 100,
    rounds: [
      {
        number: 0,
        label: '初始轮',
        generationTaskId: 't-1',
        generationStatus: 'interrupted',
        summary: '生成阶段需补充资料',
        isCurrent: true,
      },
    ],
    nodes: [
      {
        id: 'prepare',
        kind: 'prepare',
        lane: 'main',
        column: 0,
        title: '环境与资料准备',
        subtitle: '站点与资料已就绪',
        status: 'completed',
        statusLabel: '已完成',
        summary: '已完成建站与资料包上传。',
        description: '准备环境与资料',
        taskId: 't-1',
        durationMs: 4000,
        checks: [{ id: 'c1', label: '创建目标站', status: 'done' }],
        actions: [{ type: 'tab', label: '查看输入与配置', tab: 'input' }],
      },
      {
        id: 'generation',
        kind: 'generation',
        lane: 'main',
        column: 1,
        title: 'AI 生成建站',
        subtitle: '生成阶段需要处理',
        status: 'attention',
        statusLabel: '需处理',
        summary: 'AI 停下来等待补充文件。',
        description: 'AI 建站阶段',
        taskId: 't-1',
        durationMs: 10000,
        isCurrent: true,
        isBlocker: true,
        blocker: {
          nodeId: 'generation',
          nodeTitle: 'AI 生成建站',
          taskId: 't-1',
          severity: 'error',
          category: 'need-human-input',
          headline: 'AI 需要人工确认或补充资料后才能继续',
          explanation: 'Kooboo AI 正在等待您补充公司 Logo 文件后继续。',
          actions: ['点击补充资料并上传文件', '确认后点击恢复任务'],
          canSupplement: true,
          recoveryAction: 'resume',
          needsStopConfirm: false,
        },
        actions: [{ type: 'tab', label: '查看执行记录', tab: 'execution' }],
      },
      {
        id: 'evaluation',
        kind: 'evaluation',
        lane: 'main',
        column: 2,
        title: '独立评测',
        subtitle: '等待建站完成后开始',
        status: 'pending',
        statusLabel: '待开始',
        summary: '等待生成完成后自动开始独立评测。',
        description: '双端独立核验',
        durationMs: null,
      },
    ],
    edges: [
      { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true, active: true },
      { id: 'e2', from: 'generation', to: 'evaluation', kind: 'sequence' },
    ],
  };
}

async function mountGraph(fetchImpl) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, '__wfTest');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, '__wfTest', { value: { fetch: fetchImpl }, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: Object.assign(new EventTarget(), { hidden: false }), configurable: true });

  const emitted = { selectTab: [], openSupplement: 0, action: [], unavailable: 0 };
  const container = new HostNode('root');
  const app = renderer.createApp({
    render: () =>
      h(TaskWorkflowGraph, {
        taskId: 't-1',
        revision: '1',
        createdAt: 1000,
        canSupplement: true,
        onSelectTab: (tab) => emitted.selectTab.push(tab),
        onOpenSupplement: () => { emitted.openSupplement++; },
        onAction: (act, id) => emitted.action.push({ act, id }),
        onUnavailable: () => { emitted.unavailable++; },
      }),
  });
  app.mount(container);
  await settle();

  return {
    container,
    emitted,
    text: () => text(container),
    nodes: () => descendants(container),
    close() {
      app.unmount();
      if (prev) Object.defineProperty(globalThis, '__wfTest', prev);
      else delete globalThis.__wfTest;
      if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
      else delete globalThis.document;
    },
  };
}

test('TaskWorkflowGraph highlights blocker node, allows clicking other nodes, and triggers actions', async () => {
  const f = await mountGraph(async () =>
    new Response(JSON.stringify(sampleGraph()), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  try {
    const rendered = f.text();
    assert.ok(rendered.includes('卡在这里'));
    assert.ok(rendered.includes('AI 需要人工确认或补充资料后才能继续'));
    assert.ok(rendered.includes('初始轮'));

    // Click recovery & supplement buttons in inspector
    const resumeBtn = f.nodes().find((n) => n.tag === 'button' && text(n) === '恢复任务');
    const suppBtn = f.nodes().find((n) => n.tag === 'button' && text(n) === '补充资料 / AI 收集');
    assert.ok(resumeBtn);
    assert.ok(suppBtn);
    resumeBtn.props.onClick();
    suppBtn.props.onClick();
    assert.deepEqual(f.emitted.action, [{ act: 'resume', id: 't-1' }]);
    assert.equal(f.emitted.openSupplement, 1);

    // Click prepare node to switch inspector content & trigger tab jump
    const prepNode = f.nodes().find((n) => n.tag === 'button' && n.props.id === 'workflow-node-prepare');
    assert.ok(prepNode);
    prepNode.props.onClick();
    await settle();
    assert.ok(f.text().includes('已完成建站与资料包上传。'));
    const inputTabBtn = f.nodes().find((n) => n.tag === 'button' && text(n).includes('查看输入与配置'));
    assert.ok(inputTabBtn);
    inputTabBtn.props.onClick();
    assert.deepEqual(f.emitted.selectTab, ['input']);
  } finally {
    f.close();
  }
});

test('TaskWorkflowGraph emits unavailable when backend returns missing route 404', async () => {
  const f = await mountGraph(async () =>
    new Response(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Route GET:/api/automation/tasks/t-1/workflow not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  );
  try {
    assert.equal(f.emitted.unavailable, 1);
  } finally {
    f.close();
  }
});

test('TaskWorkflowGraph differentiates warning/waiting badges and skips fetch when document is hidden', async () => {
  const warnGraph = sampleGraph();
  warnGraph.blocker.severity = 'warning';
  warnGraph.nodes[1].blocker.severity = 'warning';

  let fetches = 0;
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevTest = Object.getOwnPropertyDescriptor(globalThis, '__wfTest');
  const doc = Object.assign(new EventTarget(), { hidden: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, '__wfTest', {
    value: {
      fetch: async () => {
        fetches++;
        return new Response(JSON.stringify(warnGraph), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
    configurable: true,
  });

  const container = new HostNode('root');
  const app = renderer.createApp({
    render: () => h(TaskWorkflowGraph, { taskId: 't-1', revision: '1', createdAt: 1000 }),
  });
  app.mount(container);
  await settle();
  try {
    assert.equal(fetches, 0, 'hidden tab must skip eager workflow fetch');
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(fetches, 1, 'visible tab resumes pending refresh once');
    assert.ok(text(container).includes('需关注'));
    assert.ok(!text(container).includes('卡在这里'));
  } finally {
    app.unmount();
    if (prevTest) Object.defineProperty(globalThis, '__wfTest', prevTest);
    else delete globalThis.__wfTest;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  }
});
