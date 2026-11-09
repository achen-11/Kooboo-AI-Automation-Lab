import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}
export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('更新路径越界');
  return resolve(path);
}
export function rejectSymlinkTreePath(path: string) {
  let at = resolve(path);
  for (;;) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error('更新目录不能经过符号链接');
    const parent = dirname(at); if (parent === at) break; at = parent;
  }
}
export function versionAt(root = process.cwd()): string {
  const build = readJson<{ product: string; version: string }>(resolve(root, 'dist-server/build-info.json'));
  if (build?.product === 'Kooboo AI Automation Lab' && build.version) return build.version;
  const pkg = readJson<{ version: string }>(resolve(root, 'package.json'));
  if (!pkg?.version) throw new Error('缺少应用版本信息');
  return pkg.version;
}
// Freeze the running build identity: editing package.json or rebuilding must not relabel a live process.
export const runningVersion = versionAt();
