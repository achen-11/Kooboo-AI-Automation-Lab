import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultOptimizationPolicy, type AutomationReport, type FollowupAction } from '../shared/automation.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { MigrationVerificationStore, checkpointMigrationReport, finishPendingMigrationReport, extractManweiResponse, mergeMigrationReport, migrationRepairContext, registerMigrationProfile, verifyTaskMigration, type MigrationReadDependencies } from '../server/automation/migration-verification.js';
import { advanceOptimization, applyOptimizationAction } from '../server/automation/optimization.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'migration-verification-'));
  const f = await createApp({ directory, startWorker: false, serveWeb: false }), store = f.automationStore;
  const headers = { cookie: String((await f.app.inject({ method: 'POST', url: '/api/login' })).headers['set-cookie']).split(';')[0] };
  const settings = structuredClone(defaultAutomationSettings), contentFolderId = randomUUID(), relationFolderId = randomUUID();
  const resource = store.saveResource({ name: 'Migration', scenario: 'migration', contentUrl: 'https://manwei-sav.com', referenceUrl: '', description: '', files: [], externalSource: '', externalId: '' });
  const version = store.versions(resource.id)[0], site = { id: randomUUID(), resourceId: resource.id, versionId: version.id, environmentId: randomUUID(), siteId: randomUUID(), name: 'Target', url: 'https://target.invalid', createdAt: Date.now() };
  store.saveSite(site);
  const root = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'site', environmentId: site.environmentId, generatedSiteId: site.id, requirements: '', optimization: defaultOptimizationPolicy }, settings)[0];
  root.generation = { prepared: true, conversationId: randomUUID(), deliveryState: 'completed' };
  const manifests = new ManifestStore(store);
  const old = manifests.save(root, { sourceComplete: false, limitations: ['full source unknown'], evidence: [], items: [{ id: 'relations', kind: 'data', title: 'relations', required: true, source: 'source', expectation: 'preserve', paths: [], expectedCount: 2, expectedKeys: ['1', '2'], viewports: ['business'] }] }, 'human');
  root.status = 'completed'; root.stopped = true; store.beginSiteChange(root); store.put(root);
  const evaluation = store.ensureEvaluation(root, settings); evaluation.status = 'completed'; evaluation.stopped = true;
  const dir = join(directory, 'automation-runs', evaluation.id, 'evidence'); mkdirSync(dir, { recursive: true });
  const sourceFiles = [1, 2].map(page => {
    const path = '/cn/category/10' + (page === 1 ? '' : '_2.aspx');
    const value = { kind: 'source', url: 'https://manwei-sav.com' + path, status: 200, truncated: false, body: `<ul class="proud_list"><li><a href="/cn/show/${page}">${page}</a></li></ul><a href="/cn/category/10_2.aspx">2</a>` };
    const bytes = Buffer.from(JSON.stringify(value)), name = 'source-review-' + randomUUID() + '.json'; writeFileSync(join(dir, name), bytes);
    return { id: randomUUID(), name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: 'application/json', role: 'content' as const };
  });
  const report: AutomationReport = { summary: 'AI漏报关系缺失', assessments: evaluation.rule!.criteria.flatMap(c => c.viewports.map(viewport => ({ criterionId: c.id, viewport, score: 90, reason: 'evidence', evidence: [], passed: true }))), scores: [{ viewport: 'desktop', value: 90 }, { viewport: 'mobile', value: 90 }], quality: 'passed', issues: [], coverage: { verified: [], unverified: [], outOfScope: [] }, artifacts: sourceFiles,
    completeness: { manifestId: old.id, manifestRevision: old.revision, sourceComplete: false, state: 'unverified', checks: [] } };
  evaluation.report = report; store.publishSiteReport(evaluation); store.put(evaluation);
  const registration = { sourceTaskId: evaluation.id, expectedManifestId: old.id, contentFolderId, relationFolderId };
  const register = () => registerMigrationProfile(store.task(root.id)!, store, directory, registration);
  const reads: string[] = [];
  const dependencies = (fixed = false): MigrationReadDependencies => ({
    implementation: async input => {
      reads.push(input.id + '/' + input.page);
      const ids = input.id === contentFolderId ? ['10', '1', '2'] : fixed ? ['1', '2'] : ['1'];
      return { request: input, capturedAt: Date.now(), value: { pageNr: input.page, pageSize: 100, totalPages: 1, totalCount: ids.length, list: ids.map(id => ({ id: randomUUID(), textValues: input.id === contentFolderId ? { sourceId: id, title: 'same' } : { catId: '10', showId: id } })) } };
    },
    page: async url => { reads.push(url.pathname); return { status: !fixed && url.pathname.endsWith('_2.aspx') ? 404 : 200, body: `<div class="p-list"><div><a href="/cn/show/${url.pathname.endsWith('_2.aspx') ? '2' : '1'}">item</a></div></div>` }; },
  });
  return { ...f, directory, store, headers, root, evaluation, site, old, register, registration, settings, dependencies, reads, sourceFiles, async close() { await f.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('registration freezes host-verified source evidence without rewriting old reports or cumulative budgets', async () => {
  const f = await fixture(); try {
    const before = f.store.task(f.evaluation.id), root = f.store.task(f.root.id)!;
    f.store.scheduleFollowup(root, f.settings.followup); root.followup!.attempts = 5; root.followup!.tokens = 123; root.status = 'interrupted'; root.followup!.state = 'interrupted'; f.store.put(root);
    const response = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${root.id}/migration/profile`, headers: f.headers, payload: f.registration });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().manifest.migration.pages.records.length, 2);
    assert.deepEqual(f.store.task(f.evaluation.id), before);
    const saved = f.store.task(root.id)!; assert.equal(saved.followup!.attempts, 5); assert.equal(saved.followup!.tokens, 123); assert.equal(saved.status, 'interrupted');
    assert.equal(saved.optimization!.rounds.length, 1); assert.equal(f.store.tasks().length, 2);
    assert.throws(f.register, /已经固定/);
  } finally { await f.close(); }
});

test('host check catches AI omissions, saves checked paths, and appends every confirmed difference to the same-session repair', async () => {
  const f = await fixture(); try {
    const { manifest: registered } = f.register();
    const run = (await verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()))!;
    const missing = run.checks.find(c => c.id === 'stored-relations')!.differences.find(d => d.confirmed && d.code === 'missing')!;
    assert.ok(missing); assert.ok(missing.subject.includes('2'));
    const pages = run.checks.find(c => c.id === 'pages')!;
    assert.deepEqual(pages.expectedKeys, ['/cn/category/10', '/cn/category/10_2.aspx']); assert.deepEqual(pages.checkedKeys, pages.expectedKeys);
    assert.ok(pages.differences.some(d => d.confirmed && d.code === 'response' && d.subject.endsWith('_2.aspx')));
    assert.equal(run.state, 'incomplete'); assert.equal(new MigrationVerificationStore(f.store).runs(f.root).length, 1);
    const file = run.checks[3].evidence.find(e => e.name.startsWith('migration-observation-'))!;
    const evidence = await f.app.inject({ url: `/api/automation/tasks/${f.root.id}/migration/${run.id}/evidence/${file.name}`, headers: f.headers });
    assert.equal(evidence.statusCode, 200); assert.equal(createHash('sha256').update(evidence.rawPayload).digest('hex'), file.sha256);
    assert.equal((await f.app.inject({ url: `/api/automation/tasks/${randomUUID()}/migration/${run.id}/evidence/${file.name}`, headers: f.headers })).statusCode, 404);
    const root = f.store.task(f.root.id)!; advanceOptimization(root, f.store, f.settings);
    const planning = f.store.task(root.id)!; assert.equal(planning.optimization!.state, 'planning');
    const action: FollowupAction = { action: 'repair', reason: '只注意到了Hero', evidence: ['observed'], message: '修复Hero', imageEvidence: ['image.png'], progress: { improved: false, reason: 'first', resolved: [], remaining: [], unverified: [], introduced: [] } };
    applyOptimizationAction(planning, action, f.store, f.settings);
    const child = f.store.task(f.store.task(root.id)!.optimization!.activeTaskId)!;
    assert.match(child.message, /修复Hero/); assert.ok(child.message.includes(missing.id)); assert.ok(child.message.includes('/cn/category/10_2.aspx'));
    assert.equal(child.generation!.conversationId, f.root.generation!.conversationId); assert.equal(child.versionId, f.root.versionId); assert.equal(child.requirementsId, f.store.task(root.id)!.requirementsId);
    assert.equal(child.requirementsId, registered.id, 'the historical inherited manifest cannot replace the newer registered migration baseline');
    assert.deepEqual(new ManifestStore(f.store).get(child.requirementsId)!.migration, registered.migration);
    assert.equal(f.store.task(f.evaluation.id)!.report!.issues.length, 0, 'historical AI report remains immutable');
  } finally { await f.close(); }
});

test('the full independent issue list is retained even when the planner only requests visual repair', async () => {
  const f = await fixture(); try {
    f.register(); await verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies());
    const evaluation = f.store.task(f.evaluation.id)!;
    evaluation.report!.issues = [{ severity: 'major', title: '正文缺失', detail: '详情19项：867、868、923等；分类1、7、19、163、168缺段', evidence: [f.sourceFiles[0].name] }]; f.store.put(evaluation);
    advanceOptimization(f.store.task(f.root.id)!, f.store, f.settings);
    const context = migrationRepairContext(f.store.task(f.root.id)!, f.store)!;
    assert.equal(context.payload.reportedIssues.length, 1); assert.ok(context.message.includes('867、868、923'));
    assert.ok(context.message.includes(`${evaluation.id}:issue:1`));
  } finally { await f.close(); }
});

test('an in-flight site change rejects publication and the 300-read allowance cannot be bypassed by a large frozen scope', async () => {
  const f = await fixture(); try {
    const { manifest } = f.register(), deps = f.dependencies();
    const original = deps.page; deps.page = async (url, signal) => { const value = await original(url, signal); f.store.db.prepare('UPDATE auto_site_state SET revision=? WHERE site_id=?').run('changed', f.site.id); return value; };
    await assert.rejects(verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, deps), /取证期间站点版本改变/);
    assert.equal(new MigrationVerificationStore(f.store).runs(f.root).length, 0);
    f.store.db.prepare('UPDATE auto_site_state SET revision=? WHERE site_id=?').run(f.evaluation.siteRevision, f.site.id);
    // Simulate a valid larger fixed scope to verify the collector's bound, without performing network calls.
    manifest.migration!.pages.records = Array.from({ length: 305 }, (_, index) => ({ ...manifest.migration!.pages.records[0], path: '/cn/category/' + (index + 10) }));
    f.store.db.prepare('UPDATE auto_requirement_manifests SET json=? WHERE id=?').run(JSON.stringify(manifest), manifest.id);
    let reads = 0; const bounded = f.dependencies(); const read = bounded.page;
    bounded.page = async (url, signal) => { reads++; return read(url, signal); };
    const run = (await verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, bounded))!;
    assert.equal(reads, 298, 'two folder reads leave 298 HTTP reads');
    assert.equal(run.checks[3].checkedKeys!.length, 298); assert.ok(run.checks[3].limitations.some(s => s.includes('300次')));
    assert.equal(run.checks[3].differences.filter(d => d.code === 'missing' && d.confirmed).length, 0);
  } finally { await f.close(); }
});

test('manual check reservations exclude new generation and followup execution, and expire after a crashed process', async () => {
  const f = await fixture(); try {
    const root = f.store.task(f.root.id)!;
    f.store.db.prepare('INSERT INTO auto_migration_read_locks VALUES(?,?,?)').run(f.site.id, root.id, Date.now() + 10000);
    assert.equal(f.store.migrationReadReserved(root), true);
    assert.throws(() => f.store.create({ resourceIds: [root.resourceId], kind: 'generation', scope: 'site', environmentId: root.environmentId, generatedSiteId: f.site.id, requirements: 'new' }, f.settings), /正在自动优化/);
    f.store.scheduleFollowup(root, f.settings.followup); assert.equal(f.store.claimFollowup(1), undefined);
    f.store.db.prepare('UPDATE auto_migration_read_locks SET expires_at=0').run();
    assert.equal(f.store.migrationReadReserved(root), false); assert.ok(f.store.claimFollowup(1));
  } finally { await f.close(); }
});

test('repair recheck uses the frozen paths, and lost evidence is never treated as a resolved defect', async () => {
  const f = await fixture(); try {
    f.register(); const first = (await verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()))!;
    const next = { ...f.evaluation, siteRevision: randomUUID(), optimizationRound: 1 };
    f.store.db.prepare('UPDATE auto_site_state SET revision=? WHERE site_id=?').run(next.siteRevision, f.site.id);
    const fixed = (await verifyTaskMigration(next, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies(true)))!;
    assert.equal(fixed.checks[1].differences.filter(d => d.confirmed && d.code === 'missing').length, 0);
    assert.equal(fixed.checks[3].differences.length, 0); assert.equal(fixed.state, 'unverified', 'unknown source scope does not become complete');
    const root = f.store.task(f.root.id)!; root.optimization!.currentRevision = next.siteRevision; f.store.put(root);
    const payload = migrationRepairContext(root, f.store)!.payload;
    assert.equal(payload.comparison!.comparable, true); assert.equal(payload.comparison!.improved, null); assert.deepEqual(payload.comparison!.resolved, []);
    const failing = f.dependencies(); failing.implementation = async () => { throw new Error('offline'); }; failing.page = async () => { throw new Error('offline'); };
    const failed = (await verifyTaskMigration(next, f.store, f.vault, f.directory, new AbortController().signal, failing))!;
    assert.equal(failed.state, 'unverified'); assert.ok(failed.checks.every(c => !c.differences.some(d => d.confirmed)));
    assert.equal(failed.checks[3].checkedKeys!.length, 0); assert.equal(first.state, 'incomplete');
  } finally { await f.close(); }
});

test('tampered evidence, stale site revisions and cancellation cannot publish a check', async () => {
  const f = await fixture(); try {
    f.register(); const registry = new MigrationVerificationStore(f.store);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, controller.signal, f.dependencies()));
    assert.equal(registry.runs(f.root).length, 0);
    f.store.db.prepare('UPDATE auto_site_state SET revision=? WHERE site_id=?').run('new-revision', f.site.id);
    await assert.rejects(verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), /修订已变化/);
    f.store.db.prepare('UPDATE auto_site_state SET revision=? WHERE site_id=?').run(f.evaluation.siteRevision, f.site.id);
    writeFileSync(join(f.directory, 'automation-runs', f.evaluation.id, 'evidence', f.sourceFiles[0].name), '{}');
    await assert.rejects(verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), /SHA-256/);
    assert.equal(registry.runs(f.root).length, 0);
  } finally { await f.close(); }
});

test('registered workflows cannot pass or dispatch repairs without a current program check', async () => {
  const f = await fixture(); try {
    f.register(); const root = f.store.task(f.root.id)!; advanceOptimization(root, f.store, f.settings);
    const stopped = f.store.task(root.id)!; assert.equal(stopped.optimization!.state, 'stopped'); assert.match(stopped.optimization!.reason, /缺少程序迁移检查/);
    assert.equal(stopped.optimization!.rounds.length, 1);
    assert.throws(() => migrationRepairContext(stopped, f.store), /缺少程序迁移检查/);
  } finally { await f.close(); }
});

test('balanced containers preserve all cards and duplicates while unsupported layouts remain unverified', () => {
  assert.deepEqual(extractManweiResponse('<div class="p-list"><div><a href="/cn/show/1">1</a></div><div><a href="/cn/show/2">2</a></div></div><footer><a href="/cn/show/9">9</a></footer>'), { ids: ['1', '2'], complete: true });
  assert.deepEqual(extractManweiResponse('<ul class="item-grid"><li><a href="/cn/show/1">1</a><a href="/cn/show/1">1</a></li></ul>'), { ids: ['1', '1'], complete: true });
  assert.equal(extractManweiResponse('<div class="p-list"><div>broken').complete, false);
  assert.equal(extractManweiResponse('<nav><a href="/cn/show/1">nav</a></nav>').complete, false);
});

test('case-list responses retain case order and duplicates without counting navigation or footer links', () => {
  const html = '<nav><a href="/cn/show/9">outside</a></nav><ul class="case-list"><li><a class="case-card" href="/cn/show/1059"><div class="case-thumb"><img src="/case.jpg"/></div><div class="case-body"><h2>Case</h2></div></a></li><li><a class="case-card" href="/cn/show/1058">Next</a></li><li><a href="/cn/show/1058">Duplicate</a></li></ul><footer><a href="/cn/show/7">outside</a></footer>';
  assert.deepEqual(extractManweiResponse(html), { ids: ['1059', '1058', '1058'], complete: true });
  assert.deepEqual(extractManweiResponse('<ul class="case-list"></ul>'), { ids: [], complete: true });
  assert.deepEqual(extractManweiResponse('<ul class="case-list"><li><a href="/cn/show/1059">broken'), { ids: [], complete: false });
  assert.deepEqual(extractManweiResponse('<ul class="unknown-list"><li><a href="/cn/show/1059">unknown</a></li></ul>'), { ids: [], complete: false });
});

test('machine failures override AI completeness without changing numeric scores or certifying unrelated requirements', async () => {
  const f = await fixture(); try {
    f.register(); const run = (await verifyTaskMigration(f.evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()))!;
    const report = structuredClone(f.evaluation.report!), scores = structuredClone(report.scores); report.completeness!.state = 'complete';
    mergeMigrationReport(report, run); assert.equal(report.completeness!.state, 'incomplete'); assert.equal(report.quality, 'failed'); assert.deepEqual(report.scores, scores);
    run.state = 'complete'; const other = structuredClone(f.evaluation.report!); mergeMigrationReport(other, run); assert.equal(other.completeness!.state, 'unverified');
  } finally { await f.close(); }
});

test('interrupted program verification resumes the validated AI report without a new scoring request', async () => {
  const f = await fixture(); try {
    f.register(); const evaluation = f.store.task(f.evaluation.id)!;
    assert.equal(checkpointMigrationReport(evaluation, evaluation.report!, f.store), true);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(finishPendingMigrationReport(evaluation, f.store, f.vault, f.directory, controller.signal, f.dependencies()));
    assert.ok(f.store.task(evaluation.id)!.migrationPendingReport);
    const resumed = f.store.task(evaluation.id)!;
    assert.equal(await finishPendingMigrationReport(resumed, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), true);
    const saved = f.store.task(evaluation.id)!;
    assert.equal(saved.migrationPendingReport, undefined); assert.equal(saved.report!.migrationCheck!.state, 'incomplete');
    assert.equal(saved.report!.scores[0].value, 90); assert.equal(saved.threadId, evaluation.threadId); assert.equal(f.store.usage.entries(saved.id).length, 0);
  } finally { await f.close(); }
});

test('changed checkpoint bindings or evidence cannot silently reuse an old score', async () => {
  const f = await fixture(); try {
    f.register(); const evaluation = f.store.task(f.evaluation.id)!;
    checkpointMigrationReport(evaluation, evaluation.report!, f.store);
    const changed = { ...evaluation, versionId: randomUUID() };
    await assert.rejects(finishPendingMigrationReport(changed, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), /检查点与当前/);
    writeFileSync(join(f.directory, 'automation-runs', evaluation.id, 'evidence', f.sourceFiles[0].name), '{}');
    await assert.rejects(finishPendingMigrationReport(evaluation, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), /检查点证据已变化/);
    assert.ok(f.store.task(evaluation.id)!.migrationPendingReport); assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test('AI-added source identities cannot become confirmed failures merely by citing a valid source file', async () => {
  const f = await fixture(); try {
    const { manifest } = f.register(), migration = structuredClone(manifest.migration!);
    migration.entities.records.push({ key: { namespace: 'manwei-sav.com/cn', kind: 'detail', id: 'invented' }, evidence: migration.entities.records[0].evidence });
    const task = { ...f.evaluation, requirementsId: manifest.id };
    new ManifestStore(f.store).save(task, { sourceComplete: false, limitations: manifest.limitations, evidence: manifest.evidence, items: manifest.items, migration }, 'ai', manifest.id);
    await assert.rejects(verifyTaskMigration(task, f.store, f.vault, f.directory, new AbortController().signal, f.dependencies()), /不能把AI新增标识当作来源事实/);
    assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});
