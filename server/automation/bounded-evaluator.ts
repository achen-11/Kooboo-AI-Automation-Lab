import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import { decodeXML } from 'entities';
import { z } from 'zod';
import type {
  Assessment,
  AutomationReport,
  AutomationTask,
  Criterion,
  GeneratedSite,
  MaterialFile,
  ResourceInput,
} from '../../shared/automation.js';
import type { RequirementManifest } from '../../shared/completeness.js';
import {
  deriveEvaluationHumanSummary,
  type EvaluationHumanSummary,
  type EvaluationVerdict,
} from '../../shared/human-diagnostics.js';
import { materialPath } from '../../shared/materials.js';
import {
  applyBoundedVerdictCaps,
  areCrossViewportMinorDuplicates,
  buildBoundedCheckerPrompt,
  deduplicateBatchTexts,
  defaultOutOfScope,
  DEFAULT_ANTI_PATTERN_RULES,
  filterContradictoryHighlights,
  filterCrossBatchOutOfScopeLeaks,
  filterCrossSliceCoverageLeaks,
  pickStrictestHeadline,
  type AntiPatternRule,
  type BoundedIssue,
} from './bounded-checker-rules.js';
import { hashChecksSnapshot, renderChecksMarkdown, toAntiPatternRules } from './checker-checks.js';
import type { evaluationBrowser } from './browser.js';
import type { codexClient } from './codex-client.js';
import {
  screenshotRangeCovered,
  type PageScreenshotsReceipt,
  type ScreenshotPosition,
  type ScreenshotReceipt,
} from './page-screenshots.js';
import type { AutomationStore } from './store.js';
import type { usageCapture } from './usage-proxy.js';
import { formatPrecheckDigest, type ViewportVisualPrecheck } from './visual-precheck.js';

const MAX_SCREENSHOTS_PER_VIEWPORT = 12;
const MAX_SCREENSHOTS_PER_CALL = 16;
const MAX_HOMEPAGE_TOTAL_SCREENSHOTS = 40;
const MAX_HOMEPAGE_BATCH_IMAGES = 12;
const SINGLE_TURN_IMAGE_LIMIT = 10;
const MAX_MATERIAL_NOTE_BYTES = 8000;
const MAX_DOCX_XML_BYTES = 256 * 1024;
export const MAX_REFERENCE_IMAGES_PER_VIEWPORT = 5;

export interface BatchImage {
  name: string;
  absPath: string;
  role: 'target' | 'reference';
  viewport: 'desktop' | 'mobile';
  sha256: string;
  width: number | null;
  height: number | null;
  scrollY: number | null;
  action: string;
  probe?: string;
  url?: string;
}

export function createBoundedTurnIssueSchema(allowedRuleIds: readonly string[]) {
  const uniqueIds = [...new Set(allowedRuleIds.map(id => id.trim()).filter(Boolean))];
  const ruleIdSchema =
    uniqueIds.length > 0
      ? z.enum(uniqueIds as [string, ...string[]]).nullable()
      : z.null();
  return z
    .object({
      severity: z.enum(['critical', 'major', 'minor']),
      ruleId: ruleIdSchema,
      viewport: z.enum(['desktop', 'mobile', 'both']),
      criterionId: z.string().min(1).nullable(),
      title: z.string().min(1).max(200),
      detail: z.string().min(1).max(2000),
      evidence: z.array(z.string().min(1)).min(1).max(20),
    })
    .strict();
}

export function createBoundedTurnOutputSchema(allowedRuleIds: readonly string[]) {
  return z
    .object({
      summary: z.string().min(1).max(4000),
      assessments: z
        .array(
          z
            .object({
              criterionId: z.string().min(1),
              viewport: z.enum(['desktop', 'mobile']),
              score: z.number().min(0).max(100).nullable(),
              reason: z.string().min(1).max(1500),
              evidence: z.array(z.string().min(1)).max(20),
              passed: z.boolean().nullable(),
            })
            .strict(),
        )
        .max(30),
      issues: z.array(createBoundedTurnIssueSchema(allowedRuleIds)).max(60),
      coverage: z
        .object({
          verified: z.array(z.string()),
          unverified: z.array(z.string()),
          outOfScope: z.array(z.string()),
        })
        .strict(),
      humanSummary: z
        .object({
          verdict: z.enum(['ready', 'needs-fixes', 'blocked', 'incomplete-check']),
          headline: z.string().min(1).max(300),
          highlights: z.array(z.string().min(1).max(300)).max(6),
          topFixes: z.array(z.string().min(1).max(400)).max(6),
          unverifiedNote: z.string().max(500).nullable(),
        })
        .strict(),
    })
    .strict();
}

export const boundedTurnIssueSchema = createBoundedTurnIssueSchema(
  DEFAULT_ANTI_PATTERN_RULES.map(r => r.id),
);

export const boundedTurnOutputSchema = createBoundedTurnOutputSchema(
  DEFAULT_ANTI_PATTERN_RULES.map(r => r.id),
);

export type BoundedTurnOutput = z.infer<typeof boundedTurnOutputSchema>;

export function canUseBoundedHomepageEvaluation(input: {
  task: AutomationTask;
  manifest?: RequirementManifest;
  program?: unknown;
}): boolean {
  const { task, manifest, program } = input;
  if (task.scope !== 'homepage') return false;
  if (!['materials', 'upgrade', 'migration'].includes(task.scenario)) return false;
  if (task.templateWorkflow || task.requirementsEnabled || manifest || program) return false;
  if (!task.rule) return false;
  const criteria = task.rule.criteria.filter(c => c.scopes.includes('homepage'));
  if (!criteria.length) return false;
  return criteria.every(c => c.viewports.every(v => v === 'desktop' || v === 'mobile'));
}

/** Extract plain paragraph text from a ZIP-based .docx buffer without external dependencies. */
export function extractDocxPlainText(buf: Buffer, maxChars = 4000): string {
  try {
    if (buf.length < 22) return '';
    let eocdOffset = -1;
    const minEocd = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= minEocd; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50 && buf.readUInt16LE(i + 20) === buf.length - (i + 22)) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return '';

    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdEnd = cdOffset + cdSize;
    if (cdOffset < 0 || cdEnd > buf.length) return '';

    let pos = cdOffset;
    while (pos + 46 <= cdEnd) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break;
      const method = buf.readUInt16LE(pos + 10);
      const compSize = buf.readUInt32LE(pos + 20);
      const uncompSize = buf.readUInt32LE(pos + 24);
      const nameLen = buf.readUInt16LE(pos + 28);
      const extraLen = buf.readUInt16LE(pos + 30);
      const commentLen = buf.readUInt16LE(pos + 32);
      const localOffset = buf.readUInt32LE(pos + 42);
      const nextPos = pos + 46 + nameLen + extraLen + commentLen;
      if (pos + 46 + nameLen > cdEnd) break;

      const entryName = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      pos = nextPos;
      if (entryName !== 'word/document.xml') continue;

      if (compSize > MAX_DOCX_XML_BYTES || uncompSize > MAX_DOCX_XML_BYTES) return '';
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return '';
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) return '';

      const slice = buf.subarray(dataStart, dataEnd);
      const xmlBuf =
        method === 0
          ? slice.subarray(0, MAX_DOCX_XML_BYTES)
          : method === 8
            ? inflateRawSync(slice, { maxOutputLength: MAX_DOCX_XML_BYTES })
            : undefined;
      if (!xmlBuf) return '';

      const withBreaks = xmlBuf
        .toString('utf8')
        .replace(/<\/w:p\s*>/gi, '\n')
        .replace(/<w:br\b[^>]*\/?>/gi, '\n')
        .replace(/<w:tab\b[^>]*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '');
      return decodeXML(withBreaks)
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, maxChars);
    }
    return '';
  } catch {
    return '';
  }
}

export function extractBoundedMaterialNotes(work: string, files: MaterialFile[]): string {
  if (!files.length) return '';
  const textLines: string[] = [];
  const otherNames: string[] = [];
  let remainingBytes = MAX_MATERIAL_NOTE_BYTES;
  let textCount = 0;

  for (const file of files) {
    let logical: string;
    try {
      logical = materialPath(file.name);
    } catch {
      continue;
    }
    const isPlainText = !file.type.startsWith('image/') && /\.(md|txt|json|csv|ya?ml)$/i.test(logical);
    const isDocx = !file.type.startsWith('image/') && /\.docx$/i.test(logical);
    if ((isPlainText || isDocx) && textCount < 5 && remainingBytes > 200) {
      const fullPath = resolve(work, 'materials', logical);
      if (existsSync(fullPath)) {
        try {
          const content = isDocx
            ? extractDocxPlainText(readFileSync(fullPath), 4000).trim()
            : readFileSync(fullPath, 'utf8').trim();
          if (content) {
            const slice = content.slice(0, Math.min(isDocx ? 4000 : 2000, remainingBytes));
            remainingBytes -= slice.length;
            textCount++;
            textLines.push(`--- ${logical} ---\n${slice}${content.length > slice.length ? '\n...(已截断)' : ''}`);
            continue;
          }
        } catch {
          // Fall through to listing filename
        }
      }
    }
    otherNames.push(`${logical} (${file.type || 'file'})`);
  }

  const parts: string[] = [];
  if (textLines.length) parts.push(textLines.join('\n\n'));
  if (otherNames.length) parts.push(`其余附件清单（共 ${otherNames.length} 项）：${otherNames.slice(0, 40).join('、')}`);
  return parts.join('\n\n');
}

function readPngSize(filePath: string): { width: number; height: number } | null {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(24);
      if (readSync(fd, header, 0, 24, 0) < 24) return null;
      if (
        header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        header.subarray(12, 16).toString('ascii') !== 'IHDR'
      ) {
        return null;
      }
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function urlMatchesTargetPath(observedUrl: string | undefined, targetUrl?: string): boolean {
  if (!targetUrl) return true;
  if (!observedUrl) return false;
  try {
    const obs = new URL(observedUrl);
    const tgt = new URL(targetUrl);
    if (obs.origin !== tgt.origin) return false;
    const norm = (pathname: string) => (pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname || '/');
    return norm(obs.pathname) + obs.search === norm(tgt.pathname) + tgt.search;
  } catch {
    return false;
  }
}

function isReferenceCaptureUnusable(
  file: MaterialFile,
  obs?: {
    settlement?: { settled?: boolean };
    readiness?: { settled?: boolean; pendingImages?: number; brokenImages?: number; fontsReady?: boolean };
  },
): boolean {
  const settledFalse = file.settled === false || obs?.settlement?.settled === false;
  if (!settledFalse) return false;
  const r = obs?.readiness;
  if (!r) return true;
  return (r.pendingImages ?? 0) > 0 || (r.brokenImages ?? 0) > 0 || r.fontsReady === false;
}

/** Keep first frame + last frame + evenly spaced interior frames when sampling long reference pages. */
export function sampleReferenceImages(images: readonly BatchImage[], maxCount: number): BatchImage[] {
  if (images.length <= maxCount || maxCount <= 0) return [...images];
  if (maxCount === 1) return [images[0]];
  const last = images.length - 1;
  const indices = new Set<number>([0, last]);
  for (let slot = 1; slot < maxCount - 1; slot++) {
    const idx = Math.round((slot * last) / (maxCount - 1));
    indices.add(Math.max(0, Math.min(last, idx)));
  }
  for (let i = 1; indices.size < maxCount && i < last; i++) {
    indices.add(i);
  }
  return [...indices].sort((a, b) => a - b).map(i => images[i]);
}

export function hasCompleteRetainedCapture(
  artifacts: MaterialFile[],
  work: string,
  role: 'target' | 'reference',
  viewport: 'desktop' | 'mobile',
  targetUrl?: string,
): boolean {
  const positions: ScreenshotPosition[] = [];
  for (const file of artifacts) {
    if (file.type !== 'image/png' || file.role !== role || file.viewport !== viewport) continue;
    const obsPath = resolve(work, 'evidence', file.name.replace(/\.png$/, '.json'));
    if (!existsSync(obsPath)) continue;
    try {
      const obs = JSON.parse(readFileSync(obsPath, 'utf8')) as {
        action?: string;
        url?: string;
        position?: ScreenshotPosition;
        settlement?: { settled?: boolean };
        readiness?: { settled?: boolean; pendingImages?: number; brokenImages?: number; fontsReady?: boolean };
      };
      if (!urlMatchesTargetPath(obs.url, targetUrl)) continue;
      if (role === 'reference' && isReferenceCaptureUnusable(file, obs)) continue;
      if (obs.action === 'take_page_screenshots' && obs.position) {
        positions.push(obs.position);
      }
    } catch {
      // ignore invalid observation
    }
  }
  if (!positions.length) return false;
  positions.sort((a, b) => a.scrollY - b.scrollY);
  return screenshotRangeCovered(positions);
}

export function collectBatchImages(
  artifacts: MaterialFile[],
  work: string,
  role: 'target' | 'reference',
  viewport: 'desktop' | 'mobile',
  targetUrl?: string,
  maxBaseImages = MAX_SCREENSHOTS_PER_VIEWPORT,
): BatchImage[] {
  const seenHashes = new Set<string>();
  const items: (BatchImage & { capturedAt: number; priority: number })[] = [];

  for (const file of artifacts) {
    if (file.type !== 'image/png' || file.role !== role || file.viewport !== viewport) continue;
    if (seenHashes.has(file.sha256)) continue;
    const absPath = resolve(work, 'evidence', file.name);
    if (!existsSync(absPath)) continue;

    let action = 'unknown';
    let scrollY: number | null = null;
    let capturedAt = 0;
    let probe: string | undefined;
    let url: string | undefined;
    let obs:
      | {
          action?: string;
          url?: string;
          capturedAt?: number;
          probe?: string;
          position?: { scrollY?: number };
          settlement?: { settled?: boolean };
          readiness?: { settled?: boolean; pendingImages?: number; brokenImages?: number; fontsReady?: boolean };
        }
      | undefined;
    const obsPath = resolve(work, 'evidence', file.name.replace(/\.png$/, '.json'));
    if (existsSync(obsPath)) {
      try {
        obs = JSON.parse(readFileSync(obsPath, 'utf8'));
        if (typeof obs?.url === 'string' && obs.url.trim()) url = obs.url.trim();
        action = obs?.action || action;
        if (typeof obs?.position?.scrollY === 'number') scrollY = obs.position.scrollY;
        if (typeof obs?.capturedAt === 'number') capturedAt = obs.capturedAt;
        if (typeof obs?.probe === 'string' && obs.probe.trim()) probe = obs.probe.trim();
      } catch {
        // ignore parse failure
      }
    }
    if (role === 'reference' && isReferenceCaptureUnusable(file, obs)) continue;
    if (!urlMatchesTargetPath(url, targetUrl)) continue;
    seenHashes.add(file.sha256);

    const dims = readPngSize(absPath);
    const priority = action === 'take_page_screenshots' ? 0 : action === 'snapshot' || action === 'screenshot' ? 1 : 2;
    items.push({
      name: file.name,
      absPath,
      role,
      viewport,
      sha256: file.sha256,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      scrollY,
      action,
      ...(probe ? { probe } : {}),
      ...(url ? { url } : {}),
      capturedAt,
      priority,
    });
  }

  const paged = items.filter(i => i.action === 'take_page_screenshots');
  const probes = items.filter(i => i.action === 'visual_precheck');
  const pool = paged.length ? paged : items.filter(i => i.action !== 'visual_precheck');
  pool.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.scrollY !== null && b.scrollY !== null && a.scrollY !== b.scrollY) return a.scrollY - b.scrollY;
    return a.capturedAt - b.capturedAt || a.name.localeCompare(b.name);
  });
  probes.sort((a, b) => a.capturedAt - b.capturedAt || a.name.localeCompare(b.name));

  const selectedBase = pool.slice(0, maxBaseImages);
  const selected = [...selectedBase, ...probes.filter(p => !selectedBase.some(b => b.sha256 === p.sha256))];
  return selected.map(({ capturedAt: _c, priority: _p, ...clean }) => clean);
}

function analyzeScreenshotGaps(
  receipt: PageScreenshotsReceipt,
  label: string,
  shotOffset = 0,
  deferRangeCheck = false,
): { blockingGaps: string[]; notes: string[] } {
  if (!receipt.screenshots?.length) {
    return {
      blockingGaps: [
        shotOffset > 0
          ? `${label}续采逐屏截图中断（${receipt.gaps.join('；') || '未返回有效截图'}）`
          : `${label}逐屏截图失败（${receipt.gaps.join('；') || '未返回有效截图'}）`,
      ],
      notes: [],
    };
  }
  if (!deferRangeCheck && receipt.coverageComplete && !receipt.gaps.length && receipt.nextStartY === null) {
    return { blockingGaps: [], notes: [] };
  }

  const blockingGaps: string[] = [];
  const notes: string[] = [];

  if (!deferRangeCheck) {
    if (receipt.nextStartY !== null) {
      blockingGaps.push(`${label}逐屏截图超出单轮上限，剩余纵向区间（nextStartY=${receipt.nextStartY}）未覆盖`);
    }
    if (!screenshotRangeCovered(receipt.screenshots.map(s => s.position))) {
      blockingGaps.push(`${label}逐屏截图纵向区间未完整覆盖页面高度`);
    }
  }

  for (const gap of receipt.gaps || []) {
    if (gap === 'Horizontal overflow was not captured.') {
      notes.push(`${label}存在横向溢出信号（已交由视觉预检与截图判定 R-LAYOUT-03，不重复记为未验证）`);
      continue;
    }
    const settleMatch = /^Screenshot (\d+) did not settle:\s*(.*)$/i.exec(gap);
    if (settleMatch) {
      const localIdx = Number(settleMatch[1]) - 1;
      const globalScreenNum = shotOffset + localIdx + 1;
      const readiness = receipt.screenshots[localIdx]?.readiness;
      if (readiness && readiness.pendingImages === 0 && readiness.brokenImages === 0 && readiness.fontsReady) {
        notes.push(
          `${label}第 ${globalScreenNum} 屏受有限动画影响未完全静止，但图片与字体已就绪（${settleMatch[2]}）`,
        );
      } else {
        blockingGaps.push(`${label}第 ${globalScreenNum} 屏未完成资源加载（${settleMatch[2]}）`);
      }
      continue;
    }
    if (/^Actual viewport intervals did not cover/i.test(gap)) {
      if (!deferRangeCheck) {
        blockingGaps.push(`${label}逐屏截图实际视口范围未完整覆盖页面高度`);
      }
      continue;
    }
    blockingGaps.push(`${label}逐屏截图存在未覆盖缺口：${gap}`);
  }

  return {
    blockingGaps: [...new Set(blockingGaps)],
    notes: [...new Set(notes)],
  };
}

export function extractBlockingCaptureGaps(
  receipt: PageScreenshotsReceipt,
  label: string,
): { blockingGaps: string[]; notes: string[] } {
  return analyzeScreenshotGaps(receipt, label, 0, false);
}

export async function captureFullPageScreenshots(params: {
  browser: Pick<Awaited<ReturnType<typeof evaluationBrowser>>, 'capture'>;
  signal: AbortSignal;
  role: 'target' | 'reference';
  viewport: 'desktop' | 'mobile';
  url: string;
  label: string;
  settleTimeoutMs: number;
  maxTotalScreenshots?: number;
  chunkSize?: number;
}): Promise<{ blockingGaps: string[]; notes: string[]; totalCaptured: number }> {
  const {
    browser,
    signal,
    role,
    viewport,
    url,
    label,
    settleTimeoutMs,
    maxTotalScreenshots = MAX_HOMEPAGE_TOTAL_SCREENSHOTS,
    chunkSize = MAX_SCREENSHOTS_PER_CALL,
  } = params;

  const allScreenshots: ScreenshotReceipt[] = [];
  const blockingGaps: string[] = [];
  const notes: string[] = [];
  const maxRounds = Math.ceil(maxTotalScreenshots / Math.max(1, chunkSize)) + 1;
  let startY = 0;
  let finalNextStartY: number | null = null;
  let rounds = 0;
  let lastReceipt: PageScreenshotsReceipt | undefined;

  for (let round = 0; round < maxRounds && allScreenshots.length < maxTotalScreenshots; round++) {
    signal.throwIfAborted();
    rounds++;
    const remaining = maxTotalScreenshots - allScreenshots.length;
    const receipt = (await browser.capture({
      action: 'take_page_screenshots',
      role,
      viewport,
      url,
      scope: 'page',
      startY,
      maxScreenshots: Math.min(chunkSize, remaining),
      settleTimeoutMs,
    })) as PageScreenshotsReceipt;
    lastReceipt = receipt;

    const shotOffset = allScreenshots.length;
    const chunkAnalyzed = analyzeScreenshotGaps(receipt, label, shotOffset, true);
    blockingGaps.push(...chunkAnalyzed.blockingGaps);
    notes.push(...chunkAnalyzed.notes);

    if (!receipt.screenshots?.length) {
      finalNextStartY = receipt.nextStartY ?? (shotOffset > 0 ? startY : null);
      break;
    }

    allScreenshots.push(...receipt.screenshots);
    finalNextStartY = receipt.nextStartY;

    if (receipt.nextStartY === null) {
      break;
    }
    if (receipt.nextStartY <= startY) {
      break;
    }
    startY = receipt.nextStartY;
  }

  if (rounds === 1 && lastReceipt?.coverageComplete && !lastReceipt.gaps.length && finalNextStartY === null) {
    return { blockingGaps: [], notes: [], totalCaptured: allScreenshots.length };
  }

  if (finalNextStartY !== null) {
    blockingGaps.push(
      `${label}逐屏截图超出单轮上限，剩余纵向区间（nextStartY=${finalNextStartY}）未覆盖`,
    );
  }
  if (allScreenshots.length > 0) {
    const sortedPositions = [...allScreenshots]
      .map(s => s.position)
      .sort((a, b) => a.scrollY - b.scrollY);
    if (!screenshotRangeCovered(sortedPositions, 0)) {
      blockingGaps.push(`${label}逐屏截图纵向区间未完整覆盖页面高度`);
    }
  }

  return {
    blockingGaps: [...new Set(blockingGaps)],
    notes: [...new Set(notes)],
    totalCaptured: allScreenshots.length,
  };
}

export function formatRepairEvidenceGuide(
  images: readonly BatchImage[],
  manifestLines: readonly string[],
): string {
  if (!images.length) return manifestLines.join('\n');
  const hasMultiViewport = new Set(images.map(img => img.viewport)).size > 1;
  const formatItem = (img: BatchImage) =>
    hasMultiViewport ? `${img.name} (${img.viewport})` : img.name;
  const targets = images.filter(img => img.role === 'target').map(formatItem);
  const refs = images.filter(img => img.role === 'reference').map(formatItem);
  const lines = [`目标站 target 可用文件名：[${targets.join(', ') || '无'}]`];
  if (refs.length) {
    lines.push(`参考站 reference 可用文件名：[${refs.join(', ')}]`);
    lines.push(
      '每条已评分 assessments[].evidence 必须同时包含至少 1 张同视口 target 文件名和至少 1 张同视口 reference 文件名。',
    );
  }
  return lines.join('\n');
}

function validateTurnOutput(
  parsed: BoundedTurnOutput,
  batchViewports: ('desktop' | 'mobile')[],
  criteria: Criterion[],
  images: BatchImage[],
  referenceRequired: boolean,
  requireEvidenceFiles: boolean,
): void {
  const allowedVps = new Set(batchViewports);
  const expected = criteria
    .filter(c => c.scopes.includes('homepage'))
    .flatMap(c =>
      c.viewports
        .filter((v): v is 'desktop' | 'mobile' => allowedVps.has(v as 'desktop' | 'mobile'))
        .map(v => `${c.id}:${v}`),
    );
  const actual = parsed.assessments.map(a => `${a.criterionId}:${a.viewport}`);
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some(k => !expected.includes(k))
  ) {
    throw new Error(`评测结果没有完整对应本批指标与视口（期望 ${expected.join(', ')}）`);
  }

  const errors: string[] = [];
  const imageByName = new Map(images.map(img => [img.name, img]));
  for (const a of parsed.assessments) {
    if (a.score === null && a.passed !== null) {
      errors.push(`未验证指标 ${a.criterionId}(${a.viewport}) 的 passed 必须为 null`);
    }
    if (a.score !== null && a.passed === null) {
      errors.push(`已评分指标 ${a.criterionId}(${a.viewport}) 必须提供 passed 布尔值`);
    }
    if (!requireEvidenceFiles || !images.length) continue;

    const unknownFiles = a.evidence.filter(fileName => !imageByName.has(fileName));
    if (unknownFiles.length) {
      errors.push(`指标 ${a.criterionId}(${a.viewport}) 引用了本批未提供的证据：${unknownFiles.join(', ')}`);
    }
    if (a.score !== null) {
      const cited = a.evidence.map(name => imageByName.get(name)!).filter(Boolean);
      if (!cited.some(img => img.role === 'target' && img.viewport === a.viewport)) {
        errors.push(`指标 ${a.criterionId}(${a.viewport}) 缺少同视口 target 截图证据`);
      }
      if (
        referenceRequired &&
        images.some(img => img.role === 'reference' && img.viewport === a.viewport) &&
        !cited.some(img => img.role === 'reference' && img.viewport === a.viewport)
      ) {
        errors.push(`指标 ${a.criterionId}(${a.viewport}) 缺少同视口 reference 截图证据`);
      }
    }
  }

  if (requireEvidenceFiles && images.length) {
    for (const issue of parsed.issues) {
      const unknownIssueFiles = issue.evidence.filter(fileName => !imageByName.has(fileName));
      if (unknownIssueFiles.length) {
        errors.push(`问题「${issue.title}」引用了本批未提供的证据：${unknownIssueFiles.join(', ')}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(errors.join('；'));
  }
}

export function strictestVerdict(verdicts: EvaluationVerdict[]): EvaluationVerdict {
  const rank: Record<EvaluationVerdict, number> = {
    blocked: 4,
    'needs-fixes': 3,
    'incomplete-check': 2,
    ready: 1,
  };
  return verdicts.reduce<EvaluationVerdict>((best, cur) => (rank[cur] > rank[best] ? cur : best), 'ready');
}

export const COMPACT_RETRY_REMINDER =
  '\n\n【重试紧凑输出提醒】上一轮因思考或输出受限未能返回完整 JSON；请大幅压缩内部思考，避免逐张复述细节，仅聚焦核心缺陷与对应证据文件名，直接快速输出紧凑合法的 JSON。';

export function isBoundedNonRetryableModelError(message: string): boolean {
  return /模型预算|ModelBudgetExceeded|请求次数上限|预算上限|HTTP 402|余额/i.test(message);
}

/**
 * Run one bounded checker batch with single-batch execution recovery (fresh thread + compact reminder on
 * unexpected runtime crash/empty text) and one same-thread schema/evidence repair turn.
 */
export async function runBoundedBatchWithRecovery<T>(params: {
  codex: { startThread(options: ThreadOptions): Pick<Thread, 'runStreamed'> };
  threadOptions: ThreadOptions;
  task: AutomationTask;
  store: AutomationStore;
  capture: Awaited<ReturnType<typeof usageCapture>>;
  signal: AbortSignal;
  outputSchema: unknown;
  prompt: string;
  images?: BatchImage[];
  batchLabel: string;
  retryEventPrefix: string;
  repairEventPrefix: string;
  onThreadStarted?: (threadId: string) => void;
  buildRepairPrompt: (errorMessage: string) => string;
  parseAndValidate: (rawText: string) => T;
}): Promise<T> {
  const runSingleTurn = async (
    thread: Pick<Thread, 'runStreamed'>,
    textInput: string,
    attachImages: boolean,
  ): Promise<string> => {
    const usageStart = Date.now();
    const images = attachImages && params.images?.length ? params.images : [];
    const inputs: ({ type: 'text'; text: string } | { type: 'local_image'; path: string })[] = images.length
      ? [
          { type: 'text' as const, text: textInput },
          ...images.map(img => ({ type: 'local_image' as const, path: img.absPath })),
        ]
      : [{ type: 'text' as const, text: textInput }];
    const stream = await thread.runStreamed(inputs, {
      signal: params.capture.signal,
      outputSchema: params.outputSchema,
    });
    let final = '';
    let streamFailure: Error | undefined;
    for await (const event of stream.events) {
      params.signal.throwIfAborted();
      if (event.type === 'thread.started') {
        if (params.onThreadStarted) {
          params.onThreadStarted(event.thread_id);
        } else if (!params.task.threadId) {
          params.task.threadId = event.thread_id;
          params.store.put(params.task);
        }
      } else if (event.type === 'turn.completed') {
        params.capture.fallback(event.usage as unknown as Record<string, unknown>, usageStart);
      } else if (event.type === 'turn.failed') {
        streamFailure = new Error(event.error.message);
      } else if (event.type === 'error') {
        streamFailure = new Error(event.message);
      } else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        final = event.item.text;
      }
    }
    if (streamFailure) throw streamFailure;
    if (!final.trim()) throw new Error('模型未返回有效文本内容');
    return final;
  };

  let activeThread = params.codex.startThread(params.threadOptions);
  let firstRaw: string;
  try {
    firstRaw = await runSingleTurn(activeThread, params.prompt, true);
  } catch (execError) {
    params.signal.throwIfAborted();
    if (params.capture.signal.aborted) throw execError;
    const errMsg = execError instanceof Error ? execError.message : String(execError);
    if (isBoundedNonRetryableModelError(errMsg)) throw execError;
    params.store.event(params.task.id, `${params.retryEventPrefix}（${params.batchLabel}）：${errMsg}`);
    activeThread = params.codex.startThread(params.threadOptions);
    firstRaw = await runSingleTurn(activeThread, params.prompt + COMPACT_RETRY_REMINDER, true);
  }

  try {
    return params.parseAndValidate(firstRaw);
  } catch (firstError) {
    const errMsg = firstError instanceof Error ? firstError.message : String(firstError);
    params.store.event(params.task.id, `${params.repairEventPrefix}：${errMsg}`);
    const repairRaw = await runSingleTurn(activeThread, params.buildRepairPrompt(errMsg), false);
    return params.parseAndValidate(repairRaw);
  }
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await fn(items[current], current);
      }
    }),
  );
  return results;
}

export function mergeBoundedIssues(batchIssueLists: readonly (readonly BoundedIssue[])[]): BoundedIssue[] {
  const merged: BoundedIssue[] = [];
  for (const issues of batchIssueLists) {
    for (const issue of issues) {
      const existing = merged.find(item => {
        if (item.severity !== issue.severity) return false;
        if ((item.ruleId || '') === (issue.ruleId || '') && item.title.trim() === issue.title.trim()) {
          return true;
        }
        if (
          item.ruleId &&
          issue.ruleId &&
          item.ruleId === issue.ruleId &&
          item.criterionId &&
          issue.criterionId &&
          item.criterionId === issue.criterionId
        ) {
          return true;
        }
        return areCrossViewportMinorDuplicates(item, issue);
      });
      if (existing) {
        existing.evidence = [...new Set([...existing.evidence, ...issue.evidence])];
        if (existing.viewport !== issue.viewport) existing.viewport = 'both';
        continue;
      }
      merged.push({ ...issue, evidence: [...issue.evidence] });
    }
  }
  return merged;
}

export function mergeBoundedHumanSummary(
  summaries: readonly EvaluationHumanSummary[],
  quality: 'passed' | 'failed' | 'unverified',
): EvaluationHumanSummary {
  let verdict = strictestVerdict(summaries.map(s => s.verdict));
  if (verdict === 'ready') {
    if (quality === 'failed') verdict = 'needs-fixes';
    else if (quality === 'unverified') verdict = 'incomplete-check';
  }
  const headline = pickStrictestHeadline(summaries) || '已完成独立评测';
  const highlights = filterContradictoryHighlights(
    deduplicateBatchTexts(
      summaries.flatMap(s => s.highlights),
      6,
    ),
    quality,
    verdict,
  );
  const topFixes = deduplicateBatchTexts(
    summaries.flatMap(s => s.topFixes),
    6,
    0.36,
  );
  const unverifiedNote = deduplicateBatchTexts(
    summaries.map(s => s.unverifiedNote?.trim() || '').filter(Boolean),
    3,
    0.55,
  ).join('；');

  return {
    verdict,
    headline,
    highlights,
    topFixes,
    ...(unverifiedNote ? { unverifiedNote: unverifiedNote.slice(0, 480) } : {}),
  };
}

export function aggregateMultiBatchAssessments(
  batchAssessments: readonly Assessment[],
  criteria: readonly Criterion[],
  requiredViewports: readonly ('desktop' | 'mobile' | 'business')[],
  groupOrder: 'criterion' | 'viewport' = 'criterion',
): Assessment[] {
  const aggregated: Assessment[] = [];
  const allowedVps = new Set(requiredViewports);
  const pairs: { criterion: Criterion; vp: 'desktop' | 'mobile' | 'business' }[] =
    groupOrder === 'viewport'
      ? requiredViewports.flatMap(vp =>
          criteria.filter(c => c.viewports.includes(vp)).map(criterion => ({ criterion, vp })),
        )
      : criteria.flatMap(criterion =>
          criterion.viewports.filter(vp => allowedVps.has(vp)).map(vp => ({ criterion, vp })),
        );

  for (const { criterion, vp } of pairs) {
    const rows = batchAssessments.filter(a => a.criterionId === criterion.id && a.viewport === vp);
    if (!rows.length) {
      aggregated.push({
        criterionId: criterion.id,
        viewport: vp,
        score: null,
        passed: null,
        reason: `本轮缺少 ${vp} 视口的有效取证，保留未验证。`,
        evidence: [],
      });
      continue;
    }
    if (rows.length === 1) {
      aggregated.push({
        ...rows[0],
        evidence: [...new Set(rows[0].evidence)],
      });
      continue;
    }

    const combinedEvidence = [...new Set(rows.flatMap(r => r.evidence))];
    const combinedReason = rows
      .map(r => r.reason.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(' | ')
      .slice(0, 1500);

    if (rows.some(r => r.score === null || r.passed === null)) {
      aggregated.push({
        criterionId: criterion.id,
        viewport: vp,
        score: null,
        passed: null,
        reason: combinedReason || '存在未完成取证的页面批次，保留未验证。',
        evidence: combinedEvidence,
      });
      continue;
    }

    if (rows.some(r => r.passed === false)) {
      const minScore = Math.min(...rows.map(r => r.score!));
      aggregated.push({
        criterionId: criterion.id,
        viewport: vp,
        score: minScore,
        passed: false,
        reason: combinedReason,
        evidence: combinedEvidence,
      });
      continue;
    }

    const avgScore = Math.round((rows.reduce((sum, r) => sum + r.score!, 0) / rows.length) * 10) / 10;
    aggregated.push({
      criterionId: criterion.id,
      viewport: vp,
      score: avgScore,
      passed: true,
      reason: combinedReason,
      evidence: combinedEvidence,
    });
  }

  return aggregated;
}

export interface PlannedHomepageBatch {
  label: string;
  viewports: ('desktop' | 'mobile')[];
  criteria: Criterion[];
  images: BatchImage[];
  prechecks: ViewportVisualPrecheck[];
  pageScopeNote?: string;
}

export function planHomepageBatches(params: {
  criteria: readonly Criterion[];
  requiredViewports: readonly ('desktop' | 'mobile')[];
  targetDesktop: readonly BatchImage[];
  refDesktop: readonly BatchImage[];
  targetMobile: readonly BatchImage[];
  refMobile: readonly BatchImage[];
  prechecks: readonly ViewportVisualPrecheck[];
}): PlannedHomepageBatch[] {
  const { criteria, requiredViewports, targetDesktop, refDesktop, targetMobile, refMobile, prechecks } = params;
  const scopedCriteria = criteria.filter(c => c.scopes.includes('homepage'));
  const desktopImages = [...targetDesktop, ...refDesktop];
  const mobileImages = [...targetMobile, ...refMobile];
  const totalImages = desktopImages.length + mobileImages.length;

  if (
    totalImages <= SINGLE_TURN_IMAGE_LIMIT ||
    (requiredViewports.length <= 1 && totalImages <= MAX_HOMEPAGE_BATCH_IMAGES)
  ) {
    return [
      {
        label: '双端',
        viewports: [...requiredViewports],
        criteria: scopedCriteria,
        images: [...desktopImages, ...mobileImages],
        prechecks: [...prechecks],
      },
    ];
  }

  const batches: PlannedHomepageBatch[] = [];
  for (const viewport of requiredViewports) {
    const vpTarget = viewport === 'desktop' ? targetDesktop : targetMobile;
    const vpRef = viewport === 'desktop' ? refDesktop : refMobile;
    const vpPrechecks = prechecks.filter(p => p.snapshot.viewport === viewport);
    const vpCriteria = scopedCriteria.filter(c => c.viewports.includes(viewport));
    if (!vpCriteria.length) continue;

    if (vpTarget.length + vpRef.length <= MAX_HOMEPAGE_BATCH_IMAGES) {
      batches.push({
        label: viewport,
        viewports: [viewport],
        criteria: vpCriteria,
        images: [...vpTarget, ...vpRef],
        prechecks: vpPrechecks,
      });
      continue;
    }

    const rawBase = vpTarget.filter(img => img.action !== 'visual_precheck');
    const rawProbes = vpTarget.filter(img => img.action === 'visual_precheck');
    const baseTarget = rawBase.length ? rawBase : [...vpTarget];
    const probeTarget = rawBase.length ? rawProbes : [];
    const refPerSlice = vpRef.length > 0 ? Math.min(vpRef.length, 3) : 0;
    const probeReserved = Math.min(probeTarget.length, 2);
    const maxTargetPerSlice = Math.max(1, MAX_HOMEPAGE_BATCH_IMAGES - refPerSlice - probeReserved);
    const sliceCount = Math.max(1, Math.ceil(baseTarget.length / maxTargetPerSlice));
    const baseSize = Math.floor(baseTarget.length / sliceCount);
    const remainder = baseTarget.length % sliceCount;

    const nonHeroCriteria = vpCriteria.filter(c => !/hero|首屏/i.test(`${c.id} ${c.label}`));
    const pickRefWindow = (sliceIdx: number): BatchImage[] => {
      if (!vpRef.length || refPerSlice <= 0) return [];
      if (vpRef.length <= refPerSlice) return [...vpRef];
      const center = Math.round(((sliceIdx + 0.5) / sliceCount) * (vpRef.length - 1));
      const maxStart = vpRef.length - refPerSlice;
      const start = Math.max(0, Math.min(maxStart, center - Math.floor(refPerSlice / 2)));
      return vpRef.slice(start, start + refPerSlice);
    };

    let cursor = 0;
    for (let i = 0; i < sliceCount; i++) {
      const size = baseSize + (i < remainder ? 1 : 0);
      const targetSlice = baseTarget.slice(cursor, cursor + size);
      cursor += size;
      const refSlice = pickRefWindow(i);
      const probeSlice =
        i === 0 ? probeTarget.slice(0, Math.max(0, MAX_HOMEPAGE_BATCH_IMAGES - targetSlice.length - refSlice.length)) : [];
      const sliceImages = [...targetSlice, ...probeSlice, ...refSlice];
      const sliceCriteria = i === 0 ? vpCriteria : nonHeroCriteria.length ? nonHeroCriteria : vpCriteria;
      const scrollValues = targetSlice
        .map(img => img.scrollY)
        .filter((y): y is number => typeof y === 'number');
      const rangeDesc = scrollValues.length
        ? `纵向 scrollY=${Math.min(...scrollValues)}..${Math.max(...scrollValues)}px`
        : `共 ${targetSlice.length} 屏`;
      const partDesc = i === 0 ? '首屏与上段' : i === sliceCount - 1 ? '下段与页脚' : '中段内容区段';
      const pageScopeNote = `超长首页分段视觉评审 ${viewport}#${i + 1}/${sliceCount}（${partDesc}，${rangeDesc}）；其余区段及另一视口由并行分段独立核验。请仅依据本段截图及预检事实评价本批适用指标，严禁把“本段仅包含部分纵向区段/未包含首屏或页脚/未包含另一视口”写入 coverage.unverified 或 coverage.outOfScope。`;

      batches.push({
        label: `${viewport}#${i + 1}/${sliceCount}`,
        viewports: [viewport],
        criteria: sliceCriteria,
        images: sliceImages,
        prechecks: i === 0 ? vpPrechecks : [],
        pageScopeNote,
      });
    }
  }

  return batches;
}

export async function executeBoundedHomepageEvaluation(params: {
  task: AutomationTask;
  store: AutomationStore;
  directory: string;
  work: string;
  site: GeneratedSite;
  input: ResourceInput;
  refOrContent: string;
  templateResidualGuidance?: string;
  directTemplateName?: string;
  browser: Awaited<ReturnType<typeof evaluationBrowser>>;
  codex: ReturnType<typeof codexClient>;
  capture: Awaited<ReturnType<typeof usageCapture>>;
  signal: AbortSignal;
  threshold: number;
}): Promise<AutomationReport> {
  const {
    task,
    store,
    work,
    site,
    input,
    refOrContent,
    templateResidualGuidance,
    directTemplateName,
    browser,
    codex,
    capture,
    signal,
    threshold,
  } = params;

  const criteria = task.rule!.criteria.filter(c => c.scopes.includes('homepage'));
  const hasReference = Boolean(refOrContent.trim());
  const hasMaterials = Boolean(input.files?.length);
  const presetOutOfScope = defaultOutOfScope({
    scenario: task.scenario,
    scope: task.scope,
    hasReference,
    hasMaterials,
    hasBackendAccess: false,
  });

  const canCapture = typeof (browser as { capture?: unknown }).capture === 'function';
  const prechecks: ViewportVisualPrecheck[] = [];
  const captureGaps: string[] = [];
  const captureNotes: string[] = [];

  if (canCapture) {
    const finishEvidence = store.timing.activity(task.id, 'evidence');
    try {
      for (const viewport of ['desktop', 'mobile'] as const) {
        signal.throwIfAborted();
        if (!hasCompleteRetainedCapture(browser.artifacts, work, 'target', viewport)) {
          const captured = await captureFullPageScreenshots({
            browser,
            signal,
            role: 'target',
            viewport,
            url: site.url,
            label: `目标站 ${viewport}`,
            settleTimeoutMs: 2000,
          });
          captureGaps.push(...captured.blockingGaps);
          captureNotes.push(...captured.notes);
        }
        try {
          const precheck = (await browser.capture({
            action: 'visual_precheck',
            role: 'target',
            viewport,
            ...(directTemplateName ? { templateName: directTemplateName } : {}),
          })) as ViewportVisualPrecheck;
          if (precheck && precheck.snapshot && Array.isArray(precheck.signals)) {
            prechecks.push(precheck);
          }
        } catch {
          // Optional precheck: gracefully skip if mock browser adapter does not implement visual_precheck.
        }

        if (hasReference && !hasCompleteRetainedCapture(browser.artifacts, work, 'reference', viewport)) {
          try {
            const capturedRef = await captureFullPageScreenshots({
              browser,
              signal,
              role: 'reference',
              viewport,
              url: refOrContent,
              label: `参考/源站 ${viewport}`,
              settleTimeoutMs: 10000,
            });
            captureGaps.push(...capturedRef.blockingGaps);
            captureNotes.push(...capturedRef.notes);
          } catch (error) {
            captureGaps.push(
              `参考/源站 ${viewport} 采集失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      writeFileSync(
        resolve(work, 'precheck-facts.json'),
        JSON.stringify({ prechecks, captureGaps, captureNotes }, null, 2),
        { mode: 0o600 },
      );
    } finally {
      finishEvidence();
    }
  }

  const targetDesktop = collectBatchImages(
    browser.artifacts,
    work,
    'target',
    'desktop',
    undefined,
    MAX_HOMEPAGE_TOTAL_SCREENSHOTS,
  );
  const targetMobile = collectBatchImages(
    browser.artifacts,
    work,
    'target',
    'mobile',
    undefined,
    MAX_HOMEPAGE_TOTAL_SCREENSHOTS,
  );
  const refDesktop = hasReference
    ? sampleReferenceImages(
        collectBatchImages(
          browser.artifacts,
          work,
          'reference',
          'desktop',
          undefined,
          MAX_HOMEPAGE_TOTAL_SCREENSHOTS,
        ),
        MAX_REFERENCE_IMAGES_PER_VIEWPORT,
      )
    : [];
  const refMobile = hasReference
    ? sampleReferenceImages(
        collectBatchImages(
          browser.artifacts,
          work,
          'reference',
          'mobile',
          undefined,
          MAX_HOMEPAGE_TOTAL_SCREENSHOTS,
        ),
        MAX_REFERENCE_IMAGES_PER_VIEWPORT,
      )
    : [];

  const requiredViewports = [...new Set(criteria.flatMap(c => c.viewports))] as ('desktop' | 'mobile')[];
  const batches = planHomepageBatches({
    criteria,
    requiredViewports,
    targetDesktop,
    refDesktop,
    targetMobile,
    refMobile,
    prechecks,
  });
  const totalImages = targetDesktop.length + refDesktop.length + targetMobile.length + refMobile.length;

  const allSignals = prechecks.flatMap(p => p.signals);
  store.event(
    task.id,
    `有界多模态评测已启动（${batches.length} 批${batches.length > 1 ? '并行' : ''} / ${totalImages} 张实图；程序预检命中 ${allSignals.length} 项信号）`,
  );

  const checksSnapshot = store.checks
    ? store.checks.snapshot({ scenario: task.scenario, scope: task.scope })
    : (() => {
        const md = renderChecksMarkdown([]);
        return { hash: hashChecksSnapshot(md, []), markdown: md, rules: [], calibrations: [] };
      })();
  const antiPatternRules: AntiPatternRule[] = store.checks
    ? toAntiPatternRules(checksSnapshot.rules)
    : [...DEFAULT_ANTI_PATTERN_RULES];
  const allowedRuleIds = antiPatternRules.map(r => r.id);
  const checksSnapshotMeta = {
    hash: checksSnapshot.hash,
    ruleIds: allowedRuleIds,
    ruleCount: allowedRuleIds.length,
  };
  if (checksSnapshot.markdown) {
    writeFileSync(resolve(work, 'CHECKS.md'), checksSnapshot.markdown, { mode: 0o600 });
    store.event(
      task.id,
      `已加载并冻结 CHECKS.md 红线快照（${checksSnapshotMeta.ruleCount} 条启用规则，#${checksSnapshotMeta.hash.slice(0, 10)}）`,
    );
  }

  const materialNotes = extractBoundedMaterialNotes(work, input.files || []);
  const modelName = task.model?.name || 'deepseek-flash';
  const threadOptions = {
    model: modelName,
    workingDirectory: work,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only' as const,
    networkAccessEnabled: false,
    approvalPolicy: 'never' as const,
    webSearchMode: 'disabled' as const,
  };
  const turnSchema = createBoundedTurnOutputSchema(allowedRuleIds);
  const outputSchema = z.toJSONSchema(turnSchema);

  const batchCacheFile = resolve(work, 'bounded-batch-cache.json');
  const loadBatchCache = (): Record<string, unknown> => {
    if (!existsSync(batchCacheFile)) return {};
    try {
      const raw = JSON.parse(readFileSync(batchCacheFile, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const batchCache = loadBatchCache();
  const writeBatchCacheFile = () => {
    writeFileSync(batchCacheFile, JSON.stringify(batchCache, null, 2), { mode: 0o600 });
  };

  const batchResults: BoundedTurnOutput[] = await runWithConcurrency(batches, 2, async batch => {
      const siblingViewports =
        batches.length > 1 ? requiredViewports.filter(v => !batch.viewports.includes(v)) : undefined;
      const manifestLines = batch.images.map(
        img =>
          `${img.name} (role=${img.role}, viewport=${img.viewport}, ${img.width ?? '?'}x${img.height ?? '?'}, action=${img.action}${
            img.probe ? `, probe=${img.probe}` : ''
          }${img.scrollY !== null ? `, scrollY=${img.scrollY}` : ''})`,
      );
      const prompt = buildBoundedCheckerPrompt({
        scenario: task.scenario,
        scope: task.scope,
        siteUrl: site.url,
        description: input.description || task.message || '',
        criteria: batch.criteria,
        presetOutOfScope,
        precheckDigest: formatPrecheckDigest(batch.prechecks),
        imageManifestLines: manifestLines,
        hasReference,
        viewports: batch.viewports,
        ...(siblingViewports?.length ? { siblingViewports } : {}),
        ...(batch.pageScopeNote ? { pageScopeNote: batch.pageScopeNote } : {}),
        materialNotes,
        extraGuidance: templateResidualGuidance,
        antiPatternRules,
      });

      const parseAndValidate = (rawText: string) => {
        const parsed = turnSchema.parse(JSON.parse(rawText)) as BoundedTurnOutput;
        validateTurnOutput(parsed, batch.viewports, batch.criteria, batch.images, hasReference, canCapture);
        return parsed;
      };

      const cacheKey = createHash('sha256')
        .update(
          JSON.stringify({
            v: 1,
            siteRevision: task.siteRevision || '',
            ruleHash: task.rule?.hash || '',
            checksHash: checksSnapshotMeta.hash,
            label: batch.label,
            viewports: batch.viewports,
            criteriaIds: batch.criteria.map(c => c.id),
            images: batch.images.map(img => `${img.name}:${img.sha256}`),
          }),
        )
        .digest('hex');

      const cachedEntry = batchCache[cacheKey];
      if (cachedEntry !== undefined) {
        try {
          const validated = parseAndValidate(
            typeof cachedEntry === 'string' ? cachedEntry : JSON.stringify(cachedEntry),
          );
          store.event(task.id, `复用已验证批次缓存（${batch.label}），跳过重复模型请求`);
          return validated;
        } catch {
          delete batchCache[cacheKey];
          writeBatchCacheFile();
        }
      }

      const fresh = await runBoundedBatchWithRecovery({
        codex,
        threadOptions,
        task,
        store,
        capture,
        signal,
        outputSchema,
        prompt,
        images: batch.images,
        batchLabel: batch.label,
        retryEventPrefix: '有界评测批次重试 1/1',
        repairEventPrefix: `有界评测结果修正 1/1（${batch.label}）`,
        buildRepairPrompt: errMsg =>
          `上一轮输出未通过平台校验：${errMsg}\n请仅修正字段与证据文件名，继续使用简体中文输出完整严格 JSON。${formatRepairEvidenceGuide(batch.images, manifestLines)}`,
        parseAndValidate,
      });
      batchCache[cacheKey] = fresh;
      writeBatchCacheFile();
      return fresh;
  });

  for (const file of browser.artifacts) {
    const filePath = resolve(work, 'evidence', file.name);
    if (!existsSync(filePath)) throw new Error('证据文件丢失，不能据此评分：' + file.name);
    if (createHash('sha256').update(readFileSync(filePath)).digest('hex') !== file.sha256) {
      throw new Error('证据文件在采集后发生变化，不能据此评分');
    }
  }

  const assessments: Assessment[] = aggregateMultiBatchAssessments(
    batchResults.flatMap(r => r.assessments),
    criteria,
    requiredViewports,
    'viewport',
  );
  const rawIssues = mergeBoundedIssues(batchResults.map(r => r.issues));
  const coveredViewports = new Set<'desktop' | 'mobile'>(requiredViewports);
  const hasMultiSlice = batches.some(b => b.label.includes('#'));
  const stripSliceLeaks = (items: string[]) =>
    hasMultiSlice && captureGaps.length === 0 ? filterCrossSliceCoverageLeaks(items, true) : items;

  const mergedCoverage = {
    verified: batchResults.flatMap(r => r.coverage.verified),
    unverified: [...stripSliceLeaks(batchResults.flatMap(r => r.coverage.unverified)), ...captureGaps],
    outOfScope: filterCrossBatchOutOfScopeLeaks(
      stripSliceLeaks(batchResults.flatMap(r => r.coverage.outOfScope)),
      coveredViewports,
    ),
  };

  const combinedSummary = batchResults.map(r => r.summary.trim()).filter(Boolean).join('\n\n');
  const mergedHumanInput = mergeBoundedHumanSummary(
    batchResults.map(r => ({
      verdict: r.humanSummary.verdict,
      headline: r.humanSummary.headline,
      highlights: r.humanSummary.highlights,
      topFixes: r.humanSummary.topFixes,
      ...(r.humanSummary.unverifiedNote ? { unverifiedNote: r.humanSummary.unverifiedNote } : {}),
    })),
    'passed',
  );

  const verdict = applyBoundedVerdictCaps({
    assessments,
    issues: rawIssues,
    criteria,
    threshold,
    coverage: mergedCoverage,
    presetOutOfScope,
    humanSummary: mergedHumanInput,
    precheckSignals: allSignals,
    antiPatternRules,
  });

  if (verdict.humanSummary) {
    verdict.humanSummary = {
      ...verdict.humanSummary,
      highlights: filterContradictoryHighlights(
        verdict.humanSummary.highlights,
        verdict.quality,
        verdict.humanSummary.verdict,
      ),
    };
  }

  if (verdict.capNotes.length) {
    store.event(task.id, '宿主硬封顶已触发：' + verdict.capNotes.join('；'));
  }

  const reportIssues: AutomationReport['issues'] = verdict.issues.map(issue => ({
    severity: issue.severity,
    title: issue.title,
    detail: issue.ruleId ? `[${issue.ruleId}] ${issue.detail}` : issue.detail,
    evidence: issue.evidence,
  }));

  const humanSummary = deriveEvaluationHumanSummary({
    summary: combinedSummary,
    quality: verdict.quality,
    scores: verdict.scores,
    issues: reportIssues,
    coverage: verdict.coverage,
    assessments: verdict.assessments,
    humanSummary: verdict.humanSummary,
  });

  const report: AutomationReport = {
    summary: combinedSummary,
    assessments: verdict.assessments,
    issues: reportIssues,
    coverage: verdict.coverage,
    scores: verdict.scores,
    quality: verdict.quality,
    artifacts: browser.artifacts,
    ...(store.checks ? { checksSnapshot: checksSnapshotMeta } : {}),
    humanSummary,
  };

  writeFileSync(resolve(work, 'result.json'), JSON.stringify(batchResults.length === 1 ? batchResults[0] : batchResults, null, 2), {
    mode: 0o600,
  });
  return report;
}
