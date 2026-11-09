/** Offline adapter for the saved manwei capture format. No HTTP, model calls or code execution. */
import { z } from 'zod';
import type { MigrationBaseline, MigrationEntity, MigrationEvidenceRef, MigrationKey, MigrationPage, MigrationRelation, MigrationRunContext, MigrationSection, MigrationTargetSnapshot } from '../../../shared/migration.js';
import type { VerifiedMigrationArtifact } from '../migration-check.js';

export interface ManweiSavedCapture { artifact: VerifiedMigrationArtifact; value: unknown }
/** Selected by the host from the current implementation, never inferred from stale category fields. */
export interface ManweiSavedOptions { contentFolderId?: string; relationFolderId?: string }
const sourceSchema = z.object({ kind: z.literal('source'), url: z.url(), status: z.number().int(), body: z.string(), truncated: z.boolean() });
const implementationSchema = z.object({ request: z.object({ kind: z.string(), id: z.string().optional(), page: z.number().optional() }), value: z.unknown() });
const summaryRow = z.object({ id: z.string(), textValues: z.object({ sourceId: z.string(), title: z.string() }) });
const listingSchema = z.object({ list: z.array(summaryRow), totalCount: z.number().int().nonnegative(), totalPages: z.number().int().positive(), pageNr: z.number().int().positive(), pageSize: z.number().int().positive() });
const relationListingSchema = listingSchema.extend({ list: z.array(z.object({ id: z.string(), textValues: z.object({ catId: z.string().regex(/^\d+$/), showId: z.string().regex(/^\d+$/) }) })) });
const categorySchema = z.object({ id: z.string(), properties: z.object({ sourceId: z.string(), kind: z.literal('category'), linkUrl: z.string() }) });
const templateSchema = z.object({ name: z.literal('category'), body: z.string() });
// The known archived implementation is simulated declaratively, never evaluated.
export const MANWEI_SAVED_CATEGORY_SHA256 = 'd12ccc968c2e8d00e7a1cf705ab354e851c4184329a59ff3236fee52e1f485c4';
const ref = (capture: ManweiSavedCapture, locator: string): MigrationEvidenceRef => ({ taskId: capture.artifact.taskId, name: capture.artifact.name, sha256: capture.artifact.sha256, locator });
const key = (id: string, kind: string): MigrationKey => ({ namespace: 'manwei-sav.com/cn', kind, id });
const section = <T>(records: T[], evidence: MigrationEvidenceRef[], limitations: string[]): MigrationSection<T> => ({
  records, evidence, limitations: [...new Set(limitations)], coverage: limitations.length ? (records.length ? 'partial' : 'unavailable') : 'complete',
});

export function adaptManweiSavedEvidence(captures: ManweiSavedCapture[], context: MigrationRunContext, options: ManweiSavedOptions = {}): { baseline: MigrationBaseline; target: MigrationTargetSnapshot } {
  if (options.contentFolderId && options.contentFolderId === options.relationFolderId) throw new Error('实体与关系目录不能相同');
  const sourceProblems: string[] = [], targetProblems: string[] = [], relationProblems: string[] = [];
  const sourcePages: { category: string; page: number; maxPage: number; path: string; ids: string[]; contentComplete: boolean; evidence: MigrationEvidenceRef }[] = [];
  const listings: { value: z.infer<typeof listingSchema>; capture: ManweiSavedCapture }[] = [];
  const relationListings: { value: z.infer<typeof relationListingSchema>; capture: ManweiSavedCapture }[] = [];
  const categories = new Map<string, { id: string; links: string[]; evidence: MigrationEvidenceRef }>();
  let template: ManweiSavedCapture | undefined;
  for (const capture of captures) {
    if (capture.artifact.inputVersionId !== context.inputVersionId) throw new Error('保存证据属于其他输入版本');
    const source = sourceSchema.safeParse(capture.value);
    if (source.success && capture.artifact.layer === 'source') {
      const url = new URL(source.data.url);
      if (url.hostname !== 'manwei-sav.com') continue;
      const route = /^\/cn\/category\/(\d+)(?:_(\d+))?(?:\.aspx)?$/.exec(url.pathname);
      if (!route || url.search) continue;
      if (source.data.status !== 200 || source.data.truncated) { sourceProblems.push('来源分类采集失败或截断：' + url.pathname); continue; }
      // Scope identities to the archived detail-list layouts; navigation alone cannot certify an empty list.
      const lists = [...source.data.body.matchAll(/<ul\b[^>]*class=["'](?:proud_list|news|case)["'][^>]*>([\s\S]*?)<\/ul>/gi)];
      const contentComplete = lists.length > 0;
      if (!contentComplete) sourceProblems.push('来源分类没有已识别的详情列表版式，保留入口待核验：' + url.pathname);
      const ids = [...new Set(lists.flatMap(m => [...m[1].matchAll(/href=["']\/cn\/show\/(\d+)["']/gi)].map(link => link[1])))];
      const linkedPages = [...source.data.body.matchAll(/href=["']\/cn\/category\/(\d+)_(\d+)\.aspx["']/gi)].filter(m => m[1] === route[1]).map(m => Number(m[2]));
      sourcePages.push({ category: route[1], page: Number(route[2] || 1), maxPage: Math.max(Number(route[2] || 1), ...linkedPages), path: url.pathname, ids, contentComplete, evidence: ref(capture, 'body:category-detail-links') });
      continue;
    }
    const implementation = implementationSchema.safeParse(capture.value);
    if (!implementation.success) continue;
    const { request, value } = implementation.data;
    if (request.kind === 'content' && capture.artifact.layer === 'target-data') {
      if (options.relationFolderId && request.id === options.relationFolderId) {
        const parsed = relationListingSchema.safeParse(value);
        if (!parsed.success || parsed.data.pageNr !== request.page) relationProblems.push('无法解析关系目录分页：' + capture.artifact.name);
        else relationListings.push({ value: parsed.data, capture });
        continue;
      }
      if (options.contentFolderId && request.id !== options.contentFolderId) continue;
      const parsed = listingSchema.safeParse(value);
      if (!parsed.success || parsed.data.pageNr !== request.page) targetProblems.push('无法解析完整内容分页：' + capture.artifact.name);
      else listings.push({ value: parsed.data, capture });
    }
    if (request.kind === 'contentItem' && capture.artifact.layer === 'target-data') {
      const parsed = categorySchema.safeParse(value);
      if (!parsed.success) continue; // Detail captures use another shape and are not category relation records.
      if (request.id !== parsed.data.id) { relationProblems.push('分类详情请求与记录身份不一致'); continue; }
      const { sourceId, linkUrl } = parsed.data.properties;
      const links = linkUrl.split(',').map(s => s.trim()).filter(Boolean);
      const old = categories.get(sourceId);
      if (old && JSON.stringify(old.links) !== JSON.stringify(links)) relationProblems.push('分类保存证据互相矛盾：' + sourceId);
      categories.set(sourceId, { id: parsed.data.id, links, evidence: ref(capture, 'value.properties.linkUrl') });
    }
    const code = templateSchema.safeParse(value);
    if (request.kind === 'page' && code.success && capture.artifact.layer === 'code-derived' && capture.artifact.sha256 === MANWEI_SAVED_CATEGORY_SHA256) template = capture;
  }
  sourcePages.sort((a, b) => a.category.localeCompare(b.category, 'en', { numeric: true }) || a.page - b.page || a.path.localeCompare(b.path, 'en'));
  const sourceEntities = new Map<string, MigrationEntity>(), relations: MigrationRelation[] = [], pages: MigrationPage[] = [];
  const catIds = new Set(sourcePages.map(p => p.category));
  for (const category of catIds) {
    const catPages = sourcePages.filter(p => p.category === category), seenPage = new Set<number>(), seenIds = new Set<string>();
    let position = 0;
    for (const page of catPages) {
      if (seenPage.has(page.page)) { sourceProblems.push('来源列表页有重复或别名，需明确映射：' + page.path); continue; }
      seenPage.add(page.page);
      sourceEntities.set('category:' + category, { key: key(category, 'category'), evidence: [page.evidence] });
      for (const id of page.ids) {
        if (!sourceEntities.has('detail:' + id)) sourceEntities.set('detail:' + id, { key: key(id, 'detail'), evidence: [page.evidence] });
        if (seenIds.has(id)) { sourceProblems.push('来源同分类跨页重复实体，需要人工解释：' + category + '/' + id); continue; }
        seenIds.add(id); relations.push({ category: key(category, 'category'), entity: key(id, 'detail'), position: position++, evidence: [page.evidence] });
      }
      pages.push({ path: page.path, status: 200, finalPath: page.path, redirects: [], entities: page.ids.map(id => key(id, 'detail')), ordered: true, contentComplete: page.contentComplete, evidence: [page.evidence] });
    }
    const max = Math.max(...catPages.map(p => p.maxPage));
    for (let p = 1; p <= max; p++) if (!seenPage.has(p)) sourceProblems.push('来源缺少已发现列表页：' + category + '/' + p);
  }
  if (!sourcePages.length) sourceProblems.push('未读取到可解析的来源分类列表证据');
  const sourceRefs = sourcePages.map(p => p.evidence);
  const scopeGap = '仅覆盖保存证据发现的分类、详情标识及列表分页；详情正文、附件、孤立入口与全源站覆盖尚未验证。';
  const baseline: MigrationBaseline = {
    schemaVersion: 1, inputVersionId: context.inputVersionId,
    scope: { kind: 'site', description: 'manwei 原全站迁移范围；不将已发现集合改成用户授权的有限范围', authorization: [],
      sourceCoverage: { state: 'unknown', limitations: [scopeGap], evidence: sourceRefs },
      scopeCoverage: { state: 'partial', limitations: [scopeGap], evidence: sourceRefs } },
    entities: section([...sourceEntities.values()], sourceRefs, sourceProblems), relations: section(relations, sourceRefs, sourceProblems), pages: section(pages, sourceRefs, sourceProblems),
    rules: { preserveRelationOrder: true, allowedExtraEntities: [], allowedExtraRelations: [] },
  };
  listings.sort((a, b) => a.value.pageNr - b.value.pageNr || a.capture.artifact.name.localeCompare(b.capture.artifact.name, 'en'));
  const dataPages = new Map<number, typeof listings[number]>();
  if (new Set(listings.map(l => implementationSchema.parse(l.capture.value).request.id)).size > 1) targetProblems.push('保存分页来自多个内容目录，不能合并为一个完整目标全集');
  for (const listing of listings) {
    const old = dataPages.get(listing.value.pageNr);
    if (old && JSON.stringify(old.value.list) !== JSON.stringify(listing.value.list)) targetProblems.push('同页保存证据互相矛盾：' + listing.value.pageNr);
    else dataPages.set(listing.value.pageNr, listing);
  }
  const inventory = listings[0];
  if (!inventory) targetProblems.push('目标内容分页证据不存在');
  else {
    const totalPages = inventory.value.totalPages;
    if (totalPages > 10000) throw new Error('目标保存分页数量异常');
    for (let p = 1; p <= totalPages; p++) if (!dataPages.has(p)) targetProblems.push('缺少目标内容分页：' + p);
    for (const { value } of dataPages.values()) if (value.totalPages !== totalPages || value.totalCount !== inventory.value.totalCount || value.pageSize !== inventory.value.pageSize) targetProblems.push('目标分页元数据不一致');
    if ([...dataPages.values()].reduce((sum, p) => sum + p.value.list.length, 0) !== inventory.value.totalCount) targetProblems.push('目标分页条数与声明总量不一致');
  }
  const entities: MigrationEntity[] = [], targetRefs: MigrationEvidenceRef[] = [], titleById = new Map<string, string>();
  for (const { capture, value } of dataPages.values()) {
    targetRefs.push(ref(capture, 'value.list'));
    value.list.forEach((row, index) => {
      entities.push({ key: key(row.textValues.sourceId, catIds.has(row.textValues.sourceId) ? 'category' : 'detail'), recordId: row.id, recordType: 'Content:' + (implementationSchema.parse(capture.value).request.id || 'unknown'), label: row.textValues.title,
        evidence: [ref(capture, 'value.list[' + index + ']')] });
      titleById.set(row.textValues.sourceId, row.textValues.title);
    });
  }
  const stored: MigrationRelation[] = [], predicted: MigrationRelation[] = [], relationRefs: MigrationEvidenceRef[] = [];
  for (const [id, cat] of options.relationFolderId ? [] : categories) {
    relationRefs.push(cat.evidence);
    const summary = entities.find(e => e.key.kind === 'category' && e.key.id === id);
    if (!summary || summary.recordId !== cat.id) relationProblems.push('分类关系证据与目标实体映射不一致：' + id);
    const seenTitle: Record<string, boolean> = {};
    let outputPosition = 0;
    cat.links.forEach((entityId, position) => {
      const row = { category: key(id, 'category'), entity: key(entityId, 'detail'), position, evidence: [cat.evidence] };
      stored.push(row);
      if (!template || outputPosition >= 120 || !titleById.has(entityId)) return;
      const title = titleById.get(entityId)!;
      if (seenTitle[title]) return;
      seenTitle[title] = true;
      predicted.push({ ...row, position: outputPosition++, evidence: [cat.evidence, ref(template, 'value.body:seenTitle[itemTitle]')] });
    });
  }
  if (options.relationFolderId) {
    const pages = new Map<number, typeof relationListings[number]>();
    for (const listing of relationListings) {
      const old = pages.get(listing.value.pageNr);
      if (old && JSON.stringify(old.value) !== JSON.stringify(listing.value)) relationProblems.push('同页关系证据互相矛盾：' + listing.value.pageNr);
      else pages.set(listing.value.pageNr, listing);
      relationRefs.push(ref(listing.capture, 'value.list'));
    }
    const first = relationListings[0]?.value;
    if (!first) relationProblems.push('当前关系目录缺少保存分页证据');
    else {
      if (first.totalPages > 10000) throw new Error('目标关系分页数量异常');
      for (let p = 1; p <= first.totalPages; p++) if (!pages.has(p)) relationProblems.push('缺少目标关系分页：' + p);
      for (const { value, capture } of pages.values()) {
        if (value.totalCount !== first.totalCount || value.totalPages !== first.totalPages || value.pageSize !== first.pageSize || value.pageNr > first.totalPages) relationProblems.push('目标关系分页元数据不一致');
        value.list.forEach((row, index) => stored.push({ category: key(row.textValues.catId, 'category'), entity: key(row.textValues.showId, 'detail'), evidence: [ref(capture, 'value.list[' + index + '].textValues')] }));
      }
      if (stored.length !== first.totalCount) relationProblems.push('目标关系分页条数与声明总量不一致');
    }
    // List insertion order is not an independently verified business order; leave position absent.
  } else for (const id of catIds) if (!categories.has(id)) relationProblems.push('目标分类关系未完整读取：' + id);
  const predictedNotes = [template ? '仅按已校验哈希的保存模板推导，未读取实际目标页面响应。' : '没有受支持的保存模板证据，无法推导输出。'];
  return {
    baseline,
    target: { schemaVersion: 1, inputVersionId: context.inputVersionId,
      observation: { siteId: context.siteId, siteRevision: context.siteRevision, capturedAt: Math.max(0, ...captures.filter(c => c.artifact.layer !== 'source').map(c => c.artifact.capturedAt || 0)) },
      entities: section(entities, targetRefs, targetProblems), storedRelations: section(stored, relationRefs, [...relationProblems, ...targetProblems]),
      outputRelations: section(predicted, template ? [ref(template, 'value.body')] : [], predictedNotes),
      pages: section([], [], ['缺少对应当前目标版本的实际 URL 响应，不能用源码推导证明状态、页序或跳转。']),
    },
  };
}
