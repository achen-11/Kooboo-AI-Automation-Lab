import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../server/app.js';
import { defaultDeliveryPolicy } from '../shared/automation.js';
import { queueDelivery, executeDelivery, deliveryReceipt, deliveryRequestUrl, cleanupSiteTempScreenshots } from '../server/automation/delivery.js';

const KOOBOO_GUIDS = [
  '1adbf7f5-d119-0a84-53bb-2ecddb7d9ff1',
  'e3f7e688-16dc-c31f-21e7-0a8ed5899dfd',
  '7b788f38-93d0-fbd5-ad79-a9aac09be3b6',
] as const;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-diag-test-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const env = randomUUID();
  const target = randomUUID();
  f.vault.update({
    threshold: 80,
    paused: true,
    model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [
      {
        id: env,
        name: 'HK',
        origin: 'https://hk.test',
        apiOrigin: 'https://hk.test',
        token: 'test-hk',
        delivery: { ...defaultDeliveryPolicy, enabled: true, targetEnvironmentId: target, token: 'test-migration' },
      },
      { id: target, name: 'DE', origin: 'https://de.test', apiOrigin: 'https://de.test', token: 'test-de' },
    ],
  });
  const resource = f.automationStore.saveResource({
    name: 'Materials',
    scenario: 'migration',
    description: '',
    contentUrl: 'https://content.test',
    referenceUrl: '',
    externalId: '',
    externalSource: '',
    files: [],
  });
  const site = {
    id: randomUUID(),
    resourceId: resource.id,
    versionId: f.automationStore.versions(resource.id)[0].id,
    environmentId: env,
    siteId: randomUUID(),
    name: 'Generated',
    url: 'https://generated.test',
    createdAt: Date.now(),
  };
  f.automationStore.saveSite(site);
  const done = () => {
    const task = f.automationStore.create(
      { resourceIds: [resource.id], kind: 'evaluation', scope: 'site', environmentId: env, generatedSiteId: site.id, requirements: '' },
      f.vault.automation(),
    )[0];
    task.requirementsEnabled = false;
    task.status = 'completed';
    task.report = {
      summary: 'source report',
      assessments: [],
      issues: [],
      coverage: { verified: [], unverified: [], outOfScope: [] },
      scores: [],
      quality: 'passed',
      artifacts: [],
    };
    f.automationStore.put(task);
    return task;
  };
  return {
    ...f,
    directory,
    headers,
    env,
    target,
    resource,
    site,
    done,
    async close() {
      await f.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('delivery receipt, executeDelivery and Kooboo ID endpoints accept valid non-RFC4122 Kooboo GUIDs and reject invalid strings', async () => {
  for (const guid of KOOBOO_GUIDS) {
    assert.deepEqual(deliveryReceipt({ siteId: guid, siteUrl: 'https://target.test' }), { siteId: guid, siteUrl: 'https://target.test' });
  }
  assert.throws(() => deliveryReceipt({ siteId: 'not-a-guid', siteUrl: 'https://target.test' }));

  const f = await fixture();
  const koobooGuid = KOOBOO_GUIDS[0];
  let endpoint = '';
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/_api/v2/Template/Detail')) {
      res.end(JSON.stringify({ id: koobooGuid, name: 'Kooboo Template', previewUrl: `${endpoint}/preview` }));
      return;
    }
    if (req.method === 'GET') {
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    res.end(JSON.stringify({ siteId: koobooGuid, siteUrl: 'https://target.test' }));
  });
  endpoint = await listen(server);

  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, origin: endpoint, apiOrigin: endpoint, delivery: { ...e.delivery!, endpoint } } : e)),
    });

    const t = f.done();
    queueDelivery(t, f.automationStore, f.vault);
    let verified = 0;
    await executeDelivery(t, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async task => {
      verified++;
      task.delivery!.status = 'completed';
    });
    assert.equal(verified, 1);
    assert.equal(f.automationStore.task(t.id)!.delivery!.target?.siteId, koobooGuid);

    const site2 = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.env,
      siteId: randomUUID(),
      name: 'Generated2',
      url: 'https://generated2.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site2);
    const t2 = f.automationStore.create(
      { resourceIds: [f.resource.id], kind: 'evaluation', scope: 'site', environmentId: f.env, generatedSiteId: site2.id, requirements: '' },
      f.vault.automation(),
    )[0];
    t2.requirementsEnabled = false;
    t2.status = 'completed';
    t2.report = t.report;
    f.automationStore.put(t2);
    queueDelivery(t2, f.automationStore, f.vault);
    t2.delivery!.status = 'uncertain';
    t2.delivery!.stopped = true;
    t2.delivery!.attemptedAt = Date.now();
    t2.delivery!.error = 'uncertain';
    f.automationStore.put(t2);
    const receiptRes = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${t2.id}/delivery/receipt`,
      headers: f.headers,
      payload: { siteId: KOOBOO_GUIDS[1], siteUrl: 'https://target.test' },
    });
    assert.equal(receiptRes.statusCode, 200, receiptRes.body);
    assert.equal(f.automationStore.task(t2.id)!.delivery!.status, 'queued');
    assert.equal(f.automationStore.task(t2.id)!.delivery!.target?.siteId, KOOBOO_GUIDS[1]);

    const goodSiteRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/sites',
      headers: f.headers,
      payload: {
        resourceId: f.resource.id,
        environmentId: f.env,
        siteId: KOOBOO_GUIDS[2],
        name: 'kooboo_site_guid',
        url: 'https://kooboo-site.test',
      },
    });
    assert.equal(goodSiteRes.statusCode, 200, goodSiteRes.body);
    const badSiteRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/sites',
      headers: f.headers,
      payload: {
        resourceId: f.resource.id,
        environmentId: f.env,
        siteId: 'not-a-guid',
        name: 'bad_site',
        url: 'https://kooboo-site.test',
      },
    });
    assert.equal(badSiteRes.statusCode, 400);

    const goodResourceRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Template Ref',
        scenario: 'site-template',
        description: '',
        contentUrl: '',
        referenceUrl: '',
        referenceTemplateId: koobooGuid,
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(goodResourceRes.statusCode, 201, goodResourceRes.body);
    const badResourceRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers: f.headers,
      payload: {
        name: 'Bad Template Ref',
        scenario: 'site-template',
        description: '',
        contentUrl: '',
        referenceUrl: '',
        referenceTemplateId: 'not-a-guid',
        externalSource: '',
        externalId: '',
        files: [],
      },
    });
    assert.equal(badResourceRes.statusCode, 400);

    const goodTemplateRes = await f.app.inject({
      method: 'GET',
      url: `/api/automation/kooboo/templates/${koobooGuid}?environmentId=${f.env}`,
      headers: f.headers,
    });
    assert.equal(goodTemplateRes.statusCode, 200, goodTemplateRes.body);
    assert.equal(JSON.parse(goodTemplateRes.body).id, koobooGuid);
    const badTemplateRes = await f.app.inject({
      method: 'GET',
      url: `/api/automation/kooboo/templates/not-a-guid?environmentId=${f.env}`,
      headers: f.headers,
    });
    assert.equal(badTemplateRes.statusCode, 400);

    const fakeEvalId = randomUUID();
    const fakeRunId = randomUUID();
    const fakeHandoffId = randomUUID();
    const goodHandoffRes = await f.app.inject({
      method: 'POST',
      url: `/api/evaluations/${fakeEvalId}/issue-handoffs`,
      headers: f.headers,
      payload: { id: randomUUID(), runId: fakeRunId, indices: [0], environmentId: f.env, siteId: koobooGuid },
    });
    assert.equal(goodHandoffRes.statusCode, 409, goodHandoffRes.body);
    const badHandoffRes = await f.app.inject({
      method: 'POST',
      url: `/api/evaluations/${fakeEvalId}/issue-handoffs`,
      headers: f.headers,
      payload: { id: randomUUID(), runId: fakeRunId, indices: [0], environmentId: f.env, siteId: 'not-a-guid' },
    });
    assert.equal(badHandoffRes.statusCode, 400);

    const goodHandoffReceiptRes = await f.app.inject({
      method: 'POST',
      url: `/api/evaluations/${fakeEvalId}/issue-handoffs/${fakeHandoffId}/receipt`,
      headers: f.headers,
      payload: { runId: fakeRunId, siteId: koobooGuid, status: 'accepted', sessionId: KOOBOO_GUIDS[1] },
    });
    assert.equal(goodHandoffReceiptRes.statusCode, 409, goodHandoffReceiptRes.body);
    const badHandoffReceiptRes = await f.app.inject({
      method: 'POST',
      url: `/api/evaluations/${fakeEvalId}/issue-handoffs/${fakeHandoffId}/receipt`,
      headers: f.headers,
      payload: { runId: fakeRunId, siteId: koobooGuid, status: 'accepted', sessionId: 'not-a-guid' },
    });
    assert.equal(badHandoffReceiptRes.statusCode, 400);
  } finally {
    await close(server);
    await f.close();
  }
});

test('migration HTTP 500 JSON records bounded redacted body, trace header and elapsed time without corrupting persisted JSON', async () => {
  const f = await fixture();
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'req-500-abc' });
    res.end(JSON.stringify({ error: 'export timed out', token: 'test-migration', upstream: 'Bearer leaked-bearer-token' }));
  });
  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });
    const t = f.done();
    queueDelivery(t, f.automationStore, f.vault);
    await executeDelivery(t, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async () => assert.fail('must not verify on 500'));
    assert.equal(t.delivery!.status, 'uncertain');
    for (const err of [t.delivery!.error, f.automationStore.task(t.id)!.delivery!.error]) {
      assert.match(err, /HTTP 500/);
      assert.match(err, /耗时 \d+/);
      assert.ok(err.includes('x-request-id=req-500-abc'));
      assert.ok(err.includes('export timed out'));
      assert.ok(err.includes('[已隐藏]'));
      assert.ok(!err.includes('test-migration'));
      assert.ok(!err.includes('leaked-bearer-token'));
    }
    const failEvent = f.automationStore.events(t.id).map(e => e.message).find(m => m.includes('HTTP 500')) || '';
    assert.ok(failEvent);
    assert.match(failEvent, /耗时 \d+/);
    assert.ok(failEvent.includes('content-type=application/json'));
    assert.ok(failEvent.includes('x-request-id=req-500-abc'));
    assert.ok(failEvent.includes('export timed out'));
    assert.ok(failEvent.includes('[已隐藏]'));
    assert.ok(!failEvent.includes('test-migration'));
    assert.ok(!failEvent.includes('leaked-bearer-token'));
  } finally {
    await close(server);
    await f.close();
  }
});

test('migration HTTP 502 with oversized HTML error page strips markup, redacts secrets and bounds stored diagnostics', async () => {
  const f = await fixture();
  const html = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title><style>body{color:red}</style></head><body><p>Origin timeout ?api_key=super-secret-key</p><p>${'A'.repeat(35000)}</p></body></html>`;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'cf-ray': '99aabbcc-AMS' });
    res.end(html);
  });
  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });
    const t = f.done();
    queueDelivery(t, f.automationStore, f.vault);
    await executeDelivery(t, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async () => assert.fail('must not verify on 502'));
    assert.equal(t.delivery!.status, 'uncertain');
    const err = t.delivery!.error;
    assert.match(err, /HTTP 502/);
    assert.ok(err.includes('cf-ray=99aabbcc-AMS'));
    assert.ok(err.includes('502 Bad Gateway'));
    assert.ok(!err.includes('super-secret-key'));
    assert.ok(!err.includes('body{color:red}'));
    assert.ok(err.length < 600, `expected bounded delivery.error, got ${err.length}`);
    const failEvent = f.automationStore.events(t.id).map(e => e.message).find(m => m.includes('HTTP 502')) || '';
    assert.ok(failEvent);
    assert.ok(failEvent.includes('cf-ray=99aabbcc-AMS'));
    assert.ok(failEvent.includes('502 Bad Gateway'));
    assert.ok(!failEvent.includes('super-secret-key'));
    assert.ok(!failEvent.includes('body{color:red}'));
    assert.ok(failEvent.length < 2600, `expected bounded event, got ${failEvent.length}`);
  } finally {
    await close(server);
    await f.close();
  }
});

test('migration HTTP 500 with empty body records empty-body marker and failure event', async () => {
  const f = await fixture();
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });
    const t = f.done();
    queueDelivery(t, f.automationStore, f.vault);
    await executeDelivery(t, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async () => assert.fail('must not verify on empty 500'));
    assert.equal(t.delivery!.status, 'uncertain');
    assert.match(t.delivery!.error, /HTTP 500/);
    assert.match(t.delivery!.error, /耗时 \d+/);
    assert.ok(t.delivery!.error.includes('响应体为空'));
    const failEvent = f.automationStore.events(t.id).map(e => e.message).find(m => m.includes('HTTP 500')) || '';
    assert.ok(failEvent);
    assert.ok(failEvent.includes('响应体为空'));
  } finally {
    await close(server);
    await f.close();
  }
});

test('migration HTTP 200 with malformed non-JSON receipt records parse diagnostic event with correlation header', async () => {
  const f = await fixture();
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'x-correlation-id': 'corr-200-bad' });
    res.end('<html>unexpected proxy page Bearer leaked-token</html>');
  });
  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });
    const t = f.done();
    queueDelivery(t, f.automationStore, f.vault);
    await executeDelivery(t, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async () => assert.fail('must not verify on malformed 200 receipt'));
    assert.equal(t.delivery!.status, 'uncertain');
    const failEvent = f.automationStore.events(t.id).map(e => e.message).find(m => m.includes('迁移回执解析或校验失败')) || '';
    assert.ok(failEvent);
    assert.ok(failEvent.includes('x-correlation-id=corr-200-bad'));
    assert.match(failEvent, /耗时 \d+/);
    assert.ok(failEvent.includes('unexpected proxy page Bearer [已隐藏]'));
    assert.ok(!failEvent.includes('leaked-token'));
  } finally {
    await close(server);
    await f.close();
  }
});

test('Bearer redaction regex preserves JSON closing quotes and escape backslashes', () => {
  const serialized = JSON.stringify({ nested: JSON.stringify({ msg: 'Bearer secret-token' }) });
  const sanitized = serialized.replace(/Bearer\s+[^\s"',;\\]+/gi, 'Bearer [已隐藏]');
  const parsed = JSON.parse(sanitized) as { nested: string };
  assert.deepEqual(JSON.parse(parsed.nested), { msg: 'Bearer [已隐藏]' });
});

test('deliveryRequestUrl and executeDelivery append __engine_timeout__ aligned with policy.timeoutSeconds', async () => {
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate', 180),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=180',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate', 240),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=240',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate', 0),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=180',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate', Number.NaN),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=180',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate?foo=bar', 180),
    'https://launch.kooboo.nl/api/sitemigrate?foo=bar&__engine_timeout__=180',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=300', 180),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=300',
  );
  assert.equal(
    deliveryRequestUrl('https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=', 240),
    'https://launch.kooboo.nl/api/sitemigrate?__engine_timeout__=240',
  );

  const f = await fixture();
  const capturedUrls: string[] = [];
  const siteList = [{ siteId: f.site.siteId, homePageLink: f.site.url }];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify(siteList));
      return;
    }
    capturedUrls.push(req.url || '');
    res.end(JSON.stringify({ siteId: KOOBOO_GUIDS[0], siteUrl: 'https://target.test' }));
  });
  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });

    const t1 = f.done();
    queueDelivery(t1, f.automationStore, f.vault);
    await executeDelivery(t1, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async task => {
      task.delivery!.status = 'completed';
    });
    assert.equal(capturedUrls.length, 1);
    assert.equal(capturedUrls[0], '/api/sitemigrate?__engine_timeout__=180');
    assert.equal(t1.delivery!.policy.endpoint, endpoint);

    const raw2 = f.vault.get();
    f.vault.update({
      ...raw2,
      environments: raw2.environments.map(e => (e.id === f.env ? { ...e, delivery: { ...e.delivery!, timeoutSeconds: 240 } } : e)),
    });
    const site2 = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.automationStore.versions(f.resource.id)[0].id,
      environmentId: f.env,
      siteId: randomUUID(),
      name: 'Generated240',
      url: 'https://generated240.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site2);
    siteList.push({ siteId: site2.siteId, homePageLink: site2.url });
    const t2 = f.automationStore.create(
      { resourceIds: [f.resource.id], kind: 'evaluation', scope: 'site', environmentId: f.env, generatedSiteId: site2.id, requirements: '' },
      f.vault.automation(),
    )[0];
    t2.requirementsEnabled = false;
    t2.status = 'completed';
    t2.report = t1.report;
    f.automationStore.put(t2);
    queueDelivery(t2, f.automationStore, f.vault);
    await executeDelivery(t2, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async task => {
      task.delivery!.status = 'completed';
    });
    assert.equal(capturedUrls.length, 2);
    assert.equal(capturedUrls[1], '/api/sitemigrate?__engine_timeout__=240');
    assert.equal(t2.delivery!.policy.endpoint, endpoint);
  } finally {
    await close(server);
    await f.close();
  }
});

test('cleanupSiteTempScreenshots removes unreferenced /screenshots before sitemigrate and stays non-fatal on errors', async () => {
  const f = await fixture();
  const callLog: Array<{ path: string; body?: unknown }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/_api/v2/Site/List') {
      res.end(JSON.stringify([{ siteId: f.site.siteId, homePageLink: f.site.url }]));
      return;
    }
    if (url.pathname === '/_api/v2/Media/List') {
      const folderPath = url.searchParams.get('path') || '/';
      callLog.push({ path: `Media/List?path=${folderPath}` });
      if (folderPath === '/screenshots') {
        res.end(
          JSON.stringify({
            folders: [{ name: 'processed', fullPath: '/screenshots/processed' }],
            files: [{ id: 'img-root-1', size: 1024 * 1024, references: {} }],
          }),
        );
        return;
      }
      if (folderPath === '/screenshots/processed') {
        res.end(
          JSON.stringify({
            folders: [],
            files: [{ id: 'img-sub-1', size: 2 * 1024 * 1024, references: null }],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ folders: [], files: [] }));
      return;
    }
    if (url.pathname === '/_api/v2/Media/DeleteFolders') {
      callLog.push({ path: 'Media/DeleteFolders', body: parsedBody });
      res.end('true');
      return;
    }
    if (url.pathname === '/api/sitemigrate') {
      callLog.push({ path: 'sitemigrate' });
      res.end(JSON.stringify({ siteId: KOOBOO_GUIDS[0], siteUrl: 'https://target.test' }));
      return;
    }
    res.end('true');
  });

  const apiOrigin = await listen(server);
  const endpoint = `${apiOrigin}/api/sitemigrate`;
  try {
    const raw = f.vault.get();
    f.vault.update({
      ...raw,
      environments: raw.environments.map(e => (e.id === f.env ? { ...e, apiOrigin, delivery: { ...e.delivery!, endpoint } } : e)),
    });

    // 1. executeDelivery removes whole /screenshots folder before sitemigrate when nothing is referenced
    const t1 = f.done();
    queueDelivery(t1, f.automationStore, f.vault);
    await executeDelivery(t1, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async task => {
      task.delivery!.status = 'completed';
    });
    assert.deepEqual(callLog, [
      { path: 'Media/List?path=/screenshots' },
      { path: 'Media/List?path=/screenshots/processed' },
      { path: 'Media/DeleteFolders', body: ['/screenshots'] },
      { path: 'sitemigrate' },
    ]);
    assert.ok(
      f.automationStore.events(t1.id).some(e => /跨环境交付前已清理媒体库 \/screenshots 临时截图（2 张，释放约 3\.00 MiB）/.test(e.message)),
    );

    // 2. cleanupSiteTempScreenshots preserves referenced images and only deletes unreferenced IDs + clean subfolders
    const mixedCalls: Array<{ path: string; body?: unknown }> = [];
    const mixedResult = await cleanupSiteTempScreenshots(async (path, body) => {
      mixedCalls.push({ path, body });
      if (path === 'Media/List?path=%2Fscreenshots') {
        return {
          folders: [{ fullPath: '/screenshots/processed' }],
          files: [
            { id: 'img-used', size: 500_000, references: { Page: 1 } },
            { id: 'img-unused', size: 250_000, references: {} },
          ],
        };
      }
      if (path === 'Media/List?path=%2Fscreenshots%2Fprocessed') {
        return {
          folders: [],
          files: [{ id: 'img-slice', size: 750_000 }],
        };
      }
      return true;
    }, f.site.siteId);
    assert.deepEqual(mixedResult, {
      deletedImages: 2,
      deletedBytes: 1_000_000,
      deletedFolders: 1,
      skippedReferenced: 1,
    });
    assert.deepEqual(mixedCalls.slice(2), [
      { path: 'Media/DeleteImages', body: ['img-unused', 'img-slice'] },
      { path: 'Media/DeleteFolders', body: ['/screenshots/processed'] },
    ]);

    // 3. Failure during Media/List is non-fatal to executeDelivery
    const site2 = { ...f.site, id: randomUUID(), siteId: randomUUID(), name: 'GeneratedErr', url: 'https://generated-err.test' };
    const errServer = createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/_api/v2/Site/List') {
        res.end(JSON.stringify([{ siteId: site2.siteId, homePageLink: site2.url }]));
        return;
      }
      if (url.pathname === '/_api/v2/Media/List') {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'Media service unavailable' }));
        return;
      }
      res.end(JSON.stringify({ siteId: KOOBOO_GUIDS[1], siteUrl: 'https://target2.test' }));
    });
    const errOrigin = await listen(errServer);
    try {
      f.automationStore.saveSite(site2);
      const rawErr = f.vault.get();
      f.vault.update({
        ...rawErr,
        environments: rawErr.environments.map(e => (e.id === f.env ? { ...e, apiOrigin: errOrigin, delivery: { ...e.delivery!, endpoint: `${errOrigin}/api/sitemigrate` } } : e)),
      });
      const t2 = f.automationStore.create(
        { resourceIds: [f.resource.id], kind: 'evaluation', scope: 'site', environmentId: f.env, generatedSiteId: site2.id, requirements: '' },
        f.vault.automation(),
      )[0];
      t2.requirementsEnabled = false;
      t2.status = 'completed';
      t2.report = t1.report;
      f.automationStore.put(t2);
      queueDelivery(t2, f.automationStore, f.vault);
      await executeDelivery(t2, f.automationStore, f.vault, f.directory, AbortSignal.timeout(2000), async task => {
        task.delivery!.status = 'completed';
      });
      assert.equal(t2.delivery!.status, 'completed');
      assert.ok(
        f.automationStore.events(t2.id).some(e => /跨环境交付前清理媒体库临时截图失败（不影响继续迁移）/.test(e.message)),
      );
    } finally {
      await close(errServer);
    }
  } finally {
    await close(server);
    await f.close();
  }
});
