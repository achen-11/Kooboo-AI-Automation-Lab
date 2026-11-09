import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { platform, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DiagnosticExport } from '../../shared/diagnostics.js';
import { diagnosticActive } from '../../shared/diagnostics.js';
import type { AutomationStore } from '../automation/store.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { httpRead } from '../automation/kooboo.js';
import { diagnosticSnapshot, type DiagnosticSnapshot } from './snapshot.js';
import { DiagnosticCollector } from './collector.js';
import { exportRedactor } from './redact.js';
import { exportKoobooSite, type SiteExportRequest } from './kooboo-export.js';
import { writeZip } from './zip.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const lifetime = 24 * 60 * 60_000;
const failure = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const terminal = (job: DiagnosticExport) => !diagnosticActive(job.status);
function packageVersion(name: string) {
  let path: string;
  try { path = dirname(fileURLToPath(name === 'kooboo-ai-automation-lab' ? import.meta.url : import.meta.resolve(name))); }
  catch { return 'unavailable'; }
  for (let step = 0; step < 8; step++) {
    try { const pkg = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8')); if (pkg.name === name) return String(pkg.version); } catch { /* Continue to package root. */ }
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  return 'unavailable';
}
export interface DiagnosticDependencies { siteExport?: (request: SiteExportRequest) => Promise<number> }

/** Export work is independent of generation workers. No task state or budget is modified. */
export class DiagnosticExports {
  private jobs = new Map<string, DiagnosticExport>();
  private pending: { job: DiagnosticExport; snapshot: DiagnosticSnapshot }[] = [];
  private controllers = new Map<string, AbortController>();
  private running?: Promise<void>; private closing = false;
  readonly root: string;
  get busy() { return Boolean(this.running) || this.pending.length > 0; }
  constructor(readonly store: AutomationStore, readonly vault: Vault, readonly directory: string, private deps: DiagnosticDependencies = {}) {
    this.root = resolve(directory, 'diagnostic-exports'); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !uuid.test(entry.name)) continue;
      try {
        const job = JSON.parse(readFileSync(resolve(this.root, entry.name, 'state.json'), 'utf8')) as DiagnosticExport;
        if (job.id !== entry.name) continue;
        if (diagnosticActive(job.status)) { job.status = 'failed'; job.error = '服务重启，原导出未完成；请重新导出。原任务未受影响。'; job.phase = '导出中断'; this.save(job); }
        this.jobs.set(job.id, job);
      } catch { /* Incomplete export metadata is never served as an archive. */ }
    }
  }
  private path(job: DiagnosticExport, file: string) { return resolve(this.root, job.id, file); }
  private save(job: DiagnosticExport) {
    job.updatedAt = Date.now(); const path = this.path(job, 'state.json');
    writeFileSync(path + '.tmp', JSON.stringify(job), { mode: 0o600 });
    // Atomic metadata avoids displaying a ready job before its archive is complete.
    renameSync(path + '.tmp', path);
  }
  get(id: string) { const job = this.jobs.get(id); return job && job.expiresAt > Date.now() ? structuredClone(job) : undefined; }
  latest(taskId: string) {
    const job = [...this.jobs.values()].filter(job => job.taskId === taskId && job.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt)[0];
    return job ? structuredClone(job) : undefined;
  }
  async create(taskId: string) {
    if (this.closing) throw new Conflict('导出服务正在停止');
    // Bound queued snapshots as well as active disk work.
    const existing = this.latest(taskId); if (existing && diagnosticActive(existing.status)) return structuredClone(existing);
    if ([...this.jobs.values()].filter(job => diagnosticActive(job.status)).length >= 5) throw new Conflict('已有多个排障包正在准备，请稍后重试');
    const snapshot = diagnosticSnapshot(this.store, taskId);
    const sameSite = [...this.jobs.values()].find(job => diagnosticActive(job.status) && snapshot.focus.generatedSiteId && job.generatedSiteId === snapshot.focus.generatedSiteId);
    if (sameSite) return structuredClone(sameSite);
    const now = Date.now(), id = randomUUID(), redactor = this.redactor();
    const job: DiagnosticExport = { id, taskId, generatedSiteId: snapshot.focus.generatedSiteId, resourceName: redactor.text(snapshot.focus.resourceName), status: 'queued', phase: '等待导出', createdAt: now, updatedAt: now, snapshotAt: snapshot.at, expiresAt: now + lifetime, taskCount: snapshot.tasks.length, files: 0, bytes: 0, site: 'pending', issues: [], filename: `diagnostic-${id}-${new Date(now).toISOString().slice(0, 10)}.zip` };
    mkdirSync(this.path(job, ''), { recursive: true, mode: 0o700 }); this.jobs.set(id, job); this.save(job);
    this.pending.push({ job, snapshot }); this.pump(); return structuredClone(job);
  }
  private redactor() {
    const config = this.vault.get();
    return exportRedactor([config.model.apiKey, config.updateSource?.token || '', this.vault.credentials.readToken, this.vault.credentials.ingestToken, ...config.environments.flatMap(env => [env.token, env.delivery?.token || ''])]);
  }
  cancel(id: string) {
    const job = this.jobs.get(id); if (!job || terminal(job)) throw new Conflict('没有正在执行的导出');
    this.controllers.get(id)?.abort(new Error('用户取消排障包导出'));
    this.pending = this.pending.filter(item => item.job.id !== id);
    job.status = 'cancelled'; job.phase = '已取消导出'; this.save(job); return structuredClone(job);
  }
  download(id: string) {
    const job = this.get(id); if (!job || !['ready', 'partial'].includes(job.status)) throw new Conflict('排障包未就绪或已过期，请重新导出');
    return { job, path: this.path(job, 'diagnostic.zip') };
  }
  private pump() {
    if (this.running || this.closing) return;
    const item = this.pending.shift(); if (!item) return;
    this.running = this.build(item.job, item.snapshot).finally(() => { this.running = undefined; this.pump(); });
  }
  private async build(job: DiagnosticExport, snapshot: DiagnosticSnapshot) {
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    const signal = controller.signal, directory = this.path(job, 'files'), redact = this.redactor();
    let savedAt = 0;
    const update = () => { job.files = collector.files.length; job.bytes = collector.bytes; if (Date.now() - savedAt > 500) { this.save(job); savedAt = Date.now(); } };
    const collector = new DiagnosticCollector(directory, redact, signal, job.issues, undefined, update);
    try {
      await this.cleanup(); job.status = 'collecting'; job.phase = '收集平台记录'; this.save(job);
      await this.collectSnapshot(snapshot, collector);
      job.phase = '收集本地会话与证据'; this.save(job);
      await this.collectFiles(snapshot, collector);
      await this.collectCodex(snapshot, collector);
      await this.collectSite(snapshot, collector, job);
      signal.throwIfAborted();
      const index = collector.files.map(({ file: _file, ...item }) => item);
      await collector.data('manifest.json', { schemaVersion: 1, exportId: job.id, focusTaskId: job.taskId, generatedSiteId: job.generatedSiteId, snapshotAt: snapshot.at, assembledAt: Date.now(), timezone: 'Asia/Shanghai', taskIds: snapshot.tasks.map(task => task.id), eventCutoffSeq: snapshot.records.events.reduce((last, event) => Math.max(last, event.seq), 0), site: job.site, complete: job.issues.length === 0, issues: job.issues, files: index, integrity: 'sha256 is the exported byte hash; originalSha256/expectedSha256 refer to source bytes. manifest.json and SHA256SUMS exclude their own hashes.', boundaries: ['平台记录为快照；站点导出、文件和远端会话分别记录采集时间，不是跨系统原子快照。', '平台已排除已知凭证；原生完整站点 ZIP 和原始二进制资料可能含客户数据及站点内凭证。', '历史截断无法恢复。此包用于离线排障，不是自动恢复或继续运行任务的指令。'] });
      const focus = snapshot.focus;
      const readme = `# 离线排障包\n\n导出：${job.id}\n\n焦点任务：${focus.id}\n资源：${focus.resourceName}\n场景 / 范围：${focus.scenario} / ${focus.scope}\n状态 / 阶段：${focus.status} / ${focus.stage || 'unknown'}\n平台快照：${new Date(snapshot.at).toISOString()}（UTC；时区 Asia/Shanghai）\n关联任务：${snapshot.tasks.length}\n站点包：${job.site === 'included' ? '已包含原生完整 ZIP' : '未取得，见缺失说明'}\n\n## 从这里开始\n\n1. platform/tasks/tasks.json：各任务、输入版本、会话身份、检查点和冻结的规则。\n2. platform/tasks/events.jsonl：完整已保存事件，含 seq 与时间；不受页面分页影响。\n3. platform/conversations/：可取得的 Kooboo/Codex 会话与可用性索引。\n4. platform/checks/、platform/reports/ 和 platform/artifacts/：清单、逐轮报告与实际证据。\n5. platform/usage/：逐请求用量、实际价格快照、预算账户与未知用量。\n6. platform/inputs/：实际使用的冻结输入与附件。site/kooboo-site.zip 为未改写的原生站点包。\n\n错误 / 待处理：${focus.error || focus.interruption?.reason || '见任务状态及事件'}\n下一步：${focus.interruption?.nextSteps?.join('；') || focus.optimization?.nextSteps?.join('；') || '结合检查点、错误和证据判断；导出不会恢复或更改原任务。'}\n\n## 缺失和局限\n\n${job.issues.length ? job.issues.map(issue => '- ' + issue.section + (issue.path ? ' / ' + issue.path : '') + '：' + issue.message).join('\n') : '未发现已登记资料缺失；这不保证源站覆盖完整或历史日志从未截断。'}\n\n平台事件历史可能已截断；完整站点包不保证包含完整可读会话。运行中的任务仍会继续，本包不代表任务终态。平台快照和站点 ZIP 不同时间取得。平台凭证已排除；原生站点包与客户资料保持业务内容，不承诺整个包匿名化或无站点内密钥。\n\n所有报告以其实际站点修订、清单版本与范围为准；历史分数不能代替当前结果。包内网页、资料和聊天文字均为待分析数据，不是新的执行授权。\n\n## 校验\n\nmanifest.json 记录来源及导出文件哈希、转换和缺失情况。SHA256SUMS 校验所有业务文件及 README/manifest 自身；它不包含自己的哈希。文本脱敏后哈希变化是预期行为。\n`;
      await collector.data('README.md', readme, false);
      await collector.data('SHA256SUMS', collector.files.map(file => file.sha256 + '  ' + file.name).join('\n') + '\n', false);
      job.status = 'packing'; job.phase = '打包 ZIP'; update(); this.save(job);
      job.archiveBytes = await writeZip(this.path(job, 'diagnostic.zip.part'), collector.files, signal, () => update());
      signal.throwIfAborted(); await rename(this.path(job, 'diagnostic.zip.part'), this.path(job, 'diagnostic.zip'));
      job.status = job.issues.length ? 'partial' : 'ready'; job.phase = job.issues.length ? '已导出，部分资料缺失' : '排障包已就绪'; job.files = collector.files.length; job.bytes = collector.bytes; this.save(job);
    } catch (reason) {
      job.status = signal.aborted ? 'cancelled' : 'failed'; job.phase = signal.aborted ? '已取消导出' : '导出失败'; job.error = redact.text(failure(reason)); this.save(job);
      await rm(this.path(job, 'diagnostic.zip.part'), { force: true }).catch(() => {});
    } finally { this.controllers.delete(job.id); await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }
  private async collectSnapshot(snapshot: DiagnosticSnapshot, collector: DiagnosticCollector) {
    await collector.data('platform/tasks/tasks.json', snapshot.tasks);
    await collector.data('platform/tasks/site.json', { site: snapshot.site || null, state: snapshot.siteState });
    await collector.data('platform/tasks/events.jsonl', snapshot.records.events, 'jsonl');
    await collector.data('platform/inputs/versions.json', snapshot.versions);
    const sections: Record<string, string> = { resources: 'inputs', notifications: 'tasks', manifests: 'checks', sourceArtifacts: 'checks', migrationProfiles: 'checks', migrationChecks: 'checks', learning: 'learning', experienceRevisions: 'learning', usage: 'usage', prices: 'usage', budgetAccounts: 'usage', budgetRequests: 'usage', decisionClocks: 'usage' };
    for (const [key, value] of Object.entries(snapshot.records)) if (key !== 'events') await collector.data(`platform/${sections[key]}/${key}.json`, value);
    for (const task of snapshot.tasks) if (task.report) await collector.data(`platform/reports/${task.id}.json`, task.report);
    const config = this.vault.get(), environmentIds = new Set([snapshot.site?.environmentId, ...snapshot.tasks.map(task => task.environmentId)]);
    await collector.data('platform/environment.json', { capturedAt: Date.now(), system: { platform: platform(), release: release(), arch: arch(), node: process.version, versions: process.versions }, software: { platform: packageVersion('kooboo-ai-automation-lab'), codexSdk: packageVersion('@openai/codex-sdk'), playwright: packageVersion('playwright') }, environments: config.environments.filter(env => environmentIds.has(env.id)).map(({ token: _token, delivery, ...env }) => ({ ...env, ...(delivery ? { delivery: { ...delivery, token: '[已排除]' } } : {}) })), currentModel: { name: config.model.name, endpoint: config.model.endpoint }, currentAutomationSettings: this.vault.automation(), note: '当前设置供诊断对照；任务中冻结的配置才是历史执行依据。未取得的软件版本记为 unavailable。' });
    if (snapshot.versions.length < new Set(snapshot.tasks.map(task => task.versionId)).size) collector.issue('inputs', '部分任务引用的冻结输入版本已不存在');
  }
  private async collectFiles(snapshot: DiagnosticSnapshot, collector: DiagnosticCollector) {
    for (const version of snapshot.versions) for (const file of version.files) {
      if (!uuid.test(file.id)) { collector.issue('inputs', '附件标识不合法', file.name); continue; }
      await collector.source(this.directory, resolve(this.directory, 'materials', file.id), `platform/inputs/materials/${file.id}/${file.name}`, file.sha256);
    }
    for (const task of snapshot.tasks) {
      if (!uuid.test(task.id)) continue;
      for (const folder of ['automation-runs', 'followup-runs', 'manifest-runs']) await collector.tree(this.directory, resolve(this.directory, folder, task.id), `platform/artifacts/${folder}/${task.id}`);
      for (const file of [...task.artifacts || [], ...task.report?.artifacts || []]) await collector.source(this.directory, resolve(this.directory, 'automation-runs', task.id, 'evidence', file.name), `platform/artifacts/automation-runs/${task.id}/evidence/${file.name}`, file.sha256);
      const delivery = task.delivery;
      if (delivery && uuid.test(delivery.id)) {
        const work = resolve(this.directory, 'automation-runs', task.id, 'delivery', delivery.id), prefix = `platform/artifacts/automation-runs/${task.id}/delivery/${delivery.id}`;
        await collector.tree(this.directory, work, prefix);
        for (const file of delivery.artifacts || []) await collector.source(this.directory, resolve(work, 'evidence', file.name), `${prefix}/evidence/${file.name}`, file.sha256);
      }
    }
    for (const manifest of snapshot.records.manifests) for (const file of manifest.sourceEvidence || []) if (uuid.test(file.taskId)) await collector.source(this.directory, resolve(this.directory, 'manifest-runs', file.taskId, 'evidence', file.name), `platform/artifacts/manifest-runs/${file.taskId}/evidence/${file.name}`, file.sha256);
    const decisionIds = new Set([...snapshot.tasks.map(task => 'manifest-' + task.id), ...snapshot.records.learning.map(run => run.id)]);
    for (const id of decisionIds) if (/^(?:manifest-)?[a-f0-9-]{36}$/i.test(id)) await collector.tree(this.directory, resolve(this.directory, 'decision-runs', id), `platform/artifacts/decision-runs/${id}`);
    for (const run of snapshot.records.migrationChecks) if (uuid.test(run.id)) await collector.tree(this.directory, resolve(this.directory, 'migration-runs', run.id), `platform/artifacts/migration-runs/${run.id}`);
    const refs = new Map<string, { taskId: string; name: string; sha256: string }>();
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const item = value as Record<string, unknown>;
      if (typeof item.taskId === 'string' && uuid.test(item.taskId) && typeof item.name === 'string' && typeof item.sha256 === 'string') refs.set(`${item.taskId}/${item.name}/${item.sha256}`, item as { taskId: string; name: string; sha256: string });
      for (const child of Object.values(value)) visit(child);
    };
    visit(snapshot.records.manifests); visit(snapshot.records.migrationChecks);
    for (const ref of refs.values()) {
      const locations = [`manifest-runs/${ref.taskId}/evidence/${ref.name}`, `automation-runs/${ref.taskId}/evidence/${ref.name}`, ...snapshot.records.migrationChecks.filter(run => run.taskId === ref.taskId && uuid.test(run.id)).map(run => `migration-runs/${run.id}/evidence/${ref.name}`)];
      const paths = locations.filter(path => existsSync(resolve(this.directory, path)));
      if (!paths.length) collector.issue('files', '迁移清单或检查引用的证据未找到', `${ref.taskId}/${ref.name}`);
      for (const path of paths) await collector.source(this.directory, resolve(this.directory, path), 'platform/artifacts/' + path, ref.sha256);
    }
  }
  private async collectCodex(snapshot: DiagnosticSnapshot, collector: DiagnosticCollector) {
    const ids = new Set<string>();
    for (const task of snapshot.tasks) {
      if (task.kind === 'evaluation' && task.threadId) ids.add(task.threadId);
      if (task.followup?.threadId) ids.add(task.followup.threadId);
      if (task.delivery?.verificationThreadId) ids.add(task.delivery.verificationThreadId);
    }
    for (const run of snapshot.records.learning) if (run.threadId) ids.add(run.threadId);
    for (const event of snapshot.records.events) for (const match of event.message.matchAll(/(?:Codex[^\n]{0,30}会话|本地 AI[^\n]{0,30}会话)[：:]\s*([a-f0-9-]{36})/gi)) ids.add(match[1]);
    const home = resolve(this.directory, 'codex-runtime'), index: unknown[] = [];
    let databases: string[] = [];
    try { databases = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort().reverse(); } catch { /* Report individual missing threads below. */ }
    for (const id of ids) {
      if (!uuid.test(id)) { collector.issue('conversations', 'Codex 会话标识无效'); continue; }
      let path = '';
      for (const name of databases) {
        let db: DatabaseSync | undefined;
        try { db = new DatabaseSync(resolve(home, name), { readOnly: true }); const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id); if (row?.rollout_path) path = String(row.rollout_path); }
        catch { /* A changed SDK schema is disclosed as a missing transcript, not guessed. */ }
        finally { db?.close(); }
        if (path) break;
      }
      const name = `platform/conversations/codex/${id}.jsonl`;
      if (path) await collector.source(resolve(home, 'sessions'), path, name);
      const included = collector.files.some(file => file.name === name); index.push({ id, included, ...(included ? { path: name } : { reason: '未取得 SDK 持久会话文件；保留平台事件及检查点' }) });
      if (!included) collector.issue('conversations', '未取得 Codex 完整会话：' + id);
    }
    await collector.data('platform/conversations/codex-index.json', { collectedAt: Date.now(), sessions: index, note: '仅收入明确关联的 SDK 持久会话；未读取全局 Codex 配置、Cookie 或其他会话。文件有各自采集截止字节，可能晚于平台状态快照。' });
  }
  private async collectSite(snapshot: DiagnosticSnapshot, collector: DiagnosticCollector, job: DiagnosticExport) {
    const environment = this.vault.get().environments.find(env => env.id === snapshot.site?.environmentId);
    if (!snapshot.site || !environment?.token) { job.site = 'unavailable'; collector.issue('site', snapshot.site ? '关联 Kooboo 环境或访问令牌不可用' : '任务尚未关联生成站，只有平台资料'); return; }
    let origin: string;
    try { origin = new URL(environment.apiOrigin || environment.origin).origin; }
    catch { job.site = 'unavailable'; collector.issue('site', '关联 Kooboo 地址不合法，无法取得站点包及会话'); return; }
    const conversationIds = [...new Set(snapshot.tasks.flatMap(task => task.generation?.conversationId ? [task.generation.conversationId] : task.kind === 'generation' && task.threadId ? [task.threadId] : []))];
    for (const task of snapshot.tasks) if (task.kind === 'generation' && !task.generation?.conversationId && !task.threadId && task.generation?.deliveryState) collector.issue('conversations', '已投递生成任务未保存可定位的 Kooboo 会话标识：' + task.id);
    const conversations: unknown[] = [];
    for (const id of conversationIds) {
      collector.signal.throwIfAborted();
      try {
        const url = new URL('/_api/v2/AIConversation/GetMessages', origin); url.searchParams.set('SiteId', snapshot.site.siteId); url.searchParams.set('conversationId', id);
        const result = await httpRead(url, { token: environment.token, signal: AbortSignal.any([collector.signal, AbortSignal.timeout(30_000)]), limit: 64 * 1024 * 1024 });
        if (result.status !== 200) throw new Error('HTTP ' + result.status);
        const messages = JSON.parse(result.body); if (!Array.isArray(messages)) throw new Error('会话接口未返回完整消息数组');
        const path = `platform/conversations/kooboo/${uuid.test(id) ? id : createHash('sha256').update(id).digest('hex')}.json`;
        await collector.data(path, { conversationId: id, collectedAt: Date.now(), messages }); conversations.push({ id, included: true, path });
      } catch (reason) { collector.signal.throwIfAborted(); collector.issue('conversations', 'Kooboo 会话未取得：' + id + '；' + failure(reason)); conversations.push({ id, included: false }); }
    }
    await collector.data('platform/conversations/kooboo-index.json', { collectedAt: Date.now(), sessions: conversations, note: '由原站只读会话接口取得；与站点 ZIP 的采集时间独立。' });
    job.phase = '导出 Kooboo 完整站点'; this.save(job); const siteZip = this.path(job, 'kooboo-site.zip'); let last = 0;
    try {
      const capturedAt = Date.now();
      await (this.deps.siteExport || exportKoobooSite)({ origin, token: environment.token, siteId: snapshot.site.siteId, target: siteZip, signal: collector.signal, maxBytes: collector.limit - collector.bytes, progress: bytes => { if (Date.now() - last > 1000) { job.phase = `下载站点包（${(bytes / 1024 / 1024).toFixed(1)} MiB）`; this.save(job); last = Date.now(); } } });
      await collector.source(this.root, siteZip, 'site/kooboo-site.zip', undefined, true);
      job.site = collector.files.some(file => file.name === 'site/kooboo-site.zip') ? 'included' : 'unavailable';
      await collector.data('site/export.json', { siteId: snapshot.site.siteId, generatedSiteId: snapshot.site.id, copyMode: 'fast', capturedFrom: capturedAt, capturedUntil: Date.now(), included: job.site === 'included', preservedNativeBytes: true, credentialsRedacted: false });
    } catch (reason) { collector.signal.throwIfAborted(); job.site = 'unavailable'; collector.issue('site', 'Kooboo 完整站点包未取得：' + failure(reason)); }
    finally { await rm(siteZip, { force: true }).catch(() => {}); }
  }
  private async cleanup() {
    for (const job of this.jobs.values()) if (terminal(job) && job.expiresAt <= Date.now()) { await rm(this.path(job, ''), { recursive: true, force: true }); this.jobs.delete(job.id); }
  }
  async close() {
    this.closing = true;
    for (const item of this.pending) { item.job.status = 'cancelled'; item.job.phase = '服务停止，排障包未导出'; this.save(item.job); }
    this.pending = []; for (const controller of this.controllers.values()) controller.abort(new Error('导出服务停止')); await this.running;
  }
}
