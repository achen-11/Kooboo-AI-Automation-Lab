/** Logical paths are relative package paths, never storage paths or OS paths. */
export function materialPath(value:string):string {
  const name=value.normalize('NFC');
  if(!name||name.length>300||/[\u0000-\u001f\u007f\\]/.test(name)||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('附件路径必须为安全的相对路径，不能包含空目录、反斜杠或 ..');
  return name;
}
export function uniqueMaterialPaths(files:{name:string}[]){const seen=new Set<string>();for(const f of files){const path=materialPath(f.name);const normalized=path.toLocaleLowerCase('en-US');if(seen.has(normalized))throw new Error(`附件路径重复：${path}`);seen.add(normalized);}
  const all=[...seen].sort();for(let i=1;i<all.length;i++)if(all[i].startsWith(all[i-1]+'/'))throw new Error('附件路径同时被用作文件和目录：'+all[i-1]);}
export interface PickedMaterial { file:File; path:string }
export function packageGroups<T extends {path:string}>(files:T[],single:boolean){
  const groups=new Map<string,T[]>(),loose:T[]=[];
  for(const file of files){const path=materialPath(file.path),parts=path.split('/');if(single){const key='资料包';groups.set(key,[...(groups.get(key)||[]),file]);}else if(parts.length<2)loose.push(file);else{const key=parts[0];groups.set(key,[...(groups.get(key)||[]),{...file,path:parts.slice(1).join('/')}]);}}
  return {groups:[...groups].map(([name,files])=>({name,files})),loose};
}
