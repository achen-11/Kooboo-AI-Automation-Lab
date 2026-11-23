import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { MaterialFile } from '../../shared/automation.js';
import { materialPath, uniqueMaterialPaths } from '../../shared/materials.js';
const KOOBOO_UNSAFE_FILENAME_RE = /[\s#%?:<>|*"&+\\]/;
export const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|svg\+xml|gif|avif|x-icon|vnd\.microsoft\.icon|bmp)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|webp|svg|gif|avif|ico|bmp)$/i;

const EXT_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

export function koobooSafeFilename(file: Pick<MaterialFile, 'id'>, original: string): string {
  return KOOBOO_UNSAFE_FILENAME_RE.test(original)
    ? file.id + (/^\.[a-z0-9]{1,12}$/i.test(extname(original)) ? extname(original) : '.bin')
    : original;
}

export function isPlatformCollectionMaterial(logicalPath: string): boolean {
  const lower = logicalPath.toLowerCase();
  return lower === 'collection' || lower.startsWith('collection/');
}

export function isImageMaterial(file: Pick<MaterialFile, 'name' | 'type'>): boolean {
  return IMAGE_MIME_RE.test(file.type || '') || IMAGE_EXT_RE.test(materialPath(file.name));
}

export function isMediaLibraryMaterial(file: Pick<MaterialFile, 'name' | 'type'>): boolean {
  return !isPlatformCollectionMaterial(materialPath(file.name)) && isImageMaterial(file);
}

export function inferImageMimeType(filename: string, fallbackType?: string): string {
  if (fallbackType && IMAGE_MIME_RE.test(fallbackType)) return fallbackType;
  return EXT_IMAGE_MIME[extname(filename).toLowerCase()] || 'image/png';
}

function splitMaterialParts(resourceId: string, versionId: string, file: MaterialFile) {
  const logical = materialPath(file.name);
  const parts = logical.split('/');
  const original = parts.pop()!;
  // Kooboo Upload/File & Upload/Image normalize spaces / # / + and platform-invalid filename characters.
  // Use a stable safe filename for those names, and preserve the logical name in the manifest.
  const filename = koobooSafeFilename(file, original);
  const safeParts = parts.map(seg => (KOOBOO_UNSAFE_FILENAME_RE.test(seg) ? seg.replace(/[\s#%?:<>|*"&+\\]+/g, '_') : seg));
  const legacyFolder = [`materials/${resourceId}/${versionId}`, ...safeParts].join('/');
  return { logical, filename, safeParts, legacyFolder };
}

export function legacyCmsFileDestination(resourceId: string, versionId: string, file: MaterialFile) {
  const { logical, filename, legacyFolder } = splitMaterialParts(resourceId, versionId, file);
  return { logical, filename, folder: legacyFolder, path: `/${legacyFolder}/${filename}` };
}

export function materialDestination(resourceId: string, versionId: string, file: MaterialFile) {
  const { logical, filename, safeParts, legacyFolder } = splitMaterialParts(resourceId, versionId, file);
  const media = isMediaLibraryMaterial(file);
  const text = !media && !file.type.startsWith('image/') && /\.(md|txt|json|csv|ya?ml|html?|css|js|ts|xml)$/i.test(logical);
  if (text) {
    return { logical, filename, folder: legacyFolder, text, media, storage: 'kfile' as const, path: `_materials/${resourceId}/${versionId}/${logical}` };
  }
  if (media) {
    const folder = ['materials', ...safeParts].join('/');
    return { logical, filename, folder, text, media, storage: 'mediaLibrary' as const, path: `/${folder}/${filename}` };
  }
  return { logical, filename, folder: legacyFolder, text, media, storage: 'file' as const, path: `/${legacyFolder}/${filename}` };
}
export function readMaterial(directory:string,file:MaterialFile){const bytes=readFileSync(resolve(directory,'materials',file.id));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('资料校验失败：'+file.name);return bytes;}
export function copyEvaluationMaterials(directory:string,work:string,files:MaterialFile[]){
  uniqueMaterialPaths(files);const root=resolve(work,'materials');rmSync(root,{recursive:true,force:true});mkdirSync(root,{recursive:true,mode:0o700});
  for(const file of files){const path=resolve(root,materialPath(file.name));mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,readMaterial(directory,file),{mode:0o600,flag:'wx'});}
  writeFileSync(resolve(work,'materials-manifest.json'),JSON.stringify(files,null,2),{mode:0o600});
}
