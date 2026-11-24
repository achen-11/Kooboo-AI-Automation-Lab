import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { executeGeneration } from '../server/automation/generator.js';
import { FollowupRuntimeError } from '../server/automation/errors.js';
import { checkReferenceUrlPreflight, classifyHtmlReferenceSignals } from '../server/automation/reference-preflight.js';
import { applySupplementBatch, buildSupplementContext, createSupplementBatch, SupplementStore } from '../server/automation/supplement.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function createTestApp(koobooOrigin = 'https://kooboo.test') {
  const directory = mkdtempSync(join(tmpdir(), 'ref-preflight-test-'));
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

test('classifyHtmlReferenceSignals identifies normal pages, WAF/Cloudflare challenges, HTTP errors, login walls and blank shells', () => {
  assert.deepEqual(
    classifyHtmlReferenceSignals({
      url: 'https://ref.test/',
      status: 200,
      title: 'Modern Art Gallery',
      visibleText: 'A'.repeat(200),
      visibleElementCount: 12,
    }),
    { ok: true },
  );

  const cfHeader = classifyHtmlReferenceSignals({
    url: 'https://ref.test/',
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    title: 'Just a moment...',
    visibleText: 'Checking your browser before accessing ref.test',
  });
  assert.equal(cfHeader.ok, false);
  if (!cfHeader.ok) assert.equal(cfHeader.reasonCode, 'challenge_or_waf');

  const captchaPage = classifyHtmlReferenceSignals({
    url: 'https://ref.test/',
    status: 200,
    title: 'Security Check',
    visibleText: 'Please verify you are human to continue.',
  });
  assert.equal(captchaPage.ok, false);
  if (!captchaPage.ok) assert.equal(captchaPage.reasonCode, 'challenge_or_waf');

  const http403 = classifyHtmlReferenceSignals({
    url: 'https://ref.test/',
    status: 403,
    title: 'Forbidden',
    visibleText: 'Forbidden',
  });
  assert.equal(http403.ok, false);
  if (!http403.ok) assert.equal(http403.reasonCode, 'http_error');

  const loginWall = classifyHtmlReferenceSignals({
    url: 'https://ref.test/',
    finalUrl: 'https://ref.test/login',
    status: 200,
    title: 'Sign in',
    visibleText: 'Sign in to continue',
    hasPasswordInput: true,
  });
  assert.equal(loginWall.ok, false);
  if (!loginWall.ok) assert.equal(loginWall.reasonCode, 'login_required');

  const blankShell = classifyHtmlReferenceSignals({
    url: 'https://ref.test/',
    status: 200,
    title: 'App',
    visibleText: '',
    visibleElementCount: 1,
  });
  assert.equal(blankShell.ok, false);
  if (!blankShell.ok) assert.equal(blankShell.reasonCode, 'blank_page');
});

test('checkReferenceUrlPreflight passes fast HTTP pages, fails fast on 404/500, and escalates 403/thin SPA shells to browser check', async () => {
  let renderCalled = 0;
  const okResult = await checkReferenceUrlPreflight('https://good.test/', AbortSignal.timeout(3000), {
    fetcher: async () =>
      new Response(`<html><head><title>Gallery</title></head><body><main>${'Art gallery content '.repeat(12)}</main></body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    renderCheck: async () => {
      renderCalled++;
      throw new Error('should not spawn browser');
    },
  });
  assert.equal(okResult.ok, true);
  if (okResult.ok) assert.equal(okResult.method, 'http');
  assert.equal(renderCalled, 0);

  const notFound = await checkReferenceUrlPreflight('https://missing.test/', AbortSignal.timeout(3000), {
    fetcher: async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } }),
    renderCheck: async () => {
      renderCalled++;
      throw new Error('should not spawn browser on 404');
    },
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.reasonCode, 'http_error');
  assert.equal(renderCalled, 0);

  const spaPass = await checkReferenceUrlPreflight('https://spa.test/', AbortSignal.timeout(3000), {
    fetcher: async () => new Response('<html><body><div id="app"></div></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    renderCheck: async url => {
      renderCalled++;
      return {
        finalUrl: url,
        status: 200,
        title: 'SPA Loaded',
        visibleText: 'Rendered hero heading and sections',
        visibleElementCount: 8,
        hasPasswordInput: false,
      };
    },
  });
  assert.equal(spaPass.ok, true);
  if (spaPass.ok) assert.equal(spaPass.method, 'browser');
  assert.equal(renderCalled, 1);

  const wafFail = await checkReferenceUrlPreflight('https://waf.test/', AbortSignal.timeout(3000), {
    fetcher: async () =>
      new Response('<html><title>Just a moment...</title><body>Checking your browser</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
      }),
    renderCheck: async url => {
      renderCalled++;
      return {
        finalUrl: url,
        status: 403,
        title: 'Just a moment...',
        visibleText: 'Verify you are human',
        visibleElementCount: 2,
        hasPasswordInput: false,
      };
    },
  });
  assert.equal(wafFail.ok, false);
  if (!wafFail.ok) assert.equal(wafFail.reasonCode, 'challenge_or_waf');
  assert.equal(renderCalled, 2);
});

test('executeGeneration stops BEFORE creating any Kooboo site when referenceUrl preflight fails, and records user decision options', async () => {
  let koobooHitCount = 0;
  const server = createServer((_req, res) => {
    koobooHitCount++;
    res.writeHead(500).end('unexpected Kooboo API hit');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const f = await createTestApp(origin);
  try {
    const resource = f.automationStore.saveResource({
      name: 'BlockedRefUpgrade',
      scenario: 'upgrade',
      description: 'Blocked reference test',
      contentUrl: 'https://content.example.test/',
      referenceUrl: 'https://blocked-ref.example.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const task = f.automationStore.create(
      { resourceIds: [resource.id], environmentId: f.envId, kind: 'generation', scope: 'homepage', requirements: '' },
      f.vault.automation(),
    )[0];

    await assert.rejects(
      executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000), undefined, {
        preflightReference: async url => ({
          ok: false,
          url,
          status: 403,
          reasonCode: 'challenge_or_waf',
          detail: '页面返回反爬或安全验证拦截（HTTP 403，标题：Just a moment...）',
          method: 'browser',
        }),
      }),
      error => {
        assert.ok(error instanceof FollowupRuntimeError);
        assert.equal(error.userSummary?.category, 'source-access');
        assert.match(error.userSummary?.headline || '', /无法获取参考站/);
        assert.equal(error.nextSteps.length, 3);
        return true;
      },
    );

    assert.equal(koobooHitCount, 0, 'Must not call Kooboo site creation/transfer before reference preflight passes');
    assert.equal(f.automationStore.sites().length, 0);
    const saved = f.automationStore.task(task.id)!;
    assert.equal(saved.generatedSiteId, null);
    assert.equal(saved.generation?.createAttempted, undefined);
    assert.equal(saved.generation?.referencePreflight?.status, 'failed');
    assert.equal(saved.generation?.referencePreflight?.reasonCode, 'challenge_or_waf');
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('supplement supports all 3 user decisions after reference preflight failure without skipping content site transfer by mistake', async () => {
  const f = await createTestApp('https://kooboo.test');
  try {
    const resource = f.automationStore.saveResource({
      name: 'RefDecisionSite',
      scenario: 'upgrade',
      description: 'Test supplement decisions',
      contentUrl: 'https://customer.example.test/',
      referenceUrl: 'https://blocked-ref.example.test/',
      externalSource: '',
      externalId: '',
      files: [],
    });
    const baseTask = f.automationStore.create(
      { resourceIds: [resource.id], environmentId: f.envId, kind: 'generation', scope: 'homepage', requirements: '' },
      f.vault.automation(),
    )[0];

    const uploadRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/files',
      headers: f.headers,
      payload: { name: 'reference-home.png', type: 'image/png', content: TINY_PNG.toString('base64') },
    });
    assert.equal(uploadRes.statusCode, 201);
    const shotFile = uploadRes.json();

    const supplements = new SupplementStore(f.automationStore);

    // 1) Uploading reference screenshots sets skipReferencePreflight and must NOT auto-set skipSourceTransfer!
    const t1 = structuredClone(baseTask);
    t1.status = 'interrupted';
    t1.stopped = true;
    t1.generation = {
      referencePreflight: { url: 'https://blocked-ref.example.test/', status: 'failed', reasonCode: 'challenge_or_waf', detail: 'WAF 403', checkedAt: Date.now() },
    };
    t1.interruption = {
      stage: 'prepare',
      reason: '参考站预检失败',
      evidence: [],
      attempted: [],
      nextSteps: ['上传参考截图'],
      resumeFrom: 'prepare',
      time: Date.now(),
      userSummary: { headline: '无法获取参考站页面', category: 'source-access', explanation: 'WAF', userActions: ['上传截图'] },
    };
    f.automationStore.put(t1);
    const ctx1 = buildSupplementContext(t1, f.automationStore, supplements);
    assert.equal(ctx1.referencePreflightFailed, true);
    assert.equal(ctx1.referencePreflightDetail, 'WAF 403');

    const b1 = createSupplementBatch({
      taskId: t1.id,
      mode: 'manual',
      status: 'ready',
      note: '附上参考站桌面截图',
      skipReferencePreflight: true,
      files: [{ ...shotFile, source: 'manual' }],
    });
    supplements.put(b1);
    const applied1 = await applySupplementBatch({ batch: b1, task: t1, store: f.automationStore, supplements, vault: f.vault, directory: f.directory, signal: AbortSignal.timeout(5000) });
    assert.equal(applied1.task.generation?.skipReferencePreflight, true);
    assert.equal(applied1.task.generation?.allowFreeDesignWithoutReference, undefined);
    assert.equal(applied1.task.generation?.skipSourceTransfer, undefined, 'Must not skip cloning healthy customer content site');
    assert.match(applied1.task.message, /跳过外链预检/);

    // 2) Explicitly authorizing free design sets allowFreeDesignWithoutReference
    const t2 = f.automationStore.create(
      { resourceIds: [resource.id], environmentId: f.envId, kind: 'generation', scope: 'homepage', requirements: '' },
      f.vault.automation(),
    )[0];
    t2.status = 'interrupted';
    t2.stopped = true;
    t2.generation = {
      referencePreflight: { url: 'https://blocked-ref.example.test/', status: 'failed', reasonCode: 'http_error', detail: 'HTTP 403', checkedAt: Date.now() },
    };
    f.automationStore.put(t2);
    const b2 = createSupplementBatch({
      taskId: t2.id,
      mode: 'manual',
      status: 'ready',
      note: '',
      allowFreeDesignWithoutReference: true,
      files: [],
    });
    supplements.put(b2);
    const applied2 = await applySupplementBatch({ batch: b2, task: t2, store: f.automationStore, supplements, vault: f.vault, directory: f.directory, signal: AbortSignal.timeout(5000) });
    assert.equal(applied2.task.generation?.allowFreeDesignWithoutReference, true);
    assert.equal(applied2.task.generation?.skipReferencePreflight, undefined);
    assert.equal(applied2.task.generation?.referencePreflight, undefined);
    assert.match(applied2.task.message, /明确授权放弃参考站/);

    // 3) Replacing referenceUrl clears old preflight failure & flags
    const t3 = f.automationStore.create(
      { resourceIds: [resource.id], environmentId: f.envId, kind: 'generation', scope: 'homepage', requirements: '' },
      f.vault.automation(),
    )[0];
    t3.status = 'interrupted';
    t3.stopped = true;
    t3.generation = {
      referencePreflight: { url: 'https://blocked-ref.example.test/', status: 'failed', reasonCode: 'http_error', detail: 'HTTP 403', checkedAt: Date.now() },
      allowFreeDesignWithoutReference: true,
    };
    f.automationStore.put(t3);
    const b3 = createSupplementBatch({
      taskId: t3.id,
      mode: 'manual',
      status: 'ready',
      note: '',
      replacementReferenceUrl: 'https://new-accessible-ref.example.test/',
      files: [],
    });
    supplements.put(b3);
    const applied3 = await applySupplementBatch({ batch: b3, task: t3, store: f.automationStore, supplements, vault: f.vault, directory: f.directory, signal: AbortSignal.timeout(5000) });
    assert.equal(applied3.task.generation?.overrideReferenceUrl, 'https://new-accessible-ref.example.test/');
    assert.equal(applied3.task.generation?.referencePreflight, undefined);
    assert.equal(applied3.task.generation?.allowFreeDesignWithoutReference, undefined);
    assert.equal(applied3.task.generation?.skipReferencePreflight, undefined);
  } finally {
    await f.close();
  }
});
