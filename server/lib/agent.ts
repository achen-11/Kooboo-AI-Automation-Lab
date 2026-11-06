import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  AgentState,
  CaptureCheckpoint,
  Evaluation,
  EvaluationStep,
  Evidence,
  Pipeline,
  Report,
  RuleSet,
  RuntimeSettings,
  Screenshot,
  StepId,
} from '../../shared/types.js';
import type { Store } from './store.js';
import { LostLease } from './store.js';
import type { Artifacts } from './artifacts.js';
import type { Sop } from './sop.js';
import { collectEvidence } from './collector.js';
import { captureEvidenceComplete, combinedEvidence, successful } from './pipeline.js';
import { modelResultSchema } from './validation.js';
import { scoringInstructions } from './rules.js';
import { scoringReadiness, weightedScore } from './scorer.js';
import { requestAgentCompletion, type AgentCompletionRequest } from './model.js';
import { contactSheet, imageHash } from './agent-images.js';
import { safeErrorMessage } from './capture-error.js';

export const agentVersion = 'tool-agent-v1';
const roleSchema = z.enum(['target', 'reference']);
const viewportSchema = z.enum(['desktop', 'mobile']);
const idsSchema = z.array(z.string().min(1).max(150)).min(1).max(20);
const homepageLimitation = '本轮请求全站，但实际仅采集首页；分数仅适用于已采集首页，不代表全站 UI 还原度、任务完成度或交互验收。';
const schemas = {
  get_task: z.object({}).strict(),
  capture_page: z
    .object({
      role: roleSchema,
      viewport: viewportSchema,
      force: z.boolean().optional(),
      waitMs: z.number().int().min(0).max(10000).optional(),
      scrollWaitMs: z.number().int().min(100).max(2000).optional(),
    })
    .strict(),
  read_images: z
    .object({
      ids: z.array(z.string().min(1).max(150)).min(1).max(6),
      mode: z.enum(['overview', 'original']),
    })
    .strict(),
  submit_review: z
    .object({
      role: roleSchema,
      viewport: viewportSchema,
      usable: z.boolean(),
      reason: z.string().min(1).max(2000),
      evidence: idsSchema,
    })
    .strict(),
  submit_assessment: modelResultSchema
    .extend({
      limitations: z.array(z.string().min(1).max(2000)).min(1).max(30),
      pairings: z
        .array(
          z.object({ name: z.string().min(1).max(200), target: idsSchema, reference: idsSchema })
        )
        .max(30),
    })
    .strict(),
  report_blocked: z
    .object({
      reason: z.string().min(1).max(2000),
      limitations: z.array(z.string().max(2000)).max(30),
    })
    .strict(),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  get_task:
    'Get fixed task inputs, scoring rules, existing screenshots and capture/review checkpoints. No browser work.',
  capture_page:
    'Capture one assigned site/viewport using bounded continuous scrolling and screenshots. Reuses successful evidence unless force=true. Only assigned URLs are accessible. Tune bounded waitMs/scrollWaitMs when lazy loading needs more time.',
  read_images:
    'Actually view image pixels. Pass at most six screenshot IDs. overview combines them into a labelled contact sheet; original returns up to three full-resolution images. All IDs must be original screenshot IDs from get_task/capture_page.',
  submit_review:
    'Submit visual usability review after viewing every screenshot in that site/viewport. Can reject and request bounded recapture.',
  submit_assessment:
    'Deliver final structured report after visual review and semantic pairing. Server verifies evidence, configured dimensions and scores, then calculates weighted total and saves report.',
  report_blocked:
    'End an unrecoverable evaluation with a persisted diagnostic report. Keeps successful captures; never converts failure to zero.',
};
export const agentTools: ChatCompletionTool[] = (Object.keys(schemas) as ToolName[]).map(
  (name) => ({
    type: 'function',
    function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name]) },
  })
);

export interface AgentInput {
  store: Store;
  artifacts: Artifacts;
  evaluation: Evaluation;
  runId: string;
  owner: string;
  pipeline: Pipeline;
  rule: RuleSet;
  model: RuntimeSettings['model'];
  sop: Sop;
  directory: string;
  signal: AbortSignal;
  deadline: number;
  settings: RuntimeSettings['execution'];
  checkpoint: () => void;
  start: (id: StepId) => EvaluationStep;
  finish: (step: EvaluationStep, status: EvaluationStep['status'], message: string) => void;
  collect?: typeof collectEvidence;
  complete?: AgentCompletionRequest;
  sheet?: typeof contactSheet;
}

/** An autonomous tool loop; deterministic tools own files, status changes and score acceptance. */
export async function runEvaluationAgent(input: AgentInput): Promise<Report> {
  const { store, artifacts, evaluation, pipeline, rule, runId, owner, signal } = input;
  const complete = input.complete || requestAgentCompletion;
  const collect = input.collect || collectEvidence;
  const state: AgentState = (pipeline.agent ||= {
    version: 1,
    iterations: 0,
    calls: [],
    reviews: {},
    artifacts: [],
    usage: {},
  });
  const currentViewed = new Set<string>();
  const imageSources = new WeakMap<object, string[]>();
  let pendingViewed: string[] = [];
  let imagesThisTurn = 0;
  let final: Report | null = null;
  const captureCounts = (state.captureAttempts ||= {});
  // This is only a resume hint, never proof the current model has viewed the pixels.
  const required = [
    'target',
    ...(evaluation.submission.inputs.referenceUrl ? ['reference'] : []),
  ].flatMap((role) => rule.viewports.map((v) => `${role}-${v.id}`));
  const persist = () => {
    input.checkpoint();
    store.update(runId, owner, {
      pipeline,
      evidence: combinedEvidence(pipeline, rule, evaluation),
    });
  };
  const shots = () => pipeline.captures.flatMap((c) => c.evidence?.screenshots || []);
  const captureKey = (role: string, viewport: string) => `${role}-${viewport}`;
  const captureReady = (capture: CaptureCheckpoint | undefined) => !!capture &&
    successful(capture.status) && captureEvidenceComplete(capture.evidence, capture.role, capture.viewport);
  const canCapture = (role: 'target' | 'reference', capture: CaptureCheckpoint | undefined) =>
    ['all', 'failed', 'prepare', role].includes(pipeline.retryMode) || !captureReady(capture);
  const step = (id: StepId) => pipeline.steps.find((s) => s.id === id)!;
  const source = (shot: Screenshot) => {
    const value = artifacts.get(evaluation.id, shot.sourceRunId || runId, shot.file);
    if (!value) throw Error(`截图文件已丢失：${shot.id}，请重新采集`);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw Error(`截图格式无效：${shot.id}`);
    if (shot.sha256 && imageHash(bytes) !== shot.sha256) throw Error(`截图已变化：${shot.id}`);
    return value;
  };
  // Validate reusable checkpoints against actual artifacts, not the earlier success label.
  for (const capture of pipeline.captures) {
    if (!successful(capture.status) || !capture.evidence) continue;
    try {
      if (!captureEvidenceComplete(capture.evidence, capture.role, capture.viewport))
        throw Error('采集证据未完整完成');
      capture.evidence.screenshots.forEach(source);
    } catch {
      capture.status = 'failed';
      capture.error = '已保存的采集证据不完整、截图不存在或校验失败，需要重新采集';
      delete state.reviews[captureKey(capture.role, capture.viewport)];
      pipeline.scoredReport = null;
      for (const id of ['check', 'score', 'report'] as const) step(id).status = 'pending';
    }
  }
  for (const role of ['target', 'reference'] as const) {
    if (role === 'reference' && !evaluation.submission.inputs.referenceUrl) {
      input.finish(step(role), 'skipped', '未提供参考站');
      continue;
    }
    const captures = rule.viewports.map((v) =>
      pipeline.captures.find((c) => c.role === role && c.viewport === v.id)
    );
    if (captures.every((c) => c && successful(c.status)))
      input.finish(
        step(role),
        captures.every((c) => c?.status === 'reused') ? 'reused' : 'completed',
        '复用已校验的截图证据'
      );
    else if (captures.some((c) => c?.status === 'failed'))
      Object.assign(step(role), {
        status: 'failed',
        error: '部分截图需要重新采集',
        message: '部分截图需要重新采集',
      });
  }
  persist();
  if (pipeline.scoredReport) {
    const s = input.start('report');
    input.finish(s, 'completed', '复用已校验评分，报告已保存');
    return pipeline.scoredReport;
  }
  const task = () => ({
    targetUrl: pipeline.prepared!.targetUrl,
    referenceUrl: evaluation.submission.inputs.referenceUrl || null,
    scope: evaluation.submission.scope,
    assessmentScope: 'homepage',
    scopeLimitations: evaluation.submission.scope === 'site' ? [homepageLimitation] : [],
    rule,
    readme: pipeline.prepared!.readme?.slice(0, 18000) || null,
    warnings: pipeline.prepared!.warnings,
    captures: pipeline.captures.map((c) => ({
      role: c.role,
      viewport: c.viewport,
      status: c.status,
      error: c.error,
      coverage: c.evidence?.coverage,
      canCapture: canCapture(c.role, c),
      captureAttemptsRemaining: Math.max(0, input.settings.captureAttempts - (captureCounts[captureKey(c.role, c.viewport)] || 0)),
      issues: c.evidence?.issues || [],
      review: state.reviews[captureKey(c.role, c.viewport)],
      screenshots:
        c.evidence?.screenshots.map((s) => ({
          id: s.id,
          region: s.region,
          pageY: s.pageY,
          width: s.width,
          height: s.height,
          capturedAt: s.capturedAt,
        })) || [],
    })),
    retryMode: pipeline.retryMode,
    limits: {
      captureAttempts: input.settings.captureAttempts,
      maxToolCalls: 120,
      maxIterations: 80,
    },
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: input.sop.documents['runtime.md'] + '\n\n' + scoringInstructions(rule) },
    { role: 'user', content: '开始执行本轮评测。任务和已有产物：\n' + JSON.stringify(task()) },
  ];
  store.event(runId, `Agent ${agentVersion} 已启动，模型 ${input.model.name}，按 SOP 自主调用工具`);

  async function executeTool(
    name: ToolName,
    raw: unknown
  ): Promise<{ value: unknown; images?: { id: string; content: string; sourceIds: string[] }[] }> {
    input.checkpoint();
    if (name === 'get_task') {
      schemas.get_task.parse(raw);
      return { value: task() };
    }
    if (name === 'capture_page') {
      const args = schemas.capture_page.parse(raw),
        key = captureKey(args.role, args.viewport);
      if (!required.includes(key)) throw Error('本轮没有该站点或视口');
      let capture = pipeline.captures.find(
        (c) => c.role === args.role && c.viewport === args.viewport
      );
      if (captureReady(capture) && !args.force)
        return {
          value: {
            reused: true,
            capture: task().captures.find((c) => captureKey(c.role, c.viewport) === key),
          },
        };
      if (!canCapture(args.role, capture))
        throw Error('本轮复用该分支的有效证据；如需强制重采，请重试对应采集阶段');
      const count = (captureCounts[key] || 0) + 1;
      if (count > input.settings.captureAttempts)
        throw Error('该视口已达到本轮采集次数上限，请报告阻塞');
      captureCounts[key] = count;
      const active = input.start(args.role);
      if (!capture) {
        capture = {
          role: args.role,
          viewport: args.viewport,
          status: 'pending',
          evidence: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        };
        pipeline.captures.push(capture);
      }
      Object.assign(capture, {
        status: 'running',
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        sourceRunId: runId,
      });
      delete state.reviews[key];
      pipeline.scoredReport = null;
      for (const id of ['check', 'score', 'report'] as const) step(id).status = 'pending';
      persist();
      const viewport = rule.viewports.find((v) => v.id === args.viewport)!;
      const captureSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(input.settings.timeoutSeconds * 1000),
      ]);
      try {
        capture.evidence = await collect({
          targetUrl: pipeline.prepared!.targetUrl,
          referenceUrl: evaluation.submission.inputs.referenceUrl,
          readme: null,
          warnings: [],
          roles: [args.role],
          rule: { ...rule, viewports: [viewport] },
          scope: evaluation.submission.scope,
          evaluationId: evaluation.id,
          runId,
          directory: input.directory,
          artifacts,
          signal: captureSignal,
          deadline: Math.min(input.deadline, Date.now() + input.settings.timeoutSeconds * 1000),
          continuous: true,
          waitStrategy: { waitMs: args.waitMs ?? 2500, scrollWaitMs: args.scrollWaitMs ?? 650 },
          attemptTag: `a${randomUUID().slice(0, 8)}`,
          maxAttempts: 1,
          onCheckpoint: input.checkpoint,
          onProgress: (message, evidence) => {
            capture!.evidence = evidence;
            persist();
            store.event(runId, message);
          },
        });
        input.checkpoint();
        const usable = captureEvidenceComplete(capture.evidence, args.role, args.viewport);
        capture.status = usable ? 'completed' : 'failed';
        capture.error = usable
          ? null
          : capture.evidence.issues.find(
              (i) => i.dimension === args.role || i.dimension === 'coverage'
            )?.detail || '当前采集覆盖不足';
      } catch (error) {
        if (signal.aborted || error instanceof LostLease) throw error;
        capture.status = 'failed';
        capture.error = safeErrorMessage(error);
      }
      capture.finishedAt = Date.now();
      persist();
      const roleCaptures = rule.viewports.map((v) =>
        pipeline.captures.find((c) => c.role === args.role && c.viewport === v.id)
      );
      if (roleCaptures.some((c) => c?.status === 'failed'))
        input.finish(active, 'failed', capture.error || '部分视口采集失败');
      else if (roleCaptures.every((c) => c && successful(c.status)))
        input.finish(active, 'completed', '连续截图已保存，等待 Agent 看图审查');
      else {
        active.message = '当前视口已保存，等待其余视口采集';
        persist();
      }
      return {
        value: { capture: task().captures.find((c) => captureKey(c.role, c.viewport) === key) },
      };
    }
    if (name === 'read_images') {
      const args = schemas.read_images.parse(raw);
      const imageCount = args.mode === 'original' ? args.ids.length : 1;
      if(imagesThisTurn + imageCount > 6) throw Error('单轮最多发送 6 幅图像，请在下一轮继续查看');
      if (args.mode === 'original' && args.ids.length > 3)
        throw Error('单次最多查看 3 张原图；概览最多 6 张');
      const selected = args.ids.map((id) => {
        const shot = shots().find((s) => s.id === id);
        if (!shot || shot.diagnostic) throw Error(`截图不存在或仅供诊断：${id}`);
        return shot;
      });
      if (new Set(args.ids).size !== args.ids.length) throw Error('截图 ID 不能重复');
      if (args.mode === 'original')
        return {
          value: { viewed: args.ids, mode: 'original' },
          images: selected.map((s) => ({ id: s.id, content: source(s), sourceIds: [s.id] })),
        };
      const filename = `agent-sheet-${imageHash(
        Buffer.from(JSON.stringify(selected.map((s) => [s.id, s.sha256, s.sourceRunId])))
      ).slice(0, 20)}.png`;
      const id = filename.slice(0, -4);
      let content = artifacts.get(evaluation.id, runId, filename);
      if (!content) {
        const bytes = await (input.sheet || contactSheet)(selected, source, signal);
        input.checkpoint();
        content = bytes.toString('base64');
        artifacts.save(evaluation.id, runId, filename, content);
        state.artifacts.push({ id, file: filename, sourceIds: args.ids, sha256: imageHash(bytes) });
        persist();
      }
      return {
        value: {
          viewed: args.ids,
          mode: 'overview',
          sheet: id,
          positions: selected.map((s, i) => ({
            number: i + 1,
            id: s.id,
            role: s.role,
            viewport: s.viewport,
            pageY: s.pageY,
          })),
          remaining: shots()
            .filter((s) => !currentViewed.has(s.id) && !args.ids.includes(s.id))
            .map((s) => s.id),
        },
        images: [{ id, content, sourceIds: args.ids }],
      };
    }
    if (name === 'submit_review') {
      const args = schemas.submit_review.parse(raw),
        key = captureKey(args.role, args.viewport);
      const capture = pipeline.captures.find(
        (c) => c.role === args.role && c.viewport === args.viewport
      );
      if (!capture?.evidence?.screenshots.length) throw Error('没有可审查的截图');
      const available = new Set(capture.evidence.screenshots.map((s) => s.id));
      if (args.evidence.some((id) => !available.has(id) || !currentViewed.has(id)))
        throw Error('审查必须引用当前模型实际看过的该视口截图');
      if (args.usable && capture.evidence.screenshots.some((s) => !currentViewed.has(s.id)))
        throw Error('该视口还有未查看的分段图，请继续 read_images');
      if (args.usable && !captureReady(capture))
        throw Error('采集尚未完整完成，请补采或报告阻塞');
      const active = input.start('check');
      state.reviews[key] = { usable: args.usable, reason: args.reason, evidence: args.evidence };
      if (!args.usable) {
        capture.status = 'failed';
        capture.error = args.reason;
        input.finish(active, 'failed', args.reason);
      } else if (required.every((key) => state.reviews[key]?.usable))
        input.finish(active, 'completed', '所有必需视口已由 Agent 实际看图并接受');
      persist();
      return {
        value: { accepted: true, remaining: required.filter((key) => !state.reviews[key]?.usable) },
      };
    }
    if (name === 'submit_assessment') {
      const args = schemas.submit_assessment.parse(raw),
        evidence = combinedEvidence(pipeline, rule, evaluation);
      for (const key of required) {
        const c = pipeline.captures.find((c) => captureKey(c.role, c.viewport) === key);
        if (
          !c ||
          !captureReady(c) ||
          !state.reviews[key]?.usable
        )
          throw Error(`尚无完整可用证据和审查：${key}`);
        c.evidence!.screenshots.forEach(source);
        if (c.evidence!.screenshots.some((s) => !currentViewed.has(s.id)))
          throw Error(`当前模型尚未看完该视口：${key}`);
      }
      const known = new Map(shots().map((s) => [s.id, s]));
      function checkIds(ids: string[], role?: string) {
        for (const id of ids) {
          const s = known.get(id);
          if (!s || s.diagnostic || !currentViewed.has(id) || (role && s.role !== role))
            throw Error(`必须引用本轮实际查看过的对应截图：${id}`);
        }
      }
      const hasReference = !!evaluation.submission.inputs.referenceUrl;
      if (hasReference) {
        weightedScore(args.dimensions, rule);
        if (!args.pairings.length) throw Error('请提交至少一组语义区域对应关系');
      } else if (args.dimensions.length) throw Error('没有参考站不能生成还原度分项');
      for (const dimension of args.dimensions) {
        checkIds(dimension.evidence);
        for (const role of ['target', 'reference'])
          if (!dimension.evidence.some((id) => known.get(id)?.role === role))
            throw Error('视觉分项必须同时引用两站截图');
        if (
          dimension.id === 'mobile' &&
          !['target', 'reference'].every((role) =>
            dimension.evidence.some(
              (id) => known.get(id)?.role === role && known.get(id)?.viewport === 'mobile'
            )
          )
        )
          throw Error('移动项必须引用两站移动图');
      }
      for (const issue of args.issues) checkIds(issue.evidence.filter((id) => id !== 'materials')); // Materials are accepted only when actually loaded.
      if (args.issues.some((i) => i.evidence.includes('materials')) && !evidence.readme)
        throw Error('没有资料证据');
      for (const pairing of args.pairings) {
        checkIds(pairing.target, 'target');
        checkIds(pairing.reference, 'reference');
      }
      store.update(runId, owner, { status: 'scoring' });
      const scoreStep = input.start('score');
      const scopeLimited = evidence.coverage.requested !== evidence.coverage.actual;
      final = {
        ...args,
        summary: scopeLimited ? `仅首页评测（全站覆盖未完成）。${args.summary}` : args.summary,
        confidence: scopeLimited && args.confidence === 'high' ? 'medium' : args.confidence,
        limitations: scopeLimited ? [...new Set([homepageLimitation, ...args.limitations])] : args.limitations,
        fidelityScore: hasReference ? weightedScore(args.dimensions, rule) : null,
        completionScore: evidence.readme && !scopeLimited ? args.completionScore : null,
        health: evidence.health,
        coverage: evidence.coverage,
        stable: evidence.stable,
        referenceStatus: scoringReadiness(evidence, rule).referenceStatus,
        calibrated: false,
        issues: [...evidence.issues, ...args.issues],
        model: { name: input.model.name, usage: { ...state.usage } },
      };
      pipeline.scoredReport = final;
      artifacts.save(evaluation.id, runId, 'agent-assessment.json', JSON.stringify(args));
      input.finish(scoreStep, 'completed', 'Agent 评分及证据引用已校验，程序完成加权计算');
      const reportStep = input.start('report');
      artifacts.save(evaluation.id, runId, 'report.json', JSON.stringify(final));
      input.finish(reportStep, 'completed', '结构化报告已保存');
      persist();
      return { value: { accepted: true, fidelityScore: final.fidelityScore } };
    }
    const args = schemas.report_blocked.parse(raw),
      evidence = combinedEvidence(pipeline, rule, evaluation);
    for (const s of pipeline.steps)
      if (s.status === 'pending' || s.status === 'running')
        Object.assign(s, {
          status: 'blocked',
          error: args.reason,
          message: args.reason,
          finishedAt: Date.now(),
        });
    final = {
      fidelityScore: null,
      completionScore: null,
      confidence: 'low',
      summary: args.reason,
      dimensions: [],
      issues: evidence.issues,
      health: evidence.health,
      coverage: evidence.coverage,
      stable: evidence.stable,
      referenceStatus: scoringReadiness(evidence, rule).referenceStatus,
      calibrated: false,
      model: { name: input.model.name, usage: { ...state.usage } },
      limitations: args.limitations,
    };
    pipeline.scoredReport = final;
    artifacts.save(evaluation.id, runId, 'report.json', JSON.stringify(final));
    const reportStep = input.start('report');
    input.finish(reportStep, 'completed', '诊断报告已保存，未生成分数');
    persist();
    return { value: { accepted: true, blocked: true } };
  }

  for (; state.iterations < 80 && !final; ) {
    input.checkpoint();
    const remaining = Math.min(
      input.settings.timeoutSeconds,
      Math.floor((input.deadline - Date.now()) / 1000)
    );
    if (remaining < 1) throw Error('Agent 执行预算已用完，已保留检查点');
    if (state.calls.length >= 120) throw Error('Agent 工具调用达到预算上限，已保存完成步骤');
    state.iterations++;
    persist();
    const response = await complete(input.model, messages, agentTools, remaining, signal);
    input.checkpoint();
    // Images count as seen only after a successful model turn consumed their messages.
    pendingViewed.forEach((id) => currentViewed.add(id));
    pendingViewed = [];
    for (const [key, value] of Object.entries(response.usage || {}))
      if (typeof value === 'number') state.usage[key] = (state.usage[key] || 0) + value;
    const message = response.choices[0]?.message;
    if (!message) throw Error('Agent 未返回有效响应');
    const calls = message.tool_calls;
    artifacts.save(
      evaluation.id,
      runId,
      `agent-turn-${state.iterations}.json`,
      JSON.stringify({ content: message.content, tool_calls: calls, usage: response.usage })
    );
    if (!calls?.length) {
      messages.push(
        { role: 'assistant', content: message.content || '' },
        {
          role: 'user',
          content: '请使用工具继续；最终报告必须通过 submit_assessment 或 report_blocked 交付。',
        }
      );
      persist();
      continue;
    }
    if (calls.length > 12 || state.calls.length + calls.length > 120)
      throw Error('Agent 工具调用达到预算上限，已保存完成步骤');
    messages.push({ role: 'assistant', content: message.content, tool_calls: calls });
    imagesThisTurn = 0;
    const images: { id: string; content: string; sourceIds: string[] }[] = [];
    for (const call of calls) {
      input.checkpoint();
      if (call.type !== 'function') throw Error('不支持的 Agent 工具类型');
      const startedAt = Date.now();
      let value: unknown,
        status: 'completed' | 'failed' = 'completed';
      const name = call.function.name;
      try {
        if (final) throw Error('报告已经提交，本轮不再执行工具');
        if (!Object.hasOwn(schemas, name)) throw Error('工具不存在');
        if (call.function.arguments.length > 100000) throw Error('工具参数过长');
        const result = await executeTool(name as ToolName, JSON.parse(call.function.arguments));
        value = result.value;
        images.push(...(result.images || []));
        imagesThisTurn += result.images?.length || 0;
      } catch (error) {
        if (signal.aborted || error instanceof LostLease) throw error;
        status = 'failed';
        value = { error: safeErrorMessage(error).slice(0, 1200) };
      }
      artifacts.save(
        evaluation.id,
        runId,
        `agent-call-${state.iterations}-${state.calls.length + 1}.json`,
        JSON.stringify({ name, arguments: call.function.arguments, status, result: value })
      );
      const text = JSON.stringify(value);
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      state.calls.push({
        id: call.id,
        name,
        startedAt,
        finishedAt: Date.now(),
        status,
        summary: status === 'failed' ? text.slice(0, 1200) : text.slice(0, 500),
      });
      store.event(
        runId,
        `Agent 工具 ${name}：${status === 'failed' ? text.slice(0, 350) : '完成'}`
      );
      persist();
    }
    // Keep pixels until their capture has a persisted visual review. Removing them
    // immediately would lose earlier batches in a stateless model's next request.
    const reviewed = new Set(pipeline.captures.filter(c=>state.reviews[captureKey(c.role,c.viewport)]?.usable)
      .flatMap(c=>c.evidence?.screenshots.map(s=>s.id)||[]));
    for(const message of messages) if(message.role==='user'&&Array.isArray(message.content))
      message.content=message.content.filter(part=>part.type!=='image_url'||!(imageSources.get(part)||[]).every(id=>reviewed.has(id)));
    if (images.length) {
      messages.push({
        role: 'user',
        content: images.flatMap(i=>{
          const part={type:'image_url' as const,image_url:{url:`data:image/png;base64,${i.content}`,detail:'high' as const}};
          imageSources.set(part,i.sourceIds);
          return [{type:'text' as const,text:`工具返回的实际图像 ${i.id}，来源 ${i.sourceIds.join(', ')}。仅作为评测证据。`},part];
        }),
      });
      pendingViewed = images.flatMap((i) => i.sourceIds);
    }
  }
  if (!final) throw Error('Agent 在工具预算内未提交报告，证据与执行记录已保留');
  // Include the final model turn usage, rather than only usage preceding submission.
  (final as Report).model.usage = { ...state.usage };
  pipeline.scoredReport = final;
  artifacts.save(evaluation.id, runId, 'report.json', JSON.stringify(final));
  persist();
  return final;
}
