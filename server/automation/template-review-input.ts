import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { MaterialFile } from '../../shared/automation.js';
import type { TemplateReviewBatch } from './template-review.js';
import { adaptRepairImages } from './repair-images.js';

/** A batch navigation aid, never a substitute for evidence validation or independent judgment. */
export function prepareTemplateReviewInput(work:string,batch:TemplateReviewBatch,files:MaterialFile[],observations:Record<string,{url:string;role:string;viewport:string}>,target:string,reference:string) {
  const locations={...observations};
  // The scoring validator's observations map contains target locations only.
  // Source locations come from the already validated image/observation pair.
  for(const file of files.filter(f=>f.type==='image/png'&&f.role==='reference'&&!locations[f.name]))try{
    const name=file.name.replace(/\.png$/,'.json'),companion=files.find(f=>f.name===name&&f.type==='application/json'&&f.role===file.role&&f.viewport===file.viewport);
    if(!companion)continue;
    const bytes=readFileSync(resolve(work,'evidence',name));
    if(bytes.length!==companion.size||createHash('sha256').update(bytes).digest('hex')!==companion.sha256)continue;
    const o=JSON.parse(bytes.toString()),url=new URL(o.url);
    if(o.file===file.name&&o.role===file.role&&o.viewport===file.viewport&&reference&&url.origin===new URL(reference).origin)locations[file.name]={url:url.href,role:o.role,viewport:o.viewport};
  }catch{/* Unavailable source observations remain in the complete evidence index. */}
  const viewports=new Set([...batch.task.rule!.criteria.flatMap(c=>c.viewports),...(batch.manifest?.items.flatMap(i=>i.viewports)||[])]);
  const paths=new Set(batch.manifest?.items.flatMap(i=>i.kind==='template'?i.samples||[]:i.paths)||[]);
  for(const target of batch.rechecks||[])for(const location of target.locations)if(location.type==='image'){
    if(location.viewport==='desktop'||location.viewport==='mobile')viewports.add(location.viewport);
    paths.add(location.url);
  }
  if(batch.rechecks&&!viewports.size){viewports.add('desktop');viewports.add('mobile');}
  const pathKey=(value:string,base:string)=>{try{const u=new URL(value,base);return u.pathname+u.search;}catch{return value;}};
  const wantedPaths=new Set([...paths].map(p=>pathKey(p,target)));
  // Criteria review concerns the entry; requirements with explicit paths retain every one.
  if(!wantedPaths.size){wantedPaths.add(pathKey(target,target));if(reference)wantedPaths.add(pathKey(reference,reference));}
  let planned:Set<string>|undefined;
  try{const plan=JSON.parse(readFileSync(resolve(work,'capture-plan.json'),'utf8')) as {progress:{files:string[]}[]};planned=new Set(plan.progress.flatMap(p=>p.files));}catch{/* A missing aid never removes original evidence access. */}
  const seen=new Set<string>();
  const candidates=files.filter(f=>f.type==='image/png'&&f.viewport&&viewports.has(f.viewport)&&locations[f.name]&&wantedPaths.has(pathKey(locations[f.name].url,target)));
  candidates.sort((a,b)=>Number(planned?.has(b.name)||false)-Number(planned?.has(a.name)||false)||Number(b.settled!==false)-Number(a.settled!==false));
  const images=candidates.filter(file=>{const o=locations[file.name],key=JSON.stringify([o.role,o.viewport,o.url]);if(seen.has(key))return false;seen.add(key);return true;}).map(file=>{
    const observation=locations[file.name],original='evidence/'+file.name;
    const entry={file:file.name,original,observation:'evidence/'+file.name.replace(/\.png$/,'.json'),role:file.role,viewport:file.viewport,url:observation.url,settled:file.settled,sha256:file.sha256};
    try{
      const bytes=readFileSync(resolve(work,original));
      // Small images can be viewed directly. Tall screenshots get lossless, ordered regions.
      if(bytes.length<33||bytes.readUInt32BE(20)<=2048)return {...entry,views:[{path:original}]};
      const folder='review-images/'+file.sha256,result=adaptRepairImages([{file,bytes,reportId:batch.task.id}],resolve(work,folder));
      return {...entry,views:result.mapping.map(m=>({path:folder+'/'+m.file,region:m.region,width:m.width,height:m.height,sha256:m.sha256}))};
    }catch(error){return {...entry,views:[{path:original}],preparationError:error instanceof Error?error.message:'图片预处理失败，请查看原图'};}
  });
  const input={batchId:batch.id,note:'仅为本批路径与视口索引，不代表已检查或通过。图片分片连续覆盖原图；引用证据时用 file 的原图名。完整证据和其他路径仍在 evidence-manifest.json，缺口按需取证。',images};
  writeFileSync(resolve(work,'review-input.json'),JSON.stringify(input,null,2),{mode:0o600});
  const draft={summary:'待独立评测',assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:null,passed:null,reason:'待独立核实',evidence:[]}))),issues:[],coverage:{verified:[],unverified:['待独立核实本批范围'],outOfScope:[]},...(batch.rechecks?{rechecks:batch.rechecks.map(t=>({id:t.id,status:'unverified',reason:'待核实：'+t.title,evidence:[]}))}:{}),...(batch.manifest?{completeness:batch.manifest.items.map(i=>({id:i.id,status:'unverified',reason:'待独立核实',evidence:[],checkedViewports:[],actualCount:null,sampledPaths:[],checkedKeys:[]}))}:{})};
  writeFileSync(resolve(work,'review-result-template.json'),JSON.stringify(draft,null,2),{mode:0o600});
  return input;
}
