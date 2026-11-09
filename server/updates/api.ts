import type { FastifyInstance } from 'fastify';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { compareVersions, updateBusy, type UpdateRelease, type UpdateState, type UpdateStatus } from '../../shared/update.js';
import { atomicJson, readJson, runningVersion } from './files.js';
import { checkRelease, sourceSchema, type Fetcher } from './source.js';
import { LauncherBridge, type UpdateTransport } from './bridge.js';
import { inMaintenance, maintenancePath } from './maintenance.js';

export function registerUpdateApi(app: FastifyInstance, options: { directory: string; vault: Vault; active: () => Promise<number>; transport?: UpdateTransport; fetcher?: Fetcher }) {
  const { directory, vault } = options, bridge = options.transport || new LauncherBridge();
  const cachePath = resolve(directory, 'update-check.json');
  let checking = false, applying = false, inflight = 0;
  const excluded = (url: string) => url.split('?')[0] === '/api/login' || url.startsWith('/api/updates');
  const isWrite = (method: string, url: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method) && url.startsWith('/api/') && !excluded(url);
  const writes = new Set<string>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.url.split('?')[0] !== '/api/login' && inMaintenance(directory)) return reply.code(503).send({ error: '平台正在安装更新，请等待重启完成' });
    if (!isWrite(request.method, request.url)) return;
    if (inMaintenance(directory)) return reply.code(503).send({ error: '平台正在安装更新，请等待重启完成' });
    writes.add(request.id); inflight++;
  });
  app.addHook('onResponse', async request => { if (writes.delete(request.id)) inflight--; });
  function state(): UpdateState | null {
    if (!bridge.root) return null;
    const value = readJson<UpdateState>(resolve(bridge.root, '.updates/state.json'));
    if (!value) return null;
    const { id, phase, message, version, updatedAt, bytes, total, rolledBack } = value;
    return { id, phase, message, version, updatedAt, bytes, total, rolledBack };
  }
  function status(): UpdateStatus {
    const source = vault.updateSource();
    const cache = readJson<{ checkedAt: number; release: UpdateRelease }>(cachePath);
    const release = cache?.release.repository === source.repository ? cache.release : undefined;
    return { currentVersion: runningVersion, managed: Boolean(bridge.root), source: { repository: source.repository, hasToken: !!source.token }, checkedAt: release ? cache?.checkedAt : undefined, release, available: !!release && compareVersions(release.version, runningVersion) > 0, state: state() };
  }
  async function apply() {
    if (applying) throw new Conflict('正在检查安装条件');
    const current = state();
    if (!current || !['ready', 'blocked'].includes(current.phase)) throw new Conflict('更新包尚未准备完成');
    applying = true; let acquired = false, handedOff = false;
    try {
      if (inflight || checking) throw new Conflict('有操作仍在处理中，请稍后重新检查并安装');
      try { writeFileSync(maintenancePath(directory), JSON.stringify({ id: current.id }), { flag: 'wx', mode: 0o600 }); acquired = true; }
      catch { throw new Conflict('平台正在维护，请查看当前更新进度'); }
      // Marker prevents future claims; the IPC barrier observes claims that raced with creating it.
      const active = await options.active();
      if (inflight || active) throw new Conflict(`还有 ${Math.max(active, inflight)} 项任务或操作未停止，请处理后重新检查并安装`);
      await bridge.request('apply'); handedOff = true;
    } catch (error) {
      const text = error instanceof Error ? error.message : '安装条件尚未满足';
      await bridge.request('blocked', { message: text }).catch(() => {});
      throw new Conflict(text);
    } finally {
      // An IPC timeout is ambiguous: leave the marker if launcher already entered installation.
      const phase = state()?.phase;
      if (acquired && !handedOff && ['ready', 'blocked'].includes(phase || '') && readJson<{ id: string }>(maintenancePath(directory))?.id === current.id) unlinkSync(maintenancePath(directory));
      applying = false;
    }
  }
  bridge.prepared(() => { void apply().catch(() => {}); });
  app.get('/api/updates', async () => status());
  app.put('/api/updates/source', async request => {
    if (checking || updateBusy(state()?.phase) || state()?.phase === 'blocked') throw new Conflict('请先完成或取消当前更新');
    const input = sourceSchema.parse(request.body); vault.setUpdateSource(input); return status();
  });
  app.post('/api/updates/check', async () => {
    if (checking || updateBusy(state()?.phase) || state()?.phase === 'blocked') throw new Conflict('更新检查或安装正在进行');
    checking = true;
    try {
      const release = await checkRelease(vault.updateSource(), runningVersion, options.fetcher);
      atomicJson(cachePath, { checkedAt: Date.now(), release }); return status();
    } catch (error) {
      if (error instanceof Error && !/https?:\/\/|Bearer\s/i.test(error.message)) throw new Conflict(error.message.slice(0, 400));
      throw new Conflict('无法检查 GitHub 更新，请检查网络与发布源');
    } finally { checking = false; }
  });
  app.post('/api/updates/install', async (_request, reply) => {
    const current = status();
    if (!current.managed) throw new Conflict('当前为开发目录或直接启动的服务，请使用带启动器的交付包更新');
    if (!current.available || !current.release) throw new Conflict('请先检查可用更新');
    if (current.state?.phase === 'blocked') { await apply(); return reply.code(202).send(status()); }
    if (updateBusy(current.state?.phase)) throw new Conflict('已有更新正在进行');
    try { await bridge.request('prepare', { source: vault.updateSource(), release: current.release }); }
    catch (error) { throw new Conflict(error instanceof Error ? error.message : '启动更新失败'); }
    return reply.code(202).send(status());
  });
  app.post('/api/updates/cancel', async () => { try { await bridge.request('cancel'); return status(); } catch (error) { throw new Conflict(error instanceof Error ? error.message : '无法取消更新'); } });
  app.addHook('onClose', async () => { bridge.close(); });
  return { status, apply };
}
