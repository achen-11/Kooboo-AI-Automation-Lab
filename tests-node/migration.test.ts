import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSnapshot, type KoobooSnapshot } from '../server/lib/migration.js';
import { Store } from '../server/lib/store.js';
import { Vault } from '../server/lib/vault.js';
import { Artifacts } from '../server/lib/artifacts.js';
import { listRules } from '../server/lib/rules.js';

function fixture(): KoobooSnapshot {
  const { rule, hash } = listRules()[0];
  const screenshot = { id: 'shot-1', role: 'target', viewport: 'desktop', region: 'top', file: 'target-desktop-top.png', url: 'https://generated.test/', capturedAt: 10, width: 1440, height: 900, sourceRunId: 'run-1' };
  const evidence = { targetUrl: 'https://generated.test/', targetTitle: 'Preserved', text: 'Historical text', readme: null, screenshots: [screenshot], health: 'unknown', issues: [], fingerprint: 'original', stable: false, coverage: { requested: 'homepage', actual: 'homepage', complete: false, note: 'Historical gap' } };
  const report = { fidelityScore: null, completionScore: null, confidence: 'low', summary: '证据不足', dimensions: [], issues: [], health: 'unknown', model: { name: 'old-model', usage: null }, coverage: evidence.coverage, stable: false, referenceStatus: 'unavailable', calibrated: false };
  return {
    schemaVersion: 1,
    settings: { threshold: 80, paused: true, model: { endpoint: 'https://models.test/v1', name: 'configurable-model', apiKey: 'private-model-key' }, environments: [{ id: '5110315a-57b4-4b36-98c6-79fbb276499a', name: 'Imported', origin: 'https://kooboo.test', apiOrigin: 'https://api.kooboo.test', token: 'private-environment-token' }] },
    credentials: { ingestToken: 'i'.repeat(64), readToken: 'r'.repeat(64) },
    tables: {
      evaluations: [{ id: 'evaluation-1', project_id: 'project-1', attempt_id: 'attempt-1', job_id: 'job-1', occurred_at: 1, created_at: 2, submission: JSON.stringify({ schemaVersion: 1, attemptId: 'attempt-1', jobId: 'job-1', inputs: { referenceUrl: 'https://original.test/' } }), target_url: 'https://generated.test/', site_domain: 'generated.test', payload_hash: 'original-hash', current_run_id: 'run-2' }],
      runs: [
        { id: 'run-1', evaluation_id: 'evaluation-1', status: 'failed', created_at: 3, updated_at: 4, error: 'Reference timeout', report: null, evidence: JSON.stringify(evidence), snapshot: JSON.stringify({ rule, ruleHash: hash, model: { endpoint: 'https://old-model.test/v1', name: 'old-model' } }), lease_owner: null, lease_until: null, claims: 2, pipeline: null },
        { id: 'run-2', evaluation_id: 'evaluation-1', status: 'completed', created_at: 5, updated_at: 6, error: null, report: JSON.stringify(report), evidence: JSON.stringify(evidence), snapshot: null, lease_owner: null, lease_until: null, claims: 1, pipeline: JSON.stringify({ version: 1, retryMode: 'reference', sourceRunId: 'run-1', steps: [{ id: 'target', status: 'reused', sourceRunId: 'run-1', message: 'Reused target', startedAt: 5, finishedAt: 5, error: null }], prepared: null, captures: [{ role: 'target', viewport: 'desktop', status: 'reused', sourceRunId: 'run-1', evidence, startedAt: 3, finishedAt: 4, error: null }], scoredReport: report }) },
      ],
      events: [{ seq: 41, run_id: 'run-1', occurred_at: 3, message: 'Original collection' }, { seq: 99, run_id: 'run-2', occurred_at: 6, message: 'Legacy report' }],
      reviews: [{ id: 'review-1', run_id: 'run-2', decision: 'rework', note: 'Needs valid evidence', created_at: 7 }],
      rule_versions: [{ version: rule.version, hash, rule_json: JSON.stringify(rule) }],
      rule_drafts: [{ id: 'draft-1', rule_json: JSON.stringify({ ...rule, version: 'draft-v1' }), revision: 4, updated_at: 8, published_at: null }],
      sites: [{ project_id: 'project-1', domain: 'generated.test', created_at: 2 }],
      evaluator_artifacts: [{ evaluation_id: 'evaluation-1', run_id: 'run-1', file: screenshot.file, content: 'cHJlc2VydmVkIHBpeGVscw==' }],
    },
  };
}

function temporary(): { root: string; destination: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'evaluator-migration-test-'));
  return { root, destination: join(root, 'data'), close() { rmSync(root, { recursive: true, force: true }); } };
}

test('imports exact historical rows, IDs, event order, checkpoints, private configuration and tokens', () => {
  const f = temporary(), snapshot = fixture();
  try {
    assert.deepEqual(importSnapshot(snapshot, f.destination), { evaluations: 1, runs: 2, artifacts: 1, rules: 1, drafts: 1, verified: true });
    const store = new Store(join(f.destination, 'database.sqlite'));
    try {
      for (const [table, rows] of Object.entries(snapshot.tables)) assert.deepEqual(store.db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })), rows);
      const run = store.history('evaluation-1').find(run => run.id === 'run-2')!;
      assert.equal(run.status, 'completed'); assert.equal(run.report?.fidelityScore, null); assert.equal(run.report?.completionScore, null);
      assert.equal(run.pipeline?.captures[0].evidence?.screenshots[0].sourceRunId, 'run-1');
      assert.deepEqual(store.events('run-2').map(event => event.seq), [99]);
      store.db.prepare('INSERT INTO events (run_id,occurred_at,message) VALUES (?,?,?)').run('run-2', 9, 'New event');
      assert.equal(store.db.prepare('SELECT MAX(seq) AS seq FROM events').get().seq, 100);
      assert.equal(new Artifacts(store.db).get('evaluation-1', 'run-1', 'target-desktop-top.png'), snapshot.tables.evaluator_artifacts[0].content);
    } finally { store.close(); }
    const vault = new Vault(f.destination), settings = vault.get();
    assert.equal(settings.model.apiKey, 'private-model-key'); assert.equal(settings.environments[0].token, 'private-environment-token');
    assert.deepEqual(settings.execution, { timeoutSeconds: 300, captureAttempts: 2 });
    assert.deepEqual(vault.credentials, snapshot.credentials);
    assert.ok(!readFileSync(join(f.destination, 'settings.enc')).includes(Buffer.from('private-model-key')));
    assert.deepEqual(readdirSync(f.root), ['data']);
  } finally { f.close(); }
});

test('allows historical hash-only rule versions and incomplete drafts without inventing contents', () => {
  const f = temporary(), snapshot = fixture();
  try {
    snapshot.tables.rule_versions[0].rule_json = null;
    const draft = JSON.parse(String(snapshot.tables.rule_drafts[0].rule_json));
    draft.dimensions[0].weight = 0;
    snapshot.tables.rule_drafts[0].rule_json = JSON.stringify(draft);
    assert.equal(importSnapshot(snapshot, f.destination).verified, true);
    const store = new Store(join(f.destination, 'database.sqlite'));
    try { assert.equal(store.db.prepare('SELECT rule_json FROM rule_versions').get().rule_json, null); }
    finally { store.close(); }
  } finally { f.close(); }
});

test('refuses existing directories, populated data, and dangling symlinks without changing them', () => {
  for (const kind of ['empty', 'configured', 'symlink']) {
    const f = temporary();
    try {
      if (kind === 'symlink') symlinkSync(join(f.root, 'missing'), f.destination);
      else {
        mkdirSync(f.destination);
        if (kind === 'configured') writeFileSync(join(f.destination, 'master.key'), 'original-private-key');
      }
      assert.throws(() => importSnapshot(fixture(), f.destination), /目标已存在/);
      if (kind === 'configured') assert.equal(readFileSync(join(f.destination, 'master.key'), 'utf8'), 'original-private-key');
      assert.deepEqual(readdirSync(f.root), ['data']);
    } finally { f.close(); }
  }
});

test('invalid snapshots leave no destination, SQLite, vault, or temporary directory', () => {
  const scenarios: [string, (snapshot: KoobooSnapshot) => void, RegExp][] = [
    ['schema version', s => { (s as any).schemaVersion = 2; }, /快照版本/],
    ['unknown envelope field', s => { (s as any).extra = 'unexpected'; }, /未知字段/],
    ['unknown table', s => { s.tables.secrets = []; }, /未知数据表/],
    ['unknown column', s => { s.tables.runs[0].extra = 'unexpected'; }, /未知列/],
    ['non SQLite value', s => { s.tables.runs[0].created_at = {}; }, /SQLite 值/],
    ['missing primary key', s => { delete s.tables.events[0].seq; }, /缺少原始主键/],
    ['coerced column type', s => { s.tables.runs[0].created_at = '3'; }, /类型不匹配/],
    ['rule hash mismatch', s => { s.tables.rule_versions[0].hash = '0'.repeat(64); }, /指纹不匹配/],
    ['rule content invalid', s => { const rule = JSON.parse(String(s.tables.rule_versions[0].rule_json)); rule.dimensions[0].weight = 0; s.tables.rule_versions[0].rule_json = JSON.stringify(rule); }, /权重之和/],
    ['snapshot hash mismatch', s => { const config = JSON.parse(String(s.tables.runs[0].snapshot)); config.ruleHash = '1'.repeat(64); s.tables.runs[0].snapshot = JSON.stringify(config); }, /指纹不匹配/],
    ['missing screenshot artifact', s => { s.tables.evaluator_artifacts = []; }, /证据文件不存在/],
    ['missing checkpoint artifact', s => { const pipeline = JSON.parse(String(s.tables.runs[1].pipeline)); pipeline.captures[0].evidence.screenshots[0].file = 'checkpoint-only-missing.png'; s.tables.runs[1].pipeline = JSON.stringify(pipeline); }, /证据文件不存在/],
    ['foreign key', s => { s.tables.events[0].run_id = 'missing-run'; }, /FOREIGN KEY/],
    ['wrong current run', s => { s.tables.evaluations[0].current_run_id = 'missing-run'; }, /当前执行记录/],
    ['invalid credentials', s => { s.credentials.ingestToken = 'short'; }, /迁移令牌/],
    ['invalid settings', s => { s.settings = { model: null }; }, /invalid_type|Invalid input/],
  ];
  for (const [name, mutate, expected] of scenarios) {
    const f = temporary(), snapshot = fixture();
    try {
      mutate(snapshot);
      assert.throws(() => importSnapshot(snapshot, f.destination), expected, name);
      assert.equal(existsSync(f.destination), false, name);
      assert.deepEqual(readdirSync(f.root), [], name);
    } finally { f.close(); }
  }
});

test('checkpoint screenshots inherit capture sourceRunId when their own provenance is absent', () => {
  const f = temporary(), snapshot = fixture();
  try {
    const pipeline = JSON.parse(String(snapshot.tables.runs[1].pipeline));
    delete pipeline.captures[0].evidence.screenshots[0].sourceRunId;
    snapshot.tables.runs[1].pipeline = JSON.stringify(pipeline);
    assert.equal(importSnapshot(snapshot, f.destination).verified, true);
  } finally { f.close(); }
});

test('rejects cross-evaluation screenshot provenance in aggregate and checkpoint evidence', () => {
  for (const location of ['evidence', 'pipeline']) {
    const f = temporary(), snapshot = fixture();
    try {
      snapshot.tables.evaluations.push({ ...snapshot.tables.evaluations[0], id: 'evaluation-2', attempt_id: 'attempt-2', current_run_id: 'other-run' });
      snapshot.tables.runs.push({ ...snapshot.tables.runs[0], id: 'other-run', evaluation_id: 'evaluation-2', evidence: null });
      if (location === 'evidence') {
        const evidence = JSON.parse(String(snapshot.tables.runs[1].evidence)); evidence.screenshots[0].sourceRunId = 'other-run';
        snapshot.tables.runs[1].evidence = JSON.stringify(evidence);
      } else {
        const pipeline = JSON.parse(String(snapshot.tables.runs[1].pipeline)); pipeline.captures[0].evidence.screenshots[0].sourceRunId = 'other-run';
        snapshot.tables.runs[1].pipeline = JSON.stringify(pipeline);
      }
      assert.throws(() => importSnapshot(snapshot, f.destination), /不属于同一任务/);
      assert.deepEqual(readdirSync(f.root), []);
    } finally { f.close(); }
  }
});
