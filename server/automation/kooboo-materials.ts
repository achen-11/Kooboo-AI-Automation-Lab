import { randomUUID } from 'node:crypto';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import { materialPath } from '../../shared/materials.js';
import type { ContextRequest } from './generation-context.js';
import {
  inferImageMimeType,
  isImageMaterial,
  koobooSafeFilename,
  legacyCmsFileDestination,
  materialDestination,
  readMaterial,
} from './materials.js';

export interface UploadedSiteMaterial {
  file: MaterialFile;
  id?: string;
  name: string;
  url?: string;
  relativeUrl?: string;
  key?: string;
  mimeType: string;
  size: number;
  storage: 'cmsFile' | 'mediaLibrary';
  mapping: string;
}

export interface TaskMaterialEntry {
  name: string;
  id: string;
  destination: string;
  type: string;
  size: number;
  sha256: string;
  storage: 'kfile' | 'file' | 'mediaLibrary';
  imageId?: string;
}

export function resolveTaskMaterialEntry(
  task: Pick<AutomationTask, 'resourceId' | 'versionId' | 'generation'>,
  file: MaterialFile,
): TaskMaterialEntry {
  const dest = materialDestination(task.resourceId, task.versionId, file);
  if (dest.text) {
    return {
      name: file.name,
      id: file.id,
      destination: dest.path,
      type: file.type,
      size: file.size,
      sha256: file.sha256,
      storage: 'kfile',
    };
  }
  if (dest.media) {
    const cachedMedia = task.generation?.importedMedia?.[file.id];
    if (cachedMedia && cachedMedia.sha256 === file.sha256) {
      return {
        name: file.name,
        id: file.id,
        destination: cachedMedia.url,
        type: file.type,
        size: file.size,
        sha256: file.sha256,
        storage: 'mediaLibrary',
        ...(cachedMedia.id ? { imageId: cachedMedia.id } : {}),
      };
    }
    if (task.generation?.importedMaterials?.[file.id] === file.sha256) {
      const legacy = legacyCmsFileDestination(task.resourceId, task.versionId, file);
      return {
        name: file.name,
        id: file.id,
        destination: legacy.path,
        type: file.type,
        size: file.size,
        sha256: file.sha256,
        storage: 'file',
      };
    }
    return {
      name: file.name,
      id: file.id,
      destination: dest.path,
      type: file.type,
      size: file.size,
      sha256: file.sha256,
      storage: 'mediaLibrary',
    };
  }
  return {
    name: file.name,
    id: file.id,
    destination: dest.path,
    type: file.type,
    size: file.size,
    sha256: file.sha256,
    storage: 'file',
  };
}

/** Merge original frozen files with task-level supplemental files, keeping newer supplement when paths collide. */
export function mergeTaskMaterials(
  inputFiles: readonly MaterialFile[],
  supplementalFiles?: readonly MaterialFile[] | null,
): MaterialFile[] {
  if (!supplementalFiles?.length) return [...inputFiles];
  const byPath = new Map<string, MaterialFile>();
  for (const file of inputFiles) {
    byPath.set(materialPath(file.name).toLowerCase(), file);
  }
  for (const file of supplementalFiles) {
    byPath.set(materialPath(file.name).toLowerCase(), file);
  }
  return [...byPath.values()];
}

function safeUploadBasename(file: MaterialFile): string {
  const logical = materialPath(file.name);
  const original = logical.split('/').pop()!;
  return koobooSafeFilename(file, original);
}

export async function uploadMaterialsToKoobooSite(params: {
  task: AutomationTask;
  siteId: string;
  files: readonly MaterialFile[];
  apiOrigin: string;
  token: string;
  request: ContextRequest;
  directory: string;
  signal: AbortSignal;
  mode?: 'materials' | 'mediaLibrary';
  mediaFolder?: string;
  fetcher?: typeof fetch;
  onUploaded?: (file: MaterialFile, result: UploadedSiteMaterial) => void;
}): Promise<{ uploaded: UploadedSiteMaterial[]; newlyImportedCount: number }> {
  const { task, siteId, files, apiOrigin, token, request, directory, signal } = params;
  const mode = params.mode || 'materials';
  const fetcher = params.fetcher || fetch;
  const results: UploadedSiteMaterial[] = [];
  let newlyImportedCount = 0;

  for (const file of files) {
    signal.throwIfAborted();
    const bytes = readMaterial(directory, file);
    const dest = materialDestination(task.resourceId, task.versionId, file);
    const { filename, folder, text, path } = dest;
    const isExplicitMedia = mode === 'mediaLibrary' && isImageMaterial(file);
    const isMaterialMedia = mode === 'materials' && dest.media;

    if (isExplicitMedia || isMaterialMedia) {
      const alreadyImported = isMaterialMedia && task.generation?.importedMaterials?.[file.id] === file.sha256;
      if (alreadyImported) {
        const cachedMedia = task.generation?.importedMedia?.[file.id];
        if (cachedMedia && cachedMedia.sha256 === file.sha256) {
          results.push({
            file,
            ...(cachedMedia.id ? { id: cachedMedia.id } : {}),
            name: file.name,
            url: cachedMedia.url,
            relativeUrl: cachedMedia.url,
            mimeType: inferImageMimeType(dest.filename, file.type),
            size: bytes.length,
            storage: 'mediaLibrary',
            mapping: `${file.name} → media:${cachedMedia.url}`,
          });
        } else {
          const legacyPath = legacyCmsFileDestination(task.resourceId, task.versionId, file).path;
          results.push({
            file,
            name: file.name,
            url: legacyPath,
            relativeUrl: legacyPath,
            mimeType: file.type || 'application/octet-stream',
            size: bytes.length,
            storage: 'cmsFile',
            mapping: `${file.name} → ${legacyPath}`,
          });
        }
        continue;
      }

      const targetFolder = isExplicitMedia
        ? '/' + String(params.mediaFolder || `automation-uploads/${task.id}`).replace(/^\/+|\/+$/g, '')
        : '/' + folder.replace(/^\/+|\/+$/g, '');
      const uploadName = isExplicitMedia ? safeUploadBasename(file) : filename;
      const mimeType = inferImageMimeType(uploadName, file.type);
      const form = new FormData();
      form.append('Folder', targetFolder);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), uploadName);
      const url = new URL('/_api/v2/Upload/Image', apiOrigin);
      url.searchParams.set('SiteId', siteId);
      url.searchParams.set('provider', 'default');
      const response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`媒体库图片上传失败（HTTP ${response.status}）：${file.name}`);
      const receipt = await response.json();
      const item = Array.isArray(receipt) && receipt.length ? receipt[0] : undefined;
      const hasValidId = typeof item?.id === 'string' && item.id.trim().length > 0;
      const hasValidUrl = typeof item?.url === 'string' && item.url.trim().length > 0;
      if (!item || (!hasValidId && !hasValidUrl)) {
        throw new Error(`媒体库上传回执无效：${file.name}`);
      }
      if (typeof item.size === 'number' && item.size !== bytes.length) {
        throw new Error(`媒体库上传回执大小不匹配：${file.name}`);
      }
      const imageId = hasValidId ? item.id.trim() : undefined;
      const resolvedUrl = hasValidUrl ? item.url.trim() : isMaterialMedia ? path : '';
      task.generation ??= {};
      task.generation.importedMaterials ??= {};
      task.generation.importedMaterials[file.id] = file.sha256;
      task.generation.importedMedia ??= {};
      task.generation.importedMedia[file.id] = {
        sha256: file.sha256,
        ...(imageId ? { id: imageId } : {}),
        url: resolvedUrl,
      };
      const uploadedItem: UploadedSiteMaterial = {
        file,
        ...(imageId ? { id: imageId } : {}),
        name: file.name,
        url: resolvedUrl,
        relativeUrl: resolvedUrl,
        mimeType,
        size: bytes.length,
        storage: 'mediaLibrary',
        mapping: `${file.name} → media:${resolvedUrl || imageId || ''}`,
      };
      results.push(uploadedItem);
      newlyImportedCount++;
      params.onUploaded?.(file, uploadedItem);
      continue;
    }

    const mapping = `${file.name} → ${text ? 'kfile:' : ''}${path}`;
    const alreadyImported = task.generation?.importedMaterials?.[file.id] === file.sha256;
    if (!alreadyImported) {
      if (text) {
        const response = await request(
          'AI/CallFunction',
          {
            name: 'run_kscript',
            callId: randomUUID(),
            arguments: { code: `k.file.write(${JSON.stringify(path)}, ${JSON.stringify(bytes.toString('utf8'))}); return true;` },
          },
          siteId,
        );
        const content = response?.contents?.[0];
        if (!content || content.isError || content.result?.error || content.result === false) {
          throw new Error(`资料写入未确认：${file.name}`);
        }
      } else {
        const form = new FormData();
        form.append('Folder', folder);
        form.append('file', new Blob([new Uint8Array(bytes)], { type: file.type }), filename);
        const url = new URL('/_api/v2/Upload/File', apiOrigin);
        url.searchParams.set('SiteId', siteId);
        const response = await fetcher(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`上传资料失败（HTTP ${response.status}）：${file.name}`);
        const receipt = await response.json();
        // Kooboo's ApiManager consumes boolean results; v2 serializes a successful
        // bool-returning Upload/File as null. Never infer persistence from that alone.
        if (receipt !== true && receipt !== null) throw new Error(`上传资料回执异常：${file.name}`);
        const query = new URLSearchParams({ path: '/' + folder, keyword: filename, pageNr: '1', pageSize: '100' });
        let confirmed = false;
        for (let page = 1; !confirmed; page++) {
          query.set('pageNr', String(page));
          const listing = await request('File/List?' + query, undefined, siteId);
          if (listing?.errorMessage || !Array.isArray(listing?.files?.list)) {
            throw new Error(`读取上传资料确认失败：${file.name}`);
          }
          confirmed = listing.files.list.some((item: any) => item.url === path && item.size === bytes.length);
          if (confirmed || page >= listing.files.totalPages) break;
          if (!Number.isInteger(listing.files.totalPages) || listing.files.totalPages > 1000) {
            throw new Error(`上传资料目录分页异常：${file.name}`);
          }
        }
        if (!confirmed) throw new Error(`上传资料未确认（目标路径或大小不匹配）：${file.name}`);
      }
      task.generation ??= {};
      task.generation.importedMaterials ??= {};
      task.generation.importedMaterials[file.id] = file.sha256;
      newlyImportedCount++;
    }

    const uploadedItem: UploadedSiteMaterial = {
      file,
      name: file.name,
      ...(text ? { key: path } : { url: path, relativeUrl: path }),
      mimeType: file.type || 'application/octet-stream',
      size: bytes.length,
      storage: 'cmsFile',
      mapping,
    };
    results.push(uploadedItem);
    if (!alreadyImported) params.onUploaded?.(file, uploadedItem);
  }

  return { uploaded: results, newlyImportedCount };
}

export async function syncMaterialManifestToSite(params: {
  task: AutomationTask;
  siteId: string;
  allFiles: readonly MaterialFile[];
  request: ContextRequest;
}): Promise<string> {
  const { task, siteId, allFiles, request } = params;
  const manifestPath = `_automation-manifests/${task.id}.json`;
  const mappings = allFiles.map(file => {
    const entry = resolveTaskMaterialEntry(task, file);
    return {
      name: entry.name,
      id: entry.id,
      destination: entry.destination,
      storage: entry.storage,
      ...(entry.imageId ? { imageId: entry.imageId } : {}),
    };
  });
  const result = await request(
    'AI/CallFunction',
    {
      name: 'run_kscript',
      callId: randomUUID(),
      arguments: { code: `k.file.write(${JSON.stringify(manifestPath)}, ${JSON.stringify(JSON.stringify(mappings))}); return true;` },
    },
    siteId,
  );
  const content = result?.contents?.[0];
  if (!content || content.isError || content.result === false || content.result?.error) {
    throw new Error('资料映射清单写入未确认');
  }
  return manifestPath;
}
