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
}

export type VisualPrecheckSignalCode =
  | 'HERO_SVG_PLACEHOLDER'
  | 'CARD_SVG_PLACEHOLDER'
  | 'BROKEN_IMAGE'
  | 'HORIZONTAL_OVERFLOW'
  | 'HEADER_COVERS_H1'
  | 'HEADING_ORPHAN_WRAP'
  | 'TEMPLATE_RESIDUAL'
  | 'MOBILE_MENU_TRAPPED';

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
  const needles = ['lorem ipsum', 'edit me', 'your text here', 'company name here'];
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
