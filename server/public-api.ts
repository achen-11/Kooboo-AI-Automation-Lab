import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Evaluation, Run } from '../shared/types.js';
import { scoringStatus } from '../shared/result.js';
import { normalizeSiteDomain } from './lib/site-domain.js';
import type { Store } from './lib/store.js';
import type { Vault } from './lib/vault.js';
import type { Artifacts } from './lib/artifacts.js';

const detail = z.enum(['summary', 'report', 'full']).default('summary');
const page = { page: z.coerce.number().int().min(1).max(1000000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) };
const bool = z.enum(['true', 'false']);
const timestamp = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const domain = z.string().max(2048).transform((value, ctx) => {
  try { return normalizeSiteDomain(value); }
  catch { ctx.addIssue({ code: 'custom', message: '生成站域名无效' }); return z.NEVER; }
});
const querySchema = z.object({
  ...page, detail, domain: domain.optional(), jobId: z.string().min(1).max(200).optional(),
  requestId: z.string().min(1).max(200).optional(), attemptId: z.string().min(1).max(200).optional(),
  status: z.enum(['queued', 'collecting', 'scoring', 'completed', 'failed']).optional(),
  scoringStatus: z.enum(['pending', 'failed', 'unscored', 'partial', 'scored']).optional(),
  needsReview: bool.optional(), latestPerSite: bool.default('false'),
  fidelityBelow: z.coerce.number().min(0).max(101).optional(), ruleSetVersion: z.string().min(1).max(80).optional(),
  createdFrom: timestamp.optional(), createdBefore: timestamp.optional(),
  updatedSince: timestamp.optional(), updatedBefore: timestamp.optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict().superRefine((input, ctx) => {
  for (const [from, before] of [[input.createdFrom, input.createdBefore], [input.updatedSince, input.updatedBefore]]) {
    if (from !== undefined && before !== undefined && from >= before) ctx.addIssue({ code: 'custom', message: '时间范围起点必须小于终点' });
  }
  if (input.detail === 'full' && input.pageSize > 10) ctx.addIssue({ code: 'custom', message: 'full 颗粒度 pageSize 不能大于 10' });
});
const idParams = z.object({ id: z.string().uuid() });
const runParams = idParams.extend({ runId: z.string().uuid() });
const resultPage = <T>(items: T[], input: { page: number; pageSize: number }) => ({
  apiVersion: 1, items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
  total: items.length, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < items.length,
});

/** Deliberately project public data: never serialize vault settings or private agent file paths. */
export function registerPublicApi(app: FastifyInstance, store: Store, vault: Vault, artifacts: Artifacts) {
  function updatedAt(item: Evaluation) {
    const row = store.db.prepare(`SELECT MAX(value) AS value FROM (
      SELECT ? AS value UNION ALL SELECT ? UNION ALL
      SELECT MAX(occurred_at) FROM events WHERE run_id IN (SELECT id FROM runs WHERE evaluation_id=?) UNION ALL
      SELECT MAX(created_at) FROM reviews WHERE run_id IN (SELECT id FROM runs WHERE evaluation_id=?) UNION ALL
      SELECT MAX(updated_at) FROM issue_decisions WHERE run_id IN (SELECT id FROM runs WHERE evaluation_id=?) UNION ALL
      SELECT MAX(updated_at) FROM issue_handoffs WHERE run_id IN (SELECT id FROM runs WHERE evaluation_id=?)
    )`).get(item.createdAt, item.run.updatedAt, item.id, item.id, item.id, item.id);
    return Number(row.value);
  }
  function snapshot(run: Run) {
    const source = run.snapshot;
    return source ? { rule: source.rule, ruleHash: source.ruleHash, model: { name: source.model.name }, collector: source.collector, sop: source.sop, executor: source.executor, execution: source.execution } : null;
  }
  function evidence(run: Run) {
    const source = run.evidence;
    return source ? { ...source, screenshots: source.screenshots.map(({ file, ...shot }) => ({
      ...shot, artifactUrl: `/api/v1/evaluations/${run.evaluationId}/runs/${run.id}/artifacts/${encodeURIComponent(file)}`,
    })) } : null;
  }
  function projectRun(run: Run, level: z.infer<typeof detail>) {
    const report = run.report;
    return {
      runId: run.id, evaluationId: run.evaluationId, status: run.status, scoringStatus: scoringStatus(run),
      createdAt: run.createdAt, updatedAt: run.updatedAt, error: run.error,
      fidelityScore: report?.fidelityScore ?? null, completionScore: report?.completionScore ?? null,
      confidence: report?.confidence ?? null, coverage: report?.coverage ?? run.evidence?.coverage ?? null,
      modelName: run.snapshot?.model.name ?? report?.model.name ?? null,
      ruleSetVersion: run.snapshot?.rule.version ?? null,
      ...(level !== 'summary' ? { report } : {}),
      ...(level === 'full' ? {
        evidence: evidence(run), snapshot: snapshot(run), stages: run.pipeline?.steps ?? [], actions: store.issueActions(run.id),
        captures: (run.pipeline?.captures ?? []).map(capture => ({ ...capture, evidence: evidence({ ...run, evidence: capture.evidence }) })),
      } : {}),
    };
  }
  function project(item: Evaluation, level: z.infer<typeof detail>, changedAt = updatedAt(item)) {
    return {
      ...projectRun(item.run, level), evaluationId: item.id, jobId: item.submission.jobId,
      requestId: item.submission.requestId, attemptId: item.submission.attemptId,
      siteDomain: item.siteDomain, siteId: item.submission.target.siteId, koobooOrigin: item.submission.target.koobooOrigin,
      targetUrl: item.targetUrl, scope: item.submission.scope, occurredAt: item.submission.occurredAt,
      createdAt: item.createdAt, updatedAt: changedAt, needsReview: item.needsReview, review: item.review,
      ruleSetVersion: item.run.snapshot?.rule.version ?? item.submission.ruleSetVersion ?? null,
      reportUrl: `/#/evaluations/${item.id}`,
      ...(level === 'full' ? { submission: item.submission } : {}),
    };
  }
  function findRun(id: string, runId: string) {
    return store.get(id) ? store.history(id).find(run => run.id === runId) : undefined;
  }

  app.get('/api/v1/evaluations', async request => {
    const input = querySchema.parse(request.query), threshold = vault.get().threshold;
    const filtered = store.list(threshold, input.latestPerSite === 'true').map(item => ({ item, changedAt: updatedAt(item) })).filter(({ item, changedAt }) => {
      const submission = item.submission;
      if (input.domain !== undefined && item.siteDomain !== input.domain) return false;
      if (input.jobId !== undefined && submission.jobId !== input.jobId) return false;
      if (input.requestId !== undefined && submission.requestId !== input.requestId) return false;
      if (input.attemptId !== undefined && submission.attemptId !== input.attemptId) return false;
      if (input.status !== undefined && item.run.status !== input.status) return false;
      if (input.scoringStatus !== undefined && scoringStatus(item.run) !== input.scoringStatus) return false;
      if (input.needsReview !== undefined && item.needsReview !== (input.needsReview === 'true')) return false;
      if (input.ruleSetVersion !== undefined && (item.run.snapshot?.rule.version ?? submission.ruleSetVersion) !== input.ruleSetVersion) return false;
      if (input.fidelityBelow !== undefined && (item.run.report?.fidelityScore == null || item.run.report.fidelityScore >= input.fidelityBelow)) return false;
      if (input.createdFrom !== undefined && item.createdAt < input.createdFrom) return false;
      if (input.createdBefore !== undefined && item.createdAt >= input.createdBefore) return false;
      if (input.updatedSince !== undefined && changedAt < input.updatedSince) return false;
      if (input.updatedBefore !== undefined && changedAt >= input.updatedBefore) return false;
      return true;
    }).sort((a, b) => (a.item.createdAt - b.item.createdAt || a.item.id.localeCompare(b.item.id)) * (input.order === 'asc' ? 1 : -1));
    const response = resultPage(filtered, input);
    return { ...response, generatedAt: Date.now(), items: response.items.map(({ item, changedAt }) => project(store.get(item.id, threshold)!, input.detail, changedAt)) };
  });
  app.get('/api/v1/evaluations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = z.object({ detail: detail.removeDefault().default('report') }).strict().parse(request.query);
    const item = store.get(id, vault.get().threshold);
    return item ? { apiVersion: 1, ...project(item, input.detail) } : reply.code(404).send({ error: '评测不存在' });
  });
  app.get('/api/v1/evaluations/:id/runs', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = z.object({ ...page, detail }).strict().superRefine((value, ctx) => {
      if (value.detail === 'full' && value.pageSize > 10) ctx.addIssue({ code: 'custom', message: 'full 颗粒度 pageSize 不能大于 10' });
    }).parse(request.query);
    if (!store.get(id)) return reply.code(404).send({ error: '评测不存在' });
    const response = resultPage(store.history(id), input);
    return { ...response, items: response.items.map(run => projectRun(run, input.detail)) };
  });
  app.get('/api/v1/evaluations/:id/runs/:runId/events', async (request, reply) => {
    const { id, runId } = runParams.parse(request.params);
    const input = z.object({ ...page, afterSeq: timestamp.default(0) }).strict().parse(request.query);
    if (!findRun(id, runId)) return reply.code(404).send({ error: '执行轮次不存在' });
    const events = store.events(runId).filter(event => event.seq > input.afterSeq).reverse();
    return resultPage(events, input);
  });
  app.get('/api/v1/evaluations/:id/runs/:runId/report', async (request, reply) => {
    const { id, runId } = runParams.parse(request.params);
    z.object({}).strict().parse(request.query);
    const run = findRun(id, runId);
    return run?.report ? { apiVersion: 1, evaluationId: id, runId, snapshot: snapshot(run), report: run.report } : reply.code(404).send({ error: '本轮尚无报告' });
  });
  app.get('/api/v1/evaluations/:id/runs/:runId/artifacts/:file', async (request, reply) => {
    const { id, runId, file } = runParams.extend({ file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,200}\.png$/) }).parse(request.params);
    z.object({}).strict().parse(request.query);
    const run = findRun(id, runId);
    const screenshots = [...(run?.evidence?.screenshots ?? []), ...(run?.pipeline?.captures.flatMap(capture => capture.evidence?.screenshots ?? []) ?? [])];
    const shot = screenshots.find(shot => shot.file === file);
    if (!shot) return reply.code(404).send({ error: '证据不存在' });
    const content = artifacts.get(id, shot.sourceRunId || runId, file);
    return content ? reply.type('image/png').send(Buffer.from(content, 'base64')) : reply.code(404).send({ error: '证据文件已丢失' });
  });
}
