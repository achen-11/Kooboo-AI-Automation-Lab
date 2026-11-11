import { matchesDispositionFilter, type DispositionFilter, type ItemDisposition } from './dispositions.js';
export interface ResourceFolder { id: string; name: string; parentId?: string | null; createdAt: number }
export interface ResourceFolderNode extends ResourceFolder { depth: number; path: string; ancestors: string[]; hasChildren: boolean }

export function resourceFolderTree(folders: readonly ResourceFolder[]): ResourceFolderNode[] {
  const children = new Map<string | null, ResourceFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId || null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(folder);
  }
  const result: ResourceFolderNode[] = [], seen = new Set<string>();
  const pending = (children.get(null) || []).map(folder => ({ folder, ancestors: [] as string[], path: folder.name })).reverse();
  while (pending.length) {
    const { folder, ancestors, path } = pending.pop()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    const nested = children.get(folder.id) || [];
    result.push({ ...folder, depth: ancestors.length, path, ancestors, hasChildren: nested.length > 0 });
    for (let index = nested.length - 1; index >= 0; index--) pending.push({ folder: nested[index], ancestors: [...ancestors, folder.id], path: `${path} / ${nested[index].name}` });
  }
  return result;
}

export function resourceFolderDescendants(folders: readonly ResourceFolder[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const folder of folders) if (folder.parentId) {
    if (!children.has(folder.parentId)) children.set(folder.parentId, []);
    children.get(folder.parentId)!.push(folder.id);
  }
  const result = new Set<string>(), pending = [id];
  while (pending.length) {
    const next = pending.pop()!;
    if (result.has(next)) continue;
    result.add(next);
    pending.push(...(children.get(next) || []));
  }
  return result;
}

export interface ResourceFilters { query: string; scenario: string; folder: string; generated: string; disposition?: DispositionFilter | '' }

export function resourceSiteCounts(sites: readonly { resourceId: string; disposition?: ItemDisposition }[]) {
  const counts = new Map<string, number>();
  for (const site of sites) {
    if (site.disposition?.state === 'discarded') continue;
    counts.set(site.resourceId, (counts.get(site.resourceId) || 0) + 1);
  }
  return counts;
}

export function filterResources<T extends { id: string; folderId?: string | null; disposition?: ItemDisposition; scenario: string; name: string; description: string; contentUrl: string; externalId: string; externalSource: string }>(resources: readonly T[], counts: ReadonlyMap<string, number>, filters: ResourceFilters, folders: readonly ResourceFolder[] = []): T[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const folderIds = resourceFolderDescendants(folders, filters.folder);
  return resources.filter(item =>
    matchesDispositionFilter(item.disposition, filters.disposition) &&
    (!filters.folder || (filters.folder === 'ungrouped' ? !item.folderId : folderIds.has(item.folderId || ''))) &&
    (!filters.scenario || item.scenario === filters.scenario) &&
    (!filters.generated || (filters.generated === 'yes' ? !!counts.get(item.id) : !counts.get(item.id))) &&
    (!query || [item.name, item.description, item.contentUrl, item.externalId, item.externalSource].join(' ').toLocaleLowerCase().includes(query)));
}
