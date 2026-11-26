import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  effectiveReferenceUrl,
  effectiveTemplateUsageMode,
  scenarios,
  shouldEvaluateAfterGeneration,
  taskStatusNames,
  type AutomationTask,
  type FollowupRun,
  type InputVersion,
} from '../../shared/automation.js';
import type { CollectionRun } from '../../shared/collection.js';
import {
  deriveHumanNotice,
  sanitizeHumanText,
} from '../../shared/human-diagnostics.js';
import type { QueueWaitingTask } from '../../shared/queue-diagnostics.js';
import { deliveryStatusNames } from '../../shared/site-delivery.js';
import type { TaskSupplementBatch } from '../../shared/supplement.js';
import {
  canAdjustTaskSiteNames,
  canHandoffGenerationConversation,
  taskRecoveryAction,
} from '../../shared/task-presentation.js';
import type { TemplateWorkflowResponse } from '../../shared/template-workflow.js';
import { timingStageNames, type TimingStage } from '../../shared/timing.js';
import {
  workflowNodeStatusLabels,
  type TaskWorkflowGraph,
  type WorkflowBlocker,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeAction,
  type WorkflowNodeMetric,
  type WorkflowNodeStatus,
  type WorkflowRoundSummary,
  type WorkflowStepCheck,
} from '../../shared/workflow-graph.js';
import type { Vault } from '../lib/vault.js';
import { inMaintenance } from '../updates/maintenance.js';
import { CollectionStore } from './collection/store.js';
import { diagnoseTaskQueueReason } from './queue-diagnostics.js';
import type { AutomationStore } from './store.js';
import { SupplementStore } from './supplement.js';
import { TemplateWorkflowStore } from './template-workflow-store.js';

export interface WorkflowGraphOptions {
  owns: (id: string) => boolean;
  workerReady: boolean;
  maintenance: boolean;
  now?: number;
}

interface StoreHelpers {
  collection: CollectionStore;
  template: TemplateWorkflowStore;
  supplement: SupplementStore;
}

/** Cache sub-stores per AutomationStore instance so GET /workflow never re-runs DDL or migrations. */
const storeCache = new WeakMap<AutomationStore, StoreHelpers>();

function getStoreHelpers(store: AutomationStore, directory: string): StoreHelpers {
  let cached = storeCache.get(store);
  if (!cached) {
    cached = {
      collection: new CollectionStore(store, directory),
      template: new TemplateWorkflowStore(store),
      supplement: new SupplementStore(store),
    };
    storeCache.set(store, cached);
  }
  return cached;
}

const collectionCheckLabels: Record<string, string> = {
  A1: '采集范围',
  A2: '入口发现',
  A3: '栏目与记录',
  A4: '原始采集',
  A5: '内容提取',
  A6: '素材下载',
  A7: '版本交接',
};

const collectionStatusText: Record<CollectionRun['status'], string> = {
  collecting: '正在采集中',
  reviewing: '独立复核中',
  repairing: '正在修正缺口',
  ready: '采集完成并已冻结',
  blocked: '等待外部条件',
};

const followupActionLabels: Record<string, string> = {
  repair: '安排修复',
  retry: '重试当前阶段',
  continue: '继续原会话',
  answer: '补充待输入参数',
  evaluate: '交接独立评测',
  wait: '等待执行',
  interrupt: '中断并交由人工',
  collect: '定向补采资料',
};

function cleanText(text: string | undefined | null, fallback = '', max = 220): string {
  const cleaned = sanitizeHumanText(text || '', max);
  return cleaned || fallback;
}

function resolveWorkflowRoot(viewing: AutomationTask, store: AutomationStore): AutomationTask {
  let root = store.root(viewing) || viewing;
  if (root.kind === 'generation') return root;

  // Walk parentId chain (supports multi-hop manual re-evaluations: gen -> eval1 -> eval2 -> ...)
  const visited = new Set<string>([root.id]);
  let cursor: AutomationTask | undefined = root;
  for (let hop = 0; hop < 20 && cursor?.parentId; hop++) {
    if (visited.has(cursor.parentId)) break;
    visited.add(cursor.parentId);
    const parent = store.task(cursor.parentId, false);
    if (!parent) break;
    if (parent.kind === 'generation') {
      return parent.optimizationRootId
        ? store.task(parent.optimizationRootId, false) || parent
        : parent;
    }
    cursor = parent;
  }

  // Fallback via lightweight index headers for this generated site
  if (viewing.generatedSiteId) {
    const genHeaders = store
      .headers(viewing.generatedSiteId)
      .filter((h) => h.kind === 'generation');
    const matched =
      genHeaders.find((h) => h.versionId === viewing.versionId && h.createdAt <= viewing.createdAt) ||
      genHeaders.find((h) => h.createdAt <= viewing.createdAt) ||
      genHeaders[0];
    if (matched) {
      const genTask = store.task(matched.id, false);
      if (genTask) {
        return genTask.optimizationRootId
          ? store.task(genTask.optimizationRootId, false) || genTask
          : genTask;
      }
    }
  }

  return root;
}

function stageDuration(
  stages: { stage: TimingStage; recordedMs: number }[],
  keys: TimingStage[],
): number | null {
  let sum = 0;
  let hasAny = false;
  for (const item of stages) {
    if (keys.includes(item.stage) && item.recordedMs > 0) {
      sum += item.recordedMs;
      hasAny = true;
    }
  }
  return hasAny ? sum : null;
}

function mapTaskStatus(status: AutomationTask['status']): WorkflowNodeStatus {
  if (status === 'completed') return 'completed';
  if (status === 'running' || status === 'cancelling' || status === 'following-up') return 'running';
  if (status === 'queued') return 'queued';
  if (status === 'cancelled') return 'cancelled';
  return 'attention';
}

function scoreTone(value: number | null, targetScore: number): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null || !Number.isFinite(value)) return 'neutral';
  if (value >= targetScore) return 'good';
  if (value >= 60) return 'warn';
  return 'bad';
}

function buildHumanBlocker(
  nodeId: string,
  nodeTitle: string,
  task: AutomationTask,
  opts: {
    severity?: WorkflowBlocker['severity'];
    queueReason?: QueueWaitingTask['reason'];
    supplementBatch?: TaskSupplementBatch;
    canSupplement?: boolean;
  } = {},
): WorkflowBlocker {
  if (opts.queueReason) {
    return {
      nodeId,
      nodeTitle,
      taskId: task.id,
      severity: 'waiting',
      headline: `任务正在排队等待（${nodeTitle}）`,
      explanation: cleanText(opts.queueReason.message, '任务已加入队列，等待后台调度执行。'),
      actions:
        opts.queueReason.code === 'paused'
          ? ['前往「设置」开启自动执行开关，队列将立即自动领取并继续执行。']
          : opts.queueReason.code === 'worker-unavailable'
            ? ['请检查后台执行服务是否正常运行，必要时重启服务。']
            : opts.queueReason.code === 'capacity'
              ? ['当前并发名额已满，等待正在执行的任务结束后自动开始，无需人工干预。']
              : opts.queueReason.code === 'site-busy' || opts.queueReason.code === 'optimization'
                ? ['同一站点仍有其它流程保留执行权，等待其结束后会自动推进。']
                : ['等待前置条件就绪后会自动开始执行，也可到任务中心「队列诊断」查看详情。'],
      queueCode: opts.queueReason.code,
      canSupplement: opts.canSupplement,
    };
  }

  const adjustNames = canAdjustTaskSiteNames(task);
  if (adjustNames) {
    return {
      nodeId,
      nodeTitle,
      taskId: task.id,
      severity: 'error',
      category: 'site-collision',
      headline: '目标站点名称或域名已被占用',
      explanation: '准备创建的站点名称或子域名与环境中已有站点冲突，任务已安全暂停以避免覆盖线上站点。',
      actions: ['点击「自动调整名称并继续」，系统将更换可用的站点名或子域名并继续执行。'],
      recoveryAction: taskRecoveryAction({
        id: task.id,
        status: task.status,
        stopped: task.stopped,
        kind: task.kind,
        canAdjustSiteNames: true,
      }),
      needsStopConfirm: !task.stopped,
      canSupplement: opts.canSupplement,
    };
  }

  const notice = deriveHumanNotice({
    reason: task.interruption?.reason,
    error: task.error,
    stage: task.interruption?.stage || task.stage,
    scenario: task.scenario,
    generatedSiteId: task.generatedSiteId,
    evidence: task.interruption?.evidence,
    nextSteps: task.interruption?.nextSteps,
    userSummary: task.interruption?.userSummary,
    lastAction: task.followup?.lastAction,
  });

  const extraExplanation =
    opts.supplementBatch?.status === 'collecting'
      ? '（AI 正在后台补充收集资料，请稍候查看进度）'
      : opts.supplementBatch?.status === 'ready'
        ? '（AI 已整理好补充资料，待您确认应用后即可恢复）'
        : '';

  return {
    nodeId,
    nodeTitle,
    taskId: task.id,
    severity: opts.severity || (task.status === 'pending' ? 'warning' : 'error'),
    category: notice.category,
    headline: notice.headline,
    explanation: notice.explanation + extraExplanation,
    actions: notice.userActions,
    canSupplement: opts.canSupplement,
    recoveryAction: taskRecoveryAction({
      id: task.id,
      status: task.status,
      stopped: task.stopped,
      kind: task.kind,
      canAdjustSiteNames: false,
      canHandoffConversation: canHandoffGenerationConversation(task),
    }),
    needsStopConfirm: !task.stopped && ['pending', 'interrupted'].includes(task.status),
  };
}

function stageLabel(stage?: string): string {
  if (!stage) return '当前阶段';
  if (stage in timingStageNames) return timingStageNames[stage as TimingStage];
  const map: Record<string, string> = {
    prepare: '环境与资料准备',
    generation: 'AI 生成建站',
    handoff: '交接评测',
    evaluation: '独立评测',
    delivery: '跨环境交付',
    optimization: '质量优化',
  };
  return map[stage] || '当前阶段';
}

function buildDeliveryBlocker(
  task: AutomationTask,
  delivery: NonNullable<AutomationTask['delivery']>,
  queueReason?: QueueWaitingTask['reason'],
): WorkflowBlocker {
  if (delivery.status === 'queued' && queueReason) {
    return {
      nodeId: 'delivery',
      nodeTitle: '跨环境交付',
      taskId: task.id,
      severity: 'waiting',
      headline: '交付正在排队等待执行',
      explanation: cleanText(queueReason.message, '跨环境交付已加入队列，等待当前站点或环境释放后自动开始。'),
      actions: ['等待前置限制解除后会自动开始迁移与核验，也可前往「交付」标签页查看详情。'],
      queueCode: queueReason.code,
    };
  }
  const uncertain = delivery.status === 'uncertain';
  return {
    nodeId: 'delivery',
    nodeTitle: '跨环境交付',
    taskId: task.id,
    severity: uncertain ? 'warning' : 'error',
    headline: uncertain ? '迁移已发出但结果待核查' : '跨环境交付未完成',
    explanation:
      cleanText(delivery.error) ||
      (uncertain
        ? '系统已发起迁移请求，但未收到最终回执，为避免重复覆盖目标站已暂停，需要核实目标站状态。'
        : '交付迁移或双端核验存在未通过项，源站与原有评测报告均完整保留。'),
    actions: uncertain
      ? [
          '前往「交付」标签页检查目标环境是否已生成站点，如有结果可补录目标回执。',
          '若确认原交付执行已停止，请先确认停止后再恢复核验。',
        ]
      : ['前往「交付」标签页查看失败路径与双端核验详情，必要时重新发起或恢复核验。'],
    needsStopConfirm: delivery.stopped === false && ['failed', 'uncertain'].includes(delivery.status),
  };
}

function formatGenerationChecks(
  genTask: AutomationTask,
  prepareComplete: boolean,
  isRunningGen: boolean,
  nextStage: 'evaluation' | 'delivery' | 'none',
): WorkflowStepCheck[] {
  const g = genTask.generation;
  const deliverySent = Boolean(g?.deliveryId || g?.legacySubmitted);
  const deliveryAccepted = Boolean(
    g?.deliveryState === 'accepted' ||
      g?.deliveryState === 'completed' ||
      g?.legacySubmitted ||
      genTask.status === 'completed',
  );
  const loopCompleted = Boolean(
    g?.deliveryState === 'completed' || genTask.status === 'completed' || genTask.stage === 'handoff',
  );
  const pendingInput = Boolean(g?.pending);
  const siteReady = Boolean(genTask.siteUrl && (loopCompleted || genTask.status === 'completed'));

  const failedAtGen = ['failed', 'interrupted', 'pending'].includes(genTask.status) && prepareComplete;
  const siteReadyLabel =
    nextStage === 'evaluation'
      ? '刷新站点地址并交接评测'
      : nextStage === 'delivery'
        ? '刷新站点地址并交接交付'
        : '刷新站点可访问地址';

  return [
    {
      id: 'send-delegate',
      label: '发送建站指令至 Kooboo AI',
      status: deliveryAccepted
        ? 'done'
        : failedAtGen && !deliverySent
          ? 'failed'
          : isRunningGen && !deliverySent
            ? 'running'
            : deliverySent
              ? 'running'
              : 'pending',
      detail: deliveryAccepted ? '指令已被目标会话接收' : deliverySent ? '正在确认指令接收状态' : undefined,
    },
    {
      id: 'ai-build',
      label: 'Kooboo AI 执行建站循环',
      status: loopCompleted
        ? 'done'
        : pendingInput || (failedAtGen && deliverySent)
          ? 'failed'
          : isRunningGen && deliveryAccepted
            ? 'running'
            : 'pending',
      detail: pendingInput
        ? 'AI 停下来等待人工确认或补充输入'
        : loopCompleted
          ? '已收到本轮建站完成回执'
          : deliveryAccepted
            ? '正在追踪 Kooboo 实时构建进度'
            : undefined,
    },
    {
      id: 'site-ready',
      label: siteReadyLabel,
      status: siteReady
        ? 'done'
        : failedAtGen && loopCompleted
          ? 'failed'
          : isRunningGen && loopCompleted
            ? 'running'
            : 'pending',
      detail: genTask.siteUrl ? '已取得可访问站点地址' : undefined,
    },
  ];
}

function formatPrepareChecks(
  genTask: AutomationTask,
  version: InputVersion | undefined,
  isRunningPrepare: boolean,
): WorkflowStepCheck[] {
  const g = genTask.generation || {};
  const needsClone =
    genTask.scenario === 'upgrade' ||
    Boolean(g.referenceTemplate || version?.referenceTemplateId);
  const filesCount = (version?.files?.length || 0) + (g.supplementalFiles?.length || 0);
  const importedCount = Object.keys(g.importedMaterials || {}).length;
  const failedHere =
    ['failed', 'interrupted', 'pending'].includes(genTask.status) &&
    (genTask.stage === 'prepare' || !g.prepared);

  const siteCreated = Boolean(genTask.generatedSiteId);
  const cloneDone = Boolean(
    g.prepared ||
      g.skipSourceTransfer ||
      (genTask.scenario === 'upgrade'
        ? g.referenceTemplate?.mode === 'direct-template'
          ? g.sourceSandbox?.complete
          : g.transferComplete
        : true) &&
        (g.referenceTemplate?.mode === 'reference-sandbox'
          ? Boolean(g.referenceTemplateSandbox)
          : true),
  );
  const uploadDone = filesCount === 0 || Boolean(g.prepared && importedCount >= filesCount);
  const manifestDone = Boolean(g.prepared);

  const checks: WorkflowStepCheck[] = [
    {
      id: 'create-site',
      label: '创建并绑定目标生成站',
      status: siteCreated
        ? 'done'
        : failedHere && !siteCreated
          ? 'failed'
          : isRunningPrepare
            ? 'running'
            : 'pending',
      detail: siteCreated
        ? g.siteName
          ? `已绑定站点 ${g.siteName}`
          : '已绑定目标站点'
        : g.createAttempted
          ? '建站请求已发出，待确认结果'
          : undefined,
    },
  ];

  if (needsClone) {
    checks.push({
      id: 'clone-source',
      label:
        g.referenceTemplate?.mode === 'direct-template'
          ? '准备模板站点与只读源站'
          : '克隆源站 / 准备参考环境',
      status: cloneDone
        ? 'done'
        : failedHere && siteCreated && !cloneDone
          ? 'failed'
          : isRunningPrepare && siteCreated
            ? 'running'
            : 'pending',
      detail: g.skipSourceTransfer
        ? '已按配置跳过原站克隆'
        : 'cloneEnvironmentFallback' in g && Boolean((g as Record<string, unknown>).cloneEnvironmentFallback)
          ? (cloneDone ? '已自动切换至备用环境完成克隆' : '已切换至备用环境继续克隆')
          : g.sourceSandbox?.complete
            ? '源站 Sandbox 已就绪'
            : g.referenceTemplateSandbox
              ? '参考模板 Sandbox 已就绪'
              : undefined,
    });
  }

  if (filesCount > 0) {
    checks.push({
      id: 'upload-materials',
      label: `同步参考资料包（${Math.min(importedCount, filesCount)}/${filesCount}）`,
      status: uploadDone
        ? 'done'
        : failedHere && siteCreated && cloneDone && !uploadDone
          ? 'failed'
          : isRunningPrepare && siteCreated && cloneDone
            ? 'running'
            : 'pending',
    });
  }

  checks.push({
    id: 'prepare-manifest',
    label: '锁定交付清单与上下文',
    status: manifestDone
      ? 'done'
      : failedHere && siteCreated && cloneDone && uploadDone
        ? 'failed'
        : isRunningPrepare && siteCreated && cloneDone && uploadDone
          ? 'running'
          : 'pending',
  });

  return checks;
}

function buildRounds(root: AutomationTask, store: AutomationStore): WorkflowRoundSummary[] {
  const opt = root.optimization;
  if (!opt?.rounds?.length) return [];
  const currentActiveId = opt.activeTaskId;
  return opt.rounds.map((round) => {
    const gen = store.task(round.generationTaskId, false);
    const evalTask = round.evaluationTaskId ? store.task(round.evaluationTaskId, false) : undefined;
    const isCurrent =
      currentActiveId === round.generationTaskId ||
      (Boolean(round.evaluationTaskId) && currentActiveId === round.evaluationTaskId) ||
      round.number === opt.rounds.at(-1)?.number;
    return {
      number: round.number,
      label: round.number === 0 ? '初始轮' : `修复第 ${round.number} 轮`,
      generationTaskId: round.generationTaskId,
      generationStatus: gen?.status || 'queued',
      ...(evalTask
        ? {
            evaluationTaskId: evalTask.id,
            evaluationStatus: evalTask.status,
            ...(evalTask.report
              ? {
                  scores: evalTask.report.scores,
                  quality: evalTask.report.quality,
                }
              : {}),
          }
        : {}),
      ...(round.progress ? { improved: round.progress.improved } : {}),
      summary: cleanText(
        round.progress?.reason ||
          evalTask?.report?.summary ||
          (evalTask
            ? `评测${taskStatusNames[evalTask.status]}`
            : gen
              ? `生成${taskStatusNames[gen.status]}`
              : '等待执行'),
        '等待本轮结果',
        120,
      ),
      isCurrent,
    };
  });
}

export function buildTaskWorkflowGraph(
  taskId: string,
  store: AutomationStore,
  vault: Vault,
  directory: string,
  options: WorkflowGraphOptions,
): TaskWorkflowGraph | null {
  const viewing = store.task(taskId, false);
  if (!viewing) return null;

  const now = options.now ?? Date.now();
  const settings = vault.automation();
  const helpers = getStoreHelpers(store, directory);
  const root = resolveWorkflowRoot(viewing, store);
  const workflowIds = [...new Set([...store.workflowIds(root), viewing.id])];
  const version = store.version(root.versionId);
  const opt = root.optimization;
  const targetScore = opt?.policy.targetScore ?? vault.get().threshold ?? 80;

  let collection: CollectionRun | undefined;
  if (root.kind === 'generation' && root.scope === 'site' && ['migration', 'upgrade'].includes(root.scenario)) {
    try {
      collection = helpers.collection.forTask(root);
    } catch {
      collection = undefined;
    }
  }

  let templateWorkflow: TemplateWorkflowResponse | undefined;
  if (root.scenario === 'site-template' && root.templateWorkflow) {
    try {
      const tw = helpers.template.response(root);
      if (tw.supported) templateWorkflow = tw;
    } catch {
      templateWorkflow = undefined;
    }
  }

  const rounds = buildRounds(root, store);
  const latestRound = opt?.rounds.at(-1);
  const firstRound = opt?.rounds[0];

  const hasGeneration = root.kind === 'generation';
  const generationTask: AutomationTask | undefined = hasGeneration
    ? (latestRound ? store.task(latestRound.generationTaskId, false) : undefined) || root
    : undefined;
  const initialGenerationTask: AutomationTask | undefined = hasGeneration
    ? (firstRound ? store.task(firstRound.generationTaskId, false) : undefined) || root
    : undefined;

  const currentReportTask = store.currentReport(root);
  const evaluationTask: AutomationTask | undefined =
    viewing.kind === 'evaluation' && !opt
      ? viewing
      : root.kind === 'evaluation'
        ? root
        : latestRound?.evaluationTaskId
          ? store.task(latestRound.evaluationTaskId, false)
          : currentReportTask?.kind === 'evaluation'
            ? currentReportTask
            : root.evaluationTaskId
              ? store.task(root.evaluationTaskId, false)
              : undefined;

  // Delivery projection aligned with /summary
  const showEvaluation = Boolean(
    evaluationTask ||
      opt ||
      templateWorkflow?.evaluation ||
      root.kind === 'evaluation' ||
      shouldEvaluateAfterGeneration(root, settings),
  );
  const showOptimization = Boolean(opt);
  const showQualityGate = showOptimization;
  const siteHeaders = root.generatedSiteId ? store.headers(root.generatedSiteId) : [];
  const siteState = root.generatedSiteId ? store.siteState(root.generatedSiteId) : undefined;
  const deliveryHeader =
    (viewing.delivery ? viewing : undefined) ||
    (root.delivery ? root : undefined) ||
    (evaluationTask?.delivery ? evaluationTask : undefined) ||
    siteHeaders.find((h) => h.delivery && (!siteState || h.siteRevision === siteState.revision)) ||
    siteHeaders.find((h) => h.delivery);
  const currentDeliveryHeader =
    deliveryHeader && (!siteState || !deliveryHeader.generatedSiteId || deliveryHeader.siteRevision === siteState.revision)
      ? deliveryHeader
      : undefined;
  const deliveryTask = currentDeliveryHeader ? store.task(currentDeliveryHeader.id, false) : undefined;
  const del = deliveryTask?.delivery;
  const envConfig = vault.get().environments.find((e) => e.id === root.environmentId);
  const envDeliveryEnabled = Boolean(envConfig?.delivery?.enabled);
  const autoDeliveryFlag = root.autoDelivery ?? evaluationTask?.autoDelivery;
  const autoDeliveryExpected = Boolean(
    envDeliveryEnabled &&
      (autoDeliveryFlag !== undefined
        ? autoDeliveryFlag
        : envConfig?.delivery?.auto),
  );
  const showDelivery = Boolean(del || autoDeliveryFlag || autoDeliveryExpected);

  // Timing & supplements
  const timing = store.timing.summary(workflowIds, now);

  const activeTask: AutomationTask =
    viewing.kind === 'evaluation' && !opt
      ? viewing
      : (opt?.activeTaskId ? store.task(opt.activeTaskId, false) : undefined) ||
        (root.kind === 'generation' && root.status === 'completed' && evaluationTask ? evaluationTask : undefined) ||
        root;

  let supplementBatches: TaskSupplementBatch[] = [];
  if (activeTask.kind === 'generation') {
    try {
      supplementBatches = helpers.supplement.list(activeTask.id);
    } catch {
      supplementBatches = [];
    }
  }
  const activeSupplementBatch = supplementBatches.find(
    (b) => b.status === 'collecting' || b.status === 'ready',
  );
  const canSupplement = Boolean(
    activeTask.kind === 'generation' &&
      activeTask.stopped &&
      ['interrupted', 'pending', 'failed', 'cancelled'].includes(activeTask.status),
  );

  // O(1) queue diagnostics only for queued activeTask or queued deliveryTask
  const queueReasonMap = new Map<string, QueueWaitingTask['reason']>();
  const diagOpts = {
    workerReady: options.workerReady,
    maintenance: options.maintenance,
    owns: options.owns,
    now,
  };
  if (activeTask.status === 'queued') {
    queueReasonMap.set(activeTask.id, diagnoseTaskQueueReason(activeTask, store, settings, diagOpts));
  }
  if (deliveryTask?.delivery?.status === 'queued') {
    queueReasonMap.set(deliveryTask.id, diagnoseTaskQueueReason(deliveryTask, store, settings, diagOpts));
  }

  const latestEventRow = store.db
    .prepare('SELECT seq, time, message FROM auto_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1')
    .get(activeTask.id) as { seq: number; time: number; message: string } | undefined;
  const latestEventText = cleanText(latestEventRow?.message);

  // Build full end-to-end skeleton nodes & edges
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let col = 0;

  // 1a. Optional scenario-specific pre-step: A-stage Collection
  if (hasGeneration && (collection || root.collectionId)) {
    const prepRef = initialGenerationTask || root;
    const cStatus: WorkflowNodeStatus = !collection
      ? root.collectionVersionId
        ? 'completed'
        : prepRef.status === 'queued'
          ? 'pending'
          : mapTaskStatus(prepRef.status)
      : collection.status === 'ready'
        ? 'completed'
        : collection.status === 'blocked'
          ? 'attention'
          : prepRef.status === 'queued'
            ? 'queued'
            : ['failed', 'interrupted', 'cancelled'].includes(prepRef.status)
              ? mapTaskStatus(prepRef.status)
              : 'running';

    const cChecks: WorkflowStepCheck[] = collection?.checks?.length
      ? collection.checks.map((c) => ({
          id: c.id,
          label: `${c.id} ${collectionCheckLabels[c.id] || c.id}`,
          status: c.status === 'verified' ? 'done' : c.status === 'failed' ? 'failed' : 'pending',
          detail: cleanText(c.reason, undefined, 90),
        }))
      : [
          {
            id: 'a-discover',
            label: '站点结构探测与抓取',
            status: cStatus === 'completed' ? 'done' : cStatus === 'running' ? 'running' : 'pending',
          },
          {
            id: 'a-verify',
            label: 'A1–A7 完整性复核并冻结版本',
            status: cStatus === 'completed' ? 'done' : 'pending',
          },
        ];

    nodes.push({
      id: 'collection',
      kind: 'collection',
      lane: 'main',
      column: col++,
      title: '原站采集',
      subtitle: collection
        ? collectionStatusText[collection.status]
        : root.collectionVersionId
          ? '已冻结来源资料'
          : '准备采集原站内容',
      status: cStatus,
      statusLabel: workflowNodeStatusLabels[cStatus],
      summary: collection?.error
        ? cleanText(collection.error, '原站采集存在需要确认的阻断。')
        : collection?.status === 'ready'
          ? '原站页面、素材与数据关系已采集完毕并锁定版本。'
          : collection?.next?.description
            ? cleanText(collection.next.description)
            : '正在对旧站页面、文章栏目和媒体资产进行静态采集与独立复核。',
      description: '全站迁移或升级前，先将原网站的页面结构、正文内容与图片素材完整采集下来并冻结，确保后续建站和评测依据同一份真实资料。',
      taskId: prepRef.id,
      durationMs: null,
      checks: cChecks,
      actions: [{ type: 'tab', label: '查看采集与输入', tab: 'overview' }],
    });
  }

  // 1b. Optional scenario-specific pre-step: Template Analysis
  if (hasGeneration && templateWorkflow) {
    const prepRef = initialGenerationTask || root;
    const baseline = templateWorkflow.baseline;
    const totalViews = baseline ? baseline.pages.reduce((sum, p) => sum + p.views.length, 0) : 0;
    const tStatus: WorkflowNodeStatus = baseline
      ? baseline.complete
        ? 'completed'
        : templateWorkflow.phase === 'analysis' &&
            ['running', 'following-up'].includes(activeTask.status)
          ? 'running'
          : 'attention'
      : templateWorkflow.phase === 'analysis'
        ? prepRef.status === 'queued'
          ? 'queued'
          : ['failed', 'interrupted', 'pending', 'cancelled'].includes(prepRef.status)
            ? mapTaskStatus(prepRef.status)
            : 'running'
        : 'pending';

    nodes.push({
      id: 'template-analysis',
      kind: 'template-analysis',
      lane: 'main',
      column: col++,
      title: '参考基线分析',
      subtitle: baseline
        ? `已冻结 v${baseline.revision} · ${baseline.pages.length} 页 / ${totalViews} 区块`
        : tStatus === 'running'
          ? '正在分析参考模板页面与区块'
          : '等待参考基线分析',
      status: tStatus,
      statusLabel: workflowNodeStatusLabels[tStatus],
      summary: baseline
        ? baseline.complete
          ? '来源参考截图与语义区块基线已冻结，生成与评测共同遵守同一标准。'
          : `基线已冻结，但存在 ${baseline.limitations.length || 1} 项来源限制需要留意。`
        : latestEventText || '拆解参考模板的页面结构、视觉留白和关键区块约束。',
      description: '针对 AI Site 模板场景，先对参考站点进行结构化拆解并冻结基线，避免建站和评测标准不一致。',
      taskId: prepRef.id,
      durationMs: null,
      actions: [
        {
          type: 'baseline',
          label: baseline ? '查看参考基线' : '查看输入与检查集',
        },
      ],
    });
  }

  // 2. Core Node 1: Prepare & 3. Core Node 2: Generation (only when generation is part of workflow)
  let prepDone = false;
  let genDone = false;
  if (hasGeneration) {
    const prepTask = initialGenerationTask || root;
    const prepGen = prepTask.generation;
    prepDone = Boolean(
      prepGen?.prepared ||
        prepGen?.deliveryId ||
        prepGen?.legacySubmitted ||
        prepTask.stage === 'generation' ||
        prepTask.stage === 'handoff' ||
        prepTask.status === 'completed' ||
        evaluationTask,
    );
    const collectionBlockingPrep = Boolean(collection && collection.status !== 'ready');
    const templateBlockingPrep = Boolean(templateWorkflow && !templateWorkflow.baseline);

    let prepStatus: WorkflowNodeStatus;
    if (prepDone) prepStatus = 'completed';
    else if (collectionBlockingPrep || templateBlockingPrep) prepStatus = 'pending';
    else if (prepTask.status === 'queued') prepStatus = 'queued';
    else if (['running', 'following-up', 'cancelling'].includes(prepTask.status)) prepStatus = 'running';
    else if (prepTask.status === 'cancelled') prepStatus = 'cancelled';
    else prepStatus = 'attention';

    const prepChecks = formatPrepareChecks(
      prepTask,
      version,
      prepStatus === 'running',
    );
    const refUrl = effectiveReferenceUrl(version, prepTask);
    const tplMode = effectiveTemplateUsageMode(version, Boolean(prepTask.generatedSiteId));
    const prepMetrics: WorkflowNodeMetric[] = [];
    if (prepTask.generation?.siteName) {
      prepMetrics.push({ label: '目标站点名', value: prepTask.generation.siteName, tone: 'neutral' });
    }
    if (tplMode) {
      prepMetrics.push({
        label: '模板模式',
        value: tplMode === 'direct-template' ? '原生模板原位适配' : '克隆到参考 Sandbox',
        tone: 'neutral',
      });
    } else if (refUrl) {
      prepMetrics.push({ label: '参考来源', value: '已配置参考站', tone: 'neutral' });
    }

    nodes.push({
      id: 'prepare',
      kind: 'prepare',
      lane: 'main',
      column: col++,
      title: '环境与资料准备',
      subtitle: prepDone
        ? '站点与资料已就绪'
        : prepStatus === 'running'
          ? '正在建站 / 同步资料'
          : prepStatus === 'queued'
            ? '排队等待开始准备'
            : prepStatus === 'attention'
              ? '准备阶段遇到阻断'
              : '等待前置步骤完成',
      status: prepStatus,
      statusLabel: workflowNodeStatusLabels[prepStatus],
      summary: prepDone
        ? '目标站点已创建并完成参考环境/资料包导入，已交付给 AI 开始建站。'
        : prepStatus === 'attention'
          ? cleanText(prepTask.interruption?.reason || prepTask.error, '准备阶段未完成，需要处理后恢复。')
          : latestEventText || '创建 Kooboo 目标站点、导入参考资料包并准备生成所需上下文。',
      description: '在 Kooboo 环境中初始化目标站点、同步源站内容或模板 Sandbox，并上传参考图片与说明资料。',
      taskId: prepTask.id,
      durationMs: stageDuration(timing.stages, ['prepare', 'planning']),
      checks: prepChecks,
      ...(prepMetrics.length ? { metrics: prepMetrics } : {}),
      actions: [
        { type: 'tab', label: '查看输入与配置', tab: 'input' },
        ...(prepStatus === 'attention' ? [{ type: 'tab' as const, label: '查看中断原因', tab: 'execution' as const }] : []),
      ],
    });

    const isMultiRound = rounds.length > 1;
    const genNodeTask = isMultiRound ? (initialGenerationTask || root) : (generationTask || root);
    genDone = Boolean(
      genNodeTask.status === 'completed' ||
        genNodeTask.stage === 'handoff' ||
        genNodeTask.generation?.deliveryState === 'completed' ||
        (isMultiRound && evaluationTask),
    );
    let genStatus: WorkflowNodeStatus;
    if (genDone) genStatus = 'completed';
    else if (!prepDone) genStatus = genNodeTask.status === 'cancelled' ? 'cancelled' : 'pending';
    else if (genNodeTask.status === 'queued') genStatus = 'queued';
    else if (['running', 'following-up', 'cancelling'].includes(genNodeTask.status)) genStatus = 'running';
    else if (genNodeTask.status === 'cancelled') genStatus = 'cancelled';
    else genStatus = 'attention';

    const genNextStage: 'evaluation' | 'delivery' | 'none' = showEvaluation
      ? 'evaluation'
      : showDelivery
        ? 'delivery'
        : 'none';
    const genChecks = formatGenerationChecks(genNodeTask, prepDone, genStatus === 'running', genNextStage);
    const genActions: WorkflowNodeAction[] = [{ type: 'tab', label: '查看执行记录', tab: 'execution' }];
    if (genNodeTask.generation?.deliveryId || genNodeTask.generation?.prepared) {
      genActions.push({ type: 'tab', label: '查看发送给 AI 的委托', tab: 'input' });
    }

    nodes.push({
      id: 'generation',
      kind: 'generation',
      lane: 'main',
      column: col++,
      title: 'AI 生成建站',
      subtitle: genDone
        ? showEvaluation
          ? '已生成站点并交接评测'
          : showDelivery
            ? '已生成站点并交接交付'
            : '已生成可访问站点'
        : genStatus === 'running'
          ? genNodeTask.generation?.deliveryState === 'accepted'
            ? 'AI 正在构建页面'
            : '正在投递建站指令'
          : genStatus === 'queued'
            ? '排队等待生成'
            : genStatus === 'attention'
              ? '生成阶段需要处理'
              : '等待准备完成后开始',
      status: genStatus,
      statusLabel: workflowNodeStatusLabels[genStatus],
      summary: genDone
        ? genNodeTask.siteUrl
          ? showEvaluation
            ? 'AI 已完成站点页面构建并刷新出可访问地址，流程进入独立评测。'
            : showDelivery
              ? 'AI 已完成站点页面构建并刷新出可访问地址，已跳过独立评测，直接进入跨环境交付。'
              : envDeliveryEnabled
                ? 'AI 已完成站点页面构建并刷新出可访问地址（未开启自动评测与自动交付，可直接使用或按需手动发起评测 / 交付）。'
                : 'AI 已完成站点页面构建并刷新出可访问地址（未开启自动评测，可直接使用或按需在右上角手动发起评测）。'
          : '生成阶段已结束。'
        : genStatus === 'attention'
          ? cleanText(genNodeTask.interruption?.reason || genNodeTask.error, 'AI 生成建站未能正常结束，需要核查。')
          : latestEventText || '由 Kooboo AI 根据资料包与参考风格构建网站页面与内容。',
      description: '将整理好的需求、参考视觉和资料包发送给 Kooboo AI 会话，追踪其完成建站并检查站点可访问性。',
      taskId: genNodeTask.id,
      durationMs: stageDuration(timing.stages, ['generation']),
      checks: genChecks,
      ...(genNodeTask.siteUrl
        ? { metrics: [{ label: '站点状态', value: '已生成可访问地址', tone: 'good' as const }] }
        : {}),
      actions: genActions,
    });
  }

  // 4. Core Node 3: Evaluation (shown when configured or executed)
  const evalNodeTask = evaluationTask;
  const isTemplateEval = Boolean(templateWorkflow);
  const tplEval = templateWorkflow?.evaluation;
  const evalReport = evalNodeTask?.report;

  let evalStatus: WorkflowNodeStatus = 'skipped';
  let evalPassed = false;
  if (showEvaluation) {
    if (evalNodeTask) {
      if (evalNodeTask.status === 'completed' && (evalReport || tplEval)) evalStatus = 'completed';
      else if (evalNodeTask.status === 'queued') evalStatus = 'queued';
      else if (['running', 'following-up', 'cancelling'].includes(evalNodeTask.status)) evalStatus = 'running';
      else if (evalNodeTask.status === 'cancelled') evalStatus = 'cancelled';
      else evalStatus = 'attention';
    } else {
      evalStatus = 'pending';
    }

    evalPassed = Boolean(
      evalStatus === 'completed' &&
        ((evalReport && evalReport.quality === 'passed') || (tplEval && tplEval.quality === 'passed')),
    );

    const evalMetrics: WorkflowNodeMetric[] = [];
    if (evalReport) {
      for (const s of evalReport.scores) {
        evalMetrics.push({
          label: s.viewport === 'desktop' ? 'PC 端' : s.viewport === 'mobile' ? '移动端' : '业务',
          value: s.value === null ? '未验证' : `${s.value} 分`,
          tone: scoreTone(s.value, targetScore),
        });
      }
      const severeCount = evalReport.issues.filter(
        (i) => i.severity === 'critical' || i.severity === 'major',
      ).length;
      evalMetrics.push({
        label: '问题清单',
        value: severeCount > 0 ? `${evalReport.issues.length} 项（${severeCount} 项重要）` : `${evalReport.issues.length} 项`,
        tone: severeCount > 0 ? 'bad' : evalReport.issues.length > 0 ? 'warn' : 'good',
      });
    } else if (tplEval) {
      const openCount = tplEval.issues.filter((i) => i.status === 'open').length;
      evalMetrics.push({
        label: '待修复项',
        value: `${openCount} 项`,
        tone: openCount > 0 ? 'warn' : 'good',
      });
    }

    const evalChecks: WorkflowStepCheck[] = [
      {
        id: 'eval-capture',
        label: 'PC / 移动端实机截图与取证',
        status:
          (evalNodeTask?.artifacts?.length || 0) > 0 || Boolean(evalReport || tplEval)
            ? 'done'
            : evalStatus === 'running'
              ? 'running'
              : evalStatus === 'attention'
                ? 'failed'
                : 'pending',
      },
      {
        id: 'eval-rules',
        label: '规则对比与问题清单输出',
        status: evalReport || tplEval
          ? 'done'
          : evalStatus === 'attention'
            ? 'failed'
            : evalStatus === 'running' && (evalNodeTask?.artifacts?.length || 0) > 0
              ? 'running'
              : 'pending',
      },
    ];
    if (evalReport?.completeness || evalReport?.migrationCheck || evalReport?.collectionTarget) {
      const completeOk =
        (!evalReport.completeness || evalReport.completeness.state === 'complete') &&
        (!evalReport.migrationCheck || evalReport.migrationCheck.state === 'complete') &&
        (!evalReport.collectionTarget || evalReport.collectionTarget.state === 'complete');
      evalChecks.push({
        id: 'eval-completeness',
        label: '全站内容与迁移完整性核验',
        status: completeOk ? 'done' : 'failed',
      });
    }

    const evalSubtitle =
      evalStatus === 'completed'
        ? evalReport
          ? evalReport.quality === 'passed'
            ? '已通过质量核验'
            : evalReport.quality === 'failed'
              ? `发现 ${evalReport.issues.length} 项待改进`
              : '存在未核验项'
          : tplEval
            ? tplEval.quality === 'passed'
              ? '区块核验通过'
              : '存在待修复区块'
            : '评测已结束'
        : evalNodeTask
          ? taskStatusNames[evalNodeTask.status]
          : genDone
            ? '待发起评测'
            : '等待建站完成后开始';

    nodes.push({
      id: 'evaluation',
      kind: 'evaluation',
      lane: 'main',
      column: col++,
      title: isTemplateEval ? '区块共享核验' : '独立评测',
      subtitle: evalSubtitle,
      status: evalStatus,
      statusLabel: workflowNodeStatusLabels[evalStatus],
      summary: evalReport
        ? cleanText(evalReport.summary, '独立评测已完成。', 140)
        : evalStatus === 'attention'
          ? cleanText(evalNodeTask?.interruption?.reason || evalNodeTask?.error, '独立评测过程发生异常，需要处理。')
          : '生成完成后由独立评测代理对目标站双端画面、内容完整性和规则逐项打分。',
      description: '由独立评审代理打开真实浏览器截图取证，对比参考站与资料清单进行打分，找出具体缺陷。',
      taskId: evalNodeTask?.id,
      durationMs: stageDuration(timing.stages, ['evaluation', 'evidence']),
      checks: evalChecks,
      ...(evalMetrics.length ? { metrics: evalMetrics } : {}),
      actions: [
        ...(evalReport || tplEval ? [{ type: 'tab' as const, label: '查看评测结果', tab: 'report' as const }] : []),
        ...(evalNodeTask && evalNodeTask.id !== viewing.id
          ? [{ type: 'task' as const, label: '打开评测任务详情', taskId: evalNodeTask.id }]
          : []),
        ...(evalStatus === 'attention' || evalStatus === 'cancelled'
          ? [{ type: 'tab' as const, label: '查看执行记录', tab: 'execution' as const }]
          : []),
      ],
    });
  }

  // 5. Core Node 4: Quality Gate (only when automatic optimization is enabled)
  const currentRoundNo = opt?.rounds.at(-1)?.number ?? 0;
  if (showQualityGate && opt) {
    const gateStatus: WorkflowNodeStatus =
      opt.state === 'completed'
        ? 'completed'
        : opt.state === 'stopped'
          ? 'attention'
          : evaluationTask && (opt.state === 'planning' || opt.state === 'repairing' || opt.state === 'waiting-evaluation')
            ? opt.rounds.length > 0 && (opt.state === 'planning' || opt.state === 'repairing')
              ? 'running'
              : evalStatus === 'running' || evalStatus === 'queued'
                ? 'pending'
                : 'running'
            : 'pending';
    const gateSubtitle =
      opt.state === 'completed'
        ? `已达标（≥ ${targetScore} 分）`
        : opt.state === 'stopped'
          ? '未达标，优化已停止'
          : `目标 ≥ ${targetScore} 分 · 第 ${currentRoundNo} 轮`;
    const gateSummary =
      opt.state === 'completed'
        ? 'PC 与移动端均达到质量目标，无严重或主要缺陷，准予放行。'
        : cleanText(opt.reason, `自动检查双端分数是否均 ≥ ${targetScore} 分、必过项通过且无严重/主要问题。`);

    const maxRoundsText = root.autonomy
      ? root.autonomy.policy.hardMaxRounds
        ? `最多 ${root.autonomy.policy.hardMaxRounds} 轮`
        : '持续至达标'
      : `最多 ${opt.policy.maxRounds} 轮`;

    nodes.push({
      id: 'quality-gate',
      kind: 'quality-gate',
      lane: 'main',
      column: col++,
      title: '质量达标判定',
      subtitle: gateSubtitle,
      status: gateStatus,
      statusLabel: workflowNodeStatusLabels[gateStatus],
      summary: gateSummary,
      description: `达标条件：PC 与移动端均 ≥ ${targetScore} 分、适用必检项全部通过、无严重/主要缺陷（${maxRoundsText}）。`,
      taskId: root.id,
      durationMs: null,
      metrics: [
        { label: '目标分数', value: `≥ ${targetScore} 分`, tone: 'neutral' },
        { label: '修复轮次', value: `${currentRoundNo} (${maxRoundsText})`, tone: 'neutral' },
      ],
      actions: [{ type: 'tab', label: '查看评测结果', tab: 'report' }],
    });
  }

  // 6. Core Node 5: Cross-environment Delivery (shown when configured or executed)
  if (showDelivery) {
    let delStatus: WorkflowNodeStatus;
    let delSubtitle: string;
    let delSummary: string;

    if (del) {
      if (del.status === 'completed') delStatus = 'completed';
      else if (del.status === 'running' || del.status === 'verifying') delStatus = 'running';
      else if (del.status === 'queued') delStatus = 'queued';
      else delStatus = 'attention';
      delSubtitle = deliveryStatusNames[del.status];
      delSummary =
        cleanText(del.error) ||
        (del.status === 'completed'
          ? (del.policy.verifyWithAi === false
              ? '目标站已迁移完成并通过 HTTP 可达性检查（已关闭 AI 视觉核验）。'
              : '目标站已迁移完成并通过双端交付核验。')
          : '正在执行跨环境迁移或双端交付核验。');
    } else if (opt?.state === 'stopped') {
      delStatus = 'skipped';
      delSubtitle = '优化未达标，未自动交付';
      delSummary = '自动优化未达标已停止，系统按安全策略未自动交付，可在「交付」页手动发起。';
    } else if (!opt && showEvaluation && evalStatus === 'completed' && !evalPassed && envConfig?.delivery?.requirePassed !== false) {
      delStatus = 'skipped';
      delSubtitle = '评测未通过，未自动交付';
      delSummary = '独立评测未通过且当前交付策略要求达标后自动迁移，可在「交付」标签页手动发起。';
    } else if (autoDeliveryFlag || autoDeliveryExpected) {
      delStatus = 'pending';
      delSubtitle = !showEvaluation ? '等待生成完成后自动交付' : '等待评测达标后自动交付';
      delSummary = !showEvaluation
        ? '生成完成后将跳过源站评测，直接迁移到目标环境。'
        : '评测达到交付标准后将自动迁移到目标环境并核验可访问性。';
    } else {
      delStatus = 'skipped';
      delSubtitle = '未开启自动交付，可手动发起';
      delSummary = !showEvaluation && genDone
        ? '站点已生成完成；如需迁移到目标环境，可在「交付」标签页直接发起跨环境交付。'
        : '当前任务未开启自动交付；确认质量满意后可在「交付」标签页手动发起跨环境迁移。';
    }

    const delChecks: WorkflowStepCheck[] = [
      {
        id: 'del-migrate',
        label: '向目标环境发起站点迁移',
        status: del?.target || del?.status === 'completed'
          ? 'done'
          : del?.status === 'running'
            ? 'running'
            : del?.status === 'uncertain' || (del?.status === 'failed' && !del.target)
              ? 'failed'
              : delStatus === 'skipped'
                ? 'skipped'
                : 'pending',
      },
      {
        id: 'del-verify',
        label: del?.policy.verifyWithAi === false ? '目标站 HTTP 可达性检查（已关闭 AI 视觉核验）' : '目标站可达性与双端视觉核验',
        status: del?.status === 'completed'
          ? 'done'
          : del?.status === 'verifying'
            ? 'running'
            : del?.status === 'failed' && Boolean(del.target)
              ? 'failed'
              : delStatus === 'skipped'
                ? 'skipped'
                : 'pending',
      },
    ];

    nodes.push({
      id: 'delivery',
      kind: 'delivery',
      lane: 'main',
      column: col++,
      title: '跨环境交付',
      subtitle: delSubtitle,
      status: delStatus,
      statusLabel: delStatus === 'skipped' ? '未开启' : workflowNodeStatusLabels[delStatus],
      summary: delSummary,
      description: '完成最终质量验收后，把站点发布到目标交付环境并对可访问性与页面呈现做一次独立核验。',
      taskId: deliveryTask?.id,
      durationMs: stageDuration(timing.stages, ['delivery']),
      checks: delChecks,
      ...(envDeliveryEnabled || del ? { actions: [{ type: 'tab' as const, label: '查看交付详情', tab: 'delivery' as const }] } : {}),
    });
  }

  // 7. Branch Node: Optimization Repair Loop (only when automatic optimization is enabled)
  if (showOptimization && opt) {
    const evalCol = nodes.find((n) => n.id === 'evaluation')?.column ?? 2;
    const activeOptChild =
      opt.activeTaskId && opt.activeTaskId !== root.id
        ? store.task(opt.activeTaskId, false)
        : undefined;
    let optLoopStatus: WorkflowNodeStatus = 'pending';
    if (opt.state === 'completed') {
      optLoopStatus = currentRoundNo > 0 ? 'completed' : 'skipped';
    } else if (opt.state === 'planning') {
      optLoopStatus =
        root.status === 'queued'
          ? 'queued'
          : ['failed', 'interrupted', 'pending', 'cancelled'].includes(root.status)
            ? mapTaskStatus(root.status)
            : 'running';
    } else if (opt.state === 'repairing') {
      optLoopStatus = activeOptChild ? mapTaskStatus(activeOptChild.status) : 'running';
    } else if (opt.state === 'waiting-evaluation') {
      optLoopStatus = currentRoundNo > 0 ? 'completed' : 'pending';
    } else if (opt.state === 'stopped') {
      optLoopStatus = 'attention';
    }

    const lastProgress = [...opt.rounds].reverse().find((r) => r.progress)?.progress;
    nodes.push({
      id: 'optimization',
      kind: 'optimization',
      lane: 'branch',
      column: evalCol,
      anchorNodeId: 'evaluation',
      title: '自动优化修复',
      subtitle:
        opt.state === 'planning'
          ? 'AI 正在制定修复方案'
          : opt.state === 'repairing'
            ? `正在执行第 ${currentRoundNo} 轮修复`
            : opt.state === 'completed'
              ? currentRoundNo > 0
                ? `共修复 ${currentRoundNo} 轮后达标`
                : '首轮即达标，无需修复'
              : opt.state === 'stopped'
                ? `已停止（共 ${currentRoundNo} 轮）`
                : '等待评测结果',
      status: optLoopStatus,
      statusLabel: optLoopStatus === 'skipped' ? '未触发' : workflowNodeStatusLabels[optLoopStatus],
      summary:
        lastProgress?.reason
          ? cleanText(lastProgress.reason)
          : cleanText(opt.reason, '根据评测问题清单与截图自动委托原站点会话做精准修复，完成后回到独立评测复验。'),
      description: '当质量判定未达标时，系统会分析截图与缺陷清单，在原站点原会话上做针对性修复，随后重新触发独立评测形成闭环。',
      taskId: activeOptChild?.id || root.id,
      durationMs: stageDuration(timing.stages, ['optimization', 'repair']),
      ...(lastProgress
        ? {
            metrics: [
              {
                label: '上轮改善',
                value: lastProgress.improved ? '有实质改善' : '改善不明显',
                tone: lastProgress.improved ? 'good' : 'warn',
              },
              { label: '已解决', value: `${lastProgress.resolved.length} 项`, tone: 'good' },
              { label: '仍存在', value: `${lastProgress.remaining.length} 项`, tone: lastProgress.remaining.length ? 'warn' : 'good' },
            ],
          }
        : {}),
      actions: [
        { type: 'tab', label: '查看优化执行记录', tab: 'execution' },
        ...(activeOptChild && activeOptChild.id !== viewing.id
          ? [{ type: 'task' as const, label: '查看当前修复任务', taskId: activeOptChild.id }]
          : []),
      ],
    });
  }

  // 8. Sequential & Loop Edges
  const mainNodes = nodes.filter((n) => n.lane === 'main').sort((a, b) => a.column - b.column);
  for (let i = 0; i < mainNodes.length - 1; i++) {
    const from = mainNodes[i];
    const to = mainNodes[i + 1];
    if (from.kind === 'quality-gate' && to.kind === 'delivery') {
      edges.push({
        id: `edge-${from.id}-${to.id}`,
        from: from.id,
        to: to.id,
        kind: 'pass',
        label: '质量达标',
        completed: from.status === 'completed' && to.status !== 'pending' && to.status !== 'skipped',
        active: to.status === 'running' || to.status === 'queued',
      });
    } else if (from.kind === 'evaluation' && to.kind === 'delivery' && envConfig?.delivery?.requirePassed !== false) {
      edges.push({
        id: `edge-${from.id}-${to.id}`,
        from: from.id,
        to: to.id,
        kind: 'pass',
        label: '评测通过',
        completed: evalPassed && to.status !== 'pending' && to.status !== 'skipped',
        active: to.status === 'running' || to.status === 'queued',
      });
    } else {
      edges.push({
        id: `edge-${from.id}-${to.id}`,
        from: from.id,
        to: to.id,
        kind: 'sequence',
        completed: from.status === 'completed',
        active:
          from.status === 'completed' &&
          ['running', 'queued', 'attention'].includes(to.status),
      });
    }
  }

  if (showOptimization && showQualityGate && showEvaluation) {
    edges.push({
      id: 'edge-gate-opt',
      from: 'quality-gate',
      to: 'optimization',
      kind: 'fail',
      label: '未达标 · 进入修复',
      active: Boolean(opt && (opt.state === 'planning' || opt.state === 'repairing')),
      completed: Boolean(opt && opt.rounds.length > 1),
    });
    edges.push({
      id: 'edge-opt-eval',
      from: 'optimization',
      to: 'evaluation',
      kind: 'loop',
      label: '修复后复评',
      active: Boolean(opt && opt.state === 'waiting-evaluation' && opt.rounds.length > 1),
      completed: Boolean(opt && opt.rounds.length > 1 && nodes.find((n) => n.id === 'evaluation')?.status === 'completed'),
    });
  }

  // 9. Optional Followup branch node (only when followup was triggered/active)
  const followupOwner =
    [activeTask, evaluationTask, generationTask, root].find(
      (t): t is AutomationTask =>
        Boolean(
          t?.followup &&
            (t.status === 'following-up' ||
              t.followup.attempts > 0 ||
              Boolean(t.followup.lastAction)) &&
            !(t.id === root.id && t.stage === 'optimization'),
        ),
    ) || undefined;

  if (followupOwner?.followup) {
    const f: FollowupRun = followupOwner.followup;
    const anchorId =
      followupOwner.kind === 'evaluation'
        ? 'evaluation'
        : followupOwner.stage === 'prepare' || !followupOwner.generation?.prepared
          ? 'prepare'
          : 'generation';
    const anchorNode = mainNodes.find((n) => n.id === anchorId) || mainNodes[0];
    const fStatus: WorkflowNodeStatus =
      followupOwner.status === 'following-up'
        ? f.state === 'waiting'
          ? 'queued'
          : 'running'
        : f.state === 'resolved'
          ? 'completed'
          : f.state === 'interrupted'
            ? 'attention'
            : 'pending';
    const actionLabel = f.lastAction ? followupActionLabels[f.lastAction.action] || '自动决策' : '分析卡点';

    nodes.push({
      id: 'followup',
      kind: 'followup',
      lane: 'branch',
      column: anchorNode?.column ?? 0,
      anchorNodeId: anchorNode?.id,
      title: 'AI 自动跟进',
      subtitle:
        fStatus === 'running'
          ? `第 ${f.attempts}/${f.policy.maxAttempts} 次 · AI 排查中`
          : fStatus === 'queued'
            ? `等待第 ${f.attempts + 1} 次跟进`
            : fStatus === 'completed'
              ? `已协助处理（${actionLabel}）`
              : `已尝试 ${f.attempts} 次，需人工接管`,
      status: fStatus,
      statusLabel: workflowNodeStatusLabels[fStatus],
      summary: f.lastAction?.userSummary
        ? `${f.lastAction.userSummary.headline}：${f.lastAction.userSummary.explanation}`
        : f.lastAction?.reason
          ? cleanText(f.lastAction.reason)
          : '当主流程出现超时、异常或等待状态时，AI 自动查证现场并决定重试、续接或交由人工处理。',
      description: '异常处理旁路：无需人工立刻介入，先由 AI 跟进员读取会话与页面状态尝试自动恢复。',
      taskId: followupOwner.id,
      durationMs: stageDuration(timing.stages, ['followup']),
      metrics: [
        { label: '尝试次数', value: `${f.attempts} / ${f.policy.maxAttempts}`, tone: 'neutral' },
        ...(f.lastAction ? [{ label: '最近决策', value: actionLabel, tone: 'neutral' as const }] : []),
      ],
      actions: [{ type: 'tab', label: '查看 AI 跟进详情', tab: 'execution' }],
    });

    if (anchorNode) {
      edges.push({
        id: `edge-${anchorNode.id}-followup`,
        from: anchorNode.id,
        to: 'followup',
        kind: 'branch',
        label: '异常自动跟进',
        active: fStatus === 'running' || fStatus === 'queued',
        completed: fStatus === 'completed',
      });
    }
  }

  // 11. Locate Blocker & Current Node
  let blocker: WorkflowBlocker | null = null;

  const findTargetNodeId = (t: AutomationTask): string => {
    if (t.id === root.id && t.optimization?.state === 'planning') return 'optimization';
    if (t.status === 'following-up' && nodes.some((n) => n.id === 'followup')) return 'followup';
    if (t.kind === 'evaluation') return 'evaluation';
    if (collection && collection.status !== 'ready' && nodes.some((n) => n.id === 'collection')) return 'collection';
    if (templateWorkflow && !templateWorkflow.baseline && nodes.some((n) => n.id === 'template-analysis')) return 'template-analysis';
    if (t.optimizationRootId && t.optimizationRound && t.optimizationRound > 0) return 'optimization';
    if (t.stage === 'prepare' || !t.generation?.prepared) return 'prepare';
    return 'generation';
  };

  if (['interrupted', 'failed', 'pending'].includes(activeTask.status)) {
    const bNodeId = findTargetNodeId(activeTask);
    const bNode = nodes.find((n) => n.id === bNodeId) || mainNodes[0];
    blocker = buildHumanBlocker(bNode.id, bNode.title, activeTask, {
      severity: activeTask.status === 'pending' ? 'warning' : 'error',
      supplementBatch: activeSupplementBatch,
      canSupplement,
    });
  } else if (collection?.status === 'blocked') {
    const cNode = nodes.find((n) => n.id === 'collection') || mainNodes[0];
    blocker = {
      nodeId: cNode.id,
      nodeTitle: cNode.title,
      taskId: root.id,
      severity: 'warning',
      category: 'source-access',
      headline: '原站采集等待外部条件',
      explanation: cleanText(collection.error, '原站采集遇到缺失素材或访问限制，需要确认处理条件。'),
      actions: ['查看上方采集检查项与原因，补充或确认接受素材缺口后恢复任务。'],
    };
  } else if (deliveryTask?.delivery && ['uncertain', 'failed'].includes(deliveryTask.delivery.status)) {
    blocker = buildDeliveryBlocker(deliveryTask, deliveryTask.delivery);
  } else if (activeTask.status === 'queued') {
    const qNodeId = findTargetNodeId(activeTask);
    const qNode = nodes.find((n) => n.id === qNodeId) || mainNodes[0];
    const qReason = queueReasonMap.get(activeTask.id);
    if (qReason && qReason.code !== 'ready') {
      blocker = buildHumanBlocker(qNode.id, qNode.title, activeTask, {
        severity: 'waiting',
        queueReason: qReason,
      });
    }
  } else if (deliveryTask?.delivery?.status === 'queued') {
    const qReason = queueReasonMap.get(deliveryTask.id);
    if (qReason && qReason.code !== 'ready') {
      blocker = buildDeliveryBlocker(deliveryTask, deliveryTask.delivery, qReason);
    }
  } else if (opt?.state === 'stopped') {
    const gateNode = nodes.find((n) => n.id === 'quality-gate') || mainNodes[mainNodes.length - 1];
    blocker = {
      nodeId: gateNode.id,
      nodeTitle: gateNode.title,
      taskId: root.id,
      severity: 'warning',
      headline: '自动优化已停止，当前未达到目标分数',
      explanation: cleanText(opt.reason, '自动修复已到达轮数上限或连续未见改善，现有站点与报告均已保留。'),
      actions: opt.nextSteps?.length
        ? opt.nextSteps.map((s) => cleanText(s)).filter(Boolean)
        : ['点击「查看评测结果」核对当前问题，也可继续手动跟进或交付。'],
    };
  } else if (activeTask.status === 'cancelled') {
    const cNodeId = findTargetNodeId(activeTask);
    const cNode = nodes.find((n) => n.id === cNodeId) || mainNodes[0];
    blocker = {
      nodeId: cNode.id,
      nodeTitle: cNode.title,
      taskId: activeTask.id,
      severity: 'warning',
      headline: `任务已在「${cNode.title}」阶段取消`,
      explanation: cleanText(activeTask.error, '任务已手动取消并安全停止，原有输入与已生成成果已保留。'),
      actions: ['如需继续执行，可点击右上角「恢复任务」重新启动。'],
      recoveryAction: taskRecoveryAction({
        id: activeTask.id,
        status: activeTask.status,
        stopped: activeTask.stopped,
        kind: activeTask.kind,
      }),
    };
  } else if (
    evaluationTask?.status === 'completed' &&
    evaluationTask.report &&
    evaluationTask.report.quality !== 'passed' &&
    !opt
  ) {
    blocker = {
      nodeId: 'evaluation',
      nodeTitle: '独立评测',
      taskId: evaluationTask.id,
      severity: 'warning',
      headline:
        evaluationTask.report.quality === 'failed'
          ? '独立评测发现待改进项'
          : '独立评测存在未核验项',
      explanation: cleanText(
        evaluationTask.report.summary,
        '当前站点尚未完全通过质量核验，可查看问题清单后决定继续生成修复或手动交付。',
      ),
      actions: [
        '前往「评测结果」查看具体得分与扣分原因。',
        '若需继续改进，可点击顶部「继续生成」或「自动优化到目标」。',
      ],
    };
  }

  if (blocker) {
    const target = nodes.find((n) => n.id === blocker!.nodeId);
    if (target) {
      target.isBlocker = true;
      target.blocker = blocker;
      if (target.status === 'completed' && blocker.severity === 'error') {
        target.status = 'attention';
        target.statusLabel = workflowNodeStatusLabels.attention;
      }
    }
  }

  const runningNode =
    nodes.find((n) => n.lane === 'branch' && n.status === 'running') ||
    mainNodes.find((n) => n.status === 'running') ||
    nodes.find((n) => n.status === 'queued');
  const currentNodeId =
    blocker?.nodeId ||
    runningNode?.id ||
    [...mainNodes].reverse().find((n) => n.status === 'completed')?.id ||
    mainNodes[0]?.id ||
    null;

  if (currentNodeId) {
    const cur = nodes.find((n) => n.id === currentNodeId);
    if (cur) cur.isCurrent = true;
  }

  let overallStatus: WorkflowNodeStatus = 'running';
  let overallLabel = '进行中';
  let headline = '任务正在推进中。';

  if (blocker?.severity === 'error') {
    overallStatus = 'attention';
    overallLabel = '卡住待处理';
    headline = `当前卡在「${blocker.nodeTitle}」：${blocker.headline}`;
  } else if (blocker?.severity === 'waiting') {
    overallStatus = 'queued';
    overallLabel = '排队等待';
    headline = `${blocker.headline} — ${blocker.explanation}`;
  } else if (runningNode) {
    overallStatus = runningNode.status;
    overallLabel = runningNode.status === 'queued' ? '排队中' : '执行中';
    headline =
      runningNode.id === 'followup'
        ? `AI 正在自动跟进「${stageLabel(followupOwner?.stage)}」遇到的异常，请稍候。`
        : `当前正在进行「${runningNode.title}」：${runningNode.subtitle}`;
  } else if (blocker?.severity === 'warning') {
    overallStatus = activeTask.status === 'cancelled' ? 'cancelled' : 'attention';
    overallLabel =
      activeTask.status === 'cancelled'
        ? '已取消'
        : blocker.nodeId === 'evaluation' && evaluationTask?.status === 'completed'
          ? '待改进'
          : '待确认';
    headline = `停在「${blocker.nodeTitle}」：${blocker.headline}`;
  } else if (mainNodes.every((n) => n.status === 'completed' || n.status === 'skipped')) {
    overallStatus = 'completed';
    overallLabel = '全流程完成';
    headline =
      deliveryTask?.delivery?.status === 'completed'
        ? showEvaluation && evalStatus === 'completed'
          ? '建站、独立评测与跨环境交付核验已全部完成。'
          : '站点生成与跨环境交付已全部完成。'
        : evalPassed
          ? hasGeneration
            ? '站点生成与独立评测已全部达标完成。'
            : '独立评测已达标完成。'
          : !showEvaluation && hasGeneration && genDone
            ? '站点已生成完成，可直接访问使用。'
            : '所有已触发流程节点均已执行完成。';
  } else {
    const nextPending = mainNodes.find((n) => n.status === 'pending');
    overallStatus = 'pending';
    overallLabel = '待继续';
    headline = nextPending ? `即将进入「${nextPending.title}」` : '等待流程调度。';
  }

  if (root.id !== viewing.id && viewing.kind === 'evaluation') {
    const prefix = viewing.optimizationRound ? `第 ${viewing.optimizationRound} 轮` : '关联';
    headline = `${headline}（当前查看${prefix}评测关联的完整流程）`;
  }

  const totalRecordedMs = timing.recordedMs > 0 || timing.complete ? timing.recordedMs : null;

  return {
    taskId: viewing.id,
    rootTaskId: root.id,
    viewingTaskId: viewing.id,
    scenario: root.scenario,
    scope: root.scope,
    kind: root.kind,
    overallStatus,
    overallLabel,
    headline: `${scenarios[root.scenario]} · ${headline}`,
    currentNodeId,
    blocker,
    targetScore,
    totalRecordedMs,
    timingComplete: timing.complete,
    nodes,
    edges,
    rounds,
    updatedAt: Math.max(root.updatedAt, activeTask.updatedAt, deliveryTask?.delivery?.updatedAt || 0),
  };
}

export function registerWorkflowGraphApi(
  app: FastifyInstance,
  store: AutomationStore,
  vault: Vault,
  directory: string,
  owns: (id: string) => boolean,
  workerReady: () => boolean,
) {
  const params = z.object({ id: z.string().uuid() });
  app.get('/api/automation/tasks/:id/workflow', async (request, reply) => {
    const { id } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    const graph = buildTaskWorkflowGraph(id, store, vault, directory, {
      owns,
      workerReady: workerReady(),
      maintenance: inMaintenance(directory),
    });
    if (!graph) return reply.code(404).send({ error: '任务不存在' });
    return graph;
  });
}
