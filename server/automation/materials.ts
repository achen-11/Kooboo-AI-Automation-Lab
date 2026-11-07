import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { MaterialFile } from '../../shared/automation.js';
import { materialPath, uniqueMaterialPaths } from '../../shared/materials.js';
export function materialDestination(resourceId:string,versionId:string,file:MaterialFile){
  const logical=materialPath(file.name),parts=logical.split('/'),original=parts.pop()!;
  // Kooboo Upload/File normalizes spaces / # and platform-invalid filename characters.
  // Use a stable safe filename for those names, and preserve the logical name in the manifest.
  const filename=/[\s#%?:<>|*"&]/.test(original)?file.id+(/^\.[a-z0-9]{1,12}$/i.test(extname(original))?extname(original):'.bin'):original;
  const folder=[`materials/${resourceId}/${versionId}`,...parts].join('/');
  const text=!file.type.startsWith('image/')&&/\.(md|txt|json|csv|ya?ml|html?|css|js|ts|xml)$/i.test(logical);
  return {logical,filename,folder,text,path:text?`_materials/${resourceId}/${versionId}/${logical}`:`/${folder}/${filename}`};
}
export function readMaterial(directory:string,file:MaterialFile){const bytes=readFileSync(resolve(directory,'materials',file.id));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('资料校验失败：'+file.name);return bytes;}
export function copyEvaluationMaterials(directory:string,work:string,files:MaterialFile[]){
  uniqueMaterialPaths(files);const root=resolve(work,'materials');rmSync(root,{recursive:true,force:true});mkdirSync(root,{recursive:true,mode:0o700});
  for(const file of files){const path=resolve(root,materialPath(file.name));mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,readMaterial(directory,file),{mode:0o600,flag:'wx'});}
  writeFileSync(resolve(work,'materials-manifest.json'),JSON.stringify(files,null,2),{mode:0o600});
}
