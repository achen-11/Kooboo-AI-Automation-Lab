import type {
  CaptureCheckpoint,
  Evaluation,
  Evidence,
  Pipeline,
  RetryMode,
  RuleSet,
  Run,
  StepId,
} from '../../shared/types.js';

export const stepNames: Record<StepId, string> = {
  prepare: '资料准备',
  target: '生成站采集',
  reference: '参考站采集',
  check: '证据检查',
  score: '模型评分',
  report: '报告输出',
};
export const stepIds: StepId[] = ['prepare', 'target', 'reference', 'check', 'score', 'report'];
export const successful = (status: string) => status === 'completed' || status === 'reused';

export function emptyPipeline(mode: RetryMode = 'all'): Pipeline {
  return {
    version: 1,
    retryMode: mode,
    prepared: null,
    captures: [],
    scoredReport: null,
    steps: stepIds.map((id) => ({
      id,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      message: '',
      error: null,
    })),
  };
}

/** A diagnostic image without verified metadata must never become a reusable scoring capture. */
export function captureValid(
  evidence: Evidence | null,
  role: 'target' | 'reference',
  viewport: string
): boolean {
  return (
    !!evidence?.screenshots.some((shot) => shot.role === role && shot.viewport === viewport) &&
    !evidence.issues.some((issue) => issue.dimension === role)
  );
}

/** Capture integrity and requested-scope coverage are separate. Legacy scope-only
 * failures cannot be promoted without an explicit completed capture checkpoint. */
export function captureEvidenceComplete(
  evidence: Evidence | null,
  role: 'target' | 'reference',
  viewport: string
): boolean {
  if (!captureValid(evidence, role, viewport) || !evidence) return false;
  const coverage = evidence.coverage;
  const complete = coverage.captureComplete ?? coverage.complete;
  return complete &&
    (coverage.requested !== coverage.actual || coverage.complete) &&
    !evidence.screenshots.some((shot) => shot.diagnostic) &&
    !evidence.issues.some((issue) => issue.dimension === 'coverage' || issue.dimension === role);
}

/** Upgrade old records in memory only. Every issue is scoped back to its own site/viewport. */
export function legacyPipeline(run: Run, evaluation: Evaluation, rule: RuleSet): Pipeline {
  const pipeline = emptyPipeline();
  const evidence = run.evidence;
  if (!evidence) return pipeline;
  pipeline.prepared = {
    targetUrl: evidence.targetUrl,
    readme: evidence.readme,
    warnings: evidence.issues
      .filter((issue) => issue.dimension === 'materials')
      .map((issue) => issue.detail),
  };
  // Legacy runs did not checkpoint preparation; missing requested material must be retried.
  if (!evaluation.submission.inputs.materialsPath || evidence.readme)
    pipeline.steps[0].status = 'completed';
  for (const role of ['target', 'reference'] as const) {
    if (role === 'reference' && !evaluation.submission.inputs.referenceUrl) continue;
    for (const viewport of rule.viewports) {
      const prefix = `${role}-${viewport.id}-`;
      const issues = evidence.issues.filter((issue) =>
        issue.capture
          ? issue.capture.role === role && issue.capture.viewport === viewport.id
          : issue.evidence.some((id) => id.startsWith(prefix)) ||
            (issue.dimension === role &&
              !issue.evidence.some((id) => /^(target|reference)-(desktop|mobile)-/.test(id)))
      );
      const fragment: Evidence = {
        ...evidence,
        issues,
        readme: null,
        screenshots: evidence.screenshots.filter(
          (shot) => shot.role === role && shot.viewport === viewport.id
        ),
        // Legacy aggregate stability cannot prove the condition of a single capture.
        stable: evidence.stable,
        coverage: {
          ...evidence.coverage,
          complete:
            evaluation.submission.scope === 'homepage' &&
            !issues.some((issue) => ['coverage', 'target', 'reference'].includes(issue.dimension)),
        },
      };
      pipeline.captures.push({
        role,
        viewport: viewport.id,
        evidence: fragment,
        status: captureValid(fragment, role, viewport.id) ? 'completed' : 'failed',
        error: issues.find((issue) => issue.dimension === role)?.detail || null,
        startedAt: null,
        finishedAt: null,
      });
    }
  }
  return pipeline;
}

/** Each retry is a new immutable run. Only upstream or unrelated successful work survives. */
export function retryPipeline(
  run: Run,
  evaluation: Evaluation,
  rule: RuleSet,
  mode: RetryMode
): Pipeline {
  if (mode === 'all') return emptyPipeline(mode);
  const previous = run.pipeline || legacyPipeline(run, evaluation, rule);
  const next = emptyPipeline(mode);
  next.sourceRunId = run.id;
  if (
    mode !== 'prepare' &&
    successful(previous.steps.find((step) => step.id === 'prepare')?.status || '')
  ) {
    next.prepared = previous.prepared;
    const step = next.steps[0];
    Object.assign(step, {
      status: 'reused',
      sourceRunId: run.id,
      message: '复用已保存的资料',
      finishedAt: Date.now(),
    });
  }
  for (const capture of previous.captures) {
    if (mode === 'prepare' || mode === capture.role) continue;
    if (
      !successful(capture.status) ||
      !captureValid(capture.evidence, capture.role, capture.viewport)
    ) {
      if (mode !== 'failed')
        next.captures.push({
          ...capture,
          evidence: capture.evidence && {
            ...capture.evidence,
            screenshots: capture.evidence.screenshots.map((shot) => ({
              ...shot,
              sourceRunId: shot.sourceRunId || capture.sourceRunId || run.id,
            })),
          },
        });
      continue;
    }
    const sourceRunId = capture.sourceRunId || run.id;
    next.captures.push({
      ...capture,
      status: 'reused',
      sourceRunId,
      evidence: capture.evidence && {
        ...capture.evidence,
        screenshots: capture.evidence.screenshots.map((shot) => ({
          ...shot,
          sourceRunId: shot.sourceRunId || sourceRunId,
        })),
      },
    });
  }
  if (
    (mode === 'report' ||
      (mode === 'failed' &&
        successful(previous.steps.find((step) => step.id === 'score')?.status || '') &&
        previous.steps
          .filter((step) => step.status === 'failed' || step.status === 'blocked')
          .every((step) => step.id === 'report'))) &&
    previous.scoredReport
  ) {
    next.scoredReport = previous.scoredReport;
    for (const id of ['check', 'score'] as const) {
      const prior = previous.steps.find((step) => step.id === id)!;
      if (successful(prior.status))
        Object.assign(next.steps.find((step) => step.id === id)!, prior, {
          status: 'reused',
          sourceRunId: run.id,
        });
    }
  }
  if(previous.agent) next.agent = {version:1,iterations:0,calls:[],usage:{},artifacts:[],captureAttempts:{},reviews:Object.fromEntries(
    next.captures.filter(c=>successful(c.status)).flatMap(c=>{const key=`${c.role}-${c.viewport}`;const review=previous.agent!.reviews[key];return mode!=='check'&&review?.usable?[[key,review]]:[];})
  )};
  return next;
}

export function combinedEvidence(
  pipeline: Pipeline,
  rule: RuleSet,
  evaluation: Evaluation
): Evidence {
  const fragments = pipeline.captures.flatMap((capture) =>
    capture.evidence ? [capture.evidence] : []
  );
  const target =
    pipeline.captures.find((capture) => capture.role === 'target' && capture.viewport === 'desktop')
      ?.evidence || pipeline.captures.find((capture) => capture.role === 'target')?.evidence;
  const issues = fragments.flatMap((fragment) => fragment.issues);
  for (const warning of pipeline.prepared?.warnings || [])
    issues.push({
      severity: 'major',
      dimension: 'materials',
      title: '资料读取不完整',
      detail: warning,
      evidence: ['materials-unavailable'],
    });
  const targetComplete = rule.viewports.every((viewport) =>
    pipeline.captures.some(
      (capture) =>
        capture.role === 'target' &&
        capture.viewport === viewport.id &&
        captureValid(capture.evidence, 'target', viewport.id)
    )
  );
  const captureComplete = ['target', ...(evaluation.submission.inputs.referenceUrl ? ['reference'] : [])]
    .every((role) => rule.viewports.every((viewport) => pipeline.captures.some((capture) =>
      capture.role === role && capture.viewport === viewport.id && successful(capture.status) &&
      captureEvidenceComplete(capture.evidence, capture.role, viewport.id)
    )));
  const scopeNote = evaluation.submission.scope === 'site'
    ? '本轮请求全站，实际仅采集首页；只能评估首页静态视觉，全站覆盖尚未完成。'
    : '';
  return {
    targetUrl: pipeline.prepared?.targetUrl || evaluation.targetUrl || '',
    targetTitle: target?.targetTitle || '',
    text: target?.text || '',
    readme: pipeline.prepared?.readme || null,
    screenshots: fragments.flatMap((fragment) => fragment.screenshots),
    issues,
    fingerprint: target?.fingerprint || '',
    stable: fragments.length > 0 && fragments.every((fragment) => fragment.stable),
    health: !targetComplete
      ? 'unknown'
      : issues.some((issue) => issue.dimension === 'health' && issue.severity === 'critical')
      ? 'critical'
      : issues.some((issue) => issue.dimension === 'health')
      ? 'warning'
      : 'ok',
    coverage: {
      requested: evaluation.submission.scope,
      actual: 'homepage',
      complete: evaluation.submission.scope === 'homepage' && captureComplete,
      captureComplete,
      note: [scopeNote, fragments[0]?.coverage.note || '尚未取得页面证据'].filter(Boolean).join(' '),
    },
  };
}

export function captureSummary(captures: CaptureCheckpoint[]): string {
  const count = captures.filter((capture) => successful(capture.status)).length;
  const reused = captures.filter((capture) => capture.status === 'reused').length;
  return `${count}/${captures.length} 个视口可用${
    reused ? `，复用 ${reused} 个` : ''
  }；${captures.reduce((n, capture) => n + (capture.evidence?.screenshots.length || 0), 0)} 张截图`;
}
