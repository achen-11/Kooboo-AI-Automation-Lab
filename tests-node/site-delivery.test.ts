import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultDeliveryPolicy, type AutomationTask, type AutomationReport } from '../shared/automation.js';
import { siteDeliveries } from '../server/automation/site-delivery.js';
import type { UsageStage } from '../shared/billing.js';
import { dashboardAnalytics } from '../server/automation/dashboard-analytics.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'site-delivery-'));
  const f = await createApp({ directory, startWorker: false, serveWeb: false });
  const store = f.automationStore, settings = structuredClone(defaultAutomationSettings);
  const resource = store.saveResource({ name: 'Migration', scenario: 'migration', description: '', contentUrl: 'https://source.test', referenceUrl: '', files: [], externalSource: '', externalId: '' });
  const site = { id: randomUUID(), resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId: randomUUID(), siteId: randomUUID(), name: 'Target', url: 'https://target.test', createdAt: 1 };
  store.saveSite(site);
  const login = await f.app.inject({ method: 'POST', url: '/api/login' }), headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  function create(scope: 'homepage' | 'site' = 'homepage') {
    return store.create({ resourceIds: [resource.id], generatedSiteId: site.id, kind: 'generation', scope, environmentId: site.environmentId, requirements: '' }, settings)[0];
  }
  function finish(task: AutomationTask, value = 90) {
    store.beginSiteChange(task); task.status = 'completed'; task.stopped = true; store.put(task);
    const evaluation = store.ensureEvaluation(task, settings);
    evaluation.status = 'completed'; evaluation.stopped = true;
    evaluation.report = { summary: '独立评测结果', quality: value >= 80 ? 'passed' : 'failed', scores: [{ viewport: 'desktop', value }, { viewport: 'mobile', value }], assessments: evaluation.rule!.criteria.flatMap(c => c.viewports.map(viewport => ({ criterionId: c.id, viewport, score: value, passed: true, reason: '证据', evidence: [] }))), issues: [], coverage: { verified: ['本次范围'], unverified: [], outOfScope: [] }, artifacts: [] } satisfies AutomationReport;
    store.publishSiteReport(evaluation); store.put(evaluation); return evaluation;
  }
  function charge(task: AutomationTask, stage: UsageStage, input: number, unknown = false) {
    const at = Date.parse('2026-11-08T10:00:00+08:00');
    store.usage.record(task.id, { id: randomUUID(), source: stage === 'generation' ? 'kooboo' : 'codex', stage, model: 'deepseek-flash-1017', endpoint: 'https://api.deepseek.com/v1', startedAt: at, endedAt: at + 10, status: unknown ? 'unknown' : 'completed', basis: 'request', raw: unknown ? null : { input_tokens: input, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } });
  }
  return { ...f, store, settings, resource, site, headers, create, finish, charge, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('one delivery per actual site sums raw requests once, including continuations and independent reviews', async () => {
  const f = await fixture(); try {
    const first = f.create(), review = f.finish(first);
    f.charge(first, 'generation', 1_000_000); f.charge(first, 'followup', 2_000_000); f.charge(review, 'evaluation', 3_000_000);
    const next = f.create(), nextReview = f.finish(next); f.charge(next, 'generation', 4_000_000); f.charge(nextReview, 'evaluation', 0, true);
    const rows = siteDeliveries(f.store, 80); assert.equal(rows.length, 1);
    const row = rows[0]; assert.equal(row.taskCount, 4); assert.equal(row.usage.requests, 5); assert.equal(row.usage.knownCny, 10); assert.equal(row.usage.missing, 1);
    assert.equal(row.stages.find(item => item.stage === 'generation')!.usage.knownCny, 5);
    assert.equal(row.stages.find(item => item.stage === 'followup')!.usage.knownCny, 2);
    assert.equal(row.stages.find(item => item.stage === 'evaluation')!.usage.knownCny, 3);
    assert.equal(row.report!.id, nextReview.id); assert.equal(row.state, 'ready');
    const list = (await f.app.inject({ url: '/api/automation/site-deliveries?pageSize=1', headers: f.headers })).json();
    assert.equal(list.total, 1); assert.equal(list.items[0].usage.requests, 5);
    assert.equal(list.items[0].environmentId, f.site.environmentId);
    const usage = (await f.app.inject({ url: `/api/automation/site-deliveries/${f.site.id}/usage?stage=evaluation&pageSize=1`, headers: f.headers })).json();
    assert.equal(usage.total, 2); assert.equal(usage.items.length, 1);
    const history = (await f.app.inject({ url: `/api/automation/site-deliveries/${f.site.id}/tasks?pageSize=1`, headers: f.headers })).json();
    assert.equal(history.total, 4); assert.equal(history.items.length, 1);
  } finally { await f.close(); }
});

test('historical generation and repair costs, timing and request filters match the dashboard without rewriting ledgers', async () => {
  const f = await fixture(); try {
    const first = f.create(), repair = f.create();
    repair.optimizationRootId = first.id; repair.optimizationRound = 1;
    for (const task of [first, repair]) { task.status = 'completed'; task.stopped = true; f.store.put(task); }
    f.charge(first, 'generation', 1_000_000); f.charge(repair, 'generation', 4_000_000);
    const start = Date.now() - 60_000;
    for (const [task, duration] of [[first, 10_000], [repair, 20_000]] as const) {
      f.store.db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(task.id);
      f.store.db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(randomUUID(), task.id, 'generation', 0, start, start + duration, start + duration);
    }
    f.store.db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(randomUUID(), first.id, 'optimization', 0, start + 20_000, start + 25_000, start + 25_000);
    const row = siteDeliveries(f.store, 80, f.site.id)[0];
    assert.equal(row.stages.find(item => item.stage === 'generation')!.usage.knownCny, 1);
    assert.equal(row.stages.find(item => item.stage === 'repair')!.usage.knownCny, 4);
    assert.equal(row.usage.knownCny, 5);
    const timed = (await f.app.inject({url:`/api/automation/site-deliveries/${f.site.id}/timing`,headers:f.headers})).json();
    assert.equal(timed.stages.find((item:any) => item.stage === 'generation').recordedMs, 10_000);
    assert.equal(timed.stages.find((item:any) => item.stage === 'repair').recordedMs, 25_000);
    const analytics = dashboardAnalytics(f.store, {start:Date.parse('2026-11-08T00:00:00+08:00'),end:Date.now()+1,granularity:'day',scenario:'all',scope:'all',unit:'generation',page:1});
    for (const stage of ['generation', 'repair'] as const) {
      const total = analytics.consumption.stages.find(item => item.stage === stage)!;
      assert.equal(total.knownCny, row.stages.find(item => item.stage === stage)!.usage.knownCny);
      assert.equal(total.recordedMs, timed.stages.find((item:any) => item.stage === stage).recordedMs);
      const page = (await f.app.inject({url:`/api/automation/site-deliveries/${f.site.id}/usage?stage=${stage}&pageSize=1`,headers:f.headers})).json();
      assert.equal(page.total, 1); assert.equal(page.items[0].stage, stage);
      assert.equal(page.items[0].taskId, stage === 'repair' ? repair.id : first.id);
    }
    const repairPage = (await f.app.inject({url:`/api/automation/tasks/${repair.id}/usage?stage=repair`,headers:f.headers})).json();
    assert.equal(repairPage.total, 1); assert.equal(repairPage.items[0].stage, 'repair');
    const empty = (await f.app.inject({url:`/api/automation/tasks/${repair.id}/usage?stage=generation`,headers:f.headers})).json();
    assert.equal(empty.total, 0);
    assert.equal(f.store.usage.entries(repair.id)[0].stage, 'generation', 'persisted billing evidence retains its original stage');
  } finally { await f.close(); }
});

test('timing endpoints group all site requests and require the local session',async()=>{
  const f=await fixture();try{
    const task=f.create(),review=f.finish(task);f.charge(task,'generation',100);f.charge(review,'evaluation',200);
    const siteTiming=await f.app.inject({url:`/api/automation/site-deliveries/${f.site.id}/timing`,headers:f.headers});
    assert.equal(siteTiming.statusCode,200);assert.equal(siteTiming.json().stages.reduce((sum:number,row:{requests:number})=>sum+row.requests,0),2);
    const workflow=await f.app.inject({url:`/api/automation/tasks/${task.id}/timing`,headers:f.headers});assert.equal(workflow.statusCode,200);assert.equal(workflow.json().modelMs,10,'overlapping request times are not added twice');
    assert.equal((await f.app.inject({url:`/api/automation/tasks/${task.id}/timing`})).statusCode,401);
    assert.equal((await f.app.inject({url:`/api/automation/site-deliveries/${randomUUID()}/timing`,headers:f.headers})).statusCode,404);
    assert.doesNotMatch(siteTiming.body,/endpoint|raw|threadId|apiKey/);
  }finally{await f.close();}
});

test('dashboard has authenticated, bounded projections and validates filters',async()=>{
  const f=await fixture();try{const task=f.create();f.charge(task,'generation',100);const path='/api/automation/dashboard?days=7&scenario=all';
    assert.equal((await f.app.inject({url:path})).statusCode,401);const response=await f.app.inject({url:path,headers:f.headers});assert.equal(response.statusCode,200);const result=response.json();assert.equal(result.daily.length,7);assert.equal(result.timezone,'Asia/Shanghai');assert.equal(result.current.finished,0,'queued workflows are not complete samples');assert.doesNotMatch(response.body,/endpoint|raw|threadId|apiKey|test-only/);
    assert.equal((await f.app.inject({url:'/api/automation/dashboard?days=91',headers:f.headers})).statusCode,400);assert.equal((await f.app.inject({url:'/api/automation/dashboard?scenario=unknown',headers:f.headers})).statusCode,400);
  }finally{await f.close();}
});

test('full-site continuation never inherits a passed homepage result while queued, changed or unreviewed', async () => {
  const f = await fixture(); try {
    const home = f.create(); f.finish(home);
    assert.equal(siteDeliveries(f.store, 80)[0].state, 'ready');
    const full = f.create('site');
    let row = siteDeliveries(f.store, 80)[0]; assert.equal(row.scope, 'site'); assert.equal(row.state, 'queued'); assert.equal(row.report, null);
    f.store.beginSiteChange(full); full.status = 'completed'; f.store.put(full);
    row = siteDeliveries(f.store, 80)[0]; assert.equal(row.report, null); assert.equal(row.state, 'awaiting-evaluation');
    const review = f.finish(full, 95);
    row = siteDeliveries(f.store, 80)[0]; assert.equal(row.state, 'needs-improvement', 'a numeric pass without required full-site completeness is insufficient');
    review.report!.completeness = { manifestId: randomUUID(), manifestRevision: 1, sourceComplete: true, state: 'complete', checks: [] }; f.store.put(review);
    assert.equal(siteDeliveries(f.store, 80)[0].state, 'ready');
    review.report!.assessments.find(item => item.criterionId === 'seo-migration')!.passed = false; f.store.put(review);
    assert.equal(siteDeliveries(f.store, 80)[0].state, 'needs-improvement');
  } finally { await f.close(); }
});

test('failed review or unfinished execution cannot be presented as deliverable; sites and pending new tasks stay distinct', async () => {
  const f = await fixture(); try {
    const generation = f.create(), review = f.finish(generation, 60);
    assert.equal(siteDeliveries(f.store, 80)[0].state, 'needs-improvement');
    review.status = 'interrupted'; review.error = '网络中断'; f.store.put(review);
    let row = siteDeliveries(f.store, 80)[0]; assert.equal(row.state, 'attention'); assert.equal(row.report, null); assert.match(row.reason, /网络中断/);
    const newEnvironmentId = randomUUID();
    const newTask = f.store.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: newEnvironmentId, requirements: '' }, f.settings)[0];
    assert.equal(siteDeliveries(f.store, 80).length, 2);
    const pending=await f.app.inject({url:`/api/automation/site-deliveries/${newTask.id}`,headers:f.headers});
    assert.equal(pending.statusCode,200);assert.equal(pending.json().detailTaskId,newTask.id);
    assert.equal(pending.json().environmentId, newEnvironmentId);
    const another = { ...f.site, id: randomUUID(), siteId: randomUUID(), environmentId: randomUUID() }; f.store.saveSite(another);
    assert.equal(siteDeliveries(f.store, 80).length, 3, 'the same resource or URL does not identify the same generated site');
    assert.equal(siteDeliveries(f.store, 80, another.id)[0].environmentId, another.environmentId, 'sites without tasks retain their own environment');
    const filtered = (await f.app.inject({ url: '/api/automation/site-deliveries?state=queued', headers: f.headers })).json();
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0].id, newTask.id);
    assert.equal((await f.app.inject({ url: '/api/automation/site-deliveries', headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
  } finally { await f.close(); }
});

test('a later homepage-only review does not downgrade the intended full-site scope or certify it', async () => {
  const f = await fixture(); try {
    const generation = f.create('site'), fullReview = f.finish(generation);
    fullReview.report!.completeness = { manifestId: randomUUID(), manifestRevision: 1, sourceComplete: true, state: 'complete', checks: [] }; f.store.put(fullReview);
    assert.equal(siteDeliveries(f.store, 80)[0].state, 'ready');
    const narrow = f.store.create({ resourceIds: [f.resource.id], kind: 'evaluation', scope: 'homepage', environmentId: f.site.environmentId, generatedSiteId: f.site.id, requirements: '' }, f.settings)[0];
    narrow.status = 'completed'; narrow.stopped = true; narrow.report = structuredClone(fullReview.report); f.store.publishSiteReport(narrow); f.store.put(narrow);
    const row = siteDeliveries(f.store, 80)[0]; assert.equal(row.scope, 'site'); assert.equal(row.report, null); assert.equal(row.state, 'awaiting-evaluation');
  } finally { await f.close(); }
});

test('site report history spans initial, repair, manual and continuation evaluations, newest first without full reports', async () => {
  const f = await fixture(); try {
    const original = f.create(), first = f.finish(original);
    first.message = 'PRIVATE_PROMPT_NOT_FOR_LIST';
    first.report!.artifacts = [{ id: randomUUID(), name: 'PRIVATE_EVIDENCE_INDEX', type: 'image/png', size: 1, sha256: 'a'.repeat(64) }];
    f.store.put(first);
    const repair = f.create(); repair.optimizationRootId = original.id; repair.optimizationRound = 1; f.store.put(repair);
    const second = f.finish(repair);
    const manual = f.store.create({ resourceIds: [f.resource.id], kind: 'evaluation', scope: 'homepage', generatedSiteId: f.site.id, environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    manual.report = structuredClone(first.report); manual.status = 'completed'; manual.stopped = true; f.store.publishSiteReport(manual); f.store.put(manual);
    const continuation = f.create('site'), full = f.finish(continuation);
    f.store.put(first); // Updating an old record must not move it ahead of later evaluations.
    const url = `/api/automation/site-deliveries/${f.site.id}/reports`;
    const response = await f.app.inject({ url: url + '?pageSize=2', headers: f.headers });
    assert.equal(response.statusCode, 200);
    const page = response.json(); assert.equal(page.total, 4); assert.equal(page.pages, 2); assert.equal(page.pageSize, 2);
    assert.deepEqual(page.items.map((r: { id: string }) => r.id), [full.id, manual.id]);
    assert.equal(page.currentReportId, full.id); assert.equal(page.scope, 'site');
    assert.equal(page.items[0].reportCurrent, true); assert.equal(page.items[1].reportCurrent, false);
    assert.ok(Array.isArray(page.items[0].report.scores));
    const older = (await f.app.inject({ url: url + '?page=2&pageSize=2', headers: f.headers })).json();
    assert.deepEqual(older.items.map((r: { id: string }) => r.id), [second.id, first.id]);
    assert.equal(older.items[0].optimizationRound, 1);
    assert.doesNotMatch(response.body + JSON.stringify(older), /PRIVATE_PROMPT_NOT_FOR_LIST|PRIVATE_EVIDENCE_INDEX|assessments|artifacts|threadId/);
    assert.equal((await f.app.inject({ url: url + '?page=99&pageSize=2', headers: f.headers })).json().page, 2);
    const historical = await f.app.inject({ url: url + '/' + first.id, headers: f.headers });
    assert.equal(historical.json().historical, true); assert.equal(historical.json().rule.id, first.rule!.id);
    assert.equal(historical.json().report.artifacts[0].name, 'PRIVATE_EVIDENCE_INDEX');
    assert.equal((await f.app.inject({ url: url + '/' + full.id, headers: f.headers })).json().historical, false);
    assert.equal((await f.app.inject({ url: `/api/automation/tasks/${first.id}/sections/report`, headers: f.headers })).json().report.artifacts[0].name, 'PRIVATE_EVIDENCE_INDEX', 'old report detail links retain the original data');
  } finally { await f.close(); }
});

test('report history never promotes older scores while a site changes or the current scope is unreviewed', async () => {
  const f = await fixture(); try {
    const first = f.finish(f.create());
    const url = `/api/automation/site-deliveries/${f.site.id}/reports`;
    const continuation = f.create('site');
    let history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.currentReportId, null); assert.equal(history.items[0].reportCurrent, false); assert.ok(history.items[0].report);
    f.store.beginSiteChange(continuation); continuation.status = 'completed'; continuation.stopped = true; f.store.put(continuation);
    const pending = f.store.ensureEvaluation(continuation, f.settings);
    history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.total, 2); assert.equal(history.currentReportId, null);
    assert.equal(history.items.find((r: { id: string }) => r.id === pending.id).report, null);
    pending.status = 'interrupted'; pending.error = 'provider unavailable'; f.store.put(pending);
    history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.currentReportId, null); assert.equal(history.items.find((r: { id: string }) => r.id === pending.id).status, 'interrupted');
    assert.equal((await f.app.inject({ url: url + '/' + first.id, headers: f.headers })).json().historical, true);
    const narrow = f.store.create({ resourceIds: [f.resource.id], kind: 'evaluation', scope: 'homepage', generatedSiteId: f.site.id, environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    narrow.report = structuredClone(first.report); narrow.status = 'completed'; narrow.stopped = true; f.store.publishSiteReport(narrow); f.store.put(narrow);
    history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.currentReportId, null, 'a homepage report cannot become the current full-site result');
  } finally { await f.close(); }
});

test('unchanged site keeps its valid report during manual re-review; cleared publication cannot be restored from stored scores', async () => {
  const f = await fixture(); try {
    const first = f.finish(f.create());
    const pending = f.store.create({ resourceIds: [f.resource.id], kind: 'evaluation', scope: 'homepage', generatedSiteId: f.site.id, environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    const url = `/api/automation/site-deliveries/${f.site.id}/reports`;
    assert.equal((await f.app.inject({ url, headers: f.headers })).json().currentReportId, first.id);
    pending.status = 'interrupted'; pending.report = structuredClone(first.report); f.store.put(pending);
    let history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.items.find((r: { id: string }) => r.id === pending.id).report, null, 'unfinished records cannot masquerade as published reports');
    f.store.db.prepare('UPDATE auto_site_state SET report_id=NULL WHERE site_id=?').run(f.site.id);
    history = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(history.currentReportId, null); assert.equal(siteDeliveries(f.store, 80)[0].report, null);
  } finally { await f.close(); }
});

test('report routes enforce site identity, pagination and local authentication including sites without reviews', async () => {
  const f = await fixture(); try {
    const generation = f.create(), report = f.finish(generation);
    const another = { ...f.site, id: randomUUID(), siteId: randomUUID() }; f.store.saveSite(another);
    const url = `/api/automation/site-deliveries/${another.id}/reports`;
    const empty = (await f.app.inject({ url, headers: f.headers })).json();
    assert.equal(empty.total, 0); assert.equal(empty.pages, 1); assert.equal(empty.currentReportId, null);
    assert.equal((await f.app.inject({ url: url + '/' + report.id, headers: f.headers })).statusCode, 404, 'same resource and URL do not establish report ownership');
    assert.equal((await f.app.inject({ url: `/api/automation/site-deliveries/${f.site.id}/reports/${generation.id}`, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: `/api/automation/site-deliveries/${randomUUID()}/reports`, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ url: url + '?pageSize=101', headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: url + '?page=0', headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal((await f.app.inject({ url: url + '/' + report.id })).statusCode, 401);
  } finally { await f.close(); }
});

test('site deliveries support filtering attention rows by accessible site address and return missing count', async () => {
  const f = await fixture(); try {
    const withUrl = f.create();
    withUrl.status = 'interrupted'; withUrl.error = '已有地址但中断'; f.store.put(withUrl);

    const resNoUrl = f.store.saveResource({ name: 'No URL Yet', scenario: 'site-template', description: '', contentUrl: '', referenceUrl: 'https://ref.test', files: [], externalSource: '', externalId: '' });
    const siteNoUrl = { id: randomUUID(), resourceId: resNoUrl.id, versionId: f.store.versions(resNoUrl.id)[0].id, environmentId: f.site.environmentId, siteId: randomUUID(), name: 'NoUrlTarget', url: '', createdAt: 2 };
    f.store.saveSite(siteNoUrl);
    const noUrl = f.store.create({ resourceIds: [resNoUrl.id], generatedSiteId: siteNoUrl.id, kind: 'generation', scope: 'site', environmentId: siteNoUrl.environmentId, requirements: '' }, f.settings)[0];
    noUrl.status = 'interrupted'; noUrl.error = '创建后尚无域名'; f.store.put(noUrl);

    const resPendingSite = f.store.saveResource({ name: 'Pending Site Creation', scenario: 'site-template', description: '', contentUrl: '', referenceUrl: 'https://ref2.test', files: [], externalSource: '', externalId: '' });
    const pendingSite = f.store.create({ resourceIds: [resPendingSite.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    pendingSite.status = 'failed'; pendingSite.error = '建站失败'; f.store.put(pendingSite);

    const resQueued = f.store.saveResource({ name: 'Queued No URL', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalSource: '', externalId: '' });
    f.store.create({ resourceIds: [resQueued.id], kind: 'generation', scope: 'homepage', environmentId: f.site.environmentId, requirements: '' }, f.settings);

    const missing = (await f.app.inject({ url: '/api/automation/site-deliveries?state=attention&address=missing', headers: f.headers })).json();
    assert.equal(missing.total, 2);
    assert.equal(missing.attentionMissingAddress, 2);
    assert.deepEqual(missing.items.map((item: any) => item.resourceName).sort(), ['No URL Yet', 'Pending Site Creation']);
    assert.ok(missing.items.every((item: any) => item.state === 'attention'));

    const accessible = (await f.app.inject({ url: '/api/automation/site-deliveries?state=attention&address=accessible', headers: f.headers })).json();
    assert.equal(accessible.total, 1);
    assert.equal(accessible.attentionMissingAddress, 2);
    assert.equal(accessible.items[0].resourceName, 'Migration');

    assert.equal((await f.app.inject({ url: '/api/automation/site-deliveries?address=invalid', headers: f.headers })).statusCode, 400);
  } finally { await f.close(); }
});

test('site deliveries project safe recovery metadata consistent with per-task resume guards', async () => {
  const f = await fixture(); try {
    const makeRes = (name: string) => f.store.saveResource({ name, scenario: 'site-template', description: '', contentUrl: '', referenceUrl: 'https://ref.test', files: [], externalSource: '', externalId: '' });

    // 1. Confirmed-stopped interrupted task -> resume
    const rResume = makeRes('Resume Ready');
    const tResume = f.store.create({ resourceIds: [rResume.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    tResume.status = 'interrupted'; tResume.stopped = true; tResume.error = '超时中断'; f.store.put(tResume);

    // 2. Naming conflict -> adjust-site-names
    const rNaming = makeRes('Naming Conflict');
    const tNaming = f.store.create({ resourceIds: [rNaming.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    tNaming.status = 'interrupted'; tNaming.stopped = true; tNaming.error = '自定义站点名或子域名已被占用'; f.store.put(tNaming);

    // 3. Unconfirmed-stopped -> confirm-stopped
    const rUnconfirmed = makeRes('Unconfirmed Stop');
    const tUnconfirmed = f.store.create({ resourceIds: [rUnconfirmed.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    tUnconfirmed.status = 'interrupted'; tUnconfirmed.stopped = false; tUnconfirmed.error = '进程异常退出'; f.store.put(tUnconfirmed);

    // 4. Cancelled task -> resume
    const rCancelled = makeRes('Cancelled Task');
    const tCancelled = f.store.create({ resourceIds: [rCancelled.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    tCancelled.status = 'cancelled'; tCancelled.stopped = true; f.store.put(tCancelled);

    // 5. Archived interrupted task -> recovery undefined
    const rArchived = makeRes('Archived Task');
    const tArchived = f.store.create({ resourceIds: [rArchived.id], kind: 'generation', scope: 'site', environmentId: f.site.environmentId, requirements: '' }, f.settings)[0];
    tArchived.status = 'interrupted'; tArchived.stopped = true; tArchived.error = '已中断'; f.store.put(tArchived);
    const archivedResp = await f.app.inject({ method: 'POST', url: '/api/automation/dispositions', headers: f.headers, payload: { kind: 'delivery', ids: [tArchived.id], state: 'discarded', note: '' } });
    assert.equal(archivedResp.statusCode, 200);

    const all = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=all', headers: f.headers })).json();
    const byName = (name: string) => all.items.find((item: any) => item.resourceName === name);

    assert.deepEqual(byName('Resume Ready').recovery, { action: 'resume', taskId: tResume.id });
    assert.deepEqual(byName('Naming Conflict').recovery, { action: 'adjust-site-names', taskId: tNaming.id });
    assert.deepEqual(byName('Unconfirmed Stop').recovery, { action: 'confirm-stopped', taskId: tUnconfirmed.id });
    assert.deepEqual(byName('Cancelled Task').recovery, { action: 'resume', taskId: tCancelled.id });
    assert.equal(byName('Archived Task').recovery, undefined);

    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${tUnconfirmed.id}/resume`, headers: f.headers })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${tResume.id}/resume`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${tCancelled.id}/resume`, headers: f.headers })).statusCode, 200);
  } finally { await f.close(); }
});

test('site deliveries project generated state when autoEvaluate is disabled and awaiting-evaluation otherwise', async () => {
  const f = await fixture();
  try {
    const resGenerated = f.store.saveResource({ name: 'Direct Gen Site', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalSource: '', externalId: '' });
    const siteGenerated = { id: randomUUID(), resourceId: resGenerated.id, versionId: f.store.versions(resGenerated.id)[0].id, environmentId: f.site.environmentId, siteId: randomUUID(), name: 'DirectGen', url: 'https://direct-gen.test', createdAt: 10 };
    f.store.saveSite(siteGenerated);
    const genNoEval = f.store.create({ resourceIds: [resGenerated.id], generatedSiteId: siteGenerated.id, kind: 'generation', scope: 'homepage', environmentId: siteGenerated.environmentId, autoEvaluate: false, requirements: '' }, { ...f.settings, autoEvaluate: false })[0];
    f.store.beginSiteChange(genNoEval);
    genNoEval.status = 'completed';
    genNoEval.stopped = true;
    f.store.put(genNoEval);

    const rowNoEval = siteDeliveries(f.store, 80, siteGenerated.id)[0];
    assert.equal(rowNoEval.state, 'generated');
    assert.match(rowNoEval.reason, /已关闭自动评测/);

    // Direct delivery completed updates reason cleanly for generated sites
    genNoEval.delivery = {
      id: randomUUID(),
      policy: { enabled: true, endpoint: 'https://migrate.test', auto: false, requirePassed: true, verifyWithAi: false, timeoutSeconds: 180 },
      status: 'completed',
      sourceEnvironmentId: siteGenerated.environmentId,
      sourceSiteId: siteGenerated.siteId,
      sourceUrl: siteGenerated.url,
      evaluationTaskId: '',
      target: { siteId: randomUUID(), siteUrl: 'https://delivered.test/' },
      updatedAt: Date.now(),
      error: '',
      checks: [{ url: 'https://delivered.test/', status: 200, ok: true, detail: 'ok' }],
      verifiedAt: Date.now(),
    };
    f.store.put(genNoEval);
    const deliveredRow = siteDeliveries(f.store, 80, siteGenerated.id)[0];
    assert.equal(deliveredRow.state, 'generated');
    assert.match(deliveredRow.reason, /已跳过源站评测/);

    // Generation with autoEvaluate=true and no report yet stays awaiting-evaluation
    const genWithEval = f.create('homepage');
    f.store.beginSiteChange(genWithEval);
    genWithEval.status = 'completed';
    genWithEval.stopped = true;
    f.store.put(genWithEval);
    const rowAwaiting = siteDeliveries(f.store, 80, f.site.id)[0];
    assert.equal(rowAwaiting.state, 'awaiting-evaluation');
  } finally {
    await f.close();
  }
});

test('GET /api/automation/site-deliveries projects deliveryAction eligibility, environmentName, counts, and delivery filters', async () => {
  const f = await fixture();
  try {
    const delivEnvId = randomUUID();
    const noTokenEnvId = randomUUID();
    const plainEnvId = randomUUID();
    const requirePassEnvId = randomUUID();
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://model.test/v1', name: 'deepseek-flash-1017', apiKey: 'model-key' },
      environments: [
        {
          id: delivEnvId,
          name: '香港 kooboo',
          origin: 'https://hk.test',
          apiOrigin: 'https://hk.test',
          token: 'hk-tok',
          delivery: { ...defaultDeliveryPolicy, enabled: true, auto: true, requirePassed: false, token: 'deliv-tok' },
        },
        {
          id: noTokenEnvId,
          name: '缺令牌环境',
          origin: 'https://notok.test',
          apiOrigin: 'https://notok.test',
          token: 'tok',
          delivery: { ...defaultDeliveryPolicy, enabled: true, auto: false, token: '' },
        },
        {
          id: plainEnvId,
          name: '德国 kooboo',
          origin: 'https://de.test',
          apiOrigin: 'https://de.test',
          token: 'de-tok',
        },
        {
          id: requirePassEnvId,
          name: '严格环境',
          origin: 'https://strict.test',
          apiOrigin: 'https://strict.test',
          token: 'strict-tok',
          delivery: { ...defaultDeliveryPolicy, enabled: true, auto: false, requirePassed: true, token: 'strict-deliv-tok' },
        },
      ],
    });
    f.store.publish({
      name: 'Site rule',
      kind: 'site',
      sop: 'Inspect',
      references: '',
      criteria: [{ id: 'hero', label: 'Hero', weight: 100, instruction: 'Check', required: true, viewports: ['desktop', 'mobile'], scopes: ['homepage', 'site'] }],
    });

    const addSiteTask = (opts: {
      name: string;
      envId: string;
      autoEvaluate?: boolean;
      evalScore?: number;
      delivered?: boolean;
      archived?: boolean;
      running?: boolean;
    }) => {
      const res = f.store.saveResource({ name: opts.name, scenario: 'upgrade', description: '', contentUrl: 'https://src.test', referenceUrl: '', files: [], externalSource: '', externalId: '' });
      const site = { id: randomUUID(), resourceId: res.id, versionId: f.store.versions(res.id)[0].id, environmentId: opts.envId, siteId: randomUUID(), name: opts.name.replace(/\s+/g, '_').toLowerCase(), url: `https://${opts.name.replace(/\s+/g, '-').toLowerCase()}.test/`, createdAt: Date.now() };
      f.store.saveSite(site);
      const gen = f.store.create({ resourceIds: [res.id], generatedSiteId: site.id, kind: 'generation', scope: 'homepage', environmentId: opts.envId, autoEvaluate: opts.autoEvaluate ?? false, requirements: '' }, { ...f.settings, autoEvaluate: opts.autoEvaluate ?? false })[0];
      f.store.beginSiteChange(gen);
      if (opts.running) {
        gen.status = 'running';
        gen.stopped = false;
        f.store.put(gen);
        return { gen, evalTask: undefined };
      }
      gen.status = 'completed';
      gen.stopped = true;
      let evalTask: AutomationTask | undefined;
      if (opts.evalScore !== undefined) {
        evalTask = f.store.ensureEvaluation(gen, f.settings);
        evalTask.status = 'completed';
        evalTask.stopped = true;
        evalTask.report = {
          summary: 'Eval',
          quality: opts.evalScore >= 80 ? 'passed' : 'failed',
          scores: [{ viewport: 'desktop', value: opts.evalScore }, { viewport: 'mobile', value: opts.evalScore }],
          assessments: evalTask.rule!.criteria.flatMap(c => c.viewports.map(viewport => ({ criterionId: c.id, viewport, score: opts.evalScore!, passed: opts.evalScore! >= 80, reason: 'ok', evidence: [] }))),
          issues: opts.evalScore >= 80 ? [] : [{ severity: 'major', title: 'Gap', detail: 'Fix', evidence: [] }],
          coverage: { verified: ['首页'], unverified: [], outOfScope: [] },
          artifacts: [],
        };
        f.store.publishSiteReport(evalTask);
        f.store.put(evalTask);
      }
      if (opts.delivered) {
        gen.delivery = {
          id: randomUUID(),
          policy: { ...defaultDeliveryPolicy, enabled: true, verifyWithAi: false },
          status: 'completed',
          sourceEnvironmentId: opts.envId,
          sourceSiteId: site.siteId,
          sourceUrl: site.url,
          evaluationTaskId: evalTask?.id || '',
          target: { siteId: randomUUID(), siteUrl: 'https://de-target.test/' },
          updatedAt: Date.now(),
          error: '',
          checks: [],
        };
      }
      f.store.put(gen);
      if (opts.archived) {
        f.store.dispositions.set('delivery', [site.id], 'completed', '');
      }
      return { gen, evalTask };
    };

    const sGenOk = addSiteTask({ name: 'GenOk', envId: delivEnvId, autoEvaluate: false });
    const sEvalOk = addSiteTask({ name: 'EvalOk', envId: delivEnvId, autoEvaluate: true, evalScore: 92 });
    addSiteTask({ name: 'PlainEnv', envId: plainEnvId, autoEvaluate: false });
    addSiteTask({ name: 'NoToken', envId: noTokenEnvId, autoEvaluate: false });
    addSiteTask({ name: 'LowScore', envId: requirePassEnvId, autoEvaluate: true, evalScore: 60 });
    addSiteTask({ name: 'Delivered', envId: delivEnvId, autoEvaluate: false, delivered: true });
    addSiteTask({ name: 'Archived', envId: delivEnvId, autoEvaluate: false, archived: true });
    addSiteTask({ name: 'Running', envId: delivEnvId, autoEvaluate: false, running: true });

    const allRes = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=all&pageSize=50', headers: f.headers })).json();
    const byName = (name: string) => allRes.items.find((item: any) => item.resourceName === name);

    assert.equal(byName('GenOk').environmentName, '香港 kooboo');
    assert.deepEqual(byName('GenOk').deliveryAction, { eligible: true, taskId: sGenOk.gen.id, code: 'ready' });
    assert.deepEqual(byName('EvalOk').deliveryAction, { eligible: true, taskId: sEvalOk.evalTask!.id, code: 'ready' });
    assert.equal(byName('PlainEnv').environmentName, '德国 kooboo');
    assert.equal(byName('PlainEnv').deliveryAction.eligible, false);
    assert.equal(byName('PlainEnv').deliveryAction.code, 'unsupported-env');
    assert.equal(byName('NoToken').deliveryAction.eligible, false);
    assert.equal(byName('NoToken').deliveryAction.code, 'missing-token');
    assert.equal(byName('LowScore').deliveryAction.eligible, false);
    assert.equal(byName('LowScore').deliveryAction.code, 'require-passed');
    assert.equal(byName('Delivered').deliveryAction.code, 'already-delivered');
    assert.equal(byName('Archived').deliveryAction.code, 'archived');
    assert.equal(byName('Running').deliveryAction.code, 'in-progress');

    assert.equal(allRes.deliverableCount, 2);
    assert.equal(allRes.undeliveredCount, 6); // GenOk, EvalOk, PlainEnv, NoToken, LowScore + fixture default Migration site

    // delivery=undelivered shows finished undelivered active sites (both deliverable & ineligible envs)
    const undeliveredRes = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=active&delivery=undelivered&pageSize=50', headers: f.headers })).json();
    assert.deepEqual(
      undeliveredRes.items.map((i: any) => i.resourceName).sort(),
      ['EvalOk', 'GenOk', 'LowScore', 'Migration', 'NoToken', 'PlainEnv'],
    );

    // delivery=deliverable shows only eligible sites
    const deliverableRes = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=active&delivery=deliverable&pageSize=50', headers: f.headers })).json();
    assert.deepEqual(
      deliverableRes.items.map((i: any) => i.resourceName).sort(),
      ['EvalOk', 'GenOk'],
    );

    // Confirm queueing delivery on returned taskId works cleanly via existing endpoint
    const queueRes = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${sGenOk.gen.id}/delivery`, headers: f.headers });
    assert.equal(queueRes.statusCode, 200);
  } finally {
    await f.close();
  }
});

test('site deliveries requirePassed matches queueDelivery frozen threshold and includes stopped-optimization deliverable sites in undelivered filter', async () => {
  const f = await fixture();
  try {
    const strictEnvId = randomUUID();
    const relaxedEnvId = randomUUID();
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://model.test/v1', name: 'deepseek-flash-1017', apiKey: 'model-key' },
      environments: [
        {
          id: strictEnvId,
          name: 'StrictPass',
          origin: 'https://strict-pass.test',
          apiOrigin: 'https://strict-pass.test',
          token: 'tok-1',
          delivery: { ...defaultDeliveryPolicy, enabled: true, auto: false, requirePassed: true, token: 'deliv-1' },
        },
        {
          id: relaxedEnvId,
          name: 'RelaxedOpt',
          origin: 'https://relaxed-opt.test',
          apiOrigin: 'https://relaxed-opt.test',
          token: 'tok-2',
          delivery: { ...defaultDeliveryPolicy, enabled: true, auto: false, requirePassed: false, token: 'deliv-2' },
        },
      ],
    });
    const rule = f.store.publish({
      name: 'Site rule',
      kind: 'site',
      sop: 'Inspect',
      references: '',
      criteria: [{ id: 'hero', label: 'Hero', weight: 100, instruction: 'Check', required: true, viewports: ['desktop', 'mobile'], scopes: ['homepage', 'site'] }],
    });

    const createUnverifiedOptSite = (opts: { name: string; envId: string; frozenThreshold: number; targetScore: number; score: number }) => {
      const res = f.store.saveResource({ name: opts.name, scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalSource: '', externalId: '' });
      const site = { id: randomUUID(), resourceId: res.id, versionId: f.store.versions(res.id)[0].id, environmentId: opts.envId, siteId: randomUUID(), name: opts.name.toLowerCase(), url: `https://${opts.name.toLowerCase()}.test/`, createdAt: Date.now() };
      f.store.saveSite(site);
      const root = f.store.create({
        resourceIds: [res.id],
        generatedSiteId: site.id,
        kind: 'generation',
        scope: 'homepage',
        environmentId: opts.envId,
        ruleId: rule.id,
        optimization: { targetScore: opts.targetScore, maxRounds: 2, maxCostCny: null },
        requirements: '',
      }, f.settings)[0];
      f.store.beginSiteChange(root);
      root.status = 'completed';
      root.stopped = true;
      const evalTask = f.store.ensureEvaluation(root, f.settings);
      evalTask.status = 'completed';
      evalTask.stopped = true;
      evalTask.report = {
        summary: 'Unverified report',
        quality: 'unverified',
        scores: [{ viewport: 'desktop', value: opts.score }, { viewport: 'mobile', value: opts.score }],
        assessments: evalTask.rule!.criteria.flatMap(c => c.viewports.map(viewport => ({ criterionId: c.id, viewport, score: opts.score, passed: true, reason: 'ok', evidence: [] }))),
        issues: [],
        coverage: { verified: ['首页'], unverified: ['动画待人工复核'], outOfScope: [] },
        artifacts: [],
      };
      f.store.publishSiteReport(evalTask);
      f.store.put(evalTask);
      root.optimization = {
        ...root.optimization!,
        state: 'stopped',
        threshold: opts.frozenThreshold,
        rounds: [{ number: 0, generationTaskId: root.id, evaluationTaskId: evalTask.id, revision: root.siteRevision || 'rev-1', startedAt: Date.now() }],
        activeTaskId: evalTask.id,
        reportId: evalTask.id,
        reason: '达到轮次上限已停止',
        nextSteps: [],
        stoppedAt: Date.now(),
      };
      f.store.put(root);
      return { root, evalTask };
    };

    // 1. Frozen threshold 80 < targetScore 85 with score 82 -> eligible & queueDelivery accepts (200)
    const passByFrozen = createUnverifiedOptSite({ name: 'OptPassFrozen', envId: strictEnvId, frozenThreshold: 80, targetScore: 85, score: 82 });
    // 2. Frozen threshold 80 > targetScore 70 with score 75 -> ineligible (require-passed) & queueDelivery rejects (409)
    const failByFrozen = createUnverifiedOptSite({ name: 'OptFailFrozen', envId: strictEnvId, frozenThreshold: 80, targetScore: 70, score: 75 });
    // 3. Stopped optimization with state='attention' and requirePassed=false -> eligible and visible in delivery=undelivered
    const optAttentionDeliverable = createUnverifiedOptSite({ name: 'OptAttentionOk', envId: relaxedEnvId, frozenThreshold: 80, targetScore: 95, score: 70 });

    const all = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=active&pageSize=50', headers: f.headers })).json();
    const byName = (name: string) => all.items.find((item: any) => item.resourceName === name);

    assert.equal(byName('OptPassFrozen').deliveryAction.eligible, true);
    assert.equal(byName('OptFailFrozen').deliveryAction.eligible, false);
    assert.equal(byName('OptFailFrozen').deliveryAction.code, 'require-passed');
    assert.equal(byName('OptAttentionOk').state, 'attention');
    assert.equal(byName('OptAttentionOk').deliveryAction.eligible, true);

    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${passByFrozen.evalTask.id}/delivery`, headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${failByFrozen.evalTask.id}/delivery`, headers: f.headers })).statusCode, 409);

    const undelivered = (await f.app.inject({ url: '/api/automation/site-deliveries?disposition=active&delivery=undelivered&pageSize=50', headers: f.headers })).json();
    assert.ok(undelivered.items.some((item: any) => item.resourceName === 'OptAttentionOk'), 'deliverable stopped-optimization site must be visible in batch delivery mode');
  } finally {
    await f.close();
  }
});
