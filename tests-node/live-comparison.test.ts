import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { createEmbedProber, registerLiveComparisonApi, type HeaderFetcher } from '../server/automation/live-comparison.js';
import { defaultAutomationSettings, type AutomationReport, type MaterialFile } from '../shared/automation.js';
import {
  detectKoobooAdminRedirect,
  evaluateFrameHeaders,
  resolveComparisonSources,
  type LiveComparisonPayload,
} from '../shared/live-comparison.js';

const PARENT_ORIGIN = 'http://127.0.0.1:4180';

test('evaluateFrameHeaders handles Framer, Webflow CSP frame-ancestors, X-Frame-Options, and CSP precedence', () => {
  // 1. Framer template: no XFO or CSP frame-ancestors
  assert.deepEqual(
    evaluateFrameHeaders({}, 'https://horizone-visuvate.framer.website/', PARENT_ORIGIN),
    { status: 'allowed', embeddable: true },
  );

  // 2. Webflow template: CSP frame-ancestors restricts to Webflow domains
  const webflowVerdict = evaluateFrameHeaders(
    {
      contentSecurityPolicy:
        "frame-ancestors 'self' https://*.webflow.com http://*.webflow.com http://*.webflow.io http://webflow.com https://webflow.com;",
    },
    'https://car-dealership-128.webflow.io/',
    PARENT_ORIGIN,
  );
  assert.equal(webflowVerdict.status, 'blocked');
  assert.equal(webflowVerdict.embeddable, false);
  assert.match(webflowVerdict.reason || '', /CSP frame-ancestors/);

  // 3. CSP wildcard and explicit host+port matching
  assert.equal(
    evaluateFrameHeaders({ contentSecurityPolicy: 'frame-ancestors *' }, 'https://example.com/', PARENT_ORIGIN).embeddable,
    true,
  );
  assert.equal(
    evaluateFrameHeaders(
      { contentSecurityPolicy: 'default-src https:; frame-ancestors http://127.0.0.1:4180' },
      'https://example.com/',
      PARENT_ORIGIN,
    ).embeddable,
    true,
  );
  assert.equal(
    evaluateFrameHeaders(
      { contentSecurityPolicy: 'frame-ancestors http://127.0.0.1:*' },
      'https://example.com/',
      PARENT_ORIGIN,
    ).embeddable,
    true,
  );
  // Default port 80 must not match non-default port 4180
  assert.equal(
    evaluateFrameHeaders(
      { contentSecurityPolicy: 'frame-ancestors http://127.0.0.1' },
      'https://example.com/',
      PARENT_ORIGIN,
    ).embeddable,
    false,
  );

  // 4. CSP frame-ancestors supersedes X-Frame-Options: DENY per W3C CSP Level 2+
  assert.equal(
    evaluateFrameHeaders(
      { xFrameOptions: 'DENY', contentSecurityPolicy: 'frame-ancestors *' },
      'https://example.com/',
      PARENT_ORIGIN,
    ).embeddable,
    true,
  );

  // 5. Multiple enforced CSP headers require every frame-ancestors directive to allow parentOrigin
  assert.equal(
    evaluateFrameHeaders(
      { contentSecurityPolicy: ['frame-ancestors *', "frame-ancestors 'none'"] },
      'https://example.com/',
      PARENT_ORIGIN,
    ).embeddable,
    false,
  );

  // 6. X-Frame-Options: DENY and SAMEORIGIN when CSP has no frame-ancestors
  const denyVerdict = evaluateFrameHeaders(
    { xFrameOptions: 'DENY', contentSecurityPolicy: "default-src 'self'" },
    'https://example.com/',
    PARENT_ORIGIN,
  );
  assert.equal(denyVerdict.embeddable, false);
  assert.match(denyVerdict.reason || '', /X-Frame-Options: DENY/);

  assert.equal(
    evaluateFrameHeaders({ xFrameOptions: 'SAMEORIGIN' }, 'https://example.com/', PARENT_ORIGIN).embeddable,
    false,
  );
  assert.equal(
    evaluateFrameHeaders({ xFrameOptions: 'SAMEORIGIN' }, 'http://127.0.0.1:4180/preview', PARENT_ORIGIN).embeddable,
    true,
  );
});

test('resolveComparisonSources and detectKoobooAdminRedirect cover all scenarios accurately', () => {
  const upgradeSources = resolveComparisonSources({
    scenario: 'upgrade',
    referenceUrl: 'https://orthofex.framer.website/',
    contentUrl: 'https://www.orthofex.nl/',
  });
  assert.deepEqual(
    upgradeSources.map(s => ({ key: s.key, label: s.label, url: s.url, roles: s.screenshotRoles })),
    [
      { key: 'reference', label: '参考站', url: 'https://orthofex.framer.website/', roles: ['reference'] },
      { key: 'content', label: '内容站', url: 'https://www.orthofex.nl/', roles: ['content'] },
    ],
  );

  const templateSources = resolveComparisonSources({
    scenario: 'site-template',
    referenceUrl: '',
    contentUrl: 'https://horizone-visuvate.framer.website/',
  });
  assert.equal(templateSources.length, 1);
  assert.equal(templateSources[0].key, 'reference');
  assert.equal(templateSources[0].label, '参考站');
  assert.deepEqual(templateSources[0].screenshotRoles, ['reference', 'content']);

  const materialContentOnly = resolveComparisonSources({
    scenario: 'materials',
    referenceUrl: '',
    contentUrl: 'https://customer-docs.example.com/',
  });
  assert.equal(materialContentOnly.length, 1);
  assert.equal(materialContentOnly[0].key, 'content');
  assert.equal(materialContentOnly[0].label, '内容站');

  assert.equal(
    detectKoobooAdminRedirect(
      'https://auto_demo.localkooboo.com/',
      'https://auto_demo.localkooboo.com/_Admin/start/ecommerce',
    ),
    true,
  );
  assert.equal(
    detectKoobooAdminRedirect('https://auto_demo.kooboo.io/', 'https://auto_demo.kooboo.io/en'),
    false,
  );
});

test('createEmbedProber follows redirects, caches results, and falls back non-destructively on network errors', async () => {
  let calls = 0;
  const fetcher: HeaderFetcher = async url => {
    calls++;
    if (url.href === 'https://redirect.example.com/') {
      return { statusCode: 302, headers: { location: '/landing' } };
    }
    if (url.href === 'https://redirect.example.com/landing') {
      return { statusCode: 200, headers: { 'x-frame-options': 'SAMEORIGIN' } };
    }
    if (url.href === 'https://offline.example.com/') {
      throw new Error('ECONNREFUSED');
    }
    return { statusCode: 200, headers: {} };
  };

  const probe = createEmbedProber(fetcher);
  const redirected = await probe('https://redirect.example.com/', PARENT_ORIGIN);
  assert.equal(redirected.status, 'blocked');
  assert.equal(redirected.embeddable, false);
  assert.equal(redirected.finalUrl, 'https://redirect.example.com/landing');
  assert.equal(calls, 2);

  // Cached hit does not re-fetch
  const cached = await probe('https://redirect.example.com/', PARENT_ORIGIN);
  assert.equal(cached.checkedAt, redirected.checkedAt);
  assert.equal(calls, 2);

  // Explicit refresh bypasses cache
  await probe('https://redirect.example.com/', PARENT_ORIGIN, { refresh: true });
  assert.equal(calls, 4);

  // Unreachable sites remain browser-attemptable (embeddable: true) with explicit status
  const unreachable = await probe('https://offline.example.com/', PARENT_ORIGIN);
  assert.equal(unreachable.status, 'unreachable');
  assert.equal(unreachable.embeddable, true);
});

test('live-comparison API resolves URLs, header verdicts, and report fallback screenshots while respecting input version boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-comparison-'));
  const services = await createApp({ directory, serveWeb: false, startWorker: false });
  const customApp = Fastify();
  const mockFetcher: HeaderFetcher = async url => {
    if (url.hostname.endsWith('.webflow.io')) {
      return {
        statusCode: 200,
        headers: {
          'content-security-policy': "frame-ancestors 'self' https://*.webflow.com https://*.webflow.io;",
        },
      };
    }
    return { statusCode: 200, headers: {} };
  };
  registerLiveComparisonApi(customApp, services.automationStore, { fetchHeaders: mockFetcher });

  try {
    const store = services.automationStore;
    const settings = structuredClone(defaultAutomationSettings);

    // 1. App-template task with zero URLs -> summary reports canCompareLive: false
    const emptyResource = store.saveResource({
      name: 'Pure App',
      scenario: 'app-template',
      description: 'Calculator app',
      contentUrl: '',
      referenceUrl: '',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const emptyTask = store.create(
      { resourceIds: [emptyResource.id], kind: 'generation', scope: 'site', environmentId: 'env-1', requirements: '' },
      settings,
    )[0];

    const login = await services.app.inject({ method: 'POST', url: '/api/login' });
    const cookie = { cookie: String(login.headers['set-cookie']).split(';')[0] };

    // Unauthenticated access to live-comparison on main app is rejected
    const unauth = await services.app.inject({ url: `/api/automation/tasks/${emptyTask.id}/live-comparison` });
    assert.equal(unauth.statusCode, 401);

    const emptySummary = (
      await services.app.inject({ url: `/api/automation/tasks/${emptyTask.id}/summary`, headers: cookie })
    ).json();
    assert.equal(emptySummary.canCompareLive, false);

    // 2. Upgrade resource with blocked Webflow referenceUrl + embeddable customer contentUrl + Kooboo generated site
    const upgradeResource = store.saveResource({
      name: 'Dealer Upgrade',
      scenario: 'upgrade',
      description: 'Upgrade dealer site',
      referenceUrl: 'https://car-dealership-128.webflow.io/',
      contentUrl: 'https://www.orthofex.nl/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const site = {
      id: randomUUID(),
      resourceId: upgradeResource.id,
      versionId: store.versions(upgradeResource.id)[0].id,
      environmentId: randomUUID(),
      siteId: randomUUID(),
      name: 'DealerTarget',
      url: 'https://dealer_target.kooboo.io/',
      createdAt: Date.now(),
    };
    store.saveSite(site);

    const genTask = store.create(
      {
        resourceIds: [upgradeResource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: site.environmentId,
        generatedSiteId: site.id,
        requirements: '',
      },
      settings,
    )[0];
    store.beginSiteChange(genTask);
    genTask.status = 'completed';
    genTask.stopped = true;
    store.put(genTask);

    const upgradeSummary = (
      await services.app.inject({ url: `/api/automation/tasks/${genTask.id}/summary`, headers: cookie })
    ).json();
    assert.equal(upgradeSummary.canCompareLive, true);

    const evalTask = store.ensureEvaluation(genTask, settings);
    evalTask.status = 'completed';
    evalTask.stopped = true;
    const artifacts: MaterialFile[] = [
      {
        id: randomUUID(),
        name: `${randomUUID()}.png`,
        type: 'image/png',
        size: 1024,
        sha256: 'a'.repeat(64),
        role: 'reference',
        viewport: 'desktop',
      },
      {
        id: randomUUID(),
        name: `${randomUUID()}.png`,
        type: 'image/png',
        size: 1024,
        sha256: 'b'.repeat(64),
        role: 'reference',
        viewport: 'mobile',
      },
      {
        id: randomUUID(),
        name: `${randomUUID()}.json`,
        type: 'application/json',
        size: 256,
        sha256: 'c'.repeat(64),
        role: 'reference',
        viewport: 'desktop',
      },
    ];
    evalTask.report = {
      summary: 'Completed evaluation',
      quality: 'passed',
      scores: [{ viewport: 'desktop', value: 88 }],
      assessments: [],
      issues: [],
      coverage: { verified: [], unverified: [], outOfScope: [] },
      artifacts,
    } satisfies AutomationReport;
    store.publishSiteReport(evalTask);
    store.put(evalTask);

    const response = await customApp.inject({
      url: `/api/automation/tasks/${genTask.id}/live-comparison`,
      headers: { origin: PARENT_ORIGIN },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as LiveComparisonPayload;
    assert.equal(payload.referenceUrl, 'https://car-dealership-128.webflow.io/');
    assert.equal(payload.contentUrl, 'https://www.orthofex.nl/');
    assert.equal(payload.targetUrl, 'https://dealer_target.kooboo.io/');
    assert.equal(payload.sources.length, 2);
    assert.equal(payload.embedChecks['https://car-dealership-128.webflow.io/'].embeddable, false);
    assert.equal(payload.embedChecks['https://www.orthofex.nl/'].embeddable, true);
    assert.equal(payload.embedChecks['https://dealer_target.kooboo.io/'].embeddable, true);
    assert.equal(payload.fallbackScreenshots.reportTaskId, evalTask.id);
    assert.equal(payload.fallbackScreenshots.historical, false);
    assert.equal(payload.fallbackScreenshots.items.length, 2, 'only PNG artifacts are returned');

    // Unrelated reportId is rejected with 409 Conflict through the application error handler
    const badReport = await services.app.inject({
      url: `/api/automation/tasks/${genTask.id}/live-comparison?reportId=${randomUUID()}`,
      headers: { ...cookie, origin: PARENT_ORIGIN },
    });
    assert.equal(badReport.statusCode, 409);

    // If resource is updated to a new InputVersion with a different referenceUrl, a new task must not reuse old version's screenshots
    store.saveResource(
      {
        name: 'Dealer Upgrade v2',
        scenario: 'upgrade',
        description: 'New version',
        referenceUrl: 'https://cruze.webflow.io/',
        contentUrl: 'https://www.orthofex.nl/',
        externalSource: '',
        externalId: '',
        files: [],
      },
      upgradeResource.id,
      upgradeResource.revision,
    );
    const nextGen = store.create(
      {
        resourceIds: [upgradeResource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: site.environmentId,
        generatedSiteId: site.id,
        requirements: 'v2',
      },
      settings,
    )[0];
    store.beginSiteChange(nextGen);
    const nextPayload = (
      await customApp.inject({
        url: `/api/automation/tasks/${nextGen.id}/live-comparison`,
        headers: { origin: PARENT_ORIGIN },
      })
    ).json() as LiveComparisonPayload;
    assert.equal(nextPayload.referenceUrl, 'https://cruze.webflow.io/');
    assert.equal(nextPayload.fallbackScreenshots.items.length, 0, 'screenshots from an older InputVersion are not mixed');
  } finally {
    await customApp.close();
    await services.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
