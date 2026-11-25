import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultDeliveryPolicy, type AutomationReport } from '../shared/automation.js';
import { collectDeliverySecrets, resolveDeliveryDefaults, resolveEnvironmentDelivery } from '../server/lib/delivery-config.js';
import { executeDelivery, queueDelivery } from '../server/automation/delivery.js';

function passedReport(): AutomationReport {
  return {
    summary: 'Passed',
    quality: 'passed',
    scores: [
      { viewport: 'desktop', value: 90 },
      { viewport: 'mobile', value: 88 },
    ],
    assessments: [
      { criterionId: 'visual', viewport: 'desktop', score: 90, reason: 'ok', evidence: [], passed: true },
      { criterionId: 'visual', viewport: 'mobile', score: 88, reason: 'ok', evidence: [], passed: true },
    ],
    issues: [],
    coverage: { verified: ['首页'], unverified: [], outOfScope: [] },
    artifacts: [],
  };
}

test('resolveDeliveryDefaults and resolveEnvironmentDelivery follow override > vault > env > built-in precedence', () => {
  const envId = randomUUID();
  const baseEnv = {
    id: envId,
    name: 'HK',
    origin: 'https://hk.test',
    apiOrigin: 'https://hk.test',
    token: 'kooboo-token',
    delivery: {
      ...defaultDeliveryPolicy,
      enabled: true,
      endpoint: '',
      token: '',
    },
  };

  // Built-in default when vault and process.env are empty
  const builtIn = resolveEnvironmentDelivery({ environments: [baseEnv] }, envId, {});
  assert.equal(builtIn?.endpoint, defaultDeliveryPolicy.endpoint);
  assert.equal(builtIn?.token, '');
  assert.equal(builtIn?.hasCustomEndpoint, false);
  assert.equal(builtIn?.hasCustomToken, false);

  // Process env fallback (ignoring malformed URL)
  const fromInvalidEnv = resolveDeliveryDefaults({}, {
    EVALUATOR_DELIVERY_ENDPOINT: 'ftp://invalid.test/migrate',
    EVALUATOR_DELIVERY_TOKEN: 'env-default-token',
  });
  assert.equal(fromInvalidEnv.endpoint, defaultDeliveryPolicy.endpoint);
  assert.equal(fromInvalidEnv.endpointFromEnv, false);
  assert.equal(fromInvalidEnv.token, 'env-default-token');
  assert.equal(fromInvalidEnv.tokenFromEnv, true);

  const fromEnv = resolveEnvironmentDelivery({ environments: [baseEnv] }, envId, {
    EVALUATOR_DELIVERY_ENDPOINT: 'https://env-migrate.test/api/sitemigrate',
    EVALUATOR_DELIVERY_TOKEN: 'env-default-token',
  });
  assert.equal(fromEnv?.endpoint, 'https://env-migrate.test/api/sitemigrate');
  assert.equal(fromEnv?.token, 'env-default-token');

  // Vault global defaults override env
  const fromVault = resolveEnvironmentDelivery(
    {
      deliveryDefaults: { endpoint: 'https://vault-migrate.test/api', token: 'vault-default-token' },
      environments: [baseEnv],
    },
    envId,
    {
      EVALUATOR_DELIVERY_ENDPOINT: 'https://env-migrate.test/api/sitemigrate',
      EVALUATOR_DELIVERY_TOKEN: 'env-default-token',
    },
  );
  assert.equal(fromVault?.endpoint, 'https://vault-migrate.test/api');
  assert.equal(fromVault?.token, 'vault-default-token');

  // Per-environment override wins over vault and env
  const customEnv = {
    ...baseEnv,
    delivery: {
      ...baseEnv.delivery,
      endpoint: 'https://custom-migrate.test/api',
      token: 'custom-env-token',
    },
  };
  const fromOverride = resolveEnvironmentDelivery(
    {
      deliveryDefaults: { endpoint: 'https://vault-migrate.test/api', token: 'vault-default-token' },
      environments: [customEnv],
    },
    envId,
    { EVALUATOR_DELIVERY_TOKEN: 'env-default-token' },
  );
  assert.equal(fromOverride?.endpoint, 'https://custom-migrate.test/api');
  assert.equal(fromOverride?.token, 'custom-env-token');
  assert.equal(fromOverride?.hasCustomEndpoint, true);
  assert.equal(fromOverride?.hasCustomToken, true);

  const secrets = collectDeliverySecrets(
    {
      deliveryDefaults: { endpoint: '', token: 'vault-default-token' },
      environments: [customEnv],
    },
    { EVALUATOR_DELIVERY_TOKEN: 'env-default-token' },
  );
  assert.deepEqual(new Set(secrets), new Set(['vault-default-token', 'env-default-token', 'custom-env-token']));
});

test('settings API supports empty inherited delivery endpoint, preserves omitted deliveryDefaults, and adopts existing environment token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-defaults-api-'));
  const app = await createApp({ directory, serveWeb: false, startWorker: false });
  try {
    const login = await app.app.inject({ method: 'POST', url: '/api/login' });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

    const legacyEnvId = randomUUID();
    const newEnvId = randomUUID();

    // Legacy environment already has its own delivery token while global default is empty
    const saveInitial = await app.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        threshold: 80,
        paused: true,
        execution: { timeoutSeconds: 300, captureAttempts: 2 },
        model: { endpoint: '', name: 'deepseek-flash' },
        environments: [
          {
            id: legacyEnvId,
            name: '香港旧环境',
            origin: 'https://hk.test',
            apiOrigin: 'https://hk.test',
            delivery: { ...defaultDeliveryPolicy, enabled: true, endpoint: '', token: 'legacy-secret-token' },
          },
          {
            id: newEnvId,
            name: '德国新环境',
            origin: 'https://de.test',
            apiOrigin: 'https://de.test',
            delivery: { ...defaultDeliveryPolicy, enabled: true, endpoint: '' },
          },
        ],
      },
    });
    assert.equal(saveInitial.statusCode, 200);
    const pub1 = saveInitial.json();
    assert.equal(pub1.deliveryDefaults.hasToken, false);
    assert.equal(pub1.deliveryDefaults.reusableEnvironmentId, legacyEnvId);
    assert.equal(pub1.deliveryDefaults.reusableEnvironmentName, '香港旧环境');
    assert.equal(pub1.environments[0].delivery.hasToken, true);
    assert.equal(pub1.environments[0].delivery.hasCustomToken, true);
    assert.equal(pub1.environments[1].delivery.hasToken, false);
    assert.equal(pub1.environments[1].delivery.hasCustomToken, false);
    assert.equal(pub1.environments[1].delivery.effectiveEndpoint, defaultDeliveryPolicy.endpoint);
    assert.ok(!saveInitial.body.includes('legacy-secret-token'));

    // Unauthenticated adopt-token is rejected
    const unauth = await app.app.inject({
      method: 'POST',
      url: '/api/settings/delivery-defaults/adopt-token',
      payload: { environmentId: legacyEnvId },
    });
    assert.equal(unauth.statusCode, 401);

    // Adopting from environment without token fails cleanly
    const missingToken = await app.app.inject({
      method: 'POST',
      url: '/api/settings/delivery-defaults/adopt-token',
      headers,
      payload: { environmentId: newEnvId },
    });
    assert.equal(missingToken.statusCode, 409);

    // Adopting from legacyEnv populates global default without exposing plaintext
    const adopted = await app.app.inject({
      method: 'POST',
      url: '/api/settings/delivery-defaults/adopt-token',
      headers,
      payload: { environmentId: legacyEnvId },
    });
    assert.equal(adopted.statusCode, 200);
    assert.ok(!adopted.body.includes('legacy-secret-token'));
    const pub2 = adopted.json();
    assert.equal(pub2.deliveryDefaults.hasToken, true);
    assert.equal(pub2.deliveryDefaults.hasSavedToken, true);
    assert.equal(pub2.deliveryDefaults.reusableEnvironmentId, undefined);
    assert.equal(pub2.environments[1].delivery.hasToken, true);
    assert.equal(pub2.environments[1].delivery.hasCustomToken, false);

    // Saving settings without deliveryDefaults (legacy client / saveModel) retains global defaults
    const saveWithoutDefaults = await app.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        threshold: 85,
        paused: true,
        execution: { timeoutSeconds: 300, captureAttempts: 2 },
        model: { endpoint: '', name: 'deepseek-flash' },
        environments: [
          {
            id: newEnvId,
            name: '德国新环境',
            origin: 'https://de.test',
            apiOrigin: 'https://de.test',
            delivery: { ...defaultDeliveryPolicy, enabled: true, endpoint: '' },
          },
        ],
      },
    });
    assert.equal(saveWithoutDefaults.statusCode, 200);
    assert.equal(saveWithoutDefaults.json().deliveryDefaults.hasToken, true);
    assert.equal(app.vault.get().deliveryDefaults?.token, 'legacy-secret-token');

    // Explicit deliveryDefaults update & clearToken
    const cleared = await app.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers,
      payload: {
        threshold: 85,
        paused: true,
        execution: { timeoutSeconds: 300, captureAttempts: 2 },
        deliveryDefaults: { endpoint: 'https://custom-default.test/migrate', clearToken: true },
        model: { endpoint: '', name: 'deepseek-flash' },
        environments: [
          {
            id: newEnvId,
            name: '德国新环境',
            origin: 'https://de.test',
            apiOrigin: 'https://de.test',
            delivery: { ...defaultDeliveryPolicy, enabled: true, endpoint: '' },
          },
        ],
      },
    });
    assert.equal(cleared.statusCode, 200);
    const pub3 = cleared.json();
    assert.equal(pub3.deliveryDefaults.endpoint, 'https://custom-default.test/migrate');
    assert.equal(pub3.deliveryDefaults.hasToken, false);
    assert.equal(pub3.environments[0].delivery.effectiveEndpoint, 'https://custom-default.test/migrate');
  } finally {
    await app.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('queueDelivery and executeDelivery use inherited global default endpoint and token and redact global token on errors', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let mode: 'ok' | 'fail' = 'ok';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/_api/v2/Site/List') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ siteId: '11111111-1111-4111-8111-111111111111', homePageLink: 'https://source-site.test' }]));
      return;
    }
    if (req.url?.startsWith('/migrate')) {
      requests.push({ url: req.url, body });
      if (mode === 'fail') {
        res.statusCode = 502;
        res.end('Upstream rejected token global-secret-migrate-token');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        siteId: '22222222-2222-4222-8222-222222222222',
        siteUrl: 'https://delivered-site.test',
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'delivery-defaults-exec-'));
  const app = await createApp({ directory, serveWeb: false, startWorker: false });
  try {
    const envId = randomUUID();
    app.vault.update({
      threshold: 80,
      paused: true,
      deliveryDefaults: { endpoint: `${origin}/migrate`, token: 'global-secret-migrate-token' },
      model: { endpoint: '', name: 'deepseek-flash' },
      environments: [
        {
          id: envId,
          name: 'DE',
          origin: 'https://de.test',
          apiOrigin: origin,
          token: 'kooboo-token',
          delivery: { ...defaultDeliveryPolicy, enabled: true, endpoint: '', verifyWithAi: false },
        },
      ],
    });
    const resource = app.automationStore.saveResource({
      name: 'Demo',
      scenario: 'migration',
      description: 'Migrate',
      contentUrl: 'https://source.test',
      referenceUrl: '',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const version = app.automationStore.versions(resource.id)[0];
    const siteId = randomUUID();
    app.automationStore.saveSite({
      id: siteId,
      resourceId: resource.id,
      versionId: version.id,
      environmentId: envId,
      siteId: '11111111-1111-4111-8111-111111111111',
      name: 'demo',
      url: 'https://source-site.test',
      createdAt: Date.now(),
    });
    const [evalTask] = app.automationStore.create(
      { kind: 'evaluation', resourceIds: [resource.id], scope: 'site', environmentId: envId, generatedSiteId: siteId, requirements: '' },
      defaultAutomationSettings,
    );
    evalTask.status = 'completed';
    evalTask.stopped = true;
    evalTask.report = passedReport();
    app.automationStore.put(evalTask);

    const queued = queueDelivery(evalTask, app.automationStore, app.vault);
    assert.equal(queued.delivery?.policy.endpoint, `${origin}/migrate`);

    // Failure redacts global default token
    mode = 'fail';
    await executeDelivery(queued, app.automationStore, app.vault, directory, AbortSignal.timeout(5000), async () => {});
    const failedTask = app.automationStore.task(evalTask.id)!;
    assert.equal(failedTask.delivery?.status, 'uncertain');
    assert.ok(!failedTask.delivery?.error.includes('global-secret-migrate-token'));
    for (const ev of app.automationStore.events(evalTask.id)) {
      assert.ok(!ev.message.includes('global-secret-migrate-token'));
    }

    // Success sends inherited global default token to inherited endpoint
    mode = 'ok';
    failedTask.delivery!.attemptedAt = undefined;
    failedTask.delivery!.status = 'queued';
    app.automationStore.put(failedTask);
    let verifiedTarget = '';
    await executeDelivery(failedTask, app.automationStore, app.vault, directory, AbortSignal.timeout(5000), async (task) => {
      verifiedTarget = task.delivery?.target?.siteUrl || '';
      task.delivery!.status = 'completed';
      app.automationStore.put(task);
    });
    assert.equal(requests.at(-1)?.body.token, 'global-secret-migrate-token');
    assert.equal(requests.at(-1)?.body.siteUrl, 'https://source-site.test');
    assert.equal(verifiedTarget, 'https://delivered-site.test');
  } finally {
    await app.app.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
