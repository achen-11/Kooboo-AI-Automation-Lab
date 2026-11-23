import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { buildHarnessCatalog } from '../server/automation/harness.js';
import { GenerationContextStore } from '../server/automation/generation-context.js';
import { executeGeneration } from '../server/automation/generator.js';
import { executeEvaluation } from '../server/automation/evaluator.js';
import { koobooSafeFilename, materialDestination } from '../server/automation/materials.js';
import type { codexClient } from '../server/automation/codex-client.js';
import type { evaluationBrowser } from '../server/automation/browser.js';
import { createSupplementBatch, SupplementStore } from '../server/automation/supplement.js';
import { startAiSupplementIntake } from '../server/automation/supplement-ai.js';
import { type AutomationTask, type MaterialFile } from '../shared/automation.js';
import type { TaskSupplementContext } from '../shared/supplement.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function createTestApp(koobooOrigin = 'https://kooboo.test') {
  const directory = mkdtempSync(join(tmpdir(), 'supplement-test-'));
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

async function uploadFixtureFile(
  f: Awaited<ReturnType<typeof createTestApp>>,
  name: string,
  type: string,
  content: Buffer,
): Promise<MaterialFile> {
  const res = await f.app.inject({
    method: 'POST',
    url: '/api/automation/files',
    headers: f.headers,
    payload: {
      name,
      type,
      content: content.toString('base64'),
    },
  });
  assert.equal(res.statusCode, 201);
  return res.json() as MaterialFile;
}

function mockSessionFactory(
  task: { id: string },
  siteId: string,
  delivered: Array<{ text?: string; answer?: unknown; callId?: string }>,
): typeof import('../server/automation/generation-session.js').generationSession {
  return async () => {
    const conversationId = randomUUID();
    const runId = 'run-' + randomUUID().slice(0, 8);
    let sentId = '';
    return {
      snapshot: async () => ({
        version: 1,
        taskId: task.id,
        siteId,
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
      deliver: async input => {
        sentId = input.id;
        delivered.push({ text: input.text, answer: input.answer, callId: input.callId });
        return { id: input.id, state: 'accepted', conversationId };
      },
      close: async () => {},
    };
  };
}

function createStoppedUpgradeTask(
  f: Awaited<ReturnType<typeof createTestApp>>,
  options?: {
    contentUrl?: string;
    referenceUrl?: string;
    category?: 'source-access' | 'need-human-input';
    siteUrl?: string;
    withFollowupAnswerEvidence?: string;
    status?: AutomationTask['status'];
  },
) {
  const resource = f.automationStore.saveResource({
    name: 'SupplementTestSite',
    scenario: 'upgrade',
    description: '原有网站升级改造',
    contentUrl: options?.contentUrl || 'https://unreachable.example.test',
    referenceUrl: options?.referenceUrl || 'https://ref-origin.example.test',
    externalSource: '',
    externalId: '',
    files: [],
  });
  const tasks = f.automationStore.create(
    {
      resourceIds: [resource.id],
      environmentId: f.envId,
      kind: 'generation',
      scope: 'homepage',
      requirements: '保留主要业务信息并完善配图',
    },
    f.vault.automation(),
  );
  const task = tasks[0];
  const siteId = randomUUID();
  const site = {
    id: randomUUID(),
    resourceId: resource.id,
    versionId: task.versionId,
    environmentId: f.envId,
    siteId,
    name: 'supp-site',
    url: options?.siteUrl || 'https://target-site.example.test',
    createdAt: Date.now(),
  };
  f.automationStore.saveSite(site);
  task.generatedSiteId = site.id;
  task.siteUrl = site.url;
  task.status = options?.status || 'interrupted';
  task.stopped = true;
  task.interruption = {
    stage: 'generation',
    reason: '原内容站无法访问',
    nextSteps: ['上传补充资料或替换源站地址'],
    evidence: options?.withFollowupAnswerEvidence ? [options.withFollowupAnswerEvidence] : [],
    attempted: [],
    resumeFrom: 'generation',
    time: Date.now(),
    userSummary: {
      category: options?.category || 'source-access',
      headline: '需要补充资料',
      explanation: '请通过 Automation Lab 上传资料或引导 AI 收集',
      userActions: ['点击补充资料 / AI 收集'],
    },
  };
  f.automationStore.put(task);
  return { resource, site, task };
}

function handleMockKscript(code: string) {
  if (code.startsWith('var files=')) {
    const marker = code.includes('; for(var i=0;i<files.length')
      ? '; for(var i=0;i<files.length'
      : ';for(var i=0;i<files.length';
    const idx = code.indexOf(marker);
    const files = idx > 0 ? (JSON.parse(code.slice('var files='.length, idx)) as unknown[]) : [];
    return { contents: [{ isError: false, result: { ok: true, count: files.length } }] };
  }
  return { contents: [{ isError: false, result: true }] };
}

test('Harness catalog exposes intake/SKILL.md (15 docs, 8 stages)', async () => {
  const f = await createTestApp();
  try {
    const catalog = buildHarnessCatalog(f.vault.rawAutomation());
    assert.equal(catalog.stages.length, 8);
    assert.equal(catalog.documents.length, 15);
    assert.ok(catalog.stages.some(stage => stage.id === 'intake'));
    assert.ok(catalog.documents.some(doc => doc.path === 'intake/SKILL.md'));
  } finally {
    await f.close();
  }
});

test('Manual supplement on source-access syncs kfile manifest, sets skipSourceTransfer, and skips Transfer in generator', async () => {
  const calls: Array<{ path: string; body: string }> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const buf = await readBody(req);
    const body = buf.toString('utf8');
    calls.push({ path: url, body });

    if (url.startsWith('/_api/v2/AI/CallFunction')) {
      const code = String(JSON.parse(body)?.arguments?.code || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handleMockKscript(code)));
      return;
    }
    if (url.startsWith('/_api/v2/Site/Get')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 's', name: 'supp-site', baseUrl: serverOrigin }));
      return;
    }
    if (url.startsWith('/_api/v2/Site/List')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (url.startsWith('/_api/v2/Template/List')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ list: [] }));
      return;
    }
    if (url.startsWith('/_api/v2/Page/All')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'p1', name: 'index', online: true }]));
      return;
    }
    if (url.includes('Transfer')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errorMessage: 'should not invoke transfer when skipped' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Generated Tea Shop</h1></body></html>');
  });
  const serverOrigin = await listen(server);
  const f = await createTestApp(serverOrigin);

  try {
    const mdFile = await uploadFixtureFile(
      f,
      'docs/brand-intro.md',
      'text/markdown',
      Buffer.from('# 云起茶室\n\n精选明前龙井与岩茶。\n', 'utf8'),
    );
    const { task, site } = createStoppedUpgradeTask(f, {
      category: 'source-access',
      siteUrl: serverOrigin,
    });
    task.generation = { transferFallbackAttempted: true };
    f.automationStore.put(task);

    const res = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/manual`,
      headers: f.headers,
      payload: {
        files: [mdFile],
        note: '原网址已下线，请改用刚上传的品牌介绍文档建站',
        replacementContentUrl: '',
        replacementReferenceUrl: '',
        skipSourceTransfer: true,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.batch.status, 'applied');
    assert.equal(body.batch.appliedResult.uploadedCount, 1);

    const kscriptCodes = calls
      .filter(c => c.path.startsWith('/_api/v2/AI/CallFunction'))
      .map(c => JSON.parse(c.body).arguments.code as string);
    assert.ok(kscriptCodes.some(code => code.includes('brand-intro.md')));
    assert.ok(kscriptCodes.some(code => code.includes(`_automation-manifests/${task.id}.json`)));

    const updated = f.automationStore.task(task.id)!;
    assert.equal(updated.status, 'queued');
    assert.equal(updated.interruption, undefined);
    assert.equal(updated.generation?.skipSourceTransfer, true);
    assert.equal(updated.generation?.transferComplete, true);
    assert.equal(updated.generation?.transferFallbackAttempted, undefined);

    const delivered: Array<{ text?: string; answer?: unknown; callId?: string }> = [];
    const controller = new AbortController();
    await executeGeneration(
      updated,
      f.automationStore,
      f.vault,
      f.directory,
      controller.signal,
      mockSessionFactory(updated, site.siteId, delivered),
    );

    assert.equal(calls.some(c => c.path.includes('Transfer')), false);
    assert.equal(delivered.length, 1);
    const packages = new GenerationContextStore(f.automationStore).packages(updated.id);
    const combinedContext = `${delivered[0].text || ''}\n${packages.at(-1)?.original || ''}`;
    assert.match(combinedContext, /_automation-manifests\//);
    assert.match(combinedContext, /改用刚上传的品牌介绍文档建站/);
  } finally {
    await f.close();
    await closeServer(server);
  }
});

test('Manual supplement answers pending ask_user_input (mediaLibrary) without kscript manifest and rejects archived tasks', async () => {
  const imageUploads: Array<{ url: string; contentType: string; size: number }> = [];
  const kscriptCalls: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const buf = await readBody(req);
    if (url.startsWith('/_api/v2/Upload/Image')) {
      imageUploads.push({
        url,
        contentType: String(req.headers['content-type'] || ''),
        size: buf.length,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'media-123', url: '/images/yunqi-tea/hero.png' }]));
      return;
    }
    if (url.startsWith('/_api/v2/AI/CallFunction')) {
      kscriptCalls.push(buf.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ contents: [{ isError: false, result: true }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const serverOrigin = await listen(server);
  const f = await createTestApp(serverOrigin);

  try {
    const pngFile = await uploadFixtureFile(f, 'tea/hero.png', 'image/png', TINY_PNG);
    const { task } = createStoppedUpgradeTask(f, {
      category: 'need-human-input',
      withFollowupAnswerEvidence:
        '[call_id=call-tea-upload-1] ask_user_input args={"kind":"upload","question":"请上传茶叶首页横幅图","description":"用于替换首页占位图片","upload":{"target":"mediaLibrary","folder":"yunqi-tea","accept":["image/png"],"maxFiles":4,"purpose":"hero"}}',
    });
    task.generation = {
      deliveryId: 'delivery-prev',
      conversationId: 'conv-prev',
      previousRunId: 'run-prev',
      prepared: true,
      pending: {
        callId: 'call-tea-upload-1',
        name: 'ask_user_input',
        args: {
          kind: 'upload',
          question: '请上传茶叶首页横幅图',
          description: '用于替换首页占位图片',
          upload: {
            target: 'mediaLibrary',
            folder: 'yunqi-tea',
            accept: ['image/png'],
            maxFiles: 4,
            purpose: 'hero',
          },
        },
      },
    };
    f.automationStore.put(task);

    const ctxRes = await f.app.inject({
      method: 'GET',
      url: `/api/automation/tasks/${task.id}/supplements`,
      headers: f.headers,
    });
    assert.equal(ctxRes.statusCode, 200);
    const ctx = ctxRes.json() as TaskSupplementContext;
    assert.equal(ctx.pendingUpload?.callId, 'call-tea-upload-1');
    assert.equal(ctx.pendingUpload?.target, 'mediaLibrary');
    assert.equal(ctx.pendingUpload?.folder, 'yunqi-tea');

    const res = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/manual`,
      headers: f.headers,
      payload: {
        files: [pngFile],
        note: '已上传茶室主视觉图片',
        replacementContentUrl: '',
        replacementReferenceUrl: '',
        skipSourceTransfer: false,
      },
    });
    assert.equal(res.statusCode, 200);
    const result = res.json();
    assert.equal(result.batch.appliedResult.answeredPending, true);
    assert.equal(result.batch.appliedResult.uploadedCount, 1);

    assert.equal(imageUploads.length, 1);
    assert.equal(kscriptCalls.length, 0);

    const updated = f.automationStore.task(task.id)!;
    assert.equal(updated.status, 'queued');
    assert.equal(updated.generation?.next?.action, 'answer');
    assert.equal(updated.generation?.next?.callId, 'call-tea-upload-1');
    assert.deepEqual(updated.generation?.next?.answer, {
      confirmed: true,
      kind: 'upload',
      value: [
        {
          id: 'media-123',
          name: 'tea/hero.png',
          url: '/images/yunqi-tea/hero.png',
          relativeUrl: '/images/yunqi-tea/hero.png',
          mimeType: 'image/png',
          size: TINY_PNG.length,
          storage: 'mediaLibrary',
        },
      ],
      feedback: '已上传茶室主视觉图片',
    });

    // Archived tasks must reject supplement modifications cleanly.
    f.automationStore.dispositions.set('delivery', [task.generatedSiteId!], 'completed', 'done');
    updated.status = 'interrupted';
    f.automationStore.put(updated);
    const archivedRes = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/manual`,
      headers: f.headers,
      payload: { files: [], note: 'retry on archived' },
    });
    assert.equal(archivedRes.statusCode, 409);
  } finally {
    await f.close();
    await closeServer(server);
  }
});

test('URL overrides preserve frozen InputVersion and propagate to generator Transfer/Single and evaluator effectiveInput', async () => {
  const singleCalls: Array<{ path: string; body: string }> = [];
  let singleStarted = false;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const buf = await readBody(req);
    const body = buf.toString('utf8');

    if (url.startsWith('/_api/v2/Transfer/GetTaskStatus')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pages: singleStarted ? 1 : 0, done: true }));
      return;
    }
    if (url.startsWith('/_api/v2/Transfer/Single')) {
      singleStarted = true;
      singleCalls.push({ path: url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'single-task-1' }));
      return;
    }
    if (url.startsWith('/_api/v2/Transfer/GetStatus')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(singleStarted ? [{ done: true }] : []));
      return;
    }
    if (url.startsWith('/_api/v2/AI/CallFunction')) {
      const code = String(JSON.parse(body)?.arguments?.code || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handleMockKscript(code)));
      return;
    }
    if (url.startsWith('/_api/v2/Site/Get')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 's', name: 'supp-site', baseUrl: serverOrigin }));
      return;
    }
    if (url.startsWith('/_api/v2/Site/List')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><p>Target Site</p></body></html>');
  });
  const serverOrigin = await listen(server);
  const f = await createTestApp(serverOrigin);

  try {
    const extraFile = await uploadFixtureFile(f, 'supplement/notes.txt', 'text/plain', Buffer.from('门店营业时间 09:00-21:00'));
    const { task, site } = createStoppedUpgradeTask(f, {
      contentUrl: 'https://dead-origin.example.test',
      referenceUrl: 'https://old-ref.example.test',
      category: 'source-access',
      siteUrl: serverOrigin,
    });
    const originalVersion = f.automationStore.version(task.versionId)!;

    const res = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/manual`,
      headers: f.headers,
      payload: {
        files: [extraFile],
        note: '使用可访问镜像链接继续',
        replacementContentUrl: 'https://mirror.example.test/home',
        replacementReferenceUrl: 'https://new-ref.example.test/style',
        skipSourceTransfer: false,
      },
    });
    assert.equal(res.statusCode, 200);

    // Frozen input version must stay completely unchanged.
    const untouchedVersion = f.automationStore.version(task.versionId)!;
    assert.equal(untouchedVersion.contentUrl, originalVersion.contentUrl);
    assert.equal(untouchedVersion.referenceUrl, originalVersion.referenceUrl);
    assert.equal(untouchedVersion.files.length, 0);

    const ctxRes = await f.app.inject({
      method: 'GET',
      url: `/api/automation/tasks/${task.id}/supplements`,
      headers: f.headers,
    });
    const ctx = ctxRes.json() as TaskSupplementContext;
    assert.equal(ctx.effectiveContentUrl, 'https://mirror.example.test/home');
    assert.equal(ctx.effectiveReferenceUrl, 'https://new-ref.example.test/style');

    // Run generator: !taskId + overrideContentUrl should invoke Transfer/Single once with new contentUrl.
    const genTask = f.automationStore.task(task.id)!;
    const delivered: Array<{ text?: string }> = [];
    await executeGeneration(
      genTask,
      f.automationStore,
      f.vault,
      f.directory,
      new AbortController().signal,
      mockSessionFactory(genTask, site.siteId, delivered),
    );
    assert.equal(singleCalls.length, 1);
    assert.equal(JSON.parse(singleCalls[0].body).pageUrl, 'https://mirror.example.test/home');

    // Child evaluation task inherits supplementalFiles & URL overrides into work/task.json & materials.
    genTask.status = 'completed';
    genTask.stopped = true;
    f.automationStore.put(genTask);
    const evalTask = f.automationStore.create(
      {
        resourceIds: [genTask.resourceId],
        environmentId: f.envId,
        kind: 'evaluation',
        scope: 'homepage',
        requirements: '',
        parentId: genTask.id,
        generatedSiteId: site.id,
      },
      f.vault.automation(),
    )[0];

    const sentinel = new Error('SENTINEL_STOP_BEFORE_CODEX');
    let capturedTargets: { target?: string; reference?: string; content?: string } | undefined;
    const mockOpenBrowser: typeof evaluationBrowser = async (targets) => {
      capturedTargets = targets;
      return {
        env: {},
        artifacts: [],
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    await assert.rejects(
      executeEvaluation(evalTask, f.automationStore, f.vault, f.directory, new AbortController().signal, {
        openBrowser: mockOpenBrowser,
        createClient: (() => ({
          startThread: () => ({
            runStreamed: async () => {
              throw sentinel;
            },
          }),
        })) as unknown as typeof codexClient,
      }),
      /SENTINEL_STOP_BEFORE_CODEX/,
    );

    assert.equal(capturedTargets?.content, 'https://mirror.example.test/home');
    assert.equal(capturedTargets?.reference, 'https://new-ref.example.test/style');

    const evalTaskJsonPath = resolve(f.directory, 'automation-runs', evalTask.id, 'task.json');
    assert.equal(existsSync(evalTaskJsonPath), true);
    const evalPayload = JSON.parse(readFileSync(evalTaskJsonPath, 'utf8'));
    assert.equal(evalPayload.input.contentUrl, 'https://mirror.example.test/home');
    assert.equal(evalPayload.input.referenceUrl, 'https://new-ref.example.test/style');
    assert.ok(evalPayload.input.files.some((file: MaterialFile) => file.id === extraFile.id));
    assert.equal(
      existsSync(resolve(f.directory, 'automation-runs', evalTask.id, 'materials', 'supplement', 'notes.txt')),
      true,
    );
  } finally {
    await f.close();
    await closeServer(server);
  }
});

test('AI-assisted intake stages ready draft for confirmation, supports selective apply, cancel, and autoApply', async () => {
  const imageUploads: Array<{ folder: string; filename: string }> = [];
  const manifestWrites: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    const buf = await readBody(req);
    const body = buf.toString('utf8');
    if (url.startsWith('/_api/v2/AI/CallFunction')) {
      const code = String(JSON.parse(body)?.arguments?.code || '');
      if (code.includes('_automation-manifests/')) manifestWrites.push(code);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handleMockKscript(code)));
      return;
    }
    if (url.startsWith('/_api/v2/Upload/Image')) {
      const latin = buf.toString('latin1');
      const folder = latin.match(/name="Folder"\r\n\r\n([^\r\n]+)/)?.[1] || '';
      const filename = latin.match(/name="file"; filename="([^"]+)"/)?.[1] || 'image.png';
      imageUploads.push({ folder, filename });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: `media-${filename}`, url: `${folder}/${filename}`.replace(/\/+/g, '/') }]));
      return;
    }
    if (url.startsWith('/_api/v2/Upload/File')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('true');
      return;
    }
    if (url.startsWith('/_api/v2/File/List')) {
      const qs = new URL(url, serverOrigin).searchParams;
      const folder = qs.get('path') || '/';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          files: {
            totalPages: 1,
            list: [
              { url: `${folder === '/' ? '' : folder}/home.png`.replace(/\/+/g, '/'), size: TINY_PNG.length },
              { url: `${folder === '/' ? '' : folder}/home-img-1.png`.replace(/\/+/g, '/'), size: TINY_PNG.length },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const serverOrigin = await listen(server);
  const f = await createTestApp(serverOrigin);

  try {
    const { task } = createStoppedUpgradeTask(f, { category: 'source-access', siteUrl: serverOrigin });
    const supplements = new SupplementStore(f.automationStore);

    const makeDeps = () => ({
      fetchUrl: async (url: string, _captureImages: boolean, stagingDir: string) => {
        mkdirSync(resolve(stagingDir, 'screenshots'), { recursive: true });
        mkdirSync(resolve(stagingDir, 'assets'), { recursive: true });
        writeFileSync(resolve(stagingDir, 'screenshots', 'home.png'), TINY_PNG);
        writeFileSync(resolve(stagingDir, 'assets', 'home-img-1.png'), TINY_PNG);
        return {
          url,
          title: 'Alt Tea Home',
          description: 'Artisanal tea house',
          headings: ['云起茶室', '四季选茶'],
          navLinks: [{ text: '首页', url }],
          textContent: '云起茶室专注于高山乌龙与手工岩茶。',
          screenshotRelPath: 'screenshots/home.png',
          imageFiles: [
            {
              relPath: 'assets/home-img-1.png',
              sourceUrl: `${url}/hero.png`,
              alt: '茶席实景',
              mime: 'image/png',
              size: TINY_PNG.length,
            },
          ],
          warnings: [],
        };
      },
      createClient: ((_v: Parameters<typeof codexClient>[0], _d: string, env: Record<string, string>) => ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              const call = (payload: unknown) =>
                fetch(env.DECISION_TOOLS_URL, {
                  method: 'POST',
                  headers: {
                    authorization: 'Bearer ' + env.DECISION_TOOLS_TOKEN,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(payload),
                });
              yield { type: 'thread.started', thread_id: 'intake-thread-' + randomUUID() };
              // Exercise both readAliases shorthand (`tool: 'fetch_url'`) and `{ kind: 'write_doc' }` shorthand
              const fRes = await call({
                tool: 'fetch_url',
                url: 'https://alt.example.test',
                captureImages: true,
              });
              assert.equal(fRes.status, 200);
              const wRes = await call({
                kind: 'write_doc',
                path: 'intake-brief.md',
                content: '# 云起茶室整理简报\n\n已抽取首页文案与主要视觉配图。',
              });
              assert.equal(wRes.status, 200);
              const sRes = await call({
                tool: 'submit',
                result: {
                  headline: '已抓取 1 页文案、1 张页面截图与 1 张品牌配图',
                  collectedFrom: ['https://alt.example.test'],
                  highlights: ['整理完成云起茶室核心文案', '捕获主视觉截图与配图'],
                  gaps: ['缺少门店具体营业时间，可按通用茶室文案展示'],
                  selectedFiles: ['intake-brief.md', 'screenshots/home.png', 'assets/home-img-1.png'],
                },
              });
              assert.equal(sRes.status, 200);
              yield { type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 80 } };
            })(),
          }),
        }),
      })) as unknown as typeof codexClient,
    });

    // 1. Default autoApply: false stops in 'ready' state awaiting human confirmation.
    const previewBatch = createSupplementBatch({
      taskId: task.id,
      mode: 'ai-assisted',
      status: 'collecting',
      note: '帮我抓取并整理新网址内容',
      sourceUrl: 'https://alt.example.test',
      skipSourceTransfer: true,
      autoApply: false,
    });
    supplements.put(previewBatch);

    const readyBatch = await startAiSupplementIntake({
      task,
      batch: previewBatch,
      store: f.automationStore,
      supplements,
      vault: f.vault,
      directory: f.directory,
      deps: makeDeps(),
    });
    assert.equal(readyBatch.status, 'ready');
    assert.equal(readyBatch.files.length, 3);
    assert.equal(readyBatch.summary?.headline, '已抓取 1 页文案、1 张页面截图与 1 张品牌配图');
    assert.equal(f.automationStore.task(task.id)?.status, 'interrupted');

    // Apply only the Markdown doc to test selective file filtering.
    const docFile = readyBatch.files.find(file => file.source === 'ai-doc')!;
    assert.ok(docFile);
    const applyRes = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/${readyBatch.id}/apply`,
      headers: f.headers,
      payload: {
        selectedFileIds: [docFile.id],
        note: '仅导入整理的 Markdown 简报并跳过原站抓取',
        skipSourceTransfer: true,
      },
    });
    assert.equal(applyRes.statusCode, 200);
    const applyJson = applyRes.json();
    assert.equal(applyJson.batch.status, 'applied');
    assert.equal(applyJson.batch.appliedResult.uploadedCount, 1);

    const taskAfterSelective = f.automationStore.task(task.id)!;
    assert.equal(taskAfterSelective.status, 'queued');
    assert.equal(taskAfterSelective.generation?.supplementalFiles?.length, 1);
    assert.equal(taskAfterSelective.generation?.supplementalFiles?.[0].id, docFile.id);
    assert.ok(taskAfterSelective.generation?.skipSourceTransfer);

    // 2. Test cancelling a ready draft via POST .../cancel.
    taskAfterSelective.status = 'interrupted';
    taskAfterSelective.stopped = true;
    f.automationStore.put(taskAfterSelective);

    const draftToCancel = createSupplementBatch({
      taskId: task.id,
      mode: 'ai-assisted',
      status: 'ready',
      note: '待放弃草稿',
      sourceUrl: 'https://alt.example.test',
      files: [],
      summary: { headline: 'draft', collectedFrom: [], highlights: ['h'], gaps: [], selectedFiles: [] },
    });
    supplements.put(draftToCancel);
    const cancelRes = await f.app.inject({
      method: 'POST',
      url: `/api/automation/tasks/${task.id}/supplements/${draftToCancel.id}/cancel`,
      headers: f.headers,
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.json().batch.status, 'cancelled');

    // 3. Test autoApply: true automatically applies and re-queues without extra confirmation call.
    const autoBatch = createSupplementBatch({
      taskId: task.id,
      mode: 'ai-assisted',
      status: 'collecting',
      note: '自动导入并继续',
      sourceUrl: 'https://alt.example.test',
      skipSourceTransfer: true,
      autoApply: true,
    });
    supplements.put(autoBatch);
    const completedBatch = await startAiSupplementIntake({
      task,
      batch: autoBatch,
      store: f.automationStore,
      supplements,
      vault: f.vault,
      directory: f.directory,
      deps: makeDeps(),
    });
    assert.equal(completedBatch.status, 'applied');
    assert.equal(f.automationStore.task(task.id)?.status, 'queued');
    assert.deepEqual(imageUploads, [
      { folder: '/materials/supplement/screenshots', filename: 'home.png' },
      { folder: '/materials/supplement/assets', filename: 'home-img-1.png' },
    ]);
    assert.ok(manifestWrites.length >= 2);
  } finally {
    await f.close();
    await closeServer(server);
  }
});

test('materialDestination and koobooSafeFilename sanitize Kooboo-normalized + characters while preserving logical path', () => {
  const docxFile: MaterialFile = {
    id: 'ef71770e-4912-42af-b19a-0a2f2b0415d2',
    name: '独立站资料+备份/公司介绍+公司理念.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 11712,
    sha256: 'a'.repeat(64),
  };
  const dest = materialDestination('res-1', 'ver-1', docxFile);
  assert.equal(dest.logical, '独立站资料+备份/公司介绍+公司理念.docx');
  assert.equal(dest.text, false);
  assert.equal(dest.filename, 'ef71770e-4912-42af-b19a-0a2f2b0415d2.docx');
  assert.equal(dest.folder, 'materials/res-1/ver-1/独立站资料_备份');
  assert.equal(dest.path, '/materials/res-1/ver-1/独立站资料_备份/ef71770e-4912-42af-b19a-0a2f2b0415d2.docx');
  assert.equal(koobooSafeFilename(docxFile, 'normal-image_01.png'), 'normal-image_01.png');
});
