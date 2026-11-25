import type { Page } from 'playwright';
import type { AntiPatternRuleId } from './bounded-checker-rules.js';

export interface SvgVisualCandidate {
  inHero: boolean;
  width: number;
  height: number;
  viewportAreaRatio: number;
  primitiveCount: number;
  hasChartText: boolean;
  tagPath: string;
  top: number;
  left: number;
}

export interface ImageVisualCandidate {
  inHero: boolean;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
  broken: boolean;
  srcHint: string;
}

export interface OrphanHeadingCandidate {
  tag: string;
  text: string;
  lineCount: number;
  lastLineChars: number;
}

export interface MobileMenuPrecheckResult {
  tested: boolean;
  toggleFound: boolean;
  opened: boolean;
  hasVisibleCloseControl: boolean;
  closeWorked: boolean;
  occludedToggle: boolean;
  openScreenshotFile?: string;
  detail?: string;
}

export interface SeoMetaSnapshot {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  h1Count: number;
}

export interface AnchorPrecheckSummary {
  total: number;
  valid: number;
  broken: string[];
}

export interface HeroFoldMetrics {
  hasHeroSection: boolean;
  h1Top?: number;
  h1Bottom?: number;
  ctaBottom?: number;
  heroImgBottom?: number;
  textBlockHeight?: number;
  maxTextBlockHeight?: number;
  headerBottom?: number;
  centerPct?: number;
}

export interface SplitImbalanceCandidate {
  mediaHeight: number;
  textHeight: number;
  diffPx: number;
  diffRatio: number;
  tolerancePx: number;
  textToMediaRatio: number;
}

export interface SectionAirGapCandidate {
  index: number;
  sectionHeight: number;
  contentHeight: number;
  contentRatio: number;
}

export interface ImageDistortionCandidate {
  srcHint: string;
  opacity: number;
  naturalRatio: number;
  renderedRatio: number;
  ratioDiff: number;
  reason: 'low-opacity' | 'stretched';
}

export interface DuplicationSummary {
  phones: Array<{ value: string; total: number; main: number }>;
  emails: Array<{ value: string; total: number; main: number }>;
  ctaLabels: Array<{ label: string; total: number; main: number }>;
  duplicateBlocks: Array<{ text: string; count: number }>;
  duplicateImages: Array<{ srcHint: string; count: number }>;
}

export interface LocaleHygieneSnapshot {
  htmlLang: string;
  cjkInNonCjkSite: boolean;
  nativeDateInputs: number;
  demoNavResiduals: string[];
}

export interface RawViewportPrecheckSnapshot {
  viewport: 'desktop' | 'mobile';
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  documentHeight: number;
  scrollWidth: number;
  horizontalOverflow: boolean;
  headerCoversH1: boolean;
  heroImageCount: number;
  heroRealImageCount: number;
  heroMaxImageArea: number;
  brokenImageCount: number;
  svgCandidates: SvgVisualCandidate[];
  imageCandidates: ImageVisualCandidate[];
  orphanHeadings: OrphanHeadingCandidate[];
  templateResiduals: string[];
  internalLinks?: string[];
  seoMeta?: SeoMetaSnapshot;
  anchorCheck?: AnchorPrecheckSummary;
  mobileMenu?: MobileMenuPrecheckResult;
  minFontViolationCount?: number;
  minFontSamples?: Array<{ fontSize: number; text: string }>;
  headerSticky?: boolean;
  desktopHamburgerDetected?: boolean;
  headingLineOverflows?: Array<{ tag: string; lines: number; maxLines: number; text: string }>;
  heroFoldMetrics?: HeroFoldMetrics;
  splitImbalances?: SplitImbalanceCandidate[];
  sectionAirGaps?: SectionAirGapCandidate[];
  maxVerticalBlankGap?: number;
  imageDistortions?: ImageDistortionCandidate[];
  duplicationSummary?: DuplicationSummary;
  localeHygiene?: LocaleHygieneSnapshot;
}

export type VisualPrecheckSignalCode =
  | 'HERO_SVG_PLACEHOLDER'
  | 'CARD_SVG_PLACEHOLDER'
  | 'BROKEN_IMAGE'
  | 'HORIZONTAL_OVERFLOW'
  | 'HEADER_COVERS_H1'
  | 'HEADING_ORPHAN_WRAP'
  | 'TEMPLATE_RESIDUAL'
  | 'MOBILE_MENU_TRAPPED'
  | 'TITLE_LINES_EXCEEDED'
  | 'HERO_FOLD_CLIPPED'
  | 'HERO_OFF_CENTER'
  | 'SPLIT_HEIGHT_IMBALANCE'
  | 'SECTION_AIR_GAP'
  | 'IMAGE_VISIBILITY_ISSUE'
  | 'CONTENT_DUPLICATION'
  | 'MIN_FONT_SIZE'
  | 'NAV_NOT_STICKY'
  | 'DESKTOP_HAMBURGER_NAV'
  | 'LOCALE_OR_DATE_ISSUE';

export interface VisualPrecheckSignal {
  code: VisualPrecheckSignalCode;
  ruleId?: AntiPatternRuleId;
  severityHint: 'critical' | 'major' | 'minor';
  viewport: 'desktop' | 'mobile';
  summary: string;
  metrics: Record<string, number | string | boolean>;
}

export interface ViewportVisualPrecheck {
  snapshot: RawViewportPrecheckSnapshot;
  signals: VisualPrecheckSignal[];
}

export function evaluateVisualPrecheckSignals(snapshot: RawViewportPrecheckSnapshot): VisualPrecheckSignal[] {
  const signals: VisualPrecheckSignal[] = [];

  const heroLargeSvgs = snapshot.svgCandidates.filter(
    s => s.inHero && Math.max(s.width, s.height) >= 160 && s.width * s.height >= 20000 && !s.hasChartText,
  );
  if (heroLargeSvgs.length > 0) {
    const maxSvg = heroLargeSvgs.reduce((best, cur) =>
      cur.width * cur.height > best.width * best.height ? cur : best,
    );
    const maxSvgArea = maxSvg.width * maxSvg.height;
    if (snapshot.heroRealImageCount === 0 || maxSvgArea >= snapshot.heroMaxImageArea * 0.8) {
      signals.push({
        code: 'HERO_SVG_PLACEHOLDER',
        ruleId: 'R-VISUAL-01',
        severityHint: 'major',
        viewport: snapshot.viewport,
        summary: `首屏 Hero 区域检测到 ${heroLargeSvgs.length} 个大尺寸非图表 <svg>（最大 ${Math.round(maxSvg.width)}×${Math.round(maxSvg.height)}px，图元 ${maxSvg.primitiveCount} 个），而真实有效 <img> 数量为 ${snapshot.heroRealImageCount}；请结合截图确认是否属于 R-VISUAL-01 廉价 SVG 占位。`,
        metrics: {
          count: heroLargeSvgs.length,
          maxWidth: Math.round(maxSvg.width),
          maxHeight: Math.round(maxSvg.height),
          maxAreaRatio: Math.round(maxSvg.viewportAreaRatio * 1000) / 1000,
          primitiveCount: maxSvg.primitiveCount,
          heroRealImageCount: snapshot.heroRealImageCount,
        },
      });
    }
  }

  const cardLargeSvgs = snapshot.svgCandidates.filter(
    s => !s.inHero && Math.max(s.width, s.height) >= 140 && s.width * s.height >= 18000 && !s.hasChartText,
  );
  const totalRealImages = snapshot.imageCandidates.length
    ? snapshot.imageCandidates.filter(
        i => !i.broken && i.naturalWidth > 1 && i.width >= 40 && i.height >= 40,
      ).length
    : snapshot.heroRealImageCount;
  if (cardLargeSvgs.length >= 2 || (cardLargeSvgs.length >= 1 && totalRealImages === 0)) {
    const maxCardSvg = cardLargeSvgs.reduce((best, cur) =>
      cur.width * cur.height > best.width * best.height ? cur : best,
    );
    signals.push({
      code: 'CARD_SVG_PLACEHOLDER',
      ruleId: 'R-VISUAL-01',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: `首屏下方内容卡片/区段检测到 ${cardLargeSvgs.length} 个大尺寸非图表 <svg>（最大 ${Math.round(maxCardSvg.width)}×${Math.round(maxCardSvg.height)}px），全页真实有效 <img> 共 ${totalRealImages} 张；请确认是否用几何 SVG 替代了应有的真实配图 / imagePlaceholder。`,
      metrics: {
        count: cardLargeSvgs.length,
        maxWidth: Math.round(maxCardSvg.width),
        maxHeight: Math.round(maxCardSvg.height),
        totalRealImages,
      },
    });
  }

  if (snapshot.brokenImageCount > 0) {
    signals.push({
      code: 'BROKEN_IMAGE',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: `检测到 ${snapshot.brokenImageCount} 张可见 <img> 加载失败（naturalWidth=0）。`,
      metrics: { brokenImageCount: snapshot.brokenImageCount },
    });
  }

  if (snapshot.horizontalOverflow) {
    signals.push({
      code: 'HORIZONTAL_OVERFLOW',
      ruleId: 'R-LAYOUT-03',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: `页面存在横向溢出（scrollWidth=${snapshot.scrollWidth}px > viewportWidth=${snapshot.viewportWidth}px）。`,
      metrics: { scrollWidth: snapshot.scrollWidth, viewportWidth: snapshot.viewportWidth },
    });
  }

  if (snapshot.headerCoversH1) {
    signals.push({
      code: 'HEADER_COVERS_H1',
      ruleId: 'R-LAYOUT-03',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: '固定/吸顶头部导航与页面主标题 <h1> 存在纵向重叠遮挡。',
      metrics: { headerCoversH1: true },
    });
  }

  if (snapshot.viewport === 'desktop' && snapshot.orphanHeadings.length > 0) {
    const sample = snapshot.orphanHeadings[0];
    signals.push({
      code: 'HEADING_ORPHAN_WRAP',
      severityHint: 'minor',
      viewport: snapshot.viewport,
      summary: `桌面端检测到 ${snapshot.orphanHeadings.length} 处大标题末行孤立短行断行（例如「${sample.text.slice(0, 24)}」末行仅 ${sample.lastLineChars} 字符）。`,
      metrics: { count: snapshot.orphanHeadings.length, sampleTag: sample.tag, lastLineChars: sample.lastLineChars },
    });
  }

  if (snapshot.templateResiduals.length > 0) {
    signals.push({
      code: 'TEMPLATE_RESIDUAL',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: `页面正文或标题命中模板/占位残留词：${snapshot.templateResiduals.join('、')}。`,
      metrics: { residuals: snapshot.templateResiduals.join(','), count: snapshot.templateResiduals.length },
    });
  }

    if (
    snapshot.viewport === 'mobile' &&
    snapshot.mobileMenu?.tested &&
    snapshot.mobileMenu.opened &&
    (!snapshot.mobileMenu.hasVisibleCloseControl || !snapshot.mobileMenu.closeWorked)
  ) {
    const mm = snapshot.mobileMenu;
    const parts: string[] = [];
    if (!mm.hasVisibleCloseControl) {
      parts.push('移动端导航菜单展开后未找到可见且未被遮挡的关闭入口');
    } else {
      parts.push('移动端导航菜单展开后点击关闭控件未生效，菜单无法关闭');
    }
    if (mm.occludedToggle) {
      parts.push('原汉堡菜单按钮已被全屏遮罩拦截，无法再次点击收起');
    }
    if (mm.openScreenshotFile) {
      parts.push(`展开态取证截图：${mm.openScreenshotFile}`);
    }
    signals.push({
      code: 'MOBILE_MENU_TRAPPED',
      ruleId: 'R-LAYOUT-03',
      severityHint: 'major',
      viewport: 'mobile',
      summary: parts.join('；') + '。',
      metrics: {
        hasVisibleCloseControl: mm.hasVisibleCloseControl,
        closeWorked: mm.closeWorked,
        occludedToggle: mm.occludedToggle,
        ...(mm.openScreenshotFile ? { openScreenshotFile: mm.openScreenshotFile } : {}),
      },
    });
  }

  if (snapshot.headingLineOverflows && snapshot.headingLineOverflows.length > 0) {
    const sample = snapshot.headingLineOverflows[0];
    signals.push({
      code: 'TITLE_LINES_EXCEEDED',
      severityHint: sample.tag === 'h1' ? 'major' : 'minor',
      viewport: snapshot.viewport,
      summary: `检测到 ${snapshot.headingLineOverflows.length} 处标题行数超限（例如 ${sample.tag.toUpperCase()}「${sample.text.slice(0, 24)}」占 ${sample.lines} 行 > 上限 ${sample.maxLines} 行，H27）。`,
      metrics: {
        count: snapshot.headingLineOverflows.length,
        sampleTag: sample.tag,
        sampleLines: sample.lines,
        maxLines: sample.maxLines,
      },
    });
  }

  if (snapshot.heroFoldMetrics?.hasHeroSection) {
    const fm = snapshot.heroFoldMetrics;
    const vh = snapshot.viewportHeight;
    const ctaLimit = vh - 40;
    const clipReasons: string[] = [];
    if (typeof fm.ctaBottom === 'number' && fm.ctaBottom > ctaLimit) {
      clipReasons.push(`主 CTA 底部 ${Math.round(fm.ctaBottom)}px > ${ctaLimit}px`);
    }
    if (typeof fm.heroImgBottom === 'number' && fm.heroImgBottom > vh + 8) {
      clipReasons.push(`首屏内容主图底部 ${Math.round(fm.heroImgBottom)}px > ${vh}px`);
    }
    if (
      typeof fm.textBlockHeight === 'number' &&
      typeof fm.maxTextBlockHeight === 'number' &&
      fm.textBlockHeight > fm.maxTextBlockHeight
    ) {
      clipReasons.push(`首屏文本块高 ${Math.round(fm.textBlockHeight)}px > ${fm.maxTextBlockHeight}px`);
    }
    const minHeaderGap = snapshot.viewport === 'mobile' ? 24 : 32;
    if (
      typeof fm.h1Top === 'number' &&
      typeof fm.headerBottom === 'number' &&
      fm.h1Top < fm.headerBottom + minHeaderGap
    ) {
      clipReasons.push(`H1 顶距导航底不足 ${minHeaderGap}px（${Math.round(fm.h1Top - fm.headerBottom)}px）`);
    }
    if (clipReasons.length > 0) {
      signals.push({
        code: 'HERO_FOLD_CLIPPED',
        severityHint: 'major',
        ruleId: 'R-LAYOUT-04',
        viewport: snapshot.viewport,
        summary: `首屏未完整装入安全线（H26）：${clipReasons.join('；')}。`,
        metrics: {
          ...(typeof fm.ctaBottom === 'number' ? { ctaBottom: Math.round(fm.ctaBottom) } : {}),
          ...(typeof fm.heroImgBottom === 'number' ? { heroImgBottom: Math.round(fm.heroImgBottom) } : {}),
          ...(typeof fm.textBlockHeight === 'number' ? { textBlockHeight: Math.round(fm.textBlockHeight) } : {}),
          viewportHeight: vh,
        },
      });
    }
    if (typeof fm.centerPct === 'number' && (fm.centerPct < 44 || fm.centerPct > 56)) {
      signals.push({
        code: 'HERO_OFF_CENTER',
        severityHint: 'minor',
        viewport: snapshot.viewport,
        summary: `首屏文字块垂直中心位于视口 ${fm.centerPct}%（目标 44–56%，H28）。`,
        metrics: { centerPct: fm.centerPct },
      });
    }
  }

  if (snapshot.splitImbalances && snapshot.splitImbalances.length > 0) {
    const worst = snapshot.splitImbalances.reduce((a, b) => (b.diffPx > a.diffPx ? b : a));
    const stackAdvice =
      worst.textToMediaRatio > 2.2
        ? '；文字远高于图片，建议拆 3 图纵排或改用 sticky/拆区段（H31）'
        : worst.textToMediaRatio > 1.4
          ? '；文字高于图片，建议拆 2 图纵排对齐（H31）'
          : '';
    signals.push({
      code: 'SPLIT_HEIGHT_IMBALANCE',
      severityHint: 'major',
      ruleId: 'R-LAYOUT-04',
      viewport: snapshot.viewport,
      summary: `检测到 ${snapshot.splitImbalances.length} 处分栏图文高度失衡（最大偏差：图 ${worst.mediaHeight}px / 文 ${worst.textHeight}px，差 ${worst.diffPx}px > 容差 ${worst.tolerancePx}px，H25）${stackAdvice}。`,
      metrics: {
        count: snapshot.splitImbalances.length,
        mediaHeight: worst.mediaHeight,
        textHeight: worst.textHeight,
        diffPx: worst.diffPx,
        tolerancePx: worst.tolerancePx,
        textToMediaRatio: worst.textToMediaRatio,
      },
    });
  }

  const airReasons: string[] = [];
  if (snapshot.sectionAirGaps && snapshot.sectionAirGaps.length > 0) {
    const sample = snapshot.sectionAirGaps[0];
    airReasons.push(
      `${snapshot.sectionAirGaps.length} 个区段内容占高不足 50%（例如第 ${sample.index + 1} 节占 ${Math.round(sample.contentRatio * 100)}%）`,
    );
  }
  if (typeof snapshot.maxVerticalBlankGap === 'number' && snapshot.maxVerticalBlankGap > 240) {
    airReasons.push(`区段间最大连续空白 ${Math.round(snapshot.maxVerticalBlankGap)}px > 240px`);
  }
  if (airReasons.length > 0) {
    signals.push({
      code: 'SECTION_AIR_GAP',
      severityHint: 'minor',
      viewport: snapshot.viewport,
      summary: `检测到页面空旷信号（H30）：${airReasons.join('；')}。`,
      metrics: {
        airSectionCount: snapshot.sectionAirGaps?.length || 0,
        maxVerticalBlankGap: snapshot.maxVerticalBlankGap || 0,
      },
    });
  }

  if (snapshot.imageDistortions && snapshot.imageDistortions.length > 0) {
    const sample = snapshot.imageDistortions[0];
    signals.push({
      code: 'IMAGE_VISIBILITY_ISSUE',
      severityHint: 'major',
      viewport: snapshot.viewport,
      summary: `检测到 ${snapshot.imageDistortions.length} 张可见图片存在可见性或比例异常（H29，例如 ${sample.reason === 'low-opacity' ? `opacity=${sample.opacity} < 0.6` : `宽高比偏差 ${Math.round(sample.ratioDiff * 100)}%`}）。`,
      metrics: {
        count: snapshot.imageDistortions.length,
        sampleReason: sample.reason,
      },
    });
  }

  if (snapshot.duplicationSummary) {
    const d = snapshot.duplicationSummary;
    const parts: string[] = [];
    if (d.phones.length) {
      parts.push(`电话重复（${d.phones.map(p => `${p.value} 整页${p.total}/正文${p.main}`).join('、')}）`);
    }
    if (d.emails.length) {
      parts.push(`邮箱重复（${d.emails.map(e => `${e.value} 整页${e.total}/正文${e.main}`).join('、')}）`);
    }
    if (d.ctaLabels.length) {
      parts.push(`CTA 文案重复（${d.ctaLabels.map(c => `「${c.label}」整页${c.total}/正文${c.main}`).join('、')}）`);
    }
    if (d.duplicateBlocks.length) {
      parts.push(`${d.duplicateBlocks.length} 处正文/标题完全重复`);
    }
    if (d.duplicateImages.length) {
      parts.push(`${d.duplicateImages.length} 张内容图重复超过 2 次`);
    }
    if (parts.length > 0) {
      const severe =
        d.phones.some(p => p.total > 3 || p.main > 1) ||
        d.emails.some(e => e.total > 3 || e.main > 1) ||
        d.duplicateBlocks.length > 0;
      signals.push({
        code: 'CONTENT_DUPLICATION',
        severityHint: severe ? 'major' : 'minor',
        ruleId: 'R-DUPE-01',
        viewport: snapshot.viewport,
        summary: `同页信息重复超限（H32）：${parts.join('；')}。`,
        metrics: {
          phoneCount: d.phones.length,
          emailCount: d.emails.length,
          ctaCount: d.ctaLabels.length,
          blockCount: d.duplicateBlocks.length,
          imageCount: d.duplicateImages.length,
        },
      });
    }
  }

  if (typeof snapshot.minFontViolationCount === 'number' && snapshot.minFontViolationCount > 0) {
    const sample = snapshot.minFontSamples?.[0];
    signals.push({
      code: 'MIN_FONT_SIZE',
      severityHint: snapshot.minFontViolationCount >= 10 ? 'major' : 'minor',
      ...(snapshot.minFontViolationCount >= 10 ? { ruleId: 'R-TYPO-01' as const } : {}),
      viewport: snapshot.viewport,
      summary: `检测到 ${snapshot.minFontViolationCount} 处可见文字小于 12px（H04${sample ? `，例如 ${sample.fontSize}px「${sample.text.slice(0, 20)}」` : ''}）。`,
      metrics: { count: snapshot.minFontViolationCount },
    });
  }

  if (snapshot.viewport === 'desktop' && snapshot.headerSticky === false) {
    signals.push({
      code: 'NAV_NOT_STICKY',
      severityHint: 'minor',
      viewport: 'desktop',
      summary: '桌面端 Header 未采用 sticky/fixed 吸顶定位（H03）。',
      metrics: { headerSticky: false },
    });
  }

  if (snapshot.viewport === 'desktop' && snapshot.desktopHamburgerDetected) {
    signals.push({
      code: 'DESKTOP_HAMBURGER_NAV',
      severityHint: 'major',
      viewport: 'desktop',
      summary: '桌面端（≥1024px）出现汉堡菜单且可见导航链接不足，违背 H03 桌面导航要求。',
      metrics: { desktopHamburgerDetected: true },
    });
  }

  if (snapshot.localeHygiene) {
    const lh = snapshot.localeHygiene;
    const issuesList: string[] = [];
    if (lh.cjkInNonCjkSite) issuesList.push(`lang=${lh.htmlLang || '未知'} 页面出现中文字符`);
    if (lh.nativeDateInputs > 0) issuesList.push(`使用 ${lh.nativeDateInputs} 个原生 input[type="date"]（易引发本地化显示异常）`);
    if (lh.demoNavResiduals.length > 0) issuesList.push(`存在演示入口残留（${lh.demoNavResiduals.join('、')}）`);
    if (issuesList.length > 0) {
      signals.push({
        code: 'LOCALE_OR_DATE_ISSUE',
        severityHint: lh.cjkInNonCjkSite || lh.demoNavResiduals.length > 0 ? 'major' : 'minor',
        ruleId: 'R-TYPO-01',
        viewport: snapshot.viewport,
        summary: `本地化或演示入口检查异常（H01/H13）：${issuesList.join('；')}。`,
        metrics: {
          htmlLang: lh.htmlLang,
          cjkInNonCjkSite: lh.cjkInNonCjkSite,
          nativeDateInputs: lh.nativeDateInputs,
          demoCount: lh.demoNavResiduals.length,
        },
      });
    }
  }

  return signals;
}

/**
 * Self-contained browser evaluation script; must not reference outer module helpers.
 */
export function collectViewportVisualPrecheckInPage(args: {
  viewport: 'desktop' | 'mobile';
  templateName?: string;
}): RawViewportPrecheckSnapshot {
  const root = document.documentElement;
  const body = document.body;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const documentHeight = Math.max(root.scrollHeight, body ? body.scrollHeight : 0, viewportHeight);
  const scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
  const horizontalOverflow = scrollWidth > viewportWidth + 1;
  const heroCutoffY = Math.max(viewportHeight * 1.05, 720);

  const imageCandidates: ImageVisualCandidate[] = [];
  let heroImageCount = 0;
  let heroRealImageCount = 0;
  let heroMaxImageArea = 0;
  let brokenImageCount = 0;

  for (const img of Array.from(document.images)) {
    const rect = img.getBoundingClientRect();
    let visible = rect.width > 1 && rect.height > 1;
    for (let cur: Element | null = img; visible && cur; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      ) {
        visible = false;
      }
    }
    if (!visible) continue;
    const absTop = rect.top + window.scrollY;
    const inHero = absTop < heroCutoffY;
    const broken = img.complete && img.naturalWidth === 0;
    if (broken) brokenImageCount++;
    const area = rect.width * rect.height;
    if (inHero) {
      heroImageCount++;
      if (!broken && img.naturalWidth >= 80 && rect.width >= 80 && rect.height >= 60) {
        heroRealImageCount++;
        if (area > heroMaxImageArea) heroMaxImageArea = area;
      }
    }
    imageCandidates.push({
      inHero,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
      broken,
      srcHint: (img.currentSrc || img.getAttribute('src') || '').slice(0, 140),
    });
  }

  const svgCandidates: SvgVisualCandidate[] = [];
  const vpArea = Math.max(1, viewportWidth * viewportHeight);
  for (const svg of Array.from(document.querySelectorAll('svg'))) {
    const rect = svg.getBoundingClientRect();
    let visible = rect.width >= 20 && rect.height >= 20;
    for (let cur: Element | null = svg; visible && cur; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      ) {
        visible = false;
      }
    }
    if (!visible) continue;
    const absTop = rect.top + window.scrollY;
    const inHero = absTop < heroCutoffY;
    const primitives = svg.querySelectorAll('circle, rect, line, path, polygon, polyline, ellipse').length;
    const textEls = Array.from(svg.querySelectorAll('text'));
    const numericLabels = textEls.filter(t => /\d+%?/.test(t.textContent || '')).length;
    const clsText = `${svg.getAttribute('class') || ''} ${svg.getAttribute('aria-label') || ''}`.toLowerCase();
    const hasChartText =
      (textEls.length >= 4 && numericLabels >= 2) ||
      /recharts|echarts|chartjs|highcharts|apexcharts|\bchart\b/.test(clsText);

    const pathParts: string[] = [];
    for (let i = 0, cur: Element | null = svg; i < 4 && cur && cur !== body; i++, cur = cur.parentElement) {
      const cls =
        typeof cur.className === 'string' && cur.className.trim()
          ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
      pathParts.unshift(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : cls));
    }

    svgCandidates.push({
      inHero,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportAreaRatio: (rect.width * rect.height) / vpArea,
      primitiveCount: primitives,
      hasChartText,
      tagPath: pathParts.join(' > '),
      top: Math.round(absTop),
      left: Math.round(rect.left + window.scrollX),
    });
  }

  let headerCoversH1 = false;
  const h1 = document.querySelector('h1');
  if (h1) {
    const h1Rect = h1.getBoundingClientRect();
    let h1Visible = h1Rect.width > 1 && h1Rect.height > 1;
    for (let cur: Element | null = h1; h1Visible && cur; cur = cur.parentElement) {
      const style = getComputedStyle(cur);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) === 0
      ) {
        h1Visible = false;
      }
    }
    if (h1Visible) {
      for (const el of Array.from(document.querySelectorAll('header, nav'))) {
        if (el.contains(h1)) continue;
        const hr = el.getBoundingClientRect();
        let elVisible = hr.width > 1 && hr.height > 20;
        for (let cur: Element | null = el; elVisible && cur; cur = cur.parentElement) {
          const style = getComputedStyle(cur);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            Number(style.opacity) === 0
          ) {
            elVisible = false;
          }
        }
        if (!elVisible) continue;
        const st = getComputedStyle(el);
        if (st.position === 'fixed' || st.position === 'sticky') {
          if (hr.top <= 40 && hr.bottom > h1Rect.top + 2 && hr.top < h1Rect.bottom - 2) {
            headerCoversH1 = true;
            break;
          }
        }
      }
    }
  }

  const orphanHeadings: OrphanHeadingCandidate[] = [];
  if (args.viewport === 'desktop') {
    for (const heading of Array.from(document.querySelectorAll('h1, h2'))) {
      const hRect = heading.getBoundingClientRect();
      let hVisible = hRect.width > 1 && hRect.height > 1;
      for (let cur: Element | null = heading; hVisible && cur; cur = cur.parentElement) {
        const style = getComputedStyle(cur);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          Number(style.opacity) === 0
        ) {
          hVisible = false;
        }
      }
      if (!hVisible) continue;
      const rawText = (heading.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rawText || rawText.length < 6 || rawText.length > 120) continue;
      const lines: { top: number; text: string }[] = [];
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      const range = document.createRange();
      while ((node = walker.nextNode())) {
        const str = node.textContent || '';
        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          if (!ch.trim()) continue;
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rects = range.getClientRects();
          if (!rects.length) continue;
          const top = rects[0].top;
          let bucket = lines.find(line => Math.abs(line.top - top) <= 4);
          if (!bucket) {
            bucket = { top, text: '' };
            lines.push(bucket);
          }
          bucket.text += ch;
        }
      }
      if (lines.length >= 2) {
        lines.sort((a, b) => a.top - b.top);
        const lastText = lines[lines.length - 1].text.trim();
        const hasCjk = /[\u4e00-\u9fff]/.test(lastText);
        if ((hasCjk && lastText.length <= 2) || (!hasCjk && lastText.length <= 4)) {
          orphanHeadings.push({
            tag: heading.tagName.toLowerCase(),
            text: rawText,
            lineCount: lines.length,
            lastLineChars: lastText.length,
          });
        }
      }
    }
  }

  const bodyText = `${document.title || ''}\n${body ? body.innerText : ''}`;
  const needles = ['lorem ipsum', 'edit me', 'your text here', 'company name here', 'home 2', 'home 3'];
  if (args.templateName && args.templateName.trim().length >= 3) {
    needles.push(args.templateName.trim().toLowerCase());
  }
  const lowerBody = bodyText.toLowerCase();
  const templateResiduals = needles.filter(needle => lowerBody.includes(needle));

  const internalLinks: string[] = [];
  const seenInternalLinks: Record<string, boolean> = {};
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const rawHref = (anchor.getAttribute('href') || '').trim();
    if (!rawHref || rawHref.startsWith('#') || /^(?:mailto|tel|javascript|data|blob):/i.test(rawHref)) {
      continue;
    }
    try {
      const parsed = new URL(rawHref, location.href);
      if (parsed.origin !== location.origin) continue;
      let normalizedPath = parsed.pathname || '/';
      if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
        normalizedPath = normalizedPath.slice(0, -1);
      }
      if (
        normalizedPath.startsWith('/_api/') ||
        /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|mp4|mp3)$/i.test(normalizedPath)
      ) {
        continue;
      }
      const fullRel = normalizedPath + parsed.search;
      if (!seenInternalLinks[fullRel]) {
        seenInternalLinks[fullRel] = true;
        internalLinks.push(fullRel);
        if (internalLinks.length >= 40) break;
      }
    } catch {
      // ignore malformed href
    }
  }

  const descEl = document.querySelector('meta[name="description"]');
  const canonicalEl = document.querySelector('link[rel="canonical"]');
  const robotsEl = document.querySelector('meta[name="robots"]');
  const seoMeta = {
    title: (document.title || '').trim().slice(0, 200),
    description: (descEl?.getAttribute('content') || '').trim().slice(0, 300),
    canonical: (canonicalEl?.getAttribute('href') || '').trim().slice(0, 300),
    robots: (robotsEl?.getAttribute('content') || '').trim().slice(0, 120),
    h1Count: document.querySelectorAll('h1').length,
  };

  let anchorTotal = 0;
  let anchorValid = 0;
  const brokenAnchors: string[] = [];
  for (const anchor of Array.from(document.querySelectorAll('a[href^="#"]'))) {
    const rawHashHref = (anchor.getAttribute('href') || '').trim();
    if (rawHashHref.length <= 1) continue;
    let fragment = rawHashHref.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // keep raw fragment
    }
    if (!fragment) continue;
    anchorTotal++;
    let targetEl = document.getElementById(fragment);
    if (!targetEl) {
      try {
        const escaped = fragment.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        targetEl = document.querySelector(`[name="${escaped}"]`);
      } catch {
        targetEl = null;
      }
    }
    if (targetEl) {
      anchorValid++;
    } else if (brokenAnchors.length < 10 && brokenAnchors.indexOf(rawHashHref) === -1) {
      brokenAnchors.push(rawHashHref);
    }
  }
  const anchorCheck = {
    total: anchorTotal,
    valid: anchorValid,
    broken: brokenAnchors,
  };

  // --- v1.2 DOM probes (must stay free of named local functions to avoid esbuild __name) ---
  let minFontViolationCount = 0;
  const minFontSamples: Array<{ fontSize: number; text: string }> = [];
  if (body) {
    for (const el of Array.from(body.querySelectorAll('*'))) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') continue;
      if (el.closest('svg, [aria-hidden="true"], .sr-only')) continue;
      let hasDirectText = false;
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === 3 && node.textContent && node.textContent.trim().length > 0) {
          hasDirectText = true;
          break;
        }
      }
      if (!hasDirectText) continue;
      const er = el.getBoundingClientRect();
      if (er.width < 2 || er.height < 2) continue;
      let elVis = true;
      for (let cur: Element | null = el; elVis && cur; cur = cur.parentElement) {
        const st = getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) {
          elVis = false;
        }
      }
      if (!elVis) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (Number.isFinite(fs) && fs < 11.9) {
        minFontViolationCount++;
        if (minFontSamples.length < 5) {
          minFontSamples.push({
            fontSize: Math.round(fs * 10) / 10,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          });
        }
      }
    }
  }

  let headerSticky: boolean | undefined;
  let desktopHamburgerDetected = false;
  const headerEl = document.querySelector('header');
  if (headerEl) {
    const hdrRect = headerEl.getBoundingClientRect();
    const hdrStyle = getComputedStyle(headerEl);
    if (hdrRect.width > 1 && hdrRect.height > 1 && hdrStyle.display !== 'none' && hdrStyle.visibility !== 'hidden') {
      headerSticky = hdrStyle.position === 'sticky' || hdrStyle.position === 'fixed';
      if (args.viewport === 'desktop' && viewportWidth >= 1024) {
        let visibleNavLinks = 0;
        for (const a of Array.from(headerEl.querySelectorAll('nav a, a[href]'))) {
          if (a.querySelector('img, svg') && !(a.textContent || '').trim()) continue;
          const ar = a.getBoundingClientRect();
          if (ar.width < 2 || ar.height < 2) continue;
          const ast = getComputedStyle(a);
          if (ast.display !== 'none' && ast.visibility !== 'hidden' && Number(ast.opacity) > 0) {
            visibleNavLinks++;
          }
        }
        let hasVisibleHamburger = false;
        for (const btn of Array.from(headerEl.querySelectorAll('button, [role="button"]'))) {
          const br = btn.getBoundingClientRect();
          if (br.width < 12 || br.height < 12) continue;
          const bst = getComputedStyle(btn);
          if (bst.display === 'none' || bst.visibility === 'hidden' || Number(bst.opacity) === 0) continue;
          const hint = `${btn.getAttribute('aria-label') || ''} ${typeof (btn as HTMLElement).className === 'string' ? (btn as HTMLElement).className : ''} ${btn.textContent || ''}`;
          if (btn.hasAttribute('aria-expanded') || /menu|nav|hamburger|drawer|菜单|导航|≡|☰/i.test(hint)) {
            hasVisibleHamburger = true;
            break;
          }
        }
        if (hasVisibleHamburger && visibleNavLinks < 3) {
          desktopHamburgerDetected = true;
        }
      }
    }
  }

  const headingLineOverflows: Array<{ tag: string; lines: number; maxLines: number; text: string }> = [];
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    const hr = h.getBoundingClientRect();
    if (hr.width <= 1 || hr.height <= 1) continue;
    let hVis = true;
    for (let cur: Element | null = h; hVis && cur; cur = cur.parentElement) {
      const st = getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) {
        hVis = false;
      }
    }
    if (!hVis) continue;
    const hStyle = getComputedStyle(h);
    const lh = parseFloat(hStyle.lineHeight) || parseFloat(hStyle.fontSize) * 1.2;
    const range = document.createRange();
    range.selectNodeContents(h);
    const tops = Array.from(range.getClientRects())
      .filter(r => r.width > 2)
      .map(r => r.top)
      .sort((a, b) => a - b);
    let lineCount = 0;
    let lastTop = -1e9;
    for (const t of tops) {
      if (t - lastTop > lh * 0.45) {
        lineCount++;
        lastTop = t;
      }
    }
    if (!lineCount) lineCount = 1;
    const maxLines = h.tagName === 'H1' ? 3 : 2;
    if (lineCount > maxLines) {
      headingLineOverflows.push({
        tag: h.tagName.toLowerCase(),
        lines: lineCount,
        maxLines,
        text: (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    }
  }

  const mainEl = document.querySelector('main') || body;
  let heroSection: Element | null = null;
  if (mainEl) {
    for (const sec of Array.from(mainEl.querySelectorAll('section'))) {
      const sr = sec.getBoundingClientRect();
      const sst = getComputedStyle(sec);
      if (sr.width > 1 && sr.height > 240 && sst.display !== 'none' && sst.visibility !== 'hidden') {
        heroSection = sec;
        break;
      }
    }
    if (!heroSection) heroSection = mainEl;
  }

  const heroFoldMetrics: HeroFoldMetrics = { hasHeroSection: Boolean(heroSection) };
  if (heroSection) {
    let heroBtn: Element | null = null;
    for (const b of Array.from(heroSection.querySelectorAll('a, button'))) {
      if (b.closest('header, footer')) continue;
      const br = b.getBoundingClientRect();
      if (br.width <= 1 || br.height <= 1) continue;
      let bVis = true;
      for (let cur: Element | null = b; bVis && cur; cur = cur.parentElement) {
        const st = getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) {
          bVis = false;
        }
      }
      if (!bVis) continue;
      const bst = getComputedStyle(b);
      if (bst.backgroundColor !== 'rgba(0, 0, 0, 0)' || bst.borderTopWidth !== '0px') {
        heroBtn = b;
        break;
      }
    }
    let heroContentImg: Element | null = null;
    let heroContentImgH = 0;
    for (const img of Array.from(heroSection.querySelectorAll('img'))) {
      const ir = img.getBoundingClientRect();
      if (ir.width <= 1 || ir.height <= 180) continue;
      const ist = getComputedStyle(img);
      if (ist.display === 'none' || ist.visibility === 'hidden' || Number(ist.opacity) === 0) continue;
      if (ist.position === 'absolute' || ist.position === 'fixed' || (ir.width >= viewportWidth * 0.85 && ir.height >= viewportHeight * 0.55)) {
        continue;
      }
      if (ir.height > heroContentImgH) {
        heroContentImgH = ir.height;
        heroContentImg = img;
      }
    }
    if (heroBtn) {
      heroFoldMetrics.ctaBottom = Math.round(heroBtn.getBoundingClientRect().bottom);
    }
    if (heroContentImg) {
      heroFoldMetrics.heroImgBottom = Math.round(heroContentImg.getBoundingClientRect().bottom);
    }
    if (h1) {
      const h1r = h1.getBoundingClientRect();
      if (h1r.width > 1 && h1r.height > 1) {
        heroFoldMetrics.h1Top = Math.round(h1r.top);
        heroFoldMetrics.h1Bottom = Math.round(h1r.bottom);
        if (headerEl) {
          const hdrR = headerEl.getBoundingClientRect();
          if (hdrR.height > 1) heroFoldMetrics.headerBottom = Math.round(hdrR.bottom);
        }
        if (heroBtn) {
          heroFoldMetrics.textBlockHeight = Math.round(heroBtn.getBoundingClientRect().bottom - h1r.top);
          heroFoldMetrics.maxTextBlockHeight =
            viewportWidth < 768 ? 560 : viewportHeight <= 780 ? 520 : viewportHeight <= 840 ? 560 : 640;
        }
      }
    }
    if (heroBtn && heroSection.getBoundingClientRect().height >= viewportHeight * 0.6) {
      let minTop = Infinity;
      for (const tEl of Array.from(heroSection.querySelectorAll('h1, p, li, a, button'))) {
        const tr = tEl.getBoundingClientRect();
        const tst = getComputedStyle(tEl);
        if (tr.width > 1 && tr.height > 1 && tst.display !== 'none' && tst.visibility !== 'hidden') {
          if (tr.top < minTop) minTop = tr.top;
        }
      }
      if (Number.isFinite(minTop)) {
        let cBottom = heroBtn.getBoundingClientRect().bottom;
        if (viewportWidth < 768 && heroContentImg) {
          const heroImgR = heroContentImg.getBoundingClientRect();
          if (heroImgR.top >= cBottom - 8 && heroImgR.bottom <= viewportHeight + 8) {
            cBottom = Math.max(cBottom, heroImgR.bottom);
          }
        }
        heroFoldMetrics.centerPct = Math.round(((minTop + cBottom) / 2 / viewportHeight) * 100);
      }
    }
  }

  const splitImbalances: SplitImbalanceCandidate[] = [];
  if (mainEl && args.viewport === 'desktop' && viewportWidth >= 1024) {
    let checkedSplits = 0;
    for (const el of Array.from(mainEl.querySelectorAll('*'))) {
      if (checkedSplits >= 8) break;
      const elTag = el.tagName.toUpperCase();
      if (elTag === 'ARTICLE' || elTag === 'LI' || elTag === 'A') continue;
      const st = getComputedStyle(el);
      if (st.display !== 'grid' && st.display !== 'flex') continue;
      if (st.display === 'flex' && !st.flexDirection.startsWith('row')) continue;
      const er = el.getBoundingClientRect();
      if (er.width < viewportWidth * 0.55 || er.height < 240) continue;
      const parentEl = el.parentElement;
      if (parentEl && parentEl !== mainEl && parentEl !== body) {
        let sameWidthSiblings = 0;
        for (const sib of Array.from(parentEl.children)) {
          if (sib.tagName !== el.tagName) continue;
          const sr = sib.getBoundingClientRect();
          const sst = getComputedStyle(sib);
          if (sr.width > 1 && sr.height > 1 && sst.display !== 'none' && sst.visibility !== 'hidden') {
            if (Math.abs(sr.width - er.width) <= Math.max(24, er.width * 0.15)) {
              sameWidthSiblings++;
            }
          }
        }
        if (sameWidthSiblings >= 3) continue;
      }
      const visKids: Element[] = [];
      for (const kid of Array.from(el.children)) {
        const kr = kid.getBoundingClientRect();
        const kst = getComputedStyle(kid);
        if (kr.width > 1 && kr.height > 1 && kst.display !== 'none' && kst.visibility !== 'hidden') {
          visKids.push(kid);
        }
      }
      if (visKids.length !== 2) continue;
      const mediaCol = visKids.find(k => Boolean(k.querySelector('img')));
      const textCol = visKids.find(k => k !== mediaCol);
      if (!mediaCol || !textCol) continue;
      if (getComputedStyle(mediaCol).position === 'sticky') continue;
      checkedSplits++;
      let mTop = Infinity;
      let mBottom = -Infinity;
      for (const im of Array.from(mediaCol.querySelectorAll('img'))) {
        const mr = im.getBoundingClientRect();
        const mst = getComputedStyle(im);
        if (mr.width > 1 && mr.height > 1 && mst.display !== 'none' && mst.visibility !== 'hidden') {
          if (mr.top < mTop) mTop = mr.top;
          if (mr.bottom > mBottom) mBottom = mr.bottom;
        }
      }
      let tTop = Infinity;
      let tBottom = -Infinity;
      for (const te of Array.from(textCol.querySelectorAll('h1, h2, h3, p, li, button, a'))) {
        const tr = te.getBoundingClientRect();
        const tst = getComputedStyle(te);
        if (tr.width > 1 && tr.height > 1 && tst.display !== 'none' && tst.visibility !== 'hidden') {
          if (tr.top < tTop) tTop = tr.top;
          if (tr.bottom > tBottom) tBottom = tr.bottom;
        }
      }
      if (!Number.isFinite(mTop) || !Number.isFinite(tTop)) continue;
      const mh = mBottom - mTop;
      const th = tBottom - tTop;
      if (mh < 120 || th < 120) continue;
      const diff = Math.abs(mh - th);
      const minSide = Math.min(mh, th);
      const tol = Math.max(48, minSide * 0.08);
      if (diff > tol) {
        splitImbalances.push({
          mediaHeight: Math.round(mh),
          textHeight: Math.round(th),
          diffPx: Math.round(diff),
          diffRatio: Math.round((diff / Math.max(1, minSide)) * 100) / 100,
          tolerancePx: Math.round(tol),
          textToMediaRatio: Math.round((th / Math.max(1, mh)) * 100) / 100,
        });
      }
    }
  }

  const sectionAirGaps: SectionAirGapCandidate[] = [];
  let maxVerticalBlankGap = 0;
  if (mainEl && args.viewport === 'desktop') {
    const sections = Array.from(mainEl.querySelectorAll('section')).filter(s => {
      const sr = s.getBoundingClientRect();
      const sst = getComputedStyle(s);
      return sr.width > 1 && sr.height > 1 && sst.display !== 'none' && sst.visibility !== 'hidden';
    });
    let prevContentBottom: number | null = null;
    for (let idx = 0; idx < sections.length; idx++) {
      const sec = sections[idx];
      const sr = sec.getBoundingClientRect();
      let cTop = Infinity;
      let cBottom = -Infinity;
      for (const child of Array.from(sec.querySelectorAll('h1, h2, h3, h4, p, li, img, video, table, form, button, a, svg'))) {
        const cr = child.getBoundingClientRect();
        const cst = getComputedStyle(child);
        if (cr.width <= 1 || cr.height <= 1 || cst.display === 'none' || cst.visibility === 'hidden') continue;
        if (cst.position === 'absolute' || cst.position === 'fixed') continue;
        if (cr.top < cTop) cTop = cr.top;
        if (cr.bottom > cBottom) cBottom = cr.bottom;
      }
      if (Number.isFinite(cTop) && Number.isFinite(cBottom)) {
        if (prevContentBottom !== null) {
          const gap = cTop - prevContentBottom;
          if (gap > maxVerticalBlankGap) maxVerticalBlankGap = Math.round(gap);
        }
        prevContentBottom = cBottom;
        const contentH = cBottom - cTop;
        const hasFullBg = Array.from(sec.querySelectorAll('img, video')).some(m => {
          const mr = m.getBoundingClientRect();
          const mst = getComputedStyle(m);
          return (mst.position === 'absolute' || mst.position === 'fixed') && mr.width >= sr.width * 0.8 && mr.height >= sr.height * 0.7;
        });
        if (idx >= 1 && sr.height >= 360 && !hasFullBg) {
          const ratio = contentH / sr.height;
          if (ratio < 0.5) {
            sectionAirGaps.push({
              index: idx,
              sectionHeight: Math.round(sr.height),
              contentHeight: Math.round(contentH),
              contentRatio: Math.round(ratio * 100) / 100,
            });
          }
        }
      }
    }
  }

  const imageDistortions: ImageDistortionCandidate[] = [];
  for (const img of Array.from(document.images)) {
    const ir = img.getBoundingClientRect();
    if (ir.width < 60 || ir.height < 60) continue;
    let imgVis = true;
    for (let cur: Element | null = img; imgVis && cur; cur = cur.parentElement) {
      const st = getComputedStyle(cur);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') imgVis = false;
    }
    if (!imgVis || img.naturalWidth === 0 || img.naturalHeight === 0) continue;
    const ist = getComputedStyle(img);
    const op = Number(ist.opacity);
    const natRatio = img.naturalWidth / img.naturalHeight;
    const renRatio = ir.width / ir.height;
    const ratioDiff = Math.abs(renRatio - natRatio) / Math.max(0.01, natRatio);
    const srcHint = (img.currentSrc || img.getAttribute('src') || '').slice(0, 100);
    if (Number.isFinite(op) && op < 0.6) {
      imageDistortions.push({
        srcHint,
        opacity: Math.round(op * 100) / 100,
        naturalRatio: Math.round(natRatio * 100) / 100,
        renderedRatio: Math.round(renRatio * 100) / 100,
        ratioDiff: Math.round(ratioDiff * 100) / 100,
        reason: 'low-opacity',
      });
    } else if (ist.objectFit !== 'cover' && ist.objectFit !== 'contain' && ratioDiff > 0.15) {
      imageDistortions.push({
        srcHint,
        opacity: Math.round(op * 100) / 100,
        naturalRatio: Math.round(natRatio * 100) / 100,
        renderedRatio: Math.round(renRatio * 100) / 100,
        ratioDiff: Math.round(ratioDiff * 100) / 100,
        reason: 'stretched',
      });
    }
  }

  const phoneCounts: Record<string, { display: string; total: number; main: number }> = {};
  const emailCounts: Record<string, { total: number; main: number }> = {};
  const ctaCounts: Record<string, { label: string; total: number; main: number }> = {};
  const blockCounts: Record<string, { text: string; count: number }> = {};
  const dupImgCounts: Record<string, { srcHint: string; count: number }> = {};

  if (body) {
    const zones: Array<{ zone: 'header' | 'main' | 'footer'; text: string }> = [];
    const footerEl = document.querySelector('footer');
    if (headerEl) zones.push({ zone: 'header', text: (headerEl as HTMLElement).innerText || '' });
    if (footerEl) zones.push({ zone: 'footer', text: (footerEl as HTMLElement).innerText || '' });
    if (mainEl) {
      const mainCloneText = Array.from(mainEl.children)
        .filter(c => c.tagName !== 'HEADER' && c.tagName !== 'FOOTER' && !c.closest('[aria-hidden="true"]'))
        .map(c => (c as HTMLElement).innerText || '')
        .join('\n');
      zones.push({ zone: 'main', text: mainCloneText || (mainEl as HTMLElement).innerText || '' });
    }
    for (const z of zones) {
      const phoneMatches = z.text.match(/(?:\+|00)?\d[\d\s().-]{7,18}\d/g) || [];
      for (const rawPhone of phoneMatches) {
        if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(rawPhone.trim())) continue;
        const digits = rawPhone.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) continue;
        const key = digits.slice(-9);
        if (!phoneCounts[key]) phoneCounts[key] = { display: rawPhone.trim(), total: 0, main: 0 };
        phoneCounts[key].total++;
        if (z.zone === 'main') phoneCounts[key].main++;
      }
      const emailMatches = z.text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      for (const rawEmail of emailMatches) {
        const key = rawEmail.toLowerCase();
        if (!emailCounts[key]) emailCounts[key] = { total: 0, main: 0 };
        emailCounts[key].total++;
        if (z.zone === 'main') emailCounts[key].main++;
      }
    }

    for (const cta of Array.from(document.querySelectorAll('a, button'))) {
      if (cta.closest('[aria-hidden="true"], nav')) continue;
      const cr = cta.getBoundingClientRect();
      if (cr.width < 20 || cr.height < 20) continue;
      const cst = getComputedStyle(cta);
      if (cst.display === 'none' || cst.visibility === 'hidden' || Number(cst.opacity) === 0) continue;
      const isStyledBtn =
        cta.tagName === 'BUTTON' || cst.backgroundColor !== 'rgba(0, 0, 0, 0)' || cst.borderTopWidth !== '0px';
      if (!isStyledBtn) continue;
      const rawLabel = (cta.textContent || '').replace(/\s+/g, ' ').trim();
      if (rawLabel.length < 2 || rawLabel.length > 40) continue;
      const key = rawLabel.toLowerCase();
      if (!ctaCounts[key]) ctaCounts[key] = { label: rawLabel, total: 0, main: 0 };
      ctaCounts[key].total++;
      if (!cta.closest('header, footer')) ctaCounts[key].main++;
    }

    for (const blk of Array.from(document.querySelectorAll('main p, main h1, main h2, main h3, main blockquote'))) {
      if (blk.closest('[aria-hidden="true"], header, footer')) continue;
      const br = blk.getBoundingClientRect();
      if (br.width < 10 || br.height < 10) continue;
      const bst = getComputedStyle(blk);
      if (bst.display === 'none' || bst.visibility === 'hidden' || Number(bst.opacity) === 0) continue;
      const clean = (blk.textContent || '').replace(/\s+/g, ' ').trim();
      const hasCjk = /[\u4e00-\u9fff]/.test(clean);
      const wordCount = clean.split(/\s+/).filter(Boolean).length;
      if ((hasCjk && clean.length >= 20) || (!hasCjk && wordCount >= 8)) {
        const key = clean.toLowerCase();
        if (!blockCounts[key]) blockCounts[key] = { text: clean.slice(0, 60), count: 0 };
        blockCounts[key].count++;
      }
    }

    for (const im of Array.from(document.images)) {
      if (im.closest('[aria-hidden="true"], header, footer')) continue;
      const ir = im.getBoundingClientRect();
      if (ir.width < 100 || ir.height < 80) continue;
      const ist = getComputedStyle(im);
      if (ist.display === 'none' || ist.visibility === 'hidden' || Number(ist.opacity) === 0) continue;
      const rawSrc = (im.currentSrc || im.getAttribute('src') || '').trim();
      if (!rawSrc || rawSrc.startsWith('data:')) continue;
      const key = rawSrc.split('#')[0];
      if (!dupImgCounts[key]) dupImgCounts[key] = { srcHint: rawSrc.slice(0, 80), count: 0 };
      dupImgCounts[key].count++;
    }
  }

  const duplicationSummary: DuplicationSummary = {
    phones: Object.values(phoneCounts)
      .filter(p => p.total > 3 || p.main > 1)
      .map(p => ({ value: p.display, total: p.total, main: p.main })),
    emails: Object.entries(emailCounts)
      .filter(([, e]) => e.total > 3 || e.main > 1)
      .map(([value, e]) => ({ value, total: e.total, main: e.main })),
    ctaLabels: Object.values(ctaCounts)
      .filter(c => c.total > 3 || c.main > 2)
      .map(c => ({ label: c.label, total: c.total, main: c.main })),
    duplicateBlocks: Object.values(blockCounts).filter(b => b.count >= 2),
    duplicateImages: Object.values(dupImgCounts).filter(d => d.count > 2),
  };

  const htmlLang = (root.getAttribute('lang') || '').trim().toLowerCase();
  const visibleBodyText = body ? body.innerText || '' : '';
  const cjkInNonCjkSite = Boolean(htmlLang && !/^(?:zh|ja|ko)\b/.test(htmlLang) && /[\u4e00-\u9fff]/.test(visibleBodyText));
  const nativeDateInputs = document.querySelectorAll('input[type="date"]').length;
  const demoNavResiduals: string[] = [];
  for (const el of Array.from(document.querySelectorAll('header a, nav a, h1, h2'))) {
    const er = el.getBoundingClientRect();
    if (er.width < 1 || er.height < 1) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(?:home\s*[23]|demos?|all\s+pages)$/i.test(t) && demoNavResiduals.indexOf(t) === -1) {
      demoNavResiduals.push(t);
    }
  }
  const localeHygiene: LocaleHygieneSnapshot = {
    htmlLang,
    cjkInNonCjkSite,
    nativeDateInputs,
    demoNavResiduals,
  };

  return {
    viewport: args.viewport,
    url: location.href,
    viewportWidth,
    viewportHeight,
    documentHeight,
    scrollWidth,
    horizontalOverflow,
    headerCoversH1,
    heroImageCount,
    heroRealImageCount,
    heroMaxImageArea,
    brokenImageCount,
    svgCandidates,
    imageCandidates,
    orphanHeadings,
    templateResiduals,
    internalLinks,
    seoMeta,
    anchorCheck,
    minFontViolationCount,
    minFontSamples,
    ...(headerSticky !== undefined ? { headerSticky } : {}),
    desktopHamburgerDetected,
    headingLineOverflows,
    heroFoldMetrics,
    splitImbalances,
    sectionAirGaps,
    maxVerticalBlankGap,
    imageDistortions,
    duplicationSummary,
    localeHygiene,
  };
}

interface MobileMenuDomBeforeState {
  beforeExpanded: string;
  controlsId: string;
  beforeControlsVisible: boolean;
  beforeOverlayCount: number;
  beforeNavLinks: number;
}

/**
 * Self-contained browser evaluation script; must not use outer helpers or named local closures.
 */
export function inspectMobileMenuStateInPage(args: {
  phase: 'initial' | 'afterOpen' | 'afterClose';
  before?: MobileMenuDomBeforeState;
  afterOverlayCount?: number;
  afterNavLinks?: number;
}): {
  found: boolean;
  beforeExpanded: string;
  controlsId: string;
  beforeControlsVisible: boolean;
  beforeOverlayCount: number;
  beforeNavLinks: number;
  opened: boolean;
  occludedToggle: boolean;
  hasVisibleCloseControl: boolean;
  afterOverlayCount: number;
  afterNavLinks: number;
  stillOpen: boolean;
} {
  let toggle: Element | null = null;
  if (args.phase === 'initial') {
    window.scrollTo(0, 0);
    for (const node of Array.from(document.querySelectorAll('[data-kb-menu-probe-toggle], [data-kb-menu-probe-close]'))) {
      node.removeAttribute('data-kb-menu-probe-toggle');
      node.removeAttribute('data-kb-menu-probe-close');
    }

    let bestScore = -1;
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], summary'))) {
      if (el.closest('a[href]') && el.tagName !== 'BUTTON') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16 || rect.top < -4 || rect.top > 140 || rect.bottom > window.innerHeight) {
        continue;
      }
      let vis = true;
      for (let cur: Element | null = el; vis && cur; cur = cur.parentElement) {
        const st = getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) {
          vis = false;
        }
      }
      if (!vis) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) continue;

      const hint = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '',
        el.id || '',
        el.textContent || '',
      ]
        .join(' ')
        .trim();
      if (/语言|lang|en|zh|tel|phone|search|搜索/i.test(hint) && !/菜单|导航|menu|nav/i.test(hint)) continue;

      let score = 0;
      if (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')) score += 4;
      if (/菜单|导航|menu|nav|hamburger|drawer|toggle/i.test(hint)) score += 3;
      if (el.closest('header, nav, [role="banner"]')) score += 2;
      const hasIcon = Boolean(el.querySelector('svg')) || /[☰≡]/.test(el.textContent || '');
      if (rect.top <= 120 && rect.width <= 96 && rect.height <= 72 && hasIcon) score += 2;
      if (score >= 3 && score > bestScore) {
        bestScore = score;
        toggle = el;
      }
    }
    if (!toggle) {
      return {
        found: false,
        beforeExpanded: '',
        controlsId: '',
        beforeControlsVisible: false,
        beforeOverlayCount: 0,
        beforeNavLinks: 0,
        opened: false,
        occludedToggle: false,
        hasVisibleCloseControl: true,
        afterOverlayCount: 0,
        afterNavLinks: 0,
        stillOpen: false,
      };
    }
    toggle.setAttribute('data-kb-menu-probe-toggle', '1');
  } else {
    toggle = document.querySelector('[data-kb-menu-probe-toggle="1"]');
  }

  let overlayCount = 0;
  for (const node of Array.from(document.body.querySelectorAll('*'))) {
    if (node === document.body || node === document.documentElement) continue;
    const st = getComputedStyle(node);
    if (st.position !== 'fixed' && st.position !== 'absolute') continue;
    const r = node.getBoundingClientRect();
    if (r.width < window.innerWidth * 0.5 || r.height < window.innerHeight * 0.45) continue;
    let vis = true;
    for (let cur: Element | null = node; vis && cur; cur = cur.parentElement) {
      const pst = getComputedStyle(cur);
      if (pst.display === 'none' || pst.visibility === 'hidden' || pst.visibility === 'collapse' || Number(pst.opacity) === 0) {
        vis = false;
      }
    }
    if (vis) overlayCount++;
  }

  let navLinkCount = 0;
  for (const a of Array.from(
    document.querySelectorAll('header a, nav a, [role="navigation"] a, [role="dialog"] a, [aria-modal="true"] a'),
  )) {
    if (!(a.textContent || '').trim()) continue;
    const ar = a.getBoundingClientRect();
    if (ar.width < 4 || ar.height < 4) continue;
    let vis = true;
    for (let cur: Element | null = a; vis && cur; cur = cur.parentElement) {
      const ast = getComputedStyle(cur);
      if (ast.display === 'none' || ast.visibility === 'hidden' || ast.visibility === 'collapse' || Number(ast.opacity) === 0) {
        vis = false;
      }
    }
    if (vis) navLinkCount++;
  }

  const controlsId = args.phase === 'initial' ? toggle?.getAttribute('aria-controls') || '' : args.before?.controlsId || '';
  const controlsEl = controlsId ? document.getElementById(controlsId) : null;
  let controlsVisible = false;
  if (controlsEl) {
    const cr = controlsEl.getBoundingClientRect();
    controlsVisible = cr.width >= 4 && cr.height >= 4;
    for (let cur: Element | null = controlsEl; controlsVisible && cur; cur = cur.parentElement) {
      const cst = getComputedStyle(cur);
      if (cst.display === 'none' || cst.visibility === 'hidden' || cst.visibility === 'collapse' || Number(cst.opacity) === 0) {
        controlsVisible = false;
      }
    }
  }

  if (args.phase === 'initial') {
    return {
      found: true,
      beforeExpanded: toggle?.getAttribute('aria-expanded') || '',
      controlsId,
      beforeControlsVisible: controlsVisible,
      beforeOverlayCount: overlayCount,
      beforeNavLinks: navLinkCount,
      opened: false,
      occludedToggle: false,
      hasVisibleCloseControl: true,
      afterOverlayCount: 0,
      afterNavLinks: 0,
      stillOpen: false,
    };
  }

  const before = args.before!;
  const expandedNow = toggle?.getAttribute('aria-expanded') || '';
  const isOpenNow =
    (expandedNow === 'true' && before.beforeExpanded !== 'true') ||
    (!before.beforeControlsVisible && controlsVisible) ||
    overlayCount > before.beforeOverlayCount ||
    navLinkCount - before.beforeNavLinks >= 2;

  if (args.phase === 'afterClose') {
    const stillOpen =
      (expandedNow === 'true' && before.beforeExpanded !== 'true') ||
      (!before.beforeControlsVisible && controlsVisible) ||
      ((args.afterOverlayCount || 0) > before.beforeOverlayCount && overlayCount > before.beforeOverlayCount) ||
      ((args.afterNavLinks || 0) - before.beforeNavLinks >= 2 && navLinkCount >= (args.afterNavLinks || 0));
    return {
      found: true,
      beforeExpanded: before.beforeExpanded,
      controlsId,
      beforeControlsVisible: before.beforeControlsVisible,
      beforeOverlayCount: before.beforeOverlayCount,
      beforeNavLinks: before.beforeNavLinks,
      opened: isOpenNow,
      occludedToggle: false,
      hasVisibleCloseControl: true,
      afterOverlayCount: overlayCount,
      afterNavLinks: navLinkCount,
      stillOpen,
    };
  }

  let toggleUnoccluded = false;
  if (toggle) {
    const tr = toggle.getBoundingClientRect();
    let tvis = tr.width >= 4 && tr.height >= 4;
    for (let cur: Element | null = toggle; tvis && cur; cur = cur.parentElement) {
      const tst = getComputedStyle(cur);
      if (tst.display === 'none' || tst.visibility === 'hidden' || tst.visibility === 'collapse' || Number(tst.opacity) === 0) {
        tvis = false;
      }
    }
    if (tvis) {
      const tcx = tr.left + tr.width / 2;
      const tcy = tr.top + tr.height / 2;
      if (tcx >= 0 && tcx <= window.innerWidth && tcy >= 0 && tcy <= window.innerHeight) {
        const thit = document.elementFromPoint(tcx, tcy);
        toggleUnoccluded = Boolean(thit && (thit === toggle || toggle.contains(thit) || thit.contains(toggle)));
      }
    }
  }

  let closeChoice: Element | null = null;
  let closeChoiceScore = -1;
  if (isOpenNow) {
    for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      if (el.closest('a[href]') && el.tagName !== 'BUTTON') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      let vis = true;
      for (let cur: Element | null = el; vis && cur; cur = cur.parentElement) {
        const st = getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || Number(st.opacity) === 0) {
          vis = false;
        }
      }
      if (!vis) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) continue;

      const labelText = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '',
        el.textContent || '',
      ]
        .join(' ')
        .trim();

      let score = 0;
      if (/关闭|收起|取消|close|dismiss|×|✕|✖/i.test(labelText)) score = 3;
      else if (el === toggle && toggleUnoccluded) score = 2;
      else if (
        rect.top <= 140 &&
        rect.width <= 80 &&
        rect.height <= 80 &&
        Boolean(el.closest('header, nav, [role="dialog"], [aria-modal="true"]')) &&
        (Boolean(el.querySelector('svg')) || /[×✕✖]/.test(el.textContent || ''))
      ) {
        score = 1;
      }
      if (score > closeChoiceScore) {
        closeChoiceScore = score;
        closeChoice = el;
      }
    }
    if (closeChoice && closeChoiceScore > 0) {
      closeChoice.setAttribute('data-kb-menu-probe-close', '1');
    } else {
      closeChoice = null;
    }
  }

  return {
    found: true,
    beforeExpanded: before.beforeExpanded,
    controlsId,
    beforeControlsVisible: before.beforeControlsVisible,
    beforeOverlayCount: before.beforeOverlayCount,
    beforeNavLinks: before.beforeNavLinks,
    opened: isOpenNow,
    occludedToggle: !toggleUnoccluded,
    hasVisibleCloseControl: Boolean(closeChoice),
    afterOverlayCount: overlayCount,
    afterNavLinks: navLinkCount,
    stillOpen: isOpenNow,
  };
}

export async function probeMobileMenuInPage(
  page: Page,
  onCaptureOpenMenu?: () => Promise<string | undefined>,
): Promise<MobileMenuPrecheckResult> {
  const defaultSkip: MobileMenuPrecheckResult = {
    tested: false,
    toggleFound: false,
    opened: false,
    hasVisibleCloseControl: true,
    closeWorked: true,
    occludedToggle: false,
  };
  let openedDuringProbe = false;
  try {
    const initial = await page.evaluate(inspectMobileMenuStateInPage, { phase: 'initial' as const });
    if (!initial.found) {
      return {
        tested: true,
        toggleFound: false,
        opened: false,
        hasVisibleCloseControl: true,
        closeWorked: true,
        occludedToggle: false,
      };
    }

    await page.locator('[data-kb-menu-probe-toggle="1"]').first().click({ timeout: 2500 });
    await page.waitForTimeout(350);

    const before: MobileMenuDomBeforeState = {
      beforeExpanded: initial.beforeExpanded,
      controlsId: initial.controlsId,
      beforeControlsVisible: initial.beforeControlsVisible,
      beforeOverlayCount: initial.beforeOverlayCount,
      beforeNavLinks: initial.beforeNavLinks,
    };
    const afterOpen = await page.evaluate(inspectMobileMenuStateInPage, { phase: 'afterOpen' as const, before });

    if (!afterOpen.opened) {
      return {
        tested: true,
        toggleFound: true,
        opened: false,
        hasVisibleCloseControl: true,
        closeWorked: true,
        occludedToggle: false,
      };
    }

    openedDuringProbe = true;
    if (!afterOpen.hasVisibleCloseControl) {
      const openScreenshotFile = await onCaptureOpenMenu?.();
      return {
        tested: true,
        toggleFound: true,
        opened: true,
        hasVisibleCloseControl: false,
        closeWorked: false,
        occludedToggle: afterOpen.occludedToggle,
        ...(openScreenshotFile ? { openScreenshotFile } : {}),
        detail: '展开后视口内未检测到可见且未遮挡的关闭入口',
      };
    }

    await page.locator('[data-kb-menu-probe-close="1"]').first().click({ timeout: 2500 });
    await page.waitForTimeout(300);

    const afterClose = await page.evaluate(inspectMobileMenuStateInPage, {
      phase: 'afterClose' as const,
      before,
      afterOverlayCount: afterOpen.afterOverlayCount,
      afterNavLinks: afterOpen.afterNavLinks,
    });

    if (afterClose.stillOpen) {
      const openScreenshotFile = await onCaptureOpenMenu?.();
      return {
        tested: true,
        toggleFound: true,
        opened: true,
        hasVisibleCloseControl: true,
        closeWorked: false,
        occludedToggle: afterOpen.occludedToggle,
        ...(openScreenshotFile ? { openScreenshotFile } : {}),
        detail: '点击关闭控件后菜单状态仍保持展开',
      };
    }

    openedDuringProbe = false;
    return {
      tested: true,
      toggleFound: true,
      opened: true,
      hasVisibleCloseControl: true,
      closeWorked: true,
      occludedToggle: false,
    };
  } catch {
    return defaultSkip;
  } finally {
    if (openedDuringProbe) {
      await page.keyboard?.press('Escape').catch(() => {});
    }
    await page
      .evaluate(() => {
        for (const node of Array.from(document.querySelectorAll('[data-kb-menu-probe-toggle], [data-kb-menu-probe-close]'))) {
          node.removeAttribute('data-kb-menu-probe-toggle');
          node.removeAttribute('data-kb-menu-probe-close');
        }
      })
      .catch(() => {});
  }
}

export async function runVisualPrecheck(
  page: Page,
  viewport: 'desktop' | 'mobile',
  options?: {
    templateName?: string;
    skipMobileMenuProbe?: boolean;
    onCaptureEvidence?: (tag: string) => Promise<string | undefined>;
  },
): Promise<ViewportVisualPrecheck> {
  const snapshot = await page.evaluate(collectViewportVisualPrecheckInPage, {
    viewport,
    templateName: options?.templateName,
  });
  let mobileMenu: MobileMenuPrecheckResult | undefined;
  if (
    viewport === 'mobile' &&
    !options?.skipMobileMenuProbe &&
    typeof (page as Partial<Page>).locator === 'function'
  ) {
    mobileMenu = await probeMobileMenuInPage(
      page,
      options?.onCaptureEvidence ? async () => options.onCaptureEvidence!('mobile-menu-open') : undefined,
    );
  }
  const fullSnapshot: RawViewportPrecheckSnapshot = mobileMenu ? { ...snapshot, mobileMenu } : snapshot;
  const signals = evaluateVisualPrecheckSignals(fullSnapshot);
  return { snapshot: fullSnapshot, signals };
}

export function normalizeInternalSitePath(rawPath: string, baseUrl: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:mailto|tel|javascript|data|blob):/i.test(trimmed)) {
    return null;
  }
  if (/[{}*]/.test(trimmed) || /(?:^|\/):[a-zA-Z0-9_-]+/.test(trimmed)) {
    return null;
  }
  try {
    const base = new URL(baseUrl);
    const parsed = new URL(trimmed, base);
    if (parsed.origin !== base.origin || parsed.username || parsed.password) return null;
    let pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    if (
      pathname.startsWith('/_api/') ||
      pathname.startsWith('/_admin/') ||
      /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|css|js|woff2?|ttf|mp4|mp3)$/i.test(pathname)
    ) {
      return null;
    }
    return pathname + parsed.search;
  } catch {
    return null;
  }
}

export function discoverBoundedSitePaths(input: {
  baseUrl: string;
  backendPagesRaw?: unknown;
  precheckLinks: string[];
  maxPages?: number;
}): { paths: string[]; overflowPaths: string[] } {
  const maxPages = Math.max(1, input.maxPages ?? 6);
  const discovered = new Set<string>(['/']);

  const unwrapList = (raw: unknown): unknown[] => {
    if (!raw || typeof raw !== 'object') return [];
    if (Array.isArray(raw)) return raw;
    const rec = raw as Record<string, unknown>;
    if (Array.isArray(rec.list)) return rec.list;
    if (rec.value !== undefined) return unwrapList(rec.value);
    if (rec.result !== undefined) return unwrapList(rec.result);
    return [];
  };

  for (const item of unwrapList(input.backendPagesRaw)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.online === false || rec.Online === false) continue;
    const explicitRoute = [rec.route, rec.Route, rec.url, rec.Url, rec.path, rec.Path].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const fallbackName = [rec.name, rec.Name].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const rawRoute =
      explicitRoute ||
      (fallbackName && /^index$/i.test(fallbackName.trim()) ? '/' : fallbackName);
    if (!rawRoute) continue;
    const normalized = normalizeInternalSitePath(
      rawRoute.startsWith('/') || /^https?:/i.test(rawRoute) ? rawRoute : `/${rawRoute}`,
      input.baseUrl,
    );
    if (normalized) discovered.add(normalized);
  }

  for (const link of input.precheckLinks) {
    const normalized = normalizeInternalSitePath(link, input.baseUrl);
    if (normalized) discovered.add(normalized);
  }

  const rest = [...discovered].filter(p => p !== '/').sort((a, b) => a.localeCompare(b));
  const ordered = ['/', ...rest];
  return {
    paths: ordered.slice(0, maxPages),
    overflowPaths: ordered.slice(maxPages),
  };
}

export function formatPrecheckDigest(checks: ViewportVisualPrecheck[]): string {
  if (!checks.length) return '（未采集实时 DOM 视觉预检）';
  const lines: string[] = [];
  for (const check of checks) {
    const s = check.snapshot;
    lines.push(
      `### ${s.viewport} 预检事实（${s.viewportWidth}×${s.viewportHeight}，文档高 ${s.documentHeight}px，URL=${s.url}）`,
    );
    lines.push(
      `- 首屏 Hero 真实有效 <img>：${s.heroRealImageCount} 张（总可见图 ${s.heroImageCount} 张，损坏 ${s.brokenImageCount} 张）；可见大/中 <svg> 候选：${s.svgCandidates.length} 个；横向溢出：${s.horizontalOverflow ? '是' : '否'}；Header 遮挡 H1：${s.headerCoversH1 ? '是' : '否'}`,
    );
    if (s.seoMeta) {
      lines.push(
        `- SEO 元数据：title=${s.seoMeta.title ? `「${s.seoMeta.title.slice(0, 60)}」` : '缺失'}，description=${s.seoMeta.description ? '已配置' : '缺失'}，h1=${s.seoMeta.h1Count}，canonical=${s.seoMeta.canonical || '未设置'}，robots=${s.seoMeta.robots || '默认'}`,
      );
    }
    if (s.anchorCheck && s.anchorCheck.total > 0) {
      lines.push(
        `- 页内锚点自检：共 ${s.anchorCheck.total} 个锚点链接，命中有效目标区块 ${s.anchorCheck.valid} 个${
          s.anchorCheck.broken.length ? `，缺失目标：[${s.anchorCheck.broken.join(', ')}]` : '（无失效锚点）'
        }`,
      );
    }
    if (s.mobileMenu?.tested && s.mobileMenu.opened) {
      lines.push(
        `- 移动端菜单探针：已找到并展开菜单；可见未遮挡关闭入口=${s.mobileMenu.hasVisibleCloseControl ? '是' : '否'}，关闭生效=${s.mobileMenu.closeWorked ? '是' : '否'}，原开关被遮挡=${s.mobileMenu.occludedToggle ? '是' : '否'}${s.mobileMenu.openScreenshotFile ? `（展开截图：${s.mobileMenu.openScreenshotFile}）` : ''}`,
      );
    }
    if (s.heroFoldMetrics?.hasHeroSection) {
      const fm = s.heroFoldMetrics;
      const parts: string[] = [];
      if (typeof fm.ctaBottom === 'number') parts.push(`CTA底=${fm.ctaBottom}px/${s.viewportHeight}px`);
      if (typeof fm.centerPct === 'number') parts.push(`中心=${fm.centerPct}%`);
      if (typeof fm.textBlockHeight === 'number') parts.push(`文本块高=${fm.textBlockHeight}px`);
      if (parts.length) {
        lines.push(`- 首屏安全线测量：${parts.join('，')}`);
      }
    }
    if (typeof s.minFontViolationCount === 'number' && s.minFontViolationCount > 0) {
      lines.push(`- 最小字号检查：<12px 可见文字共 ${s.minFontViolationCount} 处`);
    }
    if (check.signals.length) {
      for (const sig of check.signals) {
        lines.push(`- ⚠️ [${sig.code}${sig.ruleId ? ' / ' + sig.ruleId : ''}] ${sig.summary}`);
      }
    } else {
      lines.push('- ✅ 未触发程序红线风险信号');
    }
  }
  return lines.join('\n');
}
