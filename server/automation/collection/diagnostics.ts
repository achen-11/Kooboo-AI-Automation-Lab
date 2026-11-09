import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import type { CollectionRun } from '../../../shared/collection.js';
import type { CollectionStore } from './store.js';
import { collectionHash, safeCollectionPath } from './runtime.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TIME_MS = 15_000;
const MAX_REDIRECTS = 3;
const SAFE_HEADERS = ['content-type', 'content-length', 'content-encoding', 'location', 'server', 'date', 'etag', 'last-modified', 'cache-control', 'retry-after', 'via', 'x-cache'];
export interface DiagnosticAddress { address: string; family: 4 | 6 }
export type DiagnosticLookup = (hostname: string) => Promise<DiagnosticAddress[]>;
/** Test injection only: production always connects through the pinned Node transport below. */
export type DiagnosticFetch = (url: string, options: {
  method: 'GET'; redirect: 'manual'; credentials: 'omit'; headers: Record<string, string>;
  signal: AbortSignal; addresses: readonly DiagnosticAddress[];
}) => Promise<Response>;
export interface CollectionDiagnosticAttempt {
  index: number; url: string; status: number | null; headers: Record<string, string>; requestHeaders: Record<string, string>;
  addresses: DiagnosticAddress[]; startedAt: string; durationMs: number; bytes: number;
  sha256: string; bodyPath: string; metadataPath: string; truncated: boolean; error?: string;
}
export interface CollectionDiagnosticResult {
  diagnosticId: string; outcome: 'response' | 'failed'; summary: string;
  binding: { collectionId: string; inputVersionId: string; engineVersion: string };
  requestedUrl: string; finalUrl: string; status: number | null; mime: string; contentEncoding: string;
  requestHeaders: Record<string, string>;
  bytes: number; sha256: string; bodyPath: string; metadataPath: string;
  preview: string; truncated: boolean; error?: string; attempts: CollectionDiagnosticAttempt[];
}

const forbiddenV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) forbiddenV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const forbiddenV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) forbiddenV6.addSubnet(address, prefix, 'ipv6');
function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !forbiddenV4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !forbiddenV6.check(address, 'ipv6');
}
function checkedUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('诊断仅允许不带凭据的 HTTP(S) URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || /^(localhost|localhost\.localdomain)$|\.(localhost|local|internal|home|lan)$/.test(hostname)) throw new Error('诊断禁止本地或私有主机');
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('诊断禁止私有或保留 IP 地址');
  return { url, hostname };
}
const defaultLookup: DiagnosticLookup = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })).map(item => ({ address: item.address, family: item.family as 4 | 6 }));

/** DNS is resolved and checked exactly once per hop; sockets cannot resolve the host again. */
const pinnedFetch: DiagnosticFetch = async (value, options) => new Promise((done, reject) => {
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const choices = options.addresses.filter(item => !lookupOptions.family || item.family === lookupOptions.family);
    if (!choices.length) { callback(new Error('已验证地址不支持所需 IP 协议族'), '', 0); return; }
    if (lookupOptions.all) callback(null, [...choices]);
    else callback(null, choices[0].address, choices[0].family);
  };
  const url = new URL(value);
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', headers: options.headers, signal: options.signal, lookup,
    agent: false, maxHeaderSize: 16 * 1024,
  }, incoming => {
    try {
      const headers = new Headers();
      for (const [key, item] of Object.entries(incoming.headers)) if (item !== undefined) headers.set(key, Array.isArray(item) ? item.join(', ') : item);
      const status = incoming.statusCode || 500;
      // WHATWG Response disallows bodies for 204/304 even when a server sends one.
      if ([204, 205, 304].includes(status)) {
        incoming.resume(); done(new Response(null, { status, headers }));
      } else done(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
    } catch (error) { incoming.destroy(); reject(error); }
  });
  request.once('error', reject);
  request.end();
});

function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((done, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(done, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
function errorText(error: unknown) { return error instanceof Error ? error.message.slice(0, 1000) : '诊断请求失败'; }
function textPreview(body: Buffer, mime: string) {
  if (!/^(text\/|application\/(json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-javascript)|image\/svg\+xml)/i.test(mime)) return '';
  // Limit decoding as well as returned characters for a large text response.
  return body.subarray(0, 16_000).toString('utf8').slice(0, 4000);
}

/** Evidence only: never changes collection state, assets, exclusions, or A-stage checks. */
export async function diagnoseCollectionResource(
  collections: CollectionStore, run: CollectionRun, requestedUrl: string,
  options: { signal?: AbortSignal; fetch?: DiagnosticFetch; lookup?: DiagnosticLookup; timeoutMs?: number } = {},
): Promise<CollectionDiagnosticResult> {
  const diagnosticId = randomUUID(), root = collections.workspace(run), folder = `.work/diagnostics/${diagnosticId}`;
  mkdirSync(safeCollectionPath(root, folder), { recursive: true, mode: 0o700 });
  const save = (path: string, value: string | Buffer) => writeFileSync(safeCollectionPath(root, path), value, { mode: 0o600, flag: 'wx' });
  const binding = { collectionId: run.id, inputVersionId: run.inputVersionId, engineVersion: run.engineVersion };
  const metadataPath = `${folder}/metadata.json`, attempts: CollectionDiagnosticAttempt[] = [];
  const startedAt = new Date().toISOString(), started = Date.now(), controller = new AbortController();
  const stop = () => controller.abort(new Error('诊断已取消'));
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timeoutMs = Math.min(MAX_TIME_MS, Math.max(1, options.timeoutMs || MAX_TIME_MS));
  const timer = setTimeout(() => controller.abort(new Error('诊断超过总时限')), timeoutMs);
  let current = requestedUrl, totalBytes = 0, finalBody = Buffer.alloc(0), failure: string | undefined;
  let requestHeaders: Record<string, string> = {};
  try {
    const state = collections.json(run, '.work/state.json') as Record<string, unknown>;
    const records = (key: string) => {
      const values = state[key];
      return (Array.isArray(values) ? values : values && typeof values === 'object' ? Object.values(values) : [])
        .filter((item): item is { url?: string; pageUrl?: unknown } => !!item && typeof item === 'object');
    };
    const asset = [...records('assets'), ...records('files')].find(item => item.url === requestedUrl);
    const known = asset || records('stylesheets').some(item => item.url === requestedUrl);
    if (!known) throw new Error('URL 未在当前采集的样式表、素材或文件清单中登记');
    const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (compatible; CollectionResourceDiagnostic/1.0)', accept: '*/*', 'accept-encoding': 'identity' };
    try {
      const source = checkedUrl(run.sourceUrl);
      source.url.hash = ''; headers.referer = source.url.href;
      if (typeof asset?.pageUrl === 'string') {
        try {
          const page = checkedUrl(asset.pageUrl);
          // Match the engine's canonical_host rule; unrelated hosts never supply a Referer.
          const canonicalHost = (hostname: string) => hostname.replace(/^www\./, '');
          if (canonicalHost(page.hostname) === canonicalHost(source.hostname)) {
            page.url.hash = ''; headers.referer = page.url.href;
          }
        } catch { /* Unsafe recorded page URLs fall back to the validated source. */ }
      }
    } catch { /* Invalid source cannot become an outgoing header. */ }
    for (let index = 0; ; index++) {
      const hopStarted = Date.now(), bodyPath = `${folder}/response-${index}.body`, hopMetadataPath = `${folder}/response-${index}.json`;
      const attempt: CollectionDiagnosticAttempt = { index, url: current, status: null, headers: {}, requestHeaders: {}, addresses: [], startedAt: new Date().toISOString(), durationMs: 0, bytes: 0, sha256: '', bodyPath, metadataPath: hopMetadataPath, truncated: false };
      let body = Buffer.alloc(0), response: Response | undefined;
      try {
        controller.signal.throwIfAborted();
        const checked = checkedUrl(current), family = isIP(checked.hostname);
        const addresses = family ? [{ address: checked.hostname, family: family as 4 | 6 }]
          : await aborted((options.lookup || defaultLookup)(checked.hostname), controller.signal);
        if (!addresses.length || addresses.length > 64 || addresses.some(item => ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !publicAddress(item.address))) throw new Error('DNS 结果包含私有或保留地址，诊断已拒绝连接');
        attempt.addresses = addresses.map(item => ({ ...item }));
        requestHeaders = { ...headers }; attempt.requestHeaders = { ...requestHeaders };
        response = await aborted((options.fetch || pinnedFetch)(checked.url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { ...requestHeaders }, signal: controller.signal, addresses }), controller.signal);
        // The injected transport must respect manual redirects too.
        if (response.redirected || (response.url && response.url !== checked.url.href)) throw new Error('诊断传输意外自动跟随重定向');
        attempt.status = response.status;
        for (const name of SAFE_HEADERS) { const value = response.headers.get(name); if (value !== null) attempt.headers[name] = value.slice(0, 4096); }
        const reader = response.body?.getReader(), chunks: Buffer[] = [];
        if (reader) {
          try {
            while (true) {
              const part = await aborted(reader.read(), controller.signal);
              if (part.done) break;
              const chunk = Buffer.from(part.value), remaining = MAX_BYTES - totalBytes;
              if (chunk.length > remaining) {
                if (remaining) { chunks.push(chunk.subarray(0, remaining)); totalBytes += remaining; }
                attempt.truncated = true;
                throw new Error('诊断响应总量超过 10 MiB');
              }
              chunks.push(chunk); totalBytes += chunk.length;
            }
          } finally {
            body = Buffer.concat(chunks);
            void reader.cancel().catch(() => {});
          }
        }
        const location = response.headers.get('location');
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          if (index >= MAX_REDIRECTS) throw new Error('诊断重定向超过 3 次');
          current = new URL(location, checked.url).href;
          continue;
        }
        break;
      } catch (error) { attempt.error = errorText(error); throw error; }
      finally {
        attempt.durationMs = Date.now() - hopStarted; attempt.bytes = body.length; attempt.sha256 = collectionHash(body);
        save(bodyPath, body);
        save(hopMetadataPath, JSON.stringify({ ...binding, diagnosticId, ...attempt }, null, 2));
        attempts.push(attempt); finalBody = body;
      }
    }
  } catch (error) { failure = errorText(error); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
  const last = attempts.at(-1), mime = last?.headers['content-type'] || '', contentEncoding = last?.headers['content-encoding'] || 'identity';
  const result: CollectionDiagnosticResult = {
    diagnosticId, outcome: failure ? 'failed' : 'response', summary: failure ? `诊断失败：${failure}` : `HTTP ${last?.status}；保存 ${totalBytes} 字节证据`,
    binding, requestedUrl, finalUrl: last?.url || current, status: last?.status ?? null, mime, contentEncoding, requestHeaders,
    bytes: finalBody.length, sha256: collectionHash(finalBody), bodyPath: last?.bodyPath || '', metadataPath,
    preview: contentEncoding.trim().toLowerCase() === 'identity' ? textPreview(finalBody, mime) : '', truncated: attempts.some(item => item.truncated), ...(failure ? { error: failure } : {}), attempts,
  };
  save(metadataPath, JSON.stringify({ ...result, startedAt, durationMs: Date.now() - started, totalBytes }, null, 2));
  return result;
}
