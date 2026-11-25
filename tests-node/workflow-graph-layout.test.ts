import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWorkflowLayout,
  defaultSelectedNodeId,
  estimateEdgeLabelBox,
  rectsOverlap,
  type LayoutRect,
} from '../frontend/src/lib/workflow-graph-layout.js';
import type { TaskWorkflowGraph } from '../shared/workflow-graph.js';

function baseGraph(): TaskWorkflowGraph {
  return {
    taskId: 't1',
    rootTaskId: 't1',
    viewingTaskId: 't1',
    scenario: 'materials',
    scope: 'site',
    kind: 'generation',
    overallStatus: 'running',
    overallLabel: '进行中',
    headline: '正在推进',
    currentNodeId: 'evaluation',
    blocker: null,
    targetScore: 85,
    totalRecordedMs: 12000,
    timingComplete: false,
    updatedAt: 1,
    rounds: [],
    nodes: [
      {
        id: 'prepare',
        kind: 'prepare',
        lane: 'main',
        column: 0,
        title: '环境与资料准备',
        subtitle: '已完成',
        status: 'completed',
        statusLabel: '已完成',
        summary: 'ok',
        description: 'desc',
        durationMs: 2000,
      },
      {
        id: 'generation',
        kind: 'generation',
        lane: 'main',
        column: 1,
        title: 'AI 生成建站',
        subtitle: '已完成',
        status: 'completed',
        statusLabel: '已完成',
        summary: 'ok',
        description: 'desc',
        durationMs: 5000,
      },
      {
        id: 'evaluation',
        kind: 'evaluation',
        lane: 'main',
        column: 2,
        title: '独立评测',
        subtitle: '进行中',
        status: 'running',
        statusLabel: '进行中',
        summary: 'ok',
        description: 'desc',
        durationMs: 3000,
      },
      {
        id: 'quality-gate',
        kind: 'quality-gate',
        lane: 'main',
        column: 3,
        title: '质量达标判定',
        subtitle: '目标 85',
        status: 'pending',
        statusLabel: '待开始',
        summary: 'ok',
        description: 'desc',
        durationMs: null,
      },
      {
        id: 'followup',
        kind: 'followup',
        lane: 'branch',
        column: 2,
        anchorNodeId: 'evaluation',
        title: 'AI 自动跟进',
        subtitle: '跟进中',
        status: 'running',
        statusLabel: '进行中',
        summary: 'ok',
        description: 'desc',
        durationMs: 1000,
      },
      {
        id: 'optimization',
        kind: 'optimization',
        lane: 'branch',
        column: 2,
        anchorNodeId: 'evaluation',
        title: '自动优化修复',
        subtitle: '修复轮',
        status: 'pending',
        statusLabel: '待开始',
        summary: 'ok',
        description: 'desc',
        durationMs: null,
      },
    ],
    edges: [
      { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true },
      { id: 'e2', from: 'generation', to: 'evaluation', kind: 'sequence', completed: true },
      { id: 'e3', from: 'evaluation', to: 'quality-gate', kind: 'sequence' },
      { id: 'e4', from: 'quality-gate', to: 'optimization', kind: 'fail', label: '未达标' },
      { id: 'e5', from: 'optimization', to: 'evaluation', kind: 'loop', label: '复评' },
      { id: 'e6', from: 'evaluation', to: 'followup', kind: 'branch', label: '跟进' },
    ],
  };
}

test('computeWorkflowLayout arranges main nodes left-to-right and avoids branch overlaps', () => {
  const graph = baseGraph();
  const layout = computeWorkflowLayout(graph);

  const main = layout.nodes.filter((n) => n.node.lane === 'main');
  for (let i = 1; i < main.length; i++) {
    assert.ok(main[i].x > main[i - 1].x + main[i - 1].width, 'main nodes must not overlap horizontally');
    assert.equal(main[i].y, main[0].y, 'main nodes share one horizontal row');
  }

  const branches = layout.nodes.filter((n) => n.node.lane === 'branch').sort((a, b) => a.x - b.x);
  assert.equal(branches.length, 2);
  assert.ok(branches[1].x >= branches[0].x + branches[0].width + 20, 'branch nodes sharing an anchor must not overlap');
  assert.ok(branches[0].y > main[0].y + main[0].height, 'branch row sits below main row');

  assert.equal(layout.edges.length, 6);
  for (const edge of layout.edges) {
    assert.ok(edge.path.startsWith('M '), 'each edge builds a valid SVG path');
    assert.ok(Number.isFinite(edge.labelX) && Number.isFinite(edge.labelY));
  }
  assert.ok(layout.width >= Math.max(...layout.nodes.map((n) => n.x + n.width)));
  assert.ok(layout.height >= Math.max(...layout.nodes.map((n) => n.y + n.height)));
});

test('defaultSelectedNodeId prioritizes blocker over current node', () => {
  const graph = baseGraph();
  assert.equal(defaultSelectedNodeId(graph), 'evaluation');

  graph.blocker = {
    nodeId: 'prepare',
    nodeTitle: '环境与资料准备',
    taskId: 't1',
    severity: 'error',
    headline: '名称冲突',
    explanation: '冲突',
    actions: ['调整'],
  };
  assert.equal(defaultSelectedNodeId(graph), 'prepare');
});

test('complex topology with optimization loop, pass label, followup, and learning has zero overlaps', () => {
  const graph = baseGraph();
  graph.nodes.push(
    {
      id: 'delivery',
      kind: 'delivery',
      lane: 'main',
      column: 4,
      title: '跨环境交付',
      subtitle: '等待达标',
      status: 'pending',
      statusLabel: '待开始',
      summary: 'ok',
      description: 'desc',
      durationMs: null,
    },
    {
      id: 'learning',
      kind: 'learning',
      lane: 'branch',
      column: 4,
      anchorNodeId: 'delivery',
      title: '经验复盘沉淀',
      subtitle: '待开始',
      status: 'pending',
      statusLabel: '待开始',
      summary: 'ok',
      description: 'desc',
      durationMs: null,
    },
  );
  graph.edges = [
    { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true },
    { id: 'e2', from: 'generation', to: 'evaluation', kind: 'sequence', completed: true },
    { id: 'e3', from: 'evaluation', to: 'quality-gate', kind: 'sequence' },
    { id: 'e4', from: 'quality-gate', to: 'delivery', kind: 'pass', label: '质量达标' },
    { id: 'e5', from: 'quality-gate', to: 'optimization', kind: 'fail', label: '未达标 · 进入修复' },
    { id: 'e6', from: 'optimization', to: 'evaluation', kind: 'loop', label: '修复后复评' },
    { id: 'e7', from: 'evaluation', to: 'followup', kind: 'branch', label: '异常自动跟进' },
    { id: 'e8', from: 'delivery', to: 'learning', kind: 'branch', label: '结束后复盘' },
  ];

  const layout = computeWorkflowLayout(graph);
  const nodeRects: LayoutRect[] = layout.nodes.map((n) => ({
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  }));
  const labelRects = layout.edges
    .map((e) => ({ id: e.edge.id, rect: estimateEdgeLabelBox(e) }))
    .filter((x): x is { id: string; rect: LayoutRect } => Boolean(x.rect));

  assert.equal(labelRects.length, 5);

  // 1. No two nodes overlap
  for (let i = 0; i < nodeRects.length; i++) {
    for (let j = i + 1; j < nodeRects.length; j++) {
      assert.equal(rectsOverlap(nodeRects[i], nodeRects[j], 0), false, `nodes ${i} and ${j} must not overlap`);
    }
    assert.ok(nodeRects[i].x >= 0 && nodeRects[i].x + nodeRects[i].width <= layout.width);
    assert.ok(nodeRects[i].y >= 0 && nodeRects[i].y + nodeRects[i].height <= layout.height);
  }

  // 2. No edge label overlaps any node
  for (const lbl of labelRects) {
    for (let i = 0; i < nodeRects.length; i++) {
      assert.equal(
        rectsOverlap(lbl.rect, nodeRects[i], 2),
        false,
        `label ${lbl.id} overlaps node ${layout.nodes[i].node.id}`,
      );
    }
    assert.ok(lbl.rect.x >= 0 && lbl.rect.x + lbl.rect.width <= layout.width);
    assert.ok(lbl.rect.y >= 0 && lbl.rect.y + lbl.rect.height <= layout.height);
  }

  // 3. No two edge labels overlap each other
  for (let i = 0; i < labelRects.length; i++) {
    for (let j = i + 1; j < labelRects.length; j++) {
      assert.equal(
        rectsOverlap(labelRects[i].rect, labelRects[j].rect, 2),
        false,
        `labels ${labelRects[i].id} and ${labelRects[j].id} must not overlap`,
      );
    }
  }
});

test('adaptive maxWidth fits standard 5-node optimization workflow without horizontal scrolling or overlaps', () => {
  const graph = baseGraph();
  graph.nodes = graph.nodes.filter((n) => n.id !== 'followup');
  graph.nodes.push({
    id: 'delivery',
    kind: 'delivery',
    lane: 'main',
    column: 4,
    title: '跨环境交付',
    subtitle: '等待达标',
    status: 'pending',
    statusLabel: '待开始',
    summary: 'ok',
    description: 'desc',
    durationMs: null,
  });
  graph.edges = [
    { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true },
    { id: 'e2', from: 'generation', to: 'evaluation', kind: 'sequence', completed: true },
    { id: 'e3', from: 'evaluation', to: 'quality-gate', kind: 'sequence' },
    { id: 'e4', from: 'quality-gate', to: 'delivery', kind: 'pass', label: '质量达标' },
    { id: 'e5', from: 'quality-gate', to: 'optimization', kind: 'fail', label: '未达标 · 进入修复' },
    { id: 'e6', from: 'optimization', to: 'evaluation', kind: 'loop', label: '修复后复评' },
  ];

  for (const maxWidth of [1080, 960]) {
    const layout = computeWorkflowLayout(graph, { maxWidth });
    assert.ok(layout.width <= maxWidth, `expected width ${layout.width} <= maxWidth ${maxWidth}`);

    const nodeRects: LayoutRect[] = layout.nodes.map((n) => ({
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
    }));
    const labelRects = layout.edges
      .map((e) => ({ id: e.edge.id, rect: estimateEdgeLabelBox(e) }))
      .filter((x): x is { id: string; rect: LayoutRect } => Boolean(x.rect));

    for (let i = 0; i < nodeRects.length; i++) {
      for (let j = i + 1; j < nodeRects.length; j++) {
        assert.equal(rectsOverlap(nodeRects[i], nodeRects[j], 0), false);
      }
    }
    for (const lbl of labelRects) {
      for (const nr of nodeRects) {
        assert.equal(rectsOverlap(lbl.rect, nr, 2), false, `at maxWidth=${maxWidth}, ${lbl.id} overlaps a node`);
      }
    }
    for (let i = 0; i < labelRects.length; i++) {
      for (let j = i + 1; j < labelRects.length; j++) {
        assert.equal(rectsOverlap(labelRects[i].rect, labelRects[j].rect, 2), false);
      }
    }
  }
});

test('compact adapted graphs (1-node evaluation, 2-node generation+followup, 3-node direct delivery) lay out cleanly', () => {
  // 1-node standalone evaluation should have symmetric horizontal padding
  const evalOnly = baseGraph();
  evalOnly.nodes = [evalOnly.nodes.find((n) => n.id === 'evaluation')!].map((n) => ({ ...n, column: 0 }));
  evalOnly.edges = [];
  const evalLayout = computeWorkflowLayout(evalOnly);
  assert.equal(evalLayout.nodes.length, 1);
  assert.equal(
    evalLayout.width - (evalLayout.nodes[0].x + evalLayout.nodes[0].width),
    evalLayout.nodes[0].x,
    'single node should have symmetric horizontal padding',
  );

  // 2-node generate-only + followup branch
  const genOnly = baseGraph();
  genOnly.nodes = genOnly.nodes
    .filter((n) => n.id === 'prepare' || n.id === 'generation' || n.id === 'followup')
    .map((n) => (n.id === 'followup' ? { ...n, column: 1, anchorNodeId: 'generation' } : n));
  genOnly.edges = [
    { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true },
    { id: 'e6', from: 'generation', to: 'followup', kind: 'branch', label: '异常自动跟进' },
  ];
  const genLayout = computeWorkflowLayout(genOnly, { maxWidth: 960 });
  assert.ok(genLayout.width <= 960);
  assert.equal(genLayout.nodes.length, 3);
  assert.equal(genLayout.edges.length, 2);
  for (const edge of genLayout.edges) {
    assert.ok(edge.path.startsWith('M '));
  }

  // 3-node direct delivery (prepare -> generation -> delivery)
  const directDelivery = baseGraph();
  directDelivery.nodes = [
    ...directDelivery.nodes.filter((n) => n.id === 'prepare' || n.id === 'generation'),
    {
      id: 'delivery',
      kind: 'delivery',
      lane: 'main',
      column: 2,
      title: '跨环境交付',
      subtitle: '交付完成',
      status: 'completed',
      statusLabel: '已完成',
      summary: 'ok',
      description: 'desc',
      durationMs: 1000,
    },
  ];
  directDelivery.edges = [
    { id: 'e1', from: 'prepare', to: 'generation', kind: 'sequence', completed: true },
    { id: 'e2', from: 'generation', to: 'delivery', kind: 'sequence', completed: true },
  ];
  const directLayout = computeWorkflowLayout(directDelivery, { maxWidth: 960 });
  assert.ok(directLayout.width <= 960);
  assert.equal(directLayout.nodes.length, 3);
  for (let i = 1; i < directLayout.nodes.length; i++) {
    assert.ok(directLayout.nodes[i].x > directLayout.nodes[i - 1].x + directLayout.nodes[i - 1].width);
  }
});
