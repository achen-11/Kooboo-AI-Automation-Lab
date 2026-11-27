import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import {
  buildSiteUiHardRulesPrompt,
  buildClonedContentImageGuidance,
  resolveClonedContentImageSource,
  SITE_UI_RULES_VERSION,
} from '../server/automation/site-ui-rules.js';
import { executeGeneration } from '../server/automation/generator.js';
import { clearKoobooCapabilityCache } from '../server/automation/kooboo.js';

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('buildSiteUiHardRulesPrompt generates bounded, scenario- and scope-aware v1.2 guidance', () => {
  const upgradeDirect = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'site',
    templateMode: 'direct-template',
  });
  assert.ok(upgradeDirect.length <= 1800, `expected <= 1800 chars, got ${upgradeDirect.length}`);
  assert.ok(upgradeDirect.includes(SITE_UI_RULES_VERSION));
  assert.match(upgradeDirect, /position:relative;min-height:100%/);
  assert.match(upgradeDirect, /参考站失衡仍须按此重构/);
  assert.match(upgradeDirect, /覆写参考站10–11px小字/);
  assert.match(upgradeDirect, /<html lang>匹配主语种/);
  assert.match(upgradeDirect, /<input type="date">/);
  assert.match(upgradeDirect, /同页去重（H32/);
  assert.match(upgradeDirect, /按区块换场景词/);
  assert.match(upgradeDirect, /全站补齐所需内页/);
  assert.match(upgradeDirect, /保留 Kooboo 模板原生/);
  assert.match(upgradeDirect, /品牌主色\/强调色优先对齐原内容站与商家气质/);
  assert.match(upgradeDirect, /浮层卡片底 ≤ vh/);
  assert.match(upgradeDirect, /首屏同年\/定位标签最多1次/);
  assert.match(upgradeDirect, /<600px 老图禁铺大横幅\/大卡/);
  assert.match(upgradeDirect, /禁灰白实拍图充 Logo 墙及硬凑数字/);
  assert.match(upgradeDirect, /多电话（座机\+24\/7热线）全保留标用途并用 tel:\/mailto:/);
  assert.match(upgradeDirect, /内容图≤1（禁 Hero 与下方复用同图）/);
  assert.match(upgradeDirect, /禁将旧 \/ 改名备份/);
  assert.match(upgradeDirect, /严禁调用 ask_user_input 询问是否允许打开浏览器或页面进行视觉验收/);
  assert.match(upgradeDirect, /写img\[width\]\[height\]须配img\{height:auto\}/);
  assert.match(upgradeDirect, /禁凑节奏自造参考站没有的带标题冗余画廊/);
  assert.doesNotMatch(upgradeDirect, /不要写代码/);

  const materialsHomepage = buildSiteUiHardRulesPrompt({
    scenario: 'materials',
    scope: 'homepage',
  });
  assert.ok(materialsHomepage.length <= 1800, `expected <= 1800 chars, got ${materialsHomepage.length}`);
  assert.match(materialsHomepage, /本次仅交付首页，不擅自扩展内页/);
  assert.match(materialsHomepage, /#anchor 页内锚点/);
  assert.match(materialsHomepage, /禁捏造统计数字或客户证言/);
  assert.match(materialsHomepage, /直接一次完成代码落地/);
  assert.match(materialsHomepage, /写img\[width\]\[height\]须配img\{height:auto\}/);
  assert.match(materialsHomepage, /禁凑节奏自造参考站没有的带标题冗余画廊/);

  const upgradeRefSandbox = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'site',
    templateMode: 'reference-sandbox',
  });
  assert.ok(upgradeRefSandbox.length <= 1800, `expected <= 1800 chars, got ${upgradeRefSandbox.length}`);
  assert.match(upgradeRefSandbox, /保留参考视觉 DNA/);
  assert.match(upgradeRefSandbox, /Header 主 CTA 形态/);
  assert.match(upgradeRefSandbox, /不得轻易退化为普通 2×2 卡片/);
  assert.match(upgradeRefSandbox, /禁对高差悬殊列用 align-content:space-between 拉出大段空洞/);
  assert.match(upgradeRefSandbox, /禁止询问是否删除临时 reference-\* 参考 Sandbox/);
  assert.match(upgradeRefSandbox, /品牌主色\/强调色优先对齐原内容站与商家气质/);
  assert.match(upgradeRefSandbox, /写img\[width\]\[height\]须配img\{height:auto\}/);
  assert.match(upgradeRefSandbox, /禁凑节奏自造参考站没有的带标题冗余画廊/);

  const upgradeHomepageRef = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'homepage',
  });
  assert.ok(upgradeHomepageRef.length <= 1800, `expected <= 1800 chars, got ${upgradeHomepageRef.length}`);
  assert.match(upgradeHomepageRef, /Header 主 CTA 形态/);
  assert.match(upgradeHomepageRef, /核心交互\/色块签名区块/);
  assert.match(upgradeHomepageRef, /写img\[width\]\[height\]须配img\{height:auto\}/);
  assert.match(upgradeHomepageRef, /禁凑节奏自造参考站没有的带标题冗余画廊/);

  const upgradeHomepageDirect = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'homepage',
    templateMode: 'direct-template',
  });
  assert.ok(upgradeHomepageDirect.length <= 1800, `expected <= 1800 chars, got ${upgradeHomepageDirect.length}`);

  const continuation = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'site',
    isContinuation: true,
  });
  assert.ok(continuation.length <= 220, `expected <= 220 chars, got ${continuation.length}`);
  assert.match(continuation, /覆写10–11px小字/);
  assert.match(continuation, /img\[width\]\[height\]配height:auto/);
  assert.match(continuation, /严禁改动已达标稳定区段/);
  assert.match(continuation, /禁调 ask_user_input 询问打开浏览器\/页面做视觉验收或删除临时参考 Sandbox/);

  assert.equal(buildSiteUiHardRulesPrompt({ scenario: 'app-template', scope: 'site' }), '');
});

test('executeGeneration injects v1.2 UI hard rules into direct-template upgrade even with learning and autoEvaluate disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'site-ui-rules-gen-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const envId = randomUUID();
  const templateId = '15b72444-e031-4695-a7f1-048dfbf02e82';
  const targetSiteId = randomUUID();
  const sandboxSiteId = randomUUID();
  const transferTaskId = randomUUID();
  const deliveredPayloads: Array<{ conversationId?: string; text?: string }> = [];
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
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/_api/v2/Template/Detail') {
      res.end(JSON.stringify({ id: templateId, name: 'Tourvia', previewUrl: `${origin}/preview-template` }));
      return;
    }
    if (url.pathname === '/_api/v2/Domain/Available') {
      res.end(JSON.stringify([{ domainName: 'site.example.test', sudDomainUseDash: false }]));
      return;
    }
    if (url.pathname === '/_api/v2/Template/Use') {
      res.end(JSON.stringify(targetSiteId));
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
          ownerSiteId: targetSiteId,
          siteId: sandboxSiteId,
          sandbox: 'src-test01',
          previewUrl: `${origin}/src-sandbox`,
          taskId: transferTaskId,
          success: true,
        }),
      );
      return;
    }
    if (url.pathname === '/_api/v2/Transfer/GetStatus') {
      res.end(JSON.stringify([{ url: 'https://legacy.example.com/', done: true }]));
      return;
    }
    if (url.pathname === '/_api/v2/Transfer/GetTaskStatus') {
      res.end(JSON.stringify({ pages: 2 }));
      return;
    }
    if (url.pathname === '/_api/v2/AI/CallFunction') {
      res.end(JSON.stringify({ contents: [{ result: true }] }));
      return;
    }
    if (url.pathname === '/_api/v2/Site/List') {
      res.end(JSON.stringify([{ siteId: targetSiteId, name: 'auto', homePageLink: `${origin}/` }]));
      return;
    }
    res.end('true');
  });

  origin = await listen(server);
  clearKoobooCapabilityCache();
  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
      environments: [{ id: envId, name: 'TestEnv', origin, apiOrigin: origin, token: 'test-token' }],
    });
    const settings = structuredClone(defaultAutomationSettings);
    settings.autoEvaluate = false;
    f.vault.updateAutomation(settings);

    const resource = f.automationStore.saveResource({
      name: 'Direct Template Upgrade',
      scenario: 'upgrade',
      description: 'Upgrade legacy site onto Tourvia template.',
      contentUrl: 'https://legacy.example.com',
      referenceUrl: '',
      referenceTemplateId: templateId,
      referenceTemplateName: 'Tourvia',
      templateUsageMode: 'direct-template',
      externalSource: '',
      externalId: '',
      files: [],
    });

    const task = f.automationStore.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: envId,
        requirements: '',
        autoEvaluate: false,
      },
      f.vault.automation(),
    )[0];
    delete task.autonomy;
    task.requirementsEnabled = false;
    f.automationStore.put(task);

    const mockSession: typeof import('../server/automation/generation-session.js').generationSession = async () => {
      const conversationId = randomUUID();
      const runId = 'run-' + randomUUID().slice(0, 8);
      let sentId = '';
      return {
        snapshot: async () => ({
          version: 1,
          taskId: task.id,
          siteId: targetSiteId,
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

    await executeGeneration(task, f.automationStore, f.vault, directory, new AbortController().signal, mockSession);

    assert.equal(deliveredPayloads.length, 1);
    const outgoing = deliveredPayloads[0].text || '';
    assert.match(outgoing, /企业官网 UI 与版式硬约束（v1\.2/);
    assert.match(outgoing, /同页去重（H32/);
    assert.match(outgoing, /保留 Kooboo 模板原生 Page\/Layout\/View\/kooboo-var\.css/);
    assert.match(outgoing, /尽量一次自主完成.*\n\n【企业官网 UI 与版式硬约束/);
    assert.match(outgoing, /原内容站图片资源优先策略（内容站已成功克隆至只读源站 Sandbox）/);
    assert.match(outgoing, /src-test01/);
  } finally {
    await close(server);
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveClonedContentImageSource and buildClonedContentImageGuidance respect clone state, skip, and scenario', () => {
  assert.deepEqual(
    resolveClonedContentImageSource(
      { scenario: 'upgrade', generation: { transferComplete: true } },
      { contentUrl: 'https://legacy.example.com' },
    ),
    { kind: 'target-site', contentUrl: 'https://legacy.example.com' },
  );

  const targetInitial = buildClonedContentImageGuidance(
    { scenario: 'upgrade', generation: { transferComplete: true } },
    { contentUrl: 'https://legacy.example.com' },
  );
  assert.match(targetInitial, /原内容站图片资源优先策略（内容站已成功克隆至目标站）/);
  assert.match(targetInitial, /list_site_object/);
  assert.match(targetInitial, /严禁用 `update_object_route` 将旧首页改名为 `\/oud-home`/);

  const targetCont = buildClonedContentImageGuidance(
    { scenario: 'upgrade', generation: { transferComplete: true } },
    { contentUrl: 'https://legacy.example.com' },
    { isContinuation: true },
  );
  assert.match(targetCont, /【原内容站图片优先防回归】.*已成功克隆至当前目标站/);
  assert.match(targetCont, /严禁用 update_object_route 改名旧首页路由/);

  assert.deepEqual(
    resolveClonedContentImageSource(
      {
        scenario: 'upgrade',
        generation: {
          referenceTemplate: { templateId: 't1', templateName: 'Tpl', previewUrl: 'https://tpl.test', mode: 'direct-template' },
          sourceSandbox: { sandbox: 'src-abc', siteId: 'site-123', previewUrl: 'https://src.test', complete: true },
        },
      },
      { contentUrl: 'https://legacy.example.com' },
    ),
    { kind: 'source-sandbox', contentUrl: 'https://legacy.example.com', sandbox: 'src-abc', siteId: 'site-123' },
  );

  const sandboxInitial = buildClonedContentImageGuidance(
    {
      scenario: 'upgrade',
      generation: {
        referenceTemplate: { templateId: 't1', templateName: 'Tpl', previewUrl: 'https://tpl.test', mode: 'direct-template' },
        sourceSandbox: { sandbox: 'src-abc', siteId: 'site-123', previewUrl: 'https://src.test', complete: true },
      },
    },
    { contentUrl: 'https://legacy.example.com' },
  );
  assert.match(sandboxInitial, /只读源站 Sandbox/);
  assert.match(sandboxInitial, /src-abc/);

  const sandboxCont = buildClonedContentImageGuidance(
    {
      scenario: 'upgrade',
      generation: {
        referenceTemplate: { templateId: 't1', templateName: 'Tpl', previewUrl: 'https://tpl.test', mode: 'direct-template' },
        sourceSandbox: { sandbox: 'src-abc', siteId: 'site-123', previewUrl: 'https://src.test', complete: true },
      },
    },
    { contentUrl: 'https://legacy.example.com' },
    { isContinuation: true },
  );
  assert.match(sandboxCont, /【原内容站图片优先防回归】.*只读源站 Sandbox「src-abc」/);

  // overrideContentUrl takes precedence
  assert.equal(
    resolveClonedContentImageSource(
      { scenario: 'upgrade', generation: { transferComplete: true, overrideContentUrl: 'https://override.example.com' } },
      { contentUrl: 'https://legacy.example.com' },
    )?.contentUrl,
    'https://override.example.com',
  );

  // skipSourceTransfer (including degraded-to-materials with stale sourceSandbox) suppresses guidance
  assert.equal(
    resolveClonedContentImageSource(
      {
        scenario: 'upgrade',
        generation: {
          skipSourceTransfer: true,
          transferComplete: true,
          referenceTemplate: { templateId: 't1', templateName: 'Tpl', previewUrl: 'https://tpl.test', mode: 'direct-template' },
          sourceSandbox: { sandbox: 'src-abc', siteId: 'site-123', previewUrl: 'https://src.test', complete: true },
        },
      },
      { contentUrl: 'https://legacy.example.com' },
    ),
    undefined,
  );
  assert.equal(
    buildClonedContentImageGuidance(
      { scenario: 'upgrade', generation: { skipSourceTransfer: true, transferComplete: true } },
      { contentUrl: 'https://legacy.example.com' },
    ),
    '',
  );

  // Unfinished clones do not trigger guidance
  assert.equal(
    resolveClonedContentImageSource(
      { scenario: 'upgrade', generation: { transferComplete: false } },
      { contentUrl: 'https://legacy.example.com' },
    ),
    undefined,
  );
  assert.equal(
    resolveClonedContentImageSource(
      {
        scenario: 'upgrade',
        generation: {
          referenceTemplate: { templateId: 't1', templateName: 'Tpl', previewUrl: 'https://tpl.test', mode: 'direct-template' },
          sourceSandbox: { sandbox: 'src-abc', siteId: 'site-123', previewUrl: 'https://src.test', complete: false },
        },
      },
      { contentUrl: 'https://legacy.example.com' },
    ),
    undefined,
  );

  // Excluded scenarios
  for (const scenario of ['materials', 'site-template', 'app-template'] as const) {
    assert.equal(
      resolveClonedContentImageSource(
        { scenario, generation: { transferComplete: true } },
        { contentUrl: 'https://legacy.example.com' },
      ),
      undefined,
    );
  }
});

test('executeGeneration injects target-site cloned image priority on non-template upgrade and omits it when skipSourceTransfer=true', async () => {
  const runCase = async (skipSourceTransfer: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), 'site-ui-rules-upg-'));
    const f = await createApp({ directory, serveWeb: false, startWorker: false });
    const envId = randomUUID();
    const targetSiteId = randomUUID();
    const transferTaskId = randomUUID();
    const deliveredPayloads: Array<{ conversationId?: string; text?: string }> = [];
    let origin = '';

    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<html><body><h1>Generated OK</h1></body></html>');
        return;
      }
      for await (const _ of req) { /* drain */ }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/_api/v2/Domain/Available') {
        res.end(JSON.stringify([{ domainName: 'site.example.test', sudDomainUseDash: false }]));
        return;
      }
      if (url.pathname === '/_api/v2/Transfer/ByLevel') {
        res.end(JSON.stringify({ siteId: targetSiteId, taskId: transferTaskId }));
        return;
      }
      if (url.pathname === '/_api/v2/Site/Create') {
        res.end(JSON.stringify({ siteId: targetSiteId }));
        return;
      }
      if (url.pathname === '/_api/v2/Transfer/GetStatus') {
        res.end(JSON.stringify([{ url: 'https://legacy.example.com/', done: true }]));
        return;
      }
      if (url.pathname === '/_api/v2/Transfer/GetTaskStatus') {
        res.end(JSON.stringify({ pages: 2 }));
        return;
      }
      if (url.pathname === '/_api/v2/AI/CallFunction') {
        res.end(JSON.stringify({ contents: [{ result: true }] }));
        return;
      }
      if (url.pathname === '/_api/v2/Site/List') {
        res.end(JSON.stringify([{ siteId: targetSiteId, name: 'auto', homePageLink: `${origin}/` }]));
        return;
      }
      res.end('true');
    });

    origin = await listen(server);
    try {
      f.vault.update({
        threshold: 80,
        paused: true,
        model: { endpoint: 'https://api.deepseek.com', name: 'deepseek-flash-1017', apiKey: 'test-key' },
        environments: [{ id: envId, name: 'TestEnv', origin, apiOrigin: origin, token: 'test-token' }],
      });
      const settings = structuredClone(defaultAutomationSettings);
      settings.autoEvaluate = false;
      f.vault.updateAutomation(settings);

      const resource = f.automationStore.saveResource({
        name: skipSourceTransfer ? 'Upgrade Skip Transfer' : 'Upgrade With Transfer',
        scenario: 'upgrade',
        description: 'Upgrade legacy site.',
        contentUrl: 'https://legacy.example.com',
        referenceUrl: 'https://ref.example.com',
        externalSource: '',
        externalId: '',
        files: [],
        skipSourceTransfer,
      });

      const task = f.automationStore.create(
        {
          resourceIds: [resource.id],
          kind: 'generation',
          scope: 'site',
          environmentId: envId,
          requirements: '',
          autoEvaluate: false,
          skipSourceTransfer,
        },
        f.vault.automation(),
      )[0];
      delete task.autonomy;
      task.requirementsEnabled = false;
      f.automationStore.put(task);

      const mockSession: typeof import('../server/automation/generation-session.js').generationSession = async () => {
        const conversationId = randomUUID();
        const runId = 'run-' + randomUUID().slice(0, 8);
        let sentId = '';
        return {
          snapshot: async () => ({
            version: 1,
            taskId: task.id,
            siteId: targetSiteId,
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

      await executeGeneration(
        task,
        f.automationStore,
        f.vault,
        directory,
        new AbortController().signal,
        mockSession,
        { preflightReference: async (refUrl) => ({ ok: true, url: refUrl, finalUrl: refUrl, status: 200, method: 'http' }) },
      );

      assert.equal(deliveredPayloads.length, 1);
      return deliveredPayloads[0].text || '';
    } finally {
      await close(server);
      await f.app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const withClone = await runCase(false);
  assert.match(withClone, /原内容站图片资源优先策略（内容站已成功克隆至目标站）/);

  const skippedClone = await runCase(true);
  assert.doesNotMatch(skippedClone, /原内容站图片资源优先策略/);
  assert.doesNotMatch(skippedClone, /sourceSandbox/);
});
