import { z } from 'zod';

const text = z.string().min(1).max(4000);
export const migrationKeySchema = z.object({ namespace: text, kind: text, id: text }).strict();
export const migrationEvidenceSchema = z.object({
  taskId: text, name: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_.-]+$/).refine(s => s !== '.' && s !== '..'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), locator: text,
}).strict();
const evidence = z.array(migrationEvidenceSchema).max(10000);
const limitations = z.array(text).max(1000);
const coverage = z.object({ state: z.enum(['complete', 'partial', 'unknown']), limitations, evidence }).strict()
  .refine(v => v.state === 'complete' || v.limitations.length > 0, '未知或不完整覆盖必须说明缺口');
const section = <T extends z.ZodType>(record: T) => z.object({
  coverage: z.enum(['complete', 'partial', 'unavailable']), limitations, evidence,
  records: z.array(record).max(200000),
}).strict().refine(v => v.coverage === 'complete' || v.limitations.length > 0, '不完整快照必须说明缺口');
const entity = z.object({ key: migrationKeySchema, recordId: text.optional(), recordType: text.optional(), label: text.optional(), evidence }).strict();
const relationKey = z.object({ category: migrationKeySchema, entity: migrationKeySchema }).strict();
const relation = relationKey.extend({ position: z.number().int().nonnegative().optional(), evidence }).strict();
// Preserve path semantics rather than normalizing .aspx, _N, queries or trailing slashes.
const path = z.string().min(1).max(8000).refine(s => s.startsWith('/') && !s.startsWith('//') && !/[\s#\\]/.test(s), '需要无 fragment 的站内路径');
const page = z.object({
  path, status: z.number().int().min(100).max(599).nullable(), finalPath: path.nullable(),
  redirects: z.array(z.object({ path, status: z.number().int().min(300).max(399) }).strict()).max(30),
  entities: z.array(migrationKeySchema).max(200000), ordered: z.boolean(), contentComplete: z.boolean(), evidence,
}).strict();
export const migrationBaselineSchema = z.object({
  schemaVersion: z.literal(1), inputVersionId: text,
  scope: z.object({
    kind: z.enum(['site', 'subset']), description: text, authorization: evidence,
    sourceCoverage: coverage, scopeCoverage: coverage,
  }).strict().refine(v => v.kind !== 'subset' || v.authorization.length > 0, '有限迁移范围必须引用明确的范围决定'),
  entities: section(entity), relations: section(relation), pages: section(page),
  rules: z.object({
    preserveRelationOrder: z.boolean(), allowedExtraEntities: z.array(migrationKeySchema).max(200000),
    allowedExtraRelations: z.array(relationKey).max(200000),
  }).strict(),
}).strict();
export const migrationTargetSchema = z.object({
  schemaVersion: z.literal(1), inputVersionId: text,
  observation: z.object({ siteId: text, siteRevision: text, capturedAt: z.number().int().nonnegative() }).strict(),
  entities: section(entity), storedRelations: section(relation), outputRelations: section(relation), pages: section(page),
}).strict();
export const migrationArtifactSchema = z.object({
  taskId: text, name: migrationEvidenceSchema.shape.name, sha256: migrationEvidenceSchema.shape.sha256,
  size: z.number().int().nonnegative(), layer: z.enum(['source', 'target-data', 'target-response', 'code-derived', 'scope-decision']),
  inputVersionId: text, capturedAt: z.number().int().nonnegative().nullable(), siteId: text.optional(), siteRevision: text.optional(),
  actor: z.literal('human').optional(),
}).strict().refine(v => v.layer !== 'scope-decision' || v.actor === 'human', '范围决定必须来自用户');
export const migrationRunContextSchema = z.object({
  id: text, taskId: text, inputVersionId: text, siteId: text, siteRevision: text,
  round: z.number().int().nonnegative(), checkedAt: z.number().int().nonnegative(),
}).strict();
