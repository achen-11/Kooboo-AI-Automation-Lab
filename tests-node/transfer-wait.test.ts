import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { executeGeneration, waitForTransferPages } from '../server/automation/generator.js';
import { koobooClient } from '../server/automation/kooboo.js';

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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

test('waitForTransferPages exits on partial stall with imported pages and reports progress', async () => {
  const statusList = [
    ...Array.from({ length: 13 }, (_, i) => ({ url: `http://www.nativeart.nl/p${i}.htm`, done: true })),
    ...Array.from({ length: 7 }, (_, i) => ({ url: `http://www.nativeart.nl/stuck${i}.htm`, done: false })),
  ];
  const calls: string[] = [];
  const progressEvents: Array<{ completedPages: number; totalPages: number; elapsedMs: number }> = [];

  const result = await waitForTransferPages({
    request: async (path) => {
      calls.push(path);
      if (path.startsWith('Transfer/GetStatus')) return statusList;
      if (path === 'Transfer/GetTaskStatus') return { done: true, pages: 14 };
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-partial-stall',
    transferTaskId: 'task-partial-stall',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: false,
    pollMs: 10,
    stallTimeoutMs: 60,
    progressIntervalMs: 25,
    maxWaitMs: 500,
    onProgress: (info) => progressEvents.push(info),
  });

  assert.equal(result.pages, 14);
  assert.equal(result.done, true);
  assert.equal(result.completedPages, 13);
  assert.equal(result.totalPages, 20);
  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, false);
  assert.ok(progressEvents.length >= 1);
  assert.equal(progressEvents[0]!.completedPages, 13);
  assert.equal(progressEvents[0]!.totalPages, 20);
  assert.ok(calls.includes('Transfer/GetTaskStatus'));
});

test('waitForTransferPages exits on stall with 0 imported pages', async () => {
  const result = await waitForTransferPages({
    request: async (path) => {
      if (path.startsWith('Transfer/GetStatus')) {
        return [{ url: 'http://blocked.example.test/', done: false }];
      }
      if (path === 'Transfer/GetTaskStatus') {
        return { done: true, pages: 0 };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-zero-stall',
    transferTaskId: 'task-zero-stall',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: false,
    pollMs: 10,
    stallTimeoutMs: 40,
    maxWaitMs: 500,
  });

  assert.equal(result.pages, 0);
  assert.equal(result.done, true);
  assert.equal(result.completedPages, 0);
  assert.equal(result.totalPages, 1);
  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, false);
});

test('waitForTransferPages exits on maxWaitMs when progress crawls continuously', async () => {
  let completed = 0;
  const result = await waitForTransferPages({
    request: async (path) => {
      if (path.startsWith('Transfer/GetStatus')) {
        completed++;
        return Array.from({ length: 100 }, (_, i) => ({
          url: `http://slow.example.test/${i}`,
          done: i < completed,
        }));
      }
      if (path === 'Transfer/GetTaskStatus') {
        return { done: false, pages: completed };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-slow',
    transferTaskId: 'task-slow',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: false,
    pollMs: 10,
    stallTimeoutMs: 500,
    maxWaitMs: 60,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, false);
  assert.equal(result.done, false);
  assert.equal(result.pages, completed);
  assert.equal(result.completedPages, completed);
  assert.equal(result.totalPages, 100);
});

test('waitForTransferPages completes normally without calling onProgress when fast', async () => {
  let progressCalled = 0;
  const pages = [
    { url: 'http://fast.example.test/', done: true },
    { url: 'http://fast.example.test/a', done: true },
    { url: 'http://fast.example.test/b', done: true },
  ];

  const result = await waitForTransferPages({
    request: async (path) => {
      if (path.startsWith('Transfer/GetStatus')) return pages;
      if (path === 'Transfer/GetTaskStatus') return { done: true, pages: 3 };
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-fast',
    transferTaskId: 'task-fast',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: false,
    pollMs: 5,
    progressIntervalMs: 5000,
    stallTimeoutMs: 5000,
    maxWaitMs: 10000,
    onProgress: () => {
      progressCalled++;
    },
  });

  assert.equal(progressCalled, 0);
  assert.equal(result.pages, 3);
  assert.equal(result.done, true);
  assert.equal(result.completedPages, 3);
  assert.equal(result.totalPages, 3);
  assert.equal(result.stalled, false);
  assert.equal(result.timedOut, false);
});

test('waitForTransferPages uses Transfer/GetTaskStatus shortcut when allowInitialCheck is true', async () => {
  const calls: string[] = [];
  const result = await waitForTransferPages({
    request: async (path) => {
      calls.push(path);
      if (path === 'Transfer/GetTaskStatus') return { done: true, pages: 14 };
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-resume',
    transferTaskId: 'task-resume',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: true,
  });

  assert.deepEqual(calls, ['Transfer/GetTaskStatus']);
  assert.equal(result.pages, 14);
  assert.equal(result.done, true);
});

test('executeGeneration records visible waiting and completion events for legacy upgrade transfer', async () => {
  const siteId = randomUUID();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body><h1>Generated OK</h1></body></html>');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/_api/v2/User/CheckLogin') return res.end(JSON.stringify(true));
    if (url.pathname === '/_api/v2/Domain/Available') {
      return res.end(JSON.stringify([{ domainName: 'site.example.test', sudDomainUseDash: false }]));
    }
    if (url.pathname === '/_api/v2/Transfer/ByLevel') {
      return res.end(JSON.stringify({ siteId, taskId: 'legacy-transfer-task-1' }));
    }
    if (url.pathname === '/_api/v2/Transfer/GetStatus') {
      return res.end(JSON.stringify([{ url: 'https://legacy.test/', done: true }]));
    }
    if (url.pathname === '/_api/v2/Transfer/GetTaskStatus') {
      return res.end(JSON.stringify({ done: true, pages: 2 }));
    }
    if (url.pathname === '/_api/v2/Site/List') {
      return res.end(JSON.stringify([{ siteId, name: 'auto', homePageLink: `${origin}/` }]));
    }
    res.end('true');
  });

  const origin = await listen(server);
  const directory = mkdtempSync(join(tmpdir(), 'transfer-wait-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const envId = randomUUID();
  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [
        {
          id: envId,
          name: 'TestEnv',
          origin,
          apiOrigin: origin,
          token: 'test-token',
        },
      ],
    });
    const res = f.automationStore.saveResource({
      name: 'Legacy Upgrade Event Test',
      scenario: 'upgrade',
      description: 'Upgrade event check',
      contentUrl: 'https://legacy.test/',
      referenceUrl: 'https://ref.example.test',
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
    f.automationStore.put(task);

    await executeGeneration(
      task,
      f.automationStore,
      f.vault,
      directory,
      AbortSignal.timeout(10000),
      mockGenerationSession(task.id, () => siteId),
      { preflightReference: async (url) => ({ ok: true, url, finalUrl: url, status: 200, method: 'http' }) },
    );

    const messages = f.automationStore.events(task.id).map((e) => e.message);
    assert.ok(messages.some((m) => m.includes('正在等待内容站克隆完成：https://legacy.test/')));
    assert.ok(messages.some((m) => m.includes('内容站克隆完成；参考站由 Kooboo AI 使用 Sandbox tools 准备')));
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(server);
  }
});

test('waitForTransferPages converges on consecutive AbortError/TimeoutError poll failures while preserving caller aborts and auth errors', async () => {
  const pollErrors: Array<{ error: string; consecutiveErrors: number; exhausted: boolean }> = [];
  let attempts = 0;
  const result = await waitForTransferPages({
    request: async (path) => {
      if (path.startsWith('Transfer/GetStatus')) {
        attempts++;
        if (attempts === 1) return [{ url: 'https://slow.example.test/', done: false }];
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    siteId: 'site-poll-timeout',
    transferTaskId: 'task-poll-timeout',
    signal: AbortSignal.timeout(5000),
    allowInitialCheck: false,
    pollMs: 5,
    maxPollErrors: 2,
    onPollError: (info) => pollErrors.push(info),
  });

  assert.equal(attempts, 3);
  assert.equal(result.pages, 0);
  assert.equal(result.done, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, true);
  assert.equal(result.totalPages, 1);
  assert.equal(pollErrors.length, 2);
  assert.equal(pollErrors[0]!.exhausted, false);
  assert.equal(pollErrors[1]!.exhausted, true);

  // Caller abort must still rethrow immediately
  const callerAbort = new AbortController();
  callerAbort.abort(new Error('operator cancelled'));
  await assert.rejects(
    () =>
      waitForTransferPages({
        request: async () => {
          throw new Error('should not be called');
        },
        siteId: 'site-abort',
        transferTaskId: 'task-abort',
        signal: callerAbort.signal,
        allowInitialCheck: false,
      }),
    /operator cancelled/,
  );

  // Non-recoverable 401 auth errors must not be swallowed
  await assert.rejects(
    () =>
      waitForTransferPages({
        request: async () => {
          throw new Error('Kooboo Transfer/GetStatus 请求失败（401）：Unauthorized');
        },
        siteId: 'site-auth',
        transferTaskId: 'task-auth',
        signal: AbortSignal.timeout(5000),
        allowInitialCheck: false,
        pollMs: 5,
      }),
    /401/,
  );
});

test('koobooClient converts internal request timeout into a readable TimeoutError', async () => {
  const server = createServer((_req, _res) => {
    // Intentionally keep socket open past requestTimeoutMs
  });
  const origin = await listen(server);
  const directory = mkdtempSync(join(tmpdir(), 'kooboo-timeout-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const envId = randomUUID();
  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [{ id: envId, name: 'SlowEnv', origin, apiOrigin: origin, token: 'tok' }],
    });
    const { request } = koobooClient({ environmentId: envId }, f.vault, AbortSignal.timeout(5000), {
      retryDelaysMs: [10],
      requestTimeoutMs: 50,
    });
    await assert.rejects(
      () => request('Transfer/GetStatus?id=t1', undefined, 'site-1'),
      (err: unknown) => err instanceof Error && err.name === 'TimeoutError' && /Kooboo Transfer\/GetStatus 请求超时/.test(err.message),
    );
  } finally {
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
    await closeServer(server);
  }
});
