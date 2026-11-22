import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { executeEvaluation, codexClient } from '../server/automation/evaluator.js';
import { ManifestStore } from '../server/automation/completeness.js';
import {
  aggregateMultiBatchAssessments,
  canUseBoundedSiteEvaluation,
  planSiteVisualBatches,
} from '../server/automation/bounded-site-evaluator.js';
import type { evaluationBrowser } from '../server/automation/browser.js';
import type { ScreenshotReceipt } from '../server/automation/page-screenshots.js';
import { evaluateVisualPrecheckSignals, type RawViewportPrecheckSnapshot } from '../server/automation/visual-precheck.js';
import {
  defaultAutomationSettings,
  type AutomationRule,
  type AutomationTask,
  type MaterialFile,
} from '../shared/automation.js';
import { defaultLearningSettings } from '../shared/experience.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=',
  'base64',
);

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeUniquePng(label: string): Buffer {
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'ascii'), Buffer.from(`Comment\0${label}`, 'utf8')]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(typeAndData.length - 4, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([TINY_PNG.subarray(0, -12), length, typeAndData, crc, TINY_PNG.subarray(-12)]);
}

async function setupSiteEnv(options?: {
  withBackendApi?: (url: URL, body: unknown) => unknown;
  onResponses?: (body: unknown) => void;
}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'bounded-site-'));
  const db = new Database(':memory:');
  const store = new AutomationStore(db);
  const vault = new Vault(resolve(directory, 'vault'));

  const upstream = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      if (parsedUrl.pathname === '/v1/responses') {
        let parsedBody: unknown;
        try {
          parsedBody = raw ? JSON.parse(raw) : {};
        } catch {
          parsedBody = {};
        }
        options?.onResponses?.(parsedBody);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"type":"response.completed","response":{"id":"r1","model":"deepseek-flash-1017","status":"completed","usage":{"input_tokens":10,"output_tokens":10}}}\n\n',
        );
        return;
      }
      if (options?.withBackendApi && !parsedUrl.pathname.startsWith('/v1')) {
        let parsedBody: unknown;
        try {
          parsedBody = raw ? JSON.parse(raw) : undefined;
        } catch {
          parsedBody = raw;
        }
        const value = options.withBackendApi(parsedUrl, parsedBody);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([]));
    });
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const addr = upstream.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

  const environmentId = randomUUID();
  vault.update({
    ...vault.get(),
    threshold: 80,
    model: { endpoint: `${origin}/v1`, name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [{ id: environmentId, name: 'Test', origin, apiOrigin: origin, token: 'test-token' }],
  });
  const settings = structuredClone(defaultAutomationSettings);
  settings.learning = { ...defaultLearningSettings, use: false, collect: false };
  vault.updateAutomation({
    ...settings,
    evaluationEndpoint: `${origin}/v1`,
    evaluationModel: 'deepseek-flash-1017',
  });

  return {
    directory,
    db,
    store,
    vault,
    environmentId,
    settings,
    async close() {
      upstream.closeAllConnections();
      await new Promise<void>(done => upstream.close(() => done()));
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('canUseBoundedSiteEvaluation enforces active scenario/site gating and manifest bounds', () => {
  const baseRule: AutomationRule = {
    id: randomUUID(),
    name: 'Site UI',
    kind: 'site',
    sop: 'sop',
    references: '',
    createdAt: Date.now(),
    hash: 'h',
    criteria: [
      { id: 'hero', label: 'Hero', weight: 100, instruction: 'ok', required: false, viewports: ['desktop', 'mobile'], scopes: ['site'] },
    ],
  };
  const makeTask = (overrides: Partial<AutomationTask> = {}): AutomationTask =>
    ({
      id: randomUUID(),
      kind: 'evaluation',
      resourceId: randomUUID(),
      versionId: randomUUID(),
      resourceName: 'Test Site',
      scenario: 'materials',
      scope: 'site',
      environmentId: randomUUID(),
      generatedSiteId: randomUUID(),
      parentId: null,
      message: '全站评测',
      status: 'running',
      stopped: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '',
      context: '',
      threadId: '',
      rule: baseRule,
      report: null,
      siteUrl: 'https://target.example.test/',
      model: null,
      ...overrides,
    }) as AutomationTask;

  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask({ scenario: 'materials' }) }), true);
  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask({ scenario: 'upgrade' }) }), true);
  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask({ scenario: 'migration' }) }), true);

  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask({ scope: 'homepage' }) }), false);
  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask({ scenario: 'site-template' }) }), false);
  assert.equal(
    canUseBoundedSiteEvaluation({
      task: makeTask({
        templateWorkflow: { rootTaskId: 'r1', phase: 'evaluate', version: 1, checklistId: 'c1' } as unknown as AutomationTask['templateWorkflow'],
      }),
    }),
    false,
  );
  assert.equal(canUseBoundedSiteEvaluation({ task: makeTask(), program: { target: {} } }), false);
  assert.equal(
    canUseBoundedSiteEvaluation({
      task: makeTask(),
      manifest: {
        id: 'm1',
        taskId: 't1',
        revision: 1,
        createdAt: 1,
        sourceComplete: false,
        limitations: ['unknown'],
        items: [{ id: 'p1', title: 'Home', kind: 'page', required: true, source: 's', expectation: 'e', paths: ['/'], expectedCount: 1, viewports: ['desktop', 'mobile'] }],
        evidence: [],
        actor: 'ai',
      },
    }),
    false,
  );
  assert.equal(
    canUseBoundedSiteEvaluation({
      task: makeTask(),
      manifest: {
        id: 'm2',
        taskId: 't1',
        revision: 1,
        createdAt: 1,
        sourceComplete: true,
        limitations: [],
        items: [
          {
            id: 'd1',
            title: 'Relations',
            kind: 'data',
            required: true,
            source: 's',
            expectation: 'e',
            paths: ['/'],
            expectedCount: 1,
            expectedKeys: ['["https://a.test/","https://a.test/1"]'],
            dataIdentity: { kind: 'relations', parentRequirementIds: ['p1'], childRequirementIds: ['p1'] },
            viewports: ['business'],
          },
        ],
        evidence: [],
        actor: 'human',
      },
    }),
    false,
  );

  // Clean manifest within 12 paths returns true
  assert.equal(
    canUseBoundedSiteEvaluation({
      task: makeTask({ scenario: 'upgrade' }),
      manifest: {
        id: 'm3',
        taskId: 't1',
        revision: 1,
        createdAt: 1,
        sourceComplete: true,
        limitations: [],
        items: [
          { id: 'p1', title: 'Pages', kind: 'page', required: true, source: 's', expectation: 'e', paths: ['/', '/about', '/contact'], expectedCount: 3, viewports: ['desktop', 'mobile'] },
        ],
        evidence: [],
        actor: 'human',
      },
    }),
    true,
  );
});

test('planSiteVisualBatches and aggregateMultiBatchAssessments preserve worst-page failure without dilution', () => {
  const mkImg = (name: string, viewport: 'desktop' | 'mobile') => ({
    name,
    absPath: `/tmp/${name}`,
    role: 'target' as const,
    viewport,
    sha256: name,
    width: 1440,
    height: 1000,
    scrollY: 0,
    action: 'take_page_screenshots',
  });
  const batches = planSiteVisualBatches(
    [
      { path: '/', url: 'https://t.test/', desktopImages: [mkImg('d1.png', 'desktop'), mkImg('d2.png', 'desktop'), mkImg('d3.png', 'desktop')], mobileImages: [mkImg('m1.png', 'mobile')], prechecks: [] },
      { path: '/about', url: 'https://t.test/about', desktopImages: [mkImg('d4.png', 'desktop'), mkImg('d5.png', 'desktop')], mobileImages: [mkImg('m2.png', 'mobile')], prechecks: [] },
      { path: '/pricing', url: 'https://t.test/pricing', desktopImages: [mkImg('d6.png', 'desktop'), mkImg('d7.png', 'desktop')], mobileImages: [mkImg('m3.png', 'mobile')], prechecks: [] },
    ],
    ['desktop', 'mobile'],
    6,
  );

  // Desktop: (3+2)=5 fits <=6, then 2 splits into a 2nd batch; Mobile: all 3 fit in 1 batch
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0].paths, ['/', '/about']);
  assert.deepEqual(batches[1].paths, ['/pricing']);
  assert.deepEqual(batches[2].paths, ['/', '/about', '/pricing']);

  const criteria: AutomationRule['criteria'] = [
    { id: 'hero', label: 'Hero', weight: 100, instruction: 'Hero check', required: false, viewports: ['desktop', 'mobile'], scopes: ['site'] },
  ];
  const agg = aggregateMultiBatchAssessments(
    [
      { criterionId: 'hero', viewport: 'desktop', score: 92, passed: true, reason: '首页良', evidence: ['d1.png'] },
      { criterionId: 'hero', viewport: 'desktop', score: 62, passed: false, reason: '定价页 Hero 使用大型几何 SVG', evidence: ['d6.png'] },
      { criterionId: 'hero', viewport: 'mobile', score: 90, passed: true, reason: '移动全端良', evidence: ['m1.png', 'm2.png', 'm3.png'] },
    ],
    criteria,
    ['desktop', 'mobile'],
  );

  const dHero = agg.find(a => a.viewport === 'desktop')!;
  assert.equal(dHero.passed, false);
  assert.equal(dHero.score, 62);
  assert.deepEqual(dHero.evidence, ['d1.png', 'd6.png']);
});

test('non-manifest materials/site bounded evaluation discovers inner pages, runs <=2 concurrent turns, records overflow unverified, and propagates inner Major defect', async () => {
  const f = await setupSiteEnv({
    withBackendApi: (url) => {
      if (url.pathname.endsWith('Page/All')) {
        return [
          { route: '/about', online: true },
          { route: '/products/{id}', online: true },
          { route: '/pricing', online: true },
          { route: '/team', online: true },
          { route: '/blog', online: true },
          { route: '/faq', online: true },
          { route: '/legal', online: true },
        ];
      }
      return [];
    },
  });

  try {
    const resource = f.store.saveResource({
      name: '全站无图资料站',
      scenario: 'materials',
      description: '打造多页面设计工作室官网（首页、关于、定价、联系）',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const siteId = randomUUID();
    f.store.saveSite({
      id: siteId,
      resourceId: resource.id,
      versionId: f.store.versions(resource.id)[0].id,
      environmentId: f.environmentId,
      siteId: 'kooboo-site-multi',
      name: 'studio-multi',
      url: 'https://studio.example.test/',
      createdAt: Date.now(),
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: siteId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.requirementsEnabled = false;
    task.siteRevision = 'rev-multi-1';
    task.status = 'running';
    task.stopped = false;
    f.store.put(task);

    const activeFiles: MaterialFile[] = [];
    const seenPrecheckUrls: string[] = [];
    const skipMenuByUrl = new Map<string, boolean>();
    let workDir = '';

    const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, _initial, checkpoint) => {
      workDir = work;
      return {
        artifacts: activeFiles,
        env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
        capture: async (raw: unknown) => {
          const input = raw as {
            action: string;
            role: 'target' | 'reference';
            viewport: 'desktop' | 'mobile';
            url?: string;
            skipMobileMenuProbe?: boolean;
          };
          const targetUrl = input.url || 'https://studio.example.test/';
          const path = new URL(targetUrl).pathname;

          if (input.action === 'take_page_screenshots') {
            const shots: ScreenshotReceipt[] = [];
            const captureId = randomUUID();
            const count = path === '/' ? 4 : 3;
            for (let i = 0; i < count; i++) {
              const fileName = `${randomUUID()}.png`;
              const bytes = makeUniquePng(`${path}-${input.viewport}-${i}`);
              const obs = {
                action: 'take_page_screenshots',
                role: input.role,
                viewport: input.viewport,
                url: targetUrl,
                file: fileName,
                capturedAt: Date.now() + i,
                position: {
                  url: targetUrl,
                  scrollX: 0,
                  scrollY: i * 800,
                  documentHeight: count * 800,
                  viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
                  viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
                  matches: 0,
                  invalidSelector: false,
                  visible: false,
                  nestedScroll: false,
                  horizontalOverflow: false,
                  regionTop: 0,
                  regionBottom: 0,
                },
                capture: { id: captureId, index: i + 1, scope: 'page' as const, policy: 'test' },
                readiness: {
                  settled: true,
                  images: 2,
                  pendingImages: 0,
                  brokenImages: 0,
                  runningAnimations: 0,
                  fontsReady: true,
                  stableForMs: 400,
                },
                binding: { taskId: task.id, siteRevision: task.siteRevision },
                settlement: { settled: true },
              };
              const obsBytes = Buffer.from(JSON.stringify(obs));
              writeFileSync(resolve(work, 'evidence', fileName), bytes);
              writeFileSync(resolve(work, 'evidence', fileName.replace('.png', '.json')), obsBytes);
              activeFiles.push(
                { id: randomUUID(), name: fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: 'image/png', role: input.role, viewport: input.viewport, settled: true },
                { id: randomUUID(), name: fileName.replace('.png', '.json'), size: obsBytes.length, sha256: createHash('sha256').update(obsBytes).digest('hex'), type: 'application/json', role: input.role, viewport: input.viewport, settled: true },
              );
              shots.push(obs);
            }
            checkpoint?.(structuredClone(activeFiles));
            return {
              action: 'take_page_screenshots',
              status: 'complete',
              coverageComplete: true,
              screenshots: shots,
              gaps: [],
              nextStartY: null,
              nextSelectorIndex: null,
            };
          }

          if (input.action === 'visual_precheck') {
            seenPrecheckUrls.push(`${input.viewport}:${path}`);
            if (input.viewport === 'mobile') {
              skipMenuByUrl.set(path, Boolean(input.skipMobileMenuProbe));
            }
            const isBrokenHeroSvg = path === '/about' && input.viewport === 'desktop';
            const snap: RawViewportPrecheckSnapshot = {
              viewport: input.viewport,
              url: targetUrl,
              viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
              viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
              documentHeight: 2400,
              scrollWidth: input.viewport === 'mobile' ? 390 : 1440,
              horizontalOverflow: false,
              headerCoversH1: false,
              heroImageCount: isBrokenHeroSvg ? 0 : 1,
              heroRealImageCount: isBrokenHeroSvg ? 0 : 1,
              heroMaxImageArea: isBrokenHeroSvg ? 0 : 500000,
              brokenImageCount: 0,
              svgCandidates: isBrokenHeroSvg
                ? [{ inHero: true, width: 640, height: 420, viewportAreaRatio: 0.25, primitiveCount: 6, hasChartText: false, tagPath: 'section > svg', top: 100, left: 100 }]
                : [],
              imageCandidates: [],
              orphanHeadings: [],
              templateResiduals: [],
              internalLinks: path === '/' ? ['/contact'] : [],
              seoMeta: { title: 'Studio', description: 'Desc', canonical: targetUrl, robots: 'index,follow', h1Count: 1 },
            };
            return { snapshot: snap, signals: evaluateVisualPrecheckSignals(snap) };
          }
          throw new Error('Unexpected action');
        },
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    let activeTurns = 0;
    let maxConcurrentTurns = 0;
    let batchCount = 0;

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (inputs: Array<{ type: string; text?: string; path?: string }>) => {
          batchCount++;
          activeTurns++;
          maxConcurrentTurns = Math.max(maxConcurrentTurns, activeTurns);
          await new Promise(r => setTimeout(r, 20));
          activeTurns--;

          const promptText = inputs.find(i => i.type === 'text')?.text || '';
          const isMobile = /本批视口：mobile/.test(promptText);
          const hasAbout = promptText.includes('/about');
          const attachedPngs = inputs.filter(i => i.type === 'local_image').map(i => i.path!.split('/').pop()!);
          const firstPng = attachedPngs[0]!;

          const reply = {
            summary: `${isMobile ? 'mobile' : 'desktop'} 批次核验完成。`,
            assessments: [
              {
                criterionId: 'hero',
                viewport: isMobile ? 'mobile' : 'desktop',
                score: !isMobile && hasAbout ? 62 : 91,
                passed: !(!isMobile && hasAbout),
                reason: !isMobile && hasAbout ? '关于页 Hero 使用大型几何 SVG 占位' : '视觉正常',
                evidence: [firstPng],
              },
              { criterionId: 'structure', viewport: isMobile ? 'mobile' : 'desktop', score: 90, passed: true, reason: 'ok', evidence: [firstPng] },
              { criterionId: 'sections', viewport: isMobile ? 'mobile' : 'desktop', score: 89, passed: true, reason: 'ok', evidence: [firstPng] },
            ],
            issues:
              !isMobile && hasAbout
                ? [
                    {
                      severity: 'major',
                      ruleId: 'R-VISUAL-01',
                      viewport: 'desktop',
                      criterionId: 'hero',
                      title: '关于页 Hero 使用抽象 SVG 占位替代实景',
                      detail: '关于页首屏检测到大型非图表 SVG 充当主视觉',
                      evidence: [firstPng],
                    },
                  ]
                : [],
            coverage: { verified: ['已抽样核验本批页面'], unverified: [], outOfScope: [] },
            humanSummary: {
              verdict: !isMobile && hasAbout ? 'needs-fixes' : 'ready',
              headline: !isMobile && hasAbout ? '关于页存在主视觉 SVG 占位问题' : '通过',
              highlights: ['首页首屏采用真实照片。'],
              topFixes: !isMobile && hasAbout ? ['为关于页补充 imagePlaceholder 实景摄影。'] : [],
              unverifiedNote: null,
            },
          };

          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 3000, output_tokens: 900 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.ok(task.report);
    assert.ok(maxConcurrentTurns <= 2);
    assert.ok(batchCount >= 4 && batchCount <= 6);
    assert.equal(skipMenuByUrl.get('/'), false);
    assert.equal(skipMenuByUrl.get('/about'), true);

    const precheckFacts = JSON.parse(readFileSync(resolve(workDir, 'precheck-facts.json'), 'utf8')) as {
      discoveredPages: string[];
      overflowPages: string[];
    };
    // 6 capped pages ('/', '/about', '/blog', '/contact', '/faq', '/legal') + 2 overflow ('/pricing', '/team')
    assert.equal(precheckFacts.discoveredPages.length, 6);
    assert.deepEqual(precheckFacts.overflowPages, ['/pricing', '/team']);
    assert.ok(task.report.coverage.unverified.some(line => line.includes('/pricing') && line.includes('/team')));

    // Desktop Hero score must retain inner-page Major failure (<= 70) without averaging over /pricing & /blog
    const desktopHero = task.report.assessments.find(a => a.viewport === 'desktop' && a.criterionId === 'hero')!;
    assert.equal(desktopHero.passed, false);
    assert.ok(desktopHero.score !== null && desktopHero.score <= 70);
    assert.equal(task.report.quality, 'failed');
    assert.equal(task.report.humanSummary?.verdict, 'needs-fixes');
    assert.ok(seenPrecheckUrls.includes('desktop:/about'));
  } finally {
    await f.close();
  }
});

for (const simulateMissingRecord of [false, true]) {
  test(`manifest-backed upgrade/site bounded evaluation runs visual + business batches, validates completeness, and enforces R-COVER-04 (missingRecord=${simulateMissingRecord})`, async () => {
    const f = await setupSiteEnv({
      withBackendApi: (url) => {
        if (url.pathname.endsWith('Sqlite/Data')) {
          const list = simulateMissingRecord
            ? [[{ key: 'slug', value: 'a1' }, { key: 'title', value: 'First Article' }]]
            : [
                [{ key: 'slug', value: 'a1' }, { key: 'title', value: 'First Article' }],
                [{ key: 'slug', value: 'a2' }, { key: 'title', value: 'Second Article' }],
              ];
          return {
            list,
            pageNr: 1,
            totalPages: 1,
            totalCount: list.length,
          };
        }
        if (url.pathname.endsWith('Page/All')) {
          return [{ route: '/', online: true }, { route: '/about', online: true }];
        }
        return [];
      },
    });

    try {
      const resource = f.store.saveResource({
        name: '全站升级测试',
        scenario: 'upgrade',
        description: '完整升级企业站',
        contentUrl: 'https://source.example.test/',
        referenceUrl: 'https://ref.example.test/',
        files: [],
        externalSource: '',
        externalId: '',
      });
      const siteId = randomUUID();
      f.store.saveSite({
        id: siteId,
        resourceId: resource.id,
        versionId: f.store.versions(resource.id)[0].id,
        environmentId: f.environmentId,
        siteId: 'kooboo-upgrade-site',
        name: 'upgrade-site',
        url: 'https://target.example.test/',
        createdAt: Date.now(),
      });
      const task = f.store.create(
        {
          resourceIds: [resource.id],
          kind: 'evaluation',
          scope: 'site',
          environmentId: f.environmentId,
          generatedSiteId: siteId,
          requirements: '',
        },
        f.settings,
      )[0];
      task.siteRevision = 'rev-upgrade-1';
      task.status = 'running';
      task.stopped = false;
      task.rule = f.store.rules().find(r => r.scenarios?.includes('upgrade'))!;
      f.store.put(task);

      new ManifestStore(f.store).save(
        task,
        {
          sourceComplete: true,
          limitations: [],
          evidence: [],
          items: [
            {
              id: 'pages',
              title: 'Static Pages',
              kind: 'page',
              required: true,
              source: 'source sitemap',
              expectation: 'Home & About rendered cleanly on desktop/mobile',
              paths: ['/', '/about'],
              expectedCount: 2,
              viewports: ['desktop', 'mobile'],
            },
            {
              id: 'articles',
              title: 'Articles Data',
              kind: 'data',
              required: true,
              source: 'source cms',
              expectation: 'All 2 articles present in Sqlite Articles',
              paths: ['/'],
              expectedCount: 2,
              expectedKeys: ['a1', 'a2'],
              dataIdentity: { kind: 'page' },
              records: { storage: 'sqlite', container: 'Articles', keyField: 'slug', requiredFields: ['title'] },
              viewports: ['business'],
            },
          ],
        },
        'human',
      );

      const activeFiles: MaterialFile[] = [];
      let workDir = '';

      const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, _initial, checkpoint) => {
        workDir = work;
        return {
          artifacts: activeFiles,
          env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
          capture: async (raw: unknown) => {
            const input = raw as { action: string; role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; url?: string };
            const targetUrl = input.url || 'https://target.example.test/';
            if (input.action === 'take_page_screenshots') {
              const fileName = `${randomUUID()}.png`;
              const bytes = makeUniquePng(`${input.role}-${targetUrl}-${input.viewport}`);
              const obs = {
                action: 'take_page_screenshots',
                role: input.role,
                viewport: input.viewport,
                url: targetUrl,
                capturedAt: Date.now(),
                file: fileName,
                position: {
                  url: targetUrl,
                  scrollX: 0,
                  scrollY: 0,
                  documentHeight: 800,
                  viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
                  viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
                  matches: 0,
                  invalidSelector: false,
                  visible: false,
                  nestedScroll: false,
                  horizontalOverflow: false,
                  regionTop: 0,
                  regionBottom: 0,
                },
                capture: { id: randomUUID(), index: 1, scope: 'page' as const, policy: 'test' },
                readiness: { settled: true, images: 1, pendingImages: 0, brokenImages: 0, runningAnimations: 0, fontsReady: true, stableForMs: 400 },
                binding: { taskId: task.id, siteRevision: task.siteRevision },
                settlement: { settled: true },
              };
              const obsBytes = Buffer.from(JSON.stringify(obs));
              writeFileSync(resolve(work, 'evidence', fileName), bytes);
              writeFileSync(resolve(work, 'evidence', fileName.replace('.png', '.json')), obsBytes);
              activeFiles.push(
                { id: randomUUID(), name: fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: 'image/png', role: input.role, viewport: input.viewport, settled: true },
                { id: randomUUID(), name: fileName.replace('.png', '.json'), size: obsBytes.length, sha256: createHash('sha256').update(obsBytes).digest('hex'), type: 'application/json', role: input.role, viewport: input.viewport, settled: true },
              );
              checkpoint?.(structuredClone(activeFiles));
              return { action: 'take_page_screenshots', status: 'complete', coverageComplete: true, screenshots: [obs], gaps: [], nextStartY: null, nextSelectorIndex: null };
            }
            const snap: RawViewportPrecheckSnapshot = {
              viewport: input.viewport,
              url: targetUrl,
              viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
              viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
              documentHeight: 800,
              scrollWidth: input.viewport === 'mobile' ? 390 : 1440,
              horizontalOverflow: false,
              headerCoversH1: false,
              heroImageCount: 1,
              heroRealImageCount: 1,
              heroMaxImageArea: 400000,
              brokenImageCount: 0,
              svgCandidates: [],
              imageCandidates: [],
              orphanHeadings: [],
              templateResiduals: [],
              internalLinks: [],
              seoMeta: { title: 'Target', description: 'Meta', canonical: targetUrl, robots: 'index,follow', h1Count: 1 },
            };
            return { snapshot: snap, signals: [] };
          },
          close: async () => {},
        } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
      };

      const createClient = ((() => ({
        startThread: () => ({
          runStreamed: async (inputs: Array<{ type: string; text?: string; path?: string }>) => {
            const promptText = inputs.find(i => i.type === 'text')?.text || '';
            const isBusiness = promptText.includes('全站业务/SEO/后台实现与完整度专项批次');

            if (isBusiness) {
              const implFiles = activeFiles.filter(file => /^implementation-.*\.json$/.test(file.name)).map(file => file.name);
              assert.ok(implFiles.length > 0);
              const readPngFor = (path: string, vp: 'desktop' | 'mobile') =>
                activeFiles.find(file => {
                  if (file.type !== 'image/png' || file.role !== 'target' || file.viewport !== vp) return false;
                  const obs = JSON.parse(readFileSync(resolve(workDir, 'evidence', file.name.replace('.png', '.json')), 'utf8')) as { url?: string };
                  return obs.url && new URL(obs.url).pathname === path;
                })!.name;

              const reply = {
                summary: '后台与 SEO 专项核验完成。',
                assessments: [
                  { criterionId: 'dynamic-implementation', viewport: 'business', score: 90, passed: true, reason: '动态数据结构合理', evidence: [implFiles[0]] },
                  { criterionId: 'seo-migration', viewport: 'business', score: 88, passed: true, reason: 'SEO 元数据就绪', evidence: [implFiles[0]] },
                ],
                issues: [],
                coverage: { verified: ['Sqlite 文章记录与 SEO 元数据'], unverified: [], outOfScope: [] },
                completeness: [
                  {
                    id: 'pages',
                    status: 'verified',
                    reason: '双端首页与关于页截图齐全',
                    evidence: [
                      readPngFor('/', 'desktop'),
                      readPngFor('/', 'mobile'),
                      readPngFor('/about', 'desktop'),
                      readPngFor('/about', 'mobile'),
                    ],
                    checkedViewports: ['desktop', 'mobile'],
                    actualCount: 2,
                    sampledPaths: ['/', '/about'],
                    checkedKeys: [],
                  },
                  {
                    id: 'articles',
                    status: 'verified',
                    reason: '依宿主对账注入完整键',
                    evidence: [implFiles[0]],
                    checkedViewports: ['business'],
                    actualCount: null,
                    sampledPaths: ['/'],
                    checkedKeys: [],
                  },
                ],
                humanSummary: {
                  verdict: 'ready',
                  headline: '后台数据与页面清单完整',
                  highlights: ['静态页面与动态数据完整'],
                  topFixes: [],
                  unverifiedNote: null,
                },
              };

              return {
                events: (async function* () {
                  yield { type: 'thread.started', thread_id: randomUUID() };
                  yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                  yield { type: 'turn.completed', usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 600 } };
                })(),
              };
            }

            const isMobile = /本批视口：mobile/.test(promptText);
            const vp = isMobile ? 'mobile' : 'desktop';
            const targetPng = activeFiles.find(file => file.type === 'image/png' && file.role === 'target' && file.viewport === vp)!.name;
            const refPng = activeFiles.find(file => file.type === 'image/png' && file.role === 'reference' && file.viewport === vp)!.name;

            const reply = {
              summary: `${vp} 视觉完成`,
              assessments: ['hero', 'structure', 'sections', 'completeness'].map(id => ({
                criterionId: id,
                viewport: vp,
                score: 91,
                passed: true,
                reason: 'ok',
                evidence: [targetPng, refPng],
              })),
              issues: [],
              coverage: { verified: [vp], unverified: [], outOfScope: [] },
              humanSummary: {
                verdict: 'ready',
                headline: `${vp} 达标`,
                highlights: ['视觉结构一致'],
                topFixes: [],
                unverifiedNote: null,
              },
            };

            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 6000, cached_input_tokens: 2000, output_tokens: 700 } };
              })(),
            };
          },
        }),
      })) as unknown) as typeof codexClient;

      await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
        openBrowser,
        createClient,
      });

      assert.ok(task.report);
      assert.ok(task.report.completeness);
      assert.equal(existsSync(resolve(workDir, 'precheck-facts.json')), true);

      if (simulateMissingRecord) {
        assert.equal(task.report.completeness.state, 'incomplete');
        assert.equal(task.report.quality, 'failed');
        assert.notEqual(task.report.humanSummary?.verdict, 'ready');
        assert.ok(task.report.issues.some(issue => issue.severity === 'major' && issue.detail.includes('R-COVER-04')));
      } else {
        assert.equal(task.report.completeness.state, 'complete');
        assert.equal(task.report.quality, 'passed');
        assert.equal(task.report.humanSummary?.verdict, 'ready');
        const articlesCheck = task.report.completeness.checks.find(c => c.id === 'articles')!;
        assert.equal(articlesCheck.status, 'verified');
        assert.equal(articlesCheck.actualCount, 2);
        assert.deepEqual(articlesCheck.checkedKeys, ['a1', 'a2']);
      }
    } finally {
      await f.close();
    }
  });
}

test('single-batch Codex code 1 crash retries on a fresh thread without aborting sibling batch, and bounded site uses 32768 maxOutputTokens', async () => {
  const seenResponseBodies: Array<{ max_output_tokens?: number }> = [];
  const f = await setupSiteEnv({
    withBackendApi: url => {
      if (url.pathname.endsWith('Page/All')) {
        return [{ route: '/', online: true }, { route: '/about', online: true }];
      }
      return [];
    },
    onResponses: body => {
      seenResponseBodies.push(body as { max_output_tokens?: number });
    },
  });

  try {
    const resource = f.store.saveResource({
      name: '并发单批重试实测',
      scenario: 'materials',
      description: '两页官网',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const siteId = randomUUID();
    f.store.saveSite({
      id: siteId,
      resourceId: resource.id,
      versionId: f.store.versions(resource.id)[0].id,
      environmentId: f.environmentId,
      siteId: 'kooboo-retry-site',
      name: 'retry-site',
      url: 'https://target.example.test/',
      createdAt: Date.now(),
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: siteId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.requirementsEnabled = false;
    task.siteRevision = 'rev-retry-site';
    task.status = 'running';
    task.stopped = false;
    f.store.put(task);

    const activeFiles: MaterialFile[] = [];
    const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, initial, checkpoint) => {
      activeFiles.push(...(initial || []));
      return {
        artifacts: activeFiles,
        env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
        capture: async (raw: unknown) => {
          const input = raw as { action: string; role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; url?: string };
          const targetUrl = input.url || 'https://target.example.test/';
          if (input.action === 'take_page_screenshots') {
            const fileName = `${randomUUID()}.png`;
            const bytes = makeUniquePng(`${input.role}-${targetUrl}-${input.viewport}`);
            const obs = {
              action: 'take_page_screenshots',
              role: input.role,
              viewport: input.viewport,
              url: targetUrl,
              capturedAt: Date.now(),
              file: fileName,
              position: {
                url: targetUrl,
                scrollX: 0,
                scrollY: 0,
                documentHeight: 800,
                viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
                viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
                matches: 0,
                invalidSelector: false,
                visible: false,
                nestedScroll: false,
                horizontalOverflow: false,
                regionTop: 0,
                regionBottom: 0,
              },
              capture: { id: randomUUID(), index: 1, scope: 'page' as const, policy: 'test' },
              readiness: { settled: true, images: 1, pendingImages: 0, brokenImages: 0, runningAnimations: 0, fontsReady: true, stableForMs: 400 },
              binding: { taskId: task.id, siteRevision: task.siteRevision },
              settlement: { settled: true },
            };
            const obsBytes = Buffer.from(JSON.stringify(obs));
            writeFileSync(resolve(work, 'evidence', fileName), bytes);
            writeFileSync(resolve(work, 'evidence', fileName.replace('.png', '.json')), obsBytes);
            activeFiles.push(
              { id: randomUUID(), name: fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: 'image/png', role: input.role, viewport: input.viewport, settled: true },
              { id: randomUUID(), name: fileName.replace('.png', '.json'), size: obsBytes.length, sha256: createHash('sha256').update(obsBytes).digest('hex'), type: 'application/json', role: input.role, viewport: input.viewport, settled: true },
            );
            checkpoint?.(structuredClone(activeFiles));
            return { action: 'take_page_screenshots', status: 'complete', coverageComplete: true, screenshots: [obs], gaps: [], nextStartY: null, nextSelectorIndex: null };
          }
          const snap: RawViewportPrecheckSnapshot = {
            viewport: input.viewport,
            url: targetUrl,
            viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
            viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
            documentHeight: 800,
            scrollWidth: input.viewport === 'mobile' ? 390 : 1440,
            horizontalOverflow: false,
            headerCoversH1: false,
            heroImageCount: 1,
            heroRealImageCount: 1,
            heroMaxImageArea: 400000,
            brokenImageCount: 0,
            svgCandidates: [],
            imageCandidates: [],
            orphanHeadings: [],
            templateResiduals: [],
            internalLinks: [],
            seoMeta: { title: 'Site', description: 'Meta', canonical: targetUrl, robots: 'index,follow', h1Count: 1 },
          };
          return { snapshot: snap, signals: [] };
        },
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    const visualCriteria = task.rule!.criteria.filter(c => c.scopes.includes('site') && c.viewports.some(v => v === 'desktop' || v === 'mobile'));
    const businessCriteria = task.rule!.criteria.filter(c => c.scopes.includes('site') && c.viewports.includes('business'));
    let desktopAttempts = 0;
    let mobileFinishedCount = 0;
    let threadSeq = 0;

    const createClient = ((
      _vault: unknown,
      _dir: unknown,
      env: Record<string, string>,
    ) => ({
      startThread: () => {
        const threadName = `site-thread-${++threadSeq}`;
        return {
          runStreamed: async (inputs: Array<{ type: string; text?: string }>, opts: { signal?: AbortSignal }) => {
            const promptText = inputs.find(i => i.type === 'text')?.text || '';
            // Verify actual loopback proxy injects max_output_tokens = 32768 for bounded site evaluation
            if (!seenResponseBodies.length) {
              const relayRes = await fetch(`${env.AUTOMATION_RESPONSES_URL}/responses`, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${env.EVALUATOR_MODEL_KEY}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ model: 'deepseek-flash-1017', input: 'budget check' }),
              });
              assert.equal(relayRes.status, 200);
              await relayRes.text();
            }

            if (promptText.includes('全站业务/SEO/后台实现与完整度专项批次')) {
              const implFile = activeFiles.find(file => /^implementation-.*\.json$/.test(file.name))!.name;
              const reply = {
                summary: '业务批完成。',
                assessments: businessCriteria.map(c => ({
                  criterionId: c.id,
                  viewport: 'business' as const,
                  score: 90,
                  passed: true,
                  reason: 'ok',
                  evidence: [implFile],
                })),
                issues: [],
                coverage: { verified: ['SEO与业务'], unverified: [], outOfScope: [] },
                humanSummary: { verdict: 'ready', headline: '业务正常', highlights: ['ok'], topFixes: [], unverifiedNote: null },
              };
              return {
                events: (async function* () {
                  yield { type: 'thread.started', thread_id: threadName };
                  yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                  yield { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } };
                })(),
              };
            }

            const isMobile = /本批视口：mobile/.test(promptText);
            const vp = isMobile ? 'mobile' : 'desktop';
            if (!isMobile) {
              desktopAttempts++;
              if (desktopAttempts === 1) {
                throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
              }
              assert.match(promptText, /重试紧凑输出提醒/);
            } else {
              // Slight delay ensures desktop's crash overlaps sibling mobile execution without aborting it
              await new Promise(r => setTimeout(r, 30));
              assert.equal(opts.signal?.aborted, false);
              mobileFinishedCount++;
            }

            const targetPng = activeFiles.find(file => file.type === 'image/png' && file.role === 'target' && file.viewport === vp)!.name;
            const reply = {
              summary: `${vp} 视觉完成`,
              assessments: visualCriteria
                .filter(c => c.viewports.includes(vp))
                .map(c => ({
                  criterionId: c.id,
                  viewport: vp,
                  score: 91,
                  passed: true,
                  reason: 'ok',
                  evidence: [targetPng],
                })),
              issues: [],
              coverage: { verified: [vp], unverified: [], outOfScope: [] },
              humanSummary: { verdict: 'ready', headline: `${vp} 达标`, highlights: ['构图清晰'], topFixes: [], unverifiedNote: null },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: threadName };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 600 } };
              })(),
            };
          },
        };
      },
    })) as unknown as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(desktopAttempts, 2);
    assert.equal(mobileFinishedCount, 1);
    assert.ok(seenResponseBodies.length >= 1);
    assert.equal(seenResponseBodies[0].max_output_tokens, 32768);
    assert.ok(task.report);
    assert.equal(task.report.quality, 'passed');
    // Verify !task.threadId guard kept first started threadId instead of last concurrent clobber
    assert.ok(task.threadId.startsWith('site-thread-'));
    const events = f.store.events(task.id).map(e => e.message);
    assert.ok(events.some(msg => msg.includes('有界全站批次重试 1/1（desktop#1')));
  } finally {
    await f.close();
  }
});

test('disk batch cache reuses all verified batches across resumed runs and selectively drops tampered entries', async () => {
  const f = await setupSiteEnv({
    withBackendApi: url => {
      if (url.pathname.endsWith('Page/All')) {
        return [{ route: '/', online: true }, { route: '/about', online: true }];
      }
      return [];
    },
  });

  try {
    const resource = f.store.saveResource({
      name: '全站缓存复用测试',
      scenario: 'materials',
      description: '两页官网缓存测试',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const siteId = randomUUID();
    f.store.saveSite({
      id: siteId,
      resourceId: resource.id,
      versionId: f.store.versions(resource.id)[0].id,
      environmentId: f.environmentId,
      siteId: 'kooboo-cache-site',
      name: 'cache-site',
      url: 'https://target.example.test/',
      createdAt: Date.now(),
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: siteId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.requirementsEnabled = false;
    task.siteRevision = 'rev-cache-1';
    task.status = 'running';
    task.stopped = false;
    if (task.rule && !task.rule.criteria.some(c => c.scopes.includes('site') && c.viewports.includes('business'))) {
      task.rule = {
        ...task.rule,
        criteria: [
          ...task.rule.criteria,
          { id: 'seo-cache-check', label: 'SEO Meta', weight: 10, instruction: '检查 SEO', required: false, viewports: ['business'], scopes: ['site'] },
        ],
      };
    }
    f.store.put(task);

    const workDir = resolve(f.directory, 'automation-runs', task.id);
    const activeFiles: MaterialFile[] = [];
    const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, initial, checkpoint) => {
      activeFiles.length = 0;
      activeFiles.push(...(initial || []));
      return {
        artifacts: activeFiles,
        env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
        capture: async (raw: unknown) => {
          const input = raw as { action: string; role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; url?: string };
          const targetUrl = input.url || 'https://target.example.test/';
          if (input.action === 'take_page_screenshots') {
            const fileName = `${randomUUID()}.png`;
            const bytes = makeUniquePng(`${input.role}-${targetUrl}-${input.viewport}`);
            const obs = {
              action: 'take_page_screenshots',
              role: input.role,
              viewport: input.viewport,
              url: targetUrl,
              capturedAt: Date.now(),
              file: fileName,
              position: {
                url: targetUrl,
                scrollX: 0,
                scrollY: 0,
                documentHeight: 800,
                viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
                viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
                matches: 0,
                invalidSelector: false,
                visible: false,
                nestedScroll: false,
                horizontalOverflow: false,
                regionTop: 0,
                regionBottom: 0,
              },
              capture: { id: randomUUID(), index: 1, scope: 'page' as const, policy: 'test' },
              readiness: { settled: true, images: 1, pendingImages: 0, brokenImages: 0, runningAnimations: 0, fontsReady: true, stableForMs: 400 },
              binding: { taskId: task.id, siteRevision: task.siteRevision },
              settlement: { settled: true },
            };
            const obsBytes = Buffer.from(JSON.stringify(obs));
            writeFileSync(resolve(work, 'evidence', fileName), bytes);
            writeFileSync(resolve(work, 'evidence', fileName.replace('.png', '.json')), obsBytes);
            activeFiles.push(
              { id: randomUUID(), name: fileName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), type: 'image/png', role: input.role, viewport: input.viewport, settled: true },
              { id: randomUUID(), name: fileName.replace('.png', '.json'), size: obsBytes.length, sha256: createHash('sha256').update(obsBytes).digest('hex'), type: 'application/json', role: input.role, viewport: input.viewport, settled: true },
            );
            checkpoint?.(structuredClone(activeFiles));
            return { action: 'take_page_screenshots', status: 'complete', coverageComplete: true, screenshots: [obs], gaps: [], nextStartY: null, nextSelectorIndex: null };
          }
          const snap: RawViewportPrecheckSnapshot = {
            viewport: input.viewport,
            url: targetUrl,
            viewportWidth: input.viewport === 'mobile' ? 390 : 1440,
            viewportHeight: input.viewport === 'mobile' ? 844 : 1000,
            documentHeight: 800,
            scrollWidth: input.viewport === 'mobile' ? 390 : 1440,
            horizontalOverflow: false,
            headerCoversH1: false,
            heroImageCount: 1,
            heroRealImageCount: 1,
            heroMaxImageArea: 400000,
            brokenImageCount: 0,
            svgCandidates: [],
            imageCandidates: [],
            orphanHeadings: [],
            templateResiduals: [],
            internalLinks: [],
            seoMeta: { title: 'CacheSite', description: 'Meta', canonical: targetUrl, robots: 'index,follow', h1Count: 1 },
          };
          return { snapshot: snap, signals: [] };
        },
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    const visualCriteria = task.rule!.criteria.filter(c => c.scopes.includes('site') && c.viewports.some(v => v === 'desktop' || v === 'mobile'));
    const businessCriteria = task.rule!.criteria.filter(c => c.scopes.includes('site') && c.viewports.includes('business'));
    let modelCalls = 0;

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (inputs: Array<{ type: string; text?: string }>) => {
          modelCalls++;
          const promptText = inputs.find(i => i.type === 'text')?.text || '';
          if (promptText.includes('全站业务/SEO/后台实现与完整度专项批次')) {
            const implFile = activeFiles.find(file => /^implementation-.*\.json$/.test(file.name))!.name;
            const reply = {
              summary: '业务完成',
              assessments: businessCriteria.map(c => ({
                criterionId: c.id,
                viewport: 'business' as const,
                score: 90,
                passed: true,
                reason: 'ok',
                evidence: [implFile],
              })),
              issues: [],
              coverage: { verified: ['业务'], unverified: [], outOfScope: [] },
              humanSummary: { verdict: 'ready', headline: '业务正常', highlights: ['ok'], topFixes: [], unverifiedNote: null },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } };
              })(),
            };
          }

          const vp = /本批视口：mobile/.test(promptText) ? 'mobile' : 'desktop';
          const targetPng = activeFiles.find(file => file.type === 'image/png' && file.role === 'target' && file.viewport === vp)!.name;
          const reply = {
            summary: `${vp} 完成`,
            assessments: visualCriteria
              .filter(c => c.viewports.includes(vp))
              .map(c => ({
                criterionId: c.id,
                viewport: vp,
                score: 92,
                passed: true,
                reason: 'ok',
                evidence: [targetPng],
              })),
            issues: [],
            coverage: { verified: [vp], unverified: [], outOfScope: [] },
            humanSummary: { verdict: 'ready', headline: `${vp} 达标`, highlights: ['视觉正常'], topFixes: [], unverifiedNote: null },
          };
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 500 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    // Run 1: populates bounded-batch-cache.json (desktop + mobile + business = 3 model calls)
    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });
    const firstRunCalls = modelCalls;
    assert.equal(firstRunCalls, 3);
    const cachePath = resolve(workDir, 'bounded-batch-cache.json');
    assert.equal(existsSync(cachePath), true);

    // Run 2: same work dir + same artifacts -> 0 model calls
    modelCalls = 0;
    task.report = null;
    task.status = 'running';
    task.error = '';
    f.store.put(task);
    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });
    assert.equal(modelCalls, 0);
    const run2Report = (task as AutomationTask).report;
    assert.ok(run2Report);
    assert.equal(run2Report.quality, 'passed');
    const eventsAfterRun2 = f.store.events(task.id).map(e => e.message);
    assert.equal(eventsAfterRun2.filter(m => m.includes('复用已验证批次缓存')).length, 3);

    // Run 3: tamper 1 cache entry with a forged evidence filename -> only that 1 batch re-runs!
    const cacheJson = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { assessments?: Array<{ evidence: string[] }> }>;
    const firstKey = Object.keys(cacheJson)[0];
    cacheJson[firstKey].assessments![0].evidence = ['forged-nonexistent.png'];
    writeFileSync(cachePath, JSON.stringify(cacheJson, null, 2));

    modelCalls = 0;
    task.report = null;
    task.status = 'running';
    task.error = '';
    f.store.put(task);
    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });
    assert.equal(modelCalls, 1);
    const run3Report = (task as AutomationTask).report;
    assert.ok(run3Report);
    assert.equal(run3Report.quality, 'passed');
    const eventsAfterRun3 = f.store.events(task.id).map(e => e.message);
    // 3 hits from Run 2 + 2 clean hits in Run 3 = 5 total cache hit logs
    assert.equal(eventsAfterRun3.filter(m => m.includes('复用已验证批次缓存')).length, 5);
  } finally {
    await f.close();
  }
});

test('planSiteVisualBatches pairs target slices with sampled reference images and never emits reference-only batches', () => {
  const mkImg = (name: string, role: 'target' | 'reference') => ({
    name,
    absPath: `/tmp/${name}`,
    role,
    viewport: 'desktop' as const,
    sha256: name,
    width: 1440,
    height: 1000,
    scrollY: 0,
    action: 'take_page_screenshots',
  });
  const desktopImages = [
    ...Array.from({ length: 8 }, (_, i) => mkImg(`t-${i}.png`, 'target')),
    ...Array.from({ length: 6 }, (_, i) => mkImg(`r-${i}.png`, 'reference')),
  ];
  const batches = planSiteVisualBatches(
    [{ path: '/', url: 'https://t.test/', desktopImages, mobileImages: [], prechecks: [] }],
    ['desktop'],
    10,
  );

  assert.equal(batches.length, 2);
  for (const batch of batches) {
    assert.ok(batch.images.length <= 10, `expected <= 10 images, got ${batch.images.length}`);
    assert.ok(batch.images.some(img => img.role === 'target'), 'every batch must contain target screenshots');
    assert.ok(batch.images.some(img => img.role === 'reference'), 'every batch must contain reference screenshots');
  }
  const allTargets = batches.flatMap(b => b.images.filter(i => i.role === 'target').map(i => i.name));
  assert.equal(new Set(allTargets).size, 8);
});
