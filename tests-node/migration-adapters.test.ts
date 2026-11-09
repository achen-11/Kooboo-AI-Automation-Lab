import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptManweiSavedEvidence } from '../server/automation/migration-adapters/manwei-saved.js';
import { reconcileMigration, verifyMigrationArtifacts } from '../server/automation/migration-check.js';
import { auditManweiSavedMigration } from '../scripts/audit-migration.js';
import type { MigrationArtifact, MigrationRunContext } from '../shared/migration.js';
import type { RequirementManifest } from '../shared/completeness.js';

const context: MigrationRunContext = { id: 'run', taskId: 'task', inputVersionId: 'input', siteId: 'site', siteRevision: 'rev', round: 0, checkedAt: 100 };
function fixture() {
  const raw = [
    { kind: 'source', url: 'https://manwei-sav.com/cn/category/10', status: 200, truncated: false,
      body: '<ul class="proud_list"><li><a href="/cn/show/1">same title</a></li></ul><a href="/cn/category/10_2.aspx">2</a>' },
    { kind: 'source', url: 'https://manwei-sav.com/cn/category/10_2.aspx', status: 200, truncated: false,
      body: '<ul class="news"><li><a href="/cn/show/2">same title</a></li></ul>' },
    { request: { kind: 'content', id: 'folder', page: 1 }, capturedAt: 50, value: { pageNr: 1, pageSize: 3, totalCount: 3, totalPages: 1,
      list: ['10', '1', '2'].map(id => ({ id: 'target-' + id, textValues: { sourceId: id, title: 'same title' } })) } },
    { request: { kind: 'contentItem', id: 'target-10', page: 1 }, capturedAt: 50,
      value: { id: 'target-10', properties: { kind: 'category', sourceId: '10', linkUrl: '1' } } },
  ];
  function prepare(values: unknown[] = raw) {
    const bytes = values.map(v => Buffer.from(JSON.stringify(v)));
    const artifacts: MigrationArtifact[] = bytes.map((b, i) => ({ name: (i < 2 ? 'source-review-' : 'implementation-') + 'a' + i + '.json', taskId: 'task', sha256: createHash('sha256').update(b).digest('hex'), size: b.length,
      inputVersionId: 'input', layer: i < 2 ? 'source' : 'target-data', capturedAt: i < 2 ? null : 50, ...(i < 2 ? {} : { siteId: 'site', siteRevision: 'rev' }) }));
    const byName = new Map(artifacts.map((a, i) => [a.name, bytes[i]]));
    const verified = verifyMigrationArtifacts(artifacts, a => byName.get(a.name)!);
    return { captures: verified.map((artifact, i) => ({ artifact, value: values[i] })), artifacts, bytes, verified };
  }
  return { raw, prepare };
}
test('saved adapter preserves source paging, stable IDs and missing stored relations without claiming full-site or page verification', () => {
  const f = fixture(), p = f.prepare(), { baseline, target } = adaptManweiSavedEvidence(p.captures, context);
  assert.equal(baseline.entities.records.length, 3); assert.equal(baseline.relations.records.length, 2);
  assert.equal(baseline.pages.records[1].path, '/cn/category/10_2.aspx'); assert.equal(target.entities.records.length, 3);
  assert.equal(target.storedRelations.records.length, 1); assert.equal(baseline.scope.sourceCoverage.state, 'unknown');
  const manifest: RequirementManifest = { id: 'm', revision: 1, taskId: 'task', createdAt: 0, actor: 'human', sourceComplete: false, limitations: ['source unknown'], items: [], evidence: [], migration: baseline };
  const run = reconcileMigration(manifest, target, p.verified, context);
  assert.equal(run.checks[1].differences.filter(d => d.code === 'missing' && d.confirmed).length, 1);
  assert.equal(run.checks[2].status, 'unverified'); assert.equal(run.checks[3].status, 'unverified');
});
test('unknown source layout, missing source pages and incomplete target inventories stay explicit', () => {
  const f = fixture(), raw = structuredClone(f.raw);
  raw[1].body = '<html>unexpected login</html>';
  const { baseline } = adaptManweiSavedEvidence(f.prepare(raw).captures, context);
  assert.notEqual(baseline.pages.coverage, 'complete'); assert.ok(baseline.pages.limitations.some(s => s.includes('列表版式')));
  assert.equal(baseline.pages.records[1].contentComplete, false);
  const other = structuredClone(f.raw); other[2].value!.totalPages = 2; other[2].value!.totalCount = 4;
  const target = adaptManweiSavedEvidence(f.prepare(other).captures, context).target;
  assert.equal(target.entities.coverage, 'partial'); assert.ok(target.entities.limitations.some(s => s.includes('分页')));
});
test('source navigation is not an empty detail list and unrelated links do not become required relations', () => {
  const f = fixture();
  f.raw[0].body += '<footer><a href="/cn/show/999">unrelated</a></footer>';
  f.raw[1].body = '<ul class="href_list"><li>navigation</li></ul>';
  const { baseline } = adaptManweiSavedEvidence(f.prepare().captures, context);
  assert.equal(baseline.relations.records.length, 1);
  assert.equal(baseline.pages.records[1].contentComplete, false);
  assert.equal(baseline.entities.records.some(e => e.key.id === '999'), false);
});
test('read-only CLI loader verifies exported hashes and does not require runtime DB or HTTP access', () => {
  const f = fixture(), p = f.prepare(), directory = mkdtempSync(join(tmpdir(), 'migration-offline-'));
  try {
    p.artifacts.forEach((a, i) => writeFileSync(join(directory, a.name), p.bytes[i]));
    const exported = { task: { id: 'task', versionId: 'input', siteRevision: 'rev', report: { artifacts: p.artifacts.map(a => ({ ...a, role: a.layer === 'source' ? 'content' : 'target' })) } }, site: { siteId: 'site' } };
    const path = join(directory, 'task.json'); writeFileSync(path, JSON.stringify(exported));
    const before = readFileSync(path), report = auditManweiSavedMigration(directory, path);
    assert.equal(report.summary.sourceDetails, 2); assert.equal(report.summary.checks[1].confirmedMissing, 1);
    assert.deepEqual(readFileSync(path), before);
    writeFileSync(join(directory, p.artifacts[0].name), '{}');
    assert.throws(() => auditManweiSavedMigration(directory, path), /SHA-256/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function currentRelations(page: number, ids: string[], totalPages = 1, totalCount = ids.length) {
  return { request: { kind: 'content', id: 'current-relations', page }, capturedAt: 50,
    value: { pageNr: page, pageSize: 2, totalPages, totalCount,
      list: ids.map(id => ({ id: 'relation-' + id, textValues: { catId: '10', showId: id } })) } };
}
test('explicit current relation directory replaces stale linkUrl without inventing stored order', () => {
  const f = fixture(), p = f.prepare([...f.raw, currentRelations(1, ['1', '2'])]);
  const { baseline, target } = adaptManweiSavedEvidence(p.captures, context, { relationFolderId: 'current-relations' });
  assert.equal(target.entities.records.length, 3);
  assert.deepEqual(target.storedRelations.records.map(r => r.entity.id), ['1', '2']);
  assert.equal(target.storedRelations.coverage, 'complete');
  assert.ok(target.storedRelations.records.every(r => r.position === undefined));
  const run = reconcileMigration({ id: 'm', revision: 1, taskId: 'task', createdAt: 0, actor: 'human', sourceComplete: false, limitations: ['unknown'], items: [], evidence: [], migration: baseline }, target, p.verified, context);
  assert.equal(run.checks[1].differences.length, 0);
  assert.equal(run.checks[1].status, 'unverified');
  assert.ok(run.checks[1].limitations.some(l => l.includes('顺序')));
});
test('missing current relation pages cannot confirm absence using stale legacy fields', () => {
  const f = fixture(), p = f.prepare([...f.raw, currentRelations(1, ['1'], 2, 2)]);
  const { baseline, target } = adaptManweiSavedEvidence(p.captures, context, { relationFolderId: 'current-relations' });
  assert.equal(target.storedRelations.coverage, 'partial');
  assert.ok(target.storedRelations.limitations.some(l => l.includes('关系分页')));
  const run = reconcileMigration({ id: 'm', revision: 1, taskId: 'task', createdAt: 0, actor: 'human', sourceComplete: false, limitations: ['unknown'], items: [], evidence: [], migration: baseline }, target, p.verified, context);
  assert.equal(run.checks[1].differences.filter(d => d.code === 'missing' && d.confirmed).length, 0);
});
test('a fully read current directory identifies the exact missing relation despite stale legacy membership', () => {
  const f = fixture(), p = f.prepare([...f.raw, currentRelations(1, ['2'])]);
  const { baseline, target } = adaptManweiSavedEvidence(p.captures, context, { relationFolderId: 'current-relations' });
  const run = reconcileMigration({ id: 'm', revision: 1, taskId: 'task', createdAt: 0, actor: 'human', sourceComplete: false, limitations: ['unknown'], items: [], evidence: [], migration: baseline }, target, p.verified, context);
  const missing = run.checks[1].differences.filter(d => d.code === 'missing' && d.confirmed);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].subject, JSON.stringify([JSON.stringify(['manwei-sav.com/cn', 'category', '10']), JSON.stringify(['manwei-sav.com/cn', 'detail', '1'])]));
  assert.equal(run.state, 'incomplete');
});
test('current relation directory rejects contradictory pages, mismatched requests and absent directories', () => {
  const f = fixture();
  const variants: unknown[][] = [
    [...f.raw, currentRelations(1, ['1']), currentRelations(1, ['2'])],
    [...f.raw, { ...currentRelations(1, ['1']), request: { kind: 'content', id: 'current-relations', page: 2 } }],
    f.raw,
  ];
  for (const raw of variants) {
    const { target } = adaptManweiSavedEvidence(f.prepare(raw).captures, context, { relationFolderId: 'current-relations' });
    assert.notEqual(target.storedRelations.coverage, 'complete');
    assert.ok(target.storedRelations.limitations.length > 0);
  }
});

test('explicit entity directory excludes audit folders without hiding selected-folder gaps or malformed pages', () => {
  const f = fixture(), unrelated = { request: { kind: 'content', id: 'coverage-audit', page: 1 }, capturedAt: 50,
    value: { pageNr: 1, pageSize: 100, totalCount: 1, totalPages: 1, list: [{ id: 'audit-1', textValues: { verdict: 'match' } }] } };
  const options = { contentFolderId: 'folder', relationFolderId: 'current-relations' };
  const raw = [...f.raw, currentRelations(1, ['2']), unrelated];
  const p = f.prepare(raw), { baseline, target } = adaptManweiSavedEvidence(p.captures, context, options);
  assert.equal(target.entities.coverage, 'complete');
  assert.equal(target.storedRelations.coverage, 'complete');
  assert.equal(target.entities.records.length, 3);
  const run = reconcileMigration({ id: 'm', revision: 1, taskId: 'task', createdAt: 0, actor: 'human', sourceComplete: false, limitations: ['unknown'], items: [], evidence: [], migration: baseline }, target, p.verified, context);
  assert.equal(run.checks[1].differences.filter(d => d.code === 'missing' && d.confirmed).length, 1);
  // Default mode remains conservative when the host has not selected a folder.
  assert.notEqual(adaptManweiSavedEvidence(p.captures, context, { relationFolderId: 'current-relations' }).target.entities.coverage, 'complete');
  const malformed = structuredClone(unrelated); malformed.request.id = 'folder';
  for (const values of [raw.filter(v => v !== f.raw[2]), [...raw, malformed]]) {
    assert.notEqual(adaptManweiSavedEvidence(f.prepare(values).captures, context, options).target.entities.coverage, 'complete');
  }
  assert.throws(() => adaptManweiSavedEvidence(p.captures, context, { contentFolderId: 'folder', relationFolderId: 'folder' }), /不能相同/);
});
