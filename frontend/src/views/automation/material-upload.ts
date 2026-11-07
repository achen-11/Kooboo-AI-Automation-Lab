import { api } from '../../api';
import type { MaterialFile } from '../../../../shared/automation';
import { materialPath, type PickedMaterial } from '../../../../shared/materials';
export function fileSelection(list:FileList|null):PickedMaterial[]{return Array.from(list||[]).filter(f=>f.name!=='.DS_Store'&&!f.name.startsWith('._')).map(file=>({file,path:materialPath(file.webkitRelativePath||file.name)}));}
type Entry={name:string;isFile:boolean;isDirectory:boolean;file:(success:(file:File)=>void,error:(e:Error)=>void)=>void;createReader:()=>{readEntries:(success:(entries:Entry[])=>void,error:(e:Error)=>void)=>void}};
export async function droppedMaterials(transfer:DataTransfer):Promise<PickedMaterial[]>{
  const entries=Array.from(transfer.items).map(item=>(item as DataTransferItem&{webkitGetAsEntry?:()=>Entry|null}).webkitGetAsEntry?.()).filter(Boolean) as unknown as Entry[];
  if(!entries.length)return fileSelection(transfer.files);
  const result:PickedMaterial[]=[];
  async function walk(entry:Entry,parent=''){
    if(entry.name==='.DS_Store'||entry.name.startsWith('._'))return;
    const path=materialPath(parent+entry.name);
    if(entry.isFile){const file=await new Promise<File>((r,j)=>entry.file(r,j));result.push({file,path});}
    else if(entry.isDirectory){const reader=entry.createReader();while(true){const batch=await new Promise<Entry[]>((r,j)=>reader.readEntries(r,j));if(!batch.length)break;for(const child of batch)await walk(child,path+'/');}}
  }
  for(const entry of entries)await walk(entry);return result;
}
export async function uploadMaterial(item:PickedMaterial):Promise<MaterialFile>{
  materialPath(item.path);if(item.file.size>16*1024*1024)throw new Error('单文件不能超过 16 MB');
  const content=await new Promise<string>((r,j)=>{const reader=new FileReader();reader.onload=()=>r(String(reader.result).split(',')[1]||'');reader.onerror=()=>j(new Error('文件读取失败'));reader.readAsDataURL(item.file);});
  return api<MaterialFile>('/automation/files',{method:'POST',body:JSON.stringify({name:item.path,type:item.file.type,content})});
}
