import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationReport, AutomationTask } from '../../../shared/automation.js';
import type { CollectionTargetReport } from '../../../shared/collection-target.js';
import type { RequirementCheck, RequirementManifest } from '../../../shared/completeness.js';
import type { AutomationStore } from '../store.js';
import type { Vault } from '../../lib/vault.js';
import { ManifestStore, checksSchema, validateCompleteness } from '../completeness.js';
import type { MaterialFile } from '../../../shared/automation.js';
import { checkpointMigrationReport, finishPendingMigrationReport } from '../migration-verification.js';
import { collectionHash } from './runtime.js';
import { CollectionPending } from './errors.js';
import { COLLECTION_TARGET_VERIFIER_VERSION, collectionTargetGate, verifyCollectionTarget, type VerifyCollectionTargetOptions } from './target-verification.js';

/** This capability is created by the host, never deserialized from model output. */
export interface CollectionProgramEvidence { readonly kind:'collection-program-evidence' }
const programEvidence=new WeakMap<CollectionProgramEvidence,{task:AutomationTask;manifest:RequirementManifest;store:AutomationStore;directory:string;serialized:string}>();
export function collectionProgramEvidence(task:AutomationTask,manifest:RequirementManifest,store:AutomationStore,directory:string,target:CollectionTargetReport):CollectionProgramEvidence {
  const capability=Object.freeze({kind:'collection-program-evidence' as const});
  programEvidence.set(capability,{task,manifest:structuredClone(manifest),store,directory,serialized:JSON.stringify(target)});
  collectionProgramArtifacts(capability,task,manifest);
  return capability;
}

/** Recheck registration, binding and bytes when proof enters the scoring boundary. */
function readProgramEvidence(capability:CollectionProgramEvidence,task:AutomationTask,manifest?:RequirementManifest):CollectionTargetReport {
  const context=programEvidence.get(capability);if(!context)throw new Error('程序完整度证据不是宿主签发的能力');
  const {store,directory,serialized}=context,target=JSON.parse(serialized) as CollectionTargetReport,current=store.task(task.id),site=store.site(task.generatedSiteId||'');
  const row=store.db.prepare('SELECT json FROM auto_collection_target_reports WHERE id=? AND task_id=?').get(target.id,task.id);
  const frozenManifest=manifest||context.manifest;
  if(!row||row.json!==serialized||target.verifierVersion!==COLLECTION_TARGET_VERIFIER_VERSION||target.state==='pending'||target.taskId!==task.id||target.inputVersionId!==task.versionId||target.collectionId!==task.collectionId||target.collectionVersionId!==task.collectionVersionId||target.manifestId!==frozenManifest.id||target.manifestRevision!==frozenManifest.revision||target.manifestHash!==collectionHash(JSON.stringify(frozenManifest))||JSON.stringify(frozenManifest)!==JSON.stringify(context.manifest)||target.generatedSiteId!==task.generatedSiteId||!task.siteRevision||target.siteRevision!==task.siteRevision||target.siteId!==site?.siteId||store.siteState(site?.id||'')?.revision!==task.siteRevision||!current||current.versionId!==task.versionId||current.collectionVersionId!==task.collectionVersionId||current.requirementsId!==frozenManifest.id||current.siteRevision!==task.siteRevision||current.generatedSiteId!==task.generatedSiteId)throw new Error('程序完整度证据与持久报告、清单或当前站点修订不一致');
  const names=new Set<string>();
  for(const file of target.artifacts){
    if(!/^[a-zA-Z0-9_.-]+$/.test(file.name)||['.','..'].includes(file.name)||names.has(file.name))throw new Error('程序完整度证据名无效或重复');names.add(file.name);
    const bytes=readFileSync(resolve(directory,'automation-runs',task.id,'evidence',file.name));
    if(bytes.length!==file.size||collectionHash(bytes)!==file.sha256)throw new Error('程序完整度证据字节已变化');
  }
  return target;
}

export function collectionProgramArtifacts(capability:CollectionProgramEvidence,task:AutomationTask,manifest?:RequirementManifest){return readProgramEvidence(capability,task,manifest).artifacts;}

function reviewCheckpointBinding(task:AutomationTask,store:AutomationStore){return collectionHash(JSON.stringify({verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION,task:task.id,input:task.versionId,collection:task.collectionId,snapshot:task.collectionVersionId,manifest:new ManifestStore(store).get(task.requirementsId),site:task.generatedSiteId,physicalSite:store.site(task.generatedSiteId||'')?.siteId,revision:task.siteRevision,rule:task.rule?.hash}));}
function reviewCheckpointTable(store:AutomationStore){store.db.exec('CREATE TABLE IF NOT EXISTS auto_collection_program_reviews(task_id TEXT PRIMARY KEY,binding TEXT NOT NULL,json TEXT NOT NULL)');}
/** Preserve a model response if append-only scope changes need another bounded B window. */
export function checkpointCollectionProgramReview(task:AutomationTask,store:AutomationStore,raw:unknown){reviewCheckpointTable(store);store.db.prepare('INSERT INTO auto_collection_program_reviews VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET binding=excluded.binding,json=excluded.json').run(task.id,reviewCheckpointBinding(task,store),JSON.stringify(raw));}
export function pendingCollectionProgramReview(task:AutomationTask,store:AutomationStore):unknown|undefined {reviewCheckpointTable(store);const row=store.db.prepare('SELECT json FROM auto_collection_program_reviews WHERE task_id=? AND binding=?').get(task.id,reviewCheckpointBinding(task,store));return row?JSON.parse(row.json):undefined;}
export function clearCollectionProgramReview(task:AutomationTask,store:AutomationStore){reviewCheckpointTable(store);store.db.prepare('DELETE FROM auto_collection_program_reviews WHERE task_id=?').run(task.id);}

/** Program data reconciliation replaces repetitive model enumeration, not its independent judgements. */
export function validateCollectionProgramCompleteness(raw:unknown,manifest:RequirementManifest,files:MaterialFile[],capability:CollectionProgramEvidence,task:AutomationTask,observations:Record<string,{url:string;role:string;viewport:string}>={},targetBaseUrl?:string,pageAliases:Readonly<Record<string,string>>={}) {
  const target=readProgramEvidence(capability,task,manifest),checks=checksSchema.parse(raw),dataItems=manifest.items.filter(item=>item.kind==='data'),dataIds=new Set(dataItems.map(item=>item.id));
  if(new Set(checks.map(check=>check.id)).size!==checks.length||checks.some(check=>!manifest.items.some(item=>item.id===check.id)))throw new Error('完整度结果包含重复或未知清单项');
  const independent=validateCompleteness(checks.filter(check=>!dataIds.has(check.id)),{...manifest,items:manifest.items.filter(item=>!dataIds.has(item.id))},files,observations,targetBaseUrl,pageAliases);
  const names=new Set(files.map(file=>file.name)),bound=target.checks.filter(check=>check.kind==='binding');
  const bindingValid=bound.length===1&&bound[0].id==='binding'&&bound[0].status==='verified';
  const dataChecks:RequirementCheck[]=dataItems.map(item=>{
    const candidates=target.checks.filter(check=>check.id==='data:'+item.id&&check.requirementId===item.id),proof=candidates.length===1?candidates[0]:undefined;
    const expected=item.expectedKeys||[],exact=Array.isArray(item.expectedKeys)&&item.expectedCount===expected.length&&new Set(expected).size===expected.length&&proof?.expectedKeys?.length===expected.length&&expected.every(key=>proof.expectedKeys!.includes(key));
    const evidence=proof?.evidence.filter(name=>names.has(name))||[];
    const ai=checks.find(check=>check.id===item.id);
    const visualViewports=item.viewports.filter(viewport=>viewport!=='business');
    const visualProof=visualViewports.every(viewport=>ai?.status==='verified'&&ai.checkedViewports.includes(viewport)&&ai.evidence.some(name=>{const file=files.find(file=>file.name===name),observation=observations[name];if(file?.type!=='image/png'||file.role!=='target'||file.viewport!==viewport||observation?.role!=='target'||observation.viewport!==viewport)return false;try{const actual=new URL(observation.url);return !actual.username&&!actual.password&&(!targetBaseUrl||actual.origin===new URL(targetBaseUrl).origin);}catch{return false;}}));
    const actualComplete=proof?.actualKeys&&new Set(proof.actualKeys).size===expected.length&&expected.every(key=>proof.actualKeys!.includes(key));
    const status=bindingValid&&proof?.status==='missing'?'missing':bindingValid&&proof?.status==='verified'&&exact&&actualComplete&&evidence.length&&evidence.length===proof.evidence.length&&visualProof?'verified':'unverified';
    const program:RequirementCheck={id:item.id,status,reason:'宿主程序全量对账：'+(proof?.reason||'没有当前要求的完整程序核验结果')+(!visualProof?'；清单要求的视觉视口尚缺独立截图验收':''),evidence:[...new Set([...evidence,...(visualProof?ai?.evidence||[]:[])])],checkedViewports:[...(status==='verified'&&item.viewports.includes('business')?['business' as const]:[]),...(visualProof?visualViewports:[])],actualCount:proof?.actualKeys?new Set(proof.actualKeys).size:null,sampledPaths:ai?.sampledPaths||[],checkedKeys:status==='verified'?[...expected]:[]};
    if(ai){
      if(ai.evidence.some(name=>!names.has(name)))throw new Error('完整度结果引用了不存在的证据');
      if(item.required&&ai.status==='excluded')throw new Error('必交付项不能由评测员自行排除');
      // A model may contribute semantic defects or uncertainty, but cannot promote host gaps.
      if(['missing','partial'].includes(ai.status)||ai.status==='unverified'&&program.status!=='missing')return {...ai,reason:ai.reason+'；'+program.reason,evidence:[...new Set([...ai.evidence,...program.evidence])]};
    }
    return program;
  });
  const merged=manifest.items.map(item=>[...independent.checks,...dataChecks].find(check=>check.id===item.id)!);
  const required=merged.filter(check=>manifest.items.find(item=>item.id===check.id)!.required);
  return {...independent,checks:merged,state:required.some(check=>check.status==='missing'||check.status==='partial')?'incomplete' as const:independent.state==='unverified'||required.some(check=>check.status!=='verified')?'unverified' as const:'complete' as const};
}

/** Program evidence may lower the verdict, never raise an independent AI judgement. */
export function mergeCollectionTargetReport(report:AutomationReport,target:CollectionTargetReport) {
  report.collectionTarget=target;
  const files=new Map(report.artifacts.map(file=>[file.name,file]));
  for(const file of target.artifacts)files.set(file.name,file);
  report.artifacts=[...files.values()];
  const unresolved=target.checks.filter(check=>check.status!=='verified');
  if(target.state==='incomplete'){
    report.quality='failed';if(report.completeness)report.completeness.state='incomplete';
  }else if(target.state!=='complete'){
    if(report.quality==='passed')report.quality='unverified';
    if(report.completeness?.state==='complete')report.completeness.state='unverified';
  }
  if(target.state!=='complete')report.coverage.unverified.push(`B 段程序核验：${target.state}；${unresolved.length} 项尚未通过，已核对 ${target.checkedPages}/${target.expectedPages} 个来源路径。完整差异见 collectionTarget。`);
  else report.coverage.verified.push(`B 段程序核验通过：${target.checkedPages} 个冻结来源路径及适用数据检查。`);
  report.issues.push(...target.issues.slice(0,20));
}

/** Save the validated scoring stage before a bounded, restartable target read. */
export function checkpointCollectionReport(task:AutomationTask,report:AutomationReport,store:AutomationStore){
  if(!task.collectionVersionId)return false;
  if(!task.siteRevision||!task.rule||!task.requirementsId)throw new Error('B段缺少修订、清单或规则绑定');
  task.collectionPendingReport={report:structuredClone(report),inputVersionId:task.versionId,collectionVersionId:task.collectionVersionId,siteRevision:task.siteRevision,manifestId:task.requirementsId,ruleHash:task.rule.hash};
  store.put(task);return true;
}

export async function finishPendingCollectionReport(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal,dependencies?:VerifyCollectionTargetOptions['dependencies']){
  const pending=task.collectionPendingReport;if(!pending)return false;
  if(pending.inputVersionId!==task.versionId||pending.collectionVersionId!==task.collectionVersionId||pending.siteRevision!==task.siteRevision||pending.manifestId!==task.requirementsId||pending.ruleHash!==task.rule?.hash)throw new Error('B段评分检查点与当前输入、资料、清单、修订或规则不一致');
  const work=resolve(directory,'automation-runs',task.id);
  for(const file of pending.report.artifacts){
    if(!/^[a-zA-Z0-9_.-]+$/.test(file.name)||['.','..'].includes(file.name))throw new Error('B段评分检查点证据名无效');
    const bytes=readFileSync(resolve(work,'evidence',file.name));
    if(bytes.length!==file.size||collectionHash(bytes)!==file.sha256)throw new Error('B段评分检查点证据已变化');
  }
  const manifest=new ManifestStore(store).get(task.requirementsId);if(!manifest)throw new Error('B段固定清单缺失');
  const target=await verifyCollectionTarget({task,manifest,store,vault,directory,signal,dependencies});
  if(target.state==='pending')throw new CollectionPending(`B段已核对 ${target.checkedPages}/${target.expectedPages} 个路径，保存取证后继续`,target.binding+':'+target.checkedPages+':'+target.artifacts.length,true,target.nextAt);
  if(target.state==='complete'&&!collectionTargetGate(target,task,manifest))throw new Error('B段报告绑定或检查项未通过宿主校验');
  const report=structuredClone(pending.report);mergeCollectionTargetReport(report,target);
  // Preserve the older explicitly registered migration adapter when both apply.
  if(checkpointMigrationReport(task,report,store))await finishPendingMigrationReport(task,store,vault,directory,signal);
  else {writeFileSync(resolve(work,'report.json'),JSON.stringify(report,null,2),{mode:0o600});task.report=report;}
  delete task.collectionPendingReport;store.put(task);
  store.event(task.id,`B段程序核验：${target.state}，路径 ${target.checkedPages}/${target.expectedPages}；独立评分检查点已复用。`);
  return true;
}

/** Bounded input for a paid repair planner; full differences remain in local evidence. */
export function collectionTargetRepairContext(target:CollectionTargetReport|undefined){
  if(!target)return undefined;
  const failed=target.checks.filter(check=>check.status!=='verified');
  const confirmed=failed.filter(check=>check.status==='missing'&&check.kind!=='binding');
  const gaps=failed.filter(check=>check.status==='unverified'||check.kind==='binding');
  const hasBindingGap=gaps.some(check=>check.kind==='binding');
  const bounded=(checks:typeof failed)=>checks.slice(0,40).map(check=>({...check,expectedKeys:check.expectedKeys?.slice(0,30),actualKeys:check.actualKeys?.slice(0,30)}));
  const targetRepairAllowed=target.state==='incomplete'&&confirmed.length>0&&!hasBindingGap;
  return {id:target.id,state:target.state,collectionVersionId:target.collectionVersionId,siteRevision:target.siteRevision,expectedPages:target.expectedPages,checkedPages:target.checkedPages,unresolved:failed.length,checks:bounded(failed),remaining:Math.max(0,failed.length-40),
    confirmedTargetFailures:bounded(confirmed),confirmedTargetFailureCount:confirmed.length,verificationGaps:bounded(gaps),verificationGapCount:gaps.length,targetRepairAllowed,
    guidance:'B段未通过门槛必须保留；unresolved/checks 中的每个未通过项并不都是目标站缺陷。confirmedTargetFailures 只收录 status=missing 且 kind 非 binding 的实际目标差异；仅 targetRepairAllowed=true 时，才可依据这些具体对象、字段和原证据委托修复当前目标站。verificationGaps 是来源、身份绑定或核验能力缺口，status=unverified 不能当作已证目标缺陷。binding-error、binding-changed、冻结原件/数据分片数量/哈希/清单/输入绑定不一致、权限或宿主读取失败，应由来源资料或平台核验环节诊断；不得委托 Kooboo 修站 AI 修改冻结资料、原件、哈希、验收范围、清单数量或平台代码，也不得用改目标站来消除这些核验错误。sourceGaps=[] 只表示没有已确认的具体来源缺件，不表示来源完整、B段已通过或目标站存在缺陷；不能据此把 binding-error 转为目标修复事项。存在绑定缺口时，即使另有 missing 记录，也先保留证据并核实当前绑定，不向目标站派发这些 B 段修复。没有已证目标缺陷或无法判断责任时，保持 unverified/未通过门槛，说明具体核验缺口；不编造目标问题，不为通过而改站。若同时存在已证目标差异和其他未验证项，只修复允许的 confirmedTargetFailures，verificationGaps 继续未验证，不因修复其他项而宣称完成。复用固定资料，以实际响应和后台数据验收；不重新全站采集，不把 HTTP 200 或数量匹配当作完成。以上计数覆盖完整报告，列表只为有界上下文；完整差异保存在原评测 evidence 文件和 report.json。'};
}
