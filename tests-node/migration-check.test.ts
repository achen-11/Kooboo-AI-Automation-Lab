import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RequirementManifest } from '../shared/completeness.js';
import type { MigrationArtifact, MigrationBaseline, MigrationEvidenceRef, MigrationKey, MigrationRunContext, MigrationSection, MigrationTargetSnapshot } from '../shared/migration.js';
import { assertMigrationBaselinePreserved, compareMigrationRuns, migrationKey, reconcileMigration, verifyMigrationArtifacts } from '../server/automation/migration-check.js';
import { ManifestStore, manifestInput, validateCompleteness } from '../server/automation/completeness.js';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { defaultAutomationSettings } from '../shared/automation.js';

const key = (id: string, kind = 'detail', namespace = 'source') => ({ namespace, kind, id });
function fixture() {
  const bytes = new Map<string, Buffer>(), artifacts: MigrationArtifact[] = [];
  function artifact(name: string, layer: MigrationArtifact['layer']): MigrationEvidenceRef {
    const body = Buffer.from(JSON.stringify({ name, layer })); bytes.set(name, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    artifacts.push({ taskId: layer === 'source' ? 'source-task' : 'target-task', name, sha256, size: body.length, layer,
      inputVersionId: 'input-v1', capturedAt: 10, ...(layer === 'source' ? {} : { siteId: 'site', siteRevision: 'revision-1' }),
      ...(layer === 'scope-decision' ? { actor: 'human' as const } : {}),
    });
    return { taskId: artifacts.at(-1)!.taskId, name, sha256, locator: '$' };
  }
  const s = artifact('source.json', 'source'), d = artifact('data.json', 'target-data'), p = artifact('pages.json', 'target-response');
  const a = artifact('scope.json', 'scope-decision'), code = artifact('code.json', 'code-derived');
  const section = <T>(records: T[], evidence: MigrationEvidenceRef): MigrationSection<T> => ({ coverage: 'complete', limitations: [], evidence: [evidence], records });
  const category = key('category', 'category'), first = key('1'), second = key('2');
  const sourceEntities = [category, first, second].map(k => ({ key: k, label: 'same title', evidence: [s] }));
  const relations = [first, second].map((entity, position) => ({ category, entity, position, evidence: [s] }));
  const pages = [first, second].map((entity, i) => ({ path: '/category' + (i ? '_2.aspx?lang=cn' : '.aspx'), status: 200, finalPath: '/category' + (i ? '_2.aspx?lang=cn' : '.aspx'), redirects: [], entities: [entity], ordered: true, contentComplete: true, evidence: [s] }));
  const baseline: MigrationBaseline = {
    schemaVersion: 1, inputVersionId: 'input-v1',
    scope: { kind: 'site', description: 'whole source site', authorization: [], sourceCoverage: { state: 'complete', limitations: [], evidence: [s] }, scopeCoverage: { state: 'complete', limitations: [], evidence: [s] } },
    entities: section(sourceEntities, s), relations: section(relations, s), pages: section(pages, s),
    rules: { preserveRelationOrder: true, allowedExtraEntities: [], allowedExtraRelations: [] },
  };
  const target: MigrationTargetSnapshot = {
    schemaVersion: 1, inputVersionId: 'input-v1', observation: { siteId: 'site', siteRevision: 'revision-1', capturedAt: 10 },
    entities: section(sourceEntities.map((e, i) => ({ ...e, recordId: String(i), recordType: 'Content', evidence: [d] })), d),
    storedRelations: section(relations.map(r => ({ ...r, evidence: [d] })), d),
    outputRelations: section(relations.map(r => ({ ...r, evidence: [p] })), p),
    pages: section(pages.map(r => ({ ...r, evidence: [p] })), p),
  };
  const manifest: RequirementManifest = { id: 'manifest', taskId: 'generation', revision: 1, createdAt: 0, sourceComplete: true, limitations: [], items: [], evidence: [], actor: 'human', migration: baseline };
  const context: MigrationRunContext = { id: 'run-1', taskId: 'generation', inputVersionId: 'input-v1', siteId: 'site', siteRevision: 'revision-1', round: 0, checkedAt: 20 };
  const run = () => reconcileMigration(manifest, target, verifyMigrationArtifacts(artifacts, e => bytes.get(e.name)!), context);
  return { baseline, target, manifest, context, run, artifacts, bytes, s, d, p, a, code, first, second, category, section };
}

test('logical identities retain same-title entities and multi-category relations; hashes and output are deterministic', () => {
  const f = fixture(), another = key('another', 'category');
  f.baseline.entities.records.push({ key: another, label: 'same title', evidence: [f.s] });
  f.target.entities.records.push({ key: another, label: 'same title', recordId: 'another', recordType: 'Content', evidence: [f.d] });
  const relation = { category: another, entity: f.first, position: 0 };
  f.baseline.relations.records.push({ ...relation, evidence: [f.s] });
  f.target.storedRelations.records.push({ ...relation, evidence: [f.d] });
  f.target.outputRelations.records.push({ ...relation, evidence: [f.p] });
  const result = f.run();
  assert.equal(result.state, 'complete'); assert.ok(result.checks.every(c => c.status === 'verified'));
  assert.deepEqual(f.run(), result);
  assert.notEqual(migrationKey(key('c', 'b', 'a:b')), migrationKey(key('c', 'b:b', 'a')));
});

test('equal counts cannot conceal substituted IDs, duplicates, or a merged physical target record', () => {
  const f = fixture(); f.target.entities.records[2].key = key('wrong');
  let check = f.run().checks[0];
  assert.equal(check.status, 'partial'); assert.ok(check.differences.some(d => d.code === 'missing' && d.subject === migrationKey(f.second) && d.confirmed));
  assert.ok(check.differences.some(d => d.code === 'unexpected' && d.confirmed));
  f.target.entities.records[2] = { ...f.target.entities.records[1] };
  assert.ok(f.run().checks[0].differences.some(d => d.code === 'duplicate'));
  f.target.entities.records[2] = { ...f.target.entities.records[1], key: f.second };
  assert.ok(f.run().checks[0].differences.some(d => d.code === 'mapping-conflict' && d.confirmed));
});

test('entity existence does not certify relations; storage and actual output have separate results', () => {
  const f = fixture(); f.target.outputRelations.records.pop();
  const result = f.run(); assert.equal(result.checks[0].status, 'verified'); assert.equal(result.checks[1].status, 'verified');
  assert.equal(result.checks[2].status, 'partial'); assert.equal(result.state, 'incomplete');
  f.target.storedRelations.records[0].position = 1; f.target.storedRelations.records[1].position = 0;
  assert.ok(f.run().checks[1].differences.some(d => d.code === 'order' && d.confirmed));
});

test('HTTP 200 with the first page repeated fails; extension, query, ordering and redirect semantics remain significant', () => {
  const f = fixture(); f.target.pages.records[1].entities = [f.first];
  const check = f.run().checks[3]; assert.equal(check.status, 'partial'); assert.ok(check.differences.some(d => d.subject === '/category_2.aspx?lang=cn' && d.confirmed));
  f.target.pages.records[1].entities = [f.second]; f.target.pages.records[1].finalPath = '/category.aspx';
  assert.ok(f.run().checks[3].differences.some(d => d.code === 'response' && d.confirmed));
  f.target.pages.records[1].finalPath = f.baseline.pages.records[1].finalPath; f.target.pages.records[1].redirects = [{ path: '/category.aspx', status: 302 }];
  assert.ok(f.run().checks[3].differences.some(d => d.code === 'response'));
});

test('failed extraction and incomplete pagination never turn an empty snapshot into confirmed missing data', () => {
  const f = fixture(); f.target.entities = { ...f.target.entities, coverage: 'partial', limitations: ['only first data page'], records: [] };
  const check = f.run().checks[0]; assert.equal(check.status, 'unverified'); assert.ok(check.differences.every(d => !d.confirmed));
  f.target.pages.records[1].entities = []; f.target.pages.records[1].contentComplete = false;
  const pages = f.run().checks[3]; assert.equal(pages.status, 'unverified'); assert.ok(pages.differences.every(d => !d.confirmed));
});

test('source-code simulation stays diagnostic and cannot verify output or page content', () => {
  const f = fixture(); f.target.outputRelations.evidence = [f.code];
  f.target.outputRelations.records = f.target.outputRelations.records.slice(0, 1).map(r => ({ ...r, evidence: [f.code] }));
  const check = f.run().checks[2]; assert.equal(check.status, 'unverified'); assert.equal(check.actualCount, null);
  assert.ok(check.differences.some(d => d.code === 'missing')); assert.ok(check.differences.every(d => !d.confirmed));
});

test('wrong roles, missing evidence, stale versions and future observations are unverified', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.target.entities.evidence = []; },
    (f: ReturnType<typeof fixture>) => { f.target.entities.records[0].evidence = [f.s]; },
    (f: ReturnType<typeof fixture>) => { f.artifacts.find(a => a.layer === 'target-data')!.siteRevision = 'old'; },
    (f: ReturnType<typeof fixture>) => { f.target.observation.siteRevision = 'old'; },
    (f: ReturnType<typeof fixture>) => { f.target.observation.capturedAt = 30; },
    (f: ReturnType<typeof fixture>) => { f.artifacts.find(a => a.layer === 'target-data')!.capturedAt = null; },
    (f: ReturnType<typeof fixture>) => { f.artifacts.find(a => a.layer === 'target-data')!.capturedAt = 11; },
  ]) {
    const f = fixture(); mutate(f); assert.equal(f.run().checks[0].status, 'unverified'); assert.notEqual(f.run().state, 'complete');
  }
});

test('source-site coverage is distinct from an explicitly authorized and evidenced subset', () => {
  const f = fixture(); f.manifest.sourceComplete = false;
  f.baseline.scope.sourceCoverage = { state: 'unknown', limitations: ['no complete source inventory'], evidence: [f.s] };
  assert.equal(f.run().state, 'unverified');
  f.baseline.scope.kind = 'subset'; f.baseline.scope.description = 'user-selected categories'; f.baseline.scope.authorization = [f.a];
  assert.equal(f.run().state, 'complete'); assert.equal(f.run().sourceCoverage!.state, 'unknown');
  f.baseline.scope.authorization = [f.s]; assert.equal(f.run().state, 'unverified');
  f.baseline.scope.authorization = [f.a]; f.baseline.scope.scopeCoverage.limitations = ['unresolved selected-scope gap'];
  assert.equal(f.run().state, 'unverified');
});

test('unexpected extras must be explicitly accounted for and cannot offset missing entities', () => {
  const f = fixture(), extra = key('extra'); f.target.entities.records.push({ key: extra, recordId: 'extra', recordType: 'Content', evidence: [f.d] });
  assert.equal(f.run().checks[0].status, 'partial'); f.baseline.rules.allowedExtraEntities.push(extra);
  assert.equal(f.run().state, 'complete'); f.target.entities.records.splice(1, 1);
  assert.equal(f.run().checks[0].status, 'partial');
});

test('ambiguous source identities and dangling source references cannot certify a baseline', () => {
  const f = fixture(); f.baseline.entities.records.push({ ...f.baseline.entities.records[1] });
  assert.equal(f.run().checks[0].status, 'unverified');
  const g = fixture(); g.baseline.relations.records[0].entity = key('not-in-source');
  const check = g.run().checks[1]; assert.equal(check.status, 'unverified'); assert.ok(check.differences.every(d => !d.confirmed));
});

test('saved evidence must pass hash/size checks, cannot be duplicated or bypassed by supplying metadata', () => {
  const f = fixture(); f.bytes.set('data.json', Buffer.from('tampered'));
  assert.throws(() => verifyMigrationArtifacts(f.artifacts, a => f.bytes.get(a.name)!), /SHA-256/);
  const g = fixture(); assert.throws(() => verifyMigrationArtifacts([...g.artifacts, g.artifacts[0]], a => g.bytes.get(a.name)!), /身份重复/);
  assert.throws(() => reconcileMigration(g.manifest, g.target, g.artifacts as never, g.context), /先校验/);
});

test('old manifests remain unverified to the structured checker; count-only AI output cannot certify a new migration baseline', () => {
  const f = fixture(); delete f.manifest.migration; assert.equal(f.run().state, 'unverified');
  f.manifest.items = [{ id: 'data', title: 'data', kind: 'data', required: true, source: 'source', expectation: 'all keys', paths: [], expectedCount: 1, expectedKeys: ['a'], viewports: ['business'] }];
  const checks = [{ id: 'data', status: 'verified', reason: 'present', evidence: ['implementation-proof.json'], checkedViewports: ['business'], actualCount: 1, sampledPaths: [], checkedKeys: ['a'] }];
  const files = [{ id: 'proof', name: 'implementation-proof.json', type: 'application/json', size: 1, sha256: '0'.repeat(64), role: 'target' as const }];
  assert.equal(validateCompleteness(checks, f.manifest, files).state, 'complete');
  f.manifest.migration = f.baseline;
  assert.equal(validateCompleteness(checks, f.manifest, files).state, 'unverified');
  const { id: _, taskId: __, createdAt: ___, revision: ____, actor: _____, ...input } = f.manifest;
  assert.equal(manifestInput.parse(input).migration!.inputVersionId, 'input-v1');
});

test('fixed baselines cannot be removed, shrink relations, change pagination semantics or silently authorize extras', () => {
  const f = fixture(); assert.doesNotThrow(() => assertMigrationBaselinePreserved(f.baseline, structuredClone(f.baseline)));
  assert.throws(() => assertMigrationBaselinePreserved(f.baseline, undefined), /不得/);
  for (const change of [
    (b: MigrationBaseline) => { b.relations.records.pop(); },
    (b: MigrationBaseline) => { b.pages.records[1].entities = [f.first]; },
    (b: MigrationBaseline) => { b.rules.allowedExtraEntities.push(key('extra')); },
  ]) { const next = structuredClone(f.baseline); change(next); assert.throws(() => assertMigrationBaselinePreserved(f.baseline, next), /不得/); }
});

test('progress is computed from evidence-backed differences on the same baseline, not a model flag', () => {
  const f = fixture(); f.target.outputRelations.records.pop(); const before = f.run();
  f.target.outputRelations.records.push({ ...f.baseline.relations.records[1], evidence: [f.p] });
  f.context.round = 1; const after = f.run();
  const progress = compareMigrationRuns(before, after); assert.equal(progress.comparable, true); assert.equal(progress.improved, true); assert.equal(progress.resolved.length, 1);
  assert.equal(compareMigrationRuns(after, before).comparable, false);
  assert.equal(compareMigrationRuns(before, { ...after, manifestRevision: 2 }).comparable, false);
  f.target.pages.records[1].contentComplete = false;
  assert.equal(compareMigrationRuns(before, f.run()).improved, null);
  assert.deepEqual(compareMigrationRuns(before, f.run()).resolved, []);
});

test('allowed extra relations cannot hide reordered expected entities', () => {
  const f = fixture(), extra = key('extra');
  f.baseline.rules.allowedExtraEntities.push(extra);
  f.baseline.rules.allowedExtraRelations.push({ category: f.category, entity: extra });
  f.target.entities.records.push({ key: extra, recordId: 'extra', recordType: 'Content', evidence: [f.d] });
  f.target.storedRelations.records = [
    { category: f.category, entity: f.second, position: 0, evidence: [f.d] },
    { category: f.category, entity: extra, position: 1, evidence: [f.d] },
    { category: f.category, entity: f.first, position: 2, evidence: [f.d] },
  ];
  assert.ok(f.run().checks[1].differences.some(d => d.code === 'order' && d.confirmed));
});

test('page identities must resolve to the corresponding entity inventory; incomplete inventories do not prove dangling references', () => {
  const f = fixture(); f.baseline.pages.records[0].entities = [key('unknown')];
  let check = f.run().checks[3]; assert.equal(check.status, 'unverified'); assert.ok(check.differences.every(d => !d.confirmed));
  const g = fixture(); g.target.entities.records.pop();
  check = g.run().checks[3]; assert.ok(check.differences.some(d => d.code === 'dangling-reference' && d.confirmed));
  g.target.entities.coverage = 'partial'; g.target.entities.limitations = ['second inventory page unavailable'];
  check = g.run().checks[3]; assert.equal(check.status, 'unverified'); assert.ok(check.differences.every(d => !d.confirmed));
  g.target.storedRelations.records.pop(); g.target.storedRelations.coverage = 'partial'; g.target.storedRelations.limitations = ['only first relation page'];
  assert.ok(g.run().checks[1].differences.every(d => !d.confirmed));
});

test('manifest storage keeps frozen migration revisions, binds inputs and rolls back rejected reductions', () => {
  const db = new Database(':memory:');
  try {
    const store = new AutomationStore(db), manifests = new ManifestStore(store), f = fixture();
    const resource = store.saveResource({ name: 'migration', scenario: 'migration', description: '', contentUrl: 'https://source.invalid', referenceUrl: '', externalSource: '', externalId: '', files: [] });
    const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'site', environmentId: 'env', requirements: '' }, defaultAutomationSettings)[0];
    f.baseline.inputVersionId = task.versionId;
    const input = { sourceComplete: true, limitations: [], evidence: [], migration: f.baseline,
      items: [{ id: 'data', title: 'data', kind: 'data', required: true, source: 'snapshot', expectation: 'all identities', paths: [], expectedCount: 3, expectedKeys: ['category', '1', '2'], viewports: ['business'] }] };
    const original = manifests.save(task, input, 'human');
    const reduced = structuredClone(input); reduced.migration.relations.records.pop();
    assert.throws(() => manifests.save(task, reduced, 'ai'), /不得缩减/);
    assert.throws(() => manifests.save(task, { ...input, migration: undefined }, 'ai'), /不得移除/);
    assert.throws(() => manifests.save(task, { ...input, migration: { ...f.baseline, inputVersionId: 'another-input' } }, 'ai'), /输入版本不一致/);
    assert.equal(store.task(task.id)!.requirementsId, original.id);
    const extended = structuredClone(input); extended.migration.entities.records.push({ key: key('new'), evidence: [f.s] });
    const next = manifests.save(task, extended, 'ai', original.id);
    assert.equal(next.revision, 2); assert.equal(next.migration!.entities.records.length, 4);
    assert.deepEqual(manifests.get(original.id), original);
    assert.equal(manifests.get(original.id)!.migration!.entities.records.length, 3);
    assert.throws(() => manifests.save(task, extended, 'ai', original.id), /已更新/);
  } finally { db.close(); }
});
