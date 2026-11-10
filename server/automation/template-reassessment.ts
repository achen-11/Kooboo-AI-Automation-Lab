import { copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationReport, AutomationTask, EvaluationRecheck, MaterialFile } from '../../shared/automation.js';
import type { RequirementManifest } from '../../shared/completeness.js';
import type { AutomationStore } from './store.js';
import type { TemplateReviewBatch } from './template-review.js';
import { ManifestStore } from './completeness.js';
import { canonicalValue, readRegisteredEvidence } from './template-facts.js';
import { templateTargetPath } from './template-path.js';

export interface RecheckTarget {
  id:string;kind:'issue'|'coverage';title:string;detail:string;severity?:'critical'|'major'|'minor';
  locations:{role:string;url:string;viewport:string;type:'image'|'implementation';request?:unknown;interaction?:boolean}[];
}
export interface TemplateReassessment {
  baseline:AutomationTask;seeds:AutomationReport[];batches:TemplateReviewBatch[];targets:RecheckTarget[];
  inheritedAssessments:string[];inheritedRequirements:string[];
  inheritedPagePaths:{id:string;paths:string[]}[];
}
const assessmentKey=(a:{criterionId:string;viewport:string})=>a.criterionId+':'+a.viewport;
const observationValue=(value:any)=>({url:value.url,title:value.title,snapshot:value.snapshot,text:value.text,textTruncated:value.textTruncated,frames:value.frames,framesComplete:value.framesComplete,navigationStatus:value.navigationStatus});
const ruleValue=(task:AutomationTask)=>({sop:task.rule?.sop,references:task.rule?.references,criteria:task.rule?.criteria});
const inheritedReason=(reason:string,note:string)=>reason.slice(0,Math.max(0,12000-note.length-1))+'\n'+note;
const emptyReport=():AutomationReport=>({summary:'程序逐项确认未变化的本轮证据，继承对应独立判断。',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'unverified',artifacts:[]});

/** A previous judgement is inherited only after its complete evidence can be rebound to equal current bytes/results. */
export async function prepareTemplateReassessment(input:{task:AutomationTask;store:AutomationStore;directory:string;work:string;manifest?:RequirementManifest;batches:TemplateReviewBatch[];files:MaterialFile[];threshold?:number;readImplementation:(request:unknown)=>Promise<{evidence:string;result:unknown}>;signal:AbortSignal}):Promise<TemplateReassessment|undefined>{
  const {task,store,directory,work,manifest,batches,files,readImplementation,signal}=input;
  const parent=task.parentId?store.task(task.parentId):undefined,baseline=parent?.kind==='evaluation'?parent:parent?.repairEvidence?store.task(parent.repairEvidence.reportId):undefined;
  if(task.scenario!=='site-template'||!baseline?.report||baseline.kind!=='evaluation'||!baseline.siteRevision||!task.siteRevision||baseline.id===task.id||baseline.generatedSiteId!==task.generatedSiteId||baseline.versionId!==task.versionId||baseline.environmentId!==task.environmentId||baseline.scope!==task.scope||baseline.scenario!==task.scenario||store.root(baseline)?.id!==store.root(task)?.id||canonicalValue(ruleValue(baseline))!==canonicalValue(ruleValue(task)))return;
  const oldManifest=new ManifestStore(store).get(baseline.requirementsId);
  if(Boolean(manifest)!==Boolean(oldManifest))return;
  const oldWork=resolve(directory,'automation-runs',baseline.id),report=baseline.report;
  const mapping=new Map<string,string>(),failed=new Set<string>();
  const current=()=>store.task(task.id)?.artifacts||files;
  const oldFile=(name:string)=>report.artifacts.find(f=>f.name===name);
  const readOld=(file:MaterialFile)=>readRegisteredEvidence(oldWork,file);
  const oldObservation=(file:MaterialFile)=>{const json=oldFile(file.name.replace(/\.png$/,'.json'));if(!json||json.role!==file.role||json.viewport!==file.viewport)return;return JSON.parse(readOld(json).toString());};
  const mapFile=async(name:string):Promise<string|undefined>=>{
    if(mapping.has(name))return mapping.get(name);if(failed.has(name))return;failed.add(name);signal.throwIfAborted();
    const original=oldFile(name);if(!original)return;
    try{
      readOld(original);
      if(original.role==='target'&&original.type==='image/png'){
        const old=oldObservation(original);
        if(!old||old.file!==original.name||old.role!=='target'||old.viewport!==original.viewport||old.binding?.taskId!==baseline.id||old.binding?.siteRevision!==baseline.siteRevision||old.binding?.inputVersionId!==baseline.versionId||!old.settlement?.settled||old.navigationStatus!==undefined&&(old.navigationStatus<200||old.navigationStatus>=300)||['click','fill','select','press'].includes(old.action))return;
        for(const candidate of current().filter(f=>f.role==='target'&&f.type==='image/png'&&f.viewport===original.viewport&&f.sha256===original.sha256)){
          const companion=current().find(f=>f.name===candidate.name.replace(/\.png$/,'.json'));if(!companion)continue;
          const now=JSON.parse(readRegisteredEvidence(work,companion).toString());readRegisteredEvidence(work,candidate);
          if(now.role!=='target'||now.viewport!==candidate.viewport||now.binding?.capturePolicy!==old.binding?.capturePolicy||now.binding?.taskId!==task.id||now.binding?.siteRevision!==task.siteRevision||now.binding?.inputVersionId!==task.versionId||!now.settlement?.settled||now.file!==candidate.name||canonicalValue(observationValue(old))!==canonicalValue(observationValue(now)))continue;
          mapping.set(name,candidate.name);mapping.set(original.name.replace(/\.png$/,'.json'),companion.name);return candidate.name;
        }
      }else if(original.role==='target'&&/^[a-f0-9-]{36}\.json$/.test(name)){
        const image=await mapFile(name.replace(/\.json$/,'.png'));if(image)return mapping.get(name);
      }else if(original.role==='target'&&/^implementation-[a-f0-9-]{36}\.json$/.test(name)){
        const old=JSON.parse(readOld(original).toString());
        if(old.binding?.taskId!==baseline.id||old.binding?.siteRevision!==baseline.siteRevision||!old.request||!Object.hasOwn(old,'value')||old.value===null)return;
        const saved=await readImplementation(old.request),value=saved.result as {value?:unknown};
        if(value&&Object.hasOwn(value,'value')&&value.value!==null&&value.value!==undefined&&canonicalValue(old.value)===canonicalValue(value.value)){mapping.set(name,saved.evidence);return saved.evidence;}
      }else if(original.role!=='target'){
        // Only evidence of this workflow's frozen input/source snapshot may be copied; never old target observations.
        if(original.type==='image/png'){
          const old=oldObservation(original);
          const candidates=current().filter(f=>f.role===original.role&&f.viewport===original.viewport&&f.sha256===original.sha256);
          for(const candidate of candidates){const companion=current().find(f=>f.name===candidate.name.replace(/\.png$/,'.json'));if(!companion)continue;
            const now=JSON.parse(readRegisteredEvidence(work,companion).toString());
            if(old?.binding?.sourceSnapshotId&&old.binding.sourceSnapshotId===now.binding?.sourceSnapshotId&&now.binding?.inputVersionId===task.versionId&&old.url===now.url&&old.viewport===now.viewport&&now.file===candidate.name&&now.settlement?.settled){readRegisteredEvidence(work,candidate);mapping.set(name,candidate.name);mapping.set(original.name.replace(/\.png$/,'.json'),companion.name);return candidate.name;}
          }
        }else if(/^(source-review|source)-[a-f0-9-]{36}\.json$/.test(name)){
          const same=current().find(f=>f.name===name&&f.sha256===original.sha256);
          if(!same){if(current().some(f=>f.name===name))return;copyFileSync(resolve(oldWork,'evidence',name),resolve(work,'evidence',name));files.push(structuredClone(original));task.artifacts=files;store.put(task);}
          mapping.set(name,name);return name;
        }else if(/^[a-f0-9-]{36}\.json$/.test(name)){
          const image=await mapFile(name.replace(/\.json$/,'.png'));if(image)return mapping.get(name);
        }
      }
    }catch{signal.throwIfAborted();/* Any unknown dependency stays in the independent review scope. */}
  };
  const mapEvidence=async(names:string[])=>{
    if(!names.length)return;const result:string[]=[];
    for(const name of names){const mapped=await mapFile(name);if(!mapped)return;result.push(mapped);}
    return [...new Set(result)];
  };
  const seed=emptyReport(),inheritedAssessments:string[]=[],inheritedRequirements:string[]=[],inheritedPagePaths:TemplateReassessment['inheritedPagePaths']=[];
  for(const a of report.assessments){
    if(a.viewport==='business'||a.score===null||a.passed!==true||a.score<(input.threshold??store.root(task)?.optimization?.threshold??85)||!task.rule!.criteria.some(c=>c.id===a.criterionId&&c.viewports.includes(a.viewport)&&c.scopes.includes(task.scope)))continue;
    const evidence=await mapEvidence(a.evidence);if(!evidence)continue;
    seed.assessments.push({...a,evidence,reason:a.reason+'\n本轮程序复核：全部引用证据与原判断一致，已绑定当前修订。'});inheritedAssessments.push(assessmentKey(a));
  }
  const checks=[];
  for(const check of report.completeness?.checks||[]){
    const item=manifest?.items.find(i=>i.id===check.id),old=oldManifest?.items.find(i=>i.id===check.id);
    if(check.status!=='verified'||!item||!old||canonicalValue(item)!==canonicalValue(old))continue;
    // Live interactions are stateful. Equal pixels or stored code do not prove the action still works.
    if(['interaction','workflow'].includes(item.kind))continue;
    const evidence=await mapEvidence(check.evidence);
    if(evidence){checks.push({...check,evidence,reason:inheritedReason(check.reason,'本轮程序复核：清单与全部依赖证据一致，已绑定当前修订。')});inheritedRequirements.push(check.id);continue;}
    if(item.kind!=='page')continue;
    // A merged static-page check may cover dozens of paths. Keep equal paths
    // separately, while every non-image dependency remains mandatory for each.
    const site=store.site(task.generatedSiteId||''),version=store.version(task.versionId);
    if(!site||!version)continue;
    const paths:string[]=[],mapped:string[]=[];
    for(const path of item.paths)try{
      const url=new URL(templateTargetPath(path,site.url,version.contentUrl||version.referenceUrl),site.url).href;
      const images=check.evidence.flatMap(name=>{const f=oldFile(name);if(!f||f.role!=='target'||f.type!=='image/png')return [];const o=oldObservation(f);return o?.url===url?[{name,viewport:o.viewport}]:[];});
      if(!item.viewports.filter(v=>v!=='business').every(v=>images.some(i=>i.viewport===v)))continue;
      const dependency=check.evidence.filter(name=>{
        const f=oldFile(name);if(!f||f.role!=='target')return true;
        const png=f.type==='image/png'?f:/^[a-f0-9-]{36}\.json$/.test(name)?oldFile(name.replace(/\.json$/,'.png')):undefined;
        if(!png)return true;
        const o=oldObservation(png);return !o?.url||o.url===url;
      });
      const proof=await mapEvidence(dependency);if(!proof)continue;paths.push(path);mapped.push(...proof);
    }catch{signal.throwIfAborted();}
    if(paths.length){checks.push({...check,evidence:[...new Set(mapped)],sampledPaths:paths,actualCount:null,reason:inheritedReason(check.reason,'本轮程序复核：仅继承'+paths.length+'条证据一致的静态路径，其他路径独立复验。')});inheritedPagePaths.push({id:item.id,paths});}
  }
  if(manifest&&checks.length)seed.completeness={manifestId:manifest.id,manifestRevision:manifest.revision,sourceComplete:manifest.sourceComplete,state:'unverified',checks};
  const targets:RecheckTarget[]=[];
  for(const [index,issue] of report.issues.entries()){
    const locations:RecheckTarget['locations']=[];
    for(const name of issue.evidence){const file=oldFile(name);if(!file)continue;try{
      if(file.type==='image/png'){const o=oldObservation(file);readOld(file);if(o?.url){
        let url=o.url,role=o.role;
        if(role!=='target'){const source=new URL(o.url),target=store.site(task.generatedSiteId||'');if(!target)continue;url=new URL(source.pathname+source.search,target.url).href;role='target';}
        locations.push({role,url,viewport:o.viewport,type:'image',...(['click','fill','select','press'].includes(o.action)?{interaction:true}:{})});
      }}
      else if(file.role==='target'&&name.startsWith('implementation-')){const o=JSON.parse(readOld(file).toString());if(o.request)locations.push({role:'target',url:store.site(task.generatedSiteId||'')?.url||'',viewport:'business',type:'implementation',request:o.request});}
    }catch{/* Unknown location remains explicit; do not silently resolve the issue. */}}
    targets.push({id:'issue-'+(index+1),kind:'issue',title:issue.title,detail:issue.detail,severity:issue.severity,locations});
  }
  for(const [index,text] of report.coverage.unverified.entries())targets.push({id:'coverage-'+(index+1),kind:'coverage',title:text,detail:text,locations:[]});
  const scoped:TemplateReviewBatch[]=batches.flatMap(batch=>{
    const criteria=batch.task.rule!.criteria.flatMap(c=>{const viewports=c.viewports.filter(viewport=>!inheritedAssessments.includes(c.id+':'+viewport));return viewports.length?[{...c,viewports}]:[];});
    const items=batch.manifest?.items.filter(i=>!inheritedRequirements.includes(i.id)).flatMap(i=>{
      const inherited=inheritedPagePaths.find(p=>p.id===i.id);if(!inherited||i.kind!=='page')return [i];
      const paths=i.paths.filter(path=>!inherited.paths.includes(path));return paths.length?[{...i,paths,expectedCount:paths.length,expectedKeys:undefined,samples:undefined}]:[];
    });
    if(!criteria.length&&!items?.length)return [];
    return [{...batch,task:{...batch.task,rule:{...batch.task.rule!,criteria}},manifest:batch.manifest?{...batch.manifest,items:items||[]}:undefined}];
  });
  if(targets.length)scoped.push({id:'regression-issues',task:{...task,rule:{...task.rule!,criteria:[]}},rechecks:targets});
  const plan:TemplateReassessment={baseline,seeds:[seed],batches:scoped,targets,inheritedAssessments,inheritedRequirements,inheritedPagePaths};
  const detail={mode:'targeted',baselineTaskId:baseline.id,baselineRevision:baseline.siteRevision,currentRevision:task.siteRevision,inheritedAssessments,inheritedRequirements,inheritedPagePaths,reviewBatches:scoped.map(b=>({id:b.id,criteria:b.task.rule?.criteria.map(c=>c.id),requirements:b.manifest?.items.map(i=>({id:i.id,paths:i.paths}))})),targets,note:'继承基于当前真实证据相等，不把旧目标图片当作新修订证据；未证明不变的项目属于关联回归范围。'};
  writeFileSync(resolve(work,'reassessment-plan.json'),JSON.stringify(detail,null,2),{mode:0o600});
  return plan;
}

export function validateRechecks(raw:unknown,targets:RecheckTarget[],files:MaterialFile[],work:string,task:AutomationTask){
  const checks=(raw as {rechecks?:EvaluationRecheck[]}).rechecks||[];
  if(checks.length!==targets.length||new Set(checks.map(c=>c.id)).size!==checks.length||checks.some(c=>!targets.some(t=>t.id===c.id)))throw new Error('针对性复评必须逐项回应全部原问题/未验证项，不得省略或新增复验ID');
  for(const check of checks){
    if(check.evidence.some(name=>!files.some(f=>f.name===name)))throw new Error('问题复验引用了不存在的当前证据');
    if(check.status==='unverified')continue;
    if(!check.evidence.length)throw new Error('问题解决或仍存在的判断必须有当前证据');
    const target=targets.find(t=>t.id===check.id)!;
    const required=target.locations.filter(l=>l.role==='target');
    if(!required.length&&check.status==='resolved')throw new Error('原问题缺少可追溯定位，不能用任意新证据宣称解决；应保留未验证');
    const bound=check.evidence.flatMap(name=>{const f=files.find(f=>f.name===name)!;try{
      if(f.role==='target'&&f.type==='image/png'){readRegisteredEvidence(work,f);const json=files.find(j=>j.name===name.replace(/\.png$/,'.json')&&j.role==='target'&&j.viewport===f.viewport);if(!json)return [];const o=JSON.parse(readRegisteredEvidence(work,json).toString());return o.file===name&&o.role==='target'&&o.viewport===f.viewport&&o.binding?.taskId===task.id&&o.binding?.siteRevision===task.siteRevision&&o.settlement?.settled&&(check.status!=='resolved'||o.navigationStatus===undefined||o.navigationStatus>=200&&o.navigationStatus<300)?[{type:'image',url:o.url,viewport:o.viewport,interaction:['click','fill','select','press'].includes(o.action),request:undefined as unknown}]:[];}
      if(f.role==='target'&&/^implementation-[a-f0-9-]{36}\.json$/.test(name)){const o=JSON.parse(readRegisteredEvidence(work,f).toString());return o.binding?.taskId===task.id&&o.binding?.siteRevision===task.siteRevision&&o.value!==undefined&&o.value!==null?[{type:'implementation',url:'',viewport:'business',request:o.request,interaction:false}]:[];}
    }catch{}return [];});
    if(!bound.length||required.some(location=>!bound.some(o=>o.type===location.type&&(location.type==='implementation'?canonicalValue(o.request)===canonicalValue(location.request):o.url===location.url&&o.viewport===location.viewport&&(!location.interaction||o.interaction)))))throw new Error('问题复验缺少原问题路径/视口/操作或后台请求对应的当前修订证据');
  }
}

export function finishTemplateReassessment<T extends {issues:AutomationReport['issues'];coverage:AutomationReport['coverage'];rechecks?:EvaluationRecheck[]}>(raw:T,plan:TemplateReassessment|undefined):T&{review?:AutomationReport['review']}{
  if(!plan)return raw;
  const result=structuredClone(raw),checks=result.rechecks||[];
  if(checks.length!==plan.targets.length||plan.targets.some(t=>!checks.some(c=>c.id===t.id)))throw new Error('复评尚未完成全部原问题的闭环');
  for(const target of plan.targets){const check=checks.find(c=>c.id===target.id)!;
    if(check.status==='resolved')continue;
    if(target.kind==='issue'&&check.status==='remaining'){
      if(!result.issues.some(i=>i.title===target.title&&i.severity===(target.severity||'major')))result.issues.push({severity:target.severity||'major',title:target.title,detail:check.reason,evidence:check.evidence});
    }else result.coverage.unverified.push('原'+(target.kind==='issue'?'问题':'未验证项')+'尚未闭合：'+target.title+'；'+check.reason);
  }
  const review:NonNullable<AutomationReport['review']>={mode:'targeted',baselineTaskId:plan.baseline.id,baselineRevision:plan.baseline.siteRevision!,inheritedAssessments:plan.inheritedAssessments,inheritedRequirements:plan.inheritedRequirements,inheritedPagePaths:plan.inheritedPagePaths,reviewedAssessments:plan.batches.flatMap(b=>b.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>c.id+':'+viewport))),reviewedRequirements:[...new Set(plan.batches.flatMap(b=>b.manifest?.items.map(i=>i.id)||[]))],targets:plan.targets.map(({id,title,kind})=>({id,title,kind}))};
  return {...result,review};
}
