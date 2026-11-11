import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, type AutomationTask, type AutomationReport } from '../shared/automation.js';
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
