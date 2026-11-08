import http from 'node:http';
import https from 'node:https';
import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { httpRead } from '../automation/kooboo.js';

export interface SiteExportRequest {
  origin: string; token: string; siteId: string; target: string; signal: AbortSignal;
  maxBytes: number; progress?: (bytes: number) => void;
}
/** No redirects: an authenticated download must never forward credentials to another host. */
export async function exportKoobooSite(input: SiteExportRequest) {
  const origin = new URL(input.origin); if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Kooboo 导出地址不合法');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)]);
  const generate = new URL('/_api/v2/Site/ExportGenerate', origin.origin);
  generate.searchParams.set('SiteId', input.siteId); generate.searchParams.set('copyMode', 'fast');
  const generated = await httpRead(generate, { token: input.token, signal, limit: 1024 * 1024 });
  if (generated.status !== 200) throw new Error(`Kooboo 原生导出失败（HTTP ${generated.status}）`);
  const filename: unknown = JSON.parse(generated.body);
  if (typeof filename !== 'string' || !/^[\w-]+\.zip$/i.test(filename)) throw new Error('Kooboo 未返回有效的站点 ZIP 文件名');
  const url = new URL('/_api/v2/Site/Export', origin.origin);
  url.searchParams.set('SiteId', input.siteId); url.searchParams.set('copyMode', 'fast'); url.searchParams.set('exportfile', filename);
  const temporary = input.target + '.part'; let size = 0;
  try {
    const response = await new Promise<http.IncomingMessage>((accept, reject) => {
      const req = (url.protocol === 'https:' ? https : http).get(url, { signal, headers: { Authorization: 'Bearer ' + input.token, Connection: 'close' } }, accept);
      req.on('error', reject);
    });
    if (response.statusCode !== 200) { response.resume(); throw new Error(`Kooboo 站点包下载失败（HTTP ${response.statusCode}）`); }
    if (Number(response.headers['content-length'] || 0) > input.maxBytes) { response.destroy(); throw new Error('站点包超过本次排障包剩余空间限制'); }
    const meter = new Transform({ transform(chunk: Buffer, _encoding, next) {
      size += chunk.length;
      if (size > input.maxBytes) return next(new Error('站点包超过本次排障包剩余空间限制'));
      input.progress?.(size); next(null, chunk);
    } });
    await pipeline(response, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    const handle = await open(temporary, 'r');
    try { const head = Buffer.alloc(4); await handle.read(head, 0, 4, 0); if (!['504b0304', '504b0506', '504b0606'].includes(head.toString('hex'))) throw new Error('Kooboo 下载结果不是 ZIP 文件'); }
    finally { await handle.close(); }
    await rename(temporary, input.target); return size;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
