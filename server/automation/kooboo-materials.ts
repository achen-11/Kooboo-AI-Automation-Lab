import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../shared/automation.js';
import { materialPath } from '../../shared/materials.js';
import type { ContextRequest } from './generation-context.js';
import { materialDestination, readMaterial } from './materials.js';

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
  return /[\s#%?:<>|*"&]/.test(original)
    ? file.id + (/^\.[a-z0-9]{1,12}$/i.test(extname(original)) ? extname(original) : '.bin')
    : original;
}

const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|svg\+xml|gif)$/i;

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
    const { filename, folder, text, path } = materialDestination(task.resourceId, task.versionId, file);
    const isMedia = mode === 'mediaLibrary' && IMAGE_MIME_RE.test(file.type || '');

    if (isMedia) {
      const targetFolder = '/' + String(params.mediaFolder || `automation-uploads/${task.id}`).replace(/^\/+|\/+$/g, '');
      const uploadName = safeUploadBasename(file);
      const form = new FormData();
      form.append('Folder', targetFolder);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: file.type }), uploadName);
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
      if (!item || (typeof item.id !== 'string' && typeof item.url !== 'string')) {
        throw new Error(`媒体库上传回执无效：${file.name}`);
      }
      const uploadedItem: UploadedSiteMaterial = {
        file,
        id: typeof item.id === 'string' ? item.id : undefined,
        name: file.name,
        url: typeof item.url === 'string' ? item.url : '',
        relativeUrl: typeof item.url === 'string' ? item.url : '',
        mimeType: file.type || 'image/png',
        size: bytes.length,
        storage: 'mediaLibrary',
        mapping: `${file.name} → media:${String(item.url || item.id || '')}`,
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
  const mappings = allFiles.map(file => ({
    name: file.name,
    id: file.id,
    destination: materialDestination(task.resourceId, task.versionId, file).path,
  }));
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
