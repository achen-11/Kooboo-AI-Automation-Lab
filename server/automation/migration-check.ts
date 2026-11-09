import { createHash } from 'node:crypto';
import type { RequirementManifest } from '../../shared/completeness.js';
import type {
  MigrationArtifact, MigrationBaseline, MigrationCheckId, MigrationCheckResult, MigrationCheckRun,
  MigrationDifference, MigrationEntity, MigrationEvidenceLayer, MigrationEvidenceRef, MigrationKey,
  MigrationPage, MigrationRelation, MigrationRunContext, MigrationSection,
} from '../../shared/migration.js';
import { migrationArtifactSchema, migrationBaselineSchema, migrationRunContextSchema, migrationTargetSchema } from './migration-contract.js';

export const MIGRATION_CHECKER_VERSION = 'migration-v3';
declare const artifactVerified: unique symbol;
export type VerifiedMigrationArtifact = Readonly<MigrationArtifact> & { readonly [artifactVerified]: true };
const verified = new WeakSet<object>();
export const migrationKey = (key: MigrationKey) => JSON.stringify([key.namespace, key.kind, key.id]);
const relationKey = (r: Pick<MigrationRelation, 'category' | 'entity'>) => JSON.stringify([migrationKey(r.category), migrationKey(r.entity)]);
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
};
const refKey = (r: Pick<MigrationEvidenceRef, 'taskId' | 'name'>) => JSON.stringify([r.taskId, r.name]);
const dedupe = <T>(values: T[], key: (v: T) => string) => [...new Map(values.map(v => [key(v), v])).values()];
const refs = (values: MigrationEvidenceRef[]) => dedupe(values, r => canonical(r));

/** Verify saved bytes before making them available to the pure checker. No network, DB or writes. */
export function verifyMigrationArtifacts(artifacts: MigrationArtifact[], read: (artifact: MigrationArtifact) => Uint8Array): VerifiedMigrationArtifact[] {
  const seen = new Set<string>();
  return artifacts.map(raw => {
    const artifact = migrationArtifactSchema.parse(raw), key = refKey(artifact);
    if (seen.has(key)) throw new Error('迁移证据身份重复：' + artifact.name);
    seen.add(key);
    const bytes = read(artifact);
    if (bytes.byteLength !== artifact.size || hash(bytes) !== artifact.sha256) throw new Error('迁移证据大小或 SHA-256 不匹配：' + artifact.name);
    Object.freeze(artifact); verified.add(artifact);
    return artifact as VerifiedMigrationArtifact;
  });
}

/** Host-owned, hash-verified artifact metadata is required; model-supplied catalogs are not trusted. */
export function reconcileMigration(manifest: RequirementManifest, rawTarget: unknown, verifiedArtifacts: readonly VerifiedMigrationArtifact[], rawContext: MigrationRunContext): MigrationCheckRun {
  const context = migrationRunContextSchema.parse(rawContext);
  const ids: MigrationCheckId[] = ['entities', 'stored-relations', 'output-relations', 'pages'];
  const result: MigrationCheckRun = {
    ...context, checkerVersion: MIGRATION_CHECKER_VERSION, manifestId: manifest.id, manifestRevision: manifest.revision,
    baselineHash: null, state: 'unverified', sourceCoverage: null, scopeCoverage: null, limitations: [], checks: [],
  };
  if (!manifest.migration) {
    result.limitations.push('旧清单没有结构化迁移基线，不能自动升级为已核验。');
    result.checks = ids.map(id => ({ id, status: 'unverified', expectedCount: 0, actualCount: null, differences: [], evidence: [], limitations: [...result.limitations] }));
    return result;
  }
  const baseline = migrationBaselineSchema.parse(manifest.migration), target = migrationTargetSchema.parse(rawTarget);
  result.baselineHash = hash(canonical(baseline));
  result.sourceCoverage = baseline.scope.sourceCoverage;
  result.scopeCoverage = baseline.scope.scopeCoverage;
  const catalog = new Map<string, MigrationArtifact>();
  for (const raw of verifiedArtifacts) {
    if (!verified.has(raw)) throw new Error('必须先校验迁移证据原始字节');
    const artifact = migrationArtifactSchema.parse(raw), key = refKey(artifact);
    if (catalog.has(key)) throw new Error('迁移证据身份重复：' + artifact.name);
    catalog.set(key, artifact);
  }
  const binding = baseline.inputVersionId === context.inputVersionId && target.inputVersionId === context.inputVersionId
    && target.observation.siteId === context.siteId && target.observation.siteRevision === context.siteRevision
    && target.observation.capturedAt <= context.checkedAt;
  if (!binding) result.limitations.push('输入或目标观测版本不匹配，不能使用旧快照核验当前目标。');
  function validEvidence(evidence: MigrationEvidenceRef[], layer: MigrationEvidenceLayer): boolean {
    return evidence.length > 0 && evidence.every(ref => {
      const artifact = catalog.get(refKey(ref));
      return !!artifact && artifact.sha256 === ref.sha256 && artifact.layer === layer
        && artifact.inputVersionId === context.inputVersionId && (artifact.capturedAt === null || artifact.capturedAt <= context.checkedAt)
        && (layer === 'source' || layer === 'scope-decision' || artifact.siteId === context.siteId && artifact.siteRevision === context.siteRevision
          && artifact.capturedAt !== null && artifact.capturedAt <= target.observation.capturedAt)
        && (layer !== 'scope-decision' || artifact.actor === 'human');
    });
  }
  let scopeReady = baseline.scope.scopeCoverage.state === 'complete' && !baseline.scope.scopeCoverage.limitations.length && validEvidence(baseline.scope.scopeCoverage.evidence, 'source');
  if (baseline.scope.kind === 'site') scopeReady &&= manifest.sourceComplete && baseline.scope.sourceCoverage.state === 'complete' && !baseline.scope.sourceCoverage.limitations.length && validEvidence(baseline.scope.sourceCoverage.evidence, 'source');
  else scopeReady &&= validEvidence(baseline.scope.authorization, 'scope-decision');
  if (!scopeReady) result.limitations.push('约定迁移范围尚未有完整覆盖依据；保留全源站及范围缺口，不能据已发现集合声称全站完整。');

  function check<T extends { evidence: MigrationEvidenceRef[] }>(id: MigrationCheckId, expected: MigrationSection<T>, actual: MigrationSection<T>, layer: MigrationEvidenceLayer,
    key: (row: T) => string, allowed: Set<string>, compare?: (expected: T, actual: T, proven: boolean, add: Add) => void): MigrationCheckResult {
    const issues: MigrationDifference[] = [], limitations = [...expected.limitations, ...actual.limitations];
    const expectedTrusted = validEvidence(expected.evidence, 'source') && expected.records.every(r => validEvidence(r.evidence, 'source'));
    const actualTrusted = binding && validEvidence(actual.evidence, layer) && actual.records.every(r => validEvidence(r.evidence, layer));
    if (!expectedTrusted) limitations.push('来源证据缺失、角色错误、哈希或版本不符。');
    if (!actualTrusted) limitations.push('目标证据缺失或与本次版本/证据层不符；代码推导不能代替实际目标观测。');
    const byKey = (rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) { const k = key(row); const values = map.get(k) || []; values.push(row); map.set(k, values); }
      return map;
    };
    const es = byKey(expected.records), as = byKey(actual.records);
    const ambiguous = [...es.values()].some(rows => rows.length > 1);
    const add: Add = (code, subject, e, a, confirmed, evidence) => {
      const value = { checkId: id, code, subject, expected: e, actual: a };
      issues.push({ ...value, id: hash(canonical(value)), confirmed: confirmed && binding && expectedTrusted && actualTrusted && !ambiguous, evidence: refs(evidence) });
    };
    for (const [k, rows] of es) {
      const found = as.get(k);
      if (rows.length > 1) add('ambiguous-source', k, '唯一来源标识', rows.length, false, rows.flatMap(r => r.evidence));
      if (!found) add('missing', k, true, false, actual.coverage === 'complete', [...rows.flatMap(r => r.evidence), ...actual.evidence]);
      else if (rows.length === 1) compare?.(rows[0], found[0], true, add);
    }
    for (const [k, rows] of as) {
      if (rows.length > 1) add('duplicate', k, 1, rows.length, true, rows.flatMap(r => r.evidence));
      if (!es.has(k) && !allowed.has(k)) add('unexpected', k, false, true, expected.coverage === 'complete', rows.flatMap(r => r.evidence));
    }
    const proven = binding && expectedTrusted && actualTrusted && !ambiguous;
    const evidence = refs([...expected.evidence, ...actual.evidence]);
    if (id === 'entities') {
      const records = new Map<string, MigrationEntity[]>();
      for (const row of actual.records as unknown as MigrationEntity[]) {
        if (!row.recordId || !row.recordType) { limitations.push('目标实体缺少可独立定位的记录类型或 ID：' + migrationKey(row.key)); continue; }
        const k = JSON.stringify([row.recordType, row.recordId]); records.set(k, [...(records.get(k) || []), row]);
      }
      for (const [k, rows] of records) if (new Set(rows.map(r => migrationKey(r.key))).size > 1) add('mapping-conflict', k, '每个来源实体有独立目标映射', rows.map(r => r.key), true, rows.flatMap(r => r.evidence));
    }
    const check: MigrationCheckResult = {
      id, status: 'unverified', expectedCount: expected.records.length, actualCount: actualTrusted ? actual.records.length : null,
      expectedKeys: [...es.keys()], checkedKeys: actualTrusted ? [...as.keys()] : [],
      differences: issues, evidence, limitations: [...new Set(limitations)],
    };
    const finalize = () => {
      check.limitations = [...new Set(limitations)];
      check.status = issues.some(i => i.confirmed) ? 'partial'
        : proven && expected.coverage === 'complete' && actual.coverage === 'complete' && !issues.length && !limitations.length ? 'verified' : 'unverified';
    };
    finalize();
    // Relation/response-specific postchecks use the same provenance and finalization.
    postChecks.get(id)?.({ expected, actual, add, limitations, proven });
    if (issues.some(d => d.code === 'ambiguous-source')) for (const issue of issues) issue.confirmed = false;
    finalize();
    return check;
  }
  type Add = (code: MigrationDifference['code'], subject: string, expected: unknown, actual: unknown, confirmed: boolean, evidence: MigrationEvidenceRef[]) => void;
  type Post = { expected: MigrationSection<unknown>; actual: MigrationSection<unknown>; add: Add; limitations: string[]; proven: boolean };
  const postChecks = new Map<MigrationCheckId, (p: Post) => void>();
  const sourceEntities = new Set(baseline.entities.records.map(e => migrationKey(e.key)));
  const targetEntities = new Set(target.entities.records.map(e => migrationKey(e.key)));
  const targetEntitiesTrusted = binding && target.entities.coverage === 'complete' && validEvidence(target.entities.evidence, 'target-data') && target.entities.records.every(e => validEvidence(e.evidence, 'target-data'));
  function relationPost(p: Post) {
    const e = p.expected as MigrationSection<MigrationRelation>, a = p.actual as MigrationSection<MigrationRelation>;
    const sourceDangling = e.records.some(r => !sourceEntities.has(migrationKey(r.category)) || !sourceEntities.has(migrationKey(r.entity)));
    if (sourceDangling) {
      p.limitations.push('来源实体快照不能解析全部关系引用。');
      // A contradictory baseline cannot certify relations or confirmed absence.
      for (const row of e.records) if (!sourceEntities.has(migrationKey(row.category)) || !sourceEntities.has(migrationKey(row.entity))) p.add('ambiguous-source', relationKey(row), '来源实体存在', false, false, row.evidence);
    }
    for (const row of a.records) if (!targetEntities.has(migrationKey(row.category)) || !targetEntities.has(migrationKey(row.entity))) {
      p.add('dangling-reference', relationKey(row), '目标实体存在', false, targetEntitiesTrusted, row.evidence);
      if (!targetEntitiesTrusted) p.limitations.push('目标实体全集未验证，无法确认关系是否悬空。');
    }
    if (!baseline.rules.preserveRelationOrder) return;
    const group = (rows: MigrationRelation[]) => {
      const grouped = new Map<string, MigrationRelation[]>();
      for (const row of rows) { const k = migrationKey(row.category); const values = grouped.get(k) || []; values.push(row); grouped.set(k, values); }
      return grouped;
    };
    const eg = group(e.records), ag = group(a.records);
    for (const [category, expected] of eg) {
      const actual = ag.get(category) || [];
      if (expected.some(r => r.position === undefined) || actual.some(r => r.position === undefined)) { p.limitations.push('关系缺少约定顺序：' + category); continue; }
      const positions = (rows: MigrationRelation[]) => rows.map(r => r.position);
      if (new Set(positions(expected)).size !== expected.length || new Set(positions(actual)).size !== actual.length) { p.limitations.push('关系顺序标识不唯一：' + category); continue; }
      const sequence = (rows: MigrationRelation[]) => [...rows].sort((x, y) => x.position! - y.position!).map(r => migrationKey(r.entity));
      const expectedKeys = new Set(expected.map(r => migrationKey(r.entity)));
      const ee = sequence(expected), aa = sequence(actual.filter(r => expectedKeys.has(migrationKey(r.entity))));
      // Compare order only for identical sets; missing entities are already precise differences.
      if (canonical([...ee].sort()) === canonical([...aa].sort()) && canonical(ee) !== canonical(aa)) p.add('order', category, ee, aa, true, [...expected, ...actual].flatMap(r => r.evidence));
    }
  }
  postChecks.set('stored-relations', relationPost); postChecks.set('output-relations', relationPost);
  postChecks.set('pages', p => {
    for (const page of p.expected.records as MigrationPage[]) {
      if (page.status === null || page.finalPath === null || !page.contentComplete) p.limitations.push('来源 URL 缺少约定响应或完整内容序列：' + page.path);
      if (page.entities.some(e => !sourceEntities.has(migrationKey(e)))) p.add('ambiguous-source', page.path, '来源页面引用的实体存在', false, false, page.evidence);
    }
    for (const page of p.actual.records as MigrationPage[]) {
      if (page.status === null || page.finalPath === null || !page.contentComplete) p.limitations.push('目标 URL 缺少实际响应或完整内容提取：' + page.path);
      if (page.entities.some(e => !targetEntities.has(migrationKey(e)))) {
        p.add('dangling-reference', page.path, '目标页面引用的实体存在', false, targetEntitiesTrusted, page.evidence);
        if (!targetEntitiesTrusted) p.limitations.push('目标实体全集未验证，无法确认页面引用是否悬空。');
      }
    }
  });
  const entityCheck = check('entities', baseline.entities, target.entities, 'target-data', e => migrationKey(e.key), new Set(baseline.rules.allowedExtraEntities.map(migrationKey)));
  const extras = new Set(baseline.rules.allowedExtraRelations.map(relationKey));
  result.checks.push(entityCheck,
    check('stored-relations', baseline.relations, target.storedRelations, 'target-data', relationKey, extras),
    check('output-relations', baseline.relations, target.outputRelations, 'target-response', relationKey, extras),
    check('pages', baseline.pages, target.pages, 'target-response', p => p.path, new Set(), (expected, actual, _, add) => {
      if (expected.status !== null && actual.status !== null && expected.finalPath !== null && actual.finalPath !== null) {
        const response = (p: MigrationPage) => ({ status: p.status, finalPath: p.finalPath, redirects: p.redirects });
        if (canonical(response(expected)) !== canonical(response(actual))) add('response', expected.path, response(expected), response(actual), true, [...expected.evidence, ...actual.evidence]);
      }
      const sequence = (p: MigrationPage) => expected.ordered ? p.entities.map(migrationKey) : p.entities.map(migrationKey).sort();
      if (canonical(sequence(expected)) !== canonical(sequence(actual))) add('order', expected.path, sequence(expected), sequence(actual), actual.status !== null && actual.contentComplete && expected.contentComplete, [...expected.evidence, ...actual.evidence]);
    }));
  result.state = result.checks.some(c => c.differences.some(d => d.confirmed)) ? 'incomplete'
    : binding && scopeReady && result.checks.every(c => c.status === 'verified') ? 'complete' : 'unverified';
  return result;
}

/** Same-baseline, host-computed change; a model's improved flag is not an input. */
export function compareMigrationRuns(previous: MigrationCheckRun, current: MigrationCheckRun) {
  const comparable = previous.baselineHash !== null && previous.baselineHash === current.baselineHash
    && previous.manifestId === current.manifestId && previous.manifestRevision === current.manifestRevision
    && previous.siteId === current.siteId && previous.inputVersionId === current.inputVersionId && previous.checkerVersion === current.checkerVersion
    && current.round > previous.round;
  const keys = (run: MigrationCheckRun) => new Set(run.checks.flatMap(c => c.differences.filter(d => d.confirmed).map(d => d.id)));
  const before = keys(previous), after = keys(current);
  const lostVerification = current.limitations.length > 0 || current.checks.some(c => c.status === 'unverified' || c.limitations.length > 0 || c.differences.some(d => !d.confirmed));
  const resolved = comparable && !lostVerification ? [...before].filter(id => !after.has(id)) : [];
  const introduced = comparable ? [...after].filter(id => !before.has(id)) : [];
  return { comparable, resolved, introduced, remaining: [...after], improved: comparable && !lostVerification ? resolved.length > 0 && introduced.length === 0 : null };
}

/** Append-only baseline protection; shrinking a scope needs a separate explicit scope decision. */
export function assertMigrationBaselinePreserved(old: MigrationBaseline | undefined, next: MigrationBaseline | undefined) {
  if (!old) return;
  if (!next || old.inputVersionId !== next.inputVersionId || old.scope.kind !== next.scope.kind
    || old.scope.description !== next.scope.description || old.rules.preserveRelationOrder !== next.rules.preserveRelationOrder
    || canonical(old.rules.allowedExtraEntities) !== canonical(next.rules.allowedExtraEntities)
    || canonical(old.rules.allowedExtraRelations) !== canonical(next.rules.allowedExtraRelations)) throw new Error('不得移除或改变固定迁移基线及核对规则');
  const contains = <T>(before: T[], after: T[], key: (r: T) => string) => {
    const set = new Set(after.map(key)); return before.every(r => set.has(key(r)));
  };
  if (!contains(old.entities.records, next.entities.records, e => migrationKey(e.key))
    || !contains(old.relations.records, next.relations.records, r => canonical({ category: r.category, entity: r.entity, position: r.position }))
    || !contains(old.pages.records, next.pages.records, p => canonical({ ...p, evidence: [] }))) throw new Error('不得缩减已固定迁移实体、关系、分页或顺序');
}
