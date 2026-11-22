import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectViewportVisualPrecheckInPage,
  discoverBoundedSitePaths,
  evaluateVisualPrecheckSignals,
  formatPrecheckDigest,
  inspectMobileMenuStateInPage,
  type RawViewportPrecheckSnapshot,
} from '../server/automation/visual-precheck.js';

function baseSnapshot(overrides: Partial<RawViewportPrecheckSnapshot> = {}): RawViewportPrecheckSnapshot {
  return {
    viewport: 'desktop',
    url: 'https://example.test/',
    viewportWidth: 1440,
    viewportHeight: 1000,
    documentHeight: 3200,
    scrollWidth: 1440,
    horizontalOverflow: false,
    headerCoversH1: false,
    heroImageCount: 0,
    heroRealImageCount: 0,
    heroMaxImageArea: 0,
    brokenImageCount: 0,
    svgCandidates: [],
    imageCandidates: [],
    orphanHeadings: [],
    templateResiduals: [],
    ...overrides,
  };
}

test('detects HERO_SVG_PLACEHOLDER and CARD_SVG_PLACEHOLDER on 星禾空间-like geometric SVG layout', () => {
  const snap = baseSnapshot({
    heroImageCount: 0,
    heroRealImageCount: 0,
    svgCandidates: [
      {
        inHero: true,
        width: 520,
        height: 520,
        viewportAreaRatio: (520 * 520) / (1440 * 1000),
        primitiveCount: 6,
        hasChartText: false,
        tagPath: 'main > section.hero > div.visual',
        top: 180,
        left: 740,
      },
      {
        inHero: false,
        width: 320,
        height: 220,
        viewportAreaRatio: (320 * 220) / (1440 * 1000),
        primitiveCount: 4,
        hasChartText: false,
        tagPath: 'main > section.projects > div.card',
        top: 1500,
        left: 120,
      },
      {
        inHero: false,
        width: 320,
        height: 220,
        viewportAreaRatio: (320 * 220) / (1440 * 1000),
        primitiveCount: 5,
        hasChartText: false,
        tagPath: 'main > section.projects > div.card',
        top: 1500,
        left: 520,
      },
      {
        inHero: false,
        width: 320,
        height: 220,
        viewportAreaRatio: (320 * 220) / (1440 * 1000),
        primitiveCount: 4,
        hasChartText: false,
        tagPath: 'main > section.projects > div.card',
        top: 1500,
        left: 920,
      },
    ],
  });

  const signals = evaluateVisualPrecheckSignals(snap);
  const heroSig = signals.find(s => s.code === 'HERO_SVG_PLACEHOLDER');
  const cardSig = signals.find(s => s.code === 'CARD_SVG_PLACEHOLDER');
  assert.ok(heroSig);
  assert.equal(heroSig.ruleId, 'R-VISUAL-01');
  assert.equal(heroSig.severityHint, 'major');
  assert.equal(heroSig.metrics.maxWidth, 520);
  assert.ok(cardSig);
  assert.equal(cardSig.ruleId, 'R-VISUAL-01');
  assert.equal(cardSig.metrics.count, 3);
});

test('exempts small UI icons / brand logo SVGs alongside real Hero imagePlaceholder <img>', () => {
  const snap = baseSnapshot({
    heroImageCount: 1,
    heroRealImageCount: 1,
    heroMaxImageArea: 600 * 420,
    imageCandidates: [
      {
        inHero: true,
        width: 600,
        height: 420,
        naturalWidth: 1200,
        naturalHeight: 840,
        complete: true,
        broken: false,
        srcHint: 'https://img.example.test/imagePlaceholder/architecture.jpg',
      },
    ],
    svgCandidates: [
      {
        inHero: true,
        width: 40,
        height: 40,
        viewportAreaRatio: (40 * 40) / (1440 * 1000),
        primitiveCount: 3,
        hasChartText: false,
        tagPath: 'header > a.logo',
        top: 24,
        left: 40,
      },
      {
        inHero: true,
        width: 24,
        height: 24,
        viewportAreaRatio: (24 * 24) / (1440 * 1000),
        primitiveCount: 2,
        hasChartText: false,
        tagPath: 'main > section.hero > a.cta',
        top: 480,
        left: 220,
      },
    ],
  });

  const signals = evaluateVisualPrecheckSignals(snap);
  assert.equal(signals.length, 0);
});

test('exempts data visualization chart SVG from HERO_SVG_PLACEHOLDER', () => {
  const snap = baseSnapshot({
    heroRealImageCount: 0,
    svgCandidates: [
      {
        inHero: true,
        width: 560,
        height: 360,
        viewportAreaRatio: (560 * 360) / (1440 * 1000),
        primitiveCount: 18,
        hasChartText: true,
        tagPath: 'main > section.hero > div.recharts-wrapper',
        top: 160,
        left: 720,
      },
    ],
  });

  const signals = evaluateVisualPrecheckSignals(snap);
  assert.equal(signals.some(s => s.code === 'HERO_SVG_PLACEHOLDER'), false);
});

test('emits BROKEN_IMAGE, HORIZONTAL_OVERFLOW, HEADER_COVERS_H1, HEADING_ORPHAN_WRAP and TEMPLATE_RESIDUAL', () => {
  const desktopSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'desktop',
      scrollWidth: 1620,
      horizontalOverflow: true,
      headerCoversH1: true,
      brokenImageCount: 2,
      orphanHeadings: [{ tag: 'h2', text: '从一个空间的光环境开始', lineCount: 2, lastLineChars: 1 }],
      templateResiduals: ['lorem ipsum', 'shiome'],
    }),
  );

  assert.deepEqual(
    desktopSignals.map(s => s.code),
    ['BROKEN_IMAGE', 'HORIZONTAL_OVERFLOW', 'HEADER_COVERS_H1', 'HEADING_ORPHAN_WRAP', 'TEMPLATE_RESIDUAL'],
  );

  // Mobile ignores HEADING_ORPHAN_WRAP
  const mobileSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'mobile',
      viewportWidth: 390,
      viewportHeight: 844,
      scrollWidth: 390,
      orphanHeadings: [{ tag: 'h2', text: '短行', lineCount: 2, lastLineChars: 1 }],
    }),
  );
  assert.equal(mobileSignals.some(s => s.code === 'HEADING_ORPHAN_WRAP'), false);

  const digest = formatPrecheckDigest([{ snapshot: baseSnapshot(), signals: desktopSignals }]);
  assert.match(digest, /HERO_SVG_PLACEHOLDER|BROKEN_IMAGE/);
  assert.match(digest, /HORIZONTAL_OVERFLOW/);
  assert.match(digest, /TEMPLATE_RESIDUAL/);
});

test('detects MOBILE_MENU_TRAPPED when mobile menu lacks visible close control or close fails, and ignores clean toggle', () => {
  const missingCloseSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'mobile',
      viewportWidth: 390,
      viewportHeight: 844,
      scrollWidth: 390,
      mobileMenu: {
        tested: true,
        toggleFound: true,
        opened: true,
        hasVisibleCloseControl: false,
        closeWorked: false,
        occludedToggle: true,
        openScreenshotFile: 'menu-open-1.png',
      },
    }),
  );
  const trappedSig = missingCloseSignals.find(s => s.code === 'MOBILE_MENU_TRAPPED');
  assert.ok(trappedSig);
  assert.equal(trappedSig.ruleId, 'R-LAYOUT-03');
  assert.equal(trappedSig.severityHint, 'major');
  assert.match(trappedSig.summary, /menu-open-1\.png/);
  assert.match(trappedSig.summary, /全屏遮罩拦截/);

  const brokenCloseSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'mobile',
      viewportWidth: 390,
      viewportHeight: 844,
      scrollWidth: 390,
      mobileMenu: {
        tested: true,
        toggleFound: true,
        opened: true,
        hasVisibleCloseControl: true,
        closeWorked: false,
        occludedToggle: false,
      },
    }),
  );
  assert.equal(brokenCloseSignals.some(s => s.code === 'MOBILE_MENU_TRAPPED'), true);

  const cleanMenuSnap = baseSnapshot({
    viewport: 'mobile',
    viewportWidth: 390,
    viewportHeight: 844,
    scrollWidth: 390,
    mobileMenu: {
      tested: true,
      toggleFound: true,
      opened: true,
      hasVisibleCloseControl: true,
      closeWorked: true,
      occludedToggle: false,
    },
  });
  const cleanSignals = evaluateVisualPrecheckSignals(cleanMenuSnap);
  assert.equal(cleanSignals.some(s => s.code === 'MOBILE_MENU_TRAPPED'), false);

  const digest = formatPrecheckDigest([{ snapshot: cleanMenuSnap, signals: cleanSignals }]);
  assert.match(digest, /移动端菜单探针：已找到并展开菜单；可见未遮挡关闭入口=是，关闭生效=是/);
});

test('in-page collector function contains no esbuild __name helper references', () => {
  assert.equal(collectViewportVisualPrecheckInPage.toString().includes('__name'), false);
  assert.equal(inspectMobileMenuStateInPage.toString().includes('__name'), false);
});

test('discoverBoundedSitePaths prioritizes root, skips dynamic templates and external links, and caps overflow paths', () => {
  const discovered = discoverBoundedSitePaths({
    baseUrl: 'https://demo.site.test/',
    backendPagesRaw: {
      value: [
        { route: '/about/', online: true },
        { route: '/products/{id}', online: true },
        { route: '/draft', online: false },
        { route: '/pricing', online: true },
        { route: '/team', online: true },
      ],
    },
    precheckLinks: [
      'https://demo.site.test/contact#form',
      'https://external.other.test/ignored',
      '/blog/:slug',
      '/faq',
      '/cases',
      '/brochure.pdf',
      '/_api/v2/test',
      '/services',
    ],
    maxPages: 6,
  });

  assert.equal(discovered.paths[0], '/');
  assert.equal(discovered.paths.length, 6);
  assert.deepEqual(discovered.paths, ['/', '/about', '/cases', '/contact', '/faq', '/pricing']);
  assert.deepEqual(discovered.overflowPaths, ['/services', '/team']);
});

test('formatPrecheckDigest includes deterministic anchorCheck summary without introducing __name', () => {
  assert.equal(collectViewportVisualPrecheckInPage.toString().includes('__name'), false);
  const digest = formatPrecheckDigest([
    {
      snapshot: baseSnapshot({
        anchorCheck: { total: 4, valid: 3, broken: ['#missing-cta'] },
      }),
      signals: [],
    },
  ]);
  assert.match(digest, /页内锚点自检：共 4 个锚点链接，命中有效目标区块 3 个，缺失目标：\[#missing-cta\]/);
});
