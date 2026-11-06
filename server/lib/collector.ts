import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { Evidence, Issue, RuleSet, Screenshot } from '../../shared/types.js';
import type { Artifacts } from './artifacts.js';
import { captureErrorMessage } from './capture-error.js';
import { LostLease } from './store.js';

export const collectorVersion = 'playwright-sop-v4-visual-issues';
export type CaptureReview = {
  usable: boolean;
  reason: string;
  retry?: { waitMs: number; scrollWaitMs: number } | null;
};
export interface CollectionInput {
  targetUrl: string;
  readme: string | null;
  warnings: string[];
  referenceUrl?: string;
  scope: 'homepage' | 'site';
  rule: RuleSet;
  evaluationId: string;
  runId: string;
  deadline: number;
  roles?: ('target' | 'reference')[];
  signal: AbortSignal;
  artifacts: Artifacts;
  directory: string;
  maxAttempts?: number;
  continuous?: boolean;
  waitStrategy?: {waitMs: number; scrollWaitMs: number};
  attemptTag?: string;
  onProgress?: (message: string, evidence: Evidence) => void;
  onCheckpoint?: () => void;
  review?: (evidence: Evidence) => Promise<CaptureReview>;
}
export type BrowserFactory = (timeout: number) => Promise<Browser>;
interface Metadata {
  title: string;
  text: string;
  height: number;
  width: number;
  images: number;
  unloaded: number;
  broken: number;
}
const metadataScript = `({ title: document.title, text: (document.body?.innerText || '').slice(0,40000), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), width: document.documentElement.scrollWidth, images: document.images.length, unloaded: [...document.images].filter(i => !i.complete).length, broken: [...document.images].filter(i => i.complete && !i.naturalWidth).length })`;
const fontsAndImagesScript = `Promise.race([Promise.allSettled([document.fonts?.ready, ...[...document.images].filter(i => !i.complete).map(i => new Promise(resolve => { i.addEventListener('load', resolve, {once:true}); i.addEventListener('error', resolve, {once:true}); }))]),new Promise(resolve => setTimeout(resolve, 3000))])`;
const scrollScript = (y: number) => window.scrollTo({left:0,top:y,behavior:'instant'});

function checkpoint(input: CollectionInput) {
  input.signal.throwIfAborted();
  input.onCheckpoint?.();
  if (Date.now() >= input.deadline) throw new Error('评测超过本轮采集预算');
}
function timeout(input: CollectionInput) {
  return Math.max(1, Math.min(input.rule.capture.timeoutMs, input.deadline - Date.now()));
}
async function bounded<T>(input: CollectionInput, operation: () => Promise<T>): Promise<T> {
  checkpoint(input);
  const value = await operation();
  checkpoint(input);
  return value;
}
function readMetadata(page: Page) {
  return page.evaluate(metadataScript).then((value: unknown): Metadata => {
    if (!value || typeof value !== 'object') throw new Error('页面信息返回值不完整');
    const data = value as Metadata;
    if (typeof data.title !== 'string' || typeof data.text !== 'string' || !Number.isFinite(data.height) || data.height < 1 || !Number.isFinite(data.width)) throw new Error('页面信息返回值不完整');
    return data;
  });
}

/** Pixel regions are real page coordinates, deduplicated for short pages. */
export function screenshotRegions(height: number, viewportHeight: number, maxHeight: number, regions: number) {
  const coveredHeight = Math.min(height, maxHeight);
  const shotHeight = Math.min(viewportHeight, coveredHeight);
  const bottom = Math.max(0, coveredHeight - shotHeight);
  const seen = new Set<number>();
  return [{ region: 'top', y: 0 }, { region: 'middle', y: Math.round(bottom / 2) }, { region: 'bottom', y: bottom }]
    .slice(0, regions).filter(item => !seen.has(item.y) && !!seen.add(item.y))
    .map(item => ({ ...item, height: shotHeight }));
}

export function continuousRegions(height: number, viewportHeight: number, maxHeight: number) {
  const covered = Math.min(height, maxHeight), shotHeight = Math.min(viewportHeight, covered);
  const bottom = Math.max(0, covered - shotHeight), positions: number[] = [];
  for (let y = 0; y < bottom; y += Math.max(1, Math.floor(viewportHeight * .9))) positions.push(y);
  if (positions.at(-1) !== bottom) positions.push(bottom);
  return positions.map((y, index) => ({region:`tile-${String(index+1).padStart(3,'0')}`,y,height:shotHeight}));
}

/** A single browser page owns navigation, scrolling, metadata and pixels for one capture. */
export async function captureViewport(
  input: CollectionInput,
  page: Page,
  role: 'target' | 'reference',
  viewport: RuleSet['viewports'][number],
  strategy: { waitMs: number; scrollWaitMs: number },
  progress: (message: string) => void,
  onPartial?: (evidence: Evidence) => void
): Promise<Evidence> {
  const url = role === 'target' ? input.targetUrl : input.referenceUrl!;
  const issues: Issue[] = [], screenshots: Screenshot[] = [];
  const issue = (dimension: string, title: string, detail: string, severity: Issue['severity'] = 'major') => issues.push({
    severity, dimension, title, detail, evidence: [`${role}-${viewport.id}-top`],
    capture: { role, viewport: viewport.id, stage: '采集检查' },
  });
  progress('导航并等待页面正文');
  const response = await bounded(input, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout(input) }));
  if (response && response.status() >= 400) issue(role, '页面返回错误状态', `HTTP ${response.status()}`);
  await bounded(input, () => page.waitForTimeout(strategy.waitMs));
  await bounded(input, () => page.evaluate(fontsAndImagesScript));
  const first = await bounded(input, () => readMetadata(page));
  const scrollLimit = Math.min(first.height, input.rule.capture.maxHeight);
  progress('逐段滚动加载页面内容');
  const step = Math.max(200, Math.round(viewport.height * .75));
  let reached = 0;
  // Both passes are bounded by the run deadline and the configured height limit.
  if (input.continuous) {
    for (let y = 0, count = 0; count < 100; count++, y += step) {
      const current = await bounded(input, () => readMetadata(page));
      const bottom = Math.max(0, Math.min(current.height, input.rule.capture.maxHeight) - viewport.height);
      const position = Math.min(y, bottom);
      await bounded(input, () => page.evaluate(scrollScript, position));
      await bounded(input, () => page.waitForTimeout(strategy.scrollWaitMs));
      reached = position;
      if (position >= bottom) {
        await bounded(input, () => page.evaluate(fontsAndImagesScript));
        const updated = await bounded(input, () => readMetadata(page));
        if (Math.min(updated.height, input.rule.capture.maxHeight) <= position + viewport.height) break;
      }
    }
  } else {
  for (let y = 0; y < scrollLimit && y / step < 90; y += step) {
    await bounded(input, () => page.evaluate(scrollScript, y));
    await bounded(input, () => page.waitForTimeout(strategy.scrollWaitMs));
    reached = y;
  }
  await bounded(input, () => page.evaluate(scrollScript, Math.max(0, scrollLimit - viewport.height)));
  await bounded(input, () => page.waitForTimeout(strategy.scrollWaitMs));
  await bounded(input, () => page.evaluate(fontsAndImagesScript));
  }
  const before = await bounded(input, () => readMetadata(page));
  if (before.height > input.rule.capture.maxHeight) issue('coverage', '页面超出采集高度预算', `页面高度 ${before.height}px，本轮仅检查前 ${input.rule.capture.maxHeight}px`);
  if (!input.continuous && before.height > first.height + viewport.height) issue('coverage', '滚动后页面继续增长', '已采集当前页面范围，但不能确认无限滚动或后续追加内容');
  if (reached + viewport.height < (input.continuous ? Math.min(before.height, input.rule.capture.maxHeight) : scrollLimit)) issue('coverage', '未完整滚动采集范围', '本轮滚动次数达到上限');
  if (role === 'target' && before.width > viewport.width + 4) issue('health', '页面横向溢出', `页面宽度 ${before.width}px，视口 ${viewport.width}px`);
  if (role === 'target' && before.text.trim().length < 20 && !before.images) issue('health', '页面可能为空白', '缺少可见正文和图片', 'critical');
  const partial = (): Evidence => ({
    targetUrl: input.targetUrl, targetTitle: role === 'target' ? before.title : '',
    text: role === 'target' ? before.text : '', readme: input.readme, screenshots, issues,
    fingerprint: role === 'target' ? createHash('sha256').update(before.text).digest('hex') : '', stable: false,
    health: role !== 'target' ? 'unknown' : issues.some(i => i.dimension === 'health' && i.severity === 'critical') ? 'critical' : issues.some(i => i.dimension === 'health') ? 'warning' : 'ok',
    coverage: { requested: input.scope, actual: 'homepage', complete: false, captureComplete: false, note: '页面截图尚在采集中，最终稳定性与视觉检查未完成。' },
  });
  onPartial?.(partial());
  progress('保存实际页面区域截图');
  for (const region of (input.continuous ? continuousRegions(before.height, viewport.height, input.rule.capture.maxHeight) : screenshotRegions(before.height, viewport.height, input.rule.capture.maxHeight, input.rule.capture.regions))) {
    await bounded(input, () => page.evaluate(scrollScript, region.y));
    await bounded(input, () => page.waitForTimeout(strategy.scrollWaitMs));
    const pageY: unknown = await bounded(input, () => page.evaluate('window.scrollY'));
    if (typeof pageY !== 'number' || !Number.isFinite(pageY) || pageY < 0) throw new Error('无法确认截图在页面中的实际位置');
    if (Math.abs(pageY - region.y) > 1) issue('coverage', '页面滚动位置发生变化', `${region.region} 计划位置 ${region.y}px，实际位置 ${Math.round(pageY)}px，请复核截图覆盖范围`);
    // With fullPage:false Playwright clips within the viewport, after scrolling.
    // Document offsets belong to scrollTo/pageY, never to this clip rectangle.
    const pixels = await bounded(input, () => page.screenshot({ type: 'png', fullPage: false, clip: { x: 0, y: 0, width: viewport.width, height: region.height }, timeout: timeout(input) }));
    if (pixels.length > 18 * 1024 * 1024) throw new Error('单张截图超过 18 MB 上限');
    const id = `${role}-${viewport.id}-${input.attemptTag ? input.attemptTag + "-" : ""}${region.region}`, file = `${id}.png`;
    input.artifacts.save(input.evaluationId, input.runId, file, pixels.toString('base64'));
    screenshots.push({ id, role, viewport: viewport.id, region: region.region, file, url,
      sha256: createHash('sha256').update(pixels).digest('hex'), capturedAt: Date.now(), width: viewport.width, height: region.height, pageY, captureMethod: 'playwright' });
    onPartial?.(partial());
  }
  const after = await bounded(input, () => readMetadata(page));
  // Document-wide counts include hidden/lazy images and cannot prove a visible defect.
  // Preserve them separately from issues, health and screenshot evidence associations.
  input.artifacts.save(input.evaluationId, input.runId,
    `${role}-${viewport.id}-${input.attemptTag ? input.attemptTag + '-' : ''}image-load-diagnostics.json`,
    JSON.stringify({ role, viewport: viewport.id, capturedAt: Date.now(), images: after.images,
      unloaded: after.unloaded || 0, broken: after.broken || 0,
      note: '全页图片元素状态统计，包含隐藏和屏幕外图片；不代表截图中存在可见缺图。' }));
  const stable = before.text === after.text && before.height === after.height;
  if (input.continuous && after.height > before.height + 1) issue('coverage', '截图期间页面继续增长', `截图覆盖 ${before.height}px，最终页面 ${after.height}px，需要补采`);
  if (!stable) issue('stability', '页面内容在采集中变化', '同一页面的正文或高度发生变化，请复核采集证据');
  for (const item of issues) item.evidence = screenshots.slice(0, 1).map(shot => shot.id);
  return {
    targetUrl: input.targetUrl, targetTitle: role === 'target' ? before.title : '',
    text: role === 'target' ? before.text : '', readme: input.readme, screenshots, issues,
    fingerprint: role === 'target' ? createHash('sha256').update(before.text).digest('hex') : '', stable,
    health: role !== 'target' ? 'unknown' : issues.some(i => i.dimension === 'health' && i.severity === 'critical') ? 'critical' : issues.some(i => i.dimension === 'health') ? 'warning' : 'ok',
    coverage: { requested: input.scope, actual: 'homepage',
      complete: input.scope === 'homepage' && !issues.some(i => ['coverage', 'target', 'reference'].includes(i.dimension)),
      captureComplete: screenshots.length > 0 && !issues.some(i => ['coverage', 'target', 'reference'].includes(i.dimension)),
      note: 'Playwright 同一页面导航、有限逐段滚动、等待资源并采集首页实际区域。静态截图不代表业务交互、动效或无限滚动内容已验收。' },
  };
}

export function createCollector(factory: BrowserFactory = timeout => chromium.launch({ headless: true, timeout })) {
  return async function collect(input: CollectionInput): Promise<Evidence> {
    checkpoint(input);
    const fragments: Evidence[] = [];
    let pending: Evidence | null = null;
    let browser: Browser | undefined;
    let aborted = false;
    const snapshot = (): Evidence => {
      const visible = pending ? [...fragments, pending] : fragments;
      const target = visible.find(fragment => fragment.targetTitle || fragment.text);
      const issues = visible.flatMap(fragment => fragment.issues);
      for (const warning of input.warnings) issues.push({ severity: 'major', dimension: 'materials', title: '资料读取不完整', detail: warning, evidence: ['materials-unavailable'] });
      const requestedRoles = (input.roles || ['target', 'reference']).filter(role => role === 'target' ? !!input.targetUrl : !!input.referenceUrl);
      const targetRequested = requestedRoles.includes('target');
      const validTarget = !targetRequested || input.rule.viewports.every(viewport => visible.some(fragment => fragment.screenshots.some(shot => shot.role === 'target' && shot.viewport === viewport.id) && !fragment.issues.some(issue => issue.dimension === 'target')));
      return { targetUrl: input.targetUrl, targetTitle: target?.targetTitle || '', text: target?.text || '', readme: input.readme,
        screenshots: visible.flatMap(fragment => fragment.screenshots), issues, fingerprint: target?.fingerprint || '',
        health: !targetRequested || !validTarget ? 'unknown' : issues.some(i => i.dimension === 'health' && i.severity === 'critical') ? 'critical' : issues.some(i => i.dimension === 'health') ? 'warning' : 'ok',
        stable: visible.length > 0 && visible.every(fragment => fragment.stable),
        coverage: { requested: input.scope, actual: 'homepage',
          complete: input.scope === 'homepage' && visible.length === requestedRoles.length * input.rule.viewports.length && visible.every(fragment => fragment.coverage.captureComplete ?? fragment.coverage.complete),
          captureComplete: visible.length === requestedRoles.length * input.rule.viewports.length && visible.every(fragment => fragment.coverage.captureComplete ?? fragment.coverage.complete),
          note: 'Playwright 同一页面导航、有限逐段滚动、等待资源并采集首页实际区域。静态截图不代表业务交互、动效或无限滚动内容已验收。' } };
    };
    const closeOnAbort = () => { aborted = true; void browser?.close().catch(() => {}); };
    input.signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      browser = await factory(timeout(input));
      if (input.signal.aborted) { await browser.close(); input.signal.throwIfAborted(); }
      for (const role of input.roles || ['target', 'reference'] as const) {
        const url = role === 'target' ? input.targetUrl : input.referenceUrl;
        if (!url) continue;
        for (const viewport of input.rule.viewports) {
          checkpoint(input);
          const label = `${role === 'target' ? '生成站' : '参考站'} · ${viewport.id === 'desktop' ? '桌面' : '移动'}`;
          const progress = (message: string) => { checkpoint(input); input.onProgress?.(`${label}：${message}`, snapshot()); };
          let fragment: Evidence | null = null, error: string | null = null;
          pending = null;
          let strategy = input.waitStrategy || (input.continuous ? { waitMs: 2500, scrollWaitMs: 650 } : { waitMs: 1500, scrollWaitMs: 250 });
          const maxAttempts = Math.max(1, Math.min(3, Math.floor(input.maxAttempts || 2)));
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            checkpoint(input);
            const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, isMobile: viewport.id === 'mobile' });
            try {
              const page = await context.newPage();
              page.setDefaultTimeout(timeout(input));
              progress(`第 ${attempt} 次采集`);
              fragment = await captureViewport(input, page, role, viewport, strategy, progress, partial => {
                fragment = partial; pending = partial;
                input.onProgress?.(`${label}：采集证据检查点`, snapshot());
              });
              pending = fragment;
              if (input.review && !fragment.issues.some(issue => issue.dimension === role)) {
                progress('检查截图是否可用于评分');
                const review = await input.review(fragment);
                checkpoint(input);
                if (!review.usable) {
                  error = review.reason || '视觉检查未通过';
                  if (review.retry && attempt < maxAttempts) {
                    strategy = { waitMs: Math.max(0, Math.min(15000, Math.floor(review.retry.waitMs))), scrollWaitMs: Math.max(100, Math.min(2000, Math.floor(review.retry.scrollWaitMs))) };
                    if (!Number.isFinite(strategy.waitMs) || !Number.isFinite(strategy.scrollWaitMs)) throw new Error('补采策略不是有效数值');
                    progress(`视觉检查要求补采：${error}`);
                    continue;
                  }
                  fragment.issues.push({ severity: 'major', dimension: role, title: '截图未通过视觉检查', detail: error, evidence: fragment.screenshots.map(shot => shot.id), capture: { role, viewport: viewport.id, stage: '视觉检查' } });
                  fragment.coverage.complete = false;
                  fragment.coverage.captureComplete = false;
                } else error = null;
              }
              break;
            } catch (failure) {
              if (failure instanceof LostLease || input.signal.aborted || aborted) throw failure;
              checkpoint(input);
              error = captureErrorMessage(failure);
              if (fragment) {
                fragment.issues.push({ severity: 'major', dimension: role, title: '采集或视觉检查未完成', detail: error, evidence: fragment.screenshots.map(shot => shot.id), capture: { role, viewport: viewport.id, stage: '采集' } });
                fragment.coverage.complete = false;
                fragment.coverage.captureComplete = false;
              }
              progress(error);
              break;
            } finally { await context.close().catch(() => {}); }
          }
          if (!fragment) fragment = { targetUrl: input.targetUrl, targetTitle: '', text: '', readme: input.readme, screenshots: [], health: 'unknown', fingerprint: '', stable: false,
            issues: [{ severity: 'major', dimension: role, title: '页面采集失败', detail: error || '未取得截图', evidence: [`${role}-${viewport.id}-top`], capture: { role, viewport: viewport.id, stage: '采集' } }],
            coverage: { requested: input.scope, actual: 'homepage', complete: false, captureComplete: false, note: '采集未完成，不能作为完整评分证据。' } };
          pending = null;
          fragments.push(fragment);
          progress(fragment.issues.some(issue => issue.dimension === role) ? '诊断证据已保留，采集未通过' : '页面证据已保存');
        }
      }
      return snapshot();
    } finally {
      input.signal.removeEventListener('abort', closeOnAbort);
      await browser?.close().catch(() => {});
    }
  };
}
export const collectEvidence = createCollector();
