import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import {
  defaultAutomationSettings,
  type AutomationReport,
  type AutomationTask,
} from '../shared/automation.js';
import { filterResources, resourceSiteCounts } from '../shared/resource-library.js';
import { dashboardAnalytics } from '../server/automation/dashboard-analytics.js';

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dispositions-'));
  const services = await createApp({ directory, startWorker: false, serveWeb: false });
  const store = services.automationStore;
  const settings = structuredClone(defaultAutomationSettings);
  const envId = randomUUID();
  services.vault.connectEnvironment(
    { id: envId, name: 'Test Kooboo', origin: 'https://kooboo.test', apiOrigin: 'https://kooboo.test' },
    'secret-token',
    undefined,
  );
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

  function makeResource(name: string) {
    return store.saveResource({
      name,
      scenario: 'site-template',
      description: 'Template spec',
      contentUrl: 'https://source.test',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
  }

  function makeSite(resourceId: string, name: string) {
    const site = {
      id: randomUUID(),
      resourceId,
      versionId: store.versions(resourceId)[0].id,
      environmentId: envId,
      siteId: randomUUID(),
      name,
      url: `https://${name.toLowerCase()}.test`,
      createdAt: Date.now(),
    };
    store.saveSite(site);
    return site;
  }

  function finishSiteRun(resourceId: string, siteId: string, score: number, collectLearning = false) {
    const generation = store.create(
      {
        resourceIds: [resourceId],
        generatedSiteId: siteId,
        kind: 'generation',
        scope: 'homepage',
        environmentId: envId,
        requirements: '',
      },
      settings,
    )[0];
    store.beginSiteChange(generation);
    generation.status = 'completed';
    generation.stopped = true;
    generation.generation = { conversationId: 'conv-1', prepared: true };
    store.put(generation);

    const evaluation = store.ensureEvaluation(generation, settings);
    evaluation.status = 'completed';
    evaluation.stopped = true;
    if (collectLearning) {
      evaluation.learningPolicy = { ...evaluation.learningPolicy!, collect: true };
    }
    evaluation.report = {
      summary: score >= 85 ? '复刻达标' : '首屏结构差距较大',
      quality: score >= 85 ? 'passed' : 'failed',
      scores: [
        { viewport: 'desktop', value: score },
        { viewport: 'mobile', value: score },
      ],
      assessments: evaluation.rule!.criteria.flatMap(criterion =>
        criterion.viewports.map(viewport => ({
          criterionId: criterion.id,
          viewport,
          score,
          passed: score >= 85,
          reason: '已核对截图证据',
          evidence: [],
        })),
      ),
      issues: score >= 85 ? [] : [{ severity: 'major', title: 'Hero 错位', detail: '布局不符', evidence: [] }],
      coverage: { verified: ['首页'], unverified: [], outOfScope: [] },
      artifacts: [],
    } satisfies AutomationReport;
    store.publishSiteReport(evaluation);
    store.put(evaluation);
    return { generation, evaluation };
  }

  return {
    ...services,
    store,
    settings,
    envId,
    headers,
    makeResource,
    makeSite,
    finishSiteRun,
    async close() {
      await services.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('completing a generated site optionally completes its resource, auto-discards leftover stopped attempts, and preserves versions', async () => {
  const f = await createFixture();
  try {
    const resource = f.makeResource('Template Alpha');
    const frozenVersions = f.store.versions(resource.id);
    const badSite = f.makeSite(resource.id, 'alpha-v1');
    const goodSite = f.makeSite(resource.id, 'alpha-v2');

    const badRun = f.finishSiteRun(resource.id, badSite.id, 55);
    f.store.notice(badRun.evaluation, '任务已中断', '旧站中断通知');
    const goodRun = f.finishSiteRun(resource.id, goodSite.id, 92);

    assert.equal(f.store.noticePage(1, 10).unread, 1);

    const response = await f.app.inject({
      method: 'POST',
      url: '/api/automation/dispositions',
      headers: f.headers,
      payload: {
        kind: 'delivery',
        ids: [goodSite.id],
        state: 'completed',
        note: '模板验收通过',
        cascadeResources: true,
      },
    });
    assert.equal(response.statusCode, 200, response.body);

    // Resource is completed without altering revision, updatedAt, or InputVersion history.
    const updatedResource = f.store.resource(resource.id)!;
    assert.equal(updatedResource.disposition?.state, 'completed');
    assert.equal(updatedResource.disposition?.note, '模板验收通过');
    assert.equal(updatedResource.revision, resource.revision);
    assert.equal(updatedResource.updatedAt, resource.updatedAt);
    assert.deepEqual(f.store.versions(resource.id), frozenVersions);

    // Sibling stopped site was automatically folded into 'discarded'.
    assert.equal(f.store.site(goodSite.id)?.disposition?.state, 'completed');
    assert.equal(f.store.site(badSite.id)?.disposition?.state, 'discarded');
    assert.equal(f.store.noticePage(1, 10).unread, 0, 'archiving marks associated task notices as read');

    // Default site-deliveries list ('active') is now clean; filtered views return exact buckets.
    const activePage = (await f.app.inject({ url: '/api/automation/site-deliveries', headers: f.headers })).json();
    assert.equal(activePage.total, 0);
    assert.equal(activePage.activeTotal, 0);

    const completedPage = (
      await f.app.inject({ url: '/api/automation/site-deliveries?disposition=completed', headers: f.headers })
    ).json();
    assert.deepEqual(completedPage.items.map((item: { id: string }) => item.id), [goodSite.id]);
    assert.equal(completedPage.items[0].disposition.note, '模板验收通过');
    assert.equal(completedPage.items[0].resourceDisposition.state, 'completed');

    const discardedPage = (
      await f.app.inject({ url: '/api/automation/site-deliveries?disposition=discarded', headers: f.headers })
    ).json();
    assert.deepEqual(discardedPage.items.map((item: { id: string }) => item.id), [badSite.id]);

    // Direct detail & summary endpoints remain readable for historical links.
    const detail = await f.app.inject({ url: `/api/automation/site-deliveries/${goodSite.id}`, headers: f.headers });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().disposition.state, 'completed');

    const summary = (
      await f.app.inject({ url: `/api/automation/tasks/${goodRun.generation.id}/summary`, headers: f.headers })
    ).json();
    assert.equal(summary.disposition.state, 'completed');
    assert.equal(summary.resourceDisposition.state, 'completed');
  } finally {
    await f.close();
  }
});

test('discarding a generated site leaves its resource active, cancels purely queued tasks, skips reflection, and retains billing', async () => {
  const f = await createFixture();
  try {
    const resource = f.makeResource('Template Beta');
    const site = f.makeSite(resource.id, 'beta-v1');
    const { generation, evaluation } = f.finishSiteRun(resource.id, site.id, 48, true);

    const at = Date.parse('2026-11-10T10:00:00+08:00');
    f.store.usage.record(generation.id, {
      id: randomUUID(),
      source: 'kooboo',
      stage: 'generation',
      model: 'deepseek-flash-1017',
      endpoint: 'https://api.deepseek.com/v1',
      startedAt: at,
      endedAt: at + 500,
      status: 'completed',
      basis: 'request',
      raw: { input_tokens: 2_000_000, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
    });

    // Queue a continuation while automation is paused.
    const queuedTask = f.store.create(
      {
        resourceIds: [resource.id],
        generatedSiteId: site.id,
        kind: 'generation',
        scope: 'site',
        environmentId: f.envId,
        requirements: '补全内页',
      },
      f.settings,
    )[0];
    assert.equal(queuedTask.status, 'queued');
    assert.ok(f.store.reflectionCandidates().includes(evaluation.id));

    const discardRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/dispositions',
      headers: f.headers,
      payload: { kind: 'delivery', ids: [site.id], state: 'discarded', note: '环境过时' },
    });
    assert.equal(discardRes.statusCode, 200, discardRes.body);

    // Resource stays active, and non-discarded site count drops to 0 so it filters as 'no' generated sites.
    const savedResource = f.store.resource(resource.id)!;
    assert.equal(savedResource.disposition, undefined);
    const counts = resourceSiteCounts(f.store.sites());
    assert.equal(counts.get(resource.id) || 0, 0);
    assert.deepEqual(
      filterResources(f.store.resources(), counts, {
        query: '',
        scenario: '',
        folder: '',
        generated: 'no',
        disposition: 'active',
      }).map(r => r.id),
      [resource.id],
    );

    // Queued continuation was cleanly cancelled, and discarded evaluation skips reflection.
    assert.equal(f.store.task(queuedTask.id)?.status, 'cancelled');
    assert.equal(f.store.reflectionCandidates().includes(evaluation.id), false);

    // Dashboard cost accounting still retains historical spend.
    const analytics = dashboardAnalytics(f.store, {
      start: Date.parse('2026-11-09T00:00:00+08:00'),
      end: Date.now() + 1000,
      granularity: 'day',
      scenario: 'all',
      scope: 'all',
      unit: 'generation',
      page: 1,
    });
    assert.ok(analytics.consumption.knownCny > 0, 'discarded task spend must remain in cost ledger');
  } finally {
    await f.close();
  }
});

test('running or unconfirmed tasks block archiving; archived items block paid actions until restored to active', async () => {
  const f = await createFixture();
  try {
    const resource = f.makeResource('Template Gamma');
    const site = f.makeSite(resource.id, 'gamma-v1');
    const { generation } = f.finishSiteRun(resource.id, site.id, 88);

    // Simulate an unconfirmed interrupted task (stopped = false).
    const unconfirmed: AutomationTask = f.store.create(
      {
        resourceIds: [resource.id],
        generatedSiteId: site.id,
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    unconfirmed.status = 'interrupted';
    unconfirmed.stopped = false;
    f.store.put(unconfirmed);

    for (const state of ['completed', 'discarded'] as const) {
      const blocked = await f.app.inject({
        method: 'POST',
        url: '/api/automation/dispositions',
        headers: f.headers,
        payload: { kind: 'delivery', ids: [site.id], state },
      });
      assert.equal(blocked.statusCode, 409, `unconfirmed execution must block ${state}`);
    }

    // Confirm stop, then complete both delivery and resource.
    unconfirmed.stopped = true;
    f.store.put(unconfirmed);
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          headers: f.headers,
          payload: { kind: 'delivery', ids: [site.id], state: 'completed', cascadeResources: true },
        })
      ).statusCode,
      200,
    );

    // Paid/mutating actions against the archived site or resource are rejected with 409.
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/tasks',
          headers: { ...f.headers, 'idempotency-key': 'archived-resource-create' },
          payload: { resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/automation/tasks/${unconfirmed.id}/resume`,
          headers: f.headers,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/automation/tasks/${generation.id}/followup`,
          headers: f.headers,
          payload: { kind: 'generation', requirements: '继续修改' },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/automation/tasks/${generation.id}/optimize`,
          headers: f.headers,
          payload: { targetScore: 90, maxRounds: 2, maxCostCny: null },
        })
      ).statusCode,
      409,
    );

    // Restore both delivery and resource back to active.
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          headers: f.headers,
          payload: { kind: 'delivery', ids: [site.id], state: 'active', cascadeResources: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.site(site.id)?.disposition, undefined);
    assert.equal(f.store.resource(resource.id)?.disposition, undefined);

    // Creating a new task from the restored resource succeeds again.
    const createdAfterRestore = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...f.headers, 'idempotency-key': 'restored-resource-create' },
      payload: { resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.envId },
    });
    assert.equal(createdAfterRestore.statusCode, 201, createdAfterRestore.body);

    // Unattached pending/failed root task (generatedSiteId = null) can also be discarded directly.
    const unattachedId = createdAfterRestore.json().items[0].id as string;
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          headers: f.headers,
          payload: { kind: 'delivery', ids: [unattachedId], state: 'discarded', note: '建站前取消' },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.task(unattachedId)?.status, 'cancelled');
    const discardedDeliveries = (
      await f.app.inject({ url: '/api/automation/site-deliveries?disposition=discarded', headers: f.headers })
    ).json();
    assert.ok(discardedDeliveries.items.some((item: { id: string }) => item.id === unattachedId));
  } finally {
    await f.close();
  }
});

test('resource-level archiving handles multi-site ambiguity, cascades discards, and requires authentication', async () => {
  const f = await createFixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          payload: { kind: 'resource', ids: [randomUUID()], state: 'discarded' },
        })
      ).statusCode,
      401,
    );

    const resource = f.makeResource('Template Delta');
    const siteA = f.makeSite(resource.id, 'delta-a');
    const siteB = f.makeSite(resource.id, 'delta-b');
    f.finishSiteRun(resource.id, siteA.id, 70);
    f.finishSiteRun(resource.id, siteB.id, 72);

    // Completing from resource with two ambiguous non-ready sites rejects cascadeDeliveries.
    const ambiguous = await f.app.inject({
      method: 'POST',
      url: '/api/automation/dispositions',
      headers: f.headers,
      payload: { kind: 'resource', ids: [resource.id], state: 'completed', cascadeDeliveries: true },
    });
    assert.equal(ambiguous.statusCode, 409);

    // Discarding one broken site first makes the remaining site unambiguous.
    await f.app.inject({
      method: 'POST',
      url: '/api/automation/dispositions',
      headers: f.headers,
      payload: { kind: 'delivery', ids: [siteA.id], state: 'discarded', note: '废版' },
    });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          headers: f.headers,
          payload: { kind: 'resource', ids: [resource.id], state: 'completed', cascadeDeliveries: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.site(siteB.id)?.disposition?.state, 'completed');
    assert.equal(f.store.site(siteA.id)?.disposition?.state, 'discarded');

    // Restoring the resource with cascadeDeliveries restores siteB ('completed' -> 'active'),
    // while keeping explicitly discarded siteA in 'discarded'.
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/automation/dispositions',
          headers: f.headers,
          payload: { kind: 'resource', ids: [resource.id], state: 'active', cascadeDeliveries: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.site(siteB.id)?.disposition, undefined);
    assert.equal(f.store.site(siteA.id)?.disposition?.state, 'discarded');
  } finally {
    await f.close();
  }
});
