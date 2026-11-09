import { runEvaluationAgent, agentVersion } from './lib/agent.js';
import { Store, LostLease } from './lib/store.js';
import { Vault } from './lib/vault.js';
import { Artifacts } from './lib/artifacts.js';
import { collectEvidence, collectorVersion } from './lib/collector.js';
import { scoreEvidence, scoringReadiness } from './lib/scorer.js';
import { resolveTarget } from './lib/kooboo.js';
import { siteDomainFromUrl } from './lib/site-domain.js';
import { randomUUID } from 'node:crypto';
import { loadSop } from './lib/sop.js';
import { inspectCapture } from './lib/scorer.js';
import { executionPlan, modelTimeoutSeconds } from './lib/execution-policy.js';
import {
  captureSummary,
  captureValid,
  combinedEvidence,
  emptyPipeline,
  stepNames,
  successful,
} from './lib/pipeline.js';
import { captureErrorMessage, safeErrorMessage } from './lib/capture-error.js';
import type { CaptureCheckpoint, EvaluationStep, StepId } from '../shared/types.js';
import { inMaintenance } from './updates/maintenance.js';

export type Dependencies = {
  agent: typeof runEvaluationAgent;
  collect: typeof collectEvidence;
  score: typeof scoreEvidence;
  inspect: typeof inspectCapture;
  resolve: typeof resolveTarget;
};

/** Persistent checkpoints are independent of the browser tab displaying the platform. */
export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private stopping = false;
  private readonly dependencies: Dependencies;
  constructor(private store: Store, private vault: Vault, private artifacts: Artifacts,
    private directory: string, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = { agent: runEvaluationAgent, collect: collectEvidence, score: scoreEvidence, inspect: inspectCapture,
      resolve: resolveTarget, ...dependencies };
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort(new Error('服务正在关闭，保留步骤并重新排队'));
    await this.running;
  }
  async tick() {
    if (this.running || this.stopping || inMaintenance(this.directory)) return;
    this.running = this.execute();
    try { await this.running; }
    catch (error) { console.error('后台任务调度失败：' + safeErrorMessage(error)); }
    finally { this.running = undefined; }
  }
  get busy() { return Boolean(this.running); }
  private async execute() {
    const { store, vault, artifacts } = this;
    const settings = vault.get();
    if (settings.paused || inMaintenance(this.directory)) return;
    const owner = randomUUID();
    const job = store.claim(owner);
    if (!job) return;
    const controller = this.controller = new AbortController();
    const signal = controller.signal;
    const heartbeat = setInterval(() => {
      try { if (!store.heartbeat(job.run.id, owner)) controller.abort(new LostLease('执行租约已失效')); }
      catch { controller.abort(new LostLease('无法续期执行租约')); }
    }, 10000);
    heartbeat.unref();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const { evaluation, run } = job;
    let pipeline = run.pipeline || emptyPipeline();
    let active: EvaluationStep | null = null;
    const renewLease = () => {
      if (!store.heartbeat(run.id, owner)) throw new LostLease('执行租约已失效');
    };
    const persist = () => store.update(run.id, owner, { pipeline });
    const start = (id: StepId) => {
      active = pipeline.steps.find((step) => step.id === id)!;
      Object.assign(active, {
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        message: '',
      });
      persist();
      store.event(run.id, `${stepNames[id]}：开始`);
      return active;
    };
    const finish = (step: EvaluationStep, status: EvaluationStep['status'], message: string) => {
      Object.assign(step, {
        status,
        finishedAt: Date.now(),
        message,
        error: status === 'failed' || status === 'blocked' ? message : null,
      });
      persist();
      store.event(run.id, `${stepNames[step.id]}：${message}`);
      active = null;
    };
    try {
      const found = store.getRule(evaluation.submission.ruleSetVersion || 'visual-v1');
      if (!found) throw new Error('任务规则版本未发布');
      const sop = loadSop(found.rule.executor === 'agent');
      if (
        run.snapshot &&
        (run.snapshot.ruleHash !== found.hash || run.snapshot.collector !== collectorVersion)
      ) {
        pipeline = emptyPipeline();
        store.event(run.id, '规则或采集器已变化，已清空复用计划');
      } else if (run.snapshot && run.snapshot.sop?.hash !== sop.hash) {
        // New instructions invalidate observations and conclusions, not unchanged
        // screenshot pixels or preparation. The agent rechecks artifacts and views
        // them again; its viewed set is always local to the new invocation.
        pipeline.scoredReport = null;
        if (pipeline.retryMode === 'score' || pipeline.retryMode === 'report') pipeline.retryMode = 'check';
        if (pipeline.agent) pipeline.agent.reviews = {};
        for (const step of pipeline.steps) {
          if (!['check', 'score', 'report'].includes(step.id)) continue;
          Object.assign(step, {
            status: 'pending', startedAt: null, finishedAt: null, error: null,
            message: 'SOP 已更新，需要重新审查与评分',
          });
          delete step.sourceRunId;
        }
        store.event(run.id, 'SOP 已更新，保留资料与截图，重新执行证据审查和评分');
      }
      const execution = executionPlan(found.rule, !!evaluation.submission.inputs.referenceUrl, settings.execution.timeoutSeconds);
      const deadline = Date.now() + execution.runBudgetMs;
      budgetTimer = setTimeout(() => controller.abort(new Error('评测超过本轮任务时限')), execution.runBudgetMs);
      budgetTimer.unref();
      const checkpoint = () => {
        signal.throwIfAborted();
        renewLease();
        if (Date.now() > deadline) throw new Error('评测超过本轮任务时限，已保留完成步骤');
      };
      store.update(run.id, owner, {
        pipeline,
        error: null,
        snapshot: {
          rule: found.rule,
          ruleHash: found.hash,
          model:
            pipeline.scoredReport && run.snapshot
              ? run.snapshot.model
              : { endpoint: settings.model.endpoint, name: settings.model.name },
          collector: collectorVersion,
          execution,
          sop: { version: sop.version, hash: sop.hash },
          executor: { provider: 'openai-compatible', model: settings.model.name, ...(found.rule.executor==='agent' ? { kind:'tool-agent' as const,version:agentVersion } : {}) },
        },
      });
      artifacts.save(evaluation.id, run.id, 'sop.json', JSON.stringify(sop));
      store.event(run.id, `本地 SOP ${sop.version}，单次采集预算 ${settings.execution.timeoutSeconds} 秒，最多 ${settings.execution.captureAttempts} 次尝试`);
      store.event(
        run.id,
        `页面导航超时 ${execution.pageInfoTimeoutSeconds} 秒，本轮预算 ${Math.ceil(
          execution.runBudgetMs / 60000
        )} 分钟`
      );
      const preparation = pipeline.steps[0];
      if (!successful(preparation.status) || !pipeline.prepared) {
        const step = start('prepare');
        pipeline.prepared = await this.dependencies.resolve(evaluation, settings, signal);
        checkpoint();
        store.bindSite(evaluation.id, siteDomainFromUrl(pipeline.prepared.targetUrl), run.id, owner);
        finish(
          step,
          pipeline.prepared.warnings.length ? 'failed' : 'completed',
          pipeline.prepared.warnings.join('；') ||
            (pipeline.prepared.readme ? '域名与资料已保存' : '域名已确认，未提供资料包')
        );
      } else
        store.bindSite(evaluation.id, siteDomainFromUrl(pipeline.prepared.targetUrl), run.id, owner);
      const prepared = pipeline.prepared!;

      if(found.rule.executor === 'agent') {
        if (!settings.model.endpoint || !settings.model.name) throw new Error('请先保存支持图片与工具调用的模型配置，再重试评测');
        const report = await this.dependencies.agent({store,artifacts,evaluation,runId:run.id,owner,pipeline,rule:found.rule,
          model:settings.model,sop,directory:this.directory,signal,deadline,settings:settings.execution,checkpoint,start,finish});
        checkpoint();
        const failed = pipeline.steps.some(s => s.status === 'failed' || s.status === 'blocked');
        store.update(run.id,owner,{report,pipeline,evidence:combinedEvidence(pipeline,found.rule,evaluation),
          status:failed?'failed':'completed',error:failed?'部分步骤未完成，成功证据已保存，可重试失败步骤':null});
        return;
      }

      for (const role of ['target', 'reference'] as const) {
        const step = start(role);
        if (role === 'reference' && !evaluation.submission.inputs.referenceUrl) {
          finish(step, 'skipped', '未提供参考站');
          continue;
        }
        for (const viewport of found.rule.viewports) {
          let capture = pipeline.captures.find(
            (item) => item.role === role && item.viewport === viewport.id
          );
          if (
            capture &&
            successful(capture.status) &&
            captureValid(capture.evidence, role, viewport.id)
          ) {
            const filesPresent = capture.evidence!.screenshots.every(
              (shot) =>
                !!artifacts.get(
                  evaluation.id,
                  shot.sourceRunId || capture!.sourceRunId || run.id,
                  shot.file
                )
            );
            if (filesPresent) {
              store.event(
                run.id,
                `${role === 'target' ? '生成站' : '参考站'} ${viewport.id}：复用已保存证据`
              );
              continue;
            }
            capture.status = 'failed';
            capture.error = '截图文件已丢失，需要重新采集';
            pipeline.scoredReport = null;
            for (const downstream of pipeline.steps.filter(
              (item) => item.id === 'check' || item.id === 'score'
            ))
              downstream.status = 'pending';
          }
          if (!['all', 'failed', 'prepare', role].includes(pipeline.retryMode)) {
            if (!capture) {
              capture = {
                role,
                viewport: viewport.id,
                status: 'failed',
                evidence: null,
                error: '缺少可复用证据，请重试采集',
                startedAt: null,
                finishedAt: Date.now(),
              };
              pipeline.captures.push(capture);
            }
            continue;
          }
          checkpoint();
          if (!capture) {
            capture = {
              role,
              viewport: viewport.id,
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
            evidence: null,
            error: null,
            startedAt: Date.now(),
            finishedAt: null,
            sourceRunId: run.id,
          });
          persist();
          const currentCapture: CaptureCheckpoint = capture;
          const captureSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.execution.timeoutSeconds * 1000)]);
          try {
            currentCapture.evidence = await this.dependencies.collect({
              ...prepared,
              readme: null,
              warnings: [],
              roles: [role],
              referenceUrl: evaluation.submission.inputs.referenceUrl,
              scope: evaluation.submission.scope,
              rule: { ...found.rule, viewports: [viewport] },
              evaluationId: evaluation.id,
              runId: run.id,
              deadline: Math.min(deadline, Date.now() + settings.execution.timeoutSeconds * 1000),
              signal: captureSignal, artifacts, directory: this.directory, maxAttempts: settings.execution.captureAttempts,
              review: (evidence) => this.dependencies.inspect(evidence, found.rule, settings.model,
                artifacts, evaluation.id, run.id, captureSignal, undefined, sop),
              onCheckpoint: checkpoint,
              onProgress: (message, evidence) => {
                currentCapture.evidence = evidence;
                store.update(run.id, owner, {
                  pipeline,
                  evidence: combinedEvidence(pipeline, found.rule, evaluation),
                });
                store.event(run.id, message);
              },
            });
            checkpoint();
            currentCapture.status = captureValid(currentCapture.evidence, role, viewport.id)
              ? 'completed'
              : 'failed';
            currentCapture.error =
              currentCapture.status === 'failed'
                ? currentCapture.evidence.issues.find((issue) => issue.dimension === role)?.detail ||
                  '未取得可信页面证据'
                : null;
          } catch (error) {
            if (error instanceof LostLease || signal.aborted) throw error;
            currentCapture.status = 'failed';
            currentCapture.error = captureErrorMessage(error);
            if (
              currentCapture.evidence &&
              !currentCapture.evidence.issues.some((issue) => issue.dimension === role)
            )
              currentCapture.evidence.issues.push({
                severity: 'major',
                dimension: role,
                title: '采集未完整完成',
                detail: currentCapture.error,
                evidence: [`${role}-${viewport.id}-top`],
                capture: { role, viewport: viewport.id, stage: '采集' },
              });
          }
          currentCapture.finishedAt = Date.now();
          store.update(run.id, owner, {
            pipeline,
            evidence: combinedEvidence(pipeline, found.rule, evaluation),
          });
          store.event(
            run.id,
            `${role === 'target' ? '生成站' : '参考站'} ${viewport.id}：${
              currentCapture.error || '证据已保存'
            }`
          );
        }
        const captures = pipeline.captures.filter((capture) => capture.role === role);
        const failed = captures.filter((capture) => !successful(capture.status));
        finish(
          step,
          failed.length
            ? 'failed'
            : captures.every((capture) => capture.status === 'reused')
            ? 'reused'
            : 'completed',
          captureSummary(captures) +
            (failed.length
              ? `；${failed
                  .map((capture) => `${capture.viewport}：${capture.error || '采集未完成'}`)
                  .join('；')}`
              : '')
        );
      }
      const evidence = combinedEvidence(pipeline, found.rule, evaluation);
      store.update(run.id, owner, { evidence, status: 'scoring' });
      const readiness = scoringReadiness(evidence, found.rule);
      if (!successful(pipeline.steps.find((step) => step.id === 'check')!.status)) {
        const step = start('check');
        finish(
          step,
          readiness.willCallModel ? 'completed' : 'blocked',
          readiness.willCallModel
            ? readiness.referenceAvailable
              ? '生成站与参考站证据可用于评分'
              : '资料可用于完成度评分，还原度暂不可评估'
            : !readiness.targetAvailable
            ? '生成站缺少可信证据，请重试生成站采集'
            : '参考站证据不足且无可用资料，请重试参考站采集或资料准备'
        );
      }
      if (!pipeline.scoredReport) {
        const step = start('score');
        if (pipeline.retryMode === 'report')
          throw new Error('已保存的评分证据不再完整，请重试采集后再评分');
        if (!readiness.willCallModel) {
          pipeline.scoredReport = await this.dependencies.score(
            evidence,
            found.rule,
            settings.model,
            evaluation.id,
            run.id, settings.execution.timeoutSeconds, artifacts, signal, sop
          );
          finish(step, 'blocked', '证据检查未通过，未调用模型');
        } else {
          if (!settings.model.endpoint || !settings.model.name)
            throw new Error('请先保存模型配置，再重试模型评分');
          checkpoint();
          store.event(run.id, `正在调用评分模型 ${settings.model.name}`);
          const remaining = Math.min(settings.execution.timeoutSeconds, modelTimeoutSeconds, Math.floor((deadline - Date.now()) / 1000));
          if (remaining < 1) throw new Error('评测超过本轮任务时限');
          pipeline.scoredReport = await this.dependencies.score(
            evidence,
            found.rule,
            settings.model,
            evaluation.id,
            run.id,
            remaining, artifacts, signal, sop
          );
          checkpoint();
          finish(step, 'completed', '模型结果已校验并保存');
        }
      }
      const reportStep = start('report');
      const failed = pipeline.steps.some(
        (step) => step.status === 'failed' || step.status === 'blocked'
      );
      finish(
        reportStep,
        'completed',
        pipeline.scoredReport.model.name === '未调用'
          ? '诊断报告已保存，尚未生成评分'
          : '评分报告已保存'
      );
      store.update(run.id, owner, {
        report: pipeline.scoredReport,
        pipeline,
        status: failed ? 'failed' : 'completed',
        error: failed ? '部分步骤未完成，可在阶段面板重试并复用成功证据' : null,
      });
    } catch (error) {
      if (error instanceof LostLease || signal.reason instanceof LostLease) return;
      if (this.stopping) {
        try {
          if (active) Object.assign(active, { status: 'pending', message: '服务停止，等待恢复', error: null });
          store.update(run.id, owner, { pipeline, status: 'queued', error: null });
          store.event(run.id, '服务已停止，完成步骤已保存，启动后继续执行');
        } catch { /* Lease already transferred. */ }
        return;
      }
      const message = safeErrorMessage(error).slice(0, 800);
      try {
        active ||= pipeline.steps.find(s=>s.status==='running') || pipeline.steps.find(s=>s.status==='pending') || null;
        if (active) {
          Object.assign(active, {
            status: 'failed',
            error: message,
            message,
            finishedAt: Date.now(),
          });
          const index = pipeline.steps.indexOf(active);
          for (const step of pipeline.steps.slice(index + 1))
            if (step.status === 'pending')
              Object.assign(step, {
                status: 'blocked',
                message: '等待前置步骤完成',
                error: '等待前置步骤完成',
              });
        }
        store.update(run.id, owner, { pipeline, status: 'failed', error: message });
        store.event(run.id, message);
      } catch {
        /* A stale owner must not write. */
      }
    } finally {
      clearInterval(heartbeat);
      if (budgetTimer) clearTimeout(budgetTimer);
      this.controller = undefined;
    }
  }
}
