import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MigrationArtifact } from '../../shared/migration.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { MigrationVerificationStore, migrationRepairContext, registerMigrationProfile, verifyTaskMigration } from './migration-verification.js';

const params = z.object({ id: z.string().uuid() });
const folderId = z.string().regex(/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9-]{36})$/);
const profileInput = z.object({ sourceTaskId: z.string().uuid(), expectedManifestId: z.string().uuid(), contentFolderId: folderId, relationFolderId: folderId }).strict();

export function registerMigrationApi(app: FastifyInstance, store: AutomationStore, vault: Vault, directory: string, owns: (id: string) => boolean) {
  const registry = new MigrationVerificationStore(store), checking = new Set<string>();
  const stopped = (id: string) => {
    const task = store.task(id); if (!task) throw new Conflict('任务不存在');
    const root = store.root(task)!;
    if (!root.stopped || owns(root.id) || checking.has(root.id) || store.migrationReadReserved(root) || store.domainReserved(root.generatedSiteId) || store.tasks().some(t => t.generatedSiteId === root.generatedSiteId && (!t.stopped || t.status === 'queued' || t.status === 'following-up' || owns(t.id) || t.delivery?.stopped === false))) throw new Conflict('等待原站全部执行停止后再登记或检查');
    return root;
  };
  app.post('/api/automation/tasks/:id/migration/profile', async req => {
    const { id } = params.parse(req.params), root = stopped(id);
    return registerMigrationProfile(root, store, directory, profileInput.parse(req.body));
  });
  app.get('/api/automation/tasks/:id/migration', async (req, reply) => {
    const { id } = params.parse(req.params), task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    return { profile: registry.profile(task) || null, current: registry.current(task) || null, runs: registry.runs(task) };
  });
  app.get('/api/automation/tasks/:id/migration/repair-context', async (req, reply) => {
    const { id } = params.parse(req.params), task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    return { context: migrationRepairContext(task, store)?.payload || null };
  });
  app.get('/api/automation/tasks/:id/migration/:runId/evidence/:name', async (req, reply) => {
    const { id, runId, name } = params.extend({ runId: z.string().uuid(), name: z.string().regex(/^migration-observation-[a-f0-9-]+\.json$/) }).parse(req.params);
    const task = store.task(id), run = task && registry.runs(task).find(r => r.id === runId);
    if (!run) return reply.code(404).send({ error: '检查运行不存在' });
    const base = resolve(directory, 'migration-runs', run.id), artifacts: MigrationArtifact[] = JSON.parse(readFileSync(resolve(base, 'artifacts.json'), 'utf8'));
    const artifact = artifacts.find(f => f.name === name);
    if (!artifact) return reply.code(404).send({ error: '检查证据不存在' });
    const bytes = readFileSync(resolve(base, 'evidence', name));
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Conflict('检查证据哈希校验失败');
    return reply.type('application/json').send(bytes);
  });
  app.post('/api/automation/tasks/:id/migration/check', async req => {
    z.object({}).strict().parse(req.body || {});
    const { id } = params.parse(req.params), root = stopped(id), source = store.currentReport(root);
    if (!registry.profile(root) || !source) throw new Conflict('先固定程序检查基线，并保留当前修订的独立报告');
    checking.add(root.id);
    store.db.prepare('INSERT INTO auto_migration_read_locks VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET workflow_id=excluded.workflow_id,expires_at=excluded.expires_at').run(root.generatedSiteId,root.id,Date.now()+240000);
    try {
      // This read-only action never resumes optimization, creates a generation task or changes old reports.
      return { run: await verifyTaskMigration(source, store, vault, directory, AbortSignal.timeout(180000)) };
    } finally { checking.delete(root.id); store.db.prepare('DELETE FROM auto_migration_read_locks WHERE site_id=? AND workflow_id=?').run(root.generatedSiteId,root.id); }
  });
}
