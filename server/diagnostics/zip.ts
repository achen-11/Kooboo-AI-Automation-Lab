import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[i] = c >>> 0; }
export function archivePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f:]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('导出文件路径不合法');
  return path;
}
export interface ZipInput { name: string; file: string; sha256: string; size: number }
/** Streaming, stored ZIP64. Nested ZIPs and screenshots are already compressed. */
export async function writeZip(target: string, files: ZipInput[], signal: AbortSignal, progress?: (files: number, bytes: number) => void) {
  const output = await open(target, 'wx', 0o600), central: Buffer[] = [], seen = new Set<string>();
  let offset = 0n;
  const write = async (buffer: Buffer) => {
    signal.throwIfAborted(); let written = 0;
    while (written < buffer.length) { const result = await output.write(buffer, written, buffer.length - written); if (!result.bytesWritten) throw new Error('ZIP 写入失败'); written += result.bytesWritten; }
    offset += BigInt(buffer.length);
  };
  try {
    for (let index = 0; index < files.length; index++) {
      const item = files[index], name = Buffer.from(archivePath(item.name));
      if (seen.has(item.name) || name.length > 65535) throw new Error('ZIP 文件名重复或过长'); seen.add(item.name);
      const start = offset, local = Buffer.alloc(30), extra = Buffer.alloc(20);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(45, 4); local.writeUInt16LE(0x808, 6);
      local.writeUInt16LE(33, 12); local.writeUInt32LE(0xffffffff, 18); local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
      extra.writeUInt16LE(1); extra.writeUInt16LE(16, 2);
      await write(local); await write(name); await write(extra);
      let crc = 0xffffffff, size = 0n; const hash = createHash('sha256');
      for await (const value of createReadStream(item.file, { signal })) {
        const chunk = value as Buffer; hash.update(chunk); size += BigInt(chunk.length);
        for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
        await write(chunk);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      if (size !== BigInt(item.size) || hash.digest('hex') !== item.sha256) throw new Error('打包期间文件发生变化：' + item.name);
      const descriptor = Buffer.alloc(24); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeBigUInt64LE(size, 8); descriptor.writeBigUInt64LE(size, 16); await write(descriptor);
      const header = Buffer.alloc(46), zip64 = Buffer.alloc(28);
      header.writeUInt32LE(0x02014b50); header.writeUInt16LE(45, 4); header.writeUInt16LE(45, 6); header.writeUInt16LE(0x808, 8); header.writeUInt16LE(33, 14); header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(0xffffffff, 20); header.writeUInt32LE(0xffffffff, 24); header.writeUInt16LE(name.length, 28); header.writeUInt16LE(zip64.length, 30); header.writeUInt32LE(0xffffffff, 42);
      zip64.writeUInt16LE(1); zip64.writeUInt16LE(24, 2); zip64.writeBigUInt64LE(size, 4); zip64.writeBigUInt64LE(size, 12); zip64.writeBigUInt64LE(start, 20);
      central.push(header, name, zip64); progress?.(index + 1, Number(offset));
    }
    const centralOffset = offset;
    for (const part of central) await write(part);
    const centralSize = offset - centralOffset, endOffset = offset, end64 = Buffer.alloc(56), locator = Buffer.alloc(20), end = Buffer.alloc(22);
    end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(files.length), 24); end64.writeBigUInt64LE(BigInt(files.length), 32); end64.writeBigUInt64LE(centralSize, 40); end64.writeBigUInt64LE(centralOffset, 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(endOffset, 8); locator.writeUInt32LE(1, 16);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(65535, 8); end.writeUInt16LE(65535, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    await write(end64); await write(locator); await write(end); return Number(offset);
  } finally { await output.close(); }
}
