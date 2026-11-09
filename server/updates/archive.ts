import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { updateProduct, type UpdateManifest } from '../../shared/update.js';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const prefix = 'Kooboo-AI-Automation-Lab/';
const sourceDirs = new Set(['frontend', 'server', 'shared', 'sop', 'engines', 'scripts', 'tests-node', 'tests-python', 'docs', 'examples', 'deploy', 'dist', 'dist-server', '.kooboo-ai']);
const rootFiles = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.server.build.json', 'tsconfig.web.json', 'README.md', 'AGENTS.md', '.gitignore', 'READ_FIRST.md', 'DELIVERY_MANIFEST.json']);
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

/** Deliberately accepts only the small, non-ZIP64 file-only format emitted by our packager. */
export function unpackUpdate(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw new Error('更新包 ZIP 目录缺失');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || count > 30000 || centralOffset + centralSize !== end) throw new Error('更新包 ZIP 格式不受支持');
  const files = new Map<string, Buffer>(), normalized = new Set<string>(); let position = centralOffset, expanded = 0, localEnd = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw new Error('更新包 ZIP 目录损坏');
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), crc = bytes.readUInt32LE(position + 16), compressed = bytes.readUInt32LE(position + 20), size = bytes.readUInt32LE(position + 24);
    const nameSize = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32), mode = bytes.readUInt32LE(position + 38) >>> 16, offset = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameSize + extra + comment;
    if (next > end || flags & ~0x800 || ![0, 8].includes(method) || bytes.readUInt16LE(position + 34) || (mode & 0xf000) && (mode & 0xf000) !== 0x8000) throw new Error('更新包包含不支持的文件类型');
    const rawName = bytes.subarray(position + 46, position + 46 + nameSize), name = rawName.toString('utf8');
    if (!rawName.equals(Buffer.from(name)) || !name.startsWith(prefix)) throw new Error('更新包文件路径不合法');
    const path = name.slice(prefix.length), parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f:*?"<>|]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || (!sourceDirs.has(parts[0]) && !rootFiles.has(path)) || parts.some(part => ['.git', '.data', '.updates', 'node_modules', 'master.key', 'settings.enc', 'kooboo.d.ts'].includes(part) || part.startsWith('.env'))) throw new Error('更新包包含越界路径或个人数据');
    const identity = path.normalize('NFC').toLowerCase();
    if (normalized.has(identity)) throw new Error('更新包包含重复文件路径'); normalized.add(identity);
    expanded += size;
    if (size > 64 * 1024 * 1024 || expanded > 1024 * 1024 * 1024 || offset !== localEnd || offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('更新包体积或文件布局不合法');
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28), dataOffset = offset + 30 + localName + localExtra;
    if (bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt32LE(offset + 14) !== crc || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size || !bytes.subarray(offset + 30, offset + 30 + localName).equals(rawName) || dataOffset + compressed > centralOffset) throw new Error('更新包文件头不一致');
    const packed = bytes.subarray(dataOffset, dataOffset + compressed);
    const content = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
    if (content.length !== size || crc32(content) !== crc) throw new Error('更新包文件校验失败');
    files.set(path, content); localEnd = dataOffset + compressed; position = next;
  }
  if (position !== end || localEnd !== centralOffset) throw new Error('更新包 ZIP 目录长度不一致');
  for (const path of files.keys()) { const parts = path.split('/'); while (parts.length > 1) { parts.pop(); if (files.has(parts.join('/'))) throw new Error('更新包文件和目录冲突'); } }
  return files;
}
export function verifyPayload(files: Map<string, Buffer>, manifest: UpdateManifest) {
  const text = (name: string) => { const bytes = files.get(name); if (!bytes) throw new Error(`更新包缺少 ${name}`); return bytes.toString('utf8'); };
  const delivery = JSON.parse(text('DELIVERY_MANIFEST.json')) as { product: string; version: string; baseCommit: string; sourceState: string; files: Record<string, string> };
  if (delivery.product !== updateProduct || delivery.version !== manifest.version || delivery.baseCommit !== manifest.commit || delivery.sourceState !== 'clean-commit' || !delivery.files || Object.keys(delivery.files).length !== files.size - 1) throw new Error('交付清单与发行版不匹配，或该包属于未提交的测试快照');
  for (const [name, bytes] of files) if (name !== 'DELIVERY_MANIFEST.json' && delivery.files[name] !== sha256(bytes)) throw new Error('更新包逐文件校验失败');
  if (JSON.parse(text('package.json')).version !== manifest.version || JSON.parse(text('package-lock.json')).version !== manifest.version) throw new Error('软件版本与清单不一致');
  const build = JSON.parse(text('dist-server/build-info.json'));
  if (build.product !== updateProduct || build.version !== manifest.version || build.commit !== manifest.commit) throw new Error('构建版本与发布清单不一致');
  if (sha256(text('engines/site-harvest/requirements.lock')) !== manifest.collectionLockSha256) throw new Error('采集依赖清单不一致');
  for (const name of ['dist/index.html', 'dist-server/server/main.js', 'dist-server/server/updates/launcher.js', 'scripts/launch.mjs', 'sop/automation-collection-v1/README.md']) text(name);
}
