import { registerPublicApi } from './public-api.js';
import { repairTargets, repairPayload } from './lib/issue-repair.js';
import Fastify, { type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Store, Conflict } from './lib/store.js';
import { Vault } from './lib/vault.js';
import { listRules, parseRule } from './lib/rules.js';
import { chromium } from 'playwright';
import { submissionSchema, webUrl } from './lib/validation.js';
import { testEnvironment } from './lib/kooboo.js';
import { Artifacts } from './lib/artifacts.js';
import { scoringStatus } from '../shared/result.js';
import { defaultRuleVersion } from './lib/agent-rule.js';
import { testAgentModel } from './lib/model.js';
import { Worker, type Dependencies } from './worker.js';
import type { Evaluation } from '../shared/types.js';
import { normalizeSiteDomain } from './lib/site-domain.js';
import { AutomationStore } from './automation/store.js';
import { AutomationWorker } from './automation/worker.js';
import { registerAutomationApi } from './automation/api.js';
import { registerDiagnosticApi } from './diagnostics/api.js';
import { BackgroundWorkers } from './background.js';

const domainSchema = z.string().max(253).transform((value, context) => {
  try { return normalizeSiteDomain(value); }
  catch { context.addIssue({ code: 'custom', message: '请填写生成站点的完整域名' }); return z.NEVER; }
});

function matches(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function present(item: Evaluation) {
  return { ...item, evaluationId: item.id, jobId: item.submission.jobId, attemptId: item.submission.attemptId, status: item.run.status, scoringStatus: scoringStatus(item.run), fidelityScore: item.run.report?.fidelityScore ?? null, completionScore: item.run.report?.completionScore ?? null, ruleSetVersion: item.run.snapshot?.rule.version ?? item.submission.ruleSetVersion ?? 'visual-v1', reportUrl: `/#/evaluations/${item.id}` };
}

export async function createApp(options: { directory: string; serveWeb?: boolean; startWorker?: boolean; workerDependencies?: Partial<Dependencies>; backgroundEntry?: URL }) {
  const directory = resolve(options.directory);
  const vault = new Vault(directory);
  const store = new Store(resolve(directory, 'database.sqlite'));
  for (const item of listRules()) store.registerRule(item.rule.version, item.hash, item.rule);
  const latestRuleVersion = () => store.rules().at(-1)?.rule.version || defaultRuleVersion;
  const artifacts = new Artifacts(store.db, resolve(directory,'artifacts'));
  const worker = new Worker(store, vault, artifacts, directory, options.workerDependencies);
  const automationStore = new AutomationStore(store.db,value=>{
    const settings=vault.get();
    for(const secret of [settings.model.apiKey,...settings.environments.flatMap(e=>[e.token,e.delivery?.token||''])])if(secret)value=value.replaceAll(secret,'[已隐藏]');
    return value.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [已隐藏]');
  });
  const automationWorker = options.startWorker === false || options.workerDependencies
    ? new AutomationWorker(automationStore, vault, directory)
    : new BackgroundWorkers(directory, automationStore, options.backgroundEntry);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 30000 });
  let session = randomUUID() + randomUUID();
  let modelTestRunning = false;
  const knownHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const origins = new Set(['http://127.0.0.1:4180', 'http://localhost:4180', 'http://127.0.0.1:4181', 'http://localhost:4181']);

  function localAdmin(request: FastifyRequest): boolean {
    return request.headers.cookie?.split(';').some((part) => part.trim() === `evaluator_session=${session}`) ?? false;
  }
  function bearer(request: FastifyRequest): string { return request.headers.authorization?.replace(/^Bearer /i, '') ?? ''; }

  app.addHook('onRequest', async (request, reply) => {
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host || ''}`).hostname; } catch { return reply.code(403).send({ error: 'Host 不合法' }); }
    if (!knownHosts.has(hostname)) return reply.code(403).send({ error: '本机版本只接受本机地址' });
    const origin = request.headers.origin;
    const extension = origin?.startsWith('chrome-extension://') ?? false;
    if (origin && !origins.has(origin) && !extension) return reply.code(403).send({ error: '请求来源不受信任' });
    if (origin && (origins.has(origin) || extension)) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
      if (!extension) reply.header('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
      return reply.code(204).send();
    }
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (request.url.split('?')[0] === '/api/login' && request.method === 'POST') {
      if (extension || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '请从平台页面建立会话' });
      return;
    }
    if (localAdmin(request) && !extension) return;
    const token = bearer(request);
    if(request.method==='POST' && request.url.split('?')[0]==='/api/v1/resources/import' && matches(token,vault.credentials.ingestToken)) return;
    if(request.method==='GET' && /^\/api\/v1\/automation\/(?:reports|tasks)(?:[/?]|$)/.test(request.url) && matches(token,vault.credentials.readToken)) return;
    if (request.method === 'POST' && request.url.split('?')[0] === '/api/evaluations' && matches(token, vault.credentials.ingestToken)) return;
    if (request.method === 'GET' && /^\/api\/v1\/evaluations(?:[/?]|$)/.test(request.url) && matches(token, vault.credentials.readToken)) return;
    if (request.method === 'GET' && /^\/api\/(evaluations(?:\/|\?|$)|jobs\/|sites\/|rules(?:\?|$))/.test(request.url) && matches(token, vault.credentials.readToken)) return;
    return reply.code(401).send({ error: '请重新打开平台页面，或提供此接口对应的访问令牌' });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('；') });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error instanceof Error ? error.message : '请求不合法' });
    return reply.code(500).send({ error: '平台处理失败，请检查服务状态；没有生成有效结果' });
  });

  app.post('/api/login', async (_request, reply) => {
    reply.header('Set-Cookie', `evaluator_session=${session}; HttpOnly; SameSite=Strict; Path=/api`);
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });
  app.get('/api/session', async () => ({ ok: true }));
  app.post('/api/logout', async (_request, reply) => { session = randomUUID() + randomUUID(); reply.header('Set-Cookie', 'evaluator_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'); return { ok: true }; });
  app.get('/api/health', async () => {
    const settings = vault.get();
    return { ok: true, version: '0.4.0', pipelineVersion: 1, executor: 'openai-compatible-tool-agent', paused: settings.paused, modelReady: Boolean(settings.model.endpoint && settings.model.name), browserReady: existsSync(chromium.executablePath()), storage: 'sqlite', worker: options.startWorker !== false, workerReady: automationWorker instanceof BackgroundWorkers ? automationWorker.healthy : options.startWorker !== false, homeOnly: true };
  });
  app.get('/api/settings', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); return vault.public(); });
  app.put('/api/settings', async (request) => vault.update(request.body));
  app.post('/api/model/test', async (_request, reply) => {
    const model = vault.get().model;
    if (!model.endpoint || !model.name) return reply.code(400).send({ error: '请先保存模型接口地址和模型名称' });
    if (modelTestRunning) return reply.code(409).send({ error: '已有模型测试进行中，请等待结果' });
    modelTestRunning = true;
    try { return await testAgentModel(model, AbortSignal.timeout(95000)); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : '模型测试失败' }); }
    finally { modelTestRunning = false; }
  });
  app.post('/api/environments/:id/test', async (request, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const environment = vault.get().environments.find((item) => item.id === id);
    if (!environment) return reply.code(404).send({ error: '环境不存在，请先保存' });
    try { return { ok: true, sites: await testEnvironment(environment) }; }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : '连接失败' }); }
  });
  app.get('/api/rules', async () => ({ items: store.rules().map((item) => ({ ...item.rule, hash: item.hash, calibrated: false })), defaultVersion: latestRuleVersion() }));
  app.get('/api/rule-drafts', async () => ({ items: store.drafts() }));
  app.post('/api/rule-drafts', async (request, reply) => {
    const { sourceVersion } = z.object({ sourceVersion: z.string().max(80) }).parse(request.body);
    const source = store.getRule(sourceVersion);
    if (!source) return reply.code(404).send({ error: '规则版本不存在' });
    const used = new Set([...store.rules().map((item) => item.rule.version), ...store.drafts().map((item) => item.rule.version)]);
    const base = sourceVersion.replace(/\d+$/, '').slice(0, 65);
    let next = Number(sourceVersion.match(/\d+$/)?.[0] ?? 1) + 1;
    if (!Number.isSafeInteger(next)) next = 2;
    while (used.has(`${base}${next}`)) next++;
    return reply.code(201).send(store.createDraft({ ...source.rule, version: `${base}${next}` }));
  });
  app.put('/api/rule-drafts/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision, rule } = z.object({ revision: z.number().int().positive(), rule: z.unknown() }).parse(request.body);
    return store.saveDraft(id, revision, parseRule(rule, false));
  });
  app.post('/api/rule-drafts/:id/publish', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision } = z.object({ revision: z.number().int().positive() }).parse(request.body);
    return store.publishDraft(id, revision);
  });

  app.post('/api/evaluations', async (request, reply) => {
    const submission = submissionSchema.parse(request.body);
    if (request.headers['idempotency-key'] !== submission.attemptId) return reply.code(400).send({ error: 'Idempotency-Key 必须与 attemptId 一致' });
    if (!store.getRule(submission.ruleSetVersion || latestRuleVersion())) return reply.code(400).send({ error: '规则版本未发布或配置无效' });
    const receipt = store.accept(submission,null,'local',latestRuleVersion());
    return reply.code(receipt.duplicate ? 200 : 202).send(receipt);
  });
  app.post('/api/manual-evaluations', async (request, reply) => {
    const input = z.object({ jobId: z.string().trim().min(1).max(200), targetUrl: webUrl, referenceUrl: z.union([webUrl, z.literal('')]).optional(), scope: z.enum(['homepage', 'site']).default('homepage'), ruleSetVersion: z.string().max(80).default(latestRuleVersion()) }).parse(request.body);
    if (!store.getRule(input.ruleSetVersion)) return reply.code(400).send({ error: '规则版本未发布或配置无效' });
    const id = randomUUID();
    const receipt = store.accept({ schemaVersion: 1, attemptId: id, requestId: id, jobId: input.jobId, trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: new URL(input.targetUrl).origin, siteId: 'manual-public-url' }, inputs: input.referenceUrl ? { referenceUrl: input.referenceUrl } : {}, scope: input.scope, ruleSetVersion: input.ruleSetVersion }, input.targetUrl);
    return reply.code(202).send(receipt);
  });
  app.get('/api/evaluations', async (request) => {
    const input = z.object({ q: z.string().max(200).default(''), status: z.enum(['all','queued','collecting','scoring','completed','failed']).default('all'), needsReview: z.enum(['true','false']).optional(), fidelityBelow: z.coerce.number().min(0).max(101).optional(), latestPerSite: z.enum(['true','false']).default('false'), domain: domainSchema.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.query);
    const threshold = vault.get().threshold;
    const items = store.list(threshold, input.latestPerSite === 'true');
    const query = input.q.toLowerCase();
    const filtered = items.filter((item) => {
      if (input.domain && item.siteDomain !== input.domain) return false;
      if (query && !`${item.siteDomain || ''} ${item.submission.jobId} ${item.submission.target.siteId} ${item.targetUrl || ''} ${item.submission.target.koobooOrigin}`.toLowerCase().includes(query)) return false;
      if (input.status !== 'all' && item.run.status !== input.status) return false;
      if (input.needsReview === 'true' && !item.needsReview) return false;
      if (input.fidelityBelow !== undefined && (item.run.report?.fidelityScore == null || item.run.report.fidelityScore >= input.fidelityBelow)) return false;
      return true;
    });
    return { items: filtered.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(present), total: filtered.length, page: input.page, pageSize: input.pageSize, summary: { total: items.length, active: items.filter((item) => ['queued','collecting','scoring'].includes(item.run.status)).length, needsReview: items.filter((item) => item.needsReview).length, belowThreshold: items.filter((item) => item.run.report?.fidelityScore != null && item.run.report.fidelityScore < threshold).length, completed: items.filter((item) => item.run.status === 'completed').length } };
  });
  app.get('/api/sites/:domain/evaluations/latest', async (request, reply) => {
    const { domain } = z.object({ domain: domainSchema }).parse(request.params);
    const item = store.siteHistory(domain, vault.get().threshold)[0];
    return item ? present(item) : reply.code(404).send({ error: '尚无此生成站域名的评测记录' });
  });
  app.get('/api/sites/:domain/evaluations', async (request) => {
    const { domain } = z.object({ domain: domainSchema }).parse(request.params);
    const items = store.siteHistory(domain, vault.get().threshold);
    return { siteDomain: domain, items: items.map(present), total: items.length };
  });
  app.get('/api/jobs/:jobId/evaluations/latest', async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(200) }).parse(request.params);
    const item = store.latest(jobId, vault.get().threshold);
    return item ? present(item) : reply.code(404).send({ error: '未找到该任务的评测记录' });
  });
  app.get('/api/evaluations/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = store.get(id, vault.get().threshold);
    const runs = item ? store.history(id) : [];
    return item ? { ...present(item), siteEvaluations: item.siteDomain ? store.siteHistory(item.siteDomain, vault.get().threshold).map(present) : [], runs, issueActions: Object.fromEntries(runs.map(run => [run.id, store.issueActions(run.id)])), events: store.events(item.run.id), runEvents: Object.fromEntries(runs.map((run) => [run.id, store.events(run.id)])) } : reply.code(404).send({ error: '评测不存在' });
  });
  app.post('/api/evaluations/:id/issue-decisions', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ runId: z.string().uuid(), indices: z.array(z.number().int().nonnegative()).min(1).max(500), ignored: z.boolean() }).strict().parse(request.body);
    return store.decideIssues(id, input.runId, input.indices, input.ignored);
  });
  app.get('/api/evaluations/:id/repair-targets', async (request, reply) => {
    if (!localAdmin(request)) return reply.code(403).send({ error: '请从平台页面发送修复请求' });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = store.get(id);
    return item ? repairTargets(item, vault.get()) : reply.code(404).send({ error: '评测不存在' });
  });
  app.post('/api/evaluations/:id/issue-handoffs', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ id: z.string().uuid(), runId: z.string().uuid(), indices: z.array(z.number().int().nonnegative()).min(1).max(500), environmentId: z.string().uuid(), siteId: z.string().uuid() }).strict().parse(request.body);
    const item = store.get(id);
    if (!item) throw new Conflict('评测不存在');
    const target = (await repairTargets(item, vault.get())).items.find(target => target.environmentId === input.environmentId && target.siteId === input.siteId);
    if (!target) throw new Conflict('未找到域名匹配的 Kooboo 站点，请检查环境设置');
    const payload = repairPayload(store, artifacts, id, input.runId, input.indices, target, input.id);
    const url = new URL('/_Admin/ai-chat/overview', target.origin);
    url.searchParams.set('SiteId', target.siteId);
    url.searchParams.set('evaluationHandoff', payload.id);
    url.searchParams.set('evaluationOrigin', request.headers.origin || `http://${request.headers.host}`);
    return { target, payload, url: url.href };
  });
  app.post('/api/evaluations/:id/issue-handoffs/:handoffId/receipt', async request => {
    const { id, handoffId } = z.object({ id: z.string().uuid(), handoffId: z.string().uuid() }).parse(request.params);
    const input = z.object({ runId: z.string().uuid(), siteId: z.string().uuid(), status: z.enum(['accepted', 'failed', 'unknown']), sessionId: z.string().uuid().optional() }).strict().parse(request.body);
    return store.finishIssueHandoff(id, input.runId, handoffId, input.siteId, input.status, input.sessionId);
  });
  app.post('/api/evaluations/:id/runs', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.code(202).send({ runId: store.rerun(id, z.object({ mode: z.enum(['all','failed','prepare','target','reference','check','score','report']).default('all'), sourceRunId: z.string().uuid().optional() }).strict().parse(request.body || {})) });
  });
  app.post('/api/evaluations/:id/reviews', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ decision: z.enum(['accepted','rework']), note: z.string().trim().max(1000).default(''), runId: z.string().uuid() }).parse(request.body);
    store.review(id, input.decision, input.note, input.runId);
    return { ok: true };
  });
  app.get('/api/evaluations/:id/reports/:runId', async (request, reply) => {
    const params=z.object({id:z.string().uuid(),runId:z.string().uuid()}).parse(request.params);
    const run=store.get(params.id) ? store.history(params.id).find(r=>r.id===params.runId) : null;
    if(!run?.report)return reply.code(404).send({error:'报告尚未生成'});
    reply.header('Content-Disposition',`attachment; filename="report-${run.id}.json"`);
    return {evaluationId:params.id,runId:run.id,snapshot:run.snapshot,report:run.report};
  });
  app.get('/api/evaluations/:id/artifacts/:runId/:file', async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), runId: z.string().uuid(), file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,200}\.png$/) }).parse(request.params);
    const evaluation = store.get(params.id);
    const run = evaluation ? store.history(params.id).find((item) => item.id === params.runId) : null;
    if (!run?.evidence?.screenshots.some((shot) => shot.file === params.file)) return reply.code(404).send({ error: '证据不存在' });
    const shot = run.evidence.screenshots.find(shot => shot.file === params.file)!;
    const content = artifacts.get(params.id, shot.sourceRunId || params.runId, params.file);
    if (!content) return reply.code(404).send({ error: '证据文件已丢失，请检查备份或重新评测' });
    reply.header('Cache-Control', 'private, no-store').type('image/png');
    return reply.send(Buffer.from(content, 'base64'));
  });

  registerPublicApi(app, store, vault, artifacts);
  registerAutomationApi(app, automationStore, vault, directory, id => automationWorker.cancel(id), id => automationWorker.owns(id));
  registerDiagnosticApi(app, automationStore, vault, directory);

  const dist = resolve(process.cwd(), 'dist');
  if (options.serveWeb !== false && existsSync(dist)) await app.register(staticFiles, { root: dist, prefix: '/' });
  app.addHook('onClose', async () => { await Promise.all([worker.stop(), automationWorker.stop()]); store.close(); });
  if (options.startWorker !== false) {
    try { await automationWorker.start(); if (!(automationWorker instanceof BackgroundWorkers)) worker.start(); }
    catch (error) { await app.close(); throw error; }
  }
  return { app, store, vault, worker, automationStore, automationWorker };
}
