import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { deriveHumanNotice } from '../shared/human-diagnostics.js';
import { executeGeneration } from '../server/automation/generator.js';
import { FollowupRuntimeError, Pending } from '../server/automation/errors.js';
import { settingsSchema } from '../server/lib/validation.js';
import { Vault } from '../server/lib/vault.js';

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

const passPreflight = {
  preflightReference: async (url: string) => ({ ok: true as const, url, finalUrl: url, status: 200, method: 'http' as const }),
};

function mockGenerationSession(
  taskId: string,
  siteIdRef: () => string,
): typeof import('../server/automation/generation-session.js').generationSession {
  return async () => {
    const conversationId = randomUUID();
    const runId = 'run-' + randomUUID().slice(0, 8);
    let sentId = '';
    return {
      snapshot: async () => ({
        version: 1,
        taskId,
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
        return { id: input.id, state: 'accepted', conversationId };
      },
      close: async () => {},
    };
  };
}

interface MockKoobooOptions {
  domainName: string;
  pages?: number;
  deleteStatus?: number;
  singleSyncFail?: boolean;
  sandboxUnsupported?: boolean;
  sandboxPages?: number;
  templateId?: string;
}

function startMockKooboo(opts: MockKoobooOptions) {
  const calls: Array<{ path: string; siteId: string | null; body: any }> = [];
  const siteId = randomUUID();
  const sandboxSiteId = randomUUID();
  const byLevelTaskId = 'bylevel-' + randomUUID().slice(0, 8);
  const singleTaskId = 'single-' + randomUUID().slice(0, 8);
  const sandboxTaskId = 'sandbox-' + randomUUID().slice(0, 8);
  let origin = '';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Generated OK</h1></body></html>');
      return;
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const siteIdParam = url.searchParams.get('SiteId');
    calls.push({ path: url.pathname, siteId: siteIdParam, body });
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/_api/v2/User/CheckLogin') return res.end(JSON.stringify(true));
    if (url.pathname === '/_api/v2/Domain/Available') {
      return res.end(JSON.stringify([{ domainName: opts.domainName, sudDomainUseDash: true }]));
    }
    if (url.pathname === '/_api/v2/Site/CheckUniqueName' || url.pathname === '/_api/v2/Site/IsUniqueName' || url.pathname === '/_api/v2/Site/IsSubdomainAvailable') {
      return res.end('null');
    }
    if (url.pathname === '/_api/v2/Site/List') {
      return res.end(JSON.stringify([{ siteId, name: 'auto', homePageLink: `${origin}/` }]));
    }
    if (url.pathname === '/_api/v2/Site/Delete') {
      const code = opts.deleteStatus ?? 200;
      res.statusCode = code;
      return res.end(JSON.stringify(code === 200));
    }
    if (url.pathname === '/_api/v2/Template/Detail' || url.pathname === '/_api/v2/Template/Get') {
      return res.end(JSON.stringify({
        id: opts.templateId || 'tpl-1',
        name: 'TestTemplate',
        previewUrl: `${origin}/tpl-preview`,
      }));
    }
    if (url.pathname === '/_api/v2/Template/Use' || url.pathname === '/_api/v2/Site/Create') {
      return res.end(JSON.stringify({ siteId }));
    }
    if (url.pathname === '/_api/v2/AI/CallFunction') {
      const code = String(body?.arguments?.code || '');
      const match = code.match(/var files=(\[[\s\S]*\]);\s*for\(var i=0;/);
      const count = match ? (JSON.parse(match[1]!) as unknown[]).length : 1;
      return res.end(JSON.stringify({ contents: [{ isError: false, result: { ok: true, count } }] }));
    }
    if (url.pathname === '/_api/v2/AISandbox/TransferByLevel') {
      if (opts.sandboxUnsupported) {
        res.statusCode = 400;
        return res.end(JSON.stringify(['Api method Not Found']));
      }
      if (req.method === 'GET') {
        res.statusCode = 400;
        return res.end(JSON.stringify(['missing params']));
      }
      return res.end(JSON.stringify({
        sandbox: 'src-sandbox',
        siteId: sandboxSiteId,
        previewUrl: `${origin}/src-sandbox`,
        taskId: sandboxTaskId,
      }));
    }
    if (url.pathname === '/_api/v2/Transfer/ByLevel') {
      return res.end(JSON.stringify({ siteId, taskId: byLevelTaskId }));
    }
    if (url.pathname === '/_api/v2/Transfer/Single') {
      if (opts.singleSyncFail) {
        return res.end(JSON.stringify({
          taskId: singleTaskId,
          finish: true,
          success: false,
          messages: ['no page downloaded'],
        }));
      }
      return res.end(JSON.stringify({ taskId: singleTaskId, finish: false, success: false }));
    }
    if (url.pathname === '/_api/v2/Transfer/GetStatus') {
      const id = url.searchParams.get('id');
      if (id === sandboxTaskId) {
        const n = opts.sandboxPages ?? opts.pages ?? 0;
        return res.end(JSON.stringify(n > 0 ? [{ url: 'https://source.test/', done: true }] : []));
      }
      const n = opts.pages ?? 0;
      return res.end(JSON.stringify(n > 0 ? [{ url: 'https://source.test/', done: true }] : []));
    }
    if (url.pathname === '/_api/v2/Transfer/GetTaskStatus') {
      const n = siteIdParam === sandboxSiteId ? (opts.sandboxPages ?? opts.pages ?? 0) : (opts.pages ?? 0);
      return res.end(JSON.stringify({ done: true, pages: n }));
    }
    res.end('true');
  });

  return {
    server,
    siteId,
    sandboxSiteId,
    singleTaskId,
    calls,
    async start() {
      origin = await listen(server);
      return origin;
    },
  };
}

test('settingsSchema and Vault validate, persist, preserve, and clear cloneFallbackEnvironmentId', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-fallback-'));
  try {
    const vault = new Vault(dir);
    const hkId = randomUUID();
    const deId = randomUUID();
    const missingId = randomUUID();

    // Reject self-reference
    assert.throws(
      () =>
        settingsSchema.parse({
          threshold: 80,
          paused: false,
          model: { endpoint: '', name: '' },
          environments: [
            { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test', cloneFallbackEnvironmentId: hkId },
          ],
        }),
      /不能指向当前环境自身/,
    );

    // Reject non-existent target
    assert.throws(
      () =>
        settingsSchema.parse({
          threshold: 80,
          paused: false,
          model: { endpoint: '', name: '' },
          environments: [
            { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test', cloneFallbackEnvironmentId: missingId },
          ],
        }),
      /回退环境不存在/,
    );

    // Reject cycle A -> B -> A
    assert.throws(
      () =>
        settingsSchema.parse({
          threshold: 80,
          paused: false,
          model: { endpoint: '', name: '' },
          environments: [
            { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test', cloneFallbackEnvironmentId: deId },
            { id: deId, name: 'DE', origin: 'https://de.test', apiOrigin: 'https://de.test', cloneFallbackEnvironmentId: hkId },
          ],
        }),
      /循环引用/,
    );

    // Save valid HK -> DE
    vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: '', name: '' },
      environments: [
        { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test', token: 'hk-tok', cloneFallbackEnvironmentId: deId },
        { id: deId, name: 'DE', origin: 'https://de.test', apiOrigin: 'https://de.test', token: 'de-tok' },
      ],
    });
    assert.equal(vault.public().environments.find((e) => e.id === hkId)?.cloneFallbackEnvironmentId, deId);

    // Omitting cloneFallbackEnvironmentId preserves existing value (matches automation/SettingsView model save)
    vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: '', name: '' },
      environments: [
        { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test' },
        { id: deId, name: 'DE', origin: 'https://de.test', apiOrigin: 'https://de.test' },
      ],
    });
    assert.equal(vault.get().environments.find((e) => e.id === hkId)?.cloneFallbackEnvironmentId, deId);

    // Passing '' explicitly clears cloneFallbackEnvironmentId
    vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: '', name: '' },
      environments: [
        { id: hkId, name: 'HK', origin: 'https://hk.test', apiOrigin: 'https://hk.test', cloneFallbackEnvironmentId: '' },
        { id: deId, name: 'DE', origin: 'https://de.test', apiOrigin: 'https://de.test' },
      ],
    });
    assert.equal(vault.get().environments.find((e) => e.id === hkId)?.cloneFallbackEnvironmentId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh upgrade task falls back from HK to DE on 0-page clone, deletes HK site, and skips polling synchronous Transfer/Single failure', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, singleSyncFail: true });
  const de = startMockKooboo({ domainName: '-de.kooboo.io', pages: 2 });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-fresh-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: '香港 kooboo', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', defaultRootDomain: '-hk.kooboo.io', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: '德国 kooboo', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok', defaultRootDomain: '-de.kooboo.io' },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Kinetic Awareness',
      scenario: 'upgrade',
      description: 'Upgrade fallback test',
      contentUrl: 'https://kineticawareness.nl/',
      referenceUrl: 'https://ref.example.test',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, defaultRootDomain: '-hk.kooboo.io', requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task.autonomy;
    task.requirementsEnabled = false;
    task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task);

    await executeGeneration(
      task,
      f.automationStore,
      f.vault,
      directory,
      AbortSignal.timeout(10000),
      mockGenerationSession(task.id, () => de.siteId),
      passPreflight,
    );

    const saved = f.automationStore.task(task.id)!;
    assert.equal(saved.environmentId, deEnvId);
    assert.equal(saved.generation?.rootDomain, '-de.kooboo.io');
    assert.equal(saved.generation?.cloneEnvironmentFallback?.fromEnvironmentId, hkEnvId);
    assert.equal(saved.generation?.cloneEnvironmentFallback?.toEnvironmentId, deEnvId);
    assert.equal(saved.generation?.cloneEnvironmentFallback?.abandonedSiteId, hk.siteId);
    assert.equal(saved.generation?.cloneEnvironmentFallback?.abandonedRemoteDeleted, true);
    assert.deepEqual(saved.generation?.attemptedEnvironmentIds, [hkEnvId, deEnvId]);

    // HK local site deleted, DE local site bound
    assert.equal(f.automationStore.sites(res.id).length, 1);
    assert.equal(f.automationStore.site(saved.generatedSiteId!)?.environmentId, deEnvId);
    assert.equal(f.automationStore.site(saved.generatedSiteId!)?.siteId, de.siteId);

    // HK Site/Delete called, DE Transfer/ByLevel used DE rootDomain, and Transfer/Single sync failure was NOT polled via GetStatus
    assert.ok(hk.calls.some((c) => c.path === '/_api/v2/Site/Delete' && c.siteId === hk.siteId));
    assert.ok(!hk.calls.some((c) => c.path === '/_api/v2/Transfer/GetStatus' && c.siteId === hk.siteId && c.body === undefined && JSON.stringify(c).includes(hk.singleTaskId)));
    const deByLevel = de.calls.find((c) => c.path === '/_api/v2/Transfer/ByLevel');
    assert.equal(deByLevel?.body?.rootDomain, '-de.kooboo.io');

    const events = f.automationStore.events(task.id).map((e) => e.message);
    assert.ok(events.some((m) => m.includes('已自动切换至回退环境「德国 kooboo」')));
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});

test('remote Site/Delete HTTP 500 still unbinds local HK site and completes on DE', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, singleSyncFail: true, deleteStatus: 500 });
  const de = startMockKooboo({ domainName: '-de.kooboo.io', pages: 2 });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-del500-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: 'HK', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: 'DE', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok' },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Delete 500 Test',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task.autonomy;
    task.requirementsEnabled = false;
    task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task);

    await executeGeneration(task, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), mockGenerationSession(task.id, () => de.siteId), passPreflight);

    const saved = f.automationStore.task(task.id)!;
    assert.equal(saved.environmentId, deEnvId);
    assert.equal(saved.generation?.cloneEnvironmentFallback?.abandonedRemoteDeleted, false);
    assert.equal(f.automationStore.sites(res.id).length, 1);
    const events = f.automationStore.events(task.id).map((e) => e.message);
    assert.ok(events.some((m) => m.includes('自动清理失败')));
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});

test('both HK and DE returning 0 pages interrupts cleanly with source-access without looping', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, singleSyncFail: true });
  const de = startMockKooboo({ domainName: '-de.kooboo.io', pages: 0, singleSyncFail: true });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-both0-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: 'HK', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: 'DE', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok' },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Both Fail Test',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task.autonomy;
    task.requirementsEnabled = false;
    task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task);

    await assert.rejects(
      executeGeneration(task, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), undefined, passPreflight),
      (err: unknown) =>
        err instanceof FollowupRuntimeError &&
        err.userSummary?.category === 'source-access' &&
        err.message.includes('原环境与回退环境重试后仍无法获取源站页面'),
    );

    const saved = f.automationStore.task(task.id)!;
    assert.equal(saved.environmentId, deEnvId);
    assert.equal(hk.calls.filter((c) => c.path === '/_api/v2/Transfer/ByLevel').length, 1);
    assert.equal(de.calls.filter((c) => c.path === '/_api/v2/Transfer/ByLevel').length, 1);
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});

test('POST /resume on already-interrupted HK task switches to DE when HK still has 0 pages, or stays on HK if manually imported', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, singleSyncFail: true });
  const de = startMockKooboo({ domainName: '-de.kooboo.io', pages: 2 });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-resume-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: '香港 kooboo', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: '德国 kooboo', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok' },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Interrupted Resume Test',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });

    // Case A: Pre-existing interrupted HK task (where transferFallbackAttempted was already attempted before HK -> DE fallback was configured)
    // Resume preserves transferFallbackAttempted, skips redundant HK Transfer/Single, and switches to DE
    const taskInterrupted = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete taskInterrupted.autonomy;
    taskInterrupted.requirementsEnabled = false;
    taskInterrupted.learningPolicy = { ...taskInterrupted.learningPolicy!, use: false, collect: false };
    const hkLocalSite = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: taskInterrupted.versionId,
      environmentId: hkEnvId,
      siteId: hk.siteId,
      name: 'old_hk_site',
      url: '',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(hkLocalSite);
    taskInterrupted.generatedSiteId = hkLocalSite.id;
    taskInterrupted.generation = {
      siteName: 'old_hk_site',
      subDomain: 'old_hk_site',
      rootDomain: 'hk.kooboo.io',
      createAttempted: true,
      transferTaskId: 'old-transfer-1',
      transferFallbackAttempted: true,
    };
    f.automationStore.interrupt(taskInterrupted, {
      reason: 'pages=0',
      evidence: [],
      attempted: [],
      nextSteps: ['核查'],
      resumeFrom: 'resume',
      userSummary: deriveHumanNotice({ reason: 'pages=0 transferTaskId', stage: 'generation', generatedSiteId: hkLocalSite.id }),
    });

    const hkSinglesBefore = hk.calls.filter((c) => c.path === '/_api/v2/Transfer/Single').length;
    const resumeA = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${taskInterrupted.id}/resume`, headers, payload: {} });
    assert.equal(resumeA.statusCode, 200);
    const resumedA = f.automationStore.task(taskInterrupted.id)!;
    assert.equal(resumedA.generation?.transferFallbackAttempted, true);

    await executeGeneration(resumedA, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), mockGenerationSession(resumedA.id, () => de.siteId), passPreflight);
    assert.equal(f.automationStore.task(taskInterrupted.id)?.environmentId, deEnvId);
    assert.equal(hk.calls.filter((c) => c.path === '/_api/v2/Transfer/Single').length, hkSinglesBefore, 'should skip redundant HK Transfer/Single');

    // Case B: User manually imported pages on HK -> Transfer/GetTaskStatus returns pages=1 -> stays on HK
    const hkReady = startMockKooboo({ domainName: '-hk2.kooboo.io', pages: 1 });
    const hkReadyOrigin = await hkReady.start();
    try {
      const hkEnv2 = randomUUID();
      f.vault.update({
        threshold: 80,
        paused: true,
        model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
        environments: [
          { id: hkEnv2, name: 'HK2', origin: hkReadyOrigin, apiOrigin: hkReadyOrigin, token: 'hk2-tok', cloneFallbackEnvironmentId: deEnvId },
          { id: deEnvId, name: '德国 kooboo', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok' },
        ],
      });
      const taskManual = f.automationStore.create(
        { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnv2, requirements: '' },
        defaultAutomationSettings,
      )[0];
      delete taskManual.autonomy;
      taskManual.requirementsEnabled = false;
      taskManual.learningPolicy = { ...taskManual.learningPolicy!, use: false, collect: false };
      const hkLocalSite2 = {
        id: randomUUID(),
        resourceId: res.id,
        versionId: taskManual.versionId,
        environmentId: hkEnv2,
        siteId: hkReady.siteId,
        name: 'manual_hk_site',
        url: '',
        createdAt: Date.now(),
      };
      f.automationStore.saveSite(hkLocalSite2);
      taskManual.generatedSiteId = hkLocalSite2.id;
      taskManual.generation = {
        siteName: 'manual_hk_site',
        subDomain: 'manual_hk_site',
        rootDomain: 'hk2.kooboo.io',
        createAttempted: true,
        transferTaskId: 'old-transfer-2',
        transferFallbackAttempted: true,
      };
      f.automationStore.interrupt(taskManual, {
        reason: 'pages=0',
        evidence: [],
        attempted: [],
        nextSteps: ['核查'],
        resumeFrom: 'resume',
        userSummary: deriveHumanNotice({ reason: 'pages=0 transferTaskId', stage: 'generation', generatedSiteId: hkLocalSite2.id }),
      });

      const resumeB = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${taskManual.id}/resume`, headers, payload: {} });
      assert.equal(resumeB.statusCode, 200);
      await executeGeneration(f.automationStore.task(taskManual.id)!, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), mockGenerationSession(taskManual.id, () => hkReady.siteId), passPreflight);

      assert.equal(f.automationStore.task(taskManual.id)?.environmentId, hkEnv2);
      assert.equal(f.automationStore.task(taskManual.id)?.generatedSiteId, hkLocalSite2.id);
      assert.ok(!hkReady.calls.some((c) => c.path === '/_api/v2/Site/Delete'));
    } finally {
      await closeServer(hkReady.server);
    }
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});

test('never deletes or switches environment when site is shared with another task', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, singleSyncFail: true });
  const de = startMockKooboo({ domainName: '-de.kooboo.io', pages: 2 });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-shared-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: 'HK', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: 'DE', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok' },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Shared Site Test',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const sharedSite = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: f.automationStore.versions(res.id)[0]!.id,
      environmentId: hkEnvId,
      siteId: hk.siteId,
      name: 'shared_site',
      url: '',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(sharedSite);

    const task1 = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, generatedSiteId: sharedSite.id, requirements: '' },
      defaultAutomationSettings,
    )[0];
    const task2 = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, generatedSiteId: sharedSite.id, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task1.autonomy;
    task1.requirementsEnabled = false;
    task1.learningPolicy = { ...task1.learningPolicy!, use: false, collect: false };
    task1.generation = { transferTaskId: 'shared-transfer-1' };
    f.automationStore.put(task1);
    assert.ok(task2.id);

    await assert.rejects(
      executeGeneration(task1, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), undefined, passPreflight),
      (err: unknown) => err instanceof FollowupRuntimeError && err.userSummary?.category === 'source-access',
    );
    assert.equal(f.automationStore.task(task1.id)?.environmentId, hkEnvId);
    assert.ok(f.automationStore.site(sharedSite.id));
    assert.ok(!hk.calls.some((c) => c.path === '/_api/v2/Site/Delete'));
    assert.equal(de.calls.length, 0);
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});

test('direct-template upgrade switches from HK to DE when DE supports AISandbox/TransferByLevel, and stays on HK if DE lacks capability', async () => {
  const hk = startMockKooboo({ domainName: '-hk.kooboo.io', pages: 0, sandboxPages: 0, templateId: 'tpl-1' });
  const deSupported = startMockKooboo({ domainName: '-de1.kooboo.io', pages: 2, sandboxPages: 2, templateId: 'tpl-1' });
  const deUnsupported = startMockKooboo({ domainName: '-de2.kooboo.io', pages: 2, sandboxUnsupported: true, templateId: 'tpl-1' });
  const hkOrigin = await hk.start();
  const deSupOrigin = await deSupported.start();
  const deUnsupOrigin = await deUnsupported.start();
  const directory = mkdtempSync(join(tmpdir(), 'clone-fb-tpl-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const hkEnvId = randomUUID();
  const deSupId = randomUUID();
  const deUnsupId = randomUUID();

  try {
    // 1. Supported DE: switches from HK -> DE and completes
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: 'HK', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deSupId },
        { id: deSupId, name: 'DE-OK', origin: deSupOrigin, apiOrigin: deSupOrigin, token: 'de-tok' },
        { id: deUnsupId, name: 'DE-Old', origin: deUnsupOrigin, apiOrigin: deUnsupOrigin, token: 'de2-tok' },
      ],
    });
    const res1 = f.automationStore.saveResource({
      name: 'Direct Template Upgrade OK',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: '',
      referenceTemplateId: 'tpl-1',
      referenceTemplateName: 'TestTemplate',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task1 = f.automationStore.create(
      { resourceIds: [res1.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task1.autonomy;
    task1.requirementsEnabled = false;
    task1.learningPolicy = { ...task1.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task1);

    await executeGeneration(task1, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), mockGenerationSession(task1.id, () => deSupported.siteId));
    assert.equal(f.automationStore.task(task1.id)?.environmentId, deSupId);
    assert.ok(hk.calls.some((c) => c.path === '/_api/v2/Site/Delete' && c.siteId === hk.siteId));

    // 2. Unsupported DE: refuses switch, preserves HK site
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: 'HK', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', cloneFallbackEnvironmentId: deUnsupId },
        { id: deSupId, name: 'DE-OK', origin: deSupOrigin, apiOrigin: deSupOrigin, token: 'de-tok' },
        { id: deUnsupId, name: 'DE-Old', origin: deUnsupOrigin, apiOrigin: deUnsupOrigin, token: 'de2-tok' },
      ],
    });
    const hkDeletesBefore = hk.calls.filter((c) => c.path === '/_api/v2/Site/Delete').length;
    const task2 = f.automationStore.create(
      { resourceIds: [res1.id], kind: 'generation', scope: 'homepage', environmentId: hkEnvId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task2.autonomy;
    task2.requirementsEnabled = false;
    task2.learningPolicy = { ...task2.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task2);

    await assert.rejects(
      executeGeneration(task2, f.automationStore, f.vault, directory, AbortSignal.timeout(10000)),
      (err: unknown) => err instanceof FollowupRuntimeError && err.userSummary?.category === 'source-access',
    );
    const saved2 = f.automationStore.task(task2.id)!;
    assert.equal(saved2.environmentId, hkEnvId);
    assert.ok(saved2.generatedSiteId);
    assert.equal(hk.calls.filter((c) => c.path === '/_api/v2/Site/Delete').length, hkDeletesBefore, 'should not delete HK site when DE preflight fails');
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(deSupported.server);
    await closeServer(deUnsupported.server);
  }
});

test('site-creation failure records HTTP status and Kooboo error body in task events and Pending error', async () => {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/_api/v2/User/CheckLogin') return res.end(JSON.stringify(true));
    if (url.pathname === '/_api/v2/Domain/Available') {
      return res.end(JSON.stringify([{ domainName: 'localkooboo.com', sudDomainUseDash: false }]));
    }
    if (url.pathname === '/_api/v2/Site/IsUniqueName' || url.pathname === '/_api/v2/Site/IsSubdomainAvailable') {
      return res.end('null');
    }
    if (url.pathname === '/_api/v2/Transfer/ByLevel') {
      res.statusCode = 400;
      return res.end(JSON.stringify(['Connection refused (127.0.0.1:81)']));
    }
    res.end('true');
  });

  const origin = await listen(server);
  const directory = mkdtempSync(join(tmpdir(), 'site-create-err-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const envId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [{ id: envId, name: 'Local', origin, apiOrigin: origin, token: 'local-tok' }],
    });
    const res = f.automationStore.saveResource({
      name: 'Create Error Detail Test',
      scenario: 'upgrade',
      description: '',
      contentUrl: 'https://source.test/',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: envId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    delete task.autonomy;
    task.requirementsEnabled = false;
    task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
    f.automationStore.put(task);

    await assert.rejects(
      executeGeneration(task, f.automationStore, f.vault, directory, AbortSignal.timeout(10000), undefined, passPreflight),
      (err: unknown) =>
        err instanceof Pending &&
        err.message.includes('Kooboo Transfer/ByLevel 请求失败（400）：Connection refused (127.0.0.1:81)'),
    );

    const events = f.automationStore.events(task.id).map((e) => e.message);
    assert.ok(
      events.some((m) => m.includes('建站请求异常') && m.includes('Kooboo Transfer/ByLevel 请求失败（400）：Connection refused (127.0.0.1:81)')),
      'expected 建站请求异常 event with Kooboo error detail',
    );
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('POST /api/automation/tasks enforces priority: explicit skipSourceTransfer bypasses clone & fallback routing; fallbackToMaterialsOnCloneFailure degrades after HK -> DE 0-page clone', async () => {
  const hk = startMockKooboo({ domainName: 'hk.kooboo.io', pages: 0, singleSyncFail: true });
  const de = startMockKooboo({ domainName: 'de.kooboo.io', pages: 0, singleSyncFail: true });
  const hkOrigin = await hk.start();
  const deOrigin = await de.start();
  const directory = mkdtempSync(join(tmpdir(), 'skip-vs-fallback-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const hkEnvId = randomUUID();
  const deEnvId = randomUUID();

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        { id: hkEnvId, name: '香港 kooboo', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', defaultRootDomain: 'hk.kooboo.io', cloneFallbackEnvironmentId: deEnvId },
        { id: deEnvId, name: '德国 kooboo', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok', defaultRootDomain: 'de.kooboo.io' },
      ],
    });

    // Upload a material file for the upgrade resource
    const fileRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/files',
      headers,
      payload: {
        name: 'README.md',
        type: 'text/markdown',
        content: Buffer.from('# De Friese Schaar Facts\nPhone: +31 58 212 3456', 'utf8').toString('base64'),
      },
    });
    assert.equal(fileRes.statusCode, 201);
    const uploadedFile = fileRes.json();

    const res = f.automationStore.saveResource({
      name: 'Priority Hierarchy Upgrade',
      scenario: 'upgrade',
      description: 'Upgrade with materials',
      contentUrl: 'http://www.defrieseschaar.nl',
      referenceUrl: 'https://ref.test/',
      externalSource: '',
      externalId: '',
      files: [uploadedFile],
    });

    // 1. Priority 1: Explicit skipSourceTransfer=true at task creation
    // Uses Site/Create directly on HK, never calls Transfer/ByLevel, never routes to DE
    const createSkipRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/tasks',
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      payload: {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: hkEnvId,
        skipSourceTransfer: true,
      },
    });
    assert.equal(createSkipRes.statusCode, 201, createSkipRes.body);
    const skipTaskId = createSkipRes.json().items[0].id as string;
    const skipTask = f.automationStore.task(skipTaskId)!;
    assert.equal(skipTask.generation?.skipSourceTransfer, true);
    assert.match(skipTask.message, /已显式配置跳过原站克隆/);
    delete skipTask.autonomy;
    skipTask.requirementsEnabled = false;
    skipTask.learningPolicy = { ...skipTask.learningPolicy!, use: false, collect: false };
    f.automationStore.put(skipTask);

    await executeGeneration(
      skipTask,
      f.automationStore,
      f.vault,
      directory,
      AbortSignal.timeout(10000),
      mockGenerationSession(skipTask.id, () => hk.siteId),
      passPreflight,
    );

    const savedSkip = f.automationStore.task(skipTaskId)!;
    assert.equal(savedSkip.environmentId, hkEnvId, 'explicit skipSourceTransfer must stay on primary environment');
    assert.equal(savedSkip.generation?.transferComplete, true);
    assert.equal(savedSkip.generation?.cloneEnvironmentFallback, undefined);
    assert.equal(hk.calls.filter((c) => c.path === '/_api/v2/Site/Create').length, 1);
    assert.equal(hk.calls.filter((c) => c.path === '/_api/v2/Transfer/ByLevel').length, 0);
    assert.equal(de.calls.length, 0);

    // 2. Priority 2 & 3: skipSourceTransfer not checked, fallbackToMaterialsOnCloneFailure=true
    // Tries HK2 clone (0 pages) -> routes to DE clone (0 pages) -> automatically degrades to skipSourceTransfer with material package
    const hk2 = startMockKooboo({ domainName: 'hk2.kooboo.io', pages: 0, singleSyncFail: true });
    const hk2Origin = await hk2.start();
    const hk2EnvId = randomUUID();
    try {
      f.vault.update({
        threshold: 80,
        paused: true,
        model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
        environments: [
          { id: hkEnvId, name: '香港 kooboo', origin: hkOrigin, apiOrigin: hkOrigin, token: 'hk-tok', defaultRootDomain: 'hk.kooboo.io', cloneFallbackEnvironmentId: deEnvId },
          { id: hk2EnvId, name: '香港2 kooboo', origin: hk2Origin, apiOrigin: hk2Origin, token: 'hk2-tok', defaultRootDomain: 'hk2.kooboo.io', cloneFallbackEnvironmentId: deEnvId },
          { id: deEnvId, name: '德国 kooboo', origin: deOrigin, apiOrigin: deOrigin, token: 'de-tok', defaultRootDomain: 'de.kooboo.io' },
        ],
      });
      const res2 = f.automationStore.saveResource({
        name: 'Fallback Then Materials Upgrade',
        scenario: 'upgrade',
        description: 'Upgrade with materials fallback',
        contentUrl: 'http://www.defrieseschaar.nl',
        referenceUrl: 'https://ref.test/',
        externalSource: '',
        externalId: '',
        files: [uploadedFile],
      });
      const createDegradeRes = await f.app.inject({
        method: 'POST',
        url: '/api/automation/tasks',
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        payload: {
          resourceIds: [res2.id],
          kind: 'generation',
          scope: 'homepage',
          environmentId: hk2EnvId,
          fallbackToMaterialsOnCloneFailure: true,
        },
      });
      assert.equal(createDegradeRes.statusCode, 201, createDegradeRes.body);
      const degradeTaskId = createDegradeRes.json().items[0].id as string;
      const degradeTask = f.automationStore.task(degradeTaskId)!;
      assert.equal(degradeTask.generation?.fallbackToMaterialsOnCloneFailure, true);
      assert.equal(degradeTask.generation?.skipSourceTransfer, undefined);
      delete degradeTask.autonomy;
      degradeTask.requirementsEnabled = false;
      degradeTask.learningPolicy = { ...degradeTask.learningPolicy!, use: false, collect: false };
      f.automationStore.put(degradeTask);

      await executeGeneration(
        degradeTask,
        f.automationStore,
        f.vault,
        directory,
        AbortSignal.timeout(10000),
        mockGenerationSession(degradeTask.id, () => de.siteId),
        passPreflight,
      );

      const savedDegrade = f.automationStore.task(degradeTaskId)!;
      assert.equal(savedDegrade.environmentId, deEnvId, 'should route to DE first before degrading to materials');
      assert.equal(savedDegrade.generation?.cloneEnvironmentFallback?.fromEnvironmentId, hk2EnvId);
      assert.equal(savedDegrade.generation?.cloneEnvironmentFallback?.toEnvironmentId, deEnvId);
      assert.equal(savedDegrade.generation?.skipSourceTransfer, true, 'should auto-degrade to skipSourceTransfer after DE also returns 0 pages');
      assert.equal(savedDegrade.generation?.transferComplete, true);
      const degradeEvents = f.automationStore.events(degradeTaskId).map((e) => e.message);
      assert.ok(degradeEvents.some((m) => m.includes('已自动切换至回退环境「德国 kooboo」')));
      assert.ok(degradeEvents.some((m) => m.includes('已按配置自动转为跳过原站克隆，改用随附资料包')));
    } finally {
      await closeServer(hk2.server);
    }
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(hk.server);
    await closeServer(de.server);
  }
});
