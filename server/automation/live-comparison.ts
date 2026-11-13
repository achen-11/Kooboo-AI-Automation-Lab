import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Conflict } from '../lib/store.js';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import {
  evaluateFrameHeaders,
  resolveComparisonSources,
  type LiveComparisonFallback,
  type LiveComparisonPayload,
  type LiveEmbedCheck,
} from '../../shared/live-comparison.js';
import type { AutomationStore } from './store.js';

export interface HeadResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
}

export type HeaderFetcher = (url: URL, signal: AbortSignal) => Promise<HeadResponse>;

export function readResponseHeaders(url: URL, signal: AbortSignal): Promise<HeadResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(
      url,
      {
        signal,
        headers: {
          Connection: 'close',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      response => {
        settled = true;
        const statusCode = response.statusCode || 0;
        const headers = response.headers;
        response.on('error', () => {});
        response.destroy();
        resolve({ statusCode, headers });
      },
    );
    request.on('error', error => {
      if (!settled) reject(error);
    });
  });
}

const ALLOWED_TTL_MS = 5 * 60 * 1000;
const UNREACHABLE_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 200;
const MAX_REDIRECTS = 5;
const PROBE_TIMEOUT_MS = 4500;

export function createEmbedProber(fetchHeaders: HeaderFetcher = readResponseHeaders) {
  const cache = new Map<string, { expiresAt: number; value: LiveEmbedCheck }>();

  function remember(key: string, value: LiveEmbedCheck) {
    const ttl = value.status === 'unreachable' ? UNREACHABLE_TTL_MS : ALLOWED_TTL_MS;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expiresAt: value.checkedAt + ttl, value });
  }

  return async function probeUrl(
    rawUrl: string,
    parentOrigin: string,
    options: { refresh?: boolean; timeoutMs?: number } = {},
  ): Promise<LiveEmbedCheck> {
    const key = `${parentOrigin}|${rawUrl}`;
    const now = Date.now();
    if (!options.refresh) {
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) return cached.value;
    }

    let current: URL;
    try {
      current = new URL(rawUrl);
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error('Unsupported protocol');
      }
    } catch {
      return {
        url: rawUrl,
        status: 'unreachable',
        embeddable: false,
        reason: '仅支持 HTTP(S) 站点地址。',
        checkedAt: now,
      };
    }

    const signal = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetchHeaders(current, signal);
        const location = typeof response.headers.location === 'string'
          ? response.headers.location
          : Array.isArray(response.headers.location)
            ? response.headers.location[0]
            : undefined;
        if (response.statusCode >= 300 && response.statusCode < 400 && location) {
          if (hop === MAX_REDIRECTS) throw new Error('Too many redirects');
          const next = new URL(location, current);
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw new Error('Unsupported redirect protocol');
          }
          current = next;
          continue;
        }

        const verdict = evaluateFrameHeaders(
          {
            xFrameOptions: response.headers['x-frame-options'],
            contentSecurityPolicy: response.headers['content-security-policy'],
          },
          current.href,
          parentOrigin,
        );
        const checkedAt = Date.now();
        const result: LiveEmbedCheck = {
          url: rawUrl,
          status: verdict.status,
          embeddable: verdict.embeddable,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          finalUrl: current.href,
          checkedAt,
        };
        remember(key, result);
        return result;
      }
    } catch {
      // If the server cannot reach or verify a local/external certificate, let the
      // browser still attempt loading the iframe unless an explicit header blocked it.
      const checkedAt = Date.now();
      const result: LiveEmbedCheck = {
        url: rawUrl,
        status: 'unreachable',
        embeddable: true,
        reason: '服务端未能预检该站点响应头，已在浏览器中直接尝试加载。',
        checkedAt,
      };
      remember(key, result);
      return result;
    }

    const checkedAt = Date.now();
    return { url: rawUrl, status: 'unreachable', embeddable: true, checkedAt };
  };
}

function completedReportArtifacts(task?: AutomationTask): MaterialFile[] | null {
  if (!task || task.kind !== 'evaluation' || task.status !== 'completed' || !task.stopped || !task.report) {
    return null;
  }
  return task.report.artifacts.filter(
    file => file.type === 'image/png' && (!file.role || ['reference', 'content', 'target'].includes(file.role)),
  );
}

export function resolveFallbackScreenshots(
  store: AutomationStore,
  task: AutomationTask,
  reportId?: string,
): LiveComparisonFallback {
  const root = store.root(task) || task;
  const current = store.currentReport(root);

  if (reportId) {
    const selected = store.task(reportId, false);
    const sameSite = Boolean(task.generatedSiteId && selected?.generatedSiteId === task.generatedSiteId);
    const sameWorkflow = store.workflowIds(root).includes(reportId);
    if (!selected || selected.kind !== 'evaluation' || (!sameSite && !sameWorkflow)) {
      throw new Conflict('所选评测报告不属于当前任务或生成站');
    }
    const items = completedReportArtifacts(selected);
    return {
      reportTaskId: items ? selected.id : null,
      historical: Boolean(items) && current?.id !== selected.id,
      items: items || [],
    };
  }

  const currentItems = completedReportArtifacts(current);
  if (current && currentItems) {
    return { reportTaskId: current.id, historical: false, items: currentItems };
  }

  const candidates: (AutomationTask | undefined)[] = [
    task.kind === 'evaluation' ? task : undefined,
    task.evaluationTaskId ? store.task(task.evaluationTaskId, false) : undefined,
  ];

  if (task.generatedSiteId) {
    const latestHeader = store
      .headers(task.generatedSiteId)
      .find(header => header.kind === 'evaluation' && header.status === 'completed' && header.stopped && header.report && header.versionId === task.versionId);
    if (latestHeader) candidates.push(store.task(latestHeader.id, false));
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.versionId !== task.versionId) continue;
    const items = completedReportArtifacts(candidate);
    if (items) {
      return { reportTaskId: candidate.id, historical: current?.id !== candidate.id, items };
    }
  }

  return { reportTaskId: null, historical: false, items: [] };
}

function requestParentOrigin(request: FastifyRequest): string {
  for (const raw of [request.headers.origin, request.headers.referer]) {
    if (typeof raw !== 'string' || !raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // Ignore malformed origin/referer headers and fall back to Host.
    }
  }
  const protoHeader = request.headers['x-forwarded-proto'];
  const hostHeader = request.headers['x-forwarded-host'] || request.headers.host;
  const proto = (typeof protoHeader === 'string' ? protoHeader.split(',')[0].trim() : request.protocol) || 'http';
  const host = (typeof hostHeader === 'string' ? hostHeader.split(',')[0].trim() : '') || '127.0.0.1:4180';
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return 'http://127.0.0.1:4180';
  }
}

export function registerLiveComparisonApi(
  app: FastifyInstance,
  store: AutomationStore,
  options: { fetchHeaders?: HeaderFetcher; timeoutMs?: number } = {},
) {
  const paramsSchema = z.object({ id: z.string().uuid() });
  const querySchema = z.object({
    reportId: z.string().uuid().optional(),
    refresh: z.literal('1').optional(),
  });
  const probeUrl = createEmbedProber(options.fetchHeaders);

  app.get('/api/automation/tasks/:id/live-comparison', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { reportId, refresh } = querySchema.parse(request.query);
    const task = store.task(id, false);
    if (!task) return reply.code(404).send({ error: '任务不存在' });

    const version = store.version(task.versionId);
    const site = task.generatedSiteId ? store.site(task.generatedSiteId) : undefined;
    const referenceUrl = version?.referenceUrl?.trim() || '';
    const contentUrl = version?.contentUrl?.trim() || '';
    const targetUrl = (site?.url || task.siteUrl || '').trim();
    const sources = resolveComparisonSources({
      scenario: task.scenario,
      referenceUrl,
      contentUrl,
    });
    const fallbackScreenshots = resolveFallbackScreenshots(store, task, reportId);
    const parentOrigin = requestParentOrigin(request);

    const uniqueUrls = [...new Set([referenceUrl, contentUrl, targetUrl].filter(Boolean))];
    const checks = await Promise.all(
      uniqueUrls.map(url => probeUrl(url, parentOrigin, { refresh: refresh === '1', timeoutMs: options.timeoutMs })),
    );
    const embedChecks = Object.fromEntries(checks.map(check => [check.url, check]));

    return {
      taskId: task.id,
      resourceName: task.resourceName,
      scenario: task.scenario,
      referenceUrl,
      contentUrl,
      targetUrl,
      sources,
      embedChecks,
      fallbackScreenshots,
    } satisfies LiveComparisonPayload;
  });
}
