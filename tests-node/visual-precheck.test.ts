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

test('emits v1.2 layout balance, visibility, duplication, min-font, nav and locale signals', () => {
  const desktopSnap = baseSnapshot({
    viewport: 'desktop',
    viewportWidth: 1440,
    viewportHeight: 900,
    headerSticky: false,
    desktopHamburgerDetected: true,
    minFontViolationCount: 12,
    minFontSamples: [{ fontSize: 10, text: 'Copyright footer text' }],
    headingLineOverflows: [{ tag: 'h1', lines: 4, maxLines: 3, text: 'Very long hero title wrapping onto four lines' }],
    heroFoldMetrics: {
      hasHeroSection: true,
      h1Top: 100,
      headerBottom: 80,
      ctaBottom: 890,
      heroImgBottom: 940,
      textBlockHeight: 700,
      maxTextBlockHeight: 640,
      centerPct: 68,
    },
    splitImbalances: [
      { mediaHeight: 250, textHeight: 980, diffPx: 730, diffRatio: 2.92, tolerancePx: 48, textToMediaRatio: 3.92 },
    ],
    sectionAirGaps: [{ index: 2, sectionHeight: 800, contentHeight: 280, contentRatio: 0.35 }],
    maxVerticalBlankGap: 320,
    imageDistortions: [
      { srcHint: '/img/hero.jpg', opacity: 0.4, naturalRatio: 1.5, renderedRatio: 1.5, ratioDiff: 0, reason: 'low-opacity' },
    ],
    duplicationSummary: {
      phones: [{ value: '06 835 181 80', total: 11, main: 8 }],
      emails: [{ value: 'info@example.test', total: 4, main: 2 }],
      ctaLabels: [{ label: 'Meer informatie', total: 5, main: 5 }],
      duplicateBlocks: [{ text: 'Repeated promotional paragraph across multiple sections.', count: 2 }],
      duplicateImages: [{ srcHint: '/img/shop.jpg', count: 3 }],
    },
    localeHygiene: {
      htmlLang: 'en',
      cjkInNonCjkSite: true,
      nativeDateInputs: 1,
      demoNavResiduals: ['Demos', 'Home 2'],
    },
  });

  const signals = evaluateVisualPrecheckSignals(desktopSnap);
  const codes = signals.map(s => s.code);
  assert.deepEqual(codes, [
    'TITLE_LINES_EXCEEDED',
    'HERO_FOLD_CLIPPED',
    'HERO_OFF_CENTER',
    'SPLIT_HEIGHT_IMBALANCE',
    'SECTION_AIR_GAP',
    'IMAGE_VISIBILITY_ISSUE',
    'CONTENT_DUPLICATION',
    'MIN_FONT_SIZE',
    'NAV_NOT_STICKY',
    'DESKTOP_HAMBURGER_NAV',
    'LOCALE_OR_DATE_ISSUE',
  ]);

  const splitSig = signals.find(s => s.code === 'SPLIT_HEIGHT_IMBALANCE')!;
  assert.match(splitSig.summary, /建议拆 3 图纵排/);
  assert.equal(splitSig.ruleId, 'R-LAYOUT-04');
  assert.equal(signals.find(s => s.code === 'HERO_FOLD_CLIPPED')!.ruleId, 'R-LAYOUT-04');
  assert.equal(signals.find(s => s.code === 'MIN_FONT_SIZE')!.ruleId, 'R-TYPO-01');
  assert.equal(signals.find(s => s.code === 'LOCALE_OR_DATE_ISSUE')!.ruleId, 'R-TYPO-01');
  const dupSig = signals.find(s => s.code === 'CONTENT_DUPLICATION')!;
  assert.equal(dupSig.severityHint, 'major');
  assert.equal(dupSig.ruleId, 'R-DUPE-01');
  assert.match(dupSig.summary, /06 835 181 80 整页11\/正文8/);

  // Mobile header gap relaxes from 32px to 24px (30px passes, 13px still flags R-LAYOUT-04)
  const mobileGapOk = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'mobile',
      viewportWidth: 390,
      viewportHeight: 844,
      heroFoldMetrics: {
        hasHeroSection: true,
        headerBottom: 72,
        h1Top: 102,
        ctaBottom: 500,
        centerPct: 48,
      },
    }),
  );
  assert.equal(mobileGapOk.some(s => s.code === 'HERO_FOLD_CLIPPED'), false);

  const mobileGapTooTight = evaluateVisualPrecheckSignals(
    baseSnapshot({
      viewport: 'mobile',
      viewportWidth: 390,
      viewportHeight: 844,
      heroFoldMetrics: {
        hasHeroSection: true,
        headerBottom: 72,
        h1Top: 85,
        ctaBottom: 500,
        centerPct: 48,
      },
    }),
  );
  const mobileClipSig = mobileGapTooTight.find(s => s.code === 'HERO_FOLD_CLIPPED')!;
  assert.equal(mobileClipSig.ruleId, 'R-LAYOUT-04');
  assert.match(mobileClipSig.summary, /不足 24px（13px）/);

  // <10 minFont violations stay minor without forcing R-TYPO-01 cap
  const smallFontMinor = evaluateVisualPrecheckSignals(
    baseSnapshot({ minFontViolationCount: 4, minFontSamples: [{ fontSize: 11, text: 'Badge' }] }),
  );
  assert.equal(smallFontMinor[0].severityHint, 'minor');
  assert.equal(smallFontMinor[0].ruleId, undefined);

  const twoStackSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      splitImbalances: [
        { mediaHeight: 400, textHeight: 680, diffPx: 280, diffRatio: 0.7, tolerancePx: 48, textToMediaRatio: 1.7 },
      ],
    }),
  );
  assert.match(twoStackSignals[0].summary, /建议拆 2 图纵排/);

  const digest = formatPrecheckDigest([{ snapshot: desktopSnap, signals }]);
  assert.match(digest, /首屏安全线测量：CTA底=890px\/900px，中心=68%，文本块高=700px/);
  assert.match(digest, /最小字号检查：<12px 可见文字共 12 处/);
  assert.match(digest, /CONTENT_DUPLICATION/);
});

test('detects HOMEPAGE_SUBPAGE_LINK, LOW_RES_IMAGE_UPSCALE, overlayCardBottom clipping, heroRepeatedBadges, duplicateImages >= 2, and EXTERNAL_OR_INSECURE_ASSET', () => {
  assert.equal(collectViewportVisualPrecheckInPage.toString().includes('__name'), false);

  const snap = baseSnapshot({
    viewport: 'desktop',
    viewportWidth: 1440,
    viewportHeight: 900,
    taskScope: 'homepage',
    internalLinks: ['/', '/diensten', '/projecten?page=2'],
    heroFoldMetrics: {
      hasHeroSection: true,
      ctaBottom: 600,
      overlayCardBottom: 945,
      centerPct: 50,
    },
    imageCandidates: [
      {
        inHero: true,
        width: 900,
        height: 520,
        naturalWidth: 520,
        naturalHeight: 340,
        complete: true,
        broken: false,
        srcHint: '/images/legacy-hero.jpg',
      },
      {
        inHero: false,
        width: 800,
        height: 450,
        naturalWidth: 400,
        naturalHeight: 225,
        complete: true,
        broken: false,
        srcHint: '/images/diagram.svg',
      },
      {
        inHero: false,
        width: 800,
        height: 500,
        naturalWidth: 1200,
        naturalHeight: 750,
        complete: true,
        broken: false,
        srcHint: '/images/ok.jpg',
      },
    ],
    duplicationSummary: {
      phones: [],
      emails: [],
      ctaLabels: [],
      duplicateBlocks: [],
      duplicateImages: [{ srcHint: '/images/repeat.jpg', count: 2 }],
      heroRepeatedBadges: [{ text: 'Sinds 1983', count: 3 }],
    },
    externalAssets: [{ tag: 'img', url: 'http://legacy.example.test/old.jpg', insecure: true }],
  });

  const signals = evaluateVisualPrecheckSignals(snap);
  const codes = signals.map(s => s.code);
  assert.ok(codes.includes('HERO_FOLD_CLIPPED'));
  assert.ok(codes.includes('CONTENT_DUPLICATION'));
  assert.ok(codes.includes('LOW_RES_IMAGE_UPSCALE'));
  assert.ok(codes.includes('HOMEPAGE_SUBPAGE_LINK'));
  assert.ok(codes.includes('EXTERNAL_OR_INSECURE_ASSET'));

  const clipSig = signals.find(s => s.code === 'HERO_FOLD_CLIPPED')!;
  assert.match(clipSig.summary, /首屏浮层卡片底部 945px > 900px/);

  const dupSig = signals.find(s => s.code === 'CONTENT_DUPLICATION')!;
  assert.match(dupSig.summary, /首屏标签重复（.*Sinds 1983.*×3/);
  assert.match(dupSig.summary, /建议每张实拍图仅用 1 次/);

  const lowResSig = signals.find(s => s.code === 'LOW_RES_IMAGE_UPSCALE')!;
  assert.equal(lowResSig.ruleId, 'R-VISUAL-02');
  assert.equal(lowResSig.severityHint, 'major');
  assert.equal(lowResSig.metrics.count, 1);

  const subpageSig = signals.find(s => s.code === 'HOMEPAGE_SUBPAGE_LINK')!;
  assert.equal(subpageSig.ruleId, 'R-TRUST-01');
  assert.equal(subpageSig.severityHint, 'major');
  assert.match(subpageSig.summary, /\/diensten/);

  const extSig = signals.find(s => s.code === 'EXTERNAL_OR_INSECURE_ASSET')!;
  assert.equal(extSig.ruleId, 'R-TRUST-01');
  assert.equal(extSig.severityHint, 'major');

  // site scope or root-only homepage links must not trigger HOMEPAGE_SUBPAGE_LINK
  const siteScopeSignals = evaluateVisualPrecheckSignals({ ...snap, taskScope: 'site' });
  assert.equal(siteScopeSignals.some(s => s.code === 'HOMEPAGE_SUBPAGE_LINK'), false);

  const homeRootOnlySignals = evaluateVisualPrecheckSignals({ ...snap, taskScope: 'homepage', internalLinks: ['/'] });
  assert.equal(homeRootOnlySignals.some(s => s.code === 'HOMEPAGE_SUBPAGE_LINK'), false);

  const digest = formatPrecheckDigest([{ snapshot: snap, signals }]);
  assert.match(digest, /浮层卡底=945px\/900px/);
});

test('emits LOW_TEXT_CONTRAST (minor and major) and address duplication in CONTENT_DUPLICATION', () => {
  assert.equal(collectViewportVisualPrecheckInPage.toString().includes('__name'), false);

  const minorContrastSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      contrastSummary: {
        violationCount: 1,
        samples: [{ ratio: 3.6, required: 4.5, fontSize: 15, text: 'Muted body caption' }],
        manualCheckCount: 2,
        fadedCount: 0,
      },
    }),
  );
  const minorSig = minorContrastSignals.find(s => s.code === 'LOW_TEXT_CONTRAST');
  assert.ok(minorSig);
  assert.equal(minorSig.severityHint, 'minor');
  assert.equal(minorSig.ruleId, undefined);
  assert.match(minorSig.summary, /1 处纯色背景文字对比度低于 WCAG 标准/);
  assert.match(minorSig.summary, /另有 2 处位于图片\/渐变上/);

  const majorContrastSnap = baseSnapshot({
    contrastSummary: {
      violationCount: 3,
      samples: [
        { ratio: 2.1, required: 4.5, fontSize: 14, text: 'Very faint text' },
        { ratio: 3.8, required: 4.5, fontSize: 16, text: 'Low contrast label' },
      ],
      manualCheckCount: 1,
      fadedCount: 2,
    },
  });
  const majorContrastSignals = evaluateVisualPrecheckSignals(majorContrastSnap);
  const majorSig = majorContrastSignals.find(s => s.code === 'LOW_TEXT_CONTRAST');
  assert.ok(majorSig);
  assert.equal(majorSig.severityHint, 'major');
  assert.equal(majorSig.metrics.worstRatio, 2.1);

  const contrastDigest = formatPrecheckDigest([{ snapshot: majorContrastSnap, signals: majorContrastSignals }]);
  assert.match(contrastDigest, /文字对比度检查：3 处纯色背景文字低于 WCAG 标准/);
  assert.match(contrastDigest, /另有 1 处位于图片\/渐变上需结合截图复核/);
  assert.match(contrastDigest, /LOW_TEXT_CONTRAST/);

  const addrDupSignals = evaluateVisualPrecheckSignals(
    baseSnapshot({
      duplicationSummary: {
        phones: [],
        emails: [],
        addresses: [{ value: '123 Main Street', total: 4, main: 3 }],
        ctaLabels: [],
        duplicateBlocks: [],
        duplicateImages: [],
      },
    }),
  );
  const addrSig = addrDupSignals.find(s => s.code === 'CONTENT_DUPLICATION');
  assert.ok(addrSig);
  assert.equal(addrSig.severityHint, 'major');
  assert.equal(addrSig.ruleId, 'R-DUPE-01');
  assert.equal(addrSig.metrics.addressCount, 1);
  assert.match(addrSig.summary, /地址重复（123 Main Street 整页4\/正文3）/);
});
