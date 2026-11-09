import { mkdir, readFile, writeFile, statfs, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { UpdateRelease, UpdateSource, UpdateState } from '../../shared/update.js';
import { checkRelease, githubResponse, limitedBytes, type Fetcher } from './source.js';
import { sha256, unpackUpdate, verifyPayload } from './archive.js';
import { inside, rejectSymlinkTreePath, versionAt } from './files.js';

export async function command(executable: string, args: string[], cwd: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolvePromise, reject) => {
    // Arguments are passed directly; never interpolate paths or credentials into a shell command.
    const child = spawn(executable, args, { cwd, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true, env: { ...process.env, EVALUATOR_DATA_DIR: undefined, EVALUATOR_INSTALL_ROOT: undefined } });
    let force: ReturnType<typeof setTimeout> | undefined;
    const terminate = (hard: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* Child group has already exited. */ } }
    };
    const abort = () => { terminate(false); force = setTimeout(() => terminate(true), 10000); force.unref(); };
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => { signal.removeEventListener('abort', abort); clearTimeout(force); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); signal.aborted ? reject(new Error('已取消组件准备')) : code === 0 ? resolvePromise() : reject(new Error('运行组件安装失败，请检查 npm / Chromium 下载网络后重试')); });
  });
}
export async function prepareRelease(options: { root: string; active: string; data: string; id: string; source: UpdateSource; expected: UpdateRelease; signal: AbortSignal; progress: (patch: Partial<UpdateState>) => void }, dependencies: { fetcher?: Fetcher; command?: typeof command; npmCli?: string } = {}) {
  const { root, active, data, id, source, expected, signal, progress } = options;
  const fetcher = dependencies.fetcher || fetch, run = dependencies.command || command;
  const release = await checkRelease(source, versionAt(active), fetcher, signal);
  if (release.id !== expected.id || JSON.stringify(release.manifest) !== JSON.stringify(expected.manifest)) throw new Error('发行版内容已变化，请重新检查更新');
  const manifest = release.manifest;
  if (manifest.minLauncher > 1) throw new Error('此版本需要新版启动器，请使用新的首次安装包');
  if (!manifest.platforms.includes(process.platform) || !manifest.architectures.includes(process.arch)) throw new Error('此版本不支持当前系统或处理器');
  if (Number(process.versions.node.split('.')[0]) < manifest.nodeMajor) throw new Error(`请先安装 Node.js ${manifest.nodeMajor} 或以上版本`);
  const lock = await readFile(resolve(active, 'engines/site-harvest/requirements.lock'));
  if (existsSync(resolve(data, 'collection-runtime')) && sha256(lock) !== manifest.collectionLockSha256) throw new Error('新版需要更新采集 Python 环境，请先按部署指南维护采集环境');
  const free = await statfs(root); if (free.bavail * free.bsize < manifest.archive.size * 4 + 256 * 1024 * 1024) throw new Error('更新目录可用空间不足');
  progress({ phase: 'downloading', message: '正在下载更新包', total: manifest.archive.size, bytes: 0 });
  let last = 0;
  const response = await githubResponse(release.assetUrl, source, signal, true, fetcher);
  const bytes = await limitedBytes(response, manifest.archive.size, signal, count => { if (Date.now() - last > 300) { progress({ bytes: count }); last = Date.now(); } });
  if (bytes.length !== manifest.archive.size || sha256(bytes) !== manifest.archive.sha256) throw new Error('更新包大小或 SHA-256 校验失败');
  progress({ phase: 'preparing', message: '正在校验和解压', bytes: bytes.length });
  const files = unpackUpdate(bytes); verifyPayload(files, manifest);
  const candidate = inside(root, resolve(root, 'releases', `${manifest.version}-${id}`)); rejectSymlinkTreePath(candidate);
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  try {
    for (const [name, content] of files) {
      signal.throwIfAborted(); const path = inside(candidate, resolve(candidate, name));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    }
    progress({ message: '正在安装新版本依赖' });
    const npmCli = resolve(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    // npm_execpath is provided by npm start on all supported platforms; no cmd.exe quoting is needed.
    const npm = dependencies.npmCli || process.env.npm_execpath || npmCli;
    if (!existsSync(npm)) throw new Error('找不到 npm，请通过 npm start 启动平台');
    await run(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], candidate, signal);
    progress({ message: '正在准备 Chromium 浏览器组件' });
    await run(process.execPath, [resolve(candidate, 'node_modules/playwright/cli.js'), 'install', 'chromium'], candidate, signal);
    return { candidate, release };
  } catch (error) { await rm(candidate, { recursive: true, force: true }); throw error; }
}
