import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { DiagnosticIssue } from '../../shared/diagnostics.js';
import { archivePath, type ZipInput } from './zip.js';
import type { exportRedactor } from './redact.js';

export interface ExportFile extends ZipInput {
  originalSha256?: string; originalSize?: number; expectedSha256?: string; transformed?: boolean; capturedAt: number;
}
export const inside = (root: string, path: string) => { const name = relative(root, path); return name !== '..' && !name.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(name); };
const textTypes = new Set(['.json', '.jsonl', '.txt', '.md', '.html', '.xml', '.csv', '.log', '.css', '.js', '.svg']);
const maxText = 64 * 1024 * 1024;
export class DiagnosticCollector {
  readonly files: ExportFile[] = []; bytes = 0;
  constructor(readonly directory: string, readonly redact: ReturnType<typeof exportRedactor>, readonly signal: AbortSignal, readonly issues: DiagnosticIssue[], readonly limit = 8 * 1024 ** 3, private progress: () => void = () => {}) {}
  issue(section: string, message: string, path?: string) { this.issues.push({ section, ...(path ? { path } : {}), message: this.redact.text(message) }); }
  private async destination(name: string) {
    this.signal.throwIfAborted(); archivePath(name);
    if (this.files.some(file => file.name === name)) throw new Error('重复的导出文件路径');
    const target = resolve(this.directory, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); return target;
  }
  async data(name: string, input: unknown, json: boolean | 'jsonl' = true) {
    const content = json === 'jsonl' ? (input as unknown[]).map(item => JSON.stringify(this.redact.value(item))).join('\n') + '\n' : json ? this.redact.json(input) : this.redact.text(String(input));
    const bytes = Buffer.from(content);
    if (this.bytes + bytes.length > this.limit) throw new Error('平台记录超过排障包空间限制，未完成导出');
    const target = await this.destination(name); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    this.files.push({ name, file: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), capturedAt: Date.now() }); this.bytes += bytes.length; this.progress();
  }
  /** No symlinks or out-of-root reads, including referenced evidence and SDK rollout paths. */
  async source(root: string, source: string, name: string, expectedSha256?: string, preserve = false) {
    const existing = this.files.find(file => file.name === name);
    if (existing) {
      if (expectedSha256 && existing.expectedSha256 !== expectedSha256) {
        existing.expectedSha256 = expectedSha256;
        if (existing.originalSha256 !== expectedSha256) this.issue('integrity', '来源文件哈希与登记证据不一致；已保留实际字节供排查', name);
      }
      return;
    }
    try {
      archivePath(name); this.signal.throwIfAborted();
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('来源不是普通文件或为符号链接');
      if (!inside(await realpath(root), await realpath(source))) throw new Error('来源超出允许目录');
      if (this.bytes + info.size > this.limit) throw new Error('超过单包 8 GiB 的收集空间限制，该文件未收入');
      // Material storage uses UUID filenames; its logical exported name carries the real extension.
      const target = await this.destination(name), extension = extname(name).toLowerCase();
      let transformed = false, originalHash: string, exportedHash: string, size: number;
      if (extension === '.jsonl' && !preserve) {
        const original = createHash('sha256'), exported = createHash('sha256');
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const input = handle.createReadStream({ ...(info.size ? { end: info.size - 1 } : {}), signal: this.signal });
        const decoder = new StringDecoder('utf8'); let pending = ''; size = 0;
        const line = (value: string) => {
          if (!value.trim()) return Buffer.alloc(0);
          let safe: string;
          try { safe = JSON.stringify(this.redact.value(JSON.parse(value))) + '\n'; }
          catch { this.issue('conversations', '会话中包含不完整 JSON 行，已按文本保留并脱敏', name); safe = this.redact.text(value) + '\n'; }
          const bytes = Buffer.from(safe); exported.update(bytes); size += bytes.length; return bytes;
        };
        const consume = (stream: Transform, final = false) => {
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) { const value = pending.slice(0, end); pending = pending.slice(end + 1); if (Buffer.byteLength(value) > maxText) throw new Error('单条会话记录超过 64 MiB'); stream.push(line(value)); }
          if (Buffer.byteLength(pending) > maxText) throw new Error('单条会话记录超过 64 MiB');
          if (final && pending) stream.push(line(pending));
        };
        const sanitizer = new Transform({
          transform(chunk: Buffer, _encoding, done) { try { original.update(chunk); pending += decoder.write(chunk); consume(this); done(); } catch (error) { done(error as Error); } },
          flush(done) { try { pending += decoder.end(); consume(this, true); done(); } catch (error) { done(error as Error); } },
        });
        await pipeline(input, sanitizer, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: this.signal });
        originalHash = original.digest('hex'); exportedHash = exported.digest('hex'); transformed = true;
      } else if (textTypes.has(extension) && !preserve) {
        if (info.size > maxText) throw new Error('文本超过 64 MiB 的安全处理限制，该文件未收入');
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let bytes: Buffer;
        try { bytes = await handle.readFile(); } finally { await handle.close(); }
        originalHash = createHash('sha256').update(bytes).digest('hex'); let safe: string;
        try { safe = extension === '.json' ? this.redact.json(JSON.parse(bytes.toString('utf8'))) : this.redact.text(bytes.toString('utf8')); }
        catch { safe = this.redact.text(bytes.toString('utf8')); this.issue('files', 'JSON 无法解析，已按文本保留并脱敏', name); }
        const output = Buffer.from(safe); await writeFile(target, output, { flag: 'wx', mode: 0o600 });
        exportedHash = createHash('sha256').update(output).digest('hex'); size = output.length; transformed = originalHash !== exportedHash;
      } else {
        const hash = createHash('sha256'); size = 0;
        const meter = new Transform({ transform(chunk: Buffer, _encoding, done) { size += chunk.length; hash.update(chunk); done(null, chunk); } });
        const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        await pipeline(handle.createReadStream({ ...(info.size ? { end: info.size - 1 } : {}), signal: this.signal }), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: this.signal });
        originalHash = exportedHash = hash.digest('hex');
      }
      const after = await stat(source);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) this.issue('snapshot', '文件在收集期间发生变化；此文件不是原子快照', name);
      if (expectedSha256 && expectedSha256 !== originalHash) this.issue('integrity', '来源文件哈希与登记证据不一致；已保留实际字节供排查', name);
      this.files.push({ name, file: target, size, sha256: exportedHash, originalSha256: originalHash, originalSize: info.size, ...(expectedSha256 ? { expectedSha256 } : {}), transformed, capturedAt: Date.now() });
      this.bytes += size; this.progress();
    } catch (error) {
      this.signal.throwIfAborted(); this.issue('files', error instanceof Error ? error.message : '文件无法读取', name);
    }
  }
  async tree(root: string, source: string, prefix: string) {
    let entries;
    try { entries = await readdir(source, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.issue('files', '目录无法读取', prefix); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      this.signal.throwIfAborted();
      if (entry.name.startsWith('.') || /(?:^|[-_.])(?:vault|credentials|auth|cookies?|master[-_]?key)(?:[-_.]|$)/i.test(entry.name)) continue;
      const path = resolve(source, entry.name), name = prefix + '/' + entry.name;
      if (entry.isSymbolicLink()) { this.issue('files', '已排除符号链接', name); continue; }
      if (entry.isDirectory()) { if (entry.name === 'evidence') await this.tree(root, path, name); }
      else if (entry.isFile() && (textTypes.has(extname(entry.name).toLowerCase()) || /\.(?:png|jpe?g|webp|gif|pdf|zip)$/i.test(entry.name)) && !/^tools\.(?:m?js|ts)$/.test(entry.name)) await this.source(root, path, name);
    }
  }
}
