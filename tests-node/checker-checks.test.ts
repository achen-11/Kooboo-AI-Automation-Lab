import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { executeEvaluation } from '../server/automation/evaluator.js';
import { runChecksRegressionSuite } from '../server/automation/checker-checks.js';
import type { evaluationBrowser } from '../server/automation/browser.js';
import type { ScreenshotReceipt } from '../server/automation/page-screenshots.js';
import { defaultAutomationSettings, type MaterialFile } from '../shared/automation.js';
import { defaultLearningSettings } from '../shared/experience.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=',
  'base64',
);

async function createChecksApp() {
  const directory = mkdtempSync(join(tmpdir(), 'checker-checks-'));
  const f = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await f.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Yunyu Coffee</h1></body></html>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const envId = randomUUID();

  f.vault.update({
    threshold: 85,
    paused: true,
    model: { endpoint: `${origin}/v1`, name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [{ id: envId, name: 'TestEnv', origin, apiOrigin: origin, token: 'test-token' }],
  });
  const settings = structuredClone(defaultAutomationSettings);
  settings.learning = { ...defaultLearningSettings, use: false, collect: false };
  f.vault.updateAutomation({
    ...settings,
    evaluationEndpoint: `${origin}/v1`,
    evaluationModel: 'deepseek-flash-1017',
  });

  return {
    ...f,
    directory,
    headers,
    origin,
    envId,
    async cleanup() {
      await f.app.close();
      await new Promise<void>(done => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('CheckerChecksStore seeds defaults, versions human-promoted rules, enforces concurrency, and restores revisions', async () => {
  const f = await createChecksApp();
  try {
    const initial = f.automationStore.checks.snapshot();
    assert.equal(initial.rules.length, 7);
    assert.deepEqual(
      initial.rules.map(r => r.id),
      ['R-VISUAL-01', 'R-VISUAL-02', 'R-LAYOUT-03', 'R-COVER-04', 'R-LAYOUT-04', 'R-TYPO-01', 'R-DUPE-01'],
    );
    assert.equal(initial.calibrations.length, 8);
    assert.match(initial.markdown, /R-VISUAL-01/);
    assert.match(initial.markdown, /R-LAYOUT-04/);
    assert.match(initial.hash, /^[a-f0-9]{64}$/);

    const suggested = f.automationStore.checks.nextSuggestedIds();
    assert.equal(suggested['R-CONTENT'], 'R-CONTENT-01');
    assert.equal(suggested['R-VISUAL'], 'R-VISUAL-03');

    const { rule: created, calibration } = f.automationStore.checks.createRule(
      {
        id: 'R-CONTENT-01',
        title: '公开页面与页脚严禁残留内部制作口径文案',
        severity: 'major',
        trigger: '页面正文中出现“依据客户提供的《...》资料整理”或“以商务确认为准”等内部口径。',
        exemptions: [],
        criterionCap: 72,
        viewportCap: 76,
        action: '判定 Major；对应维度 ≤ 72、视口 ≤ 76，强制 quality=failed。',
        scenarios: ['materials', 'upgrade'],
        scopes: ['homepage', 'site'],
        sourceReportId: '0c845714-0000-4000-8000-000000000001',
        rationale: '源于 OVO 第 2 轮页脚制作口径泄露',
      },
      '从人工复核沉淀内容红线',
      {
        title: '页脚残留内部制作口径文案',
        kind: 'should-catch',
        scenario: 'materials',
        scope: 'homepage',
        sourceReportId: '0c845714-0000-4000-8000-000000000001',
        viewport: 'desktop',
        criterionId: 'sections',
      },
    );
    assert.equal(created.revision, 1);
    assert.equal(created.source, 'human-review');
    assert.ok(calibration?.id);

    assert.throws(
      () => f.automationStore.checks.updateRule('R-CONTENT-01', { title: 'stale' }, 99, 'bad rev'),
      /版本已变更/,
    );

    const { rule: rev2 } = f.automationStore.checks.updateRule(
      'R-CONTENT-01',
      { exemptions: ['合规隐私声明中的联系邮箱说明'], viewportCap: 74 },
      1,
      '追加合理隐私声明豁免',
    );
    assert.equal(rev2.revision, 2);
    assert.equal(rev2.viewportCap, 74);

    const history = f.automationStore.checks.revisions('R-CONTENT-01');
    assert.equal(history.length, 2);
    assert.equal(history[0].revision, 2);
    assert.equal(history[1].revision, 1);

    const restored = f.automationStore.checks.restoreRule('R-CONTENT-01', 2, 1, '回退至初版');
    assert.equal(restored.revision, 3);
    assert.equal(restored.viewportCap, 76);
    assert.deepEqual(restored.exemptions, []);
  } finally {
    await f.cleanup();
  }
});

test('runChecksRegressionSuite verifies built-in seeds, catches custom rules, and fails loudly when disabled', async () => {
  const f = await createChecksApp();
  try {
    const baseReport = runChecksRegressionSuite(
      f.automationStore.checks.listRules(),
      f.automationStore.checks.listCalibrations(),
      f.directory,
    );
    assert.equal(baseReport.total, 8);
    assert.equal(baseReport.passed, 8);
    assert.equal(baseReport.failed, 0);

    f.automationStore.checks.createRule(
      {
        id: 'R-CONTENT-01',
        title: '严禁页脚内部制作说明泄露',
        severity: 'major',
        trigger: '页脚出现制作说明',
        exemptions: [],
        criterionCap: 70,
        viewportCap: 75,
        action: 'Major 封顶 70/75',
        scenarios: ['upgrade'],
        scopes: ['homepage'],
      },
      '新增内容红线',
      {
        title: 'upgrade 首页页脚泄露制作口径',
        kind: 'should-catch',
        scenario: 'upgrade',
        scope: 'homepage',
        viewport: 'desktop',
        criterionId: 'sections',
      },
    );

    const { calibration: minorCal } = f.automationStore.checks.createRule(
      {
        id: 'R-CONTENT-02',
        title: '三卡参数格式保持统一',
        severity: 'minor',
        trigger: '三张同类卡片的参数行前缀不一致',
        exemptions: [],
        criterionCap: null,
        viewportCap: null,
        action: '记为 Minor 并提醒统一格式',
        scenarios: ['upgrade'],
        scopes: ['homepage'],
      },
      '测试 minor 规则标定不错误触发失败/封顶预期',
      {
        title: 'Minor 格式不齐标定用例',
        kind: 'should-catch',
        scenario: 'upgrade',
        scope: 'homepage',
        viewport: 'desktop',
        criterionId: 'sections',
      },
    );
    assert.equal(minorCal?.expected.quality, 'passed');
    assert.equal(minorCal?.expected.maxDesktopScore, undefined);
    assert.equal(minorCal?.expected.maxMobileScore, undefined);

    const withCustom = runChecksRegressionSuite(
      f.automationStore.checks.listRules(),
      f.automationStore.checks.listCalibrations(),
      f.directory,
    );
    assert.equal(withCustom.total, 10);
    assert.equal(withCustom.passed, 10);
    assert.equal(withCustom.failed, 0);

    f.automationStore.checks.updateRule('R-CONTENT-01', { enabled: false }, 1, '临时停用测试');
    const afterDisable = runChecksRegressionSuite(
      f.automationStore.checks.listRules(),
      f.automationStore.checks.listCalibrations(),
      f.directory,
    );
    assert.equal(afterDisable.total, 10);
    assert.equal(afterDisable.failed, 1);
    const failedCase = afterDisable.results.find(r => r.ruleId === 'R-CONTENT-01')!;
    assert.equal(failedCase.passed, false);
  } finally {
    await f.cleanup();
  }
});

test('CHECKS REST API supports full lifecycle, false-positive exemption promotion, and regression endpoint', async () => {
  const f = await createChecksApp();
  try {
    const getRes = await f.app.inject({ url: '/api/automation/checks', headers: f.headers });
    assert.equal(getRes.statusCode, 200);
    const getBody = getRes.json();
    assert.equal(getBody.snapshot.rules.length, 7);
    assert.equal(getBody.suggestedIds['R-CONTENT'], 'R-CONTENT-01');

    const postRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/checks',
      headers: f.headers,
      payload: {
        rule: {
          id: 'R-CONTENT-01',
          title: '禁止残留 Lorem ipsum 占位文本',
          severity: 'major',
          trigger: '任意展示区块包含 Lorem ipsum 或未替换示例文字',
          exemptions: [],
          criterionCap: 70,
          viewportCap: 75,
          action: '判定 Major；对应维度 ≤ 70、视口 ≤ 75。',
          scenarios: ['materials', 'upgrade'],
          scopes: ['homepage'],
        },
        reason: 'API 创建规则',
        calibration: {
          title: 'Hero 区出现 Lorem ipsum',
          kind: 'should-catch',
          scenario: 'materials',
          scope: 'homepage',
          viewport: 'desktop',
          criterionId: 'hero',
        },
      },
    });
    assert.equal(postRes.statusCode, 201);
    const createdCalId = postRes.json().calibration.id;

    // Append exemption on R-VISUAL-02 via PUT
    const rVis2 = getBody.snapshot.rules.find((r: { id: string }) => r.id === 'R-VISUAL-02');
    const putRes = await f.app.inject({
      method: 'PUT',
      url: '/api/automation/checks/R-VISUAL-02',
      headers: f.headers,
      payload: {
        revision: rVis2.revision,
        reason: '人工复核纠偏：咖啡豆产区英文名属正当标注',
        appendExemption: '咖啡产地与风味专业英文标签',
        reviewKind: 'false-positive',
        calibration: {
          title: 'R-VISUAL-02 豁免：手冲豆卡产地英文标签',
          kind: 'should-pass',
          scenario: 'upgrade',
          scope: 'homepage',
          viewport: 'desktop',
          criterionId: 'sections',
          expected: {
            quality: 'passed',
            minDesktopScore: 85,
            requireRuleInPrompt: true,
            expectedExemptionText: '咖啡产地与风味专业英文标签',
          },
        },
      },
    });
    assert.equal(putRes.statusCode, 200);
    assert.ok(putRes.json().rule.exemptions.includes('咖啡产地与风味专业英文标签'));

    const regRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/checks/regression',
      headers: f.headers,
    });
    assert.equal(regRes.statusCode, 200);
    const reg = regRes.json();
    assert.equal(reg.total, 10);
    assert.equal(reg.passed, 10);
    assert.equal(reg.failed, 0);

    const delRes = await f.app.inject({
      method: 'DELETE',
      url: `/api/automation/checks/calibrations/${createdCalId}`,
      headers: f.headers,
    });
    assert.equal(delRes.statusCode, 200);

    const histRes = await f.app.inject({ url: '/api/automation/checks/R-VISUAL-02/history', headers: f.headers });
    assert.equal(histRes.statusCode, 200);
    assert.equal(histRes.json().items.length, 2);

    const restoreRes = await f.app.inject({
      method: 'POST',
      url: '/api/automation/checks/R-VISUAL-02/restore',
      headers: f.headers,
      payload: { revision: 2, from: 1, reason: '恢复默认' },
    });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal(restoreRes.json().rule.revision, 3);
  } finally {
    await f.cleanup();
  }
});

test('executeEvaluation freezes CHECKS.md snapshot, accepts custom ruleId in schema, enforces caps, and busts batch cache on change', async () => {
  const f = await createChecksApp();
  try {
    // Promote R-CONTENT-01 with strict cap 68/74
    f.automationStore.checks.createRule(
      {
        id: 'R-CONTENT-01',
        title: '严禁页脚或公开区暴露内部制作口径',
        severity: 'major',
        trigger: '出现“依据客户提供的《...》资料整理”等内部说明文字',
        exemptions: [],
        criterionCap: 68,
        viewportCap: 74,
        action: '判定 Major；对应维度 ≤ 68、视口 ≤ 74。',
        scenarios: ['materials', 'upgrade'],
        scopes: ['homepage', 'site'],
      },
      '单元测试沉淀自定义红线',
    );

    const resource = f.automationStore.saveResource({
      name: 'CHECKS 注入测试资源',
      scenario: 'upgrade',
      description: '云隅咖啡升级',
      contentUrl: `${f.origin}/old`,
      referenceUrl: `${f.origin}/ref`,
      externalSource: '',
      externalId: '',
      files: [],
    });
    const version = f.automationStore.versions(resource.id)[0];
    const site = {
      id: randomUUID(),
      resourceId: resource.id,
      versionId: version.id,
      environmentId: f.envId,
      siteId: 'kooboo-site-1',
      name: 'auto_checks_test',
      url: f.origin,
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);
    const evalTask = f.automationStore.create(
      {
        resourceIds: [resource.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.envId,
        generatedSiteId: site.id,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    evalTask.siteRevision = 'rev-checks-1';
    f.automationStore.put(evalTask);

    let capturedPrompt = '';
    let codexCalls = 0;

    const fakeOpenBrowser: typeof evaluationBrowser = async (_urls, work, _signal, initial, checkpoint, binding) => {
      const evidenceDir = resolve(work, 'evidence');
      mkdirSync(evidenceDir, { recursive: true });
      const activeFiles: MaterialFile[] = structuredClone(initial || []);

      return {
        artifacts: activeFiles,
        env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
        capture: async (raw: unknown) => {
          const req = raw as { action: string; role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; url?: string };
          if (req.action === 'visual_precheck') {
            const vw = req.viewport === 'mobile' ? 390 : 1440;
            const vh = req.viewport === 'mobile' ? 844 : 1000;
            return {
              snapshot: {
                viewport: req.viewport,
                url: req.url || `${f.origin}/`,
                viewportWidth: vw,
                viewportHeight: vh,
                documentHeight: 1000,
                scrollWidth: vw,
                horizontalOverflow: false,
                headerCoversH1: false,
                heroImageCount: 1,
                heroRealImageCount: 1,
                heroMaxImageArea: 250000,
                brokenImageCount: 0,
                svgCandidates: [],
                imageCandidates: [],
                orphanHeadings: [],
                templateResiduals: [],
              },
              signals: [],
            };
          }

          const vw = req.viewport === 'mobile' ? 390 : 1440;
          const vh = req.viewport === 'mobile' ? 844 : 1000;
          const file = `${randomUUID()}.png`;
          const jsonFile = file.replace(/\.png$/, '.json');
          const observation: ScreenshotReceipt & {
            action: string;
            role: string;
            viewport: string;
            capturedAt: number;
            binding?: unknown;
          } = {
            action: 'take_page_screenshots',
            role: req.role,
            viewport: req.viewport,
            capturedAt: Date.now(),
            file,
            url: req.url || `${f.origin}/`,
            position: {
              url: req.url || `${f.origin}/`,
              scrollX: 0,
              scrollY: 0,
              documentHeight: 1000,
              viewportWidth: vw,
              viewportHeight: vh,
              matches: 0,
              invalidSelector: false,
              visible: false,
              nestedScroll: false,
              horizontalOverflow: false,
              regionTop: 0,
              regionBottom: 0,
            },
            readiness: {
              settled: true,
              images: 1,
              pendingImages: 0,
              brokenImages: 0,
              runningAnimations: 0,
              fontsReady: true,
              stableForMs: 500,
            },
            settlement: { settled: true },
            capture: {
              id: randomUUID(),
              index: 1,
              scope: 'page',
              policy: 'viewport-evidence-pc1440-mobile390-v3',
            },
            ...(binding ? { binding } : {}),
          };
          const obsBytes = Buffer.from(JSON.stringify(observation));
          writeFileSync(resolve(evidenceDir, file), TINY_PNG);
          writeFileSync(resolve(evidenceDir, jsonFile), obsBytes);
          activeFiles.push(
            {
              id: randomUUID(),
              name: file,
              type: 'image/png',
              size: TINY_PNG.length,
              sha256: createHash('sha256').update(TINY_PNG).digest('hex'),
              role: req.role,
              viewport: req.viewport,
              settled: true,
            },
            {
              id: randomUUID(),
              name: jsonFile,
              type: 'application/json',
              size: obsBytes.length,
              sha256: createHash('sha256').update(obsBytes).digest('hex'),
              role: req.role,
              viewport: req.viewport,
              settled: true,
            },
          );
          checkpoint?.(structuredClone(activeFiles));
          return {
            action: 'take_page_screenshots',
            status: 'complete',
            coverageComplete: true,
            screenshots: [observation],
            gaps: [],
            nextStartY: null,
          };
        },
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    const codexFactory = () => ({
      startThread: (opts: { outputSchema?: unknown }) => {
        void opts;
        return {
          runStreamed: async (input: unknown, turnOpts?: { outputSchema?: Record<string, unknown> }) => {
            codexCalls++;
            assert.ok(Array.isArray(input));
            capturedPrompt = (input[0] as { text: string }).text;
            const targetDesk = f.automationStore.task(evalTask.id)!.artifacts!.find(a => a.role === 'target' && a.viewport === 'desktop')!.name;
            const refDesk = f.automationStore.task(evalTask.id)!.artifacts!.find(a => a.role === 'reference' && a.viewport === 'desktop')!.name;
            const targetMob = f.automationStore.task(evalTask.id)!.artifacts!.find(a => a.role === 'target' && a.viewport === 'mobile')!.name;
            const refMob = f.automationStore.task(evalTask.id)!.artifacts!.find(a => a.role === 'reference' && a.viewport === 'mobile')!.name;

            // Verify schema dynamically allows R-CONTENT-01 in ruleId enum
            const schemaJson = JSON.stringify(turnOpts?.outputSchema || {});
            assert.match(schemaJson, /R-CONTENT-01/);

            const reply = {
              summary: '评测发现页脚存在内部制作口径文案。',
              assessments: [
                { criterionId: 'hero', viewport: 'desktop', score: 92, reason: 'ok', evidence: [targetDesk, refDesk], passed: true },
                { criterionId: 'structure', viewport: 'desktop', score: 90, reason: 'ok', evidence: [targetDesk, refDesk], passed: true },
                { criterionId: 'sections', viewport: 'desktop', score: 91, reason: '局部给高分等待宿主封顶', evidence: [targetDesk, refDesk], passed: true },
                { criterionId: 'hero', viewport: 'mobile', score: 92, reason: 'ok', evidence: [targetMob, refMob], passed: true },
                { criterionId: 'structure', viewport: 'mobile', score: 90, reason: 'ok', evidence: [targetMob, refMob], passed: true },
                { criterionId: 'sections', viewport: 'mobile', score: 90, reason: 'ok', evidence: [targetMob, refMob], passed: true },
              ],
              issues: [
                {
                  severity: 'major',
                  ruleId: 'R-CONTENT-01',
                  viewport: 'desktop',
                  criterionId: 'sections',
                  title: '页脚暴露内部制作口径说明',
                  detail: '页脚写有“依据客户提供的《...》资料整理”。',
                  evidence: [targetDesk],
                },
              ],
              coverage: { verified: ['已完成双端核验'], unverified: [], outOfScope: [] },
              humanSummary: {
                verdict: 'ready',
                headline: '整体可用',
                highlights: ['首屏良好'],
                topFixes: [],
                unverifiedNote: null,
              },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started' as const, thread_id: `thread-${codexCalls}` };
                yield { type: 'item.completed' as const, item: { id: 'msg-1', type: 'agent_message' as const, text: JSON.stringify(reply) } };
                yield {
                  type: 'turn.completed' as const,
                  usage: {
                    input_tokens: 1000,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    output_tokens: 300,
                    reasoning_output_tokens: 0,
                  },
                };
              })(),
            };
          },
        };
      },
      resumeThread: () => {
        throw new Error('bounded evaluation does not resume threads');
      },
    });

    const runTask = f.automationStore.task(evalTask.id)!;
    await executeEvaluation(
      runTask,
      f.automationStore,
      f.vault,
      f.directory,
      new AbortController().signal,
      { openBrowser: fakeOpenBrowser, createClient: codexFactory as any },
    );
    runTask.status = 'completed';
    runTask.stopped = true;
    f.automationStore.put(runTask);

    const workChecksMd = resolve(f.directory, 'automation-runs', evalTask.id, 'CHECKS.md');
    assert.equal(existsSync(workChecksMd), true);
    assert.match(readFileSync(workChecksMd, 'utf8'), /R-CONTENT-01/);
    assert.match(capturedPrompt, /R-CONTENT-01/);

    const finished = f.automationStore.task(evalTask.id)!;
    assert.equal(finished.status, 'completed');
    assert.ok(finished.report);
    assert.ok(finished.report?.checksSnapshot);
    assert.ok(finished.report!.checksSnapshot!.ruleIds.includes('R-CONTENT-01'));
    assert.equal(finished.report!.quality, 'failed');
    const deskScore = finished.report!.scores.find(s => s.viewport === 'desktop')?.value;
    assert.ok(deskScore !== null && deskScore !== undefined && deskScore <= 74, `Expected desktop score <= 74, got ${deskScore}`);
    assert.equal(finished.report!.assessments.find(a => a.criterionId === 'sections' && a.viewport === 'desktop')?.score, 68);
    assert.notEqual(finished.report!.humanSummary?.verdict, 'ready');

    // Verify GET /api/automation/tasks/:id/sections/report returns evaluation.scenario
    const sectionRes = await f.app.inject({
      url: `/api/automation/tasks/${evalTask.id}/sections/report`,
      headers: f.headers,
    });
    assert.equal(sectionRes.statusCode, 200);
    assert.equal(sectionRes.json().evaluation.scenario, 'upgrade');
    assert.equal(sectionRes.json().evaluation.siteUrl, f.origin);
    assert.equal(codexCalls, 1);

    // Re-running on same CHECKS revision uses batch cache (codexCalls stays 1)
    await executeEvaluation(
      f.automationStore.task(evalTask.id)!,
      f.automationStore,
      f.vault,
      f.directory,
      new AbortController().signal,
      { openBrowser: fakeOpenBrowser, createClient: codexFactory as any },
    );
    assert.equal(codexCalls, 1);

    // Updating CHECKS rule busts batch cache (codexCalls becomes 2)
    f.automationStore.checks.updateRule('R-CONTENT-01', { viewportCap: 72 }, 1, '收紧封顶');
    await executeEvaluation(
      f.automationStore.task(evalTask.id)!,
      f.automationStore,
      f.vault,
      f.directory,
      new AbortController().signal,
      { openBrowser: fakeOpenBrowser, createClient: codexFactory as any },
    );
    assert.equal(codexCalls, 2);
  } finally {
    await f.cleanup();
  }
});

test('CheckerChecksStore incrementally seeds new builtin rules and calibrations into existing DBs without overwriting customized rules', async () => {
  const f = await createChecksApp();
  try {
    const initial = f.automationStore.checks.snapshot();
    assert.ok(initial.rules.some(r => r.id === 'R-LAYOUT-04'));

    // Simulate an existing customized rule + missing newly introduced v1.2 builtin rules/calibrations
    const updatedVisual01 = f.automationStore.checks.updateRule(
      'R-VISUAL-01',
      { viewportCap: 73 },
      1,
      '定制测试阈值',
    );
    assert.equal(updatedVisual01.rule.viewportCap, 73);

    const db = f.automationStore.db;
    db.prepare('DELETE FROM auto_checker_checks WHERE id IN (?, ?, ?)').run('R-LAYOUT-04', 'R-TYPO-01', 'R-DUPE-01');
    db.prepare('DELETE FROM auto_checker_calibrations WHERE id IN (?, ?, ?)').run(
      'cal-r-layout-04-catch',
      'cal-r-typo-01-catch',
      'cal-r-dupe-01-catch',
    );

    // Re-opening store should restore only the missing builtin rules/calibrations while keeping R-VISUAL-01 edits
    const { CheckerChecksStore } = await import('../server/automation/checker-checks.js');
    const reopenedStore = new CheckerChecksStore(db);
    const snap = reopenedStore.snapshot();

    assert.equal(snap.rules.length, 7);
    assert.equal(snap.calibrations.length, 8);
    assert.equal(snap.rules.find(r => r.id === 'R-VISUAL-01')?.viewportCap, 73);
    assert.equal(snap.rules.find(r => r.id === 'R-LAYOUT-04')?.viewportCap, 78);
    assert.equal(snap.rules.find(r => r.id === 'R-TYPO-01')?.criterionCap, 75);
    assert.equal(snap.rules.find(r => r.id === 'R-DUPE-01')?.viewportCap, 85);
  } finally {
    await f.cleanup();
  }
});
