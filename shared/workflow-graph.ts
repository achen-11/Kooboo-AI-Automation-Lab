import type { Scenario, Scope, TaskStatus } from './automation.js';
import type { DiagnosticCategory } from './human-diagnostics.js';
import type { QueueWaitCode } from './queue-diagnostics.js';
import type { TaskRecoveryAction, TaskTab } from './task-presentation.js';

export type WorkflowNodeStatus =
  | 'completed'
  | 'running'
  | 'queued'
  | 'attention'
  | 'cancelled'
  | 'skipped'
  | 'pending';

export type WorkflowNodeKind =
  | 'collection'
  | 'template-analysis'
  | 'prepare'
  | 'generation'
  | 'followup'
  | 'evaluation'
  | 'quality-gate'
  | 'optimization'
  | 'delivery'
  | 'learning';

export type WorkflowLane = 'main' | 'branch';
export type WorkflowEdgeKind = 'sequence' | 'branch' | 'pass' | 'fail' | 'loop';

export const workflowNodeStatusLabels: Record<WorkflowNodeStatus, string> = {
  completed: '已完成',
  running: '进行中',
  queued: '排队中',
  attention: '需处理',
  cancelled: '已取消',
  skipped: '未触发',
  pending: '待开始',
};

export interface WorkflowStepCheck {
  id: string;
  label: string;
  status: 'done' | 'running' | 'failed' | 'pending' | 'skipped';
  detail?: string;
}

export interface WorkflowNodeMetric {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}

export interface WorkflowNodeAction {
  type: 'tab' | 'task' | 'baseline' | 'supplement' | 'recovery';
  label: string;
  tab?: TaskTab;
  taskId?: string;
  recoveryAction?: TaskRecoveryAction;
}

export interface WorkflowBlocker {
  nodeId: string;
  nodeTitle: string;
  taskId: string;
  severity: 'error' | 'warning' | 'waiting';
  category?: DiagnosticCategory;
  headline: string;
  explanation: string;
  actions: string[];
  queueCode?: QueueWaitCode;
  canSupplement?: boolean;
  recoveryAction?: TaskRecoveryAction | null;
  needsStopConfirm?: boolean;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  lane: WorkflowLane;
  column: number;
  anchorNodeId?: string;
  title: string;
  subtitle: string;
  status: WorkflowNodeStatus;
  statusLabel: string;
  summary: string;
  description: string;
  taskId?: string;
  durationMs: number | null;
  isCurrent?: boolean;
  isBlocker?: boolean;
  checks?: WorkflowStepCheck[];
  metrics?: WorkflowNodeMetric[];
  blocker?: WorkflowBlocker;
  actions?: WorkflowNodeAction[];
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind: WorkflowEdgeKind;
  active?: boolean;
  completed?: boolean;
}

export interface WorkflowRoundSummary {
  number: number;
  label: string;
  generationTaskId: string;
  generationStatus: TaskStatus;
  evaluationTaskId?: string;
  evaluationStatus?: TaskStatus;
  scores?: { viewport: string; value: number | null }[];
  quality?: 'passed' | 'failed' | 'unverified';
  improved?: boolean;
  summary: string;
  isCurrent: boolean;
}

export interface TaskWorkflowGraph {
  taskId: string;
  rootTaskId: string;
  viewingTaskId: string;
  scenario: Scenario;
  scope: Scope;
  kind: 'generation' | 'evaluation';
  overallStatus: WorkflowNodeStatus;
  overallLabel: string;
  headline: string;
  currentNodeId: string | null;
  blocker: WorkflowBlocker | null;
  targetScore: number;
  totalRecordedMs: number | null;
  timingComplete: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  rounds: WorkflowRoundSummary[];
  updatedAt: number;
}
