/** Read an explicitly exported task and saved artifacts, never the runtime database. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { RequirementManifest } from '../shared/completeness.js';
import type { MigrationArtifact, MigrationRunContext } from '../shared/migration.js';
import { adaptManweiSavedEvidence } from '../server/automation/migration-adapters/manwei-saved.js';
import { reconcileMigration, verifyMigrationArtifacts } from '../server/automation/migration-check.js';

const taskExport = z.object({
  task: z.object({ id: z.string(), versionId: z.string(), siteRevision: z.string(), requirementsId: z.string().optional(),
    report: z.object({ artifacts: z.array(z.object({ name: z.string(), size: z.number(), sha256: z.string(), role: z.string() })) }),
  }), site: z.object({ siteId: z.string() }),
});
function readJson(path: string): unknown {
  const bytes = readFileSync(path, 'utf8');
  try { return JSON.parse(bytes); } catch { throw new Error('保存证据 JSON 无法解析，请检查指定任务或证据文件。'); }
}
export function auditManweiSavedMigration(directory: string, taskPath: string) {
  const saved = taskExport.parse(readJson(taskPath)), task = saved.task;
  const context: MigrationRunContext = { id: 'offline-' + task.id, taskId: task.id, inputVersionId: task.versionId, siteId: saved.site.siteId, siteRevision: task.siteRevision, round: 0, checkedAt: Date.now() };
  const values = new Map<string, unknown>(), bytes = new Map<string, Buffer>(), artifacts: MigrationArtifact[] = [];
  for (const file of task.report.artifacts) {
    if (!/^(?:source-review|implementation)-[a-f0-9-]+\.json$/.test(file.name)) continue;
    const body = readFileSync(resolve(directory, file.name)); bytes.set(file.name, body);
    let value;
    try { value = JSON.parse(body.toString('utf8')); } catch { throw new Error('保存证据 JSON 无法解析：' + file.name); }
    values.set(file.name, value);
    const implementationKind = value?.request?.kind;
    artifacts.push({ taskId: task.id, name: file.name, sha256: file.sha256, size: file.size,
      layer: file.role === 'content' ? 'source' : ['page', 'view', 'code'].includes(implementationKind) ? 'code-derived' : 'target-data',
      inputVersionId: task.versionId, capturedAt: typeof value.capturedAt === 'number' ? value.capturedAt : null,
      ...(file.role === 'content' ? {} : { siteId: saved.site.siteId, siteRevision: task.siteRevision }),
    });
  }
  const verified = verifyMigrationArtifacts(artifacts, a => bytes.get(a.name)!);
  const { baseline, target } = adaptManweiSavedEvidence(verified.map(artifact => ({ artifact, value: values.get(artifact.name) })), context);
  const manifest: RequirementManifest = { id: task.requirementsId || 'offline-baseline', taskId: task.id, revision: 1, createdAt: context.checkedAt, sourceComplete: false,
    limitations: ['离线提取的已知集合不证明整个源站完整。'], items: [], evidence: [], actor: 'human', migration: baseline };
  const result = reconcileMigration(manifest, target, verified, context);
  return { mode: 'offline-saved-evidence', verifiedArtifacts: verified.length, summary: {
    sourceEntities: baseline.entities.records.length, sourceCategories: baseline.entities.records.filter(e => e.key.kind === 'category').length,
    sourceDetails: baseline.entities.records.filter(e => e.key.kind === 'detail').length, sourceRelations: baseline.relations.records.length,
    knownSourceCategoryPages: baseline.pages.records.length, sourcePagesWithUnverifiedContent: baseline.pages.records.filter(p => !p.contentComplete).length,
    targetEntities: target.entities.records.length, storedRelations: target.storedRelations.records.length,
    codeDerivedRelations: target.outputRelations.records.length, state: result.state,
    checks: result.checks.map(c => ({ id: c.id, status: c.status, confirmedDifferences: c.differences.filter(d => d.confirmed).length,
      confirmedMissing: c.differences.filter(d => d.confirmed && d.code === 'missing').length,
      diagnosticMissing: c.differences.filter(d => !d.confirmed && d.code === 'missing').length })),
  }, result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [directory, taskPath, output] = process.argv.slice(2);
    if (!directory || !taskPath) throw new Error('用法：npm run audit:migration -- <保存证据目录> <导出的任务 JSON> [私有结果路径]');
    const report = auditManweiSavedMigration(resolve(directory), resolve(taskPath));
    if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(JSON.stringify({ mode: report.mode, verifiedArtifacts: report.verifiedArtifacts, ...report.summary }, null, 2) + '\n');
  } catch (error) {
    // No raw task/configuration or artifact body in CLI failure output.
    process.stderr.write(error instanceof z.ZodError ? '保存证据格式不符合离线契约，请检查必需字段。\n' : (error as Error).message + '\n');
    process.exitCode = 1;
  }
}
