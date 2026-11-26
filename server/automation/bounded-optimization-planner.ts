import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import { z } from 'zod';
import {
  optimizationScenarioGuidance,
  type AutomationTask,
  type FollowupAction,
} from '../../shared/automation.js';
import {
  retainStoppedFollowupReservations,
  followupRequestPolicy,
} from './autonomy.js';
import { runBoundedBatchWithRecovery, type BatchImage } from './bounded-evaluator.js';
import { collectionTargetRepairContext } from './collection/report.js';
import { collectionSourceGaps } from './collection/recollection.js';
import { followupReportComparison, followupTaskContext } from './followup-context.js';
import { copyHarnessReferences } from './harness.js';
import { migrationRepairContext } from './migration-verification.js';
import { optimizationEvidence } from './optimization-evidence.js';
import { ModelBudgetExceeded } from './request-budget.js';
import { resolveClonedContentImageSource } from './site-ui-rules.js';
import type { AutomationStore } from './store.js';
import { usageCapture } from './usage-proxy.js';
import type { Vault } from '../lib/vault.js';

const MAX_BOUNDED_PLANNING_IMAGES = 12;
const MAX_BOUNDED_PLANNING_IMAGE_BYTES = 16 * 1024 * 1024;

export const boundedOptimizationDecisionSchema = z
  .object({
    action: z.enum(['repair', 'interrupt']),
    reason: z.string().trim().min(1).max(4000),
    message: z.string().trim().max(12000).nullable(),
    imageEvidence: z.array(z.string().trim().min(1)).max(MAX_BOUNDED_PLANNING_IMAGES).nullable(),
    progress: z
      .object({
        improved: z.boolean(),
        reason: z.string().trim().min(1).max(3000),
        resolved: z.array(z.string().trim().min(1)).max(40),
        remaining: z.array(z.string().trim().min(1)).max(40),
        unverified: z.array(z.string().trim().min(1)).max(40),
        introduced: z.array(z.string().trim().min(1)).max(40),
      })
      .strict()
      .nullable(),
    nextSteps: z.array(z.string().trim().min(1).max(800)).max(8).nullable(),
    userSummary: z
      .object({
        headline: z.string().trim().min(1).max(160),
        category: z.enum([
          'source-access',
          'target-auth',
          'template-source',
          'ai-model',
          'environment',
          'site-collision',
          'need-human-input',
          'runtime',
        ]),
        explanation: z.string().trim().min(1).max(800),
        userActions: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BoundedOptimizationDecision = z.infer<typeof boundedOptimizationDecisionSchema>;

/** Enable bounded read-only optimization planning for active scenarios without custom workflow graphs. */
export function canUseBoundedOptimizationPlanning(task: AutomationTask): boolean {
  if (task.optimization?.state !== 'planning') return false;
  if (!['materials', 'upgrade', 'migration'].includes(task.scenario)) return false;
  if (task.templateWorkflow || task.collectionVersionId) return false;
  if (task.autonomy?.checkpoint.diagnosticRequired) return false;
  return true;
}

type SelectedOptimizationEvidenceItem = ReturnType<typeof optimizationEvidence>['selected'][number];

function selectBoundedPlanningImages(
  selected: readonly SelectedOptimizationEvidenceItem[],
  currentReportId: string,
): SelectedOptimizationEvidenceItem[] {
  const chosen: SelectedOptimizationEvidenceItem[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const tryAdd = (item: SelectedOptimizationEvidenceItem) => {
    const key = `${item.reportId}:${item.file.name}`;
    if (seen.has(key)) return;
    if (chosen.length >= MAX_BOUNDED_PLANNING_IMAGES) return;
    if (totalBytes + item.file.size > MAX_BOUNDED_PLANNING_IMAGE_BYTES) return;
    seen.add(key);
    chosen.push(item);
    totalBytes += item.file.size;
  };

  for (const item of selected) {
    if (item.reportId === currentReportId) tryAdd(item);
  }
  for (const item of selected) {
    if (item.reportId !== currentReportId) tryAdd(item);
  }
  return chosen;
}

export async function executeBoundedOptimizationPlanning(params: {
  task: AutomationTask;
  store: AutomationStore;
  vault: Vault;
  directory: string;
  signal: AbortSignal;
  createClient: (
    vault: Vault,
    directory: string,
    extra: Record<string, string>,
    model?: AutomationTask['model'],
  ) => { startThread(options: ThreadOptions): Pick<Thread, 'runStreamed'> };
  validateAction: (
    raw: unknown,
    optimizationImages: string[],
    observations: Set<string>,
  ) => FollowupAction;
}): Promise<FollowupAction> {
  const { task, store, vault, directory, signal, createClient, validateAction } = params;
  if (!task.followup || !task.optimization) {
    throw new Error('有界优化规划缺少 followup 或 optimization 配置');
  }

  const priorUsage = new Set(store.usage.entries(task.id).map(e => `${e.source}:${e.id}`));
  const priorTokens = task.followup.tokens;
  task.followup.budgetId ||= randomUUID();
  task.followup.reportObservations = {};
  store.put(task);

  const work = resolve(directory, 'followup-runs', task.id);
  mkdirSync(work, { recursive: true, mode: 0o700 });

  // Host-owned preflight validates screenshot evidence hashes before spending model tokens.
  const quality = optimizationEvidence(task, store, directory);
  const migration = migrationRepairContext(task, store);
  const comparison = followupReportComparison(quality.current.report!, quality.previous?.report);

  const save = (name: string, value: unknown) =>
    writeFileSync(resolve(work, name), JSON.stringify(store.sanitize(value), null, 2), { mode: 0o600 });
  save('report-comparison.json', comparison);
  save('current-report.json', quality.current.report);
  save('previous-report.json', quality.previous?.report || null);
  save(
    'repair-history.json',
    task.optimization.rounds.map(({ number, generationTaskId, sourceReportId, brief, progress }) => ({
      number,
      generationTaskId,
      sourceReportId,
      brief,
      progress,
    })),
  );
  copyHarnessReferences('optimization', work);
  writeFileSync(
    resolve(work, 'SKILL.md'),
    `${task.optimization.policy.sop}\n\n本次场景约束：${optimizationScenarioGuidance(task.scenario)}`,
    { mode: 0o600 },
  );

  const selectedItems = selectBoundedPlanningImages(quality.selected, quality.current.id);
  const batchImages: BatchImage[] = selectedItems.map(item => ({
    name: item.file.name,
    absPath: item.path,
    role: item.file.role === 'reference' ? 'reference' : 'target',
    viewport: item.file.viewport === 'mobile' ? 'mobile' : 'desktop',
    sha256: item.file.sha256,
    width: null,
    height: null,
    scrollY: null,
    action: item.reportId === quality.current.id ? 'current_report' : 'previous_report',
  }));
  const currentEvidenceNames = selectedItems
    .filter(item => item.reportId === quality.current.id)
    .map(item => item.file.name);
  const currentEvidenceSet = new Set(currentEvidenceNames);

  const observations = new Set<string>();
  const observe = (tool: string, value: unknown): string => {
    const id = `observation-${randomUUID()}`;
    const safe = store.sanitize(value);
    observations.add(id);
    writeFileSync(resolve(work, `${id}.json`), JSON.stringify(safe, null, 2), { mode: 0o600 });
    task.followup!.observations.push(id);
    task.followup!.observations = task.followup!.observations.slice(-100);
    store.put(task);
    store.event(task.id, `AI 工具 ${tool} → ${id}\n${JSON.stringify(safe).slice(0, 5000)}`);
    return id;
  };

  const site = task.generatedSiteId ? store.site(task.generatedSiteId) : null;
  const version = store.version(task.versionId);
  const hostTaskEvidenceId = observe('get_task', {
    task: followupTaskContext(task),
    input: version ? { ...version, description: version.description.slice(0, 12000) } : null,
    site,
    events: store.events(task.id).slice(-8).map(e => ({ ...e, message: e.message.slice(0, 1000) })),
  });

  const selectedNameSet = new Set(selectedItems.map(i => i.file.name));
  const boundedReport = (report: typeof quality.current.report) =>
    report
      ? {
          ...report,
          collectionTarget: collectionTargetRepairContext(report.collectionTarget),
          artifacts: report.artifacts.filter(f => f.type === 'image/png' && selectedNameSet.has(f.name)),
        }
      : report;
  const sourceGaps = collectionSourceGaps(quality.current.report);
  const hostReportEvidenceId = observe('get_report', {
    currentReportId: quality.current.id,
    current: boundedReport(quality.current.report),
    previous: boundedReport(quality.previous?.report || null),
    comparison,
    reportFiles: { current: 'current-report.json', previous: 'previous-report.json' },
    repairHistoryFile: 'repair-history.json',
    sourceGaps,
    migration: migration?.payload,
    rounds: followupTaskContext(task).optimization!.rounds,
    images: selectedItems.map(i => ({ reportId: i.reportId, ...i.file })),
  });
  task.followup.reportObservations[hostReportEvidenceId] = { reportId: quality.current.id, sourceGaps };
  store.put(task);

  const roundNumber = task.optimization.rounds.at(-1)?.number ?? 0;
  const policy = {
    ...followupRequestPolicy(task),
    maxOutputTokens: 32768,
  };
  let usage: Awaited<ReturnType<typeof usageCapture>> | undefined;

  const assertActionAllowed = () => {
    signal.throwIfAborted();
    usage?.signal.throwIfAborted();
    if (usage?.error instanceof ModelBudgetExceeded) throw usage.error;
    const current = store.task(task.id);
    if (current && ['cancelling', 'cancelled'].includes(current.status)) {
      throw new Error('任务正在取消或已取消');
    }
  };

  try {
    usage = await usageCapture(task.id, 'followup', store, vault, signal, policy);
    const codex = createClient(vault, directory, { ...usage.env }, task.model || undefined);
    const threadOptions = {
      model: task.model?.name || vault.automation().evaluationModel,
      workingDirectory: work,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only' as const,
      networkAccessEnabled: false,
      approvalPolicy: 'never' as const,
      webSearchMode: 'disabled' as const,
    };

    const currentReport = quality.current.report!;
    const gapsToTarget = ['desktop', 'mobile']
      .map(vp => {
        const val = currentReport.scores.find(s => s.viewport === vp)?.value;
        const diff = typeof val === 'number' ? Number((task.optimization!.policy.targetScore - val).toFixed(1)) : null;
        return `${vp}=${val ?? '未验证'}(距目标${diff === null ? '?' : diff > 0 ? `-${diff}` : `+${Math.abs(diff)}`})`;
      })
      .join('，');
    const hasMajorOrCritical = currentReport.issues.some(i => i.severity !== 'minor');
    const clonedSource = resolveClonedContentImageSource(task, version);

    const promptSections = [
      `你是站点持续优化规划 Agent（有界只读单步模式）。`,
      `【硬性约束】`,
      `- 严禁调用任何 shell 工具、读取文件系统或发起网络请求；所有报告事实与真实截图（local_image）已在本消息完整提供，请直接思考并在本轮返回严格符合 JSON Schema 的中文决策。`,
      `- 内部思考保持简洁紧凑，直击高影响问题、保留约束与精确改进建议。`,
      ``,
      `【优化规范与场景约束】`,
      task.optimization.policy.sop.trim(),
      `场景约束：${optimizationScenarioGuidance(task.scenario)}`,
      ``,
      `【当前目标与轮次】`,
      `- 站点：${site?.url || task.siteUrl || '未记录'} | 场景：${task.scenario} | 范围：${task.scope}`,
      `- 双端目标分：${task.optimization.policy.targetScore} | 当前得分：${gapsToTarget} | 已完成修复轮次：${roundNumber}/${task.optimization.policy.maxRounds}`,
      `- 原需求摘要：${(version?.description || task.message || '').trim().slice(0, 2000) || '（无）'}`,
      ...(clonedSource
        ? [
            clonedSource.kind === 'source-sandbox'
              ? `- 原内容站图片基线：原内容站（${clonedSource.contentUrl}）已成功克隆至只读源站 Sandbox「${clonedSource.sandbox}」；涉及缺图、换图或主视觉修复时，必须在修复委托中优先要求从该源站 Sandbox 复用原内容站真实图片资源，仅在原站确无可用图时才以资料图或 imagePlaceholder 兜底，严禁把可用原站图片替换成占位图。`
              : `- 原内容站图片基线：原内容站（${clonedSource.contentUrl}）已成功克隆至目标站；涉及缺图、换图或主视觉修复时，必须在修复委托中优先要求从当前目标站媒体库复用原内容站真实图片资源，仅在原站确无可用图时才以资料图或 imagePlaceholder 兜底，严禁把可用原站图片替换成占位图。`,
          ]
        : []),
      ...(!hasMajorOrCritical
        ? [
            `- 特别防退化纪律：当前报告已无 Critical/Major 缺陷！仅选 3–5 项最高收益且不牵连稳定区的 Minor 缺陷定向小改，并在 message 末尾醒目注明“严禁修改已达标的高分区段（如首屏、通过的网格或已有正确文案），严禁写入资料整理口径”。`,
          ]
        : []),
      ``,
      `【宿主对比摘要（report-comparison）】`,
      JSON.stringify(comparison, null, 2),
      ``,
      `【当前独立报告摘要（${quality.current.id}）】`,
      `- summary：${currentReport.summary.slice(0, 1200)}`,
      `- assessments：\n${currentReport.assessments
        .map(a => `  * ${a.criterionId}(${a.viewport}): score=${a.score ?? 'null'}, passed=${a.passed}, reason=${a.reason.slice(0, 220)}`)
        .join('\n')}`,
      `- issues（共 ${currentReport.issues.length} 项）：\n${
        currentReport.issues.length
          ? currentReport.issues
              .slice(0, 20)
              .map(
                (i, idx) =>
                  `  ${idx + 1}. [${i.severity}] ${i.title}｜${i.detail.slice(0, 260)}｜证据=[${i.evidence.join(', ')}]`,
              )
              .join('\n')
          : '  （无）'
      }`,
      `- coverage.unverified：${currentReport.coverage.unverified.join('；') || '无'}`,
      ...(migration?.payload ? ['', '【迁移核对约束】', JSON.stringify(migration.payload).slice(0, 2000)] : []),
      ...(task.optimization.rounds.some(r => r.progress || r.brief)
        ? [
            '',
            '【历史修复轮次】',
            ...task.optimization.rounds.slice(-3).map(
              r =>
                `- 第 ${r.number} 轮：improved=${r.progress?.improved ?? 'null'}｜${(r.progress?.reason || r.brief || '').slice(0, 320)}`,
            ),
          ]
        : []),
      ``,
      `【本轮附带的真实截图与 imageEvidence 白名单】`,
      ...selectedItems.map(
        i =>
          `- ${i.file.name} (报告=${i.reportId === quality.current.id ? '本轮 current' : '历史 previous'}, 角色=${i.file.role}, 视口=${i.file.viewport})`,
      ),
      `注意：当 action="repair" 时，imageEvidence 必须填 1–${MAX_BOUNDED_PLANNING_IMAGES} 个来自“本轮 current”的裸 PNG 文件名（${currentEvidenceNames.join(', ')}），progress 与 message 必填且 nextSteps/userSummary 填 null；${
        roundNumber === 0 ? '本轮为初评基线，progress.improved 必须为 false；' : ''
      }当 action="interrupt" 时，nextSteps 与 userSummary 必填，message/imageEvidence/progress 填 null。`,
    ]
      .filter(Boolean)
      .join('\n');

    store.event(
      task.id,
      `有界质量规划已启动（单步只读 / ${batchImages.length} 张实图；当前轮次 ${roundNumber}）`,
    );

    const parseAndValidate = (rawText: string): FollowupAction => {
      const parsed = boundedOptimizationDecisionSchema.parse(JSON.parse(rawText));
      const errors: string[] = [];
      if (parsed.action === 'repair') {
        if (!parsed.message?.trim()) errors.push('action="repair" 时 message 不能为空');
        if (!parsed.progress) errors.push('action="repair" 时 progress 不能为 null');
        const ev = parsed.imageEvidence || [];
        if (!ev.length) {
          errors.push('action="repair" 时 imageEvidence 至少引用 1 张本轮 PNG 文件名');
        } else {
          const invalid = ev.filter(name => !currentEvidenceSet.has(name));
          if (invalid.length) {
            errors.push(`imageEvidence 含非本轮合法文件名：${invalid.join(', ')}`);
          }
        }
      } else {
        if (!parsed.nextSteps?.length) errors.push('action="interrupt" 时 nextSteps 至少包含 1 条可执行建议');
        if (!parsed.userSummary) errors.push('action="interrupt" 时 userSummary 不能为 null');
      }
      if (errors.length) {
        throw new Error(errors.join('；'));
      }

      const normalized: FollowupAction =
        parsed.action === 'repair'
          ? {
              action: 'repair',
              reason: parsed.reason,
              evidence: [hostTaskEvidenceId, hostReportEvidenceId],
              message: parsed.message!.trim(),
              imageEvidence: [...new Set(parsed.imageEvidence!)],
              progress: {
                ...parsed.progress!,
                // Initial baseline cannot claim improvement over a previous repair round.
                improved: roundNumber === 0 ? false : parsed.progress!.improved,
              },
            }
          : {
              action: 'interrupt',
              reason: parsed.reason,
              evidence: [hostTaskEvidenceId, hostReportEvidenceId],
              nextSteps: parsed.nextSteps!,
              userSummary: parsed.userSummary!,
            };

      return validateAction(normalized, currentEvidenceNames, observations);
    };

    const outputSchema = z.toJSONSchema(boundedOptimizationDecisionSchema);
    const validated = await runBoundedBatchWithRecovery({
      codex,
      threadOptions,
      task,
      store,
      capture: usage,
      signal,
      outputSchema,
      prompt: promptSections,
      images: batchImages,
      batchLabel: `第 ${roundNumber} 轮质量规划`,
      retryEventPrefix: '有界质量规划批次重试 1/1',
      repairEventPrefix: '有界质量规划结果修正 1/1',
      onThreadStarted: threadId => {
        if (task.followup) {
          task.followup.threadId = threadId;
          store.put(task);
        }
        store.event(task.id, 'Codex 有界质量规划会话：' + threadId);
      },
      buildRepairPrompt: errMsg =>
        `上一轮 JSON 输出未通过宿主严格校验：${errMsg}\n请仅修正出错字段，保持简体中文输出完整合法 JSON。本轮允许填入 imageEvidence 的裸文件名：[${currentEvidenceNames.join(', ')}]`,
      parseAndValidate,
    });

    assertActionAllowed();
    task.followup.lastAction = validated;
    store.put(task);
    store.event(task.id, `AI 决策：${JSON.stringify(validated)}`);
    return validated;
  } catch (error) {
    assertActionAllowed();
    if (error instanceof ModelBudgetExceeded) throw error;
    throw usage?.error || error;
  } finally {
    await usage?.close();
    const current = store.task(task.id);
    if (current && ['cancelling', 'cancelled'].includes(current.status)) {
      task.status = current.status;
    }
    task.followup.tokens =
      priorTokens +
      store.usage
        .entries(task.id)
        .filter(e => e.stage === 'followup' && !priorUsage.has(`${e.source}:${e.id}`))
        .reduce((total, e) => total + (e.tokens?.input || 0) + (e.tokens?.output || 0), 0);
    store.put(task);
    retainStoppedFollowupReservations(
      task,
      store,
      new Set(
        store.usage
          .entries(task.id)
          .filter(e => e.stage === 'followup' && !priorUsage.has(`${e.source}:${e.id}`))
          .map(e => e.id),
      ),
    );
  }
}
