import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  collectBatchImages,
  extractBoundedMaterialNotes,
  hasCompleteRetainedCapture,
  planHomepageBatches,
  sampleReferenceImages,
  type BatchImage,
} from '../server/automation/bounded-evaluator.js';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { executeEvaluation, codexClient } from '../server/automation/evaluator.js';
import { verifyDelivery } from '../server/automation/delivery.js';
import type { evaluationBrowser } from '../server/automation/browser.js';
import type { ScreenshotReceipt } from '../server/automation/page-screenshots.js';
import { evaluateVisualPrecheckSignals, type RawViewportPrecheckSnapshot } from '../server/automation/visual-precheck.js';
import { defaultAutomationSettings, type AutomationTask, type MaterialFile } from '../shared/automation.js';
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

async function setupEnv() {
  const directory = mkdtempSync(resolve(tmpdir(), 'bounded-eval-'));
  const db = new Database(':memory:');
  const store = new AutomationStore(db);
  const vault = new Vault(resolve(directory, 'vault'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Target Site</h1></body></html>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const envId = randomUUID();

  vault.update({
    ...vault.get(),
    threshold: 80,
    model: { endpoint: `${origin}/v1`, name: 'deepseek-flash-1017', apiKey: 'test-key' },
    environments: [{ id: envId, name: 'TestEnv', origin, apiOrigin: origin, token: 'test-token' }],
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
    origin,
    envId,
    settings,
    async close() {
      await new Promise<void>(done => server.close(() => done()));
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function makeHomepageCriteria() {
  return [
    {
      id: 'hero',
      label: '首屏与主视觉',
      weight: 40,
      instruction: '检查首屏构图、视觉主体与 CTA',
      required: false,
      viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
      scopes: ['homepage', 'site'] as ('homepage' | 'site')[],
    },
    {
      id: 'structure',
      label: '页面结构',
      weight: 40,
      instruction: '检查区段顺序与双端适配',
      required: false,
      viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
      scopes: ['homepage', 'site'] as ('homepage' | 'site')[],
    },
    {
      id: 'sections',
      label: '内容区段',
      weight: 20,
      instruction: '检查卡片文案与图文表现',
      required: false,
      viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
      scopes: ['homepage', 'site'] as ('homepage' | 'site')[],
    },
  ];
}

function createMockOpenBrowser(options: {
  scrollOffsetsPerViewport?: number[];
  withHeroSvgPrecheck?: boolean;
  withUnsettledFiniteAnimation?: boolean;
  withPendingImageGap?: boolean;
  withNextStartY?: number | null;
  withMobileMenuTrapProbe?: boolean;
}) {
  const scrollOffsets = options.scrollOffsetsPerViewport || [0, 850];
  let activeFiles: MaterialFile[] = [];

  const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, initial, checkpoint, binding) => {
    activeFiles = structuredClone(initial || []);
    return {
      artifacts: activeFiles,
      env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
      capture: async (raw: unknown) => {
        const req = raw as { action: string; role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; url?: string };
        if (req.action === 'visual_precheck') {
          const vw = req.viewport === 'mobile' ? 390 : 1440;
          const vh = req.viewport === 'mobile' ? 844 : 1000;
          let probePngFile: string | undefined;
          if (req.viewport === 'mobile' && options.withMobileMenuTrapProbe) {
            probePngFile = `${randomUUID()}.png`;
            const jsonFile = probePngFile.replace(/\.png$/, '.json');
            const pngBytes = makeUniquePng(`probe:${req.viewport}:${probePngFile}`);
            const obs = {
              action: 'visual_precheck',
              probe: 'mobile-menu-open',
              role: 'target',
              viewport: 'mobile',
              url: req.url || 'https://target.test/',
              title: 'Target Site',
              file: probePngFile,
              capturedAt: Date.now() + 99,
              navigationStatus: 200,
              snapshot: '',
              text: 'Menu overlay',
              textTruncated: false,
              frames: [],
              framesComplete: true,
              settlement: { settled: true, loaded: true, networkIdle: false, images: 0, pendingImages: 0, blankImageRatio: 0 },
              ...(binding ? { binding } : {}),
            };
            const obsBytes = Buffer.from(JSON.stringify(obs));
            writeFileSync(resolve(work, 'evidence', probePngFile), pngBytes);
            writeFileSync(resolve(work, 'evidence', jsonFile), obsBytes);
            activeFiles.push(
              {
                id: randomUUID(),
                name: probePngFile,
                type: 'image/png',
                size: pngBytes.length,
                sha256: createHash('sha256').update(pngBytes).digest('hex'),
                role: 'target',
                viewport: 'mobile',
                settled: true,
              },
              {
                id: randomUUID(),
                name: jsonFile,
                type: 'application/json',
                size: obsBytes.length,
                sha256: createHash('sha256').update(obsBytes).digest('hex'),
                role: 'target',
                viewport: 'mobile',
                settled: true,
              },
            );
            checkpoint?.(structuredClone(activeFiles));
          }
          const snapshot: RawViewportPrecheckSnapshot = {
            viewport: req.viewport,
            url: req.url || 'https://target.test/',
            viewportWidth: vw,
            viewportHeight: vh,
            documentHeight: 1800,
            scrollWidth: vw,
            horizontalOverflow: false,
            headerCoversH1: false,
            heroImageCount: options.withHeroSvgPrecheck ? 0 : 1,
            heroRealImageCount: options.withHeroSvgPrecheck ? 0 : 1,
            heroMaxImageArea: options.withHeroSvgPrecheck ? 0 : 250000,
            brokenImageCount: 0,
            svgCandidates: options.withHeroSvgPrecheck
              ? [
                  {
                    inHero: true,
                    width: 480,
                    height: 480,
                    viewportAreaRatio: 0.16,
                    primitiveCount: 6,
                    hasChartText: false,
                    tagPath: 'main > section.hero > svg',
                    top: 120,
                    left: 720,
                  },
                ]
              : [],
            imageCandidates: [],
            orphanHeadings: [],
            templateResiduals: [],
            ...(req.viewport === 'mobile' && options.withMobileMenuTrapProbe
              ? {
                  mobileMenu: {
                    tested: true,
                    toggleFound: true,
                    opened: true,
                    hasVisibleCloseControl: false,
                    closeWorked: false,
                    occludedToggle: true,
                    openScreenshotFile: probePngFile,
                  },
                }
              : {}),
          };
          return { snapshot, signals: evaluateVisualPrecheckSignals(snapshot) };
        }

        if (req.action === 'screenshot') {
          const file = `${randomUUID()}.png`;
          const jsonFile = file.replace(/\.png$/, '.json');
          const pngBytes = makeUniquePng(`${req.role}:${req.viewport}:${req.url || ''}:${file}`);
          const obs = {
            action: 'screenshot' as const,
            role: req.role,
            viewport: req.viewport,
            url: req.url || '',
            title: 'Target Site',
            file,
            capturedAt: Date.now(),
            navigationStatus: 200 as number | undefined,
            snapshot: '',
            text: 'Target Site',
            textTruncated: false,
            frames: [] as { url: string; title: string; text: string; textTruncated: boolean }[],
            framesComplete: true,
            settlement: {
              settled: true,
              loaded: true,
              networkIdle: true,
              images: 1,
              pendingImages: 0,
              blankImageRatio: 0,
            },
          };
          const obsBytes = Buffer.from(JSON.stringify(obs));
          writeFileSync(resolve(work, 'evidence', file), pngBytes);
          writeFileSync(resolve(work, 'evidence', jsonFile), obsBytes);
          activeFiles.push(
            {
              id: randomUUID(),
              name: file,
              type: 'image/png',
              size: pngBytes.length,
              sha256: createHash('sha256').update(pngBytes).digest('hex'),
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
          return { ...obs, imagePath: resolve(work, 'evidence', file) };
        }

        assert.equal(req.action, 'take_page_screenshots');
        const captureId = randomUUID();
        const vw = req.viewport === 'mobile' ? 390 : 1440;
        const vh = req.viewport === 'mobile' ? 844 : 1000;
        const docHeight = scrollOffsets[scrollOffsets.length - 1] + vh;
        const gaps: string[] = [];
        const screenshots: ScreenshotReceipt[] = [];
        for (const [idx, scrollY] of scrollOffsets.entries()) {
          const isUnsettledFinite = Boolean(options.withUnsettledFiniteAnimation && idx === 0);
          const isPendingImage = Boolean(options.withPendingImageGap && idx === 0);
          const screenSettled = !isUnsettledFinite && !isPendingImage;
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
            capturedAt: Date.now() + idx,
            file,
            url: req.url || 'https://target.test/',
            position: {
              url: req.url || 'https://target.test/',
              scrollX: 0,
              scrollY,
              documentHeight: docHeight,
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
              settled: screenSettled,
              images: 1,
              pendingImages: isPendingImage ? 1 : 0,
              brokenImages: 0,
              runningAnimations: isUnsettledFinite ? 1 : 0,
              fontsReady: true,
              stableForMs: screenSettled ? 500 : 0,
            },
            settlement: { settled: screenSettled },
            capture: {
              id: captureId,
              index: idx + 1,
              scope: 'page',
              policy: 'viewport-evidence-pc1440-mobile390-v3',
            },
            ...(binding ? { binding } : {}),
          };
          if (!screenSettled) {
            gaps.push(
              `Screenshot ${idx + 1} did not settle: ${isPendingImage ? 1 : 0} pending images, 0 broken images, ${
                isUnsettledFinite ? 1 : 0
              } running finite animations, fontsReady=true, stableForMs=0.`,
            );
          }
          const pngBytes = makeUniquePng(`${req.role}:${req.viewport}:${idx}:${scrollY}:${file}`);
          const obsBytes = Buffer.from(JSON.stringify(observation));
          writeFileSync(resolve(work, 'evidence', file), pngBytes);
          writeFileSync(resolve(work, 'evidence', jsonFile), obsBytes);
          activeFiles.push(
            {
              id: randomUUID(),
              name: file,
              type: 'image/png',
              size: pngBytes.length,
              sha256: createHash('sha256').update(pngBytes).digest('hex'),
              role: req.role,
              viewport: req.viewport,
              settled: screenSettled,
            },
            {
              id: randomUUID(),
              name: jsonFile,
              type: 'application/json',
              size: obsBytes.length,
              sha256: createHash('sha256').update(obsBytes).digest('hex'),
              role: req.role,
              viewport: req.viewport,
              settled: screenSettled,
            },
          );
          screenshots.push(observation);
        }
        checkpoint?.(structuredClone(activeFiles));
        const nextStartY = options.withNextStartY ?? null;
        const coverageComplete = gaps.length === 0 && nextStartY === null;
        return {
          action: 'take_page_screenshots',
          status: coverageComplete ? 'complete' : 'partial',
          coverageComplete,
          screenshots,
          gaps,
          nextStartY,
          nextSelectorIndex: null,
        };
      },
      close: async () => {},
    };
  };

  return openBrowser;
}

test('bounded homepage evaluation runs 1 read-only local_image turn, creates budget account, writes precheck/report, and enforces R-VISUAL-01 cap', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '星禾空间测试',
      scenario: 'materials',
      description: '建筑灯光设计工作室官网',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-1';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'Xinghe',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    const openBrowser = createMockOpenBrowser({ scrollOffsetsPerViewport: [0, 850], withHeroSvgPrecheck: true });
    let threadCount = 0;
    let turnCount = 0;
    const seenInputs: unknown[] = [];

    const createClient = ((() => ({
      startThread: (opts: { sandboxMode?: string; networkAccessEnabled?: boolean }) => {
        threadCount++;
        assert.equal(opts.sandboxMode, 'read-only');
        assert.equal(opts.networkAccessEnabled, false);
        return {
          runStreamed: async (input: unknown[]) => {
            turnCount++;
            seenInputs.push(input);
            const images = input.filter((b: any) => b.type === 'local_image') as { type: string; path: string }[];
            assert.equal(images.length, 4); // 2 desktop + 2 mobile <= 10 -> single turn
            const textBlock = input[0] as { type: string; text: string };
            assert.match(textBlock.text, /HERO_SVG_PLACEHOLDER/);
            const workDir = resolve(f.directory, 'automation-runs', task.id);
            const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
            const dPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'desktop')!.name;
            const mPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'mobile')!.name;
            const reply = {
              summary: '排版完整，但首屏右侧使用抽象 SVG 占位。',
              assessments: [
                { criterionId: 'hero', viewport: 'desktop', score: 96, reason: '模型误给了虚高分', evidence: [dPng], passed: true },
                { criterionId: 'structure', viewport: 'desktop', score: 93, reason: '结构完整', evidence: [dPng], passed: true },
                { criterionId: 'sections', viewport: 'desktop', score: 85, reason: '区段完整', evidence: [dPng], passed: true },
                { criterionId: 'hero', viewport: 'mobile', score: 95, reason: '移动端首屏虚高', evidence: [mPng], passed: true },
                { criterionId: 'structure', viewport: 'mobile', score: 94, reason: '移动端结构', evidence: [mPng], passed: true },
                { criterionId: 'sections', viewport: 'mobile', score: 94, reason: '移动端区段', evidence: [mPng], passed: true },
              ],
              issues: [
                {
                  severity: 'major',
                  ruleId: 'R-VISUAL-01',
                  viewport: 'both',
                  criterionId: 'hero',
                  title: 'Hero 使用廉价几何 SVG 占位',
                  detail: '缺少真实项目实景图或 imagePlaceholder',
                  evidence: [dPng, mPng],
                },
              ],
              coverage: { verified: ['双端首屏与结构'], unverified: [], outOfScope: [] },
              humanSummary: {
                verdict: 'ready',
                headline: '看起来不错',
                highlights: ['深色排版'],
                topFixes: [],
                unverifiedNote: null,
              },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 15000, cached_input_tokens: 5000, output_tokens: 3000 } };
              })(),
            };
          },
        };
      },
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(threadCount, 1);
    assert.equal(turnCount, 1);
    assert.ok(task.report);
    // Host cap must bring desktop/mobile down to <= 75 and hero <= 70
    assert.ok((task.report.scores.find(s => s.viewport === 'desktop')?.value ?? 100) <= 75);
    assert.ok((task.report.scores.find(s => s.viewport === 'mobile')?.value ?? 100) <= 75);
    assert.ok((task.report.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'desktop')?.score ?? 100) <= 70);
    assert.equal(task.report.quality, 'failed');
    assert.equal(task.report.humanSummary?.verdict, 'needs-fixes');

    const workDir = resolve(f.directory, 'automation-runs', task.id);
    assert.equal(existsSync(resolve(workDir, 'precheck-facts.json')), true);
    assert.equal(existsSync(resolve(workDir, 'report.json')), true);

    const budgetAccount = f.db
      .prepare('SELECT id FROM auto_model_accounts WHERE id = ?')
      .get(`evaluation:${task.id}`) as { id: string } | undefined;
    assert.ok(budgetAccount);

    const usageRows = f.db.prepare('SELECT json FROM auto_usage WHERE task_id = ?').all(task.id);
    assert.equal(usageRows.length, 1);
  } finally {
    await f.close();
  }
});

test('bounded homepage evaluation splits into 2 sequential viewport turns when >10 PNGs and passes clean sites after stripping boilerplate unverified', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '晨光烘焙双批测试',
      scenario: 'upgrade',
      description: '精品烘焙单页',
      contentUrl: f.origin,
      referenceUrl: f.origin,
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-2';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'Bakery',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    // 3 screens × (target + reference) × 2 viewports = 12 PNGs (> 10 -> 2 sequential batches)
    const openBrowser = createMockOpenBrowser({ scrollOffsetsPerViewport: [0, 850, 1700], withHeroSvgPrecheck: false });
    let turnCount = 0;

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (input: unknown[]) => {
          turnCount++;
          const text = (input[0] as { text: string }).text;
          const isDesktop = text.includes('本批视口：desktop');
          const viewport: 'desktop' | 'mobile' = isDesktop ? 'desktop' : 'mobile';
          const images = input.filter((b: any) => b.type === 'local_image') as { path: string }[];
          assert.equal(images.length, 6); // 3 target + 3 reference for this viewport

          const workDir = resolve(f.directory, 'automation-runs', task.id);
          const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
          const targetPng = manifest.find(m => m.type === 'image/png' && m.role === 'target' && m.viewport === viewport)!.name;
          const refPng = manifest.find(m => m.type === 'image/png' && m.role === 'reference' && m.viewport === viewport)!.name;

          const reply = {
            summary: `${viewport} 端达标`,
            assessments: [
              { criterionId: 'hero', viewport, score: 92, reason: '真实面包摄影还原度高', evidence: [targetPng, refPng], passed: true },
              { criterionId: 'structure', viewport, score: 91, reason: '结构顺序一致', evidence: [targetPng, refPng], passed: true },
              { criterionId: 'sections', viewport, score: 90, reason: '内容区段自然', evidence: [targetPng, refPng], passed: true },
            ],
            issues: [],
            coverage: {
              verified: [`${viewport} 端视觉与结构`],
              unverified: ['正式域名上线、搜索引擎收录与未来权重未核验'],
              outOfScope: [],
            },
            humanSummary: {
              verdict: 'ready',
              headline: '达标可交付',
              highlights: ['真实摄影图文一致'],
              topFixes: [],
              unverifiedNote: null,
            },
          };
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 6000, output_tokens: 2000 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(turnCount, 2);
    assert.ok(task.report);
    assert.equal(task.report.assessments.length, 6);
    assert.deepEqual(task.report.coverage.unverified, []);
    assert.ok(task.report.coverage.outOfScope.some(item => item.includes('正式域名上线')));
    assert.equal(task.report.quality, 'passed');
    assert.equal(task.report.humanSummary?.verdict, 'ready');
  } finally {
    await f.close();
  }
});

test('verifyDelivery pre-captures target/reference screenshots, strips sourceReport.artifacts filenames, enforces budget, and completes in 1 read-only turn', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '交付测试站',
      scenario: 'materials',
      description: '单页',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.status = 'completed';
    task.stopped = true;
    task.siteUrl = f.origin;
    const oldSourcePng = `${randomUUID()}.png`;
    task.report = {
      summary: '源站合格',
      quality: 'passed',
      scores: [
        { viewport: 'desktop', value: 91 },
        { viewport: 'mobile', value: 90 },
      ],
      assessments: [],
      issues: [],
      coverage: { verified: ['全部'], unverified: [], outOfScope: [] },
      artifacts: [
        {
          id: randomUUID(),
          name: oldSourcePng,
          type: 'image/png',
          size: TINY_PNG.length,
          sha256: createHash('sha256').update(TINY_PNG).digest('hex'),
          role: 'target',
          viewport: 'desktop',
        },
      ],
    };
    const deliveryId = randomUUID();
    task.delivery = {
      id: deliveryId,
      policy: { enabled: true, endpoint: `${f.origin}/migrate`, auto: false, requirePassed: true, timeoutSeconds: 60 },
      status: 'verifying',
      sourceEnvironmentId: f.envId,
      sourceSiteId: randomUUID(),
      sourceUrl: f.origin,
      evaluationTaskId: task.id,
      target: { siteId: randomUUID(), siteUrl: f.origin },
      updatedAt: Date.now(),
      error: '',
      checks: [],
    };
    f.store.put(task);

    const openBrowser = createMockOpenBrowser({});
    let turnCount = 0;

    const createClient = ((() => ({
      startThread: (opts: { sandboxMode?: string; networkAccessEnabled?: boolean }) => {
        assert.equal(opts.sandboxMode, 'read-only');
        assert.equal(opts.networkAccessEnabled, false);
        return {
          runStreamed: async (input: unknown[]) => {
            turnCount++;
            const images = input.filter((b: any) => b.type === 'local_image') as { path: string }[];
            assert.equal(images.length, 4); // target/reference × desktop/mobile

            const deliveryWork = resolve(f.directory, 'automation-runs', task.id, 'delivery', deliveryId);
            const taskJsonRaw = readFileSync(resolve(deliveryWork, 'task.json'), 'utf8');
            assert.equal(taskJsonRaw.includes(oldSourcePng), false, 'delivery task.json must not leak old sourceReport artifact filenames');
            const parsedTaskJson = JSON.parse(taskJsonRaw) as Record<string, unknown>;
            assert.ok(parsedTaskJson.sourceSummary);
            assert.equal('sourceReport' in parsedTaskJson, false);

            const manifest = JSON.parse(readFileSync(resolve(deliveryWork, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
            const pngNames = manifest.filter(m => m.type === 'image/png').map(m => m.name);

            const reply = {
              summary: '目标站与源站双端画面及核心路径一致',
              verified: ['首页桌面与移动布局、导航及正文一致'],
              unverified: [],
              outOfScope: ['正式域名上线与搜索引擎收录'],
              evidence: pngNames,
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 8000, cached_input_tokens: 2000, output_tokens: 800 } };
              })(),
            };
          },
        };
      },
    })) as unknown) as typeof codexClient;

    await verifyDelivery(task as AutomationTask, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(turnCount, 1);
    assert.equal(task.delivery!.status, 'completed');
    assert.equal(task.delivery!.error, '');

    const budgetAccount = f.db
      .prepare('SELECT id FROM auto_model_accounts WHERE id = ?')
      .get(`delivery:${task.id}:${deliveryId}`) as { id: string } | undefined;
    assert.ok(budgetAccount);
  } finally {
    await f.close();
  }
});

test('bounded homepage evaluation ignores finite-animation settle notices when images/fonts and range are complete, while genuine pending-image or range truncation triggers unverified', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '云隅咖啡动画测试',
      scenario: 'materials',
      description: '精品咖啡馆官网',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });

    const createEvalTask = () => {
      const task = f.store.create(
        {
          resourceIds: [resource.id],
          kind: 'generation',
          scope: 'homepage',
          environmentId: f.envId,
          requirements: '',
        },
        f.settings,
      )[0];
      task.kind = 'evaluation';
      task.siteRevision = 'rev-anim';
      task.generatedSiteId = randomUUID();
      task.status = 'running';
      task.stopped = false;
      task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
      task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
      f.store.saveSite({
        id: task.generatedSiteId,
        resourceId: resource.id,
        versionId: task.versionId,
        environmentId: f.envId,
        siteId: randomUUID(),
        name: 'Yunyu',
        url: f.origin,
        createdAt: Date.now(),
      });
      f.store.put(task);
      return task;
    };

    const makeClient = (taskId: string) =>
      ((() => ({
        startThread: () => ({
          runStreamed: async () => {
            const workDir = resolve(f.directory, 'automation-runs', taskId);
            const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
            const dPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'desktop')!.name;
            const mPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'mobile')!.name;
            const reply = {
              summary: '首屏与各区段均为真实摄影且排版完整。',
              assessments: [
                { criterionId: 'hero', viewport: 'desktop', score: 92, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'structure', viewport: 'desktop', score: 91, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'sections', viewport: 'desktop', score: 90, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'hero', viewport: 'mobile', score: 93, reason: 'ok', evidence: [mPng], passed: true },
                { criterionId: 'structure', viewport: 'mobile', score: 91, reason: 'ok', evidence: [mPng], passed: true },
                { criterionId: 'sections', viewport: 'mobile', score: 90, reason: 'ok', evidence: [mPng], passed: true },
              ],
              issues: [],
              coverage: { verified: ['双端首页'], unverified: [], outOfScope: [] },
              humanSummary: {
                verdict: 'ready',
                headline: '达到可交付水准',
                highlights: ['真实摄影'],
                topFixes: [],
                unverifiedNote: null,
              },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: randomUUID() };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 1000 } };
              })(),
            };
          },
        }),
      })) as unknown) as typeof codexClient;

    // 1. Finite CSS animation unsettled notice with 0 pending images, 0 broken images, fontsReady=true & covered range => PASSED
    const animTask = createEvalTask();
    await executeEvaluation(animTask, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser: createMockOpenBrowser({
        scrollOffsetsPerViewport: [0, 700],
        withUnsettledFiniteAnimation: true,
      }),
      createClient: makeClient(animTask.id),
    });
    assert.ok(animTask.report);
    assert.deepEqual(animTask.report.coverage.unverified, []);
    assert.equal(animTask.report.quality, 'passed');
    assert.equal(animTask.report.humanSummary?.verdict, 'ready');
    const precheckFacts = JSON.parse(
      readFileSync(resolve(f.directory, 'automation-runs', animTask.id, 'precheck-facts.json'), 'utf8'),
    ) as { captureGaps: string[]; captureNotes: string[] };
    assert.deepEqual(precheckFacts.captureGaps, []);
    assert.equal(precheckFacts.captureNotes.length, 2);

    // 2. Genuine pending image => UNVERIFIED
    const pendingTask = createEvalTask();
    await executeEvaluation(pendingTask, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser: createMockOpenBrowser({
        scrollOffsetsPerViewport: [0, 700],
        withPendingImageGap: true,
      }),
      createClient: makeClient(pendingTask.id),
    });
    assert.ok(pendingTask.report);
    assert.ok(pendingTask.report.coverage.unverified.length >= 2);
    assert.equal(pendingTask.report.quality, 'unverified');
    assert.equal(pendingTask.report.humanSummary?.verdict, 'incomplete-check');

    // 3. Truncated vertical capture (nextStartY !== null) => UNVERIFIED
    const truncatedTask = createEvalTask();
    await executeEvaluation(truncatedTask, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser: createMockOpenBrowser({
        scrollOffsetsPerViewport: [0, 700],
        withNextStartY: 1600,
      }),
      createClient: makeClient(truncatedTask.id),
    });
    assert.ok(truncatedTask.report);
    assert.ok(truncatedTask.report.coverage.unverified.some(item => item.includes('nextStartY=1600')));
    assert.equal(truncatedTask.report.quality, 'unverified');
  } finally {
    await f.close();
  }
});

test('bounded homepage evaluation runs 2 batches in parallel, attaches mobile-menu probe PNG, and caps MOBILE_MENU_TRAPPED', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '并发与菜单探针测试',
      scenario: 'upgrade',
      description: '精品咖啡升级站点',
      contentUrl: f.origin,
      referenceUrl: f.origin,
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-parallel';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'MenuProbe',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    // 3 screens × (target + reference) × 2 viewports = 12 PNGs + 1 mobile-menu probe PNG => 2 parallel batches
    const openBrowser = createMockOpenBrowser({
      scrollOffsetsPerViewport: [0, 700, 1400],
      withMobileMenuTrapProbe: true,
    });

    let activeTurns = 0;
    let maxConcurrentTurns = 0;
    const seenMobileImageActions: string[] = [];

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (input: unknown[]) => {
          activeTurns++;
          maxConcurrentTurns = Math.max(maxConcurrentTurns, activeTurns);
          await new Promise(r => setTimeout(r, 40));
          activeTurns--;

          const text = (input[0] as { text: string }).text;
          const isDesktop = text.includes('本批视口：desktop');
          const viewport: 'desktop' | 'mobile' = isDesktop ? 'desktop' : 'mobile';
          const images = input.filter((b: any) => b.type === 'local_image') as { path: string }[];
          if (viewport === 'mobile') {
            seenMobileImageActions.push(text);
            assert.match(text, /action=visual_precheck, probe=mobile-menu-open/);
            assert.equal(images.length, 7); // 3 target + 3 ref + 1 mobile-menu-open PNG
            assert.match(text, /MOBILE_MENU_TRAPPED/);
          } else {
            assert.equal(images.length, 6);
          }

          const workDir = resolve(f.directory, 'automation-runs', task.id);
          const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
          const targetPng = manifest.find(m => m.type === 'image/png' && m.role === 'target' && m.viewport === viewport)!.name;
          const refPng = manifest.find(m => m.type === 'image/png' && m.role === 'reference' && m.viewport === viewport)!.name;
          const probePng = manifest.find(m => {
            if (m.type !== 'image/png' || m.role !== 'target' || m.viewport !== 'mobile') return false;
            try {
              const obs = JSON.parse(readFileSync(resolve(workDir, 'evidence', m.name.replace(/\.png$/, '.json')), 'utf8')) as { action?: string };
              return obs.action === 'visual_precheck';
            } catch {
              return false;
            }
          })!.name;

          const reply = isDesktop
            ? {
                summary: '桌面达标。',
                assessments: [
                  { criterionId: 'hero', viewport: 'desktop', score: 92, reason: 'ok', evidence: [targetPng, refPng], passed: true },
                  { criterionId: 'structure', viewport: 'desktop', score: 91, reason: 'ok', evidence: [targetPng, refPng], passed: true },
                  { criterionId: 'sections', viewport: 'desktop', score: 90, reason: 'ok', evidence: [targetPng, refPng], passed: true },
                ],
                issues: [
                  {
                    severity: 'minor',
                    ruleId: null,
                    viewport: 'desktop',
                    criterionId: 'structure',
                    title: '半透明固定导航在滚动时透出底层文字，形成轻微叠影',
                    detail: '滚动到预约区段时导航栏后方文字透出，建议提高导航底色不透明度。',
                    evidence: [targetPng],
                  },
                  {
                    severity: 'minor',
                    ruleId: null,
                    viewport: 'desktop',
                    criterionId: 'sections',
                    title: '预约表单日期字段使用英文日期占位格式',
                    detail: '日期输入框显示“mm/dd/yyyy”英文日期占位符，与中文语境不一致。',
                    evidence: [targetPng],
                  },
                ],
                coverage: { verified: ['桌面端'], unverified: [], outOfScope: [] },
                humanSummary: {
                  verdict: 'ready',
                  headline: '桌面正常',
                  highlights: [
                    '首屏以真实手冲照片建立品牌氛围。',
                    '已发现的瑕疵仅为半透明固定导航叠影和英文日期占位符，均不阻断使用。',
                  ],
                  topFixes: ['提高固定页头背景不透明度。'],
                  unverifiedNote: null,
                },
              }
            : {
                summary: '移动端菜单展开后无法关闭。',
                assessments: [
                  { criterionId: 'hero', viewport: 'mobile', score: 93, reason: 'ok', evidence: [targetPng, refPng], passed: true },
                  { criterionId: 'structure', viewport: 'mobile', score: 90, reason: '结构完整', evidence: [targetPng, refPng], passed: true },
                  { criterionId: 'sections', viewport: 'mobile', score: 89, reason: 'ok', evidence: [targetPng, refPng], passed: true },
                ],
                issues: [
                  {
                    severity: 'major',
                    ruleId: 'R-LAYOUT-03',
                    viewport: 'mobile',
                    criterionId: 'structure',
                    title: '移动端全屏菜单展开后缺少可见关闭入口',
                    detail: '展开遮罩拦截了汉堡开关且没有可见关闭按钮',
                    evidence: [probePng],
                  },
                  {
                    severity: 'minor',
                    ruleId: null,
                    viewport: 'mobile',
                    criterionId: 'sections',
                    title: '固定页头半透明造成滚动内容透出叠字',
                    detail: '滚动时页头下方内容透出叠加，建议提高背景不透明度。',
                    evidence: [targetPng],
                  },
                  {
                    severity: 'minor',
                    ruleId: null,
                    viewport: 'mobile',
                    criterionId: 'sections',
                    title: '预约日期占位符与中文界面不一致',
                    detail: '日期字段直接显示“mm/dd/yyyy”英文格式占位。',
                    evidence: [targetPng],
                  },
                ],
                coverage: {
                  verified: ['移动端'],
                  unverified: [],
                  outOfScope: ['桌面端视口的布局与交互验收（本轮仅提供移动端证据）'],
                },
                humanSummary: {
                  verdict: 'needs-fixes',
                  headline: '移动端菜单需增加关闭按钮',
                  highlights: ['首屏以真实手冲照片建立品牌氛围'],
                  topFixes: ['提高固定页头背景不透明度'],
                  unverifiedNote: null,
                },
              };

          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 11000, cached_input_tokens: 4000, output_tokens: 1500 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(maxConcurrentTurns, 2);
    assert.equal(seenMobileImageActions.length, 1);
    assert.ok(task.report);
    // Ordering preserved: desktop first, then mobile
    assert.deepEqual(
      task.report.assessments.map(a => `${a.viewport}:${a.criterionId}`),
      ['desktop:hero', 'desktop:structure', 'desktop:sections', 'mobile:hero', 'mobile:structure', 'mobile:sections'],
    );
    // Mobile structure capped <= 72 and mobile viewport capped <= 75 due to R-LAYOUT-03 Major
    const mobileStructure = task.report.assessments.find(a => a.viewport === 'mobile' && a.criterionId === 'structure')!;
    assert.ok(mobileStructure.score !== null && mobileStructure.score <= 72);
    const mobileScore = task.report.scores.find(s => s.viewport === 'mobile')!;
    assert.ok(mobileScore.value !== null && mobileScore.value <= 75);
    assert.equal(task.report.quality, 'failed');
    assert.equal(task.report.humanSummary?.verdict, 'needs-fixes');
    // Normalized deduplication of highlights & topFixes, filtering contradictory all-clear lines and viewport leaks
    assert.deepEqual(task.report.humanSummary?.highlights, ['首屏以真实手冲照片建立品牌氛围。']);
    assert.equal(task.report.humanSummary?.topFixes.length, 1);
    assert.equal(
      task.report.coverage.outOfScope.some(item => item.includes('本轮仅提供移动端证据')),
      false,
    );
    // Cross-viewport Minor duplicates merged into 2 issues instead of 4, plus 1 Major = 3 total
    assert.equal(task.report.issues.length, 3);
    assert.equal(task.report.issues.filter(i => i.severity === 'major').length, 1);
    assert.equal(task.report.issues.filter(i => i.severity === 'minor').length, 2);
  } finally {
    await f.close();
  }
});

test('bounded homepage evaluation opens a fresh thread with compact reminder when Codex CLI exits code 1 on attempt 1', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '单页崩溃重试测试',
      scenario: 'materials',
      description: '单页官网',
      contentUrl: '',
      referenceUrl: '',
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-retry-1';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'RetryHome',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    const openBrowser = createMockOpenBrowser({ scrollOffsetsPerViewport: [0], withHeroSvgPrecheck: false });
    let threadCount = 0;
    const seenPrompts: string[] = [];

    const createClient = ((() => ({
      startThread: () => {
        const myThreadIndex = ++threadCount;
        return {
          runStreamed: async (input: unknown[]) => {
            const promptText = (input[0] as { text: string }).text;
            seenPrompts.push(promptText);
            if (myThreadIndex === 1) {
              throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
            }
            const workDir = resolve(f.directory, 'automation-runs', task.id);
            const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
            const dPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'desktop')!.name;
            const mPng = manifest.find(m => m.type === 'image/png' && m.viewport === 'mobile')!.name;
            const reply = {
              summary: '重试后完成双端评审。',
              assessments: [
                { criterionId: 'hero', viewport: 'desktop', score: 91, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'structure', viewport: 'desktop', score: 90, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'sections', viewport: 'desktop', score: 90, reason: 'ok', evidence: [dPng], passed: true },
                { criterionId: 'hero', viewport: 'mobile', score: 90, reason: 'ok', evidence: [mPng], passed: true },
                { criterionId: 'structure', viewport: 'mobile', score: 90, reason: 'ok', evidence: [mPng], passed: true },
                { criterionId: 'sections', viewport: 'mobile', score: 90, reason: 'ok', evidence: [mPng], passed: true },
              ],
              issues: [],
              coverage: { verified: ['首页双端'], unverified: [], outOfScope: [] },
              humanSummary: {
                verdict: 'ready',
                headline: '重试后双端达标',
                highlights: ['布局与视觉完整'],
                topFixes: [],
                unverifiedNote: null,
              },
            };
            return {
              events: (async function* () {
                yield { type: 'thread.started', thread_id: `thread-${myThreadIndex}` };
                yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
                yield { type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 2000, output_tokens: 900 } };
              })(),
            };
          },
        };
      },
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(threadCount, 2);
    assert.equal(seenPrompts.length, 2);
    assert.match(seenPrompts[1], /重试紧凑输出提醒/);
    assert.ok(task.report);
    assert.equal(task.report.quality, 'passed');
    assert.equal(task.threadId, 'thread-2');
    const events = f.store.events(task.id).map(e => e.message);
    assert.ok(events.some(msg => msg.includes('有界评测批次重试 1/1（双端）')));
  } finally {
    await f.close();
  }
});

test('extractBoundedMaterialNotes extracts plain text from .docx ZIP archives and safely skips corrupted ones', () => {
  const work = mkdtempSync(resolve(tmpdir(), 'docx-notes-'));
  try {
    mkdirSync(resolve(work, 'materials', '客户资料'), { recursive: true });
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>福建泉州南安阀门制造企业 &amp; API 认证</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>覆盖 DN15–DN4000，服务南水北调、中国水务</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const name = Buffer.from('word/document.xml', 'utf8');
    const raw = Buffer.from(xml, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    name.copy(localHeader, 30);

    const cdHeader = Buffer.alloc(46 + name.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(8, 10);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(raw.length, 24);
    cdHeader.writeUInt16LE(name.length, 28);
    cdHeader.writeUInt32LE(0, 42);
    name.copy(cdHeader, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdHeader.length, 12);
    eocd.writeUInt32LE(localHeader.length + compressed.length, 16);

    const docxBytes = Buffer.concat([localHeader, compressed, cdHeader, eocd]);
    writeFileSync(resolve(work, 'materials', '客户资料', 'company.docx'), docxBytes);
    writeFileSync(resolve(work, 'materials', 'broken.docx'), Buffer.from('not-a-zip'));

    const files: MaterialFile[] = [
      {
        id: randomUUID(),
        name: '客户资料/company.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: docxBytes.length,
        sha256: createHash('sha256').update(docxBytes).digest('hex'),
      },
      {
        id: randomUUID(),
        name: 'broken.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 9,
        sha256: createHash('sha256').update('not-a-zip').digest('hex'),
      },
    ];

    const notes = extractBoundedMaterialNotes(work, files);
    assert.match(notes, /--- 客户资料\/company\.docx ---/);
    assert.match(notes, /福建泉州南安阀门制造企业 & API 认证/);
    assert.match(notes, /DN15–DN4000/);
    assert.match(notes, /broken\.docx/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('sampleReferenceImages preserves first/last frames and collectBatchImages retains finite-animation reference captures while rejecting pending images', () => {
  const work = mkdtempSync(resolve(tmpdir(), 'ref-cap-'));
  try {
    mkdirSync(resolve(work, 'evidence'), { recursive: true });
    const mockList: BatchImage[] = Array.from({ length: 9 }, (_, i) => ({
      name: `ref-${i}.png`,
      absPath: `/tmp/ref-${i}.png`,
      role: 'reference',
      viewport: 'desktop',
      sha256: `sha-${i}`,
      width: 1440,
      height: 1000,
      scrollY: i * 800,
      action: 'take_page_screenshots',
    }));
    const sampled = sampleReferenceImages(mockList, 5);
    assert.equal(sampled.length, 5);
    assert.equal(sampled[0].name, 'ref-0.png');
    assert.equal(sampled[sampled.length - 1].name, 'ref-8.png');

    const artifacts: MaterialFile[] = [];
    const writeShot = (label: string, scrollY: number, pendingImages: number) => {
      const file = `${randomUUID()}.png`;
      const png = makeUniquePng(label);
      const obs = {
        action: 'take_page_screenshots',
        role: 'reference',
        viewport: 'desktop',
        url: 'https://ref.example.test/',
        capturedAt: Date.now() + scrollY,
        file,
        position: { url: 'https://ref.example.test/', scrollY, documentHeight: 1600, viewportHeight: 1000, viewportWidth: 1440 },
        readiness: { settled: false, pendingImages, brokenImages: 0, runningAnimations: 1, fontsReady: true, stableForMs: 0 },
        settlement: { settled: false },
      };
      writeFileSync(resolve(work, 'evidence', file), png);
      writeFileSync(resolve(work, 'evidence', file.replace('.png', '.json')), JSON.stringify(obs));
      artifacts.push({
        id: randomUUID(),
        name: file,
        type: 'image/png',
        size: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        role: 'reference',
        viewport: 'desktop',
        settled: false,
      });
      return file;
    };

    const animTop = writeShot('anim-0', 0, 0);
    const animBottom = writeShot('anim-1', 600, 0);
    assert.equal(hasCompleteRetainedCapture(artifacts, work, 'reference', 'desktop', 'https://ref.example.test/'), true);
    const kept = collectBatchImages(artifacts, work, 'reference', 'desktop', 'https://ref.example.test/');
    assert.deepEqual(kept.map(i => i.name), [animTop, animBottom]);

    // Pending image must still disqualify reference capture
    artifacts.length = 0;
    writeShot('pending-0', 0, 2);
    writeShot('pending-1', 600, 0);
    assert.equal(hasCompleteRetainedCapture(artifacts, work, 'reference', 'desktop', 'https://ref.example.test/'), false);
    const onlyLoaded = collectBatchImages(artifacts, work, 'reference', 'desktop', 'https://ref.example.test/');
    assert.equal(onlyLoaded.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('reference validation aggregates all missing criteria in one repair prompt and succeeds in 1/1 repair turn', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '参考站聚合校验修复测试',
      scenario: 'materials',
      description: '工业阀门模板参考建站',
      contentUrl: '',
      referenceUrl: f.origin,
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-ref-agg';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'OvoRef',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    // 3 screens * (target + reference) * 2 viewports = 12 images -> parallel desktop + mobile
    const openBrowser = createMockOpenBrowser({ scrollOffsetsPerViewport: [0, 850, 1700], withHeroSvgPrecheck: false });
    let mobileRepairPrompt = '';
    let mobileTurns = 0;

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (input: unknown[]) => {
          const text = (input[0] as { text: string }).text;
          const workDir = resolve(f.directory, 'automation-runs', task.id);
          const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
          const isRepair = text.includes('上一轮输出未通过平台校验');
          const isMobile = isRepair || text.includes('本批视口：mobile');
          const vp: 'desktop' | 'mobile' = isMobile ? 'mobile' : 'desktop';
          const tPng = manifest.find(m => m.type === 'image/png' && m.role === 'target' && m.viewport === vp)!.name;
          const rPng = manifest.find(m => m.type === 'image/png' && m.role === 'reference' && m.viewport === vp)!.name;

          if (vp === 'mobile') {
            mobileTurns++;
            if (isRepair) {
              mobileRepairPrompt = text;
            }
          }

          const reply =
            vp === 'mobile' && mobileTurns === 1
              ? {
                  summary: '移动端初始输出遗漏 reference 证据',
                  assessments: [
                    // Both hero and sections omit rPng intentionally!
                    { criterionId: 'hero', viewport: 'mobile', score: 90, reason: 'ok', evidence: [tPng], passed: true },
                    { criterionId: 'structure', viewport: 'mobile', score: 91, reason: 'ok', evidence: [tPng, rPng], passed: true },
                    { criterionId: 'sections', viewport: 'mobile', score: 89, reason: 'ok', evidence: [tPng], passed: true },
                  ],
                  issues: [],
                  coverage: { verified: ['mobile'], unverified: [], outOfScope: [] },
                  humanSummary: { verdict: 'ready', headline: '达标', highlights: ['结构一致'], topFixes: [], unverifiedNote: null },
                }
              : {
                  summary: `${vp} 达标`,
                  assessments: [
                    { criterionId: 'hero', viewport: vp, score: 91, reason: 'ok', evidence: [tPng, rPng], passed: true },
                    { criterionId: 'structure', viewport: vp, score: 90, reason: 'ok', evidence: [tPng, rPng], passed: true },
                    { criterionId: 'sections', viewport: vp, score: 90, reason: 'ok', evidence: [tPng, rPng], passed: true },
                  ],
                  issues: [],
                  coverage: { verified: [vp], unverified: [], outOfScope: [] },
                  humanSummary: { verdict: 'ready', headline: '达标', highlights: ['图文贴合参考模板'], topFixes: [], unverifiedNote: null },
                };

          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 10000, cached_input_tokens: 2000, output_tokens: 1000 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    assert.equal(mobileTurns, 2);
    // Aggregated error message must surface BOTH hero(mobile) and sections(mobile) at once
    assert.match(mobileRepairPrompt, /指标 hero\(mobile\) 缺少同视口 reference 截图证据/);
    assert.match(mobileRepairPrompt, /指标 sections\(mobile\) 缺少同视口 reference 截图证据/);
    assert.match(mobileRepairPrompt, /目标站 target 可用文件名：/);
    assert.match(mobileRepairPrompt, /参考站 reference 可用文件名：/);
    assert.ok(task.report);
    assert.equal(task.report.quality, 'passed');

    const workDir = resolve(f.directory, 'automation-runs', task.id);
    assert.equal(existsSync(resolve(workDir, 'bounded-batch-cache.json')), true);
    const budgetAccount = f.db
      .prepare('SELECT id FROM auto_model_accounts WHERE id = ?')
      .get(`evaluation:${task.id}`) as { id: string } | undefined;
    assert.ok(budgetAccount);
    const usageRows = f.db.prepare('SELECT json FROM auto_usage WHERE task_id = ?').all(task.id);
    assert.equal(usageRows.length, 3);
  } finally {
    await f.close();
  }
});

test('tall 22,000px page uses startY/nextStartY continuation, slices batches <=12 images, preserves footer Major defect, and strips slice leaks', async () => {
  const f = await setupEnv();
  try {
    const resource = f.store.saveResource({
      name: '超长首页续采与分段聚合测试',
      scenario: 'materials',
      description: '超长工业落地页',
      contentUrl: '',
      referenceUrl: f.origin,
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = f.store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.envId,
        requirements: '',
      },
      f.settings,
    )[0];
    task.kind = 'evaluation';
    task.siteRevision = 'rev-tall-22k';
    task.generatedSiteId = randomUUID();
    task.status = 'running';
    task.stopped = false;
    task.learningPolicy = { ...defaultLearningSettings, use: false, collect: false };
    task.rule = { ...task.rule!, criteria: makeHomepageCriteria() };
    f.store.saveSite({
      id: task.generatedSiteId,
      resourceId: resource.id,
      versionId: task.versionId,
      environmentId: f.envId,
      siteId: randomUUID(),
      name: 'TallOvo',
      url: f.origin,
      createdAt: Date.now(),
    });
    f.store.put(task);

    // Direct unit check on planHomepageBatches: 24 mobile targets + 5 mobile refs => 3 slices <= 12 images each
    const mkImg = (name: string, role: 'target' | 'reference', viewport: 'desktop' | 'mobile', scrollY: number): BatchImage => ({
      name,
      absPath: `/tmp/${name}`,
      role,
      viewport,
      sha256: name,
      width: viewport === 'mobile' ? 390 : 1440,
      height: viewport === 'mobile' ? 844 : 1000,
      scrollY,
      action: 'take_page_screenshots',
    });
    const planned = planHomepageBatches({
      criteria: makeHomepageCriteria(),
      requiredViewports: ['desktop', 'mobile'],
      targetDesktop: Array.from({ length: 4 }, (_, i) => mkImg(`td-${i}.png`, 'target', 'desktop', i * 850)),
      refDesktop: Array.from({ length: 4 }, (_, i) => mkImg(`rd-${i}.png`, 'reference', 'desktop', i * 850)),
      targetMobile: Array.from({ length: 24 }, (_, i) => mkImg(`tm-${i}.png`, 'target', 'mobile', i * 717)),
      refMobile: Array.from({ length: 5 }, (_, i) => mkImg(`rm-${i}.png`, 'reference', 'mobile', i * 2500)),
      prechecks: [],
    });
    assert.equal(planned.filter(b => b.viewports[0] === 'desktop').length, 1);
    const mobilePlanned = planned.filter(b => b.viewports[0] === 'mobile');
    assert.equal(mobilePlanned.length, 3);
    assert.ok(mobilePlanned.every(b => b.images.length <= 12));
    assert.deepEqual(mobilePlanned[0].criteria.map(c => c.id), ['hero', 'structure', 'sections']);
    assert.deepEqual(mobilePlanned[1].criteria.map(c => c.id), ['structure', 'sections']);
    assert.deepEqual(mobilePlanned[2].criteria.map(c => c.id), ['structure', 'sections']);

    let activeFiles: MaterialFile[] = [];
    const openBrowser: typeof evaluationBrowser = async (_urls, work, _signal, initial, checkpoint, binding) => {
      activeFiles = structuredClone(initial || []);
      return {
        artifacts: activeFiles,
        env: { EVALUATION_BROWSER_URL: 'mock', EVALUATION_BROWSER_TOKEN: 'mock' },
        capture: async (raw: unknown) => {
          const req = raw as {
            action: string;
            role: 'target' | 'reference';
            viewport: 'desktop' | 'mobile';
            url?: string;
            startY?: number;
            maxScreenshots?: number;
          };
          if (req.action === 'visual_precheck') {
            const vw = req.viewport === 'mobile' ? 390 : 1440;
            const vh = req.viewport === 'mobile' ? 844 : 1000;
            const snap: RawViewportPrecheckSnapshot = {
              viewport: req.viewport,
              url: req.url || f.origin,
              viewportWidth: vw,
              viewportHeight: vh,
              documentHeight: req.viewport === 'mobile' ? 22000 : 3550,
              scrollWidth: vw,
              horizontalOverflow: false,
              headerCoversH1: false,
              heroImageCount: 1,
              heroRealImageCount: 1,
              heroMaxImageArea: 300000,
              brokenImageCount: 0,
              svgCandidates: [],
              imageCandidates: [],
              orphanHeadings: [],
              templateResiduals: [],
            };
            return { snapshot: snap, signals: evaluateVisualPrecheckSignals(snap) };
          }

          assert.equal(req.action, 'take_page_screenshots');
          const vw = req.viewport === 'mobile' ? 390 : 1440;
          const vh = req.viewport === 'mobile' ? 844 : 1000;
          const startY = req.startY ?? 0;

          let offsets: number[];
          let docHeight: number;
          let nextStartY: number | null = null;
          if (req.viewport === 'desktop') {
            docHeight = 3550;
            offsets = [0, 850, 1700, 2550];
          } else if (req.role === 'reference') {
            docHeight = 5600 + vh;
            offsets = Array.from({ length: 8 }, (_, i) => i * 800);
          } else {
            docHeight = 22000;
            if (startY === 0) {
              // First 16 screens covering 0..10755 -> bottom 11599, nextStartY 11472
              offsets = Array.from({ length: 16 }, (_, i) => Math.round(i * vh * 0.85));
              nextStartY = Math.round(16 * vh * 0.85);
            } else {
              // Continuation covering remaining 11478..21156 -> + 844 = 22000
              offsets = Array.from({ length: 16 }, (_, i) => {
                const y = Math.round(startY + i * vh * 0.85);
                return Math.min(docHeight - vh, y);
              }).filter((v, idx, arr) => idx === 0 || v > arr[idx - 1]);
              nextStartY = null;
            }
          }

          const captureId = randomUUID();
          const screenshots: ScreenshotReceipt[] = [];
          for (const [idx, scrollY] of offsets.entries()) {
            const file = `${randomUUID()}.png`;
            const jsonFile = file.replace(/\.png$/, '.json');
            const obs: ScreenshotReceipt & { action: string; role: string; viewport: string; capturedAt: number; binding?: unknown } = {
              action: 'take_page_screenshots',
              role: req.role,
              viewport: req.viewport,
              capturedAt: Date.now() + scrollY + idx,
              file,
              url: req.url || f.origin,
              position: {
                url: req.url || f.origin,
                scrollX: 0,
                scrollY,
                documentHeight: docHeight,
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
              readiness: { settled: true, images: 1, pendingImages: 0, brokenImages: 0, runningAnimations: 0, fontsReady: true, stableForMs: 500 },
              settlement: { settled: true },
              capture: { id: captureId, index: idx + 1, scope: 'page', policy: 'viewport-evidence-pc1440-mobile390-v3' },
              ...(binding ? { binding } : {}),
            };
            const pngBytes = makeUniquePng(`${req.role}:${req.viewport}:${scrollY}:${file}`);
            const obsBytes = Buffer.from(JSON.stringify(obs));
            writeFileSync(resolve(work, 'evidence', file), pngBytes);
            writeFileSync(resolve(work, 'evidence', jsonFile), obsBytes);
            activeFiles.push(
              { id: randomUUID(), name: file, type: 'image/png', size: pngBytes.length, sha256: createHash('sha256').update(pngBytes).digest('hex'), role: req.role, viewport: req.viewport, settled: true },
              { id: randomUUID(), name: jsonFile, type: 'application/json', size: obsBytes.length, sha256: createHash('sha256').update(obsBytes).digest('hex'), role: req.role, viewport: req.viewport, settled: true },
            );
            screenshots.push(obs);
          }
          checkpoint?.(structuredClone(activeFiles));
          return {
            action: 'take_page_screenshots',
            status: nextStartY === null ? 'complete' : 'partial',
            coverageComplete: nextStartY === null,
            screenshots,
            gaps: [],
            nextStartY,
            nextSelectorIndex: null,
          };
        },
        close: async () => {},
      } as unknown as Awaited<ReturnType<typeof evaluationBrowser>>;
    };

    const seenBatches: Array<{ label: string; imageCount: number; hasHero: boolean }> = [];
    const seenAllMobileTargetNames = new Set<string>();

    const createClient = ((() => ({
      startThread: () => ({
        runStreamed: async (input: unknown[]) => {
          const text = (input[0] as { text: string }).text;
          const imgs = (input.filter((b: any) => b.type === 'local_image') as { path: string }[]).map(b =>
            b.path.split('/').pop()!,
          );
          assert.ok(imgs.length <= 12, `slice exceeded 12 images: ${imgs.length}`);

          const isDesktop = text.includes('本批视口：desktop');
          const vp: 'desktop' | 'mobile' = isDesktop ? 'desktop' : 'mobile';
          const hasHero = text.includes('- hero（');
          const workDir = resolve(f.directory, 'automation-runs', task.id);
          const manifest = JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[];
          const byName = new Map(manifest.map(m => [m.name, m]));
          const targetPngs = imgs.filter(n => byName.get(n)?.role === 'target');
          const refPngs = imgs.filter(n => byName.get(n)?.role === 'reference');
          assert.ok(targetPngs.length >= 1 && refPngs.length >= 1, 'slice must attach both target and reference PNGs');

          if (vp === 'mobile') {
            for (const n of targetPngs) seenAllMobileTargetNames.add(n);
          }

          const isFooterSlice = text.includes('下段与页脚');
          seenBatches.push({ label: isDesktop ? 'desktop' : isFooterSlice ? 'mobile-footer' : 'mobile-part', imageCount: imgs.length, hasHero });

          const assessments = [
            ...(hasHero
              ? [{ criterionId: 'hero', viewport: vp, score: 92, reason: '首屏与参考模板一致', evidence: [targetPngs[0], refPngs[0]], passed: true }]
              : []),
            { criterionId: 'structure', viewport: vp, score: 91, reason: '结构合理', evidence: [targetPngs[0], refPngs[0]], passed: true },
            {
              criterionId: 'sections',
              viewport: vp,
              score: isFooterSlice ? 66 : 90,
              reason: isFooterSlice ? '页脚卡片文字被裁切' : '中段图文清晰',
              evidence: [targetPngs[targetPngs.length - 1], refPngs[refPngs.length - 1]],
              passed: !isFooterSlice,
            },
          ];

          const reply = {
            summary: isFooterSlice ? '移动端页脚卡片发现文字裁切' : '本段表现正常',
            assessments,
            issues: isFooterSlice
              ? [
                  {
                    severity: 'major' as const,
                    ruleId: 'R-LAYOUT-03' as const,
                    viewport: 'mobile' as const,
                    criterionId: 'sections',
                    title: '移动端页脚CTA卡片底部文字裁切',
                    detail: '页脚末屏底部标签发生垂直截断。',
                    evidence: [targetPngs[targetPngs.length - 1]],
                  },
                ]
              : [],
            coverage: {
              verified: [isDesktop ? '桌面全页' : '移动端区段'],
              unverified: isFooterSlice ? ['本段仅展示下段与页脚，未包含首屏区域'] : [],
              outOfScope: [],
            },
            humanSummary: {
              verdict: isFooterSlice ? ('needs-fixes' as const) : ('ready' as const),
              headline: isFooterSlice ? '移动端页脚存在裁切缺陷' : '当前分段通过',
              highlights: ['使用真实企业与设备实景摄影'],
              topFixes: isFooterSlice ? ['修复移动端页脚卡片容器高度避免裁切'] : [],
              unverifiedNote: null,
            },
          };

          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: randomUUID() };
              yield { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(reply) } };
              yield { type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 3000, output_tokens: 1500 } };
            })(),
          };
        },
      }),
    })) as unknown) as typeof codexClient;

    await executeEvaluation(task, f.store, f.vault, f.directory, new AbortController().signal, {
      openBrowser,
      createClient,
    });

    const workDir = resolve(f.directory, 'automation-runs', task.id);
    const precheckFacts = JSON.parse(readFileSync(resolve(workDir, 'precheck-facts.json'), 'utf8')) as {
      captureGaps: string[];
    };
    assert.deepEqual(precheckFacts.captureGaps, []);

    const mobileManifestTargets = (
      JSON.parse(readFileSync(resolve(workDir, 'evidence-manifest.json'), 'utf8')) as MaterialFile[]
    ).filter(m => m.type === 'image/png' && m.role === 'target' && m.viewport === 'mobile');
    assert.ok(mobileManifestTargets.length >= 25, `expected >= 25 continuation mobile shots, got ${mobileManifestTargets.length}`);
    assert.equal(seenAllMobileTargetNames.size, mobileManifestTargets.length, 'all continuation target PNGs must be inspected');

    // Non-hero slices did not include hero criterion
    assert.ok(seenBatches.some(b => !b.hasHero));
    assert.ok(task.report);
    assert.deepEqual(
      task.report.assessments.map(a => `${a.viewport}:${a.criterionId}`),
      ['desktop:hero', 'desktop:structure', 'desktop:sections', 'mobile:hero', 'mobile:structure', 'mobile:sections'],
    );
    const mobileSections = task.report.assessments.find(a => a.viewport === 'mobile' && a.criterionId === 'sections')!;
    assert.equal(mobileSections.passed, false);
    assert.ok(mobileSections.score !== null && mobileSections.score <= 66);
    assert.equal(task.report.quality, 'failed');
    assert.equal(task.report.humanSummary?.verdict, 'needs-fixes');
    assert.deepEqual(task.report.coverage.unverified, []);
  } finally {
    await f.close();
  }
});
