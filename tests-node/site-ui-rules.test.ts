import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { buildSiteUiHardRulesPrompt, SITE_UI_RULES_VERSION } from '../server/automation/site-ui-rules.js';
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
  assert.doesNotMatch(upgradeDirect, /不要写代码/);

  const materialsHomepage = buildSiteUiHardRulesPrompt({
    scenario: 'materials',
    scope: 'homepage',
  });
  assert.ok(materialsHomepage.length <= 1800, `expected <= 1800 chars, got ${materialsHomepage.length}`);
  assert.match(materialsHomepage, /本次仅交付首页，不擅自扩展内页/);
  assert.match(materialsHomepage, /禁捏造统计数字或客户证言/);
  assert.match(materialsHomepage, /直接一次完成代码落地/);

  const upgradeRefSandbox = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'site',
    templateMode: 'reference-sandbox',
  });
  assert.ok(upgradeRefSandbox.length <= 1800);
  assert.match(upgradeRefSandbox, /保留参考视觉 DNA/);

  const continuation = buildSiteUiHardRulesPrompt({
    scenario: 'upgrade',
    scope: 'site',
    isContinuation: true,
  });
  assert.ok(continuation.length <= 220);
  assert.match(continuation, /覆写10–11px小字/);
  assert.match(continuation, /严禁改动已达标稳定区段/);

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
    settings.learning = { ...settings.learning!, use: false, collect: false };
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
    task.learningPolicy = { ...task.learningPolicy!, use: false, collect: false };
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
  } finally {
    await close(server);
    await f.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
