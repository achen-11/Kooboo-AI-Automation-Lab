import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import type { CompletenessReport, RequirementCheck, RequirementManifest } from '../../shared/completeness.js';
import { deriveEvaluationHumanSummary } from '../../shared/human-diagnostics.js';
import {
  applyBoundedVerdictCaps,
  buildBoundedCheckerPrompt,
  defaultOutOfScope,
  DEFAULT_ANTI_PATTERN_RULES,
  filterContradictoryHighlights,
  filterCrossBatchOutOfScopeLeaks,
  type AntiPatternRule,
  type BoundedIssue,
} from './bounded-checker-rules.js';
import {
  aggregateMultiBatchAssessments,
  boundedTurnOutputSchema,
  captureFullPageScreenshots,
  collectBatchImages,
  createBoundedTurnIssueSchema,
  createBoundedTurnOutputSchema,
  extractBoundedMaterialNotes,
  formatRepairEvidenceGuide,
  hasCompleteRetainedCapture,
  mergeBoundedHumanSummary,
  mergeBoundedIssues,
  runBoundedBatchWithRecovery,
  runWithConcurrency,
  sampleReferenceImages,
  type BatchImage,
  type BoundedTurnOutput,
} from './bounded-evaluator.js';
import { hashChecksSnapshot, renderChecksMarkdown, toAntiPatternRules } from './checker-checks.js';
import type { evaluationBrowser } from './browser.js';
import type { codexClient } from './codex-client.js';
import { checksSchema, validateCompleteness } from './completeness.js';
import type { inspectionTools } from './inspection-tools.js';
import type { AutomationStore } from './store.js';

export { aggregateMultiBatchAssessments };
import { templateRecordFacts, type TemplateRecordFacts } from './template-facts.js';
import { templateTargetPath } from './template-path.js';
import type { usageCapture } from './usage-proxy.js';
import {
  discoverBoundedSitePaths,
  formatPrecheckDigest,
  type ViewportVisualPrecheck,
} from './visual-precheck.js';

export const MAX_BOUNDED_SITE_DISCOVERED_PAGES = 6;
export const MAX_BOUNDED_SITE_MANIFEST_PATHS = 12;
export const MAX_SITE_BATCH_IMAGES = 10;
export const MAX_SITE_BATCH_CONCURRENCY = 2;
export const INNER_PAGE_MAX_SCREENSHOTS = 8;

const IMPLEMENTATION_INDEX_KINDS = [
  'pages',
  'routes',
  'views',
  'codes',
  'folders',
  'tables',
  'products',
  'categories',
] as const;

function createSiteBusinessOutputSchemas(allowedRuleIds: readonly string[]) {
  const businessOnly = z
    .object({
      summary: z.string().min(1).max(4000),
      assessments: z
        .array(
          z
            .object({
              criterionId: z.string().min(1),
              viewport: z.literal('business'),
              score: z.number().min(0).max(100).nullable(),
              reason: z.string().min(1).max(1500),
              evidence: z.array(z.string().min(1)).max(20),
              passed: z.boolean().nullable(),
            })
            .strict(),
        )
        .max(20),
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
  return {
    businessOnly,
    manifestBusiness: businessOnly.extend({ completeness: checksSchema }),
  };
}

const { businessOnly: siteBusinessOnlyOutputSchema } = createSiteBusinessOutputSchemas(
  DEFAULT_ANTI_PATTERN_RULES.map(r => r.id),
);

export interface CapturedSitePageImages {
  path: string;
  url: string;
  desktopImages: BatchImage[];
  mobileImages: BatchImage[];
  prechecks: ViewportVisualPrecheck[];
}

export interface SiteVisualBatch {
  label: string;
  viewport: 'desktop' | 'mobile';
  paths: string[];
  images: BatchImage[];
  prechecks: ViewportVisualPrecheck[];
}

export function normalizeBoundedPath(
  rawPath: string,
  pageAliases: Readonly<Record<string, string>> = {},
  targetBaseUrl?: string,
  sourceBaseUrl?: string,
): string | null {
  let resolved = rawPath.trim();
  if (!resolved) return null;
  if (Object.hasOwn(pageAliases, resolved)) {
    resolved = pageAliases[resolved];
  }
  if (/^u\d+$/.test(resolved)) return null;
  if (targetBaseUrl && sourceBaseUrl) {
    try {
      resolved = templateTargetPath(resolved, targetBaseUrl, sourceBaseUrl);
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(resolved, targetBaseUrl || 'https://placeholder.test');
    let pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return pathname + parsed.search;
  } catch {
    return null;
  }
}

export function collectManifestTargetPaths(
  manifest: RequirementManifest,
  pageAliases: Readonly<Record<string, string>> = {},
  targetBaseUrl?: string,
  sourceBaseUrl?: string,
): string[] {
  const unique = new Set<string>();
  for (const item of manifest.items) {
    if (item.kind !== 'page' && item.kind !== 'template') continue;
    const rawList = item.kind === 'page' ? item.paths : item.samples?.length ? item.samples : item.paths;
    for (const raw of rawList) {
      const normalized = normalizeBoundedPath(raw, pageAliases, targetBaseUrl, sourceBaseUrl);
      if (normalized) unique.add(normalized);
    }
  }
  const rest = [...unique].filter(p => p !== '/');
  return unique.has('/') ? ['/', ...rest] : rest;
}

export function canUseBoundedSiteEvaluation(input: {
  task: AutomationTask;
  manifest?: RequirementManifest;
  program?: unknown;
}): boolean {
  const { task, manifest, program } = input;
  if (task.scope !== 'site') return false;
  if (!['materials', 'upgrade', 'migration'].includes(task.scenario)) return false;
  if (task.templateWorkflow || program || manifest?.migration) return false;
  if (!task.rule) return false;
  const criteria = task.rule.criteria.filter(c => c.scopes.includes('site'));
  if (!criteria.length) return false;

  if (manifest) {
    if (!manifest.sourceComplete) return false;
    if (manifest.items.some(item => item.kind === 'workflow')) return false;
    if (
      manifest.items.some(
        item =>
          item.kind === 'data' &&
          (!item.records || (item.dataIdentity?.kind && item.dataIdentity.kind !== 'page')),
      )
    ) {
      return false;
    }
    if (collectManifestTargetPaths(manifest).length > MAX_BOUNDED_SITE_MANIFEST_PATHS) {
      return false;
    }
  }

  return true;
}

export function planSiteVisualBatches(
  pages: readonly CapturedSitePageImages[],
  viewports: readonly ('desktop' | 'mobile')[],
  maxImagesPerBatch = MAX_SITE_BATCH_IMAGES,
): SiteVisualBatch[] {
  const batches: SiteVisualBatch[] = [];
  const limit = Math.max(1, maxImagesPerBatch);

  for (const viewport of viewports) {
    let chunkPaths: string[] = [];
    let chunkImages: BatchImage[] = [];
    let chunkPrechecks: ViewportVisualPrecheck[] = [];
    let partIndex = 1;

    const flush = () => {
      if (!chunkImages.length && !chunkPrechecks.length) return;
      batches.push({
        label: `${viewport}#${partIndex} (${chunkPaths.join(', ')})`,
        viewport,
        paths: chunkPaths,
        images: chunkImages,
        prechecks: chunkPrechecks,
      });
      partIndex++;
      chunkPaths = [];
      chunkImages = [];
      chunkPrechecks = [];
    };

    for (const page of pages) {
      const pageImages = viewport === 'desktop' ? page.desktopImages : page.mobileImages;
      const pagePrechecks = page.prechecks.filter(p => p.snapshot.viewport === viewport);
      if (!pageImages.length && !pagePrechecks.length) continue;

      if (pageImages.length > limit) {
        flush();
        const pageTarget = pageImages.filter(img => img.role === 'target');
        const pageRef = pageImages.filter(img => img.role === 'reference');
        if (!pageTarget.length) {
          batches.push({
            label: `${viewport}#${partIndex} (${page.path})`,
            viewport,
            paths: [page.path],
            images: sampleReferenceImages(pageRef, limit),
            prechecks: pagePrechecks,
          });
          partIndex++;
          continue;
        }
        const maxRefShare = pageRef.length ? Math.min(pageRef.length, Math.max(1, Math.floor(limit / 2))) : 0;
        const sampledRef = maxRefShare > 0 ? sampleReferenceImages(pageRef, Math.min(maxRefShare, limit - 1)) : [];
        const targetStep = Math.max(1, limit - sampledRef.length);
        for (let offset = 0; offset < pageTarget.length; offset += targetStep) {
          const targetSlice = pageTarget.slice(offset, offset + targetStep);
          const refBudget = Math.max(0, limit - targetSlice.length);
          const refSlice = sampledRef.length && refBudget > 0 ? sampleReferenceImages(sampledRef, refBudget) : [];
          batches.push({
            label: `${viewport}#${partIndex} (${page.path})`,
            viewport,
            paths: [page.path],
            images: [...targetSlice, ...refSlice],
            prechecks: offset === 0 ? pagePrechecks : [],
          });
          partIndex++;
        }
        continue;
      }

      if (chunkImages.length > 0 && chunkImages.length + pageImages.length > limit) {
        flush();
      }
      chunkPaths.push(page.path);
      chunkImages.push(...pageImages);
      chunkPrechecks.push(...pagePrechecks);
    }

    flush();
  }

  return batches;
}

function summarizeImplementationValue(value: unknown): string {
  if (!value || typeof value !== 'object') return '无返回值';
  const rec = value as Record<string, unknown>;
  const unwrap = (node: unknown): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const obj = node as Record<string, unknown>;
    if (obj.value !== undefined) return unwrap(obj.value);
    return node;
  };
  const payload = unwrap(rec.value ?? value);
  if (Array.isArray(payload)) {
    const names = payload
      .slice(0, 15)
      .map(item => {
        if (!item || typeof item !== 'object') return String(item);
        const row = item as Record<string, unknown>;
        return String(row.route || row.url || row.path || row.name || row.title || row.id || 'item');
      });
    return `共 ${payload.length} 条${names.length ? `（${names.join(', ')}${payload.length > 15 ? ', ...' : ''}）` : ''}`;
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const list = Array.isArray(obj.list) ? obj.list : undefined;
    const total = obj.totalCount ?? obj.count ?? list?.length;
    if (list) {
      const sampleNames = list
        .slice(0, 12)
        .map(item => {
          if (!item || typeof item !== 'object') return String(item);
          const row = item as Record<string, unknown>;
          return String(row.route || row.url || row.name || row.title || row.id || 'item');
        });
      return `total=${total ?? list.length}${sampleNames.length ? `（${sampleNames.join(', ')}${list.length > 12 ? ', ...' : ''}）` : ''}`;
    }
    return JSON.stringify(payload).slice(0, 260);
  }
  return String(payload).slice(0, 200);
}

function validateVisualSiteBatchOutput(
  parsed: BoundedTurnOutput,
  batchViewport: 'desktop' | 'mobile',
  visualCriteria: readonly Criterion[],
  images: readonly BatchImage[],
  referenceRequired: boolean,
  requireEvidenceFiles: boolean,
): void {
  const expected = visualCriteria
    .filter(c => c.viewports.includes(batchViewport))
    .map(c => `${c.id}:${batchViewport}`);
  const actual = parsed.assessments.map(a => `${a.criterionId}:${a.viewport}`);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(k => !expected.includes(k))) {
    throw new Error(`全站视觉批次评测结果没有完整对应本批指标与视口（期望 ${expected.join(', ')}）`);
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
      if (!cited.some(img => img.role === 'target' && img.viewport === batchViewport)) {
        errors.push(`指标 ${a.criterionId}(${a.viewport}) 缺少同视口 target 截图证据`);
      }
      if (
        referenceRequired &&
        images.some(img => img.role === 'reference' && img.viewport === batchViewport) &&
        !cited.some(img => img.role === 'reference' && img.viewport === batchViewport)
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

export async function executeBoundedSiteEvaluation(params: {
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
  inspection?: Awaited<ReturnType<typeof inspectionTools>>;
  codex: ReturnType<typeof codexClient>;
  capture: Awaited<ReturnType<typeof usageCapture>>;
  signal: AbortSignal;
  threshold: number;
  manifest?: RequirementManifest;
  pageAliases?: Readonly<Record<string, string>>;
  sourceBaseUrl?: string;
  validatedEvidence: () => { files: MaterialFile[]; observations: Record<string, { url: string; role: string; viewport: string }> };
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
    inspection,
    codex,
    capture,
    signal,
    threshold,
    manifest,
    pageAliases = {},
    sourceBaseUrl,
    validatedEvidence,
  } = params;

  const criteria = task.rule!.criteria.filter(c => c.scopes.includes('site'));
  const requiredVisualViewports = [...new Set(criteria.flatMap(c => c.viewports))].filter(
    (v): v is 'desktop' | 'mobile' => v === 'desktop' || v === 'mobile',
  );
  const businessCriteria = criteria.filter(c => c.viewports.includes('business'));
  const visualCriteria = criteria.filter(c => c.viewports.some(v => v === 'desktop' || v === 'mobile'));
  const hasReference = Boolean(refOrContent.trim());
  const hasMaterials = Boolean(input.files?.length);
  const canCapture = typeof (browser as { capture?: unknown }).capture === 'function';
  const canInspect = typeof inspection?.readImplementation === 'function';

  const presetOutOfScope = defaultOutOfScope({
    scenario: task.scenario,
    scope: 'site',
    hasReference,
    hasMaterials,
    hasBackendAccess: canInspect,
  });

  const captureGaps: string[] = [];
  const captureNotes: string[] = [];
  const pagePrecheckMap = new Map<string, ViewportVisualPrecheck[]>();
  const implementationEntries: { kind: string; evidence?: string; summary: string; error?: string }[] = [];
  const recordFactsMap = new Map<string, TemplateRecordFacts>();
  let backendPagesPayload: unknown;

  const capturePageSlot = async (pagePath: string, fullUrl: string) => {
    const prechecks: ViewportVisualPrecheck[] = [];
    if (!canCapture) {
      pagePrecheckMap.set(pagePath, prechecks);
      return;
    }

    const maxTotalScreenshots = pagePath === '/' ? 40 : 16;
    const chunkSize = pagePath === '/' ? 16 : INNER_PAGE_MAX_SCREENSHOTS;
    for (const viewport of requiredVisualViewports) {
      signal.throwIfAborted();
      if (!hasCompleteRetainedCapture(browser.artifacts, work, 'target', viewport, fullUrl)) {
        try {
          const captured = await captureFullPageScreenshots({
            browser,
            signal,
            role: 'target',
            viewport,
            url: fullUrl,
            label: `目标站 ${pagePath} (${viewport})`,
            settleTimeoutMs: 2000,
            maxTotalScreenshots,
            chunkSize,
          });
          captureGaps.push(...captured.blockingGaps);
          captureNotes.push(...captured.notes);
        } catch (error) {
          captureGaps.push(
            `目标站 ${pagePath} (${viewport}) 页面采集失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      try {
        const precheck = (await browser.capture({
          action: 'visual_precheck',
          role: 'target',
          viewport,
          url: fullUrl,
          ...(pagePath !== '/' ? { skipMobileMenuProbe: true } : {}),
          ...(directTemplateName ? { templateName: directTemplateName } : {}),
        })) as ViewportVisualPrecheck;
        if (precheck && precheck.snapshot && Array.isArray(precheck.signals)) {
          prechecks.push(precheck);
        }
      } catch {
        // Optional precheck: ignore mock adapters without visual_precheck.
      }

      if (hasReference && (pagePath === '/' || task.scenario !== 'materials')) {
        const refPageUrl = new URL(pagePath, refOrContent).href;
        if (!hasCompleteRetainedCapture(browser.artifacts, work, 'reference', viewport, refPageUrl)) {
          try {
            const capturedRef = await captureFullPageScreenshots({
              browser,
              signal,
              role: 'reference',
              viewport,
              url: refPageUrl,
              label: `参考/源站 ${pagePath} (${viewport})`,
              settleTimeoutMs: 10000,
              maxTotalScreenshots,
              chunkSize,
            });
            captureGaps.push(...capturedRef.blockingGaps);
            captureNotes.push(...capturedRef.notes);
          } catch (error) {
            if (pagePath === '/') {
              captureGaps.push(
                `参考/源站 ${pagePath} (${viewport}) 采集失败：${error instanceof Error ? error.message : String(error)}`,
              );
            } else {
              captureNotes.push(
                `参考/源站 ${pagePath} (${viewport}) 未采集到独立页面（${error instanceof Error ? error.message : String(error)}）`,
              );
            }
          }
        }
      }
    }
    pagePrecheckMap.set(pagePath, prechecks);
  };

  let pagePaths: string[] = [];
  let overflowPages: string[] = [];

  const finishEvidence = store.timing.activity(task.id, 'evidence');
  try {
    const findRetainedImplementation = (kind: string) => {
      for (const file of browser.artifacts) {
        if (file.type !== 'application/json' || !/^implementation-[a-f0-9-]{36}\.json$/.test(file.name)) {
          continue;
        }
        try {
          const bytes = readFileSync(resolve(work, 'evidence', file.name));
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) continue;
          const saved = JSON.parse(bytes.toString()) as {
            binding?: { taskId?: string; siteRevision?: string; inputVersionId?: string; generatedSiteId?: string };
            request?: { kind?: string; page?: number };
            value?: unknown;
          };
          if (
            saved.binding?.taskId === task.id &&
            saved.binding?.siteRevision === (task.siteRevision || '') &&
            saved.binding?.inputVersionId === task.versionId &&
            saved.binding?.generatedSiteId === site.id &&
            saved.request?.kind === kind &&
            (saved.request?.page ?? 1) === 1 &&
            Object.hasOwn(saved, 'value')
          ) {
            return { evidence: file.name, result: saved };
          }
        } catch {
          // Ignore malformed retained files and inspect freshly.
        }
      }
      return undefined;
    };

    if (canInspect && (manifest || businessCriteria.length > 0 || task.scope === 'site')) {
      for (const kind of IMPLEMENTATION_INDEX_KINDS) {
        signal.throwIfAborted();
        try {
          const saved = findRetainedImplementation(kind) || (await inspection!.readImplementation({ kind, page: 1 }));
          if (kind === 'pages') backendPagesPayload = saved.result;
          implementationEntries.push({
            kind,
            evidence: saved.evidence,
            summary: summarizeImplementationValue(saved.result),
          });
        } catch (error) {
          signal.throwIfAborted();
          implementationEntries.push({
            kind,
            summary: '',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (manifest) {
      const manifestPaths = collectManifestTargetPaths(manifest, pageAliases, site.url, sourceBaseUrl);
      pagePaths = requiredVisualViewports.length && !manifestPaths.includes('/') ? ['/', ...manifestPaths] : manifestPaths;
      if (!pagePaths.length) pagePaths = ['/'];
    } else {
      await capturePageSlot('/', new URL('/', site.url).href);
      const homePrecheckLinks = (pagePrecheckMap.get('/') || []).flatMap(p => p.snapshot.internalLinks || []);
      const discovered = discoverBoundedSitePaths({
        baseUrl: site.url,
        backendPagesRaw: backendPagesPayload,
        precheckLinks: homePrecheckLinks,
        maxPages: MAX_BOUNDED_SITE_DISCOVERED_PAGES,
      });
      pagePaths = discovered.paths;
      overflowPages = discovered.overflowPaths;
      if (overflowPages.length > 0) {
        captureGaps.push(
          `发现 ${pagePaths.length + overflowPages.length} 个站内页面，本轮按有界上限核验前 ${pagePaths.length} 个核心页面，其余 ${overflowPages.length} 个页面待补验：${overflowPages.slice(0, 8).join('、')}`,
        );
      }
    }

    for (const pagePath of pagePaths) {
      if (pagePrecheckMap.has(pagePath)) continue;
      await capturePageSlot(pagePath, new URL(pagePath, site.url).href);
    }

    if (manifest && canInspect) {
      for (const item of manifest.items) {
        if (item.kind === 'data' && item.records) {
          signal.throwIfAborted();
          const facts = await templateRecordFacts(item, inspection!.readImplementation, signal);
          recordFactsMap.set(item.id, facts);
        }
      }
    }

    writeFileSync(
      resolve(work, 'precheck-facts.json'),
      JSON.stringify(
        {
          scope: 'site',
          discoveredPages: pagePaths,
          overflowPages,
          pages: pagePaths.map(path => ({
            path,
            prechecks: pagePrecheckMap.get(path) || [],
          })),
          implementationIndex: implementationEntries,
          recordFacts: [...recordFactsMap.values()],
          captureGaps,
          captureNotes,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    finishEvidence();
  }

  const capturedPages: CapturedSitePageImages[] = pagePaths.map(pagePath => {
    const fullTargetUrl = new URL(pagePath, site.url).href;
    const includeReference = hasReference && (pagePath === '/' || task.scenario !== 'materials');
    const fullRefUrl = includeReference ? new URL(pagePath, refOrContent).href : '';
    const maxImgs = pagePath === '/' ? 40 : 16;
    const refCap = pagePath === '/' ? 4 : 3;
    const desktopTarget = requiredVisualViewports.includes('desktop')
      ? collectBatchImages(browser.artifacts, work, 'target', 'desktop', fullTargetUrl, maxImgs)
      : [];
    const desktopRef =
      includeReference && requiredVisualViewports.includes('desktop')
        ? sampleReferenceImages(
            collectBatchImages(browser.artifacts, work, 'reference', 'desktop', fullRefUrl, maxImgs),
            refCap,
          )
        : [];
    const mobileTarget = requiredVisualViewports.includes('mobile')
      ? collectBatchImages(browser.artifacts, work, 'target', 'mobile', fullTargetUrl, maxImgs)
      : [];
    const mobileRef =
      includeReference && requiredVisualViewports.includes('mobile')
        ? sampleReferenceImages(
            collectBatchImages(browser.artifacts, work, 'reference', 'mobile', fullRefUrl, maxImgs),
            refCap,
          )
        : [];

    return {
      path: pagePath,
      url: fullTargetUrl,
      desktopImages: [...desktopTarget, ...desktopRef],
      mobileImages: [...mobileTarget, ...mobileRef],
      prechecks: pagePrecheckMap.get(pagePath) || [],
    };
  });

  const visualBatches = visualCriteria.length
    ? planSiteVisualBatches(capturedPages, requiredVisualViewports, MAX_SITE_BATCH_IMAGES)
    : [];
  const needsBusinessBatch = businessCriteria.length > 0 || Boolean(manifest);
  const allPrechecks = [...pagePrecheckMap.values()].flat();
  const allSignals = allPrechecks.flatMap(p => p.signals);
  const totalBatchImages = visualBatches.reduce((sum, b) => sum + b.images.length, 0);

  store.event(
    task.id,
    `有界全站评测已启动（${visualBatches.length} 个视觉批${visualBatches.length > 1 ? '并行' : ''}${needsBusinessBatch ? ' + 1 个业务/实现批' : ''} / ${pagePaths.length} 页 / ${totalBatchImages} 张实图；程序预检命中 ${allSignals.length} 项信号）`,
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
  const modelName = task.model?.name || 'deepseek-flash-1017';
  const threadOptions = {
    model: modelName,
    workingDirectory: work,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only' as const,
    networkAccessEnabled: false,
    approvalPolicy: 'never' as const,
    webSearchMode: 'disabled' as const,
  };

  type BatchDescriptor =
    | { kind: 'visual'; batch: SiteVisualBatch }
    | { kind: 'business' };

  const descriptors: BatchDescriptor[] = [
    ...visualBatches.map(batch => ({ kind: 'visual' as const, batch })),
    ...(needsBusinessBatch ? [{ kind: 'business' as const }] : []),
  ];

  const visualTurnSchema = createBoundedTurnOutputSchema(allowedRuleIds);
  const businessSchemas = createSiteBusinessOutputSchemas(allowedRuleIds);
  const visualOutputSchema = z.toJSONSchema(visualTurnSchema);
  const businessOnlySchema = z.toJSONSchema(businessSchemas.businessOnly);
  const manifestBusinessSchema = z.toJSONSchema(businessSchemas.manifestBusiness);

  const buildPageScreenshotIndexText = (): string => {
    const lines: string[] = [];
    for (const p of capturedPages) {
      const targetDesktopNames = p.desktopImages.filter(i => i.role === 'target').map(i => i.name);
      const targetMobileNames = p.mobileImages.filter(i => i.role === 'target').map(i => i.name);
      lines.push(
        `- 路径 ${p.path} (${p.url})：desktop=[${targetDesktopNames.join(', ') || '无'}]，mobile=[${targetMobileNames.join(', ') || '无'}]`,
      );
    }
    return lines.join('\n');
  };

  const buildImplementationDigestText = (): string => {
    const lines: string[] = ['【宿主只读后台索引事实（已登记为 implementation-*.json，可直接按文件名引用）】'];
    if (!implementationEntries.length) {
      lines.push('- （未启用或未采集到后台只读索引；如缺少实现证明请如实判为 unverified）');
    } else {
      for (const entry of implementationEntries) {
        if (entry.evidence) {
          lines.push(`- ${entry.kind} [证据: ${entry.evidence}]：${entry.summary}`);
        } else {
          lines.push(`- ${entry.kind} [读取失败]：${entry.error || '未知错误'}`);
        }
      }
    }
    if (recordFactsMap.size) {
      lines.push('', '【宿主程序记录全量对账事实】');
      for (const facts of recordFactsMap.values()) {
        lines.push(
          `- ${facts.id} [state=${facts.state}, expected=${facts.expectedCount}, actual=${facts.actualCount}, evidence=${facts.evidence.join(',') || '无'}]：${facts.reason}`,
        );
      }
    }
    return lines.join('\n');
  };

  type VisualOrBusinessResult =
    | { kind: 'visual'; output: BoundedTurnOutput }
    | { kind: 'business'; output: z.infer<typeof siteBusinessOnlyOutputSchema> & { completeness?: RequirementCheck[] } };

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
  const hashCacheKey = (payload: unknown) =>
    createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  const runCachedBatch = async <T>(
    cacheKey: string,
    batchLabel: string,
    parseAndValidate: (rawText: string) => T,
    runFresh: () => Promise<T>,
  ): Promise<T> => {
    const cachedEntry = batchCache[cacheKey];
    if (cachedEntry !== undefined) {
      try {
        const validated = parseAndValidate(
          typeof cachedEntry === 'string' ? cachedEntry : JSON.stringify(cachedEntry),
        );
        store.event(task.id, `复用已验证批次缓存（${batchLabel}），跳过重复模型请求`);
        return validated;
      } catch {
        delete batchCache[cacheKey];
        writeBatchCacheFile();
      }
    }
    const fresh = await runFresh();
    batchCache[cacheKey] = fresh;
    writeBatchCacheFile();
    return fresh;
  };

  const batchOutputs: VisualOrBusinessResult[] = await runWithConcurrency(
    descriptors,
    MAX_SITE_BATCH_CONCURRENCY,
    async (descriptor): Promise<VisualOrBusinessResult> => {
      if (descriptor.kind === 'visual') {
        const batch = descriptor.batch;
        const siblingViewports = requiredVisualViewports.filter(v => v !== batch.viewport);
        const manifestLines = batch.images.map(img => {
          let pathLabel = '';
          if (img.url) {
            try {
              pathLabel = `, path=${new URL(img.url).pathname}`;
            } catch {
              pathLabel = '';
            }
          }
          return `${img.name} (role=${img.role}, viewport=${img.viewport}${pathLabel}, ${img.width ?? '?'}x${img.height ?? '?'}, action=${img.action}${
            img.probe ? `, probe=${img.probe}` : ''
          }${img.scrollY !== null ? `, scrollY=${img.scrollY}` : ''})`;
        });

        const prompt = buildBoundedCheckerPrompt({
          scenario: task.scenario,
          scope: task.scope,
          siteUrl: site.url,
          description: input.description || task.message || '',
          criteria: visualCriteria,
          presetOutOfScope,
          precheckDigest: formatPrecheckDigest(batch.prechecks),
          imageManifestLines: manifestLines,
          hasReference,
          viewports: [batch.viewport],
          ...(siblingViewports.length ? { siblingViewports } : {}),
          pageScopeNote: `全站分批视觉评测 ${batch.label}，覆盖站内路径：[${batch.paths.join(', ')}]${
            visualBatches.length > 1 ? '（其余路径或另一视口由并行批次独立核验，请仅评价本批页面与视口，严禁把未在本批出现且由他批负责的路径或视口写入 outOfScope/unverified）' : ''
          }`,
          materialNotes,
          extraGuidance: templateResidualGuidance,
          antiPatternRules,
        });

        const parseAndValidate = (rawText: string) => {
          const parsed = visualTurnSchema.parse(JSON.parse(rawText)) as BoundedTurnOutput;
          validateVisualSiteBatchOutput(
            parsed,
            batch.viewport,
            visualCriteria,
            batch.images,
            hasReference,
            canCapture,
          );
          return parsed;
        };

        const visualCacheKey = hashCacheKey({
          v: 1,
          kind: 'visual',
          siteRevision: task.siteRevision || '',
          ruleHash: task.rule?.hash || '',
          checksHash: checksSnapshotMeta.hash,
          viewport: batch.viewport,
          paths: batch.paths,
          images: batch.images.map(i => `${i.name}:${i.sha256}`),
        });

        const output = await runCachedBatch(visualCacheKey, batch.label, parseAndValidate, () =>
          runBoundedBatchWithRecovery({
            codex,
            threadOptions,
            task,
            store,
            capture,
            signal,
            outputSchema: visualOutputSchema,
            prompt,
            images: batch.images,
            batchLabel: batch.label,
            retryEventPrefix: '有界全站批次重试 1/1',
            repairEventPrefix: `有界全站视觉修正 1/1（${batch.label}）`,
            buildRepairPrompt: errMsg =>
              `上一轮输出未通过平台校验：${errMsg}\n请仅修正字段与证据文件名，继续使用简体中文输出完整严格 JSON。${formatRepairEvidenceGuide(batch.images, manifestLines)}`,
            parseAndValidate,
          }),
        );
        return { kind: 'visual', output };
      }

      // Business / SEO / Implementation / Completeness structured batch (text-only over host facts)
      const allValidImplementationFiles = implementationEntries
        .map(e => e.evidence)
        .filter((e): e is string => Boolean(e));
      const allTargetPngNames = capturedPages.flatMap(p =>
        [...p.desktopImages, ...p.mobileImages].filter(i => i.role === 'target').map(i => i.name),
      );
      const validBusinessEvidenceNames = new Set([...allValidImplementationFiles, ...allTargetPngNames]);

      const manifestDigest = manifest
        ? [
            '【冻结交付清单（必须逐项在 completeness 数组中返回全部 id，不得遗漏）】',
            ...manifest.items.map(item => {
              const facts = recordFactsMap.get(item.id);
              const pathsInfo = item.kind === 'template' ? item.samples || item.paths : item.paths;
              return `- id=${item.id} | title=${item.title} | kind=${item.kind} | required=${item.required} | viewports=[${item.viewports.join(',')}] | paths=[${pathsInfo.join(', ')}] | expectedCount=${item.expectedCount ?? 'null'} | expectation=${item.expectation.slice(0, 240)}${
                facts ? ` | 程序对账=${facts.state}(evidence=${facts.evidence.join(',') || '无'})` : ''
              }`;
            }),
            `注意：static page 或 dynamic template 若标记 status="verified"，其 checkedViewports 必须覆盖清单要求的全部视口，sampledPaths 必须覆盖全部规定路径，且 evidence 必须包含每个路径+视口对应的目标站 PNG 文件名；data/template/implementation 若标记 verified，evidence 必须包含上方的 implementation-*.json 文件名。缺少对应截图或后台证据时应如实输出 unverified。`,
          ].join('\n')
        : '';

      const baseBusinessPrompt = [
        buildBoundedCheckerPrompt({
          scenario: task.scenario,
          scope: task.scope,
          siteUrl: site.url,
          description: input.description || task.message || '',
          criteria: businessCriteria,
          presetOutOfScope,
          precheckDigest: formatPrecheckDigest(allPrechecks),
          imageManifestLines: [...allValidImplementationFiles, ...allTargetPngNames],
          hasReference,
          pageScopeNote: `全站业务/SEO/后台实现与完整度专项批次（覆盖路径：${pagePaths.join(', ')}；仅评价 business 指标与交付清单，视觉外观已由并行视觉批独立评分，请勿把视觉批负责的内容写入 outOfScope/unverified）`,
          materialNotes,
          extraGuidance: templateResidualGuidance,
          antiPatternRules,
        }),
        ...(businessCriteria.length === 0
          ? ['', '重要：本批不含 business 评分指标，assessments 请严格返回空数组 []，仅需逐项输出下方 manifest 的 completeness、issues、coverage 与 humanSummary。']
          : []),
        '',
        buildImplementationDigestText(),
        '',
        '【各路径已登记的目标站截图索引（供 completeness.evidence 按路径/视口引用）】',
        buildPageScreenshotIndexText(),
        ...(manifestDigest ? ['', manifestDigest] : []),
      ].join('\n');

      const expectedBusinessIds = businessCriteria.map(c => `${c.id}:business`);
      const schemaToUse = manifest ? manifestBusinessSchema : businessOnlySchema;
      const schemaZod = manifest ? businessSchemas.manifestBusiness : businessSchemas.businessOnly;

      const parseAndValidateBusiness = (rawText: string) => {
        const parsed = schemaZod.parse(JSON.parse(rawText)) as z.infer<typeof siteBusinessOnlyOutputSchema> & { completeness?: RequirementCheck[] };
        const actualIds = parsed.assessments.map(a => `${a.criterionId}:${a.viewport}`);
        if (
          actualIds.length !== expectedBusinessIds.length ||
          new Set(actualIds).size !== actualIds.length ||
          actualIds.some(k => !expectedBusinessIds.includes(k))
        ) {
          throw new Error(`业务批次没有完整对应预期指标（期望 ${expectedBusinessIds.join(', ')}）`);
        }
        for (const a of parsed.assessments) {
          if (a.score === null && a.passed !== null) {
            throw new Error(`未验证业务指标 ${a.criterionId} 的 passed 必须为 null`);
          }
          if (a.score !== null && a.passed === null) {
            throw new Error(`已评分业务指标 ${a.criterionId} 必须提供 passed 布尔值`);
          }
          for (const fileName of a.evidence) {
            if (!validBusinessEvidenceNames.has(fileName)) {
              throw new Error(`业务指标 ${a.criterionId} 引用了未登记的证据文件名：${fileName}`);
            }
          }
          if (a.score !== null && validBusinessEvidenceNames.size > 0 && !a.evidence.length) {
            throw new Error(`已评分业务指标 ${a.criterionId} 必须引用至少一条已登记证据`);
          }
        }
        for (const issue of parsed.issues) {
          if (validBusinessEvidenceNames.size > 0) {
            for (const fileName of issue.evidence) {
              if (!validBusinessEvidenceNames.has(fileName)) {
                throw new Error(`业务问题「${issue.title}」引用了未登记的证据文件名：${fileName}`);
              }
            }
          }
        }
        if (manifest) {
          const withCompleteness = parsed as z.infer<typeof siteBusinessOnlyOutputSchema> & { completeness: RequirementCheck[] };
          const adjustedChecks: RequirementCheck[] = withCompleteness.completeness.map(check => {
            const facts = recordFactsMap.get(check.id);
            if (!facts || facts.state === 'unverified') return check;
            if (facts.state === 'missing') {
              return {
                ...check,
                status: check.status === 'partial' ? 'partial' : 'missing',
                actualCount: facts.actualCount,
                checkedKeys: facts.checkedKeys,
                evidence: [...new Set([...check.evidence, ...facts.evidence])],
                reason: check.reason.startsWith(facts.reason)
                  ? check.reason
                  : `${facts.reason}；${check.reason}`.slice(0, 12000),
              };
            }
            return {
              ...check,
              actualCount: facts.actualCount,
              checkedKeys: facts.checkedKeys,
              evidence: [...new Set([...check.evidence, ...facts.evidence])],
            };
          });
          const trusted = validatedEvidence();
          validateCompleteness(
            adjustedChecks,
            manifest,
            trusted.files,
            trusted.observations,
            site.url,
            pageAliases,
            sourceBaseUrl,
          );
          return { ...parsed, completeness: adjustedChecks };
        }
        return parsed;
      };

      const businessCacheKey = hashCacheKey({
        v: 1,
        kind: 'business',
        siteRevision: task.siteRevision || '',
        ruleHash: task.rule?.hash || '',
        checksHash: checksSnapshotMeta.hash,
        manifestId: manifest?.id || '',
        manifestRevision: manifest?.revision || 0,
        implEvidence: implementationEntries.map(e => `${e.kind}:${e.evidence || e.error || ''}`),
        pagePngs: capturedPages.map(
          p => `${p.path}:${[...p.desktopImages, ...p.mobileImages].map(i => i.sha256).join(',')}`,
        ),
      });

      const output = await runCachedBatch(businessCacheKey, '业务/完整度', parseAndValidateBusiness, () =>
        runBoundedBatchWithRecovery({
          codex,
          threadOptions,
          task,
          store,
          capture,
          signal,
          outputSchema: schemaToUse,
          prompt: baseBusinessPrompt,
          batchLabel: '业务/完整度',
          retryEventPrefix: '有界全站批次重试 1/1',
          repairEventPrefix: '有界全站业务/完整度修正 1/1',
          buildRepairPrompt: errMsg =>
            `上一轮业务/完整度输出未通过宿主严格校验：${errMsg}\n请仅修正字段与证据引用，继续使用简体中文输出完整严格 JSON。可用证据文件名：${[...validBusinessEvidenceNames].join(', ') || '无'}`,
          parseAndValidate: parseAndValidateBusiness,
        }),
      );
      return { kind: 'business', output };
    },
  );

  for (const file of browser.artifacts) {
    const filePath = resolve(work, 'evidence', file.name);
    if (!existsSync(filePath)) throw new Error('证据文件丢失，不能据此评分：' + file.name);
    if (createHash('sha256').update(readFileSync(filePath)).digest('hex') !== file.sha256) {
      throw new Error('证据文件在采集后发生变化，不能据此评分');
    }
  }

  const allTurnOutputs = batchOutputs.map(item => item.output);
  const businessOutput = batchOutputs.find(item => item.kind === 'business')?.output;

  let completenessReport: CompletenessReport | undefined;
  if (manifest && businessOutput?.completeness) {
    const trusted = validatedEvidence();
    completenessReport = validateCompleteness(
      businessOutput.completeness,
      manifest,
      trusted.files,
      trusted.observations,
      site.url,
      pageAliases,
      sourceBaseUrl,
    );
  }

  const allAllowedViewports: ('desktop' | 'mobile' | 'business')[] = [
    ...requiredVisualViewports,
    ...(businessCriteria.length ? (['business'] as const) : []),
  ];
  const aggregatedAssessments = aggregateMultiBatchAssessments(
    allTurnOutputs.flatMap((o): Assessment[] => o.assessments),
    criteria,
    allAllowedViewports,
  );

  const rawIssues = mergeBoundedIssues(allTurnOutputs.map(o => o.issues));
  if (completenessReport && completenessReport.state === 'incomplete') {
    const missingItems = completenessReport.checks.filter(c => ['missing', 'partial'].includes(c.status));
    if (!rawIssues.some(i => i.severity !== 'minor' && i.ruleId === 'R-COVER-04')) {
      const sampleEvidence =
        missingItems.flatMap(c => c.evidence).find(Boolean) ||
        browser.artifacts.find(f => f.type === 'image/png' || f.name.startsWith('implementation-'))?.name;
      if (sampleEvidence) {
        rawIssues.push({
          severity: 'major',
          ruleId: 'R-COVER-04',
          viewport: requiredVisualViewports.length === 1 ? requiredVisualViewports[0] : 'both',
          criterionId: criteria.find(c => c.id === 'completeness')?.id || null,
          title: '全站必交付清单存在缺失或未完成项',
          detail: missingItems
            .slice(0, 4)
            .map(c => `${c.id}(${c.status}): ${c.reason}`)
            .join('；')
            .slice(0, 1800),
          evidence: [sampleEvidence],
        });
      }
    }
  }

  const coveredVisualSet = new Set<'desktop' | 'mobile'>(requiredVisualViewports);
  const mergedCoverage = {
    verified: allTurnOutputs.flatMap(o => o.coverage.verified),
    unverified: [...allTurnOutputs.flatMap(o => o.coverage.unverified), ...captureGaps],
    outOfScope: filterCrossBatchOutOfScopeLeaks(
      allTurnOutputs.flatMap(o => o.coverage.outOfScope),
      coveredVisualSet,
    ),
  };

  const combinedSummary = allTurnOutputs.map(o => o.summary.trim()).filter(Boolean).join('\n\n').slice(0, 20000);
  const mergedHumanInput = mergeBoundedHumanSummary(
    allTurnOutputs.map(o => ({
      verdict: o.humanSummary.verdict,
      headline: o.humanSummary.headline,
      highlights: o.humanSummary.highlights,
      topFixes: o.humanSummary.topFixes,
      ...(o.humanSummary.unverifiedNote ? { unverifiedNote: o.humanSummary.unverifiedNote } : {}),
    })),
    'passed',
  );

  const verdict = applyBoundedVerdictCaps({
    assessments: aggregatedAssessments,
    issues: rawIssues,
    criteria,
    threshold,
    coverage: mergedCoverage,
    presetOutOfScope,
    humanSummary: mergedHumanInput,
    precheckSignals: allSignals,
    antiPatternRules,
  });

  if (completenessReport) {
    if (completenessReport.state === 'incomplete') {
      verdict.quality = 'failed';
    } else if (
      (completenessReport.state === 'unverified' || verdict.coverage.unverified.length > 0) &&
      verdict.quality !== 'failed'
    ) {
      verdict.quality = 'unverified';
      completenessReport.state = 'unverified';
    }
    if (verdict.coverage.unverified.length > 0 && completenessReport.state === 'complete') {
      completenessReport.state = 'unverified';
      if (verdict.quality === 'passed') verdict.quality = 'unverified';
    }
  }

  if (verdict.humanSummary) {
    let nextVerdict = verdict.humanSummary.verdict;
    if (verdict.quality === 'failed' && nextVerdict === 'ready') nextVerdict = 'needs-fixes';
    else if (verdict.quality === 'unverified' && nextVerdict === 'ready') nextVerdict = 'incomplete-check';
    verdict.humanSummary = {
      ...verdict.humanSummary,
      verdict: nextVerdict,
      highlights: filterContradictoryHighlights(
        verdict.humanSummary.highlights,
        verdict.quality,
        nextVerdict,
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
    ...(completenessReport ? { completeness: completenessReport } : {}),
    humanSummary,
  };

  writeFileSync(resolve(work, 'result.json'), JSON.stringify(allTurnOutputs, null, 2), { mode: 0o600 });
  return report;
}
