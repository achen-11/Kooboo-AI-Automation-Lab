import type {
  TaskWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from '../../../shared/workflow-graph.js';

export interface PositionedWorkflowNode {
  node: WorkflowNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedWorkflowEdge {
  edge: WorkflowEdge;
  path: string;
  labelX: number;
  labelY: number;
}

export interface WorkflowLayoutResult {
  width: number;
  height: number;
  nodes: PositionedWorkflowNode[];
  edges: PositionedWorkflowEdge[];
}

export interface WorkflowLayoutOptions {
  maxWidth?: number;
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WORKFLOW_LAYOUT = {
  NODE_W: 220,
  MIN_NODE_W: 150,
  GATE_W: 220,
  NODE_H: 122,
  COL_GAP: 92,
  MIN_COL_GAP: 28,
  ROW_GAP: 96,
  BRANCH_GAP: 24,
  PAD_X: 28,
  PAD_Y: 28,
  ARROW_CLEARANCE: 3,
} as const;

export function defaultSelectedNodeId(graph: TaskWorkflowGraph): string | null {
  if (graph.blocker?.nodeId && graph.nodes.some((n) => n.id === graph.blocker!.nodeId)) {
    return graph.blocker.nodeId;
  }
  if (graph.currentNodeId && graph.nodes.some((n) => n.id === graph.currentNodeId)) {
    return graph.currentNodeId;
  }
  const completedMain = [...graph.nodes]
    .filter((n) => n.lane === 'main' && n.status === 'completed')
    .pop();
  if (completedMain) return completedMain.id;
  return graph.nodes[0]?.id ?? null;
}

export function estimateEdgeLabelWidth(label: string): number {
  const text = label.trim();
  if (!text) return 0;
  let units = 0;
  for (const ch of text) {
    units += /[\u4e00-\u9fff]/.test(ch) ? 11 : 6.5;
  }
  return Math.max(48, Math.ceil(units) + 16);
}

export function estimateEdgeLabelBox(edge: PositionedWorkflowEdge): LayoutRect | null {
  const label = edge.edge.label?.trim();
  if (!label) return null;
  const width = estimateEdgeLabelWidth(label);
  const height = 22;
  return {
    x: edge.labelX - width / 2,
    y: edge.labelY - height / 2,
    width,
    height,
  };
}

export function rectsOverlap(a: LayoutRect, b: LayoutRect, margin = 0): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

function buildEdgePath(
  edge: WorkflowEdge,
  byId: Map<string, PositionedWorkflowNode>,
  bottomPorts: Map<string, number>,
  corridorY: number,
): PositionedWorkflowEdge | null {
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (!from || !to) return null;

  const clearance = WORKFLOW_LAYOUT.ARROW_CLEARANCE;

  if (edge.kind === 'sequence' || edge.kind === 'pass') {
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x - clearance;
    const y2 = to.y + to.height / 2;
    const dx = Math.max(14, (x2 - x1) * 0.45);
    const path =
      Math.abs(y1 - y2) < 1
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    return {
      edge,
      path,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2,
    };
  }

  if (edge.kind === 'fail') {
    const fromPort = bottomPorts.get(`${edge.id}:from`) ?? 0.5;
    const x1 = from.x + from.width * fromPort;
    const y1 = from.y + from.height;
    const toRight = to.x + to.width;
    if (x1 > toRight + 14) {
      const x2 = toRight + clearance;
      const y2 = to.y + to.height / 2;
      const path = `M ${x1} ${y1} C ${x1} ${y2}, ${x1} ${y2}, ${x2} ${y2}`;
      return {
        edge,
        path,
        labelX: x1,
        labelY: corridorY,
      };
    }
    const x2 = to.x + to.width * 0.65;
    const y2 = to.y - clearance;
    return {
      edge,
      path: `M ${x1} ${y1} C ${x1} ${corridorY}, ${x2} ${corridorY}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: corridorY,
    };
  }

  if (edge.kind === 'loop') {
    const toPort = bottomPorts.get(`${edge.id}:to`) ?? 0.5;
    const x2 = to.x + to.width * toPort;
    const y2 = to.y + to.height + clearance;
    if (from.x >= x2 + 14) {
      const x1 = from.x;
      const y1 = from.y + from.height / 2;
      const path = `M ${x1} ${y1} C ${x2} ${y1}, ${x2} ${y1}, ${x2} ${y2}`;
      return {
        edge,
        path,
        labelX: x2,
        labelY: corridorY,
      };
    }
    const x1 = from.x + from.width * 0.35;
    const y1 = from.y;
    return {
      edge,
      path: `M ${x1} ${y1} C ${x1} ${corridorY}, ${x2} ${corridorY}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: corridorY,
    };
  }

  const fromPort = bottomPorts.get(`${edge.id}:from`) ?? 0.5;
  const x1 = from.x + from.width * fromPort;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y - clearance;
  return {
    edge,
    path: `M ${x1} ${y1} C ${x1} ${corridorY}, ${x2} ${corridorY}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: corridorY,
  };
}

export function computeWorkflowLayout(
  graph: TaskWorkflowGraph,
  options?: WorkflowLayoutOptions,
): WorkflowLayoutResult {
  const { NODE_W, MIN_NODE_W, NODE_H, COL_GAP, MIN_COL_GAP, ROW_GAP, BRANCH_GAP, PAD_Y } =
    WORKFLOW_LAYOUT;

  const mainNodes = graph.nodes
    .filter((n) => n.lane === 'main')
    .sort((a, b) => a.column - b.column);
  const branchNodes = graph.nodes.filter((n) => n.lane === 'branch');
  const mainCount = Math.max(1, mainNodes.length);

  // Measure horizontal edge label widths between adjacent main nodes
  const gapLabelWidths: number[] = [];
  for (let i = 1; i < mainNodes.length; i++) {
    const prev = mainNodes[i - 1];
    const curr = mainNodes[i];
    const connecting = graph.edges.find(
      (e) => (e.kind === 'sequence' || e.kind === 'pass') && e.from === prev.id && e.to === curr.id,
    );
    gapLabelWidths.push(connecting?.label ? estimateEdgeLabelWidth(connecting.label) : 0);
  }

  // Adaptive sizing when container maxWidth is provided
  const maxWidth =
    options?.maxWidth && Number.isFinite(options.maxWidth) && options.maxWidth > 0
      ? options.maxWidth
      : undefined;

  let padX: number = WORKFLOW_LAYOUT.PAD_X;
  let colGap: number = COL_GAP;
  let nodeW: number = NODE_W;
  let gapWidths: number[] = [];

  const computeGaps = (baseGap: number) =>
    gapLabelWidths.map((lw) => (lw > 0 ? Math.max(baseGap, lw + 16, 74) : baseGap));

  if (maxWidth) {
    padX = maxWidth < 1020 ? 14 : maxWidth < 1200 ? 20 : 28;
    const targetGap = Math.max(
      MIN_COL_GAP,
      Math.min(COL_GAP, Math.floor((maxWidth - 2 * padX) * 0.05)),
    );
    colGap = targetGap;
    gapWidths = computeGaps(colGap);
    let totalGaps = gapWidths.reduce((sum, g) => sum + g, 0);

    // Tighten regular column gaps first so main nodes stay comfortable without horizontal scroll
    if (maxWidth - 2 * padX - totalGaps < mainCount * MIN_NODE_W && colGap > MIN_COL_GAP) {
      const unlabeledCount = gapLabelWidths.filter((lw) => lw === 0).length;
      const labeledSum = gapWidths.reduce((s, g, idx) => s + (gapLabelWidths[idx] > 0 ? g : 0), 0);
      if (unlabeledCount > 0) {
        const room = maxWidth - 2 * padX - labeledSum - mainCount * MIN_NODE_W;
        colGap = Math.max(MIN_COL_GAP, Math.min(colGap, Math.floor(room / unlabeledCount)));
        gapWidths = computeGaps(colGap);
        totalGaps = gapWidths.reduce((sum, g) => sum + g, 0);
      }
    }

    const availableForNodes = maxWidth - 2 * padX - totalGaps;
    nodeW = Math.max(MIN_NODE_W, Math.min(NODE_W, Math.floor(availableForNodes / mainCount)));
  } else {
    gapWidths = computeGaps(colGap);
  }

  const positioned: PositionedWorkflowNode[] = [];
  const byId = new Map<string, PositionedWorkflowNode>();

  let cursorX = padX;
  const mainColX = new Map<number, number>();
  mainNodes.forEach((node, index) => {
    if (index > 0) {
      cursorX += nodeW + gapWidths[index - 1];
    }
    const item: PositionedWorkflowNode = {
      node,
      x: cursorX,
      y: PAD_Y,
      width: nodeW,
      height: NODE_H,
    };
    positioned.push(item);
    byId.set(node.id, item);
    mainColX.set(node.column, cursorX);
  });

  const mainBottom = PAD_Y + NODE_H;
  const branchY = mainBottom + ROW_GAP;
  const corridorY = mainBottom + ROW_GAP * 0.48;

  const branchDraft = branchNodes.map((node) => {
    let desiredX = mainColX.get(node.column) ?? padX;

    if (node.kind === 'optimization') {
      const evalPos = byId.get('evaluation');
      const gatePos = byId.get('quality-gate');
      if (evalPos && gatePos) {
        desiredX = (evalPos.x + gatePos.x + gatePos.width) / 2 - nodeW / 2;
      } else if (evalPos) {
        desiredX = evalPos.x + evalPos.width / 2 - nodeW / 2;
      }
    } else if (node.anchorNodeId && byId.has(node.anchorNodeId)) {
      const anchor = byId.get(node.anchorNodeId)!;
      desiredX = anchor.x + anchor.width / 2 - nodeW / 2;
    }

    return {
      node,
      x: Math.max(padX, desiredX),
      y: branchY,
      width: nodeW,
      height: NODE_H,
    };
  });

  branchDraft.sort((a, b) => a.x - b.x || a.node.id.localeCompare(b.node.id));
  for (let i = 1; i < branchDraft.length; i++) {
    const prev = branchDraft[i - 1];
    const curr = branchDraft[i];
    const minX = prev.x + prev.width + BRANCH_GAP;
    if (curr.x < minX) {
      curr.x = minX;
    }
  }

  for (const item of branchDraft) {
    positioned.push(item);
    byId.set(item.node.id, item);
  }

  const bottomAttachments = new Map<string, { edgeKey: string; otherCenterX: number }[]>();
  const registerBottom = (mainId: string, edgeKey: string, otherId: string) => {
    const other = byId.get(otherId);
    const main = byId.get(mainId);
    if (!other || !main || main.node.lane !== 'main') return;
    const list = bottomAttachments.get(mainId) || [];
    list.push({ edgeKey, otherCenterX: other.x + other.width / 2 });
    bottomAttachments.set(mainId, list);
  };

  for (const edge of graph.edges) {
    if (edge.kind === 'fail' || edge.kind === 'branch') {
      registerBottom(edge.from, `${edge.id}:from`, edge.to);
    } else if (edge.kind === 'loop') {
      registerBottom(edge.to, `${edge.id}:to`, edge.from);
    }
  }

  const bottomPorts = new Map<string, number>();
  for (const list of bottomAttachments.values()) {
    list.sort((a, b) => a.otherCenterX - b.otherCenterX || a.edgeKey.localeCompare(b.edgeKey));
    const n = list.length;
    list.forEach((item, idx) => {
      const ratio = n === 1 ? 0.5 : 0.28 + (idx / (n - 1)) * 0.44;
      bottomPorts.set(item.edgeKey, ratio);
    });
  }

  const edges: PositionedWorkflowEdge[] = [];
  for (const edge of graph.edges) {
    const built = buildEdgePath(edge, byId, bottomPorts, corridorY);
    if (built) edges.push(built);
  }

  const nodeRects: LayoutRect[] = positioned.map((p) => ({
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
  }));

  const labeledEdges = edges
    .filter((e) => Boolean(e.edge.label?.trim()))
    .sort((a, b) => a.labelX - b.labelX || a.edge.id.localeCompare(b.edge.id));

  for (const item of labeledEdges) {
    const box = estimateEdgeLabelBox(item);
    if (!box) continue;
    if (box.x < padX) {
      item.labelX = padX + box.width / 2;
    }
    const margin = item.edge.kind === 'sequence' || item.edge.kind === 'pass' ? 3 : 6;
    const updatedBox = estimateEdgeLabelBox(item)!;
    if (nodeRects.some((nr) => rectsOverlap(updatedBox, nr, margin))) {
      item.labelY = corridorY;
    }
  }

  const placedBoxes: LayoutRect[] = [];
  const candidateYOffsets = [0, -18, 18, -30, 30];
  for (const item of labeledEdges) {
    const baseY = item.labelY;
    const margin = item.edge.kind === 'sequence' || item.edge.kind === 'pass' ? 3 : 6;
    for (const dy of candidateYOffsets) {
      item.labelY = baseY + dy;
      const candidate = estimateEdgeLabelBox(item)!;
      const hitsNode = nodeRects.some((nr) => rectsOverlap(candidate, nr, margin));
      const hitsLabel = placedBoxes.some((pb) => rectsOverlap(candidate, pb, 5));
      if (!hitsNode && !hitsLabel) break;
    }
    let finalBox = estimateEdgeLabelBox(item)!;
    let safety = 0;
    while (
      safety++ < 12 &&
      (placedBoxes.some((pb) => rectsOverlap(finalBox, pb, 5)) ||
        nodeRects.some((nr) => rectsOverlap(finalBox, nr, margin)))
    ) {
      item.labelX += 20;
      finalBox = estimateEdgeLabelBox(item)!;
    }
    placedBoxes.push(finalBox);
  }

  const maxNodeRight = positioned.length
    ? positioned.reduce((max, item) => Math.max(max, item.x + item.width), 0)
    : 320;
  const maxLabelRight = placedBoxes.reduce((max, b) => Math.max(max, b.x + b.width), 0);
  const maxNodeBottom = positioned.reduce(
    (max, item) => Math.max(max, item.y + item.height),
    PAD_Y + NODE_H,
  );
  const maxLabelBottom = placedBoxes.reduce((max, b) => Math.max(max, b.y + b.height), 0);

  return {
    width: Math.ceil(Math.max(maxNodeRight, maxLabelRight) + padX),
    height: Math.ceil(Math.max(maxNodeBottom, maxLabelBottom) + PAD_Y),
    nodes: positioned,
    edges,
  };
}
