import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, cp, rename, rm, lstat, readdir, statfs, open, readlink, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { compareVersions, type UpdateRelease, type UpdateSource, type UpdateState } from '../../shared/update.js';
import { atomicJson, inside, readJson, rejectSymlinkTreePath, syncDirectory, versionAt } from './files.js';
import { maintenancePath } from './maintenance.js';
import { prepareRelease } from './prepare.js';

interface Journal extends UpdateState {
  previous: string; candidate?: string; data: string; backup?: string; backupReady?: boolean;
  failedData?: string; rollbackData?: string; previousVersion: string;
}
type LaunchMessage = { type?: string; requestId?: string; method?: string; source?: UpdateSource; release?: UpdateRelease; message?: string; version?: string; healthy?: boolean };
const terminal = new Set(['completed', 'failed', 'cancelled', 'idle']);
const installPhases = new Set(['backing-up', 'switching', 'restarting', 'rolling-back']);
const within = (root: string, path: string) => { const value = relative(root, path); return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\')); };

async function sizeOf(path: string, root = path): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    if (relative(root, path).split(/[\\/]/)[0] !== 'collection-runtime') throw new Error('数据目录含符号链接，请先按部署指南备份维护');
    return Buffer.byteLength(await readlink(path));
  }
  if (info.isDirectory()) { let size = 0; for (const name of await readdir(path)) size += await sizeOf(resolve(path, name), root); return size; }
  if (!info.isFile()) throw new Error('数据目录包含无法备份的文件类型');
  return info.size;
}
async function copyPrivate(source: string, target: string) {
  await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false, verbatimSymlinks: true, filter: async path => {
    const info = await lstat(path);
    if (info.isSymbolicLink() && relative(source, path).split(/[\\/]/)[0] !== 'collection-runtime') throw new Error('备份中发现资料符号链接');
    return true;
  } });
  async function flush(path: string) {
    const info = await lstat(path);
    if (info.isDirectory()) { for (const name of await readdir(path)) await flush(resolve(path, name)); syncDirectory(path); }
    else if (info.isFile()) { const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  }
  await flush(target); syncDirectory(dirname(target));
}
function safeError(error: unknown, token = '') {
  let value = error instanceof Error ? error.message : '更新未完成';
  if (token) value = value.replaceAll(token, '[已隐藏]');
  // Network, package and child-process exceptions may include signed URLs or environment details.
  if (/https?:\/\/|Bearer\s|access_token|authorization|api[_-]?key/i.test(value)) return '更新请求未完成，请检查发布源与下载网络后重试';
  return value.slice(0, 500);
}

export class ManagedLauncher {
  private child?: ChildProcess;
  private childExit?: Promise<void>;
  private active: string;
  private journal: Journal | null;
  private preparation?: { controller: AbortController; promise: Promise<void> };
  private applying = false;
  private applyWork?: Promise<void>;
  private shuttingDown = false;
  readonly statePath: string;
  readonly updates: string;
  constructor(readonly root: string, readonly data: string, private readonly entry = 'dist-server/server/main.js', private readonly prepare = prepareRelease) {
    this.updates = resolve(root, '.updates'); this.statePath = resolve(this.updates, 'state.json');
    this.active = readJson<{ path: string }>(resolve(this.updates, 'current.json'))?.path || root;
    if (this.active !== root) inside(resolve(root, 'releases'), this.active);
    rejectSymlinkTreePath(this.active);
    this.journal = readJson<Journal>(this.statePath);
    if (this.journal) this.validateJournal(this.journal);
  }
  private validateJournal(state: Journal) {
    if (!/^[a-f0-9-]{36}$/.test(state.id) || state.data !== this.data || !state.previous || !state.previousVersion) throw new Error('更新事务记录无效，请保留安装目录联系维护者');
    if (!terminal.has(state.phase) && !installPhases.has(state.phase) && !['downloading', 'preparing', 'ready', 'blocked'].includes(state.phase)) throw new Error('未知更新事务阶段，保留数据等待维护');
    compareVersions(state.version, state.previousVersion);
    if ((installPhases.has(state.phase) || state.phase === 'completed') && !state.candidate || state.backupReady && !state.backup) throw new Error('更新事务缺少版本或备份位置');
    if (terminal.has(state.phase) && this.active !== (state.phase === 'completed' ? state.candidate : state.previous)) throw new Error('版本指针与更新记录不一致，请保留安装目录联系维护者');
    for (const path of [state.previous, state.candidate]) if (path && path !== this.root) inside(resolve(this.root, 'releases'), path);
    for (const path of [state.backup]) if (path) inside(this.updates, path);
    for (const path of [state.failedData, state.rollbackData]) if (path && path !== `${this.data}.failed-${state.id}` && path !== `${this.data}.restore-${state.id}`) throw new Error('更新恢复路径不合法');
  }
  private save(patch: Partial<Journal>) {
    if (!this.journal) throw new Error('更新事务不存在');
    this.journal = { ...this.journal, ...patch, updatedAt: Date.now() }; atomicJson(this.statePath, this.journal);
    if (terminal.has(this.journal.phase)) atomicJson(resolve(this.updates, 'history', `${this.journal.id}.json`), this.journal);
  }
  private maintenanceOwned() { return readJson<{ id: string }>(maintenancePath(this.data))?.id === this.journal?.id; }
  private clearMaintenance() {
    if (!this.maintenanceOwned()) throw new Error('维护锁与更新事务不一致，保留维护状态');
    unlinkSync(maintenancePath(this.data));
  }
  async start() {
    await this.waitForBackground();
    if (this.journal && !terminal.has(this.journal.phase)) {
      if (installPhases.has(this.journal.phase)) {
        if (this.journal.backupReady) { await this.restore(); await this.boot(true); this.clearMaintenance(); return; }
        else {
          if (this.maintenanceOwned()) this.clearMaintenance();
          this.save({ phase: 'failed', message: '上次更新在备份完成前中断，保留原版本与原数据' });
        }
      } else {
        if (this.maintenanceOwned()) this.clearMaintenance();
        this.save({ phase: 'failed', message: '上次下载或准备已中断，请重新检查更新' });
      }
    }
    if (this.journal?.phase === 'completed' && this.maintenanceOwned()) this.clearMaintenance();
    if (this.journal?.phase === 'failed' && this.journal.rolledBack && this.maintenanceOwned()) { await this.boot(true); this.clearMaintenance(); return; }
    if (existsSync(maintenancePath(this.data))) throw new Error('存在尚未处理的维护锁，请保留数据并检查更新事务');
    await this.boot(false);
  }
  private async boot(maintenance: boolean) {
    const child = this.child = fork(resolve(this.active, this.entry), [], {
      cwd: this.active, execArgv: [], stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, EVALUATOR_DATA_DIR: this.data, EVALUATOR_INSTALL_ROOT: this.root, EVALUATOR_MANAGED_LAUNCHER: '1' },
    });
    atomicJson(resolve(this.updates, 'process.json'), { pid: child.pid });
    this.childExit = new Promise(resolvePromise => child.once('close', () => resolvePromise()));
    child.on('message', raw => { void this.message(raw as LaunchMessage, child).catch(error => { console.error(safeError(error)); }); });
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error('平台启动结果尚未确认')), 60000);
      const exited = () => finish(new Error('新版本未能启动'));
      const ready = (raw: LaunchMessage) => {
        if (raw?.type !== 'update:booted') return;
        if (raw.version !== versionAt(this.active) || !raw.healthy) finish(new Error('启动检查失败：版本、数据库或后台服务未就绪'));
        else finish();
      };
      const finish = (error?: Error) => { clearTimeout(timer); child.off('message', ready); child.off('exit', exited); child.off('error', exited); error ? reject(error) : resolvePromise(); };
      child.on('message', ready); child.once('exit', exited); child.once('error', exited);
    });
    child.once('close', () => { if (!this.applying && !this.shuttingDown) { console.error('平台已退出，请重新启动查看原因'); process.exitCode = 1; } });
  }
  private reply(child: ChildProcess, id: string, error?: string) { if (child.connected) child.send({ type: 'update:reply', requestId: id, error }); }
  private async message(message: LaunchMessage, child: ChildProcess) {
    if (message?.type !== 'update:request' || !message.requestId || child !== this.child) return;
    try {
      if (message.method === 'prepare') {
        if (this.applying || this.preparation || this.journal && !terminal.has(this.journal.phase)) throw new Error('已有更新正在准备，请查看当前进度');
        if (!message.source || !message.release || compareVersions(message.release.version, versionAt(this.active)) <= 0) throw new Error('没有可安装的新版本');
        const id = randomUUID();
        this.journal = { id, phase: 'downloading', message: '正在检查发行版', version: message.release.version, previous: this.active, previousVersion: versionAt(this.active), data: this.data, updatedAt: Date.now() };
        this.save({});
        const controller = new AbortController(), source = message.source, expected = message.release;
        const promise = this.prepare({ root: this.root, active: this.active, data: this.data, id, source, expected, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1000)]), progress: patch => this.save(patch) })
          .then(({ candidate }) => {
            this.save({ candidate, phase: 'ready', message: '新版本已准备，正在检查是否可以安装' });
            if (this.child?.connected) this.child.send({ type: 'update:prepared' });
          }).catch(error => this.save({ phase: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '已取消更新' : safeError(error, source.token) }))
          .finally(() => { this.preparation = undefined; });
        this.preparation = { controller, promise };
      } else if (message.method === 'cancel') {
        if (this.preparation && this.journal && ['downloading', 'preparing'].includes(this.journal.phase)) this.preparation.controller.abort();
        else if (!this.applying && this.journal && ['ready', 'blocked'].includes(this.journal.phase)) {
          if (this.journal.candidate) await rm(inside(resolve(this.root, 'releases'), this.journal.candidate), { recursive: true, force: true });
          this.save({ phase: 'cancelled', message: '已取消更新' });
        } else throw new Error('当前阶段不能取消');
      } else if (message.method === 'blocked') {
        if (!this.journal || !['ready', 'blocked'].includes(this.journal.phase)) throw new Error('更新包尚未准备');
        this.save({ phase: 'blocked', message: (message.message || '有任务仍在运行，请处理后重试').slice(0, 300) });
      } else if (message.method === 'apply') {
        if (this.applying || !this.journal?.candidate || !['ready', 'blocked'].includes(this.journal.phase) || !this.maintenanceOwned()) throw new Error('更新包或维护锁尚未就绪');
        this.applying = true; this.reply(child, message.requestId);
        this.applyWork = this.apply().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(() => { this.applying = false; });
        return;
      } else throw new Error('不支持的更新操作');
      this.reply(child, message.requestId);
    } catch (error) { this.reply(child, message.requestId, safeError(error)); }
  }
  private async stopChild() {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: 'update:shutdown' });
      else child.kill('SIGTERM');
      const timeout = delay(60000, undefined, { ref: false }).then(() => { throw new Error('服务尚未完全退出，保留维护状态，未进行数据恢复'); });
      await Promise.race([this.childExit, timeout]);
    } else await this.childExit;
    this.child = undefined;
    await this.waitForBackground();
  }
  private async waitForBackground() {
    // A crashed API may close its IPC before its background process has finished closing SQLite.
    const end = Date.now() + 30000;
    for (;;) {
      const lock = readJson<{ pid: number }>(resolve(this.data, 'automation-worker.lock'));
      if (!lock) break;
      if (!Number.isInteger(lock.pid) || lock.pid <= 0) throw new Error('后台进程身份未能确认，保持维护状态');
      try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
      if (Date.now() > end) throw new Error('后台服务尚未完全退出，保留维护状态');
      await delay(100);
    }
  }
  private async apply() {
    try {
      const bytes = await sizeOf(this.data), free = await statfs(this.updates), dataFree = await statfs(this.data);
      const sameVolume = (await stat(this.updates)).dev === (await stat(this.data)).dev;
      if (free.bavail * free.bsize < bytes * (sameVolume ? 2 : 1) + 128 * 1024 * 1024 || dataFree.bavail * dataFree.bsize < bytes + 128 * 1024 * 1024) throw new Error('完整备份与恢复所需空间不足');
    } catch (error) {
      this.save({ phase: 'failed', message: `${safeError(error)}；原服务继续运行` }); this.clearMaintenance(); return;
    }
    try {
      const state = this.journal!;
      this.save({ phase: 'backing-up', message: '正在停止服务并备份本地数据' });
      await this.stopChild();
      const backup = resolve(this.updates, 'backups', state.id, 'data');
      await mkdir(resolve(this.updates, 'backups', state.id), { recursive: true, mode: 0o700 });
      this.save({ backup }); await copyPrivate(this.data, backup);
      if (!existsSync(resolve(backup, 'master.key')) || !existsSync(resolve(backup, 'settings.enc'))) throw new Error('数据备份缺少已有配置或主密钥');
      this.save({ backupReady: true, phase: 'switching', message: '正在切换应用版本' });
      atomicJson(resolve(this.updates, 'backups', state.id, 'transaction.json'), this.journal);
      this.active = state.candidate!; atomicJson(resolve(this.updates, 'current.json'), { path: this.active });
      this.save({ phase: 'restarting', message: '正在重启平台并检查新版本' });
      await this.boot(true);
      this.save({ phase: 'completed', message: '更新完成' }); this.clearMaintenance();
    } catch (error) {
      const reason = safeError(error);
      await this.stopChild();
      if (this.journal?.backupReady) {
        await this.restore(); await this.boot(true); this.clearMaintenance();
        this.save({ phase: 'failed', rolledBack: true, message: `${reason}；已恢复原版本与更新前数据` });
      } else {
        this.active = this.journal!.previous;
        if (this.maintenanceOwned()) this.clearMaintenance();
        this.save({ phase: 'failed', message: `${reason}；保留原版本与原数据` });
        await this.boot(false);
      }
    }
  }
  private async restore() {
    const state = this.journal!;
    if (!state.backupReady || !state.backup || !existsSync(resolve(state.backup, 'master.key')) || !existsSync(resolve(state.backup, 'settings.enc'))) throw new Error('缺少完整恢复备份，请保留维护状态联系维护者');
    const failedData = state.failedData || `${this.data}.failed-${state.id}`, rollbackData = state.rollbackData || `${this.data}.restore-${state.id}`;
    this.save({ phase: 'rolling-back', message: '正在恢复原版本和数据', failedData, rollbackData });
    rejectSymlinkTreePath(state.backup); rejectSymlinkTreePath(failedData); rejectSymlinkTreePath(rollbackData);
    // If power was lost after renaming the live directory, finish that exact restore.
    if (!existsSync(failedData)) {
      await rm(rollbackData, { recursive: true, force: true }); await copyPrivate(state.backup, rollbackData);
      if (existsSync(this.data)) { await rename(this.data, failedData); syncDirectory(dirname(this.data)); }
    }
    if (!existsSync(this.data)) {
      if (!existsSync(rollbackData)) await copyPrivate(state.backup, rollbackData);
      await rename(rollbackData, this.data); syncDirectory(dirname(this.data));
    }
    this.active = state.previous; atomicJson(resolve(this.updates, 'current.json'), { path: this.active });
    this.save({ phase: 'failed', rolledBack: true, message: '上次更新已中断，已恢复原版本与更新前数据' });
    // The maintenance marker belongs to the restored snapshot; keep it until old startup is checked.
  }
  async shutdown() {
    if (this.shuttingDown) return; this.shuttingDown = true;
    this.preparation?.controller.abort(); await this.preparation?.promise;
    await this.applyWork;
    await this.stopChild();
  }
}

export async function runLauncher(root: string) {
  root = realpathSync(root);
  const data = resolve(process.env.EVALUATOR_DATA_DIR || resolve(root, '.data'));
  if (within(resolve(root, 'releases'), data) || within(resolve(root, '.updates'), data) || within(data, root)) throw new Error('持久数据目录不能包含安装目录或位于更新目录内');
  rejectSymlinkTreePath(resolve(root, '.updates')); rejectSymlinkTreePath(data);
  mkdirSync(data, { recursive: true, mode: 0o700 }); mkdirSync(resolve(root, '.updates'), { recursive: true, mode: 0o700 });
  const lock = resolve(root, '.updates/launcher.lock');
  if (existsSync(lock)) {
    const old = readJson<{ pid: number }>(lock);
    if (!old || !Number.isInteger(old.pid)) throw new Error('启动器锁损坏，请联系维护者');
    try { process.kill(old.pid, 0); throw new Error('平台已在运行，请使用现有窗口'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const previousChild = readJson<{ pid: number }>(resolve(root, '.updates/process.json'));
    if (previousChild?.pid) { try { process.kill(previousChild.pid, 0); throw new Error('原平台进程仍在退出，请稍后再启动'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const launcher = new ManagedLauncher(root, data);
  const stop = () => { void launcher.shutdown().then(() => { if (existsSync(lock)) unlinkSync(lock); process.exit(0); }).catch(() => { console.error('服务仍在退出，保留启动器锁供下次核对'); process.exitCode = 1; }); };
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, stop);
  try { await launcher.start(); }
  catch (error) { await launcher.shutdown(); if (existsSync(lock)) unlinkSync(lock); throw error; }
  process.once('exit', () => { if (existsSync(lock)) unlinkSync(lock); });
}
