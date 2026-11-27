import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../server/app.js';
import {
  defaultAutomationSettings,
  defaultDeliveryPolicy,
  type AutomationReport,
  type AutomationTask,
} from '../shared/automation.js';
import { AutomationStore } from '../server/automation/store.js';
import { AutomationWorker } from '../server/automation/worker.js';
import { queueDelivery, reportPassedDeliveryGate, parseDeliveryVerification, executeDelivery, verifyDelivery } from '../server/automation/delivery.js';
import { advanceOptimization, applyOptimizationAction } from '../server/automation/optimization.js';
import { deliveredSiteUrl, primarySiteUrl } from '../shared/site-delivery.js';

function makeReport(score: number, quality: AutomationReport['quality'] = score >= 80 ? 'passed' : 'failed', store?: AutomationStore, task?: AutomationTask): AutomationReport {
  const criteria = task?.rule?.criteria || [];
  return {
    summary: `Score ${score}`,
    quality,
    scores: [
      { viewport: 'desktop', value: score },
      { viewport: 'mobile', value: score },
    ],
    assessments: criteria.flatMap(criterion =>
      criterion.viewports.map(viewport => ({
        criterionId: criterion.id,
        viewport,
        score,
        passed: score >= 80,
        reason: '证据充分',
        evidence: [],
      })),
    ),
    issues: score >= 80 ? [] : [{ severity: 'major', title: 'Layout gap', detail: 'Need polish', evidence: [] }],
    coverage: { verified: ['首页'], unverified: [], outOfScope: [] },
    artifacts: [],
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'auto-delivery-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const envId = randomUUID();
  const plainEnvId = randomUUID();
  f.vault.update({
    threshold: 80,
    paused: true,
    model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [
      {
        id: envId,
        name: 'HK',
        origin: 'https://hk.test',
        apiOrigin: 'http://127.0.0.1:1',
        token: 'secret-hk-token',
        defaultRootDomain: '-hk.test',
        delivery: { ...defaultDeliveryPolicy, enabled: true, auto: false, requirePassed: true, token: 'secret-migrate-token' },
      },
      {
        id: plainEnvId,
        name: 'Plain',
        origin: 'https://plain.test',
        apiOrigin: 'https://plain.test',
        token: 'secret-plain-token',
      },
    ],
  });
  const resource = f.automationStore.saveResource({
    name: 'Demo Site',
    scenario: 'materials',
    description: 'Build demo site',
    contentUrl: 'https://source.test',
    referenceUrl: '',
    externalSource: '',
    externalId: '',
    files: [],
  });
  return {
    ...f,
    directory,
    headers,
    envId,
    plainEnvId,
    resource,
    async close() {
      await f.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('delivery-preference updates env.delivery.auto without losing tokens and enforces auth and config guards', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.app.inject({ method: 'PUT', url: `/api/automation/environments/${f.envId}/delivery-preference`, payload: { auto: true } })).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/automation/environments/${f.envId}/delivery-preference`,
          headers: { authorization: `Bearer ${f.vault.credentials.readToken}` },
          payload: { auto: true },
        })
      ).statusCode,
      401,
    );

    const enabled = await f.app.inject({
      method: 'PUT',
      url: `/api/automation/environments/${f.envId}/delivery-preference`,
      headers: f.headers,
      payload: { auto: true },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.ok(!enabled.body.includes('secret-hk-token'));
    assert.ok(!enabled.body.includes('secret-migrate-token'));
    const envPublic = enabled.json().environments.find((item: { id: string }) => item.id === f.envId);
    assert.equal(envPublic.delivery.auto, true);
    assert.equal(envPublic.delivery.hasToken, true);
    assert.equal(envPublic.hasToken, true);

    const stored = f.vault.get().environments.find(item => item.id === f.envId)!;
    assert.equal(stored.token, 'secret-hk-token');
    assert.equal(stored.delivery?.token, 'secret-migrate-token');
    assert.equal(stored.delivery?.auto, true);

    const disabled = await f.app.inject({
      method: 'PUT',
      url: `/api/automation/environments/${f.envId}/delivery-preference`,
      headers: f.headers,
      payload: { auto: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(f.vault.get().environments.find(item => item.id === f.envId)!.delivery?.auto, false);

    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/automation/environments/${f.plainEnvId}/delivery-preference`,
          headers: f.headers,
          payload: { auto: true },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: `/api/automation/environments/${randomUUID()}/delivery-preference`,
          headers: f.headers,
          payload: { auto: true },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});

test('POST /api/automation/tasks validates autoDelivery guards, freezes value and propagates to children', async () => {
  const f = await fixture();
  try {
    const createTask = (payload: Record<string, unknown>) =>
      f.app.inject({
        method: 'POST',
        url: '/api/automation/tasks',
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload,
      });

    // Disabled delivery on plainEnvId -> 409
    const plainRes = await createTask({
      resourceIds: [f.resource.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.plainEnvId,
      autoDelivery: true,
    });
    assert.equal(plainRes.statusCode, 409);

    // Missing migration token -> 409
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId ? { ...env, delivery: { ...env.delivery!, token: '', clearToken: true } } : env,
      ),
    });
    const noTokenRes = await createTask({
      resourceIds: [f.resource.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      autoDelivery: true,
    });
    assert.equal(noTokenRes.statusCode, 409);

    // Restore token
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId ? { ...env, delivery: { ...env.delivery!, token: 'secret-migrate-token' } } : env,
      ),
    });

    // Site already has delivery -> 409
    const deliveredSite = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'DeliveredSite',
      url: 'https://hk-existing.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(deliveredSite);
    const existingEval = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: deliveredSite.id,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    existingEval.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true },
      status: 'completed',
      sourceEnvironmentId: f.envId,
      sourceSiteId: deliveredSite.siteId,
      sourceUrl: deliveredSite.url,
      evaluationTaskId: existingEval.id,
      target: { siteId: randomUUID(), siteUrl: 'https://de-existing.test/' },
      updatedAt: Date.now(),
      error: '',
      checks: [],
    };
    f.automationStore.put(existingEval);
    const dupSiteRes = await createTask({
      resourceIds: [f.resource.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      generatedSiteId: deliveredSite.id,
      autoDelivery: true,
    });
    assert.equal(dupSiteRes.statusCode, 409);

    // Missing applicable rule -> 409
    f.automationStore.db.prepare('DELETE FROM auto_rules').run();
    const noRuleRes = await createTask({
      resourceIds: [f.resource.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      autoDelivery: true,
    });
    assert.equal(noRuleRes.statusCode, 409);

    // Re-publish a rule and verify freezing & propagation
    const publishedRule = f.automationStore.publish({
      name: 'Site rule',
      kind: 'site',
      sop: 'Inspect site',
      references: '',
      criteria: [{ id: 'hero', label: 'Hero', weight: 100, instruction: 'Check hero', required: true, viewports: ['desktop', 'mobile'], scopes: ['homepage', 'site'] }],
    });
    assert.ok(publishedRule.id);

    const createdRes = await createTask({
      resourceIds: [f.resource.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      autoDelivery: true,
    });
    assert.equal(createdRes.statusCode, 201, createdRes.body);
    const rootId = createdRes.json().items[0].id as string;
    const root = f.automationStore.task(rootId)!;
    assert.equal(root.autoDelivery, true);

    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: root.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'NewSite',
      url: 'https://hk-new.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);
    root.generatedSiteId = site.id;
    root.siteUrl = site.url;
    root.status = 'completed';
    f.automationStore.put(root);

    const childEval = f.automationStore.ensureEvaluation(root, defaultAutomationSettings);
    assert.equal(childEval.autoDelivery, true);

    const inputSection = (await f.app.inject({ url: `/api/automation/tasks/${root.id}/sections/input`, headers: f.headers })).json();
    assert.equal(inputSection.autoDelivery, true);
  } finally {
    await f.close();
  }
});

test('non-optimization generation with autoDelivery=true skips evaluation when autoEvaluate=false and queues direct delivery; autoDelivery=false suppresses env auto', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    // Enable env.delivery.auto = true while settings.autoEvaluate = false
    await f.app.inject({
      method: 'PUT',
      url: `/api/automation/environments/${f.envId}/delivery-preference`,
      headers: f.headers,
      payload: { auto: true },
    });
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: false });

    const site1 = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'Site1',
      url: 'https://hk-1.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site1);
    const gen1 = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: site1.id,
        autoDelivery: true,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    assert.equal(gen1.autoEvaluate, false);
    f.automationStore.put(gen1);

    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async (task, store) => {
          store.beginSiteChange(task);
          // Pause worker right as generation completes so queued direct delivery is observable before runDelivery executes
          if (task.scenario === 'materials') {
            f.vault.updateAutomation({ ...f.vault.automation(), enabled: false });
          }
        },
        evaluation: async (task, store) => {
          task.report = makeReport(92, 'passed', store, task);
        },
      },
      () => true,
    );

    await worker.tick();
    let updatedGen1 = f.automationStore.task(gen1.id)!;
    for (let i = 0; i < 80; i++) {
      updatedGen1 = f.automationStore.task(gen1.id)!;
      if (updatedGen1.status === 'completed' && updatedGen1.delivery) break;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(updatedGen1.evaluationTaskId, undefined, 'autoEvaluate=false must skip evaluation even with autoDelivery=true');
    assert.equal(updatedGen1.autoDelivery, true);
    assert.equal(updatedGen1.delivery?.status, 'queued');
    assert.equal(updatedGen1.delivery?.evaluationTaskId, '');

    // Now test explicit autoDelivery=false overrides env.delivery.auto=true even for migration+site
    const migrationRes = f.automationStore.saveResource({
      name: 'Migration Suppressed',
      scenario: 'migration',
      description: '',
      contentUrl: 'https://source.test',
      referenceUrl: '',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const site2 = {
      id: randomUUID(),
      resourceId: migrationRes.id,
      versionId: f.automationStore.versions(migrationRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'Site2',
      url: 'https://hk-2.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site2);
    f.vault.updateAutomation({ ...f.vault.automation(), enabled: true, autoEvaluate: true });
    const eval2 = f.automationStore.create(
      {
        resourceIds: [migrationRes.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.envId,
        generatedSiteId: site2.id,
        autoDelivery: false,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    f.automationStore.put(eval2);

    await worker.tick();
    for (let i = 0; i < 80 && f.automationStore.task(eval2.id)?.status !== 'completed'; i++) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(f.automationStore.task(eval2.id)!.status, 'completed');
    assert.equal(f.automationStore.task(eval2.id)!.delivery, undefined);

    // Legacy fallback: migration+site with autoDelivery=undefined and env.delivery.auto=true still auto-delivers
    const site3 = {
      id: randomUUID(),
      resourceId: migrationRes.id,
      versionId: f.automationStore.versions(migrationRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'Site3',
      url: 'https://hk-3.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site3);
    const evalLegacy = f.automationStore.create(
      {
        resourceIds: [migrationRes.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.envId,
        generatedSiteId: site3.id,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    assert.equal(f.automationStore.task(evalLegacy.id)!.autoDelivery, undefined);
    f.automationStore.put(evalLegacy);
    f.vault.updateAutomation({ ...f.vault.automation(), enabled: true });

    await worker.tick();
    for (let i = 0; i < 80; i++) {
      const ev = f.automationStore.task(evalLegacy.id)!;
      if (ev.status === 'completed' && ev.delivery) break;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.ok(f.automationStore.task(evalLegacy.id)!.delivery, 'legacy task with autoDelivery=undefined uses env.delivery.auto');
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('optimization workflow holds auto-delivery until optimization reaches target and notifies without delivering when stopped', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    const templateRes = f.automationStore.saveResource({
      name: 'Template Optimization',
      scenario: 'site-template',
      description: '',
      contentUrl: '',
      referenceUrl: 'https://ref.test',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const site = {
      id: randomUUID(),
      resourceId: templateRes.id,
      versionId: f.automationStore.versions(templateRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'OptSite',
      url: 'https://opt.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: true });
    const root = f.automationStore.create(
      {
        resourceIds: [templateRes.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: site.id,
        autoDelivery: true,
        optimization: { targetScore: 85, maxRounds: 2, maxCostCny: null },
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    root.status = 'completed';
    root.stopped = true;
    root.generation = { prepared: true, conversationId: randomUUID() };
    f.automationStore.beginSiteChange(root);
    root.optimization!.currentRevision = root.siteRevision!;
    root.optimization!.rounds[0].revision = root.siteRevision!;
    f.automationStore.put(root);

    // Round 0 evaluation completes at 65 (< 85 target): must NOT queue delivery yet
    const round0Eval = f.automationStore.ensureEvaluation(root, f.vault.automation());
    f.automationStore.put(round0Eval);

    let evalScore = 65;
    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async (task, store) => {
          store.beginSiteChange(task);
        },
        evaluation: async (task, store) => {
          task.report = makeReport(evalScore, evalScore >= 80 ? 'passed' : 'failed', store, task);
        },
      },
      () => true,
    );

    await worker.tick();
    for (let i = 0; i < 80 && f.automationStore.task(round0Eval.id)?.status !== 'completed'; i++) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(f.automationStore.task(round0Eval.id)!.status, 'completed');
    assert.equal(f.automationStore.task(round0Eval.id)!.delivery, undefined, 'intermediate evaluation must not trigger delivery');

    // Advance optimization to planning and trigger round 1 repair
    advanceOptimization(f.automationStore.task(root.id)!, f.automationStore, f.vault.automation());
    const planningRoot = f.automationStore.task(root.id)!;
    assert.equal(planningRoot.optimization!.state, 'planning');
    applyOptimizationAction(
      planningRoot,
      {
        action: 'repair',
        reason: 'Fix hero contrast',
        message: 'Improve contrast',
        evidence: ['shot.png'],
        imageEvidence: ['shot.png'],
        progress: { improved: false, reason: 'round 1', resolved: [], remaining: ['hero'], unverified: [], introduced: [] },
      },
      f.automationStore,
      f.vault.automation(),
    );

    const repairGenId = f.automationStore.task(root.id)!.optimization!.activeTaskId;
    const repairGen = f.automationStore.task(repairGenId)!;
    assert.equal(repairGen.autoDelivery, true);
    repairGen.status = 'completed';
    repairGen.stopped = true;
    f.automationStore.beginSiteChange(repairGen);
    const updatedRoot = f.automationStore.task(root.id)!;
    updatedRoot.optimization!.currentRevision = repairGen.siteRevision!;
    updatedRoot.optimization!.rounds[1].revision = repairGen.siteRevision!;
    f.automationStore.put(updatedRoot);

    // Round 1 evaluation reaches 92 (>= 85): advanceOptimization marks completed & worker.tick queues delivery on reportId
    evalScore = 92;
    advanceOptimization(f.automationStore.task(root.id)!, f.automationStore, f.vault.automation());
    const round1EvalId = f.automationStore.task(root.id)!.optimization!.activeTaskId;
    const round1Eval = f.automationStore.task(round1EvalId)!;
    round1Eval.status = 'completed';
    round1Eval.stopped = true;
    round1Eval.report = makeReport(92, 'passed', f.automationStore, round1Eval);
    f.automationStore.publishSiteReport(round1Eval);
    f.automationStore.put(round1Eval);

    await worker.tick();
    const completedRoot = f.automationStore.task(root.id)!;
    assert.equal(completedRoot.optimization!.state, 'completed');
    const deliveredEval = f.automationStore.task(round1EvalId)!;
    assert.ok(deliveredEval.delivery, 'final optimization evaluation must auto-queue delivery');
    assert.ok(f.automationStore.events(round1EvalId).some(ev => ev.message.includes('已排队跨环境交付')));

    // Second optimization workflow that stops without reaching target: notifies 自动交付未启动 without queuing delivery
    const siteStopped = {
      id: randomUUID(),
      resourceId: templateRes.id,
      versionId: f.automationStore.versions(templateRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'OptStoppedSite',
      url: 'https://opt-stopped.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(siteStopped);
    const stoppedRoot = f.automationStore.create(
      {
        resourceIds: [templateRes.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: siteStopped.id,
        autoDelivery: true,
        optimization: { targetScore: 85, maxRounds: 1, maxCostCny: null },
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    stoppedRoot.status = 'completed';
    stoppedRoot.stopped = true;
    stoppedRoot.optimization!.rounds[0].number = 1;
    f.automationStore.beginSiteChange(stoppedRoot);
    stoppedRoot.optimization!.currentRevision = stoppedRoot.siteRevision!;
    stoppedRoot.optimization!.rounds[0].revision = stoppedRoot.siteRevision!;
    f.automationStore.put(stoppedRoot);
    const stoppedEval = f.automationStore.ensureEvaluation(stoppedRoot, f.vault.automation());
    stoppedEval.status = 'completed';
    stoppedEval.stopped = true;
    stoppedEval.report = makeReport(60, 'failed', f.automationStore, stoppedEval);
    f.automationStore.publishSiteReport(stoppedEval);
    f.automationStore.put(stoppedEval);

    await worker.tick();
    const stoppedAfter = f.automationStore.task(stoppedRoot.id)!;
    assert.equal(stoppedAfter.optimization!.state, 'stopped');
    assert.equal(f.automationStore.task(stoppedEval.id)!.delivery, undefined);
    assert.ok(f.automationStore.notices().some(notice => notice.taskId === stoppedRoot.id && notice.title === '自动交付未启动'));
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('completed delivery promotes DE URL as primary across projections, search, sites and external API while keeping stale/unverified revisions unpromoted', async () => {
  const f = await fixture();
  try {
    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'PrimaryLinkSite',
      url: 'https://hk-source.kooboo.io/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);
    const gen = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.envId,
        generatedSiteId: site.id,
        autoDelivery: true,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    f.automationStore.beginSiteChange(gen);
    gen.status = 'completed';
    gen.stopped = true;
    f.automationStore.put(gen);

    const evalTask = f.automationStore.ensureEvaluation(gen, defaultAutomationSettings);
    evalTask.status = 'completed';
    evalTask.stopped = true;
    evalTask.report = makeReport(94, 'passed', f.automationStore, evalTask);
    f.automationStore.publishSiteReport(evalTask);
    evalTask.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true },
      status: 'verifying',
      sourceEnvironmentId: f.envId,
      sourceSiteId: site.siteId,
      sourceUrl: site.url,
      evaluationTaskId: evalTask.id,
      target: { siteId: randomUUID(), siteUrl: 'https://demo.kooboo.de/' },
      updatedAt: Date.now(),
      error: '',
      checks: [],
    };
    f.automationStore.put(evalTask);

    // While verifying, deliveredUrl must NOT be promoted yet
    assert.equal(deliveredSiteUrl({ status: 'verifying', targetUrl: 'https://demo.kooboo.de/' }), undefined);
    assert.deepEqual(primarySiteUrl(site.url, { status: 'verifying', targetUrl: 'https://demo.kooboo.de/' }), {
      url: 'https://hk-source.kooboo.io/',
      delivered: false,
    });
    const siteWhileVerifying = f.automationStore.site(site.id)!;
    assert.equal(siteWhileVerifying.hasDelivery, true);
    assert.equal(siteWhileVerifying.deliveredUrl, undefined);
    const resultWhileVerifying = (
      await f.app.inject({
        url: `/api/v1/automation/tasks/${gen.id}/result`,
        headers: { authorization: `Bearer ${f.vault.credentials.readToken}` },
      })
    ).json();
    assert.equal(resultWhileVerifying.siteUrl, site.url);
    assert.equal(resultWhileVerifying.deliveredUrl, null);

    // Complete delivery
    evalTask.delivery.status = 'completed';
    evalTask.delivery.verifiedAt = Date.now();
    f.automationStore.put(evalTask);

    assert.equal(deliveredSiteUrl({ status: 'completed', targetUrl: 'https://demo.kooboo.de/' }), 'https://demo.kooboo.de/');
    assert.deepEqual(primarySiteUrl(site.url, { status: 'completed', targetUrl: 'https://demo.kooboo.de/' }), {
      url: 'https://demo.kooboo.de/',
      delivered: true,
    });

    // Site deliveries list + search by DE URL
    const deliveriesRes = (await f.app.inject({ url: '/api/automation/site-deliveries?q=demo.kooboo.de', headers: f.headers })).json();
    assert.equal(deliveriesRes.total, 1);
    assert.deepEqual(deliveriesRes.items[0].delivery, {
      taskId: evalTask.id,
      status: 'completed',
      targetUrl: 'https://demo.kooboo.de/',
    });

    // Task summary on root generation task and evaluation task
    for (const id of [gen.id, evalTask.id]) {
      const summary = (await f.app.inject({ url: `/api/automation/tasks/${id}/summary`, headers: f.headers })).json();
      assert.equal(summary.deliveryEnabled, true);
      assert.deepEqual(summary.delivery, {
        taskId: evalTask.id,
        status: 'completed',
        targetUrl: 'https://demo.kooboo.de/',
      });
    }

    // store.sites() / store.site() and saveSite stripping
    const projectedSite = f.automationStore.site(site.id)!;
    assert.equal(projectedSite.deliveredUrl, 'https://demo.kooboo.de/');
    assert.equal(projectedSite.hasDelivery, true);
    f.automationStore.saveSite(projectedSite);
    const rawSiteRow = f.automationStore.db.prepare('SELECT json FROM auto_sites WHERE id=?').get(site.id) as { json: string };
    assert.ok(!rawSiteRow.json.includes('deliveredUrl'));
    assert.ok(!rawSiteRow.json.includes('hasDelivery'));

    // External v1 result API
    const externalResult = (
      await f.app.inject({
        url: `/api/v1/automation/tasks/${gen.id}/result`,
        headers: { authorization: `Bearer ${f.vault.credentials.readToken}` },
      })
    ).json();
    assert.equal(externalResult.siteUrl, site.url);
    assert.equal(externalResult.deliveredUrl, 'https://demo.kooboo.de/');

    // Startup backfill for older auto_task_index rows missing delivery.targetUrl / summary.autoDelivery
    f.automationStore.db
      .prepare(
        "UPDATE auto_task_index SET json = json_remove(json, '$.delivery.targetUrl', '$.summary.autoDelivery') WHERE id=?",
      )
      .run(evalTask.id);
    assert.equal(f.automationStore.header(evalTask.id)!.delivery!.targetUrl, undefined);
    const reloadedStore = new AutomationStore(f.automationStore.db);
    const backfilledHeader = reloadedStore.header(evalTask.id)!;
    assert.equal(backfilledHeader.delivery!.targetUrl, 'https://demo.kooboo.de/');
    assert.equal(backfilledHeader.summary.autoDelivery, true);

    // Continuation changes siteState.revision -> stale delivery is no longer promoted as current primary URL
    const cont = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.envId,
        generatedSiteId: site.id,
        requirements: 'Update',
      },
      defaultAutomationSettings,
    )[0];
    f.automationStore.beginSiteChange(cont);
    assert.equal(f.automationStore.site(site.id)!.deliveredUrl, undefined);
    assert.equal(f.automationStore.site(site.id)!.hasDelivery, true);
    const contSummary = (await f.app.inject({ url: `/api/automation/tasks/${cont.id}/summary`, headers: f.headers })).json();
    assert.equal(contSummary.delivery, undefined);
    const contDeliverySection = (await f.app.inject({ url: `/api/automation/tasks/${cont.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(contDeliverySection.task.delivery.target.siteUrl, 'https://demo.kooboo.de/');
  } finally {
    await f.close();
  }
});

test('requirePassed delivery gate accepts unverified reports whose applicable criteria meet threshold while blocking true gaps', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    const createSiteEval = (nameSuffix: string) => {
      const site = {
        id: randomUUID(),
        resourceId: f.resource.id,
        versionId: f.automationStore.versions(f.resource.id)[0].id,
        environmentId: f.envId,
        siteId: randomUUID(),
        name: `GateSite-${nameSuffix}`,
        url: `https://gate-${nameSuffix}.kooboo.test/`,
        createdAt: Date.now(),
      };
      f.automationStore.saveSite(site);
      const gen = f.automationStore.create(
        {
          resourceIds: [f.resource.id],
          kind: 'generation',
          scope: 'homepage',
          environmentId: f.envId,
          generatedSiteId: site.id,
          autoDelivery: true,
          requirements: '',
        },
        defaultAutomationSettings,
      )[0];
      f.automationStore.beginSiteChange(gen);
      gen.status = 'completed';
      gen.stopped = true;
      f.automationStore.put(gen);
      const evalTask = f.automationStore.ensureEvaluation(gen, defaultAutomationSettings);
      evalTask.status = 'completed';
      evalTask.stopped = true;
      f.automationStore.put(evalTask);
      return { site, gen, evalTask };
    };

    // 1. unverified solely due to free-text coverage.unverified disclaimers (all scored >= 80, only minor issue) -> passes gate
    const ok = createSiteEval('ok');
    ok.evalTask.report = makeReport(93, 'unverified', f.automationStore, ok.evalTask);
    ok.evalTask.report.issues = [{ severity: 'minor', title: 'Heading wrap', detail: 'Minor polish', evidence: [] }];
    ok.evalTask.report.coverage.unverified = ['正式域名上线及搜索引擎收录未核验'];
    f.automationStore.put(ok.evalTask);
    assert.equal(reportPassedDeliveryGate(ok.evalTask, 80), true);
    queueDelivery(ok.evalTask, f.automationStore, f.vault);
    assert.equal(ok.evalTask.delivery?.status, 'queued');

    // Also verify worker auto-delivery queues an unverified high-scoring report when requirePassed: true
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: true });
    const autoSite = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'GateSite-auto',
      url: 'https://gate-auto.kooboo.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(autoSite);
    const autoEval = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: autoSite.id,
        autoDelivery: true,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async () => {},
        evaluation: async (task, store) => {
          task.report = makeReport(92, 'unverified', store, task);
          task.report.coverage.unverified = ['正式域名尚未绑定'];
          store.publishSiteReport(task);
          store.put(task);
        },
      },
      () => true,
      async () => ({ action: 'interrupt', reason: 'unused', evidence: [] }),
    );
    await worker.tick();
    for (let i = 0; i < 60 && !f.automationStore.task(autoEval.id)?.delivery; i++) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.ok(f.automationStore.task(autoEval.id)?.delivery, 'worker should auto-queue delivery on high-scoring unverified report');
    await worker.stop();
    worker = undefined;

    // 2. score: null on an assessment -> blocked
    const nullScore = createSiteEval('null-score');
    nullScore.evalTask.report = makeReport(93, 'unverified', f.automationStore, nullScore.evalTask);
    nullScore.evalTask.report.assessments[0]!.score = null;
    nullScore.evalTask.report.assessments[0]!.passed = null;
    assert.equal(reportPassedDeliveryGate(nullScore.evalTask, 80), false);
    assert.throws(() => queueDelivery(nullScore.evalTask, f.automationStore, f.vault), /评测通过/);

    // 3. completeness.state === 'unverified' or sourceComplete: false -> blocked
    const compUnverified = createSiteEval('comp-unverified');
    compUnverified.evalTask.report = makeReport(93, 'unverified', f.automationStore, compUnverified.evalTask);
    compUnverified.evalTask.report.completeness = {
      manifestId: randomUUID(),
      manifestRevision: 1,
      sourceComplete: true,
      state: 'unverified',
      checks: [],
    };
    assert.equal(reportPassedDeliveryGate(compUnverified.evalTask, 80), false);
    assert.throws(() => queueDelivery(compUnverified.evalTask, f.automationStore, f.vault), /评测通过/);

    const sourceIncomplete = createSiteEval('source-incomplete');
    sourceIncomplete.evalTask.report = makeReport(93, 'unverified', f.automationStore, sourceIncomplete.evalTask);
    sourceIncomplete.evalTask.report.completeness = {
      manifestId: randomUUID(),
      manifestRevision: 1,
      sourceComplete: false,
      state: 'complete',
      checks: [],
    };
    assert.equal(reportPassedDeliveryGate(sourceIncomplete.evalTask, 80), false);
    assert.throws(() => queueDelivery(sourceIncomplete.evalTask, f.automationStore, f.vault), /评测通过/);

    // 4. score < threshold -> blocked
    const lowScore = createSiteEval('low-score');
    lowScore.evalTask.report = makeReport(78, 'unverified', f.automationStore, lowScore.evalTask);
    assert.equal(reportPassedDeliveryGate(lowScore.evalTask, 80), false);
    assert.throws(() => queueDelivery(lowScore.evalTask, f.automationStore, f.vault), /评测通过/);

    // 5. major issue -> blocked
    const majorIssue = createSiteEval('major-issue');
    majorIssue.evalTask.report = makeReport(92, 'unverified', f.automationStore, majorIssue.evalTask);
    majorIssue.evalTask.report.issues = [{ severity: 'major', title: 'Broken nav', detail: 'Nav overlaps', evidence: [] }];
    assert.equal(reportPassedDeliveryGate(majorIssue.evalTask, 80), false);
    assert.throws(() => queueDelivery(majorIssue.evalTask, f.automationStore, f.vault), /评测通过/);

    // 6. required criterion passed: false -> blocked
    const reqFailed = createSiteEval('req-failed');
    reqFailed.evalTask.rule!.criteria[0]!.required = true;
    reqFailed.evalTask.report = makeReport(92, 'unverified', f.automationStore, reqFailed.evalTask);
    reqFailed.evalTask.report.assessments[0]!.passed = false;
    assert.equal(reportPassedDeliveryGate(reqFailed.evalTask, 80), false);
    assert.throws(() => queueDelivery(reqFailed.evalTask, f.automationStore, f.vault), /评测通过/);

    // 7. templateWorkflow with unverified quality -> blocked
    const templateGap = createSiteEval('template-gap');
    templateGap.evalTask.templateWorkflow = { version: 1, rootTaskId: templateGap.gen.id, checklistId: randomUUID() };
    templateGap.evalTask.report = makeReport(92, 'unverified', f.automationStore, templateGap.evalTask);
    assert.equal(reportPassedDeliveryGate(templateGap.evalTask, 80), false);
    assert.throws(() => queueDelivery(templateGap.evalTask, f.automationStore, f.vault), /评测通过/);

    // 8. quality: 'failed' -> blocked
    const failed = createSiteEval('failed');
    failed.evalTask.report = makeReport(92, 'failed', f.automationStore, failed.evalTask);
    assert.equal(reportPassedDeliveryGate(failed.evalTask, 80), false);
    assert.throws(() => queueDelivery(failed.evalTask, f.automationStore, f.vault), /评测通过/);
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('parseDeliveryVerification rejects prose-joined evidence filenames and /delivery/verify resets verificationThreadId while keeping artifacts and target', async () => {
  const pngA = `${randomUUID()}.png`;
  const pngB = `${randomUUID()}.png`;
  assert.throws(
    () =>
      parseDeliveryVerification({
        summary: 'Verified',
        verified: ['首页一致'],
        unverified: [],
        outOfScope: ['正式域名与 DNS 解析'],
        evidence: [`${pngA}、${pngB}：桌面四屏`],
      }),
    /单个裸文件名/,
  );
  assert.throws(
    () =>
      parseDeliveryVerification({
        summary: 'Verified',
        verified: ['首页一致'],
        unverified: [],
        outOfScope: [],
        evidence: [`evidence/${pngA}`],
      }),
    /单个裸文件名/,
  );
  const valid = parseDeliveryVerification({
    summary: 'Verified',
    verified: ['首页一致'],
    unverified: [],
    outOfScope: ['正式域名与 DNS 解析'],
    evidence: [pngA, pngB],
  });
  assert.deepEqual(valid.evidence, [pngA, pngB]);
  assert.deepEqual(valid.outOfScope, ['正式域名与 DNS 解析']);

  const f = await fixture();
  try {
    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'VerifyRetrySite',
      url: 'https://verify-retry.kooboo.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);
    const evalTask = f.automationStore.create(
      {
        resourceIds: [f.resource.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: site.id,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    evalTask.status = 'completed';
    evalTask.stopped = true;
    evalTask.report = makeReport(93, 'passed', f.automationStore, evalTask);
    const artifact = { id: randomUUID(), name: pngA, type: 'image/png', size: 123, sha256: '0'.repeat(64) };
    evalTask.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true },
      status: 'failed',
      stopped: true,
      verificationThreadId: 'thread-stale-123',
      artifacts: [artifact],
      sourceEnvironmentId: f.envId,
      sourceSiteId: site.siteId,
      sourceUrl: site.url,
      evaluationTaskId: evalTask.id,
      target: { siteId: randomUUID(), siteUrl: 'https://demo.kooboo.nl' },
      updatedAt: Date.now(),
      error: '交付核验引用了不存在的证据',
      checks: [],
    };
    f.automationStore.put(evalTask);

    const res = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${evalTask.id}/delivery/verify`,
      headers: f.headers,
    });
    assert.equal(res.statusCode, 200);
    const updated = f.automationStore.task(evalTask.id)!.delivery!;
    assert.equal(updated.status, 'queued');
    assert.equal(updated.verificationThreadId, undefined);
    assert.equal(updated.target!.siteUrl, 'https://demo.kooboo.nl');
    assert.deepEqual(updated.artifacts, [artifact]);
  } finally {
    await f.close();
  }
});

test('POST /api/automation/tasks freezes env.delivery.auto when autoDelivery is omitted across scopes including homepage', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    f.automationStore.publish({
      name: 'Site rule',
      kind: 'site',
      sop: 'Inspect site',
      references: '',
      criteria: [{ id: 'hero', label: 'Hero', weight: 100, instruction: 'Check hero', required: true, viewports: ['desktop', 'mobile'], scopes: ['homepage', 'site'] }],
    });

    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId
          ? { ...env, delivery: { ...env.delivery!, enabled: true, auto: true, requirePassed: false, token: 'secret-migrate-token' } }
          : env,
      ),
    });
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: false });

    const upgradeRes = f.automationStore.saveResource({
      name: 'Gallery Upgrade',
      scenario: 'upgrade',
      description: 'Upgrade gallery homepage',
      contentUrl: 'https://source.test',
      referenceUrl: 'https://ref.test',
      externalSource: 'kooboo-workbench',
      externalId: 'ext-upgrade-homepage-1',
      files: [],
    });

    const createRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: {
        resourceIds: [upgradeRes.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
      },
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const rootId = createRes.json().items[0].id as string;
    const root = f.automationStore.task(rootId)!;
    assert.equal(root.autoDelivery, true);

    const inputSection = (await f.app.inject({ url: `/api/automation/tasks/${rootId}/sections/input`, headers: f.headers })).json();
    assert.equal(inputSection.autoDelivery, true);
    const deliverySection = (await f.app.inject({ url: `/api/automation/tasks/${rootId}/sections/delivery`, headers: f.headers })).json();
    assert.equal(deliverySection.autoDelivery, true);

    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async (task, store) => {
          const site = {
            id: randomUUID(),
            resourceId: task.resourceId,
            versionId: task.versionId,
            environmentId: task.environmentId,
            siteId: randomUUID(),
            name: 'GallerySite',
            url: 'https://gallery-hk.test/',
            createdAt: Date.now(),
          };
          store.saveSite(site);
          task.generatedSiteId = site.id;
          task.siteUrl = site.url;
          store.beginSiteChange(task);
          if (task.scenario === 'upgrade') {
            f.vault.updateAutomation({ ...f.vault.automation(), enabled: false });
          }
        },
        evaluation: async (task, store) => {
          const report = makeReport(92, 'failed', store, task);
          report.issues = [{ severity: 'major', title: 'Address mismatch', detail: 'Needs review', evidence: [] }];
          task.report = report;
          store.publishSiteReport(task);
        },
      },
      () => true,
    );

    await worker.tick();
    let currentGen = f.automationStore.task(rootId)!;
    for (let i = 0; i < 80; i++) {
      currentGen = f.automationStore.task(rootId)!;
      if (currentGen.status === 'completed' && currentGen.delivery) break;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(currentGen.evaluationTaskId, undefined, 'autoEvaluate=false must skip evaluation and queue direct delivery');
    assert.equal(currentGen.autoDelivery, true);
    assert.equal(currentGen.delivery?.status, 'queued');
    await worker.stop();
    worker = undefined;

    // Now set env.delivery.auto = false and create a migration+site evaluation task omitting autoDelivery
    await f.app.inject({
      method: 'PUT',
      url: `/api/automation/environments/${f.envId}/delivery-preference`,
      headers: f.headers,
      payload: { auto: false },
    });
    const migRes = f.automationStore.saveResource({
      name: 'Migration Default Off',
      scenario: 'migration',
      description: 'Migration site',
      contentUrl: 'https://source.test',
      referenceUrl: '',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const migSite = {
      id: randomUUID(),
      resourceId: migRes.id,
      versionId: f.automationStore.versions(migRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'MigSite',
      url: 'https://mig-hk.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(migSite);
    const idempotencyKey = randomUUID();
    const migPayload = {
      resourceIds: [migRes.id],
      kind: 'evaluation',
      scope: 'site',
      environmentId: f.envId,
      generatedSiteId: migSite.id,
    };
    const migRes1 = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': idempotencyKey },
      payload: migPayload,
    });
    assert.equal(migRes1.statusCode, 201, migRes1.body);
    const migEvalId = migRes1.json().items[0].id as string;
    assert.equal(f.automationStore.task(migEvalId)!.autoDelivery, false);

    // Flip preference to true and replay with the same Idempotency-Key -> stays frozen at false
    await f.app.inject({
      method: 'PUT',
      url: `/api/automation/environments/${f.envId}/delivery-preference`,
      headers: f.headers,
      payload: { auto: true },
    });
    const migReplay = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': idempotencyKey },
      payload: migPayload,
    });
    assert.equal(migReplay.statusCode, 201, migReplay.body);
    assert.equal(migReplay.json().items[0].id, migEvalId);
    assert.equal(migReplay.json().items[0].autoDelivery, false);
    assert.equal(f.automationStore.task(migEvalId)!.autoDelivery, false);

    // Worker executes evaluation: must NOT retroactively queue delivery despite env.delivery.auto now being true
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: true });
    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async () => {},
        evaluation: async (task, store) => {
          task.report = makeReport(95, 'passed', store, task);
          store.publishSiteReport(task);
        },
      },
      () => true,
    );
    await worker.tick();
    for (let i = 0; i < 80 && f.automationStore.task(migEvalId)?.status !== 'completed'; i++) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(f.automationStore.task(migEvalId)!.status, 'completed');
    assert.equal(f.automationStore.task(migEvalId)!.delivery, undefined);
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('POST /api/automation/tasks handles omitted autoDelivery gracefully across missing token/rule, delivered site, plain env, and parent precedence', async () => {
  const f = await fixture();
  try {
    f.automationStore.db.prepare('DELETE FROM auto_rules').run();
    f.automationStore.publish({
      name: 'Site rule',
      kind: 'site',
      sop: 'Inspect site',
      references: '',
      criteria: [{ id: 'hero', label: 'Hero', weight: 100, instruction: 'Check hero', required: true, viewports: ['desktop', 'mobile'], scopes: ['homepage', 'site'] }],
    });

    const createTask = (payload: Record<string, unknown>) =>
      f.app.inject({
        method: 'POST',
        url: '/api/automation/tasks',
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload,
      });

    const upgradeRes = f.automationStore.saveResource({
      name: 'Upgrade Res',
      scenario: 'upgrade',
      description: 'Upgrade',
      contentUrl: 'https://source.test',
      referenceUrl: 'https://ref.test',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const appRes = f.automationStore.saveResource({
      name: 'App Res',
      scenario: 'app-template',
      description: 'App without app rule',
      contentUrl: '',
      referenceUrl: '',
      externalSource: '',
      externalId: '',
      files: [],
    });

    // 1. Missing migration token with env.delivery.auto = true -> 201 and autoDelivery: false
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId ? { ...env, delivery: { ...env.delivery!, enabled: true, auto: true, token: '', clearToken: true } } : env,
      ),
    });
    const noTokenRes = await createTask({
      resourceIds: [upgradeRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
    });
    assert.equal(noTokenRes.statusCode, 201, noTokenRes.body);
    assert.equal(noTokenRes.json().items[0].autoDelivery, false);

    // Restore token and keep auto: true
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId ? { ...env, delivery: { ...env.delivery!, enabled: true, auto: true, token: 'secret-migrate-token' } } : env,
      ),
    });

    // 2. Missing applicable rule (single app-template without app rule, and mixed batch) -> 201 without 409
    const singleAppRes = await createTask({
      resourceIds: [appRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
    });
    assert.equal(singleAppRes.statusCode, 201, singleAppRes.body);
    assert.equal(singleAppRes.json().items[0].autoDelivery, false);

    const mixedBatchRes = await createTask({
      resourceIds: [upgradeRes.id, appRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
    });
    assert.equal(mixedBatchRes.statusCode, 201, mixedBatchRes.body);
    const mixedItems = mixedBatchRes.json().items as Array<{ id: string; resourceId: string; autoDelivery?: boolean }>;
    assert.equal(mixedItems.find(item => item.resourceId === upgradeRes.id)!.autoDelivery, true);
    assert.equal(mixedItems.find(item => item.resourceId === appRes.id)!.autoDelivery, false);

    // 3. Site already has delivery -> 201 and autoDelivery: undefined
    const deliveredSite = {
      id: randomUUID(),
      resourceId: upgradeRes.id,
      versionId: f.automationStore.versions(upgradeRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'AlreadyDeliveredSite',
      url: 'https://hk-delivered.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(deliveredSite);
    const existingEval = f.automationStore.create(
      {
        resourceIds: [upgradeRes.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: deliveredSite.id,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    existingEval.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true },
      status: 'completed',
      sourceEnvironmentId: f.envId,
      sourceSiteId: deliveredSite.siteId,
      sourceUrl: deliveredSite.url,
      evaluationTaskId: existingEval.id,
      target: { siteId: randomUUID(), siteUrl: 'https://de-delivered.test/' },
      updatedAt: Date.now(),
      error: '',
      checks: [],
    };
    f.automationStore.put(existingEval);
    const dupSiteRes = await createTask({
      resourceIds: [upgradeRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      generatedSiteId: deliveredSite.id,
    });
    assert.equal(dupSiteRes.statusCode, 201, dupSiteRes.body);
    assert.equal(f.automationStore.task(dupSiteRes.json().items[0].id)!.autoDelivery, undefined);

    // 4. Environment without delivery enabled (plainEnvId) -> 201 and autoDelivery: undefined
    const plainRes = await createTask({
      resourceIds: [upgradeRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.plainEnvId,
    });
    assert.equal(plainRes.statusCode, 201, plainRes.body);
    assert.equal(f.automationStore.task(plainRes.json().items[0].id)!.autoDelivery, undefined);

    // 5. Parent precedence: parent.autoDelivery=false overrides env.delivery.auto=true when omitted
    const freshSite = {
      id: randomUUID(),
      resourceId: upgradeRes.id,
      versionId: f.automationStore.versions(upgradeRes.id)[0].id,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'FreshParentSite',
      url: 'https://hk-fresh-parent.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(freshSite);
    const parentRes = await createTask({
      resourceIds: [upgradeRes.id],
      kind: 'generation',
      scope: 'homepage',
      environmentId: f.envId,
      generatedSiteId: freshSite.id,
      autoDelivery: false,
    });
    assert.equal(parentRes.statusCode, 201, parentRes.body);
    const parentTask = f.automationStore.task(parentRes.json().items[0].id)!;
    assert.equal(parentTask.autoDelivery, false);

    const childRes = await createTask({
      resourceIds: [upgradeRes.id],
      kind: 'evaluation',
      scope: 'homepage',
      environmentId: f.envId,
      generatedSiteId: freshSite.id,
      parentId: parentTask.id,
    });
    assert.equal(childRes.statusCode, 201, childRes.body);
    assert.equal(f.automationStore.task(childRes.json().items[0].id)!.autoDelivery, false);
  } finally {
    await f.close();
  }
});

test('per-task autoEvaluate overrides global setting and manual delivery works directly on generation tasks without evaluation', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    // 1. Global autoEvaluate=false, per-task autoEvaluate=true -> creates evaluation
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: false });
    const siteA = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'SiteA', url: 'https://hk-a.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteA);
    const resEvalOn = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: { resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteA.id, autoEvaluate: true },
    });
    assert.equal(resEvalOn.statusCode, 201, resEvalOn.body);
    const genEvalOnId = resEvalOn.json().items[0].id as string;
    const genEvalOn = f.automationStore.task(genEvalOnId)!;
    assert.equal(genEvalOn.autoEvaluate, true);

    // 2. Global autoEvaluate=true, per-task autoEvaluate=false -> skips evaluation and supports direct manual delivery even without rules
    f.automationStore.db.prepare('DELETE FROM auto_rules').run();
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: true });
    const siteB = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'SiteB', url: 'https://hk-b.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteB);
    const resEvalOff = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: { resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteB.id, autoEvaluate: false, autoDelivery: true },
    });
    assert.equal(resEvalOff.statusCode, 201, resEvalOff.body);
    const genEvalOffId = resEvalOff.json().items[0].id as string;
    const genEvalOff = f.automationStore.task(genEvalOffId)!;
    assert.equal(genEvalOff.autoEvaluate, false);
    assert.equal(genEvalOff.autoDelivery, true);

    // Reject autoEvaluate=false combined with optimization
    const badOpt = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': randomUUID() },
      payload: { resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, autoEvaluate: false, optimization: { targetScore: 85, maxRounds: 2, maxCostCny: null } },
    });
    assert.equal(badOpt.statusCode, 400);

    // Disable auto-delivery on genEvalOff temporarily so we can test manual POST /delivery on generation task
    genEvalOff.autoDelivery = false;
    f.automationStore.put(genEvalOff);
    f.automationStore.put(genEvalOn);

    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async (task, store) => {
          store.beginSiteChange(task);
        },
        evaluation: async (task, store) => {
          task.report = makeReport(60, 'failed', store, task);
          store.publishSiteReport(task);
        },
      },
      () => true,
    );
    await worker.tick();
    for (let i = 0; i < 80; i++) {
      const a = f.automationStore.task(genEvalOnId)!;
      const b = f.automationStore.task(genEvalOffId)!;
      const evA = a.evaluationTaskId ? f.automationStore.task(a.evaluationTaskId) : undefined;
      if (b.status === 'completed' && evA?.status === 'completed') break;
      await new Promise(r => setTimeout(r, 15));
    }
    await worker.stop();
    worker = undefined;

    const doneA = f.automationStore.task(genEvalOnId)!;
    const doneB = f.automationStore.task(genEvalOffId)!;
    assert.ok(doneA.evaluationTaskId, 'per-task autoEvaluate=true should override global false');
    assert.equal(doneB.evaluationTaskId, undefined, 'per-task autoEvaluate=false should override global true');

    // Summary & delivery section expose direct delivery for completed generation task B
    const sumB = (await f.app.inject({ url: `/api/automation/tasks/${doneB.id}/summary`, headers: f.headers })).json();
    assert.equal(sumB.deliveryEnabled, true);
    const delSecB = (await f.app.inject({ url: `/api/automation/tasks/${doneB.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(delSecB.task.id, doneB.id);
    assert.equal(delSecB.autoEvaluate, false);

    // Manual delivery on generation task B succeeds directly even with requirePassed=true (no evaluation exists)
    const deliverB = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${doneB.id}/delivery`, headers: f.headers });
    assert.equal(deliverB.statusCode, 200, deliverB.body);
    assert.equal(deliverB.json().delivery.status, 'queued');

    // Manual delivery on generation task A is still blocked by its failed current evaluation report
    const deliverA = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${doneA.id}/delivery`, headers: f.headers });
    assert.equal(deliverA.statusCode, 409);
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('delivery with verifyWithAi=false completes via HTTP check only without browser or AI, and settings persist verifyWithAi without losing secrets', async () => {
  const f = await fixture();
  let targetOk = true;
  const server = createServer((_req, res) => {
    res.writeHead(targetOk ? 200 : 503, { 'content-type': 'text/html' });
    res.end(targetOk ? '<html><body>ok</body></html>' : 'unavailable');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const targetOrigin = `http://127.0.0.1:${addr.port}`;
  try {
    // Verify PUT /api/settings persists delivery.verifyWithAi=false and keeps tokens
    const pub = f.vault.public();
    const putRes = await f.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: f.headers,
      payload: {
        ...pub,
        environments: pub.environments.map(env => env.id === f.envId
          ? { ...env, delivery: { ...env.delivery!, verifyWithAi: false } }
          : env),
      },
    });
    assert.equal(putRes.statusCode, 200, putRes.body);
    assert.equal(putRes.json().environments.find((e: { id: string }) => e.id === f.envId).delivery.verifyWithAi, false);
    assert.equal(f.vault.get().environments.find(e => e.id === f.envId)!.token, 'secret-hk-token');
    assert.equal(f.vault.get().environments.find(e => e.id === f.envId)!.delivery?.token, 'secret-migrate-token');

    const site = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'DirectVerifySite', url: 'https://hk-verify.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site);
    const gen = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site.id, autoEvaluate: false, requirements: '' }, f.vault.automation())[0];
    gen.status = 'completed'; gen.stopped = true; f.automationStore.beginSiteChange(gen);

    queueDelivery(gen, f.automationStore, f.vault);
    assert.equal(gen.delivery?.policy.verifyWithAi, false);
    gen.delivery!.target = { siteId: randomUUID(), siteUrl: targetOrigin + '/' };
    f.automationStore.put(gen);

    await verifyDelivery(gen, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000), {
      openBrowser: async () => { throw new Error('must not launch browser when verifyWithAi is false'); },
      createClient: () => { throw new Error('must not create Codex client when verifyWithAi is false'); },
    });
    assert.equal(gen.delivery?.status, 'completed');
    assert.ok(gen.delivery?.verifiedAt);
    assert.equal(gen.delivery?.verification, undefined);
    assert.equal(gen.delivery?.checks.every(c => c.ok), true);

    // When target HTTP fails, HTTP-only check marks failed
    targetOk = false;
    gen.delivery!.status = 'queued';
    await verifyDelivery(gen, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000), {
      openBrowser: async () => { throw new Error('must not launch browser when verifyWithAi is false'); },
      createClient: () => { throw new Error('must not create Codex client when verifyWithAi is false'); },
    });
    assert.equal(gen.delivery?.status, 'failed');
    assert.match(gen.delivery?.error || '', /HTTP 可达性检查未全部通过/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

test('worker followup evaluate action respects autoEvaluate=false and queues direct auto-delivery when enabled', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: false });
    const site = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'FollowupDirectSite', url: 'https://hk-followup-direct.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site);
    const gen = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site.id, autoEvaluate: false, autoDelivery: true, requirements: '' }, f.vault.automation())[0];
    gen.status = 'following-up';
    gen.stopped = true;
    gen.followup = { state: 'queued', attempts: 0, elapsedMs: 0, startedAt: Date.now(), nextAt: Date.now() - 1000, tokens: 0, threadId: '', policy: f.vault.automation().followup, executionStopped: true, observations: [], budgetId: randomUUID() };
    f.automationStore.beginSiteChange(gen);

    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      undefined,
      () => true,
      async () => {
        // Pause worker so delivery stays queued for inspection
        f.vault.updateAutomation({ ...f.vault.automation(), enabled: false });
        return { action: 'evaluate', reason: '页面已生成完成', evidence: [] };
      },
    );

    await worker.tick();
    let updated = f.automationStore.task(gen.id)!;
    for (let i = 0; i < 80; i++) {
      updated = f.automationStore.task(gen.id)!;
      if (updated.status === 'completed' && updated.delivery) break;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(updated.status, 'completed');
    assert.equal(updated.evaluationTaskId, undefined);
    assert.equal(updated.delivery?.status, 'queued');
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('shouldAutoDeliver supports homepage tasks with autoDelivery=undefined when environment auto delivery is enabled', async () => {
  const f = await fixture();
  let worker: AutomationWorker | undefined;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId
          ? { ...env, delivery: { ...env.delivery!, enabled: true, auto: true, requirePassed: false, token: 'secret-migrate-token' } }
          : env,
      ),
    });
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true, autoEvaluate: false });

    const site1 = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'HomepageUndefined', url: 'https://hk-home-undef.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site1);
    const gen1 = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site1.id, autoEvaluate: false, requirements: '' }, f.vault.automation())[0];
    assert.equal(gen1.autoDelivery, undefined);

    const site2 = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'HomepageFalse', url: 'https://hk-home-false.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site2);
    const gen2 = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site2.id, autoEvaluate: false, autoDelivery: false, requirements: '' }, f.vault.automation())[0];
    assert.equal(gen2.autoDelivery, false);

    let completedCount = 0;
    worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      {
        generation: async (task, store) => {
          store.beginSiteChange(task);
          completedCount++;
          if (completedCount >= 2) {
            f.vault.updateAutomation({ ...f.vault.automation(), enabled: false });
          }
        },
        evaluation: async () => {},
      },
      () => true,
    );

    await worker.tick();
    for (let i = 0; i < 80; i++) {
      const t1 = f.automationStore.task(gen1.id)!;
      const t2 = f.automationStore.task(gen2.id)!;
      if (t1.status === 'completed' && t1.delivery && t2.status === 'completed') break;
      await new Promise(r => setTimeout(r, 15));
    }
    const done1 = f.automationStore.task(gen1.id)!;
    const done2 = f.automationStore.task(gen2.id)!;
    assert.equal(done1.status, 'completed');
    assert.equal(done1.delivery?.status, 'queued');
    assert.equal(done2.status, 'completed');
    assert.equal(done2.delivery, undefined);
  } finally {
    await worker?.stop();
    await f.close();
  }
});

test('force delivery supports interrupted generation/evaluation and requirePassed failures while preserving hard safety guards and force-retry', async () => {
  const f = await fixture();
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(env =>
        env.id === f.envId
          ? { ...env, delivery: { ...env.delivery!, enabled: true, auto: false, requirePassed: true, token: 'secret-migrate-token' } }
          : env,
      ),
    });

    // Case 1: Interrupted generation with accessible URL
    const site1 = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'ForceIntGen', url: 'https://force-int-gen.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site1);
    const gen1 = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site1.id, requirements: '' }, f.vault.automation())[0];
    f.automationStore.beginSiteChange(gen1);
    gen1.status = 'interrupted';
    gen1.stopped = true;
    gen1.error = '模型流中断';
    f.automationStore.put(gen1);

    const sum1 = (await f.app.inject({ url: `/api/automation/tasks/${gen1.id}/summary`, headers: f.headers })).json();
    assert.equal(sum1.deliveryEnabled, true);
    assert.equal(sum1.canForceDeliver, true);
    assert.equal(sum1.forceDeliverTaskId, gen1.id);

    const sec1 = (await f.app.inject({ url: `/api/automation/tasks/${gen1.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(sec1.canDeliver, false);
    assert.equal(sec1.canForceDeliver, true);

    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${gen1.id}/delivery`, headers: f.headers })).statusCode, 409);
    const forcedGenRes = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${gen1.id}/delivery`, headers: f.headers, payload: { force: true } });
    assert.equal(forcedGenRes.statusCode, 200);
    const forcedGen = f.automationStore.task(gen1.id)!;
    assert.equal(forcedGen.delivery?.status, 'queued');
    assert.equal(forcedGen.delivery?.forced, true);
    assert.equal(forcedGen.siteRevision, f.automationStore.siteState(site1.id)?.revision);
    assert.ok(f.automationStore.events(gen1.id).some(e => /人工初步验收并强制排队跨环境交付/.test(e.message)));

    // Uncertain delivery -> normal retry blocked (409), force retry allowed (200)
    forcedGen.delivery!.status = 'uncertain';
    forcedGen.delivery!.attemptedAt = Date.now();
    forcedGen.delivery!.stopped = true;
    forcedGen.delivery!.error = 'fetch failed';
    f.automationStore.put(forcedGen);

    const secUncertain = (await f.app.inject({ url: `/api/automation/tasks/${gen1.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(secUncertain.canForceRetry, true);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${gen1.id}/delivery/retry`, headers: f.headers })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${gen1.id}/delivery/retry`, headers: f.headers, payload: { force: true } })).statusCode, 200);
    const retried = f.automationStore.task(gen1.id)!;
    assert.equal(retried.delivery?.status, 'queued');
    assert.equal(retried.delivery?.attemptedAt, undefined);
    assert.equal(retried.delivery?.forced, true);

    // If target exists or stopped=false, force retry MUST return 409
    retried.delivery!.status = 'failed';
    retried.delivery!.target = { siteId: randomUUID(), siteUrl: 'https://target-already.test/' };
    f.automationStore.put(retried);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${gen1.id}/delivery/retry`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    // Case 2: Completed generation + interrupted evaluation
    const site2 = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'CompGenIntEval', url: 'https://comp-gen-int-eval.test/', createdAt: Date.now() };
    f.automationStore.saveSite(site2);
    const gen2 = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: site2.id, requirements: '' }, f.vault.automation())[0];
    f.automationStore.beginSiteChange(gen2);
    gen2.status = 'completed';
    gen2.stopped = true;
    f.automationStore.put(gen2);
    const eval2 = f.automationStore.ensureEvaluation(gen2, f.vault.automation());
    eval2.status = 'interrupted';
    eval2.stopped = true;
    eval2.error = 'stream disconnected';
    f.automationStore.put(eval2);

    // /sections/delivery on gen2 selects completed gen2 (not interrupted reportless eval2)
    const sec2 = (await f.app.inject({ url: `/api/automation/tasks/${gen2.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(sec2.task.id, gen2.id);
    assert.equal(sec2.canDeliver, true);

    // Force delivery on interrupted eval2 also works
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${eval2.id}/delivery`, headers: f.headers })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${eval2.id}/delivery`, headers: f.headers, payload: { force: true } })).statusCode, 200);

    // Case 3: Hard safety guards remain enforced even with force=true
    const siteNoUrl = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'NoUrlForce', url: '', createdAt: Date.now() };
    f.automationStore.saveSite(siteNoUrl);
    const genNoUrl = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteNoUrl.id, requirements: '' }, f.vault.automation())[0];
    genNoUrl.status = 'interrupted'; genNoUrl.stopped = true; f.automationStore.put(genNoUrl);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genNoUrl.id}/delivery`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    const siteArchived = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'ArchivedForce', url: 'https://archived-force.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteArchived);
    const genArch = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteArchived.id, requirements: '' }, f.vault.automation())[0];
    genArch.status = 'interrupted'; genArch.stopped = true; f.automationStore.put(genArch);
    f.automationStore.dispositions.set('delivery', [siteArchived.id], 'discarded', '');
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genArch.id}/delivery`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    const siteSiblingBusy = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'BusySiblingForce', url: 'https://busy-sibling.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteSiblingBusy);
    const genBusy1 = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteSiblingBusy.id, requirements: '' }, f.vault.automation())[0];
    genBusy1.status = 'interrupted'; genBusy1.stopped = true; f.automationStore.put(genBusy1);
    const evalBusy = f.automationStore.ensureEvaluation(genBusy1, f.vault.automation());
    evalBusy.status = 'running'; evalBusy.stopped = false; f.automationStore.put(evalBusy);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genBusy1.id}/delivery`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    const sitePlain = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.plainEnvId, siteId: randomUUID(), name: 'PlainForce', url: 'https://plain-force.test/', createdAt: Date.now() };
    f.automationStore.saveSite(sitePlain);
    const genPlain = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.plainEnvId, generatedSiteId: sitePlain.id, requirements: '' }, f.vault.automation())[0];
    genPlain.status = 'interrupted'; genPlain.stopped = true; f.automationStore.put(genPlain);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genPlain.id}/delivery`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    // Crash-recovered uncertain delivery WITHOUT attemptedAt must still expose canForceRetry and succeed on force retry
    const siteCrashed = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'CrashUncertain', url: 'https://crash-uncertain.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteCrashed);
    const genCrashed = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteCrashed.id, requirements: '' }, f.vault.automation())[0];
    genCrashed.status = 'interrupted';
    genCrashed.stopped = true;
    genCrashed.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true, verifyWithAi: false },
      status: 'running',
      forced: true,
      stopped: false,
      sourceEnvironmentId: f.envId,
      sourceSiteId: siteCrashed.siteId,
      sourceUrl: siteCrashed.url,
      evaluationTaskId: '',
      updatedAt: Date.now(),
      error: '',
      checks: [],
    };
    f.automationStore.put(genCrashed);
    f.automationStore.recover();
    const crashedSec = (await f.app.inject({ url: `/api/automation/tasks/${genCrashed.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(crashedSec.task.delivery.status, 'uncertain');
    assert.equal(crashedSec.task.delivery.attemptedAt, undefined);
    assert.equal(crashedSec.canForceRetry, true);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genCrashed.id}/delivery/retry`, headers: f.headers, payload: { force: true } })).statusCode, 200);
    assert.equal(f.automationStore.task(genCrashed.id)!.delivery?.status, 'queued');

    // Case 4: Force retry and worker pickup MUST block when owning task itself is unconfirmed-stopped or active
    const siteUnstopped = { id: randomUUID(), resourceId: f.resource.id, versionId: f.automationStore.versions(f.resource.id)[0].id, environmentId: f.envId, siteId: randomUUID(), name: 'UnstoppedOwn', url: 'https://unstopped-own.test/', createdAt: Date.now() };
    f.automationStore.saveSite(siteUnstopped);
    const genUnstopped = f.automationStore.create({ resourceIds: [f.resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId, generatedSiteId: siteUnstopped.id, requirements: '' }, f.vault.automation())[0];
    genUnstopped.status = 'interrupted';
    genUnstopped.stopped = false;
    genUnstopped.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true, verifyWithAi: false },
      status: 'uncertain',
      forced: true,
      stopped: true,
      sourceEnvironmentId: f.envId,
      sourceSiteId: siteUnstopped.siteId,
      sourceUrl: siteUnstopped.url,
      evaluationTaskId: '',
      attemptedAt: Date.now(),
      updatedAt: Date.now(),
      error: 'fetch failed',
      checks: [],
    };
    f.automationStore.put(genUnstopped);
    const secUnstopped = (await f.app.inject({ url: `/api/automation/tasks/${genUnstopped.id}/sections/delivery`, headers: f.headers })).json();
    assert.equal(secUnstopped.canForceRetry, false);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${genUnstopped.id}/delivery/retry`, headers: f.headers, payload: { force: true } })).statusCode, 409);

    genUnstopped.delivery.status = 'queued';
    delete genUnstopped.delivery.attemptedAt;
    f.automationStore.put(genUnstopped);
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true });
    const worker = new AutomationWorker(
      f.automationStore,
      f.vault,
      f.directory,
      { generation: async () => {}, evaluation: async () => {} },
      () => true,
    );
    try {
      await worker.tick();
      await new Promise(r => setTimeout(r, 30));
      assert.equal(f.automationStore.task(genUnstopped.id)!.delivery?.status, 'queued');
    } finally {
      await worker.stop();
    }
  } finally {
    await f.close();
  }
});
