import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './store.js';
import { Vault } from './vault.js';
import { Artifacts } from './artifacts.js';
import { hashRule, parseRule } from './rules.js';

export type KoobooSnapshot = {
  schemaVersion: 1;
  tables: Record<string, Record<string, unknown>[]>;
  settings: unknown;
  credentials: { ingestToken: string; readToken: string };
};

const tableNames = ['evaluations', 'runs', 'events', 'reviews', 'rule_versions', 'rule_drafts', 'sites', 'evaluator_artifacts'] as const;
type Row = Record<string, unknown>;

function object(value: unknown, description: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} 必须是对象`);
  return value as Row;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function json(value: unknown, description: string): unknown {
  if (typeof value !== 'string') throw new Error(`${description} 必须是 JSON 字符串`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${description} 的 JSON 无效`); }
}

/** Validate references without rewriting any historical payload or status. */
function verifyData(store: Store, artifacts: Artifacts): void {
  if (store.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('快照包含不存在的任务或执行记录引用');
  const evaluations = store.db.prepare('SELECT id,current_run_id,submission FROM evaluations').all();
  const runs = store.db.prepare('SELECT * FROM runs').all();
  const owners = new Map(runs.map(run => [String(run.id), String(run.evaluation_id)]));
  const evaluationIds = new Set(evaluations.map(evaluation => String(evaluation.id)));
  for (const evaluation of evaluations) {
    json(evaluation.submission, '任务资料');
    if (owners.get(String(evaluation.current_run_id)) !== String(evaluation.id)) throw new Error('任务当前执行记录不属于该任务');
  }

  const hashes = new Map<string, string>();
  const checkRule = (value: unknown, expectedVersion: unknown, expectedHash: unknown): void => {
    const rule = parseRule(value);
    if (rule.version !== expectedVersion || typeof expectedHash !== 'string' || hashRule(value as typeof rule) !== expectedHash) throw new Error('规则内容与版本指纹不匹配');
    const previous = hashes.get(rule.version);
    if (previous && previous !== expectedHash) throw new Error('同一规则版本存在不同的内容指纹');
    hashes.set(rule.version, expectedHash);
  };
  for (const row of store.db.prepare('SELECT * FROM rule_versions').all()) {
    if (typeof row.version !== 'string' || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(row.hash)) throw new Error('规则版本或指纹无效');
    hashes.set(row.version, row.hash);
    if (row.rule_json != null) checkRule(json(row.rule_json, '发布规则'), row.version, row.hash);
  }
  for (const row of store.db.prepare('SELECT rule_json FROM rule_drafts').all()) parseRule(json(row.rule_json, '规则草稿'), false);

  for (const run of runs) {
    const evaluationId = String(run.evaluation_id), runId = String(run.id);
    const sameEvaluation = (source: unknown): string => {
      if (typeof source !== 'string' || owners.get(source) !== evaluationId) throw new Error('证据来源执行记录不属于同一任务');
      return source;
    };
    const checkEvidence = (value: unknown, fallbackRunId: string): void => {
      if (value == null) return;
      const evidence = object(value, '采集证据');
      if (!Array.isArray(evidence.screenshots)) throw new Error('截图清单无效');
      for (const rawShot of evidence.screenshots) {
        const shot = object(rawShot, '截图');
        const source = sameEvaluation(shot.sourceRunId === undefined ? fallbackRunId : shot.sourceRunId);
        if (typeof shot.file !== 'string' || !shot.file || artifacts.get(evaluationId, source, shot.file) === null) throw new Error('截图引用的证据文件不存在');
      }
    };
    if (run.report != null) json(run.report, '评测报告');
    if (run.evidence != null) checkEvidence(json(run.evidence, '采集证据'), runId);
    if (run.snapshot != null) {
      const snapshot = object(json(run.snapshot, '执行配置快照'), '执行配置快照');
      const rule = object(snapshot.rule, '执行规则');
      checkRule(rule, rule.version, snapshot.ruleHash);
    }
    if (run.pipeline != null) {
      const pipeline = object(json(run.pipeline, '阶段检查点'), '阶段检查点');
      if (pipeline.sourceRunId !== undefined) sameEvaluation(pipeline.sourceRunId);
      if (!Array.isArray(pipeline.captures) || !Array.isArray(pipeline.steps)) throw new Error('阶段检查点清单无效');
      for (const rawStep of pipeline.steps) {
        const step = object(rawStep, '执行阶段');
        if (step.sourceRunId !== undefined) sameEvaluation(step.sourceRunId);
      }
      for (const rawCapture of pipeline.captures) {
        const capture = object(rawCapture, '采集检查点');
        const source = capture.sourceRunId === undefined ? runId : sameEvaluation(capture.sourceRunId);
        checkEvidence(capture.evidence, source);
      }
    }
  }
  for (const artifact of store.db.prepare('SELECT evaluation_id,run_id FROM evaluator_artifacts').all()) {
    if (!evaluationIds.has(String(artifact.evaluation_id)) || owners.get(String(artifact.run_id)) !== String(artifact.evaluation_id)) throw new Error('证据文件不属于声明的任务和执行记录');
  }
}

/** Import to an isolated sibling; only expose the directory after every validation succeeds. */
export function importSnapshot(snapshot: KoobooSnapshot, destinationDirectory: string): {
  evaluations: number; runs: number; artifacts: number; rules: number; drafts: number; verified: true;
} {
  const envelope = object(snapshot, '迁移快照');
  if (envelope.schemaVersion !== 1) throw new Error('不支持的迁移快照版本');
  for (const key of Object.keys(envelope)) if (!['schemaVersion', 'tables', 'settings', 'credentials'].includes(key)) throw new Error(`快照包含未知字段：${key}`);
  const tables = object(envelope.tables, '数据表');
  for (const [name, rows] of Object.entries(tables)) {
    if (!(tableNames as readonly string[]).includes(name)) throw new Error(`快照包含未知数据表：${name}`);
    if (!Array.isArray(rows)) throw new Error(`数据表 ${name} 必须是行数组`);
  }
  const destination = resolve(destinationDirectory);
  if (exists(destination)) throw new Error('迁移目标已存在；请指定尚不存在的目录');
  const temporary = mkdtempSync(join(dirname(destination), `.${basename(destination)}-import-`));
  let store: Store | undefined;
  let reservation: { dev: number; ino: number } | undefined;
  try {
    store = new Store(join(temporary, 'database.sqlite'));
    const artifacts = new Artifacts(store.db);
    store.db.transaction(() => {
      for (const table of tableNames) {
        const definitions = store!.db.prepare(`PRAGMA table_info(${table})`).all();
        const columns = new Map(definitions.map(row => [String(row.name), row]));
        for (const rawRow of (tables[table] || []) as unknown[]) {
          const row = object(rawRow, `数据表 ${table} 的行`), names = Object.keys(row);
          if (!names.length) throw new Error(`数据表 ${table} 包含空行`);
          if (definitions.some(column => column.pk && row[String(column.name)] == null)) throw new Error(`数据表 ${table} 缺少原始主键`);
          for (const name of names) {
            if (!columns.has(name)) throw new Error(`数据表 ${table} 包含未知列：${name}`);
            const value = row[name];
            if (!(value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) throw new Error(`数据表 ${table} 的 ${name} 不是有效 SQLite 值`);
            const definition = columns.get(name)!;
            if (value != null && ((definition.type === 'TEXT' && typeof value !== 'string') || (definition.type === 'INTEGER' && (typeof value !== 'number' || !Number.isSafeInteger(value))))) throw new Error(`数据表 ${table} 的 ${name} 类型不匹配`);
          }
          store!.db.prepare(`INSERT INTO ${table} (${names.map(name => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map(name => row[name]));
        }
      }
      verifyData(store!, artifacts);
    });
    const vault = new Vault(temporary);
    vault.importInitial(snapshot.settings, snapshot.credentials);
    const reopened = new Vault(temporary);
    if (!isDeepStrictEqual(reopened.get(), vault.get()) || !isDeepStrictEqual(reopened.credentials, snapshot.credentials)) throw new Error('迁移配置持久化验证失败');
    const counts = {
      evaluations: Number(store.db.prepare('SELECT COUNT(*) AS count FROM evaluations').get().count),
      runs: Number(store.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count),
      artifacts: Number(store.db.prepare('SELECT COUNT(*) AS count FROM evaluator_artifacts').get().count),
      rules: Number(store.db.prepare('SELECT COUNT(*) AS count FROM rule_versions').get().count),
      drafts: Number(store.db.prepare('SELECT COUNT(*) AS count FROM rule_drafts').get().count),
      verified: true as const,
    };
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close(); store = undefined;
    // mkdir is an exclusive reservation, so an existing or concurrently created target is never replaced.
    mkdirSync(destination, { mode: 0o700 });
    reservation = lstatSync(destination);
    renameSync(temporary, destination);
    reservation = undefined;
    return counts;
  } finally {
    try { store?.close(); }
    finally {
      if (reservation) {
        try {
          const stat = lstatSync(destination);
          if (stat.dev === reservation.dev && stat.ino === reservation.ino) rmdirSync(destination);
        } finally { rmSync(temporary, { recursive: true, force: true }); }
      } else {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}
