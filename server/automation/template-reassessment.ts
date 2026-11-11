import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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
  mode:'targeted'|'incremental';scopeComplete:boolean;
  baseline:AutomationTask;seeds:AutomationReport[];batches:TemplateReviewBatch[];targets:RecheckTarget[];
  inheritedAssessments:string[];inheritedRequirements:string[];
  inheritedPagePaths:{id:string;paths:string[]}[];
  deferredAssessments:string[];deferredRequirements:string[];
  deferredPagePaths:{id:string;paths:string[]}[];
}
const assessmentKey=(a:{criterionId:string;viewport:string})=>a.criterionId+':'+a.viewport;
const observationValue=(value:any)=>({url:value.url,title:value.title,snapshot:value.snapshot,text:value.text,textTruncated:value.textTruncated,frames:value.frames,framesComplete:value.framesComplete,navigationStatus:value.navigationStatus,position:value.position});
const ruleValue=(task:AutomationTask)=>({sop:task.rule?.sop,references:task.rule?.references,criteria:task.rule?.criteria});
const inheritedReason=(reason:string,note:string)=>reason.slice(0,Math.max(0,12000-note.length-1))+'\n'+note;
const emptyReport=():AutomationReport=>({summary:'程序逐项确认未变化的本轮证据，继承对应独立判断。',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'unverified',artifacts:[]});

/** A previous judgement is inherited when its evidence is byte-equal, or incrementally rebound in intermediate optimization rounds pending final full-site audit. */
export async function prepareTemplateReassessment(input:{task:AutomationTask;store:AutomationStore;directory:string;work:string;manifest?:RequirementManifest;batches:TemplateReviewBatch[];files:MaterialFile[];threshold?:number;readImplementation:(request:unknown)=>Promise<{evidence:string;result:unknown}>;signal:AbortSignal}):Promise<TemplateReassessment|undefined>{
  const {task,store,directory,work,manifest,batches,files,readImplementation,signal}=input;
  const parent=task.parentId?store.task(task.parentId):undefined,baseline=parent?.kind==='evaluation'?parent:parent?.repairEvidence?store.task(parent.repairEvidence.reportId):undefined;
  const rootTask=store.root(task);
  if(task.scenario!=='site-template'||!baseline?.report||baseline.kind!=='evaluation'||!baseline.siteRevision||!task.siteRevision||baseline.id===task.id||baseline.generatedSiteId!==task.generatedSiteId||baseline.versionId!==task.versionId||baseline.environmentId!==task.environmentId||baseline.scope!==task.scope||baseline.scenario!==task.scenario||store.root(baseline)?.id!==rootTask?.id||canonicalValue(ruleValue(baseline))!==canonicalValue(ruleValue(task)))return;
  const oldManifest=new ManifestStore(store).get(baseline.requirementsId);
  if(Boolean(manifest)!==Boolean(oldManifest))return;
  const oldWork=resolve(directory,'automation-runs',baseline.id),report=baseline.report;
  const mapping=new Map<string,string>(),failed=new Set<string>();
  const implCache=new Map<string,{request:unknown;oldValue:unknown;evidence:string;equalValue:boolean}|null>();
  const current=()=>store.task(task.id)?.artifacts||files;
  const oldFile=(name:string)=>report.artifacts.find(f=>f.name===name);
  const readOld=(file:MaterialFile)=>readRegisteredEvidence(oldWork,file);
  const oldObservation=(file:MaterialFile)=>{const json=oldFile(file.name.replace(/\.png$/,'.json'));if(!json||json.role!==file.role||json.viewport!==file.viewport)return;return JSON.parse(readOld(json).toString());};
  const rebindImplementation=async(name:string)=>{
    if(implCache.has(name))return implCache.get(name)||undefined;
    signal.throwIfAborted();
    const original=oldFile(name);
    if(!original||original.role!=='target'||!/^implementation-[a-f0-9-]{36}\.json$/.test(name)){implCache.set(name,null);return;}
    try{
      const old=JSON.parse(readOld(original).toString());
      if(old.binding?.taskId!==baseline.id||old.binding?.siteRevision!==baseline.siteRevision||!old.request||!Object.hasOwn(old,'value')||old.value===null||old.value===undefined){implCache.set(name,null);return;}
      const saved=await readImplementation(old.request),value=saved.result as {value?:unknown};
      if(!value||!Object.hasOwn(value,'value')||value.value===null||value.value===undefined){implCache.set(name,null);return;}
      const info={request:old.request,oldValue:old.value,evidence:saved.evidence,equalValue:canonicalValue(old.value)===canonicalValue(value.value)};
      implCache.set(name,info);return info;
    }catch{signal.throwIfAborted();implCache.set(name,null);return;}
  };
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
        const info=await rebindImplementation(name);
        if(info?.equalValue){mapping.set(name,info.evidence);return info.evidence;}
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

  const allowIncremental=Boolean(rootTask?.optimization)&&!task.fullAuditRequired;
  let usedIncremental=false;
  let templateProgram:{pages?:{id:string;paths:{path:string;viewports:{viewport:string;navigationStatus:number|null;settled:boolean;state:string}[]}[]}[];records?:{id:string;state:string;evidence:string[];actualCount:number|null;checkedKeys:string[]}[]}|undefined;
  if(allowIncremental){try{templateProgram=JSON.parse(readFileSync(resolve(work,'template-program.json'),'utf8'));}catch{/* Optional in standalone unit tests. */}}
  const currentSettledTargetImages=(url:string,viewport:string,expectedCapturePolicy?:string):{image:string;companion:string}[]=>{
    const out:{image:string;companion:string}[]=[],filesNow=current();
    for(const candidate of filesNow){
      if(candidate.role!=='target'||candidate.type!=='image/png'||candidate.viewport!==viewport)continue;
      const companion=filesNow.find(f=>f.name===candidate.name.replace(/\.png$/,'.json')&&f.role==='target'&&f.viewport===viewport);if(!companion)continue;
      try{
        const now=JSON.parse(readRegisteredEvidence(work,companion).toString());readRegisteredEvidence(work,candidate);
        if(now.file!==candidate.name||now.role!=='target'||now.viewport!==viewport||now.url!==url||(expectedCapturePolicy!==undefined&&now.binding?.capturePolicy!==expectedCapturePolicy)||now.binding?.taskId!==task.id||now.binding?.siteRevision!==task.siteRevision||now.binding?.inputVersionId!==task.versionId||now.settlement?.settled!==true||now.navigationStatus!==undefined&&(now.navigationStatus<200||now.navigationStatus>=300)||['click','fill','select','press'].includes(now.action))continue;
        out.push({image:candidate.name,companion:companion.name});
      }catch{signal.throwIfAborted();}
    }
    return out;
  };
  const pageProgramSettled=(itemId:string,path:string,requiredViewports:string[])=>{
    const pageEntry=templateProgram?.pages?.find(p=>p.id===itemId);if(!pageEntry)return true;
    const pathEntry=pageEntry.paths.find(p=>p.path===path);if(!pathEntry)return false;
    return requiredViewports.every(vp=>{const v=pathEntry.viewports.find(entry=>entry.viewport===vp);return Boolean(v&&v.state==='captured'&&v.settled&&(v.navigationStatus===null||v.navigationStatus>=200&&v.navigationStatus<300));});
  };
  const issueTargets=targets.filter(t=>t.kind==='issue');
  const hasUnlocatedIssue=issueTargets.some(t=>t.locations.length===0);
  const isUrlTargeted=(url:string)=>hasUnlocatedIssue||issueTargets.some(t=>t.locations.some(l=>l.type==='image'&&l.url===url));
  const isViewportTargeted=(viewport:string)=>hasUnlocatedIssue||issueTargets.some(t=>t.locations.some(l=>l.viewport===viewport));
  const isImplementationTargeted=(request:unknown)=>hasUnlocatedIssue||issueTargets.some(t=>t.locations.some(l=>l.type==='implementation'&&canonicalValue(l.request)===canonicalValue(request)));
  const minPassScore=Math.max(input.threshold??rootTask?.optimization?.threshold??85,rootTask?.optimization?.policy.targetScore??85);

  const legacyAllDeferred=report.review?.scopeComplete===false&&report.review.deferredAssessments===undefined&&report.review.deferredRequirements===undefined&&report.review.deferredPagePaths===undefined;
  const prevDeferredAssessments=new Set(legacyAllDeferred?(report.review?.inheritedAssessments||[]):(report.review?.deferredAssessments||[]));
  const prevDeferredRequirements=new Set(legacyAllDeferred?(report.review?.inheritedRequirements||[]):(report.review?.deferredRequirements||[]));
  const prevDeferredPagePaths=new Map<string,Set<string>>();
  for(const entry of (legacyAllDeferred?(report.review?.inheritedPagePaths||[]):(report.review?.deferredPagePaths||[]))){
    const set=prevDeferredPagePaths.get(entry.id)||new Set<string>();
    for(const p of entry.paths)set.add(p);
    prevDeferredPagePaths.set(entry.id,set);
  }

  const seed=emptyReport(),inheritedAssessments:string[]=[],inheritedRequirements:string[]=[],inheritedPagePaths:TemplateReassessment['inheritedPagePaths']=[];
  const deferredAssessments:string[]=[],deferredRequirements:string[]=[],deferredPagePaths:TemplateReassessment['deferredPagePaths']=[];
  for(const a of report.assessments){
    if(a.viewport==='business'||a.score===null||a.passed!==true||a.score<(input.threshold??rootTask?.optimization?.threshold??85)||!task.rule!.criteria.some(c=>c.id===a.criterionId&&c.viewports.includes(a.viewport)&&c.scopes.includes(task.scope)))continue;
    const key=assessmentKey(a);
    const evidence=!prevDeferredAssessments.has(key)?await mapEvidence(a.evidence):undefined;
    if(evidence){
      seed.assessments.push({...a,evidence,reason:a.reason+'\n本轮程序复核：全部引用证据与原判断一致，已绑定当前修订。'});inheritedAssessments.push(key);continue;
    }
    if(!allowIncremental||a.score<minPassScore||isViewportTargeted(a.viewport)||!a.evidence.length)continue;
    const rebound:string[]=[];let ok=true,hadRefPng=false,hasRefPng=false,hasTargetPng=false;
    for(const name of a.evidence){
      const f=oldFile(name);if(!f){ok=false;break;}
      if(f.role!=='target'){
        if(f.role==='reference'&&f.type==='image/png')hadRefPng=true;
        const mapped=await mapFile(name);if(!mapped){ok=false;break;}
        if(f.role==='reference'&&f.type==='image/png')hasRefPng=true;
        rebound.push(mapped);
      }else if(f.type==='image/png'){
        const o=oldObservation(f);
        if(!o?.url||f.viewport!==a.viewport||o.viewport!==a.viewport||['click','fill','select','press'].includes(o.action)){ok=false;break;}
        const settled=currentSettledTargetImages(o.url,a.viewport,o.binding?.capturePolicy);
        if(!settled.length){ok=false;break;}
        hasTargetPng=true;rebound.push(...settled.map(s=>s.image));
      }else if(/^[a-f0-9-]{36}\.json$/.test(name)){
        const png=oldFile(name.replace(/\.json$/,'.png')),o=png?oldObservation(png):undefined;
        if(!png||!o?.url||png.viewport!==a.viewport||o.viewport!==a.viewport||['click','fill','select','press'].includes(o.action)){ok=false;break;}
        const settled=currentSettledTargetImages(o.url,a.viewport,o.binding?.capturePolicy);
        if(!settled.length){ok=false;break;}
        rebound.push(...settled.map(s=>s.companion));
      }else if(/^implementation-[a-f0-9-]{36}\.json$/.test(name)){
        const info=await rebindImplementation(name);
        if(!info?.equalValue||isImplementationTargeted(info.request)){ok=false;break;}
        rebound.push(info.evidence);
      }else{
        const mapped=await mapFile(name);if(!mapped){ok=false;break;}
        rebound.push(mapped);
      }
    }
    if(!ok||!hasTargetPng||hadRefPng&&!hasRefPng)continue;
    seed.assessments.push({...a,evidence:[...new Set(rebound)],reason:inheritedReason(a.reason,'本轮增量复核：该视口原评分已达目标且无关联问题，当前修订取证稳定，暂继承待终审全量复核。')});
    inheritedAssessments.push(key);deferredAssessments.push(key);usedIncremental=true;
  }
  const checks=[];
  for(const check of report.completeness?.checks||[]){
    const item=manifest?.items.find(i=>i.id===check.id),old=oldManifest?.items.find(i=>i.id===check.id);
    if(check.status!=='verified'||!item||!old||canonicalValue(item)!==canonicalValue(old))continue;
    // Live interactions are stateful. Equal pixels or stored code do not prove the action still works.
    if(['interaction','workflow'].includes(item.kind))continue;
    const itemDeferredPaths=prevDeferredPagePaths.get(item.id);
    const evidence=!prevDeferredRequirements.has(item.id)&&!itemDeferredPaths?.size?await mapEvidence(check.evidence):undefined;
    if(evidence){checks.push({...check,evidence,reason:inheritedReason(check.reason,'本轮程序复核：清单与全部依赖证据一致，已绑定当前修订。')});inheritedRequirements.push(check.id);continue;}
    if(item.kind==='page'){
      // A merged static-page check may cover dozens of paths. Keep equal paths
      // separately, while every non-image dependency remains mandatory for each.
      const site=store.site(task.generatedSiteId||''),version=store.version(task.versionId);
      if(!site||!version)continue;
      const equalPaths:string[]=[],equalMapped:string[]=[];
      if(!prevDeferredRequirements.has(item.id)){
        for(const path of item.paths)try{
          if(itemDeferredPaths?.has(path))continue;
          const url=new URL(templateTargetPath(path,site.url,version.contentUrl||version.referenceUrl),site.url).href;
          const images=check.evidence.flatMap(name=>{const f=oldFile(name);if(!f||f.role!=='target'||f.type!=='image/png')return [];const o=oldObservation(f);return o?.url===url?[{name,viewport:o.viewport}]:[];});
          if(!item.viewports.filter(v=>v!=='business').every(v=>images.some(i=>i.viewport===v)))continue;
          const dependency=check.evidence.filter(name=>{
            const f=oldFile(name);if(!f||f.role!=='target')return true;
            const png=f.type==='image/png'?f:/^[a-f0-9-]{36}\.json$/.test(name)?oldFile(name.replace(/\.json$/,'.png')):undefined;
            if(!png)return true;
            const o=oldObservation(png);return !o?.url||o.url===url;
          });
          const proof=await mapEvidence(dependency);if(!proof)continue;equalPaths.push(path);equalMapped.push(...proof);
        }catch{signal.throwIfAborted();}
      }
      const incPaths:string[]=[],incMapped:string[]=[];
      if(allowIncremental){
        let depsOk=true,expectedCapturePolicy:string|undefined;const sharedDeps:string[]=[];
        for(const name of check.evidence){
          const f=oldFile(name);if(!f){depsOk=false;break;}
          if(f.role!=='target'){const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}sharedDeps.push(mapped);}
          else if(f.type==='image/png'){const o=oldObservation(f);if(!o?.url){depsOk=false;break;}if(o.binding?.capturePolicy&&expectedCapturePolicy===undefined)expectedCapturePolicy=o.binding.capturePolicy;}
          else if(/^[a-f0-9-]{36}\.json$/.test(name)){const png=oldFile(name.replace(/\.json$/,'.png')),o=png?oldObservation(png):undefined;if(!png||!o?.url){depsOk=false;break;}}
          else if(/^implementation-[a-f0-9-]{36}\.json$/.test(name)){const info=await rebindImplementation(name);if(!info||isImplementationTargeted(info.request)){depsOk=false;break;}sharedDeps.push(info.evidence);}
          else{const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}sharedDeps.push(mapped);}
        }
        if(depsOk){
          const nonBusinessViewports=item.viewports.filter(v=>v!=='business');
          for(const path of item.paths){
            if(equalPaths.includes(path))continue;
            try{
              const url=new URL(templateTargetPath(path,site.url,version.contentUrl||version.referenceUrl),site.url).href;
              if(isUrlTargeted(url)||!pageProgramSettled(item.id,path,nonBusinessViewports))continue;
              const pathProof:string[]=[];let allViewports=true;
              for(const v of nonBusinessViewports){
                const settled=currentSettledTargetImages(url,v,expectedCapturePolicy);
                if(!settled.length){allViewports=false;break;}
                for(const pair of settled)pathProof.push(pair.image,pair.companion);
              }
              if(!allViewports)continue;
              incPaths.push(path);incMapped.push(...sharedDeps,...pathProof);
            }catch{signal.throwIfAborted();}
          }
        }
      }
      if(!incPaths.length){
        if(equalPaths.length){checks.push({...check,evidence:[...new Set(equalMapped)],sampledPaths:equalPaths,actualCount:null,reason:inheritedReason(check.reason,'本轮程序复核：仅继承'+equalPaths.length+'条证据一致的静态路径，其他路径独立复验。')});inheritedPagePaths.push({id:item.id,paths:equalPaths});}
      }else{
        usedIncremental=true;
        deferredPagePaths.push({id:item.id,paths:incPaths});
        const coveredPaths=item.paths.filter(p=>equalPaths.includes(p)||incPaths.includes(p)),combinedEvidence=[...new Set([...equalMapped,...incMapped])];
        if(coveredPaths.length===item.paths.length){
          checks.push({...check,evidence:combinedEvidence,sampledPaths:coveredPaths,checkedViewports:[...new Set([...check.checkedViewports,...item.viewports])],reason:inheritedReason(check.reason,'本轮增量复核：全部静态路径未受原问题影响且当前取证稳定，暂继承待终审全量复核。')});
          inheritedRequirements.push(item.id);
          if(!equalPaths.length)deferredRequirements.push(item.id);
        }else{
          checks.push({...check,evidence:combinedEvidence,sampledPaths:coveredPaths,actualCount:null,reason:inheritedReason(check.reason,'本轮增量复核：暂继承'+coveredPaths.length+'条未受原问题影响的静态路径，目标问题路径独立复验。')});
          inheritedPagePaths.push({id:item.id,paths:coveredPaths});
        }
      }
      continue;
    }
    if(!allowIncremental)continue;
    if(item.kind==='template'){
      const site=store.site(task.generatedSiteId||''),version=store.version(task.versionId),nonBusinessViewports=item.viewports.filter(v=>v!=='business'),samples=item.samples||[];
      if(!site||!version||nonBusinessViewports.length>0&&!samples.length)continue;
      let depsOk=true,expectedCapturePolicy:string|undefined;const bound:string[]=[];
      for(const name of check.evidence){
        const f=oldFile(name);if(!f){depsOk=false;break;}
        if(f.role!=='target'){const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}bound.push(mapped);}
        else if(f.type==='image/png'){const o=oldObservation(f);if(!o?.url||['click','fill','select','press'].includes(o.action)||isUrlTargeted(o.url)){depsOk=false;break;}if(o.binding?.capturePolicy&&expectedCapturePolicy===undefined)expectedCapturePolicy=o.binding.capturePolicy;}
        else if(/^[a-f0-9-]{36}\.json$/.test(name)){const png=oldFile(name.replace(/\.json$/,'.png')),o=png?oldObservation(png):undefined;if(!png||!o?.url||['click','fill','select','press'].includes(o.action)||isUrlTargeted(o.url)){depsOk=false;break;}}
        else if(/^implementation-[a-f0-9-]{36}\.json$/.test(name)){const info=await rebindImplementation(name);if(!info||isImplementationTargeted(info.request)){depsOk=false;break;}bound.push(info.evidence);}
        else{const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}bound.push(mapped);}
      }
      if(!depsOk)continue;
      const allSamplePaths=[...new Set([...samples,...check.sampledPaths])];
      let samplesOk=allSamplePaths.length>0||nonBusinessViewports.length===0;
      for(const sample of allSamplePaths){
        try{
          const url=new URL(templateTargetPath(sample,site.url,version.contentUrl||version.referenceUrl),site.url).href;
          if(isUrlTargeted(url)||samples.includes(sample)&&!pageProgramSettled(item.id,sample,nonBusinessViewports)){samplesOk=false;break;}
          for(const v of nonBusinessViewports){
            const settled=currentSettledTargetImages(url,v,expectedCapturePolicy);
            if(!settled.length){samplesOk=false;break;}
            for(const pair of settled)bound.push(pair.image,pair.companion);
          }
        }catch{signal.throwIfAborted();samplesOk=false;break;}
      }
      const hasImplProof=bound.some(n=>/^implementation-[a-f0-9-]{36}\.json$/.test(n)&&current().some(f=>f.name===n));
      if(!samplesOk||!hasImplProof)continue;
      checks.push({...check,evidence:[...new Set(bound)],sampledPaths:samples.length?samples:check.sampledPaths,checkedViewports:[...new Set([...check.checkedViewports,...item.viewports])],reason:inheritedReason(check.reason,'本轮增量复核：动态模板样本未受原问题影响且当前取证与后台证据齐全，暂继承待终审全量复核。')});
      inheritedRequirements.push(item.id);deferredRequirements.push(item.id);usedIncremental=true;continue;
    }
    if(['data','implementation','seo'].includes(item.kind)){
      const programRecord=item.kind==='data'?templateProgram?.records?.find(r=>r.id===item.id):undefined;
      if(programRecord&&programRecord.evidence.length>0&&programRecord.state!=='verified')continue;
      const recordVerifiedByProgram=Boolean(programRecord&&programRecord.state==='verified');
      let depsOk=true;const bound:string[]=[];
      for(const name of check.evidence){
        const f=oldFile(name);if(!f){depsOk=false;break;}
        if(f.role!=='target'){const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}bound.push(mapped);}
        else if(f.type==='image/png'){
          const o=oldObservation(f);
          if(!o?.url||!f.viewport||o.viewport!==f.viewport||['click','fill','select','press'].includes(o.action)||isUrlTargeted(o.url)){depsOk=false;break;}
          const settled=currentSettledTargetImages(o.url,f.viewport,o.binding?.capturePolicy);
          if(!settled.length){depsOk=false;break;}
          for(const pair of settled)bound.push(pair.image);
        }else if(/^[a-f0-9-]{36}\.json$/.test(name)){
          const png=oldFile(name.replace(/\.json$/,'.png')),o=png?oldObservation(png):undefined;
          if(!png||!o?.url||!png.viewport||o.viewport!==png.viewport||['click','fill','select','press'].includes(o.action)||isUrlTargeted(o.url)){depsOk=false;break;}
          const settled=currentSettledTargetImages(o.url,png.viewport,o.binding?.capturePolicy);
          if(!settled.length){depsOk=false;break;}
          for(const pair of settled)bound.push(pair.companion);
        }else if(/^implementation-[a-f0-9-]{36}\.json$/.test(name)){
          const info=await rebindImplementation(name);
          if(!info||isImplementationTargeted(info.request)||!info.equalValue&&!recordVerifiedByProgram){depsOk=false;break;}
          bound.push(info.evidence);
        }else{const mapped=await mapFile(name);if(!mapped){depsOk=false;break;}bound.push(mapped);}
      }
      if(!depsOk)continue;
      if(recordVerifiedByProgram&&programRecord)bound.push(...programRecord.evidence);
      const finalEvidence=[...new Set(bound)];
      if(!finalEvidence.length)continue;
      if(['data','implementation'].includes(item.kind)&&!finalEvidence.some(n=>/^implementation-[a-f0-9-]{36}\.json$/.test(n)&&current().some(f=>f.name===n)))continue;
      checks.push({...check,evidence:finalEvidence,...(recordVerifiedByProgram&&programRecord?{actualCount:programRecord.actualCount,checkedKeys:programRecord.checkedKeys}:{}),reason:inheritedReason(check.reason,'本轮增量复核：未受原问题影响且后台与页面证据核对通过，暂继承待终审全量复核。')});
      inheritedRequirements.push(item.id);deferredRequirements.push(item.id);usedIncremental=true;
    }
  }
  if(manifest&&checks.length)seed.completeness={manifestId:manifest.id,manifestRevision:manifest.revision,sourceComplete:manifest.sourceComplete,state:'unverified',checks};
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
  const hasDeferred=deferredAssessments.length>0||deferredRequirements.length>0||deferredPagePaths.length>0;
  const mode:'targeted'|'incremental'=hasDeferred||usedIncremental?'incremental':'targeted',scopeComplete=!hasDeferred&&!usedIncremental;
  const plan:TemplateReassessment={mode,scopeComplete,baseline,seeds:[seed],batches:scoped,targets,inheritedAssessments,inheritedRequirements,inheritedPagePaths,deferredAssessments,deferredRequirements,deferredPagePaths};
  const detail={mode,scopeComplete,baselineTaskId:baseline.id,baselineRevision:baseline.siteRevision,currentRevision:task.siteRevision,inheritedAssessments,inheritedRequirements,inheritedPagePaths,deferredAssessments,deferredRequirements,deferredPagePaths,reviewBatches:scoped.map(b=>({id:b.id,criteria:b.task.rule?.criteria.map(c=>c.id),requirements:b.manifest?.items.map(i=>({id:i.id,paths:i.paths}))})),targets,note:mode==='incremental'?'中间优化轮增量复评：未受原问题影响且当前修订取证稳定的范围暂继承原判断，达标后须经终审全站复核。':'继承基于当前真实证据相等，不把旧目标图片当作新修订证据；未证明不变的项目属于关联回归范围。'};
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
  const deferredAssessments=plan.deferredAssessments||[],deferredRequirements=plan.deferredRequirements||[],deferredPagePaths=plan.deferredPagePaths||[];
  const hasDeferred=Boolean(deferredAssessments.length||deferredRequirements.length||deferredPagePaths.length);
  const mode=hasDeferred?'incremental':(plan.mode||'targeted'),scopeComplete=(plan.scopeComplete??(mode!=='incremental'))&&!hasDeferred;
  const review:NonNullable<AutomationReport['review']>={mode,scopeComplete,baselineTaskId:plan.baseline.id,baselineRevision:plan.baseline.siteRevision!,inheritedAssessments:plan.inheritedAssessments,inheritedRequirements:plan.inheritedRequirements,inheritedPagePaths:plan.inheritedPagePaths,deferredAssessments,deferredRequirements,deferredPagePaths,reviewedAssessments:plan.batches.flatMap(b=>b.task.rule!.criteria.flatMap(c=>c.viewports.map(viewport=>c.id+':'+viewport))),reviewedRequirements:[...new Set(plan.batches.flatMap(b=>b.manifest?.items.map(i=>i.id)||[]))],targets:plan.targets.map(({id,title,kind})=>({id,title,kind}))};
  return {...result,review};
}
