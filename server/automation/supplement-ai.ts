import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, posix, resolve } from 'node:path';
import { z } from 'zod';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import type {
  SupplementalFileRef,
  SupplementPreviewSummary,
  TaskSupplementBatch,
} from '../../shared/supplement.js';
import type { Vault } from '../lib/vault.js';
import type { codexClient } from './codex-client.js';
import { builtInIntakeSop } from './harness.js';
import { localDecision } from './local-decision.js';
import { readMaterial } from './materials.js';
import type { AutomationStore } from './store.js';
import { applySupplementBatch, saveLocalMaterialFile, type SupplementStore } from './supplement.js';

export interface FetchedPageResult {
  url: string;
  title: string;
  description: string;
  headings: string[];
  navLinks: Array<{ text: string; url: string }>;
  textContent: string;
  screenshotRelPath?: string;
  imageFiles: Array<{ relPath: string; sourceUrl: string; alt: string; mime: string; size: number }>;
  warnings: string[];
}

export interface IntakeDependencies {
  fetchUrl?: (url: string, captureImages: boolean, stagingDir: string, signal: AbortSignal) => Promise<FetchedPageResult>;
  createClient?: typeof codexClient;
  fetcher?: typeof fetch;
}

const activeIntakeControllers = new Map<string, AbortController>();

export function cancelAiSupplementIntake(batchId: string): boolean {
  const controller = activeIntakeControllers.get(batchId);
  if (!controller) return false;
  controller.abort(new Error('用户已取消本次 AI 资料收集'));
  return true;
}

function safeSlug(value: string, fallback = 'page'): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || fallback).slice(0, 48);
}

function resolveSafeStagedRelPath(rawPath: string): string {
  const normalized = posix.normalize(String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`非法文档相对路径：${rawPath}`);
  }
  return normalized;
}

function mimeFromExt(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  return 'text/plain';
}

const EXT_FROM_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
};

async function fetchUrlWithPlaywright(
  rawUrl: string,
  captureImages: boolean,
  stagingDir: string,
  signal: AbortSignal,
): Promise<FetchedPageResult> {
  const parsed = new URL(rawUrl);
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error('仅支持 http 或 https 网址抓取');
  }
  const screenshotsDir = resolve(stagingDir, 'screenshots');
  const assetsDir = resolve(stagingDir, 'assets');
  mkdirSync(screenshotsDir, { recursive: true, mode: 0o700 });
  mkdirSync(assetsDir, { recursive: true, mode: 0o700 });

  const warnings: string[] = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(`本地无头浏览器启动失败：${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    signal.addEventListener('abort', () => { void browser?.close().catch(() => {}); }, { once: true });

    const response = await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const status = response?.status() ?? 0;
    if (status >= 400) warnings.push(`页面响应 HTTP ${status}`);
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch { /* dynamic apps stay busy */ }

    const extracted = await page.evaluate(() => {
      const title = document.title || '';
      const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 30);
      const navLinks = Array.from(document.querySelectorAll('header a[href], nav a[href]'))
        .map(a => ({
          text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
          url: (a as HTMLAnchorElement).href,
        }))
        .filter(item => item.text && /^https?:$/i.test(item.url.split(':')[0] + ':'))
        .slice(0, 20);
      const textContent = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 25000);
      const images = Array.from(document.querySelectorAll('img'))
        .map(img => ({
          src: img.currentSrc || img.getAttribute('src') || '',
          alt: (img.getAttribute('alt') || '').trim(),
          width: img.naturalWidth || img.width || 0,
        }))
        .filter(item => item.src && /^https?:/i.test(item.src) && item.width >= 48)
        .slice(0, 14);
      return { title, desc, headings, navLinks, textContent, images };
    });

    const pageSlug = safeSlug(parsed.pathname === '/' ? 'home' : parsed.pathname, 'page');
    const shotRelPath = `screenshots/${pageSlug}.png`;
    await page.screenshot({ path: resolve(stagingDir, shotRelPath), type: 'png' });

    const imageFiles: FetchedPageResult['imageFiles'] = [];
    if (captureImages) {
      const seenUrl = new Set<string>();
      for (const img of extracted.images) {
        if (imageFiles.length >= 8) break;
        if (seenUrl.has(img.src)) continue;
        seenUrl.add(img.src);
        try {
          signal.throwIfAborted();
          const imgRes = await context.request.get(img.src, { timeout: 15000 });
          if (!imgRes.ok()) continue;
          const mime = String(imgRes.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
          const ext = EXT_FROM_MIME[mime];
          if (!ext) continue;
          const buf = Buffer.from(await imgRes.body());
          if (!buf.length || buf.length > 4 * 1024 * 1024) continue;
          const relPath = `assets/${pageSlug}-img-${imageFiles.length + 1}${ext}`;
          writeFileSync(resolve(stagingDir, relPath), buf, { mode: 0o600 });
          imageFiles.push({ relPath, sourceUrl: img.src, alt: img.alt, mime, size: buf.length });
        } catch { /* skip single failed asset */ }
      }
    }

    return {
      url: page.url(),
      title: extracted.title,
      description: extracted.desc,
      headings: extracted.headings,
      navLinks: extracted.navLinks,
      textContent: extracted.textContent,
      screenshotRelPath: shotRelPath,
      imageFiles,
      warnings,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

const submissionSchema = z
  .object({
    headline: z.string().trim().min(1).max(120),
    collectedFrom: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
    highlights: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
    gaps: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    selectedFiles: z.array(z.string().trim().min(1).max(400)).max(60).default([]),
  })
  .strict();

export async function startAiSupplementIntake(params: {
  task: AutomationTask;
  batch: TaskSupplementBatch;
  store: AutomationStore;
  supplements: SupplementStore;
  vault: Vault;
  directory: string;
  deps?: IntakeDependencies;
}): Promise<TaskSupplementBatch> {
  const { task, batch, store, supplements, vault, directory, deps } = params;
  const controller = new AbortController();
  activeIntakeControllers.set(batch.id, controller);

  const stagingDir = resolve(directory, 'supplement-runs', batch.id);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

  const capturedAssets = new Map<string, { source: SupplementalFileRef['source']; sourceUrl?: string }>();
  const writtenDocs = new Set<string>();
  let fetchCount = 0;

  try {
    const version = store.version(task.versionId);
    const context = {
      taskId: task.id,
      resourceName: task.resourceName,
      scenario: task.scenario,
      interruptionReason: task.interruption?.reason || task.error || '',
      collectSourceUrl: batch.sourceUrl || task.generation?.overrideContentUrl || '',
      originalFailedContentUrl: version?.contentUrl || '',
      targetSiteUrl: task.siteUrl || '',
      referenceUrl: task.generation?.overrideReferenceUrl || version?.referenceUrl || '',
      userNote: batch.note,
      uploadedInputFiles: (batch.inputFiles || []).map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        size: f.size,
      })),
    };

    const summary = await localDecision<SupplementPreviewSummary>({
      task,
      store,
      vault,
      directory,
      id: `intake-${batch.id}`,
      workId: `intake-${batch.id}`,
      stage: 'planning',
      sop: builtInIntakeSop(),
      context,
      policy: { key: `intake:${batch.id}`, runKey: batch.id, maxTokens: 2000000, maxRequests: 25 },
      minutes: 8,
      signal: controller.signal,
      readAliases: ['fetch_url', 'read_input_file', 'write_doc'],
      ...(deps?.createClient ? { createClient: deps.createClient } : {}),
      read: async (raw, sig) => {
        const input = z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('fetch_url'), url: z.string().url(), captureImages: z.boolean().default(true) }).strict(),
            z.object({ kind: z.literal('read_input_file'), fileId: z.string().min(1).max(100) }).strict(),
            z.object({ kind: z.literal('write_doc'), path: z.string().min(1).max(200), content: z.string().min(1).max(120000) }).strict(),
          ])
          .parse(raw);

        if (input.kind === 'fetch_url') {
          if (++fetchCount > 6) throw new Error('单次收集最多抓取 6 个网页，请优先整理已获取内容并提交');
          const result = deps?.fetchUrl
            ? await deps.fetchUrl(input.url, input.captureImages, stagingDir, sig)
            : await fetchUrlWithPlaywright(input.url, input.captureImages, stagingDir, sig);
          if (result.screenshotRelPath) {
            capturedAssets.set(result.screenshotRelPath, { source: 'ai-screenshot', sourceUrl: result.url });
          }
          for (const img of result.imageFiles) {
            capturedAssets.set(img.relPath, { source: 'ai-asset', sourceUrl: img.sourceUrl });
          }
          return result;
        }

        if (input.kind === 'read_input_file') {
          const file = (batch.inputFiles || []).find(f => f.id === input.fileId);
          if (!file) throw new Error('未找到对应的待整理上传文件');
          const bytes = readMaterial(directory, file);
          const isText = /^text\/|json|markdown|xml|html|csv/i.test(file.type) || /\.(md|txt|json|csv|html?|xml)$/i.test(file.name);
          return isText
            ? { id: file.id, name: file.name, type: file.type, text: bytes.toString('utf8').slice(0, 24000) }
            : { id: file.id, name: file.name, type: file.type, size: file.size, note: '二进制或图片文件，可直接纳入资料包' };
        }

        const safeRel = resolveSafeStagedRelPath(input.path);
        const dest = resolve(stagingDir, safeRel);
        mkdirSync(resolve(dest, '..'), { recursive: true, mode: 0o700 });
        writeFileSync(dest, input.content, { encoding: 'utf8', mode: 0o600 });
        writtenDocs.add(safeRel);
        capturedAssets.set(safeRel, { source: 'ai-doc' });
        return { written: safeRel, bytes: Buffer.byteLength(input.content, 'utf8') };
      },
      submit: raw => submissionSchema.parse(raw),
    });

    const chosenRelPaths = summary.selectedFiles.length
      ? summary.selectedFiles
      : [...writtenDocs, ...capturedAssets.keys()];

    const registered: SupplementalFileRef[] = [];
    const seenPaths = new Set<string>();

    for (const relRaw of chosenRelPaths) {
      let safeRel: string;
      try {
        safeRel = resolveSafeStagedRelPath(relRaw);
      } catch {
        continue;
      }
      if (seenPaths.has(safeRel)) continue;
      const fullPath = resolve(stagingDir, safeRel);
      if (!existsSync(fullPath)) continue;
      const bytes = readFileSync(fullPath);
      const mime = mimeFromExt(safeRel);
      const logicalName = safeRel.startsWith('supplement/') ? safeRel : `supplement/${safeRel}`;
      const saved = saveLocalMaterialFile(store, directory, { name: logicalName, type: mime, bytes });
      const meta = capturedAssets.get(safeRel);
      registered.push({
        ...saved,
        source: meta?.source || (mime.startsWith('image/') ? 'ai-asset' : 'ai-doc'),
        ...(meta?.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
      });
      seenPaths.add(safeRel);
    }

    // Preserve user-uploaded raw input files in the supplemental bundle too.
    for (const rawFile of batch.inputFiles || []) {
      const normalized = rawFile.name.toLowerCase();
      if (registered.some(item => item.name.toLowerCase() === normalized)) continue;
      registered.push({ ...rawFile, source: 'manual' });
    }

    batch.files = registered;
    batch.summary = {
      ...summary,
      selectedFiles: registered.map(f => f.name),
    };
    batch.status = 'ready';
    batch.updatedAt = Date.now();
    supplements.put(batch);
    store.event(
      task.id,
      `本地 AI 已整理完成补充资料（${registered.length} 个文件）：${summary.headline}`,
    );

    if (batch.autoApply) {
      const latestTask = store.task(task.id) || task;
      if (latestTask.stopped && ['interrupted', 'pending', 'failed', 'cancelled'].includes(latestTask.status)) {
        await applySupplementBatch({
          batch,
          task: latestTask,
          store,
          supplements,
          vault,
          directory,
          signal: controller.signal,
          fetcher: deps?.fetcher,
        });
      }
    }

    return batch;
  } catch (err) {
    batch.status = controller.signal.aborted ? 'cancelled' : 'failed';
    batch.error = err instanceof Error ? err.message : String(err);
    batch.updatedAt = Date.now();
    supplements.put(batch);
    store.event(
      task.id,
      controller.signal.aborted
        ? '已取消本地 AI 资料收集'
        : `本地 AI 资料收集未完成：${batch.error}`,
    );
    return batch;
  } finally {
    activeIntakeControllers.delete(batch.id);
  }
}
