import { z } from 'zod';
import { randomUUID, URL } from './runtime.js';
import { Router, runRouter } from './http.js';
import { initialize } from './worker.js';
import { artifact } from './lib/artifacts.js';
import { parseRule } from './lib/rules.js';
import { submissionSchema, webUrl } from './lib/validation.js';
import { testEnvironment } from './lib/kooboo.js';
import { testModel } from './lib/model.js';
import { normalizeSiteDomain } from './lib/site-domain.js';
import type { Evaluation } from './shared/types.js';
const domainSchema = z.string().max(253).transform((value, context) => { try { return normalizeSiteDomain(value); } catch { context.addIssue({code:'custom',message:'请填写生成站域名'}); return z.NEVER; } });
function present(item: Evaluation) { return { ...item, evaluationId:item.id, jobId:item.submission.jobId, attemptId:item.submission.attemptId, status:item.run.status, fidelityScore:item.run.report?.fidelityScore ?? null, completionScore:item.run.report?.completionScore ?? null, ruleSetVersion:item.run.snapshot?.rule.version ?? item.submission.ruleSetVersion ?? 'visual-v1', reportUrl:`/#/evaluations/${item.id}` }; }
function acquireModelTest() {
  k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_model_lock (id INTEGER PRIMARY KEY, expires INTEGER NOT NULL)');
  let acquired = false;
  k.DB.sqlite.transaction(() => { k.DB.sqlite.execute('DELETE FROM evaluator_model_lock WHERE expires<@now',{now:Date.now()}); acquired = k.DB.sqlite.execute('INSERT OR IGNORE INTO evaluator_model_lock VALUES (1,@expires)',{expires:Date.now()+65000}) === 1; });
  return acquired;
}
function releaseModelTest() { k.DB.sqlite.execute('DELETE FROM evaluator_model_lock WHERE id=1'); }
export function dispatch() {
  const {store,vault} = initialize();
  const app = new Router();
  app.post('/api/migrations/node-v1', request => {
    const input = z.object({ migrationId:z.string(), settings:z.unknown(), credentials:z.object({ingestToken:z.string(),readToken:z.string()}) }).parse(request.body);
    return vault.importInitial(input.settings,input.credentials,input.migrationId);
  });
  app.get('/api/health',() => {
    let browserReady = false; try { k.utils.puppeteer.getTaskCapacity(); browserReady=true; } catch {}
    const settings = vault.get();
    k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_runtime (id INTEGER PRIMARY KEY, last_tick INTEGER NOT NULL)');
    const last = k.DB.sqlite.query('SELECT last_tick FROM evaluator_runtime WHERE id=1')[0];
    return {ok:true,version:'0.2.0',paused:settings.paused,modelReady:!!(settings.model.endpoint && settings.model.name),browserReady,storage:'kooboo-sqlite',worker:!!last && Date.now()-Number(last.last_tick)<120000,lastWorkerTick:last ? Number(last.last_tick):null,homeOnly:true,collector:'kooboo-fullpage-slices-v1'};
  });
  app.get('/api/settings', (_request, reply) => { reply.header('Cache-Control', 'no-store'); return vault.public(); });
  app.put('/api/settings', (request) => vault.update(request.body));
  app.post('/api/model/test', (_request, reply) => {
    const model = vault.get().model;
    if (!model.endpoint || !model.name) return reply.code(400).send({ error: '请先保存模型接口地址和模型名称' });
    if (!acquireModelTest()) return reply.code(409).send({ error: '已有模型测试进行中，请等待结果' });
    try { return testModel(model); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : '模型测试失败' }); }
    finally { releaseModelTest(); }
  });
  app.post('/api/environments/:id/test', (request, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const environment = vault.get().environments.find((item) => item.id === id);
    if (!environment) return reply.code(404).send({ error: '环境不存在，请先保存' });
    try { return { ok: true, sites: testEnvironment(environment) }; }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : '连接失败' }); }
  });
  app.get('/api/rules', () => ({ items: store.rules().map((item) => ({ ...item.rule, hash: item.hash, calibrated: false })) }));
  app.get('/api/rule-drafts', () => ({ items: store.drafts() }));
  app.post('/api/rule-drafts', (request, reply) => {
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
  app.put('/api/rule-drafts/:id', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision, rule } = z.object({ revision: z.number().int().positive(), rule: z.unknown() }).parse(request.body);
    return store.saveDraft(id, revision, parseRule(rule, false));
  });
  app.post('/api/rule-drafts/:id/publish', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision } = z.object({ revision: z.number().int().positive() }).parse(request.body);
    return store.publishDraft(id, revision);
  });

  app.post('/api/evaluations', (request, reply) => {
    const submission = submissionSchema.parse(request.body);
    if (request.headers['idempotency-key'] !== submission.attemptId) return reply.code(400).send({ error: 'Idempotency-Key 必须与 attemptId 一致' });
    if (!store.getRule(submission.ruleSetVersion || 'visual-v1')) return reply.code(400).send({ error: '规则版本未发布或配置无效' });
    const receipt = store.accept(submission);
    return reply.code(receipt.duplicate ? 200 : 202).send(receipt);
  });
  app.post('/api/manual-evaluations', (request, reply) => {
    const input = z.object({ jobId: z.string().trim().min(1).max(200), targetUrl: webUrl, referenceUrl: z.union([webUrl, z.literal('')]).optional(), scope: z.enum(['homepage', 'site']).default('homepage'), ruleSetVersion: z.string().max(80).default('visual-v1') }).parse(request.body);
    if (!store.getRule(input.ruleSetVersion)) return reply.code(400).send({ error: '规则版本未发布或配置无效' });
    const id = randomUUID();
    const receipt = store.accept({ schemaVersion: 1, attemptId: id, requestId: id, jobId: input.jobId, trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: new URL(input.targetUrl).origin, siteId: 'manual-public-url' }, inputs: input.referenceUrl ? { referenceUrl: input.referenceUrl } : {}, scope: input.scope, ruleSetVersion: input.ruleSetVersion }, input.targetUrl);
    return reply.code(202).send(receipt);
  });
  app.get('/api/evaluations', (request) => {
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
  app.get('/api/sites/:domain/evaluations/latest', (request, reply) => {
    const { domain } = z.object({ domain: domainSchema }).parse(request.params);
    const item = store.siteHistory(domain, vault.get().threshold)[0];
    return item ? present(item) : reply.code(404).send({ error: '尚无此生成站域名的评测记录' });
  });
  app.get('/api/sites/:domain/evaluations', (request) => {
    const { domain } = z.object({ domain: domainSchema }).parse(request.params);
    const items = store.siteHistory(domain, vault.get().threshold);
    return { siteDomain: domain, items: items.map(present), total: items.length };
  });
  app.get('/api/jobs/:jobId/evaluations/latest', (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(200) }).parse(request.params);
    const item = store.latest(jobId, vault.get().threshold);
    return item ? present(item) : reply.code(404).send({ error: '未找到该任务的评测记录' });
  });
  app.get('/api/evaluations/:id', (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = store.get(id, vault.get().threshold);
    const runs = item ? store.history(id) : [];
    return item ? { ...present(item), siteEvaluations: item.siteDomain ? store.siteHistory(item.siteDomain, vault.get().threshold).map(present) : [], runs, events: store.events(item.run.id), runEvents: Object.fromEntries(runs.map((run) => [run.id, store.events(run.id)])) } : reply.code(404).send({ error: '评测不存在' });
  });
  app.post('/api/evaluations/:id/runs', (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return reply.code(202).send({ runId: store.rerun(id) });
  });
  app.post('/api/evaluations/:id/reviews', (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ decision: z.enum(['accepted','rework']), note: z.string().trim().max(1000).default(''), runId: z.string().uuid() }).parse(request.body);
    store.review(id, input.decision, input.note, input.runId);
    return { ok: true };
  });

  app.get('/api/evaluations/:id/artifacts/:runId/:file', (request, reply) => {
    const params = z.object({id:z.string().uuid(),runId:z.string().uuid(),file:z.string().regex(/^[a-z-]+\.png$/)}).parse(request.params);
    const run = store.get(params.id) ? store.history(params.id).find(x => x.id === params.runId) : null;
    if (!run?.evidence?.screenshots.some(x => x.file === params.file)) return reply.code(404).send({error:'证据不存在'});
    const content = artifact(params.id,params.runId,params.file);
    return content ? reply.binary(content) : reply.code(404).send({error:'证据已丢失'});
  });
  return runRouter(app,vault);
}
