import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { MaterialFile } from '../../shared/automation.js';
import type { RequirementManifest } from '../../shared/completeness.js';
import type { TemplateReviewBatch } from './template-review.js';

export interface TemplateReviewPageViewportDigest {
  viewport?: string;
  state?: string;
  captured?: boolean;
  settled: boolean;
  navigationStatus?: number | null;
  status?: number | null;
  coverageComplete?: boolean;
  gaps?: string[];
}

export interface TemplateReviewFactsDigest {
  pages?: {
    id: string;
    state?: string;
    paths: {
      path: string;
      viewports: TemplateReviewPageViewportDigest[] | Record<string, TemplateReviewPageViewportDigest>;
    }[];
  }[];
  records?: {
    id: string;
    state: string;
    expectedCount: number | null;
    actualCount: number | null;
    missingCount: number;
    unexpectedCount: number;
    emptyFieldCount: number;
    reason?: string;
  }[];
}

export interface TemplateReviewDigestInput {
  batch: TemplateReviewBatch;
  reviewInput: ReturnType<typeof prepareTemplateReviewInput>;
  reviewFacts?: TemplateReviewFactsDigest;
  manifest?: Pick<RequirementManifest, 'items'>;
  inputDescription?: string;
  maxChars?: number;
}

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
  const details=new Map<string,{capture?:{id:string;index:number};position?:unknown;readiness?:unknown}>();
  for(const file of files.filter(f=>f.type==='image/png'))try{
    const name=file.name.replace(/\.png$/,'.json'),companion=files.find(f=>f.name===name&&f.type==='application/json');if(!companion)continue;
    const bytes=readFileSync(resolve(work,'evidence',name));if(bytes.length!==companion.size||createHash('sha256').update(bytes).digest('hex')!==companion.sha256)continue;
    const o=JSON.parse(bytes.toString());if(o.file===file.name)details.set(file.name,{capture:o.capture,position:o.position,readiness:o.readiness});
  }catch{/* Missing metadata cannot be invented from a filename. */}
  const candidates=files.filter(f=>f.type==='image/png'&&f.viewport&&viewports.has(f.viewport)&&locations[f.name]&&wantedPaths.has(pathKey(locations[f.name].url,target)));
  candidates.sort((a,b)=>Number(planned?.has(b.name)||false)-Number(planned?.has(a.name)||false)||Number(b.settled!==false)-Number(a.settled!==false));
  const groups=new Map<string,MaterialFile[]>();
  for(const file of candidates){const o=locations[file.name],key=JSON.stringify([o.role,o.viewport,o.url]),group=groups.get(key)||[];group.push(file);groups.set(key,group);}
  const selected=[...groups.values()].flatMap(group=>{
    const plannedFrames=group.filter(f=>planned?.has(f.name));if(plannedFrames.length)return plannedFrames;
    const capture=details.get(group[0].name)?.capture?.id;
    return capture?group.filter(f=>details.get(f.name)?.capture?.id===capture):group.slice(0,1);
  });
  const images=selected.map(file=>{
    const observation=locations[file.name],original='evidence/'+file.name;
    const entry={file:file.name,original,observation:'evidence/'+file.name.replace(/\.png$/,'.json'),role:file.role,viewport:file.viewport,url:observation.url,settled:file.settled,sha256:file.sha256};
    return {...entry,...details.get(file.name),views:[{path:original}]};
  });
  const input={batchId:batch.id,note:'仅为本批路径、视口与真实滚动位置的逐屏索引，不代表已查看或通过。按当前判断选择 views.path，禁止自动读取所有图片或把长图切片当作逐屏证据。引用 file 的登记名；完整证据仍在 evidence-manifest.json，缺口按需取证。',images};
  writeFileSync(resolve(work,'review-input.json'),JSON.stringify(input,null,2),{mode:0o600});
  const draft={summary:'待独立评测',assessments:batch.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:null,passed:null,reason:'待独立核实',evidence:[]}))),issues:[],coverage:{verified:[],unverified:['待独立核实本批范围'],outOfScope:[]},...(batch.rechecks?{rechecks:batch.rechecks.map(t=>({id:t.id,status:'unverified',reason:'待核实：'+t.title,evidence:[]}))}:{}),...(batch.manifest?{completeness:batch.manifest.items.map(i=>({id:i.id,status:'unverified',reason:'待独立核实',evidence:[],checkedViewports:[],actualCount:null,sampledPaths:[],checkedKeys:[]}))}:{})};
  writeFileSync(resolve(work,'review-result-template.json'),JSON.stringify(draft,null,2),{mode:0o600});
  return input;
}

const cleanInline=(value:unknown,maxLen=96):string=>{
  const normalized=String(value??'').replace(/\s+/g,' ').trim();
  const chars=Array.from(normalized);
  return chars.length>maxLen?chars.slice(0,Math.max(1,maxLen-1)).join('')+'…':normalized;
};

export const clipContract=(value:unknown,maxLen:number,fieldRef:string):{text:string;truncated:boolean}=>{
  const normalized=String(value??'').replace(/\s+/g,' ').trim();
  const chars=Array.from(normalized);
  if(chars.length>maxLen){
    return {text:`${chars.slice(0,Math.max(1,maxLen)).join('')} [已截断，必读 ${fieldRef}]`,truncated:true};
  }
  return {text:normalized,truncated:false};
};

const previewList=(values:string[],maxItems=4,itemMax=48):string=>{
  const head=values.slice(0,maxItems).map(v=>cleanInline(v,itemMax));
  return values.length>maxItems?`${head.join(', ')} (+${values.length-maxItems} more)`:head.join(', ');
};

const capRows=(rows:string[],maxRows:number,pointer:string):string[]=>
  rows.length>maxRows?[...rows.slice(0,maxRows),`  - ... (+${rows.length-maxRows} more in ${pointer})`]:rows;

/** Deterministic, character-capped inline batch digest to eliminate blind shell probing turns. */
export function formatTemplateReviewDigest(input:TemplateReviewDigestInput):string {
  const maxChars=Math.max(512,input.maxChars??8000);
  const {batch,reviewInput}=input;
  let contractTruncated=false;
  const takeContract=(value:unknown,maxLen:number,fieldRef:string):string=>{
    const clipped=clipContract(value,maxLen,fieldRef);
    if(clipped.truncated)contractTruncated=true;
    return clipped.text;
  };
  const previewContractList=(values:string[],maxItems:number,itemMax:number,fieldRef:string):string=>{
    const head=values.slice(0,maxItems).map(v=>takeContract(v,itemMax,fieldRef));
    if(values.length>maxItems){
      contractTruncated=true;
      return `${head.join(', ')} (+${values.length-maxItems} more — 必读 ${fieldRef})`;
    }
    return head.join(', ');
  };

  const lines:string[]=[
    `### 本批内联索引 (${batch.id})`,
    '1. 工作目录文件与顶层 Schema 速查（禁止运行 ls / wc / find / jq keys 探测）：',
    '- task.json: {task,input,site,manifest,batchId,rechecks,reassessment,programFacts,capturePlan,evidenceManifest}',
    '- review-input.json: {batchId,note,images:[{file,original,observation,role,viewport,url,settled,sha256,capture,position,views:[{path}]}]}',
    '- review-facts.json: {pages,records,fullFacts,note}',
    '- review-result-template.json: {summary,assessments,issues,coverage,completeness?,rechecks?}',
  ];

  if(input.inputDescription?.trim()){
    lines.push(`1b. 资料与业务说明 (task.json.input.description): ${takeContract(input.inputDescription,500,'task.json.input.description')}`);
  }

  const allCriteriaEntries=(batch.task.rule?.criteria||[]).flatMap(c=>
    c.viewports.map(viewport=>({c,viewport})),
  );
  if(allCriteriaEntries.length>24)contractTruncated=true;
  const criteriaRows=allCriteriaEntries.slice(0,24).map(({c,viewport})=>{
    const weight=typeof c.weight==='number'?String(c.weight):'-';
    const req=typeof c.required==='boolean'?(c.required?'required':'optional'):'-';
    const label=takeContract(c.label||c.id,120,'task.json.task.rule.criteria');
    const inst=c.instruction?` — ${takeContract(c.instruction,600,'task.json.task.rule.criteria')}`:'';
    return `  - ${c.id} | ${viewport} | weight=${weight} | ${req} | ${label}${inst}`;
  });
  if(criteriaRows.length){
    lines.push(
      '2. 本批评分指标 (id | viewport | weight | required | label):',
      ...criteriaRows,
      ...(allCriteriaEntries.length>24?[`  - ... (+${allCriteriaEntries.length-24} more — 必读 task.json.task.rule.criteria)`]:[]),
    );
  }else lines.push('2. 本批评分指标 (criteria): none');

  const manifestItems=(input.manifest??batch.manifest)?.items||[];
  if(manifestItems.length>20)contractTruncated=true;
  const completenessRows=manifestItems.slice(0,20).flatMap(item=>{
    const req=item.required?'required':'optional';
    const vps=item.viewports?.length?item.viewports.join(','):'-';
    const list=item.kind==='template'?(item.samples||[]):(item.paths||[]);
    const targetInfo=item.kind==='template'
      ?`samples(${list.length})${list.length?': '+previewContractList(list,8,120,'task.json.manifest.items'):''}`
      :`paths(${list.length})${list.length?': '+previewContractList(list,8,120,'task.json.manifest.items'):''}`;
    const parts:string[]=[`  - ${item.id} | ${item.kind} | ${req} | ${vps} | ${targetInfo}`];
    if(item.expectedCount!==null&&item.expectedCount!==undefined){
      parts.push(`expectedCount=${item.expectedCount}`);
    }
    const expectedKeyCount=(item as {expectedKeyCount?:number}).expectedKeyCount;
    if(typeof expectedKeyCount==='number'){
      parts.push(`expectedKeyCount=${expectedKeyCount}`);
    }else if(item.expectedKeys?.length){
      const keyHead=item.expectedKeys.slice(0,8).map(k=>takeContract(k,80,'task.json.manifest.items')).join(', ');
      if(item.expectedKeys.length>8){
        contractTruncated=true;
        parts.push(`expectedKeys(${item.expectedKeys.length}): ${keyHead} (+${item.expectedKeys.length-8} more) [expectedKeys 已省略，必读 task.json.manifest.items]`);
      }else{
        parts.push(`expectedKeys(${item.expectedKeys.length}): ${keyHead}`);
      }
    }
    if(item.dataIdentity){
      parts.push(`dataIdentity=${takeContract(JSON.stringify(item.dataIdentity),240,'task.json.manifest.items')}`);
    }
    if(item.records){
      parts.push(`records=${takeContract(JSON.stringify(item.records),200,'task.json.manifest.items')}`);
    }
    if(item.title){
      parts.push(takeContract(item.title,120,'task.json.manifest.items'));
    }
    const srcText=item.source?takeContract(item.source,200,'task.json.manifest.items'):'-';
    const expText=item.expectation?takeContract(item.expectation,600,'task.json.manifest.items'):'-';
    return [
      parts.join(' | '),
      `    source: ${srcText} | expectation: ${expText}`,
    ];
  });
  if(completenessRows.length){
    lines.push(
      '3. 本批完整度交付项 (id | kind | required | viewports | paths/samples):',
      ...completenessRows,
      ...(manifestItems.length>20?[`  - ... (+${manifestItems.length-20} more — 必读 task.json.manifest.items)`]:[]),
    );
  }else lines.push('3. 本批完整度交付项 (completeness): none');

  const allRechecks=batch.rechecks||[];
  if(allRechecks.length>20)contractTruncated=true;
  const recheckRows=allRechecks.slice(0,20).flatMap(t=>{
    const rawLocs=(t.locations||[]).map(l=>{
      const interactionSuffix=l.interaction?'(interaction=true)':'';
      if(l.type==='implementation'){
        const reqClip=clipContract(JSON.stringify(l.request??''),120,'task.json.rechecks');
        return {str:`implementation:${reqClip.text}${interactionSuffix}`,truncated:reqClip.truncated};
      }
      const urlClip=clipContract(l.url,120,'task.json.rechecks');
      const rolePrefix=l.role&&l.role!=='target'?`${l.role}:`:'';
      return {str:`${rolePrefix}${l.viewport}:${urlClip.text}${interactionSuffix}`,truncated:urlClip.truncated};
    });
    const dedupedLocs:{str:string;truncated:boolean}[]=[];
    const seenLocs=new Set<string>();
    for(const entry of rawLocs){
      if(!seenLocs.has(entry.str)){
        seenLocs.add(entry.str);
        dedupedLocs.push(entry);
      }
    }
    const shownLocs=dedupedLocs.slice(0,6);
    const totalLocCount=(t.locations||[]).length;
    const omittedLocCount=dedupedLocs.length>6?dedupedLocs.length-6:totalLocCount>6?totalLocCount-shownLocs.length:0;
    if(shownLocs.some(e=>e.truncated)||omittedLocCount>0)contractTruncated=true;
    const locSummary=shownLocs.length
      ?`${shownLocs.map(e=>e.str).join(', ')}${omittedLocCount>0?` (+${omittedLocCount} more — 必读 task.json.rechecks)`:''}`
      :'unlocated';
    const titleText=takeContract(t.title,160,'task.json.rechecks');
    const detailText=t.detail?takeContract(t.detail,600,'task.json.rechecks'):'-';
    return [
      `  - ${t.id} | ${t.kind} | ${t.severity||'-'} | ${titleText} | ${locSummary}`,
      `    detail: ${detailText}`,
    ];
  });
  if(recheckRows.length){
    lines.push(
      '4. 本批原问题/缺口复验 (id | kind | severity | title | targets):',
      ...recheckRows,
      ...(allRechecks.length>20?[`  - ... (+${allRechecks.length-20} more — 必读 task.json.rechecks)`]:[]),
    );
  }else lines.push('4. 本批原问题/缺口复验 (rechecks): none');

  const factRows:string[]=[];
  for(const p of input.reviewFacts?.pages||[]){
    const gaps:string[]=[];
    let settledCount=0;
    for(const pathEntry of p.paths||[]){
      const views=Array.isArray(pathEntry.viewports)
        ?pathEntry.viewports.map(v=>({
          viewport:v.viewport||'-',
          captured:v.captured??v.state==='captured',
          settled:Boolean(v.settled),
          status:v.navigationStatus??v.status??null,
          coverageComplete:v.coverageComplete,
        }))
        :Object.entries(pathEntry.viewports||{}).map(([viewport,v])=>({
          viewport,
          captured:v.captured??v.state==='captured',
          settled:Boolean(v.settled),
          status:v.navigationStatus??v.status??null,
          coverageComplete:v.coverageComplete,
        }));
      const bad=views.filter(v=>!v.captured||!v.settled||v.coverageComplete===false||(v.status!==null&&(v.status<200||v.status>=300)));
      if(!views.length)gaps.push(`${pathEntry.path}(missing)`);
      else if(bad.length)gaps.push(`${pathEntry.path}(${bad.map(v=>`${v.viewport}:${!v.captured?'missing':!v.settled?'unsettled':v.status!==null&&(v.status<200||v.status>=300)?'http-'+v.status:'partial'}`).join(',')})`);
      else settledCount++;
    }
    const state=p.state||(!p.paths?.length?'unverified':!gaps.length?'captured':!settledCount?'missing':'partial');
    factRows.push(`  - ${p.id}: ${state} (paths=${p.paths?.length||0}, settled=${settledCount}${gaps.length?`, gaps=${previewList(gaps,3,52)}`:''})`);
  }
  for(const r of input.reviewFacts?.records||[]){
    factRows.push(`  - ${r.id}: ${r.state} (expected=${r.expectedCount??'null'}, actual=${r.actualCount??'null'}, missing=${r.missingCount}, unexpected=${r.unexpectedCount}, emptyFields=${r.emptyFieldCount})`);
  }
  if(factRows.length){
    lines.push('5. 程序对账摘要 (review-facts.json):',...capRows(factRows,20,'review-facts.json'));
  }else lines.push('5. 程序对账摘要 (review-facts.json): none');

  const mustReadNotice='⚠️ 必读提示：上方部分验收要求、路径或说明存在截断/省略，动手判断前必须用 jq 读取 task.json 对应完整字段！';
  if(contractTruncated){
    lines.push(mustReadNotice);
  }

  const images=reviewInput.images||[];
  lines.push(`6. 本批已登记逐屏截图索引（共 ${images.length} 张；查看原图读路径 evidence/<file>，写入结果 JSON 的 evidence 数组必须用裸文件名 <file>，禁止带 evidence/ 前缀！）：`);
  if(!images.length){
    lines.push('  - none（如需补查完整证据见 evidence-manifest.json）');
  }else{
    const maxImageRows=Math.min(images.length,48);
    const overflowLine=(omitted:number)=>`  - ... 另有 ${omitted} 张已登记截图未内联（共 ${images.length} 张）；按需用 jq 查询 review-input.json（evidence 引用仍填裸 <file>）。`;
    const reserve=overflowLine(images.length).length+2;
    let currentLen=lines.join('\n').length;
    let included=0;
    for(let i=0;i<maxImageRows;i++){
      const img=images[i];
      const viewPath=img.views?.[0]?.path||`evidence/${img.file}`;
      const pos=img.position as {scrollY?:unknown}|undefined;
      const scrollY=typeof pos?.scrollY==='number'?String(pos.scrollY):'-';
      const settled=img.settled===false?'unsettled':'settled';
      const row=`  - ${viewPath} | ${img.role||'-'} | ${img.viewport||'-'} | scrollY=${scrollY} | ${settled} | ${cleanInline(img.url||'-',110)}`;
      const isLastAll=i===images.length-1;
      const needed=1+row.length+(isLastAll?0:1+reserve);
      if(currentLen+needed>maxChars)break;
      lines.push(row);
      currentLen+=1+row.length;
      included++;
    }
    const omitted=images.length-included;
    if(omitted>0)lines.push(overflowLine(omitted));
  }

  let out=lines.join('\n');
  if(out.length>maxChars){
    const fullFooter=`\n${mustReadNotice}\n... [内联索引已按 ${maxChars} 字符上限截断；剩余详情请按需查询 review-input.json / task.json / review-facts.json]`;
    const shortFooter=`\n... [内联索引已按 ${maxChars} 字符上限截断；剩余详情请按需查询 review-input.json / task.json / review-facts.json]`;
    const budget=Math.max(0,maxChars-fullFooter.length);
    let trimmed=out.slice(0,budget);
    const nl=trimmed.lastIndexOf('\n');
    if(nl>0)trimmed=trimmed.slice(0,nl);
    else if(trimmed.length>0){
      const lastCode=trimmed.charCodeAt(trimmed.length-1);
      if(lastCode>=0xd800&&lastCode<=0xdbff)trimmed=trimmed.slice(0,-1);
    }
    out=trimmed+(trimmed.includes(mustReadNotice)?shortFooter:fullFooter);
  }
  return out;
}
