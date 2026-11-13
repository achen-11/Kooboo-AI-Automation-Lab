import type { MaterialFile, TaskStatus } from '../../../shared/automation.js';
import type {
  TemplateBaseline,
  TemplateBaselinePage,
  TemplateCaptureScope,
  TemplateCheckDefinition,
  TemplateCheckKind,
  TemplateChecklist,
  TemplateChecklistInput,
  TemplateCheckResult,
  TemplateCheckStatus,
  TemplateConstraint,
  TemplateEvaluation,
  TemplateEvidence,
  TemplateIssue,
  TemplateView,
  TemplateViewport,
  TemplateWorkflowResponse,
} from '../../../shared/template-workflow.js';

export type TemplatePhase = NonNullable<TemplateWorkflowResponse['phase']>;
export type TemplateExecutor = TemplateCheckDefinition['executor'];
export type TemplateSeverity = TemplateCheckDefinition['severity'];
export type TemplateProvenance = TemplateCheckResult['provenance'];

export const templateViewportNames: Record<TemplateViewport, string> = {
  desktop: 'PC',
  mobile: '移动端',
};

export const templatePhaseNames: Record<TemplatePhase, string> = {
  analysis: '生成前参考分析',
  generation: '站点生成',
  evaluation: '共享采集与核验',
  repair: '问题修复与局部复验',
  completed: '必检已达标',
  interrupted: '流程已中断',
};

export const templateCheckKindNames: Record<TemplateCheckKind, string> = {
  presence: '区块组成',
  order: '区块顺序',
  gutter: '正文留白',
  relation: '布局关系',
  'line-count': '文本换行',
  spacing: '区块间距',
  visual: '视觉与开放问题',
  interaction: '交互状态',
};

export const templateExecutorNames: Record<TemplateExecutor, string> = {
  script: '脚本核验',
  ai: 'AI 判断',
  hybrid: '脚本 + AI',
};

export const templateCheckStatusNames: Record<TemplateCheckStatus, string> = {
  passed: '通过',
  failed: '未通过',
  unverified: '未验证',
  'not-applicable': '不适用',
};

export const templateSeverityNames: Record<TemplateSeverity, string> = {
  critical: '严重',
  major: '主要',
  minor: '次要',
};

export const templateProvenanceNames: Record<TemplateProvenance, string> = {
  measured: '本轮实测',
  inherited: '依据继承',
  unverified: '尚未验证',
};

export const templateIssueStatusNames: Record<TemplateIssue['status'], string> = {
  open: '待修复',
  done: '已复验关闭',
  unverified: '未验证',
};

export const templateCaptureModeNames: Record<TemplateCaptureScope['mode'], string> = {
  page: '全页采集',
  regions: '局部区域重采',
  inherited: '继承有效采集',
};

export const templateRelationNames: Record<NonNullable<TemplateConstraint['relation']>, string> = {
  'left-of': '位于左侧',
  above: '位于上方',
  'aligned-left': '左边缘对齐',
  'aligned-top': '上边缘对齐',
};

export const templateQualityNames: Record<TemplateEvaluation['quality'], string> = {
  passed: '达到标准',
  failed: '存在待修复问题',
  unverified: '有待补充验证',
};

const CHECK_ID_PATTERN = /^[a-z][a-z0-9-]{0,79}$/;
const SAFE_ARTIFACT_NAME = /^[a-f0-9-]{36}\.(?:png|json)$/;
const UUID_PATTERN = /^[a-f0-9-]{36}$/;

export interface ChecklistValidationResult {
  valid: boolean;
  errors: string[];
  checkErrors: Record<number, string[]>;
}

export function validateTemplateChecklist(input: TemplateChecklistInput): ChecklistValidationResult {
  const errors: string[] = [];
  const checkErrors: Record<number, string[]> = {};
  const trimmedName = input.name.trim();
  if (!trimmedName) errors.push('请填写检查集版本名称');
  else if (trimmedName.length > 200) errors.push('版本名称不能超过 200 个字符');

  if (!input.checks.length) {
    errors.push('至少保留一个检查项');
    return { valid: false, errors, checkErrors };
  }
  if (input.checks.length > 100) errors.push('检查项数量不能超过 100 项');
  if (!input.checks.some(check => check.enabled)) errors.push('至少启用一个检查项');

  const seenIds = new Map<string, number>();
  input.checks.forEach((check, index) => {
    const itemErrors: string[] = [];
    const id = check.id.trim();
    if (!CHECK_ID_PATTERN.test(id)) {
      itemErrors.push('ID 需以小写字母开头，仅含小写字母、数字和连字符（最长 80 位）');
    } else if (seenIds.has(id)) {
      itemErrors.push(`与第 ${seenIds.get(id)! + 1} 项 ID "${id}" 重复`);
    } else {
      seenIds.set(id, index);
    }

    if (!check.title.trim()) itemErrors.push('请填写检查项标题');
    else if (check.title.trim().length > 200) itemErrors.push('标题不能超过 200 个字符');

    if (!check.instruction.trim()) itemErrors.push('请填写核验说明与预期标准');
    else if (check.instruction.trim().length > 8000) itemErrors.push('核验说明不能超过 8000 个字符');

    if (!check.scopes.length || new Set(check.scopes).size !== check.scopes.length) {
      itemErrors.push('至少选择一个不重复的适用范围（仅首页 / 全站）');
    }
    if (!check.viewports.length || new Set(check.viewports).size !== check.viewports.length) {
      itemErrors.push('至少选择一个不重复的适用视口（PC / 移动端）');
    }
    if (!Number.isFinite(check.weight) || check.weight < 0 || check.weight > 100) {
      itemErrors.push('权重需为 0–100 之间的有限数字');
    }
    if (!Number.isFinite(check.tolerancePx) || check.tolerancePx < 0 || check.tolerancePx > 1000) {
      itemErrors.push('像素容差需为 0–1000 之间的非负数字');
    }
    if (check.exceptions.length > 4000) {
      itemErrors.push('例外说明不能超过 4000 个字符');
    }
    if (itemErrors.length) checkErrors[index] = itemErrors;
  });

  if (Object.keys(checkErrors).length) {
    errors.push(`有 ${Object.keys(checkErrors).length} 个检查项存在字段校验问题`);
  }
  return { valid: errors.length === 0 && Object.keys(checkErrors).length === 0, errors, checkErrors };
}

export function sanitizeTemplateChecklistInput(input: TemplateChecklistInput): TemplateChecklistInput {
  return {
    name: input.name.trim(),
    checks: input.checks.map(check => ({
      id: check.id.trim(),
      title: check.title.trim(),
      enabled: Boolean(check.enabled),
      kind: check.kind,
      executor: check.executor,
      instruction: check.instruction.trim(),
      scopes: (['homepage', 'site'] as const).filter(scope => check.scopes.includes(scope)),
      viewports: (['desktop', 'mobile'] as const).filter(viewport => check.viewports.includes(viewport)),
      required: Boolean(check.required),
      severity: check.severity,
      weight: Number(check.weight),
      tolerancePx: Number(check.tolerancePx),
      exceptions: check.exceptions.trim(),
    })),
  };
}

export function cloneChecklistForEdit(checklist: TemplateChecklist): TemplateChecklistInput {
  const baseName = checklist.name.replace(/\s*·\s*新版本$/, '');
  return {
    name: `${baseName} · 新版本`,
    checks: checklist.checks.map(check => ({
      ...check,
      scopes: [...check.scopes],
      viewports: [...check.viewports],
    })),
  };
}

export function createBlankTemplateCheck(existing: readonly TemplateCheckDefinition[]): TemplateCheckDefinition {
  const used = new Set(existing.map(item => item.id));
  let index = existing.length + 1;
  while (used.has(`custom-check-${index}`)) index++;
  return {
    id: `custom-check-${index}`,
    title: '',
    enabled: true,
    kind: 'visual',
    executor: 'hybrid',
    instruction: '',
    scopes: ['homepage', 'site'],
    viewports: ['desktop', 'mobile'],
    required: false,
    severity: 'major',
    weight: 1,
    tolerancePx: 8,
    exceptions: '',
  };
}

export interface TemplateStageStep {
  id: 'analysis' | 'generation' | 'evaluation' | 'repair';
  label: string;
  state: 'completed' | 'running' | 'attention' | 'pending';
  detail: string;
}

export function shouldShowRepairStage(workflow: TemplateWorkflowResponse, repairRoundCount = 0): boolean {
  if (!workflow.supported) return false;
  if (workflow.phase === 'repair' || repairRoundCount > 0) return true;
  if (!workflow.evaluation) return false;
  return workflow.evaluation.quality === 'failed' || workflow.evaluation.issues.some(issue => issue.status === 'open');
}

export function buildTemplateStageSteps(
  workflow: TemplateWorkflowResponse,
  activeStatus?: TaskStatus,
  repairRoundCount = 0,
): TemplateStageStep[] {
  const phase = workflow.phase;
  const baseline = workflow.baseline;
  const evaluation = workflow.evaluation;
  const running = activeStatus === 'running' || activeStatus === 'following-up';
  const interrupted = phase === 'interrupted' || ['failed', 'interrupted', 'pending', 'cancelled'].includes(activeStatus || '');

  const totalViews = baseline ? baseline.pages.reduce((sum, page) => sum + page.views.length, 0) : 0;
  const analysisState: TemplateStageStep['state'] = baseline
    ? (baseline.complete ? 'completed' : phase === 'analysis' && running ? 'running' : 'attention')
    : phase === 'analysis'
      ? (interrupted ? 'attention' : running ? 'running' : 'pending')
      : interrupted ? 'attention' : 'pending';

  const analysisDetail = baseline
    ? `冻结 v${baseline.revision} · ${baseline.pages.length} 页 / ${totalViews} 个区块${baseline.complete ? '' : `（${baseline.limitations.length || 1} 项缺口）`}`
    : phase === 'analysis'
      ? (interrupted ? '参考采集或分析已中断' : running ? '正在采集并分析来源基线' : '等待开始来源分析')
      : '等待前置来源分析';

  const generationReached = Boolean(baseline) || ['generation', 'evaluation', 'repair', 'completed'].includes(phase || '');
  const generationDone = ['evaluation', 'repair', 'completed'].includes(phase || '') || Boolean(evaluation);
  const generationState: TemplateStageStep['state'] = generationDone
    ? 'completed'
    : phase === 'generation'
      ? (interrupted ? 'attention' : running ? 'running' : 'pending')
      : !generationReached ? 'pending' : interrupted ? 'attention' : 'pending';

  const generationDetail = generationDone
    ? '已完成建站并交接核验'
    : phase === 'generation'
      ? (interrupted ? '生成阶段需要处理' : running ? 'AI Chat 按冻结基线实施中' : '等待生成队列执行')
      : '读取共同基线与简短经验实施';

  const evalPassed = Boolean(evaluation && evaluation.complete && evaluation.quality === 'passed');
  const evalState: TemplateStageStep['state'] = evalPassed
    ? 'completed'
    : evaluation
      ? 'attention'
      : phase === 'evaluation'
        ? (interrupted ? 'attention' : running ? 'running' : 'pending')
        : phase === 'completed'
          ? 'attention'
          : 'pending';

  const evalDetail = evaluation
    ? evalPassed
      ? '必检覆盖完整且通过，无需修复'
      : evaluation.quality === 'failed'
        ? `检出 ${evaluation.issues.filter(i => i.status === 'open').length} 项待修复问题`
        : '存在未验证项或证据缺口，不计为通过'
    : phase === 'evaluation'
      ? (interrupted ? '采集或核验中断' : running ? '统一采集并批量核验中' : '排队等待独立核验')
      : '生成完成后统一采集并按区块核验';

  const steps: TemplateStageStep[] = [
    { id: 'analysis', label: '参考分析', state: analysisState, detail: analysisDetail },
    { id: 'generation', label: '站点生成', state: generationState, detail: generationDetail },
    { id: 'evaluation', label: '共享核验', state: evalState, detail: evalDetail },
  ];

  if (shouldShowRepairStage(workflow, repairRoundCount)) {
    const openIssues = evaluation?.issues.filter(issue => issue.status === 'open').length ?? 0;
    const repairDone = evalPassed && repairRoundCount > 0;
    const repairState: TemplateStageStep['state'] = repairDone
      ? 'completed'
      : phase === 'repair'
        ? (interrupted ? 'attention' : running ? 'running' : 'attention')
        : 'attention';
    const repairDetail = repairDone
      ? `已完成局部复验并关闭问题`
      : phase === 'repair'
        ? (interrupted ? '修复或局部复验已中断' : running ? '批量修复并按影响局部复验中' : '等待执行修复与局部复验')
        : openIssues > 0
          ? `${openIssues} 项明确问题待批量修复与独立复验`
          : '等待局部复验确认结果';
    steps.push({ id: 'repair', label: '修复与局部复验', state: repairState, detail: repairDetail });
  }

  return steps;
}

export interface TemplateWorkflowGuidance {
  headline: string;
  blocker: string;
  nextAction: string;
  tone: 'good' | 'warning' | 'info';
}

export function describeTemplateWorkflowGuidance(
  workflow: TemplateWorkflowResponse,
  attention = '',
  nextStep = '',
): TemplateWorkflowGuidance {
  const { phase, baseline, evaluation, limitations } = workflow;
  if (phase === 'interrupted' || attention) {
    return {
      headline: '当前流程暂停等待处理',
      blocker: attention || limitations[0] || '当前执行阶段已中断或取消，未完成部分不视为通过。',
      nextAction: nextStep || '检查中断原因与原执行停止状态后，恢复当前阶段或补齐缺失证据。',
      tone: 'warning',
    };
  }
  if (evaluation && evaluation.complete && evaluation.quality === 'passed') {
    return {
      headline: '全部必检范围已覆盖并独立验证通过',
      blocker: limitations.length ? `提示：${limitations.join('；')}` : '',
      nextAction: '当前站点版本已满足冻结基线与通用检查集要求，无需追加修复或额外全站终审。',
      tone: 'good',
    };
  }
  if (!baseline) {
    return {
      headline: '正在准备冻结参考基线',
      blocker: limitations[0] || '',
      nextAction: '本地分析工具采集参考站（及可选内容站）并固定页面与语义区块要求，供生成和评测共用。',
      tone: 'info',
    };
  }
  if (!baseline.complete && phase === 'analysis') {
    return {
      headline: '参考基线存在待补齐缺口',
      blocker: baseline.limitations.join('；') || limitations.join('；') || '来源采集尚未覆盖全部必检范围。',
      nextAction: '先由受控采集补齐缺失来源证据或明确限制，不将来源异常当作目标站缺陷。',
      tone: 'warning',
    };
  }
  if (phase === 'generation') {
    return {
      headline: '基于冻结基线生成目标站点',
      blocker: !baseline.complete ? `来源基线保留 ${baseline.limitations.length || 1} 项已知限制` : '',
      nextAction: 'Kooboo AI Chat 消费统一实施包与简短适用经验实施建站；完成后进入一次采集共享评测。',
      tone: 'info',
    };
  }
  if (phase === 'evaluation' && !evaluation) {
    return {
      headline: '正在执行共享证据采集与分区块核验',
      blocker: limitations[0] || '',
      nextAction: '对必检页面与视口统一取证，批量运行确定性脚本测量与按区块 AI 判断。',
      tone: 'info',
    };
  }
  if (evaluation) {
    const openIssues = evaluation.issues.filter(issue => issue.status === 'open');
    const unverifiedChecks = evaluation.checks.filter(check => check.status === 'unverified');
    if (openIssues.length > 0) {
      const criticalOrMajor = openIssues.filter(i => i.severity !== 'minor').length;
      return {
        headline: phase === 'repair' ? '正在批量修复并按影响范围局部复验' : '检出明确缺陷，需修复并经独立复验关闭',
        blocker: `共 ${openIssues.length} 项待修复问题${criticalOrMajor ? `（含 ${criticalOrMajor} 项严重/主要问题）` : ''}${unverifiedChecks.length ? `，另有 ${unverifiedChecks.length} 项检查未验证` : ''}。`,
        nextAction: phase === 'repair'
          ? '识别修改影响范围后局部重采受影响区块与视口，合并仍有效的历史证据；仅独立复验通过可关闭问题。'
          : '合并本轮明确问题一次交接 Kooboo AI Chat 修复，随后按实际变更范围局部采集并复验。',
        tone: 'warning',
      };
    }
    return {
      headline: '尚有未验证范围或证据缺口',
      blocker: limitations[0] || `存在 ${unverifiedChecks.length} 项未验证检查或采集尚未完整，未知结果不计为通过。`,
      nextAction: '优先针对缺失证据补采并复核对应检查项，不将采集缺口交由生成方改站掩盖。',
      tone: 'warning',
    };
  }
  return {
    headline: '当前站点修订等待独立核验',
    blocker: limitations[0] || '尚未生成与当前站点修订匹配的模板评测结果，历史结果不代表当前状态。',
    nextAction: '发起或等待当前修订的共享采集与核验完成。',
    tone: 'info',
  };
}

export interface TemplateEvaluationSummary {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  unverifiedChecks: number;
  notApplicableChecks: number;
  failedRequiredChecks: number;
  measuredChecks: number;
  inheritedChecks: number;
  unverifiedProvenanceChecks: number;
  openIssues: number;
  doneIssues: number;
  unverifiedIssues: number;
  criticalOrMajorOpenIssues: number;
  viewportScores: { viewport: TemplateViewport; score: number | null; scoredCount: number; unverifiedCount: number }[];
}

export function summarizeTemplateEvaluation(
  evaluation: TemplateEvaluation,
  checklist: TemplateChecklist | null,
): TemplateEvaluationSummary {
  const checkDefs = new Map((checklist?.checks || []).map(item => [item.id, item]));
  let passedChecks = 0, failedChecks = 0, unverifiedChecks = 0, notApplicableChecks = 0, failedRequiredChecks = 0;
  let measuredChecks = 0, inheritedChecks = 0, unverifiedProvenanceChecks = 0;

  for (const check of evaluation.checks) {
    if (check.status === 'passed') passedChecks++;
    else if (check.status === 'failed') {
      failedChecks++;
      if (checkDefs.get(check.checkId)?.required) failedRequiredChecks++;
    } else if (check.status === 'unverified') unverifiedChecks++;
    else if (check.status === 'not-applicable') notApplicableChecks++;

    if (check.provenance === 'measured') measuredChecks++;
    else if (check.provenance === 'inherited') inheritedChecks++;
    else unverifiedProvenanceChecks++;
  }

  let openIssues = 0, doneIssues = 0, unverifiedIssues = 0, criticalOrMajorOpenIssues = 0;
  for (const issue of evaluation.issues) {
    if (issue.status === 'open') {
      openIssues++;
      if (issue.severity === 'critical' || issue.severity === 'major') criticalOrMajorOpenIssues++;
    } else if (issue.status === 'done') doneIssues++;
    else unverifiedIssues++;
  }

  const viewportScores = (['desktop', 'mobile'] as const).map(viewport => {
    const items = evaluation.checks.filter(item => item.viewport === viewport && item.status !== 'not-applicable');
    const unverifiedCount = items.filter(item => item.status === 'unverified' || item.score === null).length;
    const providedScore = evaluation.scores?.find(entry => entry.viewport === viewport);
    let weightedSum = 0;
    let totalWeight = 0;
    let scoredCount = 0;
    for (const item of items) {
      if (item.score === null || !Number.isFinite(item.score)) continue;
      const weight = checkDefs.get(item.checkId)?.weight ?? 1;
      if (weight <= 0) continue;
      weightedSum += item.score * weight;
      totalWeight += weight;
      scoredCount++;
    }
    const fallbackScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : null;
    return {
      viewport,
      score:
        providedScore !== undefined
          ? providedScore.value !== null && Number.isFinite(providedScore.value)
            ? Math.round(providedScore.value * 10) / 10
            : null
          : fallbackScore,
      scoredCount,
      unverifiedCount,
    };
  });

  return {
    totalChecks: evaluation.checks.length,
    passedChecks,
    failedChecks,
    unverifiedChecks,
    notApplicableChecks,
    failedRequiredChecks,
    measuredChecks,
    inheritedChecks,
    unverifiedProvenanceChecks,
    openIssues,
    doneIssues,
    unverifiedIssues,
    criticalOrMajorOpenIssues,
    viewportScores,
  };
}

export interface TemplateCheckFilter {
  pagePath?: string;
  viewport?: '' | TemplateViewport;
  status?: '' | TemplateCheckStatus;
  provenance?: '' | TemplateProvenance;
  query?: string;
}

export interface EnrichedTemplateCheckResult {
  result: TemplateCheckResult;
  definition?: TemplateCheckDefinition;
  checkTitle: string;
  required: boolean;
  executor?: TemplateExecutor;
  severity?: TemplateSeverity;
  tolerancePx?: number;
}

export interface TemplateDrilldownViewNode {
  viewId: string;
  viewTitle: string;
  role: string;
  required: boolean;
  baselineView?: TemplateView;
  checks: EnrichedTemplateCheckResult[];
  failedCount: number;
  unverifiedCount: number;
  passedCount: number;
}

export interface TemplateDrilldownPageNode {
  pagePath: string;
  pageTitle: string;
  baselinePage?: TemplateBaselinePage;
  views: TemplateDrilldownViewNode[];
  failedCount: number;
  unverifiedCount: number;
  passedCount: number;
}

export function buildPageViewCheckTree(
  evaluation: TemplateEvaluation,
  baseline: TemplateBaseline | null,
  checklist: TemplateChecklist | null,
  filter: TemplateCheckFilter = {},
): TemplateDrilldownPageNode[] {
  const checkDefs = new Map((checklist?.checks || []).map(item => [item.id, item]));
  const baselinePages = new Map((baseline?.pages || []).map(page => [page.path, page]));
  const pageOrder = new Map((baseline?.pages || []).map((page, index) => [page.path, index]));
  const normalizedQuery = (filter.query || '').trim().toLowerCase();

  const pageBuckets = new Map<string, Map<string, EnrichedTemplateCheckResult[]>>();

  for (const result of evaluation.checks) {
    if (filter.pagePath && result.pagePath !== filter.pagePath) continue;
    if (filter.viewport && result.viewport !== filter.viewport) continue;
    if (filter.status && result.status !== filter.status) continue;
    if (filter.provenance && result.provenance !== filter.provenance) continue;

    const definition = checkDefs.get(result.checkId);
    const checkTitle = definition?.title || result.checkId;
    const bPage = baselinePages.get(result.pagePath);
    const bView = bPage?.views.find(view => view.id === result.viewId);

    if (normalizedQuery) {
      const haystack = [
        result.pagePath,
        bPage?.title || '',
        result.viewId,
        bView?.title || '',
        bView?.role || '',
        result.checkId,
        checkTitle,
        result.expected,
        result.actual,
        result.reason,
      ].join(' ').toLowerCase();
      if (!haystack.includes(normalizedQuery)) continue;
    }

    let viewBuckets = pageBuckets.get(result.pagePath);
    if (!viewBuckets) {
      viewBuckets = new Map();
      pageBuckets.set(result.pagePath, viewBuckets);
    }
    let list = viewBuckets.get(result.viewId);
    if (!list) {
      list = [];
      viewBuckets.set(result.viewId, list);
    }
    list.push({
      result,
      definition,
      checkTitle,
      required: Boolean(definition?.required),
      executor: definition?.executor,
      severity: definition?.severity,
      tolerancePx: definition?.tolerancePx,
    });
  }

  const statusPriority: Record<TemplateCheckStatus, number> = {
    failed: 0,
    unverified: 1,
    passed: 2,
    'not-applicable': 3,
  };

  const pages: TemplateDrilldownPageNode[] = [];
  const sortedPaths = [...pageBuckets.keys()].sort((a, b) => {
    const idxA = pageOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
    const idxB = pageOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
    return idxA !== idxB ? idxA - idxB : a.localeCompare(b);
  });

  for (const pagePath of sortedPaths) {
    const bPage = baselinePages.get(pagePath);
    const viewOrder = new Map((bPage?.views || []).map((view, index) => [view.id, index]));
    const viewBuckets = pageBuckets.get(pagePath)!;
    const sortedViewIds = [...viewBuckets.keys()].sort((a, b) => {
      const idxA = viewOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const idxB = viewOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      return idxA !== idxB ? idxA - idxB : a.localeCompare(b);
    });

    const views: TemplateDrilldownViewNode[] = [];
    let pageFailed = 0, pageUnverified = 0, pagePassed = 0;

    for (const viewId of sortedViewIds) {
      const bView = bPage?.views.find(item => item.id === viewId);
      const checks = viewBuckets.get(viewId)!.slice().sort((a, b) => {
        const prio = statusPriority[a.result.status] - statusPriority[b.result.status];
        if (prio !== 0) return prio;
        if (a.required !== b.required) return a.required ? -1 : 1;
        return a.checkTitle.localeCompare(b.checkTitle, 'zh-CN');
      });
      const failedCount = checks.filter(item => item.result.status === 'failed').length;
      const unverifiedCount = checks.filter(item => item.result.status === 'unverified').length;
      const passedCount = checks.filter(item => item.result.status === 'passed').length;
      pageFailed += failedCount;
      pageUnverified += unverifiedCount;
      pagePassed += passedCount;

      views.push({
        viewId,
        viewTitle: bView?.title || (viewId === '_page' || viewId === 'page' ? '整页级检查' : viewId),
        role: bView?.role || '',
        required: bView?.required ?? false,
        baselineView: bView,
        checks,
        failedCount,
        unverifiedCount,
        passedCount,
      });
    }

    pages.push({
      pagePath,
      pageTitle: bPage?.title || pagePath,
      baselinePage: bPage,
      views,
      failedCount: pageFailed,
      unverifiedCount: pageUnverified,
      passedCount: pagePassed,
    });
  }

  return pages;
}

/** Strict evidence URL validation: only use safe registered API hrefs, never construct disk paths. */
export function resolveTemplateEvidenceHref(evidence: TemplateEvidence, fallbackTaskId?: string): string | null {
  const raw = (evidence.href || '').trim();
  if (raw) {
    if (raw.startsWith('/api/') && !raw.includes('..') && !raw.includes('\\')) {
      return raw;
    }
    return null;
  }
  if (fallbackTaskId && UUID_PATTERN.test(fallbackTaskId) && SAFE_ARTIFACT_NAME.test(evidence.name)) {
    return `/api/automation/tasks/${fallbackTaskId}/template-workflow/artifacts/${encodeURIComponent(evidence.name)}`;
  }
  return null;
}

export type PreviewableMaterialFile = MaterialFile & {
  href: string;
  ownerTaskId: string;
  siteRevision: string | null;
  sourceUrl: string;
};

export function mergeWorkflowEvidence(
  baseline: TemplateBaseline | null,
  evaluation: TemplateEvaluation | null,
): TemplateEvidence[] {
  const byName = new Map<string, TemplateEvidence>();
  for (const item of baseline?.evidence || []) byName.set(item.name, item);
  for (const item of evaluation?.evidence || []) byName.set(item.name, item);
  return [...byName.values()];
}

export function toPreviewArtifacts(
  evidenceList: readonly TemplateEvidence[],
  fallbackTaskId?: string,
): PreviewableMaterialFile[] {
  const items: PreviewableMaterialFile[] = [];
  for (const item of evidenceList) {
    const href = resolveTemplateEvidenceHref(item, fallbackTaskId);
    if (!href) continue;
    items.push({
      id: item.name,
      name: item.name,
      type: item.type,
      size: item.size,
      sha256: item.sha256,
      role: item.role,
      viewport: item.viewport,
      href,
      ownerTaskId: item.ownerTaskId,
      siteRevision: item.siteRevision,
      sourceUrl: item.url,
    });
  }
  return items;
}

export function templateEvidenceTitle(item: TemplateEvidence, index?: number): string {
  const role = item.role === 'reference' ? '参考站' : item.role === 'content' ? '内容站' : '生成站';
  const viewport = item.viewport ? templateViewportNames[item.viewport] : '';
  const kind = item.type === 'image/png' ? '截图' : '结构数据';
  return [role, viewport, index !== undefined ? `${kind} ${index + 1}` : kind].filter(Boolean).join(' · ');
}

export function shortRevision(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 12 ? value.slice(0, 8) : value;
}

export function appendUrlParam(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
