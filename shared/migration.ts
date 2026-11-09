/** Logical keys describe source identity, never a title or a target database ID. */
export interface MigrationKey { namespace: string; kind: string; id: string }
export interface MigrationEvidenceRef { taskId: string; name: string; sha256: string; locator: string }
export type MigrationEvidenceLayer = 'source' | 'target-data' | 'target-response' | 'code-derived' | 'scope-decision';
export interface MigrationArtifact {
  taskId: string; name: string; sha256: string; size: number;
  layer: MigrationEvidenceLayer; inputVersionId: string; capturedAt: number | null;
  siteId?: string; siteRevision?: string;
  actor?: 'human';
}
export interface MigrationCoverage {
  state: 'complete' | 'partial' | 'unknown'; limitations: string[]; evidence: MigrationEvidenceRef[];
}
export interface MigrationSection<T> {
  coverage: 'complete' | 'partial' | 'unavailable'; limitations: string[];
  evidence: MigrationEvidenceRef[]; records: T[];
}
export interface MigrationEntity {
  key: MigrationKey; recordId?: string; recordType?: string; label?: string; evidence: MigrationEvidenceRef[];
}
export interface MigrationRelation {
  category: MigrationKey; entity: MigrationKey; position?: number; evidence: MigrationEvidenceRef[];
}
export interface MigrationPage {
  /** Paths retain extensions, page numbers and query strings. */
  path: string; status: number | null; finalPath: string | null;
  redirects: { path: string; status: number }[];
  entities: MigrationKey[]; ordered: boolean; contentComplete: boolean; evidence: MigrationEvidenceRef[];
}
/** Optional, versioned extension of the existing RequirementManifest. */
export interface MigrationBaseline {
  schemaVersion: 1; inputVersionId: string;
  scope: {
    kind: 'site' | 'subset'; description: string;
    /** Explicit scope decisions, required for a subset; not inferred from crawled URLs. */
    authorization: MigrationEvidenceRef[];
    sourceCoverage: MigrationCoverage; scopeCoverage: MigrationCoverage;
  };
  entities: MigrationSection<MigrationEntity>;
  relations: MigrationSection<MigrationRelation>;
  pages: MigrationSection<MigrationPage>;
  rules: {
    preserveRelationOrder: boolean;
    allowedExtraEntities: MigrationKey[];
    allowedExtraRelations: { category: MigrationKey; entity: MigrationKey }[];
  };
}
export interface MigrationTargetSnapshot {
  schemaVersion: 1; inputVersionId: string;
  observation: { siteId: string; siteRevision: string; capturedAt: number };
  entities: MigrationSection<MigrationEntity>;
  storedRelations: MigrationSection<MigrationRelation>;
  outputRelations: MigrationSection<MigrationRelation>;
  pages: MigrationSection<MigrationPage>;
}
export type MigrationCheckId = 'entities' | 'stored-relations' | 'output-relations' | 'pages';
export interface MigrationDifference {
  id: string; checkId: MigrationCheckId;
  code: 'missing' | 'unexpected' | 'duplicate' | 'mapping-conflict' | 'dangling-reference' | 'order' | 'response' | 'ambiguous-source';
  subject: string; expected: unknown; actual: unknown;
  /** Code-derived and incomplete observations remain diagnostic, not observed failures. */
  confirmed: boolean; evidence: MigrationEvidenceRef[];
}
export interface MigrationCheckResult {
  id: MigrationCheckId; status: 'verified' | 'partial' | 'unverified';
  expectedCount: number; actualCount: number | null;
  expectedKeys?: string[]; checkedKeys?: string[];
  differences: MigrationDifference[]; limitations: string[]; evidence: MigrationEvidenceRef[];
}
export interface MigrationRunContext {
  id: string; taskId: string; inputVersionId: string; siteId: string; siteRevision: string;
  round: number; checkedAt: number;
}
export interface MigrationCheckRun extends MigrationRunContext {
  checkerVersion: string; manifestId: string; manifestRevision: number;
  baselineHash: string | null;
  state: 'complete' | 'incomplete' | 'unverified';
  /** Source-site coverage is retained even when an explicitly limited scope can pass. */
  sourceCoverage: MigrationCoverage | null; scopeCoverage: MigrationCoverage | null;
  limitations: string[]; checks: MigrationCheckResult[];
}
