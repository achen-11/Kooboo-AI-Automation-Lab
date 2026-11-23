<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Check,
  CircleAlert,
  Clock3,
  GitBranch,
  LoaderCircle,
  Minus,
  Play,
  RefreshCw,
  Upload,
} from '@lucide/vue';
import { diagnosticCategoryLabels } from '../../../../shared/human-diagnostics';
import type { TaskRecoveryAction, TaskRecoveryTarget, TaskTab } from '../../../../shared/task-presentation';
import { formatDuration } from '../../../../shared/timing';
import type {
  TaskWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeStatus,
} from '../../../../shared/workflow-graph';
import { formatDate, message, platform, sessionFetch } from '../../api';
import { isRouteMissing } from '../../lib/template-workflow-client';
import {
  computeWorkflowLayout,
  defaultSelectedNodeId,
} from '../../lib/workflow-graph-layout';

const props = defineProps<{
  taskId: string;
  revision: string;
  createdAt: number;
  busy?: boolean;
  canSupplement?: boolean;
  workflowActive?: boolean;
  recoveryTask?: TaskRecoveryTarget;
}>();

const emit = defineEmits<{
  selectTab: [tab: TaskTab];
  openBaseline: [target: { pagePath: string; viewId?: string }];
  openSupplement: [];
  action: [action: TaskRecoveryAction, taskId?: string];
  unavailable: [];
}>();

const graph = shallowRef<TaskWorkflowGraph | null>(null);
const loading = ref(false);
const error = ref('');
const unsupported = ref(false);
const selectedId = ref<string | null>(null);
const canvasHost = ref<HTMLDivElement>();
const canvasWidth = ref(0);
const isMobile = ref(false);

let controller: AbortController | undefined;
let seq = 0;
let pendingRefresh = false;
let mediaQuery: MediaQueryList | undefined;

function syncViewportMode() {
  isMobile.value = Boolean(mediaQuery?.matches);
}

function onVisibilityChange() {
  if (typeof document !== 'undefined' && !document.hidden && pendingRefresh) {
    pendingRefresh = false;
    void loadWorkflow();
  }
}

watch(canvasHost, (el, _prev, onCleanup) => {
  if (!el) return;
  const measure = () => {
    const next = Math.floor(el.clientWidth);
    if (next > 0 && Math.abs(next - canvasWidth.value) >= 4) {
      canvasWidth.value = next;
    }
  };
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  }
});

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(max-width: 760px)');
    syncViewportMode();
    mediaQuery.addEventListener?.('change', syncViewportMode);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
});

async function loadWorkflow(force = false) {
  if (!force && typeof document !== 'undefined' && document.hidden) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  const currentSeq = ++seq;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = '';
  try {
    const response = await sessionFetch(`/api/automation/tasks/${props.taskId}/workflow`, {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (currentSeq !== seq) return;
    let body: Record<string, unknown> | null = null;
    try {
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        body = (await response.json()) as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    if (currentSeq !== seq) return;
    if (response.status === 401) {
      const errText = typeof body?.error === 'string' ? body.error : '无法连接本机工作区，请重试连接';
      platform.ready = false;
      platform.online = false;
      platform.error = errText;
      throw new Error(errText);
    }
    if (isRouteMissing(response, body)) {
      unsupported.value = true;
      graph.value = null;
      emit('unavailable');
      return;
    }
    if (!response.ok) {
      throw new Error(typeof body?.error === 'string' ? body.error : `请求失败：${response.status}`);
    }
    const next = body as unknown as TaskWorkflowGraph;
    unsupported.value = false;
    graph.value = next;
    if (!selectedId.value || !next.nodes.some((n) => n.id === selectedId.value)) {
      selectedId.value = defaultSelectedNodeId(next);
    }
  } catch (reason) {
    if (currentSeq === seq && !controller?.signal.aborted) {
      error.value = message(reason);
    }
  } finally {
    if (currentSeq === seq) loading.value = false;
  }
}

watch(
  () => props.taskId,
  () => {
    selectedId.value = null;
    unsupported.value = false;
  },
  { flush: 'sync' },
);

watch(
  [() => props.taskId, () => props.revision],
  () => {
    void loadWorkflow();
  },
  { immediate: true },
);

onUnmounted(() => {
  seq++;
  controller?.abort();
  mediaQuery?.removeEventListener?.('change', syncViewportMode);
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
});

const layout = computed(() =>
  graph.value
    ? computeWorkflowLayout(
        graph.value,
        canvasWidth.value > 0 ? { maxWidth: canvasWidth.value } : undefined,
      )
    : null,
);
const fitScale = computed(() => {
  if (!layout.value || canvasWidth.value <= 0 || layout.value.width <= canvasWidth.value) return 1;
  return Math.max(0.74, canvasWidth.value / layout.value.width);
});
const selectedNode = computed<WorkflowNode | null>(() => {
  if (!graph.value) return null;
  return (
    graph.value.nodes.find((n) => n.id === selectedId.value) ||
    graph.value.nodes.find((n) => n.id === defaultSelectedNodeId(graph.value!)) ||
    graph.value.nodes[0] ||
    null
  );
});

const mainNodes = computed(() =>
  (graph.value?.nodes || []).filter((n) => n.lane === 'main').sort((a, b) => a.column - b.column),
);

function branchesFor(anchorId: string): WorkflowNode[] {
  return (graph.value?.nodes || []).filter((n) => n.lane === 'branch' && n.anchorNodeId === anchorId);
}

function selectNode(id: string) {
  selectedId.value = id;
}

function focusBlocker() {
  if (!graph.value?.blocker) return;
  selectedId.value = graph.value.blocker.nodeId;
}

function onNodeKeydown(event: KeyboardEvent, index: number) {
  const ordered = layout.value?.nodes || [];
  if (!ordered.length) return;
  let nextIndex = -1;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % ordered.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ordered.length) % ordered.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = ordered.length - 1;
  if (nextIndex < 0) return;
  event.preventDefault();
  const nextId = ordered[nextIndex].node.id;
  selectedId.value = nextId;
  document.getElementById(`workflow-node-${nextId}`)?.focus();
}

const nodeStatusMap = computed(() => {
  const map = new Map<string, WorkflowNodeStatus>();
  for (const node of graph.value?.nodes || []) map.set(node.id, node.status);
  return map;
});

function edgeDimmed(edge: WorkflowEdge): boolean {
  if (edge.active || edge.completed) return false;
  const fromStatus = nodeStatusMap.value.get(edge.from);
  const toStatus = nodeStatusMap.value.get(edge.to);
  return (
    fromStatus === 'pending' ||
    fromStatus === 'skipped' ||
    toStatus === 'pending' ||
    toStatus === 'skipped'
  );
}

function edgeStrokeColor(edge: WorkflowEdge): string {
  if (edgeDimmed(edge)) return '#d5dce8';
  if (edge.kind === 'fail') return '#cc5260';
  if (edge.kind === 'loop') return '#5279e7';
  if (edge.active) return '#5279e7';
  if (edge.completed) return '#148568';
  return '#c5cfdf';
}

function edgeMarkerEnd(edge: WorkflowEdge): string {
  if (edgeDimmed(edge)) return 'url(#wf-arrow-muted)';
  if (edge.kind === 'fail') return 'url(#wf-arrow-red)';
  if (edge.kind === 'loop' || edge.active) return 'url(#wf-arrow-blue)';
  if (edge.completed) return 'url(#wf-arrow-green)';
  return 'url(#wf-arrow-muted)';
}

function blockerBadgeLabel(node: WorkflowNode): string {
  const severity = node.blocker?.severity;
  if (severity === 'waiting') return '排队等待';
  if (severity === 'warning') return '需关注';
  return '卡在这里';
}

function effectiveRecoveryAction(node: WorkflowNode): TaskRecoveryAction | null {
  const raw = node.blocker?.recoveryAction;
  if (!raw) return null;
  if (props.workflowActive && raw === 'resume') return 'force-resume';
  return raw;
}

function recoveryButtonLabel(action: TaskRecoveryAction, node: WorkflowNode): string {
  if (action === 'adjust-site-names') return '自动调整名称并继续';
  if (action === 'force-resume') return '强制中断并恢复';
  if (action === 'confirm-stopped') return '已检查并确认原执行停止';
  if (node.status === 'cancelled') return '重新启动';
  return '恢复任务';
}

function triggerRecovery(node: WorkflowNode) {
  const act = effectiveRecoveryAction(node);
  if (!act || props.busy) return;
  emit('action', act, node.blocker?.taskId || node.taskId);
}

function statusTone(status: WorkflowNodeStatus): string {
  return status;
}

function checkProgressText(node: WorkflowNode): string {
  if (!node.checks?.length) return '';
  const done = node.checks.filter((c) => c.status === 'done').length;
  return `${done}/${node.checks.length} 项`;
}
</script>

<template>
  <section v-if="!unsupported" class="panel settings-panel workflow-panel" aria-label="任务流程可视化">
    <div class="section-heading workflow-header">
      <div class="workflow-title-group">
        <h2>流程进展</h2>
        <span v-if="graph" class="workflow-overall-pill" :class="statusTone(graph.overallStatus)">
          {{ graph.overallLabel }}
        </span>
        <span v-if="graph && graph.totalRecordedMs !== null" class="workflow-duration-chip">
          已记录耗时 {{ formatDuration(graph.totalRecordedMs) }}
        </span>
      </div>
      <div class="workflow-header-right">
        <div v-if="!isMobile" class="workflow-legend" aria-hidden="true">
          <span><i class="dot completed" />已完成</span>
          <span><i class="dot running" />进行中</span>
          <span><i class="dot attention" />需处理</span>
          <span><i class="dot queued" />排队中</span>
          <span><i class="dot pending" />未开始 / 已跳过</span>
        </div>
        <span class="text-muted small-text">{{ formatDate(createdAt) }} 创建</span>
        <button
          type="button"
          class="icon-button"
          aria-label="刷新流程图"
          title="刷新流程图"
          :disabled="loading"
          @click="loadWorkflow(true)"
        >
          <RefreshCw :size="15" :class="{ spin: loading }" />
        </button>
      </div>
    </div>

    <p v-if="error" class="alert error" role="alert">
      {{ error }}
      <button type="button" class="text-action" @click="loadWorkflow(true)">重试</button>
    </p>

    <p v-if="loading && !graph" class="section-loading">
      <LoaderCircle class="spin" :size="18" />正在生成任务流程图…
    </p>

    <template v-if="graph && layout">
      <!-- Non-developer Headline & Blocker Banner -->
      <div
        class="workflow-banner"
        :class="
          graph.blocker
            ? `severity-${graph.blocker.severity}`
            : graph.overallStatus === 'completed'
              ? 'severity-good'
              : 'severity-info'
        "
        role="status"
      >
        <div class="workflow-banner-main">
          <div class="workflow-banner-headline">
            <AlertTriangle v-if="graph.blocker?.severity === 'error'" :size="16" />
            <Clock3 v-else-if="graph.blocker?.severity === 'waiting'" :size="16" />
            <CircleAlert v-else-if="graph.blocker?.severity === 'warning'" :size="16" />
            <Check v-else-if="graph.overallStatus === 'completed'" :size="16" />
            <LoaderCircle v-else-if="graph.overallStatus === 'running'" class="spin" :size="16" />
            <strong>{{ graph.headline }}</strong>
          </div>
          <p v-if="graph.blocker" class="workflow-banner-detail">
            {{ graph.blocker.explanation }}
          </p>
        </div>
        <div v-if="graph.blocker" class="workflow-banner-actions">
          <span v-if="graph.blocker.category" class="workflow-cat-tag">
            {{ diagnosticCategoryLabels[graph.blocker.category] }}
          </span>
          <button
            v-if="selectedId !== graph.blocker.nodeId"
            type="button"
            class="button small secondary"
            @click="focusBlocker"
          >
            定位卡点
          </button>
        </div>
      </div>

      <!-- Desktop Interactive Node-Link Flow Canvas -->
      <div v-if="!isMobile" ref="canvasHost" class="workflow-canvas-host">
        <div
          class="workflow-canvas-stage"
          :style="{
            width: Math.ceil(layout.width * fitScale) + 'px',
            height: Math.ceil(layout.height * fitScale) + 'px',
          }"
        >
          <div
            class="workflow-canvas"
            :style="{
              width: layout.width + 'px',
              height: layout.height + 'px',
              transform: fitScale < 1 ? `scale(${fitScale})` : undefined,
              transformOrigin: fitScale < 1 ? 'top left' : undefined,
            }"
          >
          <svg
            class="workflow-svg"
            :width="layout.width"
            :height="layout.height"
            :viewBox="`0 0 ${layout.width} ${layout.height}`"
            aria-hidden="true"
          >
            <defs>
              <marker id="wf-arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#b7c2d6" />
              </marker>
              <marker id="wf-arrow-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#148568" />
              </marker>
              <marker id="wf-arrow-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#5279e7" />
              </marker>
              <marker id="wf-arrow-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#cc5260" />
              </marker>
            </defs>
            <path
              v-for="item in layout.edges"
              :key="item.edge.id"
              :d="item.path"
              fill="none"
              :stroke="edgeStrokeColor(item.edge)"
              :stroke-width="!edgeDimmed(item.edge) && (item.edge.active || item.edge.kind === 'fail' || item.edge.kind === 'loop') ? 2.2 : 1.75"
              :stroke-dasharray="item.edge.kind === 'branch' || item.edge.kind === 'loop' || edgeDimmed(item.edge) ? '5 4' : undefined"
              :marker-end="edgeMarkerEnd(item.edge)"
            />
          </svg>

          <!-- Edge Labels -->
          <span
            v-for="item in layout.edges.filter((e) => e.edge.label)"
            :key="item.edge.id + '-label'"
            class="workflow-edge-label"
            :class="[item.edge.kind, { active: item.edge.active, dimmed: edgeDimmed(item.edge) }]"
            :style="{ left: item.labelX + 'px', top: item.labelY + 'px' }"
          >
            {{ item.edge.label }}
          </span>

          <!-- Nodes -->
          <button
            v-for="(item, index) in layout.nodes"
            :id="`workflow-node-${item.node.id}`"
            :key="item.node.id"
            type="button"
            class="workflow-node"
            :class="[
              item.node.status,
              item.node.kind,
              {
                selected: selectedNode?.id === item.node.id,
                current: item.node.isCurrent,
                blocker: item.node.isBlocker,
                branch: item.node.lane === 'branch',
              },
            ]"
            :style="{
              left: item.x + 'px',
              top: item.y + 'px',
              width: item.width + 'px',
              height: item.height + 'px',
            }"
            :aria-pressed="selectedNode?.id === item.node.id"
            :aria-label="`${item.node.title}，状态：${item.node.statusLabel}，${item.node.subtitle}`"
            @click="selectNode(item.node.id)"
            @keydown="onNodeKeydown($event, index)"
          >
            <div class="node-head">
              <span class="node-icon" :class="item.node.status">
                <Check v-if="item.node.status === 'completed'" :size="14" />
                <LoaderCircle v-else-if="item.node.status === 'running'" class="spin" :size="14" />
                <CircleAlert v-else-if="item.node.status === 'attention'" :size="14" />
                <Ban v-else-if="item.node.status === 'cancelled'" :size="14" />
                <Minus v-else-if="item.node.status === 'skipped'" :size="14" />
                <Clock3 v-else :size="14" />
              </span>
              <span class="node-title">{{ item.node.title }}</span>
            </div>

            <p class="node-subtitle">{{ item.node.subtitle }}</p>

            <div class="node-foot">
              <span
                v-if="item.node.isBlocker"
                class="node-blocker-badge"
                :class="item.node.blocker?.severity || 'error'"
              >
                {{ blockerBadgeLabel(item.node) }}
              </span>
              <span v-else class="node-status-word" :class="item.node.status">{{ item.node.statusLabel }}</span>
              <span v-if="item.node.checks?.length" class="node-check-dots" :title="checkProgressText(item.node)">
                <i
                  v-for="chk in item.node.checks"
                  :key="chk.id"
                  class="check-dot"
                  :class="chk.status"
                />
              </span>
              <span v-else-if="item.node.metrics?.length" class="node-mini-metric">
                {{ item.node.metrics[0].label }} {{ item.node.metrics[0].value }}
              </span>
              <span v-if="item.node.durationMs !== null" class="node-time">
                {{ formatDuration(item.node.durationMs) }}
              </span>
            </div>
          </button>
          </div>
        </div>
      </div>

      <!-- Mobile Vertical Stepper Layout -->
      <div v-else class="workflow-mobile-list">
        <div v-for="(node, idx) in mainNodes" :key="node.id" class="mobile-stage-group">
          <div v-if="idx > 0" class="mobile-connector" :class="{ completed: mainNodes[idx - 1].status === 'completed' }" />
          <button
            type="button"
            class="mobile-node-card"
            :class="[node.status, { selected: selectedNode?.id === node.id, blocker: node.isBlocker }]"
            @click="selectNode(node.id)"
          >
            <div class="node-head">
              <span class="node-icon" :class="node.status">
                <Check v-if="node.status === 'completed'" :size="14" />
                <LoaderCircle v-else-if="node.status === 'running'" class="spin" :size="14" />
                <CircleAlert v-else-if="node.status === 'attention'" :size="14" />
                <Minus v-else-if="node.status === 'skipped'" :size="14" />
                <Clock3 v-else :size="14" />
              </span>
              <span class="node-title">{{ node.title }}</span>
              <span v-if="node.isBlocker" class="node-blocker-inline" :class="node.blocker?.severity || 'error'">
                {{ blockerBadgeLabel(node) }}
              </span>
              <span class="node-status-word mobile-right" :class="node.status">{{ node.statusLabel }}</span>
            </div>
            <p class="node-subtitle">{{ node.subtitle }}</p>
          </button>

          <button
            v-for="branch in branchesFor(node.id)"
            :key="branch.id"
            type="button"
            class="mobile-node-card mobile-branch-card"
            :class="[branch.status, { selected: selectedNode?.id === branch.id, blocker: branch.isBlocker }]"
            @click="selectNode(branch.id)"
          >
            <div class="node-head">
              <GitBranch :size="14" class="branch-glyph" />
              <span class="node-title">{{ branch.title }}</span>
              <span class="node-status-word mobile-right" :class="branch.status">{{ branch.statusLabel }}</span>
            </div>
            <p class="node-subtitle">{{ branch.subtitle }}</p>
          </button>
        </div>
      </div>

      <!-- Optimization Rounds Trajectory Strip -->
      <div v-if="graph.rounds.length" class="workflow-rounds">
        <span class="rounds-label">优化轮次轨迹</span>
        <div class="rounds-list">
          <template v-for="(round, rIdx) in graph.rounds" :key="round.number">
            <span v-if="rIdx > 0" class="round-arrow" aria-hidden="true">→</span>
            <a
              class="round-chip"
              :class="{
                current: round.isCurrent,
                passed: round.quality === 'passed',
                failed: round.quality === 'failed',
              }"
              :href="`#/tasks/${round.evaluationTaskId || round.generationTaskId}`"
              :title="round.summary"
            >
              <strong>{{ round.label }}</strong>
              <span v-if="round.scores?.length" class="round-scores">
                {{ round.scores.map((s) => `${s.viewport === 'desktop' ? 'PC' : s.viewport === 'mobile' ? '移动' : s.viewport} ${s.value ?? '—'}`).join(' · ') }}
              </span>
              <span v-else class="round-scores">{{ round.summary }}</span>
              <span v-if="round.improved === true" class="round-improved">有改善</span>
            </a>
          </template>
        </div>
      </div>

      <!-- Node Details Inspector -->
      <div v-if="selectedNode" class="workflow-inspector" aria-live="polite">
        <div class="inspector-head">
          <div class="inspector-title-wrap">
            <h3>{{ selectedNode.title }}</h3>
            <span class="workflow-overall-pill" :class="statusTone(selectedNode.status)">
              {{ selectedNode.statusLabel }}
            </span>
            <span class="inspector-lane-tag">
              {{ selectedNode.lane === 'main' ? '主流程阶段' : '支路 / 闭环' }}
            </span>
          </div>
          <span class="text-muted small-text">
            {{ selectedNode.durationMs !== null ? `本阶段耗时 ${formatDuration(selectedNode.durationMs)}` : '暂无阶段计时记录' }}
          </span>
        </div>

        <p class="inspector-summary">{{ selectedNode.summary }}</p>
        <p class="inspector-desc">{{ selectedNode.description }}</p>

        <div v-if="selectedNode.metrics?.length" class="inspector-metrics">
          <div
            v-for="metric in selectedNode.metrics"
            :key="metric.label"
            class="inspector-metric-pill"
            :class="metric.tone || 'neutral'"
          >
            <span>{{ metric.label }}</span>
            <strong>{{ metric.value }}</strong>
          </div>
        </div>

        <ul v-if="selectedNode.checks?.length" class="inspector-checks">
          <li v-for="chk in selectedNode.checks" :key="chk.id" :class="chk.status">
            <span class="chk-icon">
              <Check v-if="chk.status === 'done'" :size="14" />
              <LoaderCircle v-else-if="chk.status === 'running'" class="spin" :size="14" />
              <CircleAlert v-else-if="chk.status === 'failed'" :size="14" />
              <Minus v-else-if="chk.status === 'skipped'" :size="14" />
              <Clock3 v-else :size="14" />
            </span>
            <div class="chk-body">
              <strong>{{ chk.label }}</strong>
              <span v-if="chk.detail">{{ chk.detail }}</span>
            </div>
          </li>
        </ul>

        <!-- Blocker Callout Inside Inspector -->
        <div v-if="selectedNode.blocker" class="inspector-blocker" :class="`severity-${selectedNode.blocker.severity}`">
          <div class="inspector-blocker-head">
            <strong>{{ selectedNode.blocker.headline }}</strong>
            <span v-if="selectedNode.blocker.category" class="workflow-cat-tag">
              {{ diagnosticCategoryLabels[selectedNode.blocker.category] }}
            </span>
          </div>
          <p>{{ selectedNode.blocker.explanation }}</p>
          <ol v-if="selectedNode.blocker.actions.length" class="inspector-blocker-steps">
            <li v-for="step in selectedNode.blocker.actions" :key="step">{{ step }}</li>
          </ol>
          <div class="inspector-actions">
            <button
              v-if="effectiveRecoveryAction(selectedNode)"
              type="button"
              class="button small"
              :class="effectiveRecoveryAction(selectedNode) === 'confirm-stopped' ? 'secondary' : 'primary'"
              :disabled="busy"
              @click="triggerRecovery(selectedNode)"
            >
              <Check v-if="effectiveRecoveryAction(selectedNode) === 'confirm-stopped'" :size="14" />
              <Play v-else :size="14" />
              {{ recoveryButtonLabel(effectiveRecoveryAction(selectedNode)!, selectedNode) }}
            </button>
            <button
              v-if="selectedNode.blocker.canSupplement && canSupplement"
              type="button"
              class="button small secondary"
              :disabled="busy"
              @click="emit('openSupplement')"
            >
              <Upload :size="14" />补充资料 / AI 收集
            </button>
          </div>
        </div>

        <div v-if="selectedNode.actions?.length" class="inspector-links">
          <template v-for="act in selectedNode.actions" :key="act.label">
            <button
              v-if="act.type === 'tab' && act.tab"
              type="button"
              class="text-action"
              @click="emit('selectTab', act.tab)"
            >
              {{ act.label }}<ArrowUpRight :size="14" />
            </button>
            <button
              v-else-if="act.type === 'baseline'"
              type="button"
              class="text-action"
              @click="emit('openBaseline', { pagePath: '/' })"
            >
              {{ act.label }}<ArrowUpRight :size="14" />
            </button>
            <a
              v-else-if="act.type === 'task' && act.taskId"
              class="text-action"
              :href="`#/tasks/${act.taskId}`"
            >
              {{ act.label }}<ArrowUpRight :size="14" />
            </a>
          </template>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.workflow-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.workflow-header {
  margin-bottom: 0;
  flex-wrap: wrap;
  gap: 12px;
}
.workflow-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.workflow-header-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.workflow-overall-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background: var(--field);
  color: var(--muted);
}
.workflow-overall-pill.completed { background: #eaf7f1; color: var(--green); }
.workflow-overall-pill.running { background: #eef3ff; color: var(--blue); }
.workflow-overall-pill.attention { background: #fff0f1; color: var(--red); }
.workflow-overall-pill.queued { background: #fff6e8; color: var(--orange); }
.workflow-overall-pill.cancelled { background: #f0f3f8; color: #64748b; }

.workflow-duration-chip {
  font-size: 12px;
  color: var(--muted);
  background: var(--field);
  padding: 3px 9px;
  border-radius: 6px;
  font-variant-numeric: tabular-nums;
}

.workflow-legend {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}
.workflow-legend > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.workflow-legend .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c5cfdf;
}
.workflow-legend .dot.completed { background: var(--green); }
.workflow-legend .dot.running { background: var(--blue); }
.workflow-legend .dot.attention { background: var(--red); }
.workflow-legend .dot.queued { background: var(--orange); }

.workflow-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid #e5ebf5;
  background: #f6f8fd;
  font-size: 13px;
  line-height: 1.65;
}
.workflow-banner.severity-good { background: #effaf5; border-color: #cdeadd; }
.workflow-banner.severity-waiting { background: #fff9f0; border-color: #f3dec0; }
.workflow-banner.severity-warning { background: #fff8ee; border-color: #f1d8b5; }
.workflow-banner.severity-error { background: #fff5f6; border-color: #f4ccd2; }
.workflow-banner-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.workflow-banner-headline {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink);
}
.workflow-banner.severity-error .workflow-banner-headline { color: #a73443; }
.workflow-banner.severity-waiting .workflow-banner-headline,
.workflow-banner.severity-warning .workflow-banner-headline { color: #8c5319; }
.workflow-banner.severity-good .workflow-banner-headline { color: #126b53; }
.workflow-banner-detail {
  color: #49566b;
  font-size: 12.5px;
}
.workflow-banner-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
}
.workflow-cat-tag {
  padding: 3px 8px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid #e3e8f2;
  font-size: 11px;
  font-weight: 600;
  color: #536078;
}

.workflow-canvas-host {
  overflow: hidden;
  display: flex;
  justify-content: center;
  border: 1px solid #e7ecf4;
  border-radius: 14px;
  background-color: #fafbfe;
  background-image: radial-gradient(#dce3f0 1px, transparent 1px);
  background-size: 18px 18px;
}
.workflow-canvas-stage {
  position: relative;
  flex: none;
}
.workflow-canvas {
  position: relative;
}
.workflow-svg {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.workflow-edge-label {
  position: absolute;
  z-index: 3;
  transform: translate(-50%, -50%);
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  background: #fff;
  border: 1px solid #dfe6f2;
  color: var(--muted);
  box-shadow: 0 1px 4px #131d2e0a;
  pointer-events: none;
}
.workflow-edge-label.fail {
  color: #a73443;
  border-color: #f4ccd2;
  background: #fff6f7;
}
.workflow-edge-label.loop,
.workflow-edge-label.active {
  color: var(--blue);
  border-color: #c9d8fb;
  background: #f2f6ff;
}
.workflow-edge-label.pass {
  color: var(--green);
  border-color: #bde6d5;
  background: #effaf5;
}
.workflow-edge-label.dimmed {
  color: #93a0b5;
  border-color: #e4eaf3;
  background: #f8fafd;
  box-shadow: none;
}

.workflow-node {
  position: absolute;
  z-index: 2;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  padding: 12px 13px;
  border-radius: 12px;
  border: 1.5px solid #dfe6f2;
  background: #fff;
  text-align: left;
  box-shadow: 0 2px 8px #131d2e08;
  transition: border-color .15s, box-shadow .15s, opacity .15s;
}
.workflow-node:hover {
  border-color: #a9bde8;
  box-shadow: 0 6px 18px #131d2e12;
  opacity: 1;
}
.workflow-node.selected {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px #5279e71f, 0 8px 20px #131d2e14;
  opacity: 1;
}
.workflow-node.completed { border-color: #bde6d5; }
.workflow-node.running { border-color: #9cb7f5; background: #fbfcff; }
.workflow-node.current.running { border-color: var(--blue); box-shadow: 0 0 0 3px #5279e71a; }
.workflow-node.attention { border-color: #eeb4bd; background: #fffafa; }
.workflow-node.queued { border-color: #efd2a6; background: #fffcf7; }
.workflow-node.pending,
.workflow-node.skipped {
  background: #f5f7fb;
  border-style: dashed;
  border-color: #d7dfec;
  box-shadow: none;
  opacity: .72;
}
.workflow-node.pending .node-title,
.workflow-node.skipped .node-title { color: #5f6c82; }
.workflow-node.pending .node-subtitle,
.workflow-node.skipped .node-subtitle { color: #8793a8; }
.workflow-node.branch { background: #fdfeff; }
.workflow-node.branch.pending,
.workflow-node.branch.skipped { background: #f5f7fb; }

.node-blocker-badge {
  flex: none;
  white-space: nowrap;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1.3;
  color: #fff;
  background: var(--red);
}
.node-blocker-badge.waiting,
.node-blocker-badge.warning {
  background: var(--orange);
}

.node-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
}
.node-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  background: var(--field);
  color: var(--muted);
}
.node-icon.completed { background: #eaf7f1; color: var(--green); }
.node-icon.running { background: #eaf0ff; color: var(--blue); }
.node-icon.attention { background: #ffecef; color: var(--red); }
.node-icon.queued { background: #fff3e0; color: var(--orange); }

.node-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-subtitle {
  font-size: 12px;
  color: #556277;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
.node-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--muted);
}
.node-status-word {
  flex: none;
  white-space: nowrap;
  font-weight: 600;
}
.node-status-word.completed { color: var(--green); }
.node-status-word.running { color: var(--blue); }
.node-status-word.attention { color: var(--red); }
.node-status-word.queued { color: var(--orange); }

.node-check-dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  margin-left: 2px;
}
.check-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d3dbe9;
}
.check-dot.done { background: var(--green); }
.check-dot.running { background: var(--blue); }
.check-dot.failed { background: var(--red); }

.node-mini-metric {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-time {
  flex: none;
  white-space: nowrap;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.workflow-mobile-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.mobile-stage-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mobile-connector {
  width: 2px;
  height: 16px;
  margin-left: 22px;
  background: #d9e1ef;
}
.mobile-connector.completed {
  background: #8fd2b8;
}
.mobile-node-card {
  width: 100%;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1.5px solid #dfe6f2;
  background: #fff;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mobile-node-card.selected {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px #5279e71a;
}
.mobile-node-card.attention { border-color: #eeb4bd; background: #fffafa; }
.mobile-node-card.pending,
.mobile-node-card.skipped { background: #f5f7fb; border-style: dashed; border-color: #d7dfec; opacity: .74; }
.mobile-node-card.pending.selected,
.mobile-node-card.skipped.selected { opacity: 1; }
.mobile-branch-card {
  margin-left: 22px;
  width: calc(100% - 22px);
  border-style: dashed;
}
.branch-glyph {
  color: var(--blue);
  flex: none;
}
.node-blocker-inline {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  color: #fff;
  background: var(--red);
}
.node-blocker-inline.waiting,
.node-blocker-inline.warning {
  background: var(--orange);
}
.mobile-right {
  margin-left: auto;
  font-size: 11px;
}

.workflow-rounds {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--field);
}
.rounds-label {
  font-size: 12px;
  font-weight: 650;
  color: #465368;
  white-space: nowrap;
}
.rounds-list {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.round-arrow {
  color: var(--muted);
  font-size: 12px;
}
.round-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid #dde4f0;
  background: #fff;
  font-size: 12px;
}
.round-chip:hover {
  border-color: var(--blue);
}
.round-chip.current {
  border-color: var(--blue);
  background: #f4f7ff;
}
.round-chip.passed {
  border-color: #bde6d5;
}
.round-chip.failed {
  border-color: #f1d4b5;
}
.round-scores {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.round-improved {
  padding: 1px 6px;
  border-radius: 4px;
  background: #eaf7f1;
  color: var(--green);
  font-size: 11px;
  font-weight: 600;
}

.workflow-inspector {
  padding: 16px 18px;
  border-radius: 12px;
  border: 1px solid #e5ebf5;
  background: #fcfdff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.inspector-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.inspector-title-wrap h3 {
  font-size: 15px;
  font-weight: 650;
}
.inspector-lane-tag {
  font-size: 11px;
  color: var(--muted);
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--field);
}
.inspector-summary {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--ink);
  line-height: 1.65;
}
.inspector-desc {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}
.inspector-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.inspector-metric-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 11px;
  border-radius: 8px;
  background: var(--field);
  font-size: 12px;
}
.inspector-metric-pill span { color: var(--muted); }
.inspector-metric-pill strong { font-weight: 650; font-variant-numeric: tabular-nums; }
.inspector-metric-pill.good { background: #eaf7f1; color: var(--green); }
.inspector-metric-pill.warn { background: #fff6e8; color: var(--orange); }
.inspector-metric-pill.bad { background: #fff0f1; color: var(--red); }

.inspector-checks {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.inspector-checks li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 11px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #e9eef6;
  font-size: 12.5px;
}
.chk-icon {
  margin-top: 2px;
  color: var(--muted);
  flex: none;
}
.inspector-checks li.done .chk-icon { color: var(--green); }
.inspector-checks li.running .chk-icon { color: var(--blue); }
.inspector-checks li.failed .chk-icon { color: var(--red); }
.chk-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chk-body strong { font-weight: 600; color: var(--ink); }
.chk-body span { font-size: 11.5px; color: var(--muted); }

.inspector-blocker {
  padding: 13px 15px;
  border-radius: 10px;
  background: #fff5f6;
  border: 1px solid #f4ccd2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.inspector-blocker.severity-waiting,
.inspector-blocker.severity-warning {
  background: #fff9f0;
  border-color: #f3dec0;
}
.inspector-blocker-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.inspector-blocker-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.6;
}
.inspector-actions,
.inspector-links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 18px;
}
</style>
