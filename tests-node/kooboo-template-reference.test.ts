import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import {
  defaultAutomationSettings,
  effectiveReferenceUrl,
  effectiveTemplateUsageMode,
} from '../shared/automation.js';
import {
  siteIdentity,
  resolveKoobooAssetUrl,
  probeKoobooApiMethod,
  probeKoobooSandboxCapabilities,
  clearKoobooCapabilityCache,
} from '../server/automation/kooboo.js';
import { executeGeneration } from '../server/automation/generator.js';
import { FollowupRuntimeError, GenerationInputError } from '../server/automation/errors.js';

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fixture(koobooOrigin = 'https://kooboo.test') {
  const directory = mkdtempSync(join(tmpdir(), 'kooboo-tpl-ref-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const envId = randomUUID();
  f.vault.update({
    threshold: 80,
    paused: true,
    model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [
      {
        id: envId,
        name: 'TestEnv',
        origin: koobooOrigin,
        apiOrigin: koobooOrigin,
        token: 'test-token',
      },
    ],
  });
  return {
    ...f,
    directory,
    headers,
    envId,
    async close() {
      await f.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function mockOpenSession(
  task: { id: string },
  siteIdRef: () => string,
  deliveredPayloads: Array<{ conversationId?: string; text?: string }>,
): typeof import('../server/automation/generation-session.js').generationSession {
  return async () => {
    const conversationId = randomUUID();
    const runId = 'run-' + randomUUID().slice(0, 8);
    let sentId = '';
    return {
      snapshot: async () => ({
        version: 1,
        taskId: task.id,
        siteId: siteIdRef(),
        conversationId,
        runId: sentId ? runId : '',
        ready: true,
        running: false,
        state: sentId ? 'completed' : 'unknown',
        observedAt: Date.now(),
        pending: null,
        context: [],
        outcome: sentId
          ? { conversationId, runId, status: 'completed', time: Date.now() }
          : { conversationId: '', runId: '', status: 'unknown', time: 0 },
        delivery: sentId ? { id: sentId, state: 'accepted', conversationId } : undefined,
      }),
      deliver: async (input) => {
        sentId = input.id;
        deliveredPayloads.push({ conversationId, text: input.text });
        return { id: input.id, state: 'accepted', conversationId };
      },
      close: async () => {},
    };
  };
}

test('siteIdentity accepts bare UUID strings and object responses, and resolveKoobooAssetUrl resolves protocol-relative URLs', () => {
  const id = randomUUID();
  assert.equal(siteIdentity(id), id);
  assert.equal(siteIdentity(`  ${id}  `), id);
  assert.equal(siteIdentity({ siteId: id }), id);
  assert.equal(siteIdentity({ SiteId: id }), id);
  assert.equal(siteIdentity({ id }), id);
  assert.equal(siteIdentity({ Id: id }), id);
  assert.equal(siteIdentity(null), '');

  assert.equal(resolveKoobooAssetUrl('', 'https://www.localkooboo.com'), '');
  assert.equal(
    resolveKoobooAssetUrl('//15fd9f5c.devday.cn', 'https://www.localkooboo.com'),
    'https://15fd9f5c.devday.cn/',
  );
  assert.equal(
    resolveKoobooAssetUrl('//15fd9f5c.devday.cn', 'http://127.0.0.1:4180'),
    'http://15fd9f5c.devday.cn/',
  );
  assert.equal(resolveKoobooAssetUrl('https://already.example.com/a'), 'https://already.example.com/a');
});

test('resource schema accepts Kooboo template references, defaults mode and strips stale template fields when cleared', async () => {
  const f = await fixture();
  try {
    const templateId = '15b72444-e031-4695-a7f1-048dfbf02e82';

    const upgradeRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Upgrade With Template',
        scenario: 'upgrade',
        description: 'Migrate old site onto Kooboo template',
        contentUrl: 'https://legacy.example.com',
        referenceUrl: '',
        referenceTemplateId: templateId,
        referenceTemplateName: 'Tourvia',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(upgradeRes.statusCode, 201);
    const createdUpgrade = upgradeRes.json();
    assert.equal(createdUpgrade.referenceTemplateId, templateId);
    assert.equal(createdUpgrade.referenceTemplateName, 'Tourvia');
    assert.equal(createdUpgrade.templateUsageMode, 'direct-template');

    const siteTemplateRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Site Template Only ID',
        scenario: 'site-template',
        description: '',
        contentUrl: '',
        referenceUrl: '',
        referenceTemplateId: templateId,
        templateUsageMode: 'reference-sandbox',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(siteTemplateRes.statusCode, 201);
    assert.equal(siteTemplateRes.json().templateUsageMode, 'reference-sandbox');

    const clearedRes = await f.app.inject({
      method: 'PUT',
      url: `/api/automation/resources/${createdUpgrade.id}`,
      headers: f.headers,
      payload: {
        revision: createdUpgrade.revision,
        name: 'Upgrade External URL',
        scenario: 'upgrade',
        description: '',
        contentUrl: 'https://legacy.example.com',
        referenceUrl: 'https://external-ref.example.com',
        referenceTemplateId: '',
        referenceTemplateName: 'Stale Name',
        templateUsageMode: 'reference-sandbox',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(clearedRes.statusCode, 200);
    const updated = clearedRes.json();
    assert.equal(updated.referenceTemplateId, undefined);
    assert.equal(updated.referenceTemplateName, undefined);
    assert.equal(updated.templateUsageMode, undefined);

    const invalidUuidRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Bad Template Id',
        scenario: 'materials',
        description: '',
        contentUrl: '',
        referenceUrl: '',
        referenceTemplateId: 'not-a-uuid',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(invalidUuidRes.statusCode, 400);

    const missingUpgradeRef = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Upgrade Missing Ref',
        scenario: 'upgrade',
        description: '',
        contentUrl: 'https://legacy.example.com',
        referenceUrl: '',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(missingUpgradeRef.statusCode, 400);
  } finally {
    await f.close();
  }
});

test('Kooboo template proxy endpoints forward environment search/detail without devday fallback', async () => {
  const f = await fixture();
  const templateA = '15b72444-e031-4695-a7f1-048dfbf02e82';
  const templateRel = randomUUID();
  const templateEmptyPreview = randomUUID();
  const missingId = randomUUID();
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url!, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === '/_api/v2/Template/FullTextSearch') {
      let body = '';
      for await (const c of req) body += c;
      const parsed = JSON.parse(body);
      res.end(
        JSON.stringify({
          list: [
            {
              id: templateA,
              name: 'Tourvia',
              typeName: 'Site',
              category: 'Travel',
              previewUrl: '//env-a.example.com/tourvia',
              thunbnailUrl: '//env-a.example.com/tourvia.jpg',
              pageCount: 6,
              layoutCount: 1,
              viewCount: 12,
              downloadCount: 99,
            },
          ],
          totalCount: 1,
          pageNr: parsed.pageNr,
          pageSize: parsed.pageSize,
          totalPages: 1,
        }),
      );
      return;
    }
    if (url.pathname === '/_api/v2/Template/Detail') {
      const id = url.searchParams.get('Id');
      if (id === templateA || id === templateRel) {
        res.end(
          JSON.stringify({
            id,
            name: 'Tourvia',
            previewUrl: '//env-a.example.com/tourvia',
            typeName: 'Site',
          }),
        );
        return;
      }
      if (id === templateEmptyPreview) {
        res.end(
          JSON.stringify({
            id: templateEmptyPreview,
            name: 'NoPreview',
            previewUrl: '',
            typeName: 'Site',
          }),
        );
        return;
      }
      res.end('null');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const origin = await listen(server);
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map((e) => ({ ...e, origin, apiOrigin: origin })),
    });

    const listRes = await f.app.inject({
      url: `/api/automation/kooboo/templates?environmentId=${f.envId}&keyword=tourvia&page=1`,
      headers: f.headers,
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().list[0].id, templateA);
    assert.equal(listRes.json().list[0].previewUrl, 'http://env-a.example.com/tourvia');
    assert.equal(listRes.json().list[0].thumbnailUrl, 'http://env-a.example.com/tourvia.jpg');

    const relDetailRes = await f.app.inject({
      url: `/api/automation/kooboo/templates/${templateRel}?environmentId=${f.envId}`,
      headers: f.headers,
    });
    assert.equal(relDetailRes.statusCode, 200);
    assert.equal(relDetailRes.json().previewUrl, 'http://env-a.example.com/tourvia');

    const emptyPreviewRes = await f.app.inject({
      url: `/api/automation/kooboo/templates/${templateEmptyPreview}?environmentId=${f.envId}`,
      headers: f.headers,
    });
    assert.equal(emptyPreviewRes.statusCode, 200);
    assert.equal(emptyPreviewRes.json().previewUrl, '', 'Must never synthesize devday.cn when previewUrl is empty');

    const notFoundRes = await f.app.inject({
      url: `/api/automation/kooboo/templates/${missingId}?environmentId=${f.envId}`,
      headers: f.headers,
    });
    assert.equal(notFoundRes.statusCode, 404);
    assert.ok(requests.some((r) => r.includes('Template/FullTextSearch')));
  } finally {
    await close(server);
    await f.close();
  }
});

test('executeGeneration handles direct-template, missing previewUrl rejection, upgrade role-swap, and reference-sandbox', async () => {
  const f = await fixture();
  const templateId = '15b72444-e031-4695-a7f1-048dfbf02e82';
  const emptyPreviewTemplateId = randomUUID();
  let currentTargetSiteId = randomUUID();
  const sandboxSiteId = randomUUID();
  const refSandboxSiteId = randomUUID();
  const transferTaskId = randomUUID();
  const apiCalls: Array<{ path: string; siteId: string; body: any }> = [];
  let origin = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const siteId = String(url.searchParams.get('SiteId') || req.headers['siteid'] || '');
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Generated OK</h1></body></html>');
      return;
    }
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    apiCalls.push({ path: url.pathname + url.search, siteId, body });
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/_api/v2/Template/Detail') {
      const id = url.searchParams.get('Id');
      res.end(
        JSON.stringify({
          id,
          name: 'Tourvia',
          previewUrl: id === emptyPreviewTemplateId ? '' : `${origin}/preview-template`,
        }),
      );
      return;
    }
    if (url.pathname === '/_api/v2/Domain/Available') {
      res.end(JSON.stringify([{ domainName: 'site.example.test', sudDomainUseDash: false }]));
      return;
    }
    if (url.pathname === '/_api/v2/Template/Use') {
      res.end(JSON.stringify(currentTargetSiteId));
      return;
    }
    if (url.pathname === '/_api/v2/Site/Create') {
      res.end(JSON.stringify({ siteId: currentTargetSiteId }));
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/TransferByLevel') {
      if (!siteId) {
        res.statusCode = 401;
        res.end(JSON.stringify(['User or website not valid']));
        return;
      }
      res.end(
        JSON.stringify({
          ownerSiteId: currentTargetSiteId,
          siteId: sandboxSiteId,
          sandbox: 'src-test01',
          previewUrl: `${origin}/src-sandbox`,
          taskId: transferTaskId,
          url: body?.url,
          success: true,
        }),
      );
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/ImportFromTemplate') {
      if (!siteId) {
        res.statusCode = 401;
        res.end(JSON.stringify(['User or website not valid']));
        return;
      }
      const templateName = typeof body?.templateName === 'string' ? body.templateName.trim() : '';
      if (!templateName) {
        res.statusCode = 400;
        res.end(JSON.stringify(['Parameter not found: templateName']));
        return;
      }
      res.end(
        JSON.stringify({
          ownerSiteId: currentTargetSiteId,
          siteId: refSandboxSiteId,
          sandbox: 'tpl-test01',
          previewUrl: `${origin}/tpl-sandbox`,
          templateId,
          templateName,
        }),
      );
      return;
    }
    if (url.pathname === '/_api/v2/Transfer/GetStatus') {
      res.end(JSON.stringify([{ url: 'https://legacy.example.com/', done: true }]));
      return;
    }
    if (url.pathname === '/_api/v2/Transfer/GetTaskStatus') {
      res.end(JSON.stringify({ pages: 4 }));
      return;
    }
    if (url.pathname === '/_api/v2/AI/CallFunction') {
      res.end(JSON.stringify({ contents: [{ result: true }] }));
      return;
    }
    if (url.pathname === '/_api/v2/Site/List') {
      res.end(JSON.stringify([{ siteId: currentTargetSiteId, name: 'auto', homePageLink: `${origin}/` }]));
      return;
    }
    res.end('true');
  });

  origin = await listen(server);
  clearKoobooCapabilityCache();
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map((e) => ({ ...e, origin, apiOrigin: origin })),
    });

    // 1. Missing previewUrl must fail before site creation without devday.cn fallback.
    const badRes = f.automationStore.saveResource({
      name: 'Missing Preview',
      scenario: 'materials',
      description: 'Need preview',
      contentUrl: '',
      referenceUrl: '',
      referenceTemplateId: emptyPreviewTemplateId,
      referenceTemplateName: 'NoPreview',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const badTask = f.automationStore.create(
      { resourceIds: [badRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    badTask.requirementsEnabled = false;
    badTask.learningPolicy = { ...badTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(badTask);
    await assert.rejects(
      executeGeneration(badTask, f.automationStore, f.vault, f.directory, AbortSignal.timeout(3000)),
      GenerationInputError,
    );
    assert.equal(f.automationStore.sites(badRes.id).length, 0);
    assert.ok(!apiCalls.some((c) => c.path.includes('Template/Use')));

    // 2. Materials + direct-template creates site via Template/Use and passes adaptation guidance.
    apiCalls.length = 0;
    const matSiteId = (currentTargetSiteId = randomUUID());
    const matRes = f.automationStore.saveResource({
      name: 'Materials Direct',
      scenario: 'materials',
      description: 'Brand adaptation materials',
      contentUrl: '',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const matTask = f.automationStore.create(
      { resourceIds: [matRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    matTask.requirementsEnabled = false;
    matTask.learningPolicy = { ...matTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(matTask);
    const matPayloads: Array<{ text?: string }> = [];
    await executeGeneration(
      matTask,
      f.automationStore,
      f.vault,
      f.directory,
      AbortSignal.timeout(5000),
      mockOpenSession(matTask, () => matSiteId, matPayloads),
    );
    assert.ok(apiCalls.some((c) => c.path.includes('Template/Use') && c.body?.id === templateId));
    assert.equal(matTask.generation?.referenceTemplate?.mode, 'direct-template');
    assert.equal(matTask.generation?.referenceTemplate?.previewUrl, `${origin}/preview-template`);
    assert.match(matPayloads[0]?.text || '', /template-adaptation\.md|原位适配/);
    assert.equal(effectiveReferenceUrl(f.automationStore.version(matTask.versionId), matTask), `${origin}/preview-template`);

    // Also verify task summary & live-comparison resolve the frozen template previewUrl when version.referenceUrl was empty.
    const summaryRes = await f.app.inject({ url: `/api/automation/tasks/${matTask.id}/summary`, headers: f.headers });
    assert.equal(summaryRes.statusCode, 200);
    assert.equal(summaryRes.json().canCompareLive, true);

    // 3. Upgrade + direct-template role-swap: Template/Use + AISandbox/TransferByLevel + sandbox polling + idempotent retry.
    apiCalls.length = 0;
    const upgSiteId = (currentTargetSiteId = randomUUID());
    const upgRes = f.automationStore.saveResource({
      name: 'Upgrade Role Swap',
      scenario: 'upgrade',
      description: 'Upgrade old site',
      contentUrl: 'https://legacy.example.com',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const upgTask = f.automationStore.create(
      { resourceIds: [upgRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete upgTask.autonomy;
    upgTask.requirementsEnabled = false;
    upgTask.learningPolicy = { ...upgTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(upgTask);
    const upgPayloads: Array<{ text?: string }> = [];
    await executeGeneration(
      upgTask,
      f.automationStore,
      f.vault,
      f.directory,
      AbortSignal.timeout(8000),
      mockOpenSession(upgTask, () => upgSiteId, upgPayloads),
    );
    assert.ok(apiCalls.some((c) => c.path.includes('Template/Use')));
    const transferCall = apiCalls.find((c) => c.path.includes('AISandbox/TransferByLevel') && c.siteId === upgSiteId);
    assert.ok(transferCall);
    assert.equal(transferCall.siteId, upgSiteId);
    assert.ok(apiCalls.some((c) => c.path.includes('Transfer/GetStatus') && c.siteId === sandboxSiteId));
    assert.ok(apiCalls.some((c) => c.path.includes('Transfer/GetTaskStatus') && c.siteId === sandboxSiteId));
    assert.equal(upgTask.generation?.sourceSandbox?.siteId, sandboxSiteId);
    assert.equal(upgTask.generation?.sourceSandbox?.complete, true);
    assert.match(upgPayloads[0]?.text || '', /src-test01/);

    // Retry must not re-create site or re-transfer source sandbox.
    const callsBeforeRetry = apiCalls.length;
    await executeGeneration(
      upgTask,
      f.automationStore,
      f.vault,
      f.directory,
      AbortSignal.timeout(5000),
      async () => {
        throw new Error('Completed generation should not open a new session');
      },
    );
    const callsDuringRetry = apiCalls.slice(callsBeforeRetry);
    assert.ok(!callsDuringRetry.some((c) => c.path.includes('Template/Use') || c.path.includes('TransferByLevel')));

    // 4. Reference-sandbox mode: Site/Create + AISandbox/ImportFromTemplate.
    apiCalls.length = 0;
    const sbSiteId = (currentTargetSiteId = randomUUID());
    const sbRes = f.automationStore.saveResource({
      name: 'Ref Sandbox',
      scenario: 'site-template',
      description: 'Study template in sandbox',
      contentUrl: '',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'reference-sandbox',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const sbTask = f.automationStore.create(
      { resourceIds: [sbRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    sbTask.requirementsEnabled = false;
    sbTask.learningPolicy = { ...sbTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(sbTask);
    const sbPayloads: Array<{ text?: string }> = [];
    await executeGeneration(
      sbTask,
      f.automationStore,
      f.vault,
      f.directory,
      AbortSignal.timeout(5000),
      mockOpenSession(sbTask, () => sbSiteId, sbPayloads),
    );
    assert.ok(apiCalls.some((c) => c.path.includes('Site/Create')));
    assert.ok(
      apiCalls.some(
        (c) =>
          c.path.includes('AISandbox/ImportFromTemplate') &&
          c.siteId === sbSiteId &&
          c.body?.templateId === templateId &&
          c.body?.templateName === 'Tourvia',
      ),
    );
    assert.equal(sbTask.generation?.referenceTemplateSandbox?.siteId, refSandboxSiteId);
    assert.match(sbPayloads[0]?.text || '', /tpl-test01/);

    assert.equal(
      effectiveTemplateUsageMode({ referenceTemplateId: templateId }, true),
      'reference-sandbox',
    );
  } finally {
    await close(server);
    await f.close();
  }
});

test('probeKoobooApiMethod and GET /api/automation/kooboo/capabilities distinguish old vs new Kooboo servers', async () => {
  clearKoobooCapabilityCache();
  let mode: 'old-en' | 'old-zh' | '404' | 'partial-1117' | 'new' | 'error-500' = 'old-en';
  let probeCount = 0;

  const server = createServer((req, res) => {
    probeCount++;
    const url = new URL(req.url!, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'error-500') {
      res.statusCode = 500;
      res.end('Internal Error');
      return;
    }
    if (mode === '404') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/TransferByLevel') {
      if (mode === 'old-en') {
        res.statusCode = 400;
        res.end(JSON.stringify(['Api method Not Found']));
        return;
      }
      if (mode === 'old-zh') {
        res.statusCode = 400;
        res.end(JSON.stringify(['找不到API方法']));
        return;
      }
      if (mode === 'partial-1117') {
        res.statusCode = 400;
        res.end(JSON.stringify(['Api method Not Found']));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify(['User or website not valid']));
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/ImportFromTemplate') {
      if (mode === 'old-en') {
        res.statusCode = 400;
        res.end(JSON.stringify(['Api method Not Found']));
        return;
      }
      if (mode === 'old-zh') {
        res.statusCode = 400;
        res.end(JSON.stringify(['找不到API方法']));
        return;
      }
      res.statusCode = mode === 'partial-1117' ? 403 : 400;
      res.end(JSON.stringify([mode === 'partial-1117' ? 'Access denied' : 'templateId is required.']));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  const origin = await listen(server);
  const f = await fixture(origin);
  try {
    // 500 -> 'unknown', must NOT be cached
    mode = 'error-500';
    assert.equal(
      await probeKoobooApiMethod({ apiOrigin: origin, path: 'AISandbox/TransferByLevel', signal: AbortSignal.timeout(3000) }),
      'unknown',
    );
    mode = 'old-en';
    assert.equal(
      await probeKoobooApiMethod({ apiOrigin: origin, path: 'AISandbox/TransferByLevel', signal: AbortSignal.timeout(3000) }),
      'unsupported',
    );

    // 404 -> 'unsupported'
    clearKoobooCapabilityCache();
    mode = '404';
    assert.equal(
      await probeKoobooApiMethod({ apiOrigin: origin, path: 'AISandbox/ImportFromTemplate', signal: AbortSignal.timeout(3000) }),
      'unsupported',
    );

    // Old Chinese Kooboo via HTTP API
    clearKoobooCapabilityCache();
    mode = 'old-zh';
    const zhRes = await f.app.inject({
      url: `/api/automation/kooboo/capabilities?environmentId=${f.envId}`,
      headers: f.headers,
    });
    assert.equal(zhRes.statusCode, 200);
    assert.deepEqual(zhRes.json(), {
      environmentId: f.envId,
      transferByLevel: 'unsupported',
      importFromTemplate: 'unsupported',
    });

    // Cached without refresh=1, updated when refresh=1
    mode = 'partial-1117';
    const beforeRefresh = probeCount;
    const cachedRes = await f.app.inject({
      url: `/api/automation/kooboo/capabilities?environmentId=${f.envId}`,
      headers: f.headers,
    });
    assert.equal(cachedRes.statusCode, 200);
    assert.equal(cachedRes.json().transferByLevel, 'unsupported');
    assert.equal(cachedRes.json().importFromTemplate, 'unsupported');
    assert.equal(probeCount, beforeRefresh, 'Expected capabilities to be served from TTL cache');

    const refreshedRes = await f.app.inject({
      url: `/api/automation/kooboo/capabilities?environmentId=${f.envId}&refresh=1`,
      headers: f.headers,
    });
    assert.equal(refreshedRes.statusCode, 200);
    assert.deepEqual(refreshedRes.json(), {
      environmentId: f.envId,
      transferByLevel: 'unsupported',
      importFromTemplate: 'supported',
    });

    mode = 'new';
    const newCap = await probeKoobooSandboxCapabilities(
      { id: f.envId, origin, apiOrigin: origin, token: 'test-token' },
      AbortSignal.timeout(3000),
      { forceRefresh: true },
    );
    assert.deepEqual(newCap, {
      environmentId: f.envId,
      transferByLevel: 'supported',
      importFromTemplate: 'supported',
    });
  } finally {
    clearKoobooCapabilityCache();
    await close(server);
    await f.close();
  }
});

test('executeGeneration blocks incompatible template modes BEFORE creating any site on old Kooboo while allowing materials + direct-template', async () => {
  clearKoobooCapabilityCache();
  const templateId = '15b72444-e031-4695-a7f1-048dfbf02e82';
  const matSiteId = randomUUID();
  const calls: string[] = [];
  let origin = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url!, origin);
    calls.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Template OK</h1></body></html>');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/_api/v2/Template/Detail') {
      res.end(JSON.stringify({ id: templateId, name: 'Tourvia', previewUrl: `${origin}/preview-template` }));
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/TransferByLevel') {
      res.statusCode = 400;
      res.end(JSON.stringify(['Api method Not Found']));
      return;
    }
    if (url.pathname === '/_api/v2/AISandbox/ImportFromTemplate') {
      res.statusCode = 400;
      res.end(JSON.stringify(['找不到API方法']));
      return;
    }
    if (url.pathname === '/_api/v2/Domain/Available') {
      res.end(JSON.stringify([{ domainName: 'site.example.test', sudDomainUseDash: false }]));
      return;
    }
    if (url.pathname === '/_api/v2/Template/Use') {
      res.end(JSON.stringify(matSiteId));
      return;
    }
    if (url.pathname === '/_api/v2/Site/List') {
      res.end(JSON.stringify([{ siteId: matSiteId, name: 'auto', homePageLink: `${origin}/` }]));
      return;
    }
    res.end('true');
  });

  origin = await listen(server);
  const f = await fixture(origin);
  try {
    // 1. upgrade + direct-template must be blocked BEFORE Template/Use (zero sites created)
    const upgRes = f.automationStore.saveResource({
      name: 'Old HK Upgrade',
      scenario: 'upgrade',
      description: 'Should be stopped before site creation',
      contentUrl: 'https://legacy.example.com',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const upgTask = f.automationStore.create(
      { resourceIds: [upgRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete upgTask.autonomy;
    upgTask.requirementsEnabled = false;
    upgTask.learningPolicy = { ...upgTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(upgTask);

    await assert.rejects(
      executeGeneration(upgTask, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)),
      (err: unknown) =>
        err instanceof FollowupRuntimeError &&
        err.userSummary?.category === 'environment' &&
        /AISandbox\/TransferByLevel/.test(err.message),
    );
    assert.equal(f.automationStore.sites(upgRes.id).length, 0);
    assert.ok(!calls.some((c) => c.includes('Template/Use') || c.includes('Site/Create')));

    // 2. site-template + reference-sandbox must be blocked BEFORE Site/Create (zero sites created)
    calls.length = 0;
    const sbRes = f.automationStore.saveResource({
      name: 'Old HK Ref Sandbox',
      scenario: 'site-template',
      description: 'Should be stopped before Site/Create',
      contentUrl: '',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'reference-sandbox',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const sbTask = f.automationStore.create(
      { resourceIds: [sbRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete sbTask.autonomy;
    sbTask.requirementsEnabled = false;
    sbTask.learningPolicy = { ...sbTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(sbTask);

    await assert.rejects(
      executeGeneration(sbTask, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)),
      (err: unknown) =>
        err instanceof FollowupRuntimeError &&
        err.userSummary?.category === 'environment' &&
        /AISandbox\/ImportFromTemplate/.test(err.message),
    );
    assert.equal(f.automationStore.sites(sbRes.id).length, 0);
    assert.ok(!calls.some((c) => c.includes('Site/Create') || c.includes('Template/Use')));

    // 3. materials + direct-template does NOT require new AISandbox methods and still works on old Kooboo!
    calls.length = 0;
    const matRes = f.automationStore.saveResource({
      name: 'Old HK Materials Direct',
      scenario: 'materials',
      description: 'Should still succeed via Template/Use',
      contentUrl: '',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const matTask = f.automationStore.create(
      { resourceIds: [matRes.id], kind: 'generation', scope: 'site', environmentId: f.envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    matTask.requirementsEnabled = false;
    matTask.learningPolicy = { ...matTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(matTask);
    const payloads: Array<{ text?: string }> = [];
    await executeGeneration(
      matTask,
      f.automationStore,
      f.vault,
      f.directory,
      AbortSignal.timeout(5000),
      mockOpenSession(matTask, () => matSiteId, payloads),
    );
    assert.equal(f.automationStore.sites(matRes.id).length, 1);
    assert.ok(calls.some((c) => c.includes('Template/Use')));
  } finally {
    clearKoobooCapabilityCache();
    await close(server);
    await f.close();
  }
});
