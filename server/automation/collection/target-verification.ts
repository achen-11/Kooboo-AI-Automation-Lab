import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, MaterialFile } from '../../../shared/automation.js';
import type { RequirementManifest } from '../../../shared/completeness.js';
import type { CollectionRun, CollectionSnapshot, SourceRenderedEvidence } from '../../../shared/collection.js';
import type { CollectionTargetCheck, CollectionTargetReport, CollectionRelationBinding } from '../../../shared/collection-target.js';
export type { CollectionTargetCheck, CollectionTargetReport, CollectionRelationBinding } from '../../../shared/collection-target.js';
import type { Vault } from '../../lib/vault.js';
import type { AutomationStore } from '../store.js';
import { inspectImplementation, ManifestStore, assertRequirementDataIdentityPreserved } from '../completeness.js';
import { assertMigrationBaselinePreserved } from '../migration-check.js';
import { httpRead } from '../kooboo.js';
import { CollectionStore } from './store.js';
import { collectionHash, safeCollectionPath } from './runtime.js';
import { acceptedAssetGapGuidance } from './accepted-gaps.js';
import { collectionHtml as html, type CollectionTextFragment } from './html.js';
import { collectionLinksEquivalent, missingCollectionText } from './text-links.js';
import { assertSourceRenderedEvidenceIndex, sourceRenderedEvidencePath, sourceRenderedGuidance } from './source-rendered.js';
import type { VisibleBrowserFrame } from '../browser.js';
import { parseFrozenAssetSource, compareAssetTargets, readTargetAsset, type AssetTargetObservation, type CollectionAssetBinding } from './asset-target.js';
import { collectionVerificationFailureClass, summarizeCollectionTargetReport } from './verification-summary.js';
import { CollectionTargetReports } from './report-store.js';
export const COLLECTION_TARGET_VERIFIER_VERSION=4;

/** Generation and evaluation share only the verified frozen decision, never mutable run state. */
export function frozenCollectionAssetGapGuidance(task:AutomationTask,store:AutomationStore,directory:string):string {
  if(!task.collectionVersionId)return '';
  const collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId);
  if(!snapshot||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId)throw new Error('素材接受记录的冻结资料与当前输入不一致');
  collections.verify(snapshot);
  const guidance=[acceptedAssetGapGuidance(snapshot.acceptedAssetGaps),sourceRenderedGuidance(snapshot)].filter(Boolean).join('\n');
  return guidance?'\n'+guidance:'';
}

export interface VerifyCollectionTargetOptions {
  task:AutomationTask; manifest:RequirementManifest; store:AutomationStore; vault:Vault; directory:string; signal:AbortSignal;
  /** A soft request window. Checkpoints are reused only within the exact binding. */
  maxRequests?:number;
  /** Explicitly retry failed reads after a complete sweep; pending windows never restart that sweep. */
  retryTransientFailures?:boolean;
  /** Optional host override; otherwise read target SQLite CollectionRelationBindings declarations. */
  relationBindings?:CollectionRelationBinding[];
  dependencies?:{readHttp?:typeof httpRead; inspect?:typeof inspectImplementation;readAsset?:typeof readTargetAsset};
}
interface SourcePage {id:string;url:string;path:string;rawFile:string;title:string;fullText:string;segments:string[];semanticFragments:CollectionTextFragment[];links:{url:string;text:string;where?:string}[];pageType:string;aliases:string[];sourceEvidence:string[];rendered?:SourceRenderedEvidence}
interface EvidenceCache {file:MaterialFile;retryable?:boolean}
interface Checkpoint {entries:Record<string,EvidenceCache>;scanComplete?:boolean}
interface TargetRow {kind:'content'|'sqlite';container:string;id:string;value:unknown;evidence:string[];identityKeyField?:string}
const norm=(value:string)=>value.normalize('NFC').replace(/[\s\u00a0\u3000]+/g,' ').trim();
const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
const field=(value:unknown,key:string):any=>{const row=object(value);if(!row)return;const found=Object.keys(row).find(name=>name.toLowerCase()===key.toLowerCase());return found===undefined?undefined:row[found];};
const strings=(value:unknown):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):object(value)?Object.values(value as object).flatMap(strings):[];
function url(value:string,base:string,fragment=false){const parsed=new URL(value,base);if(parsed.username||parsed.password||!['http:','https:'].includes(parsed.protocol))throw new Error('URL 不在 HTTP 只读范围');if(!fragment)parsed.hash='';return parsed;}
const pathOf=(value:URL)=>value.pathname+value.search;
const unique=<T>(values:T[])=>[...new Set(values)];
class WindowEnded extends Error {}
class InventoryContractError extends Error {}
class CachedReadFailure extends Error {constructor(message:string,readonly evidence:string){super(message);}}

function frozenReader(collections:CollectionStore,run:CollectionRun,snapshot:CollectionSnapshot,directory:string){
  return (path:string)=>{
    const expected=snapshot.originals.find(item=>item.path===path);if(!expected)throw new Error('冻结索引未包含来源证据：'+path);
    const material=snapshot.files.find(file=>file.name==='collection/'+path);
    const bytes=material?readFileSync(safeCollectionPath(resolve(directory,'materials'),material.id)):readFileSync(safeCollectionPath(resolve(directory,'collection-snapshots',snapshot.id,'originals'),path));
    if(bytes.length!==expected.size||collectionHash(bytes)!==expected.sha256)throw new Error('来源证据与冻结哈希不一致：'+path);
    return bytes;
  };
}
function frozenRenderedIndex(read:(path:string)=>Buffer,run:CollectionRun,snapshot:CollectionSnapshot) {
  const records=snapshot.sourceRenderedEvidence||[];
  if(!records.length)return new Map<string,SourceRenderedEvidence>();
  assertSourceRenderedEvidenceIndex({...run,engineVersion:snapshot.engineVersion,sourceRenderedEvidence:records},read);
  const index=new Map<string,SourceRenderedEvidence>();
  for(const entry of records){
    if(entry.inputVersionId!==snapshot.inputVersionId||entry.collectionId!==snapshot.collectionId||!norm(entry.visibleText))throw new Error('冻结来源渲染证据缺少输入绑定或真实可见正文');
    index.set(url(entry.url,run.sourceUrl).href,entry);
  }
  return index;
}

/** A frozen index directs the independent evaluator; no new browser session is launched here. */
export function frozenCollectionRenderedTargets(task:AutomationTask,store:AutomationStore,directory:string) {
  if(!task.collectionVersionId)return [];
  const collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId),run=collections.forTask(task);
  if(!snapshot||!run||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId)throw new Error('来源渲染证据的冻结资料与当前输入不一致');
  collections.verify(snapshot);
  const read=frozenReader(collections,run,snapshot,directory),entries=frozenRenderedIndex(read,run,snapshot);
  if(!entries.size)return [];
  const targetOrigin=url(task.siteUrl,task.siteUrl).origin;
  return [...entries.values()].map(entry=>{const source=url(entry.url,run.sourceUrl),target=new URL(targetOrigin);target.pathname=source.pathname;target.search=source.search;return {sourceUrl:entry.url,targetUrl:target.href,viewport:entry.viewport,indexPath:'collection/'+sourceRenderedEvidencePath,observationPath:'collection/'+entry.observationPath,screenshotPath:'collection/'+entry.screenshotPath};});
}

/** Resolve harvest IDs from the immutable original archive, never the current collection workspace. */
export function frozenCollectionPageAliases(task:AutomationTask,store:AutomationStore,directory:string):Record<string,string> {
  if(!task.collectionVersionId)return {};
  const collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId),input=store.version(task.versionId);
  if(!snapshot||!input||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId)throw new Error('页面样本别名的冻结资料与当前输入不一致');
  collections.verify(snapshot);
  const indexed=snapshot.originals.find(item=>item.path==='.work/state.json');if(!indexed)throw new Error('冻结原件缺少页面样本身份索引');
  const bytes=readFileSync(safeCollectionPath(resolve(directory,'collection-snapshots',snapshot.id,'originals'),indexed.path));
  if(bytes.length!==indexed.size||collectionHash(bytes)!==indexed.sha256)throw new Error('冻结页面样本身份索引不完整或已变化');
  const state=JSON.parse(bytes.toString()),source=url(input.contentUrl,input.contentUrl);
  if(state.source!==input.contentUrl)throw new Error('冻结页面样本来源与固定输入不一致');
  const aliases=new Map<string,string>(),seen=new Set<string>(),ambiguous=new Set<string>();
  for(const record of Object.values(state.urls||{}) as any[]){
    if(typeof record?.id!=='string'||!record.id)continue;
    if(seen.has(record.id)){ambiguous.add(record.id);aliases.delete(record.id);continue;}seen.add(record.id);
    if(record.action!=='keep'||typeof record.status!=='number'||record.status<200||record.status>=300||typeof record.url!=='string')continue;
    try{const page=url(record.url,source.href);if(page.origin===source.origin)aliases.set(record.id,pathOf(page));}catch{}
  }
  return Object.fromEntries([...aliases].filter(([id])=>!ambiguous.has(id)));
}

interface TargetRenderedObservation {url:string;file:string;title:string;text:string;frames:VisibleBrowserFrame[];capturedAt:number;binding:{taskId:string;siteRevision:string};role:'target';viewport:'desktop'|'mobile';framesComplete:boolean;textTruncated:boolean}

function targetRenderedObservation(task:AutomationTask,store:AutomationStore,work:string,targetUrl:string,viewport:string) {
  const files=store.task(task.id)?.artifacts||[],observations:{value:TargetRenderedObservation;json:MaterialFile;index:number}[]=[],invalid:unknown[]=[];
  const readFile=(file:MaterialFile)=>{
    if(!/^[a-zA-Z0-9_.-]+$/.test(file.name)||file.name==='.'||file.name==='..')throw new Error('浏览器证据文件名无效');
    const bytes=readFileSync(resolve(work,file.name));
    if(bytes.length!==file.size||collectionHash(bytes)!==file.sha256)throw new Error('浏览器证据缺失或哈希变化：'+file.name);
    return bytes;
  };
  for(const [index,file] of files.filter(file=>file.type==='application/json'&&file.role==='target'&&/^[a-f0-9-]{36}\.json$/.test(file.name)).entries()){
    let observation:TargetRenderedObservation;
    try{observation=JSON.parse(readFile(file).toString()) as TargetRenderedObservation;}catch(error){invalid.push(error);continue;}
    if(!object(observation)){invalid.push(new Error('目标渲染观测形状无效'));continue;}
    if(observation.url!==targetUrl||observation.viewport!==viewport||observation.role!=='target'||observation.binding?.taskId!==task.id||observation.binding?.siteRevision!==task.siteRevision)continue;
    if(!Number.isFinite(observation.capturedAt)||observation.capturedAt<=0){invalid.push(new Error('目标渲染观测缺少有效采集时间'));continue;}
    observations.push({value:observation,json:file,index});
  }
  // A later complete observation supersedes an older incomplete one. Conversely,
  // never fall back to an old success when the latest bound observation is incomplete.
  const latest=observations.sort((a,b)=>b.value.capturedAt-a.value.capturedAt||b.index-a.index)[0];
  if(!latest){if(invalid.length)throw invalid[0];return;}
  const {value:observation,json:file}=latest;
  if(file.viewport!==observation.viewport||typeof observation.file!=='string'||file.name!==observation.file.replace(/\.png$/,'.json'))throw new Error('目标渲染观测身份或截图引用不完整');
  if(observation.framesComplete!==true||observation.textTruncated!==false||typeof observation.text!=='string'||!Array.isArray(observation.frames)||observation.frames.some(frame=>typeof frame?.url!=='string'||typeof frame?.text!=='string'))throw new Error('目标可见正文或iframe观测不完整');
  const image=files.find(image=>image.name===observation.file&&image.type==='image/png'&&image.role==='target'&&image.viewport===viewport);
  if(!image)throw new Error('目标渲染观测缺少同视口真实截图');
  if(!readFile(image).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('目标渲染证据不是PNG截图');
  return {value:observation,json:file,image};
}

function sourcePages(read:(path:string)=>Buffer,run:CollectionRun,snapshot:CollectionSnapshot){
  const state=JSON.parse(read('.work/state.json').toString()),pages:SourcePage[]=[],renderedIndex=frozenRenderedIndex(read,run,snapshot);
  if(state.source!==run.sourceUrl)throw new Error('冻结发现状态与原站不一致');
  for(const record of Object.values(state.urls||{}) as any[]){
    if(record.action!=='keep')continue;
    const source=url(String(record.url),run.sourceUrl);if(source.origin!==url(run.sourceUrl,run.sourceUrl).origin)throw new Error('冻结来源页面越出任务原站');
    if(typeof record.id!=='string'||typeof record.rawFile!=='string')throw new Error('冻结页面缺少来源身份或原件');
    const extractPath='.work/extract/'+record.id+'.json',extracted=JSON.parse(read(extractPath).toString()),raw=read(record.rawFile).toString();
    const rendered=renderedIndex.get(source.href);
    if(rendered&&(rendered.pageId!==record.id||rendered.rawPath!==record.rawFile||rendered.extractPath!==extractPath))throw new Error('冻结渲染证据与逐页来源身份不一致：'+source.href);
    let title=typeof extracted.title==='string'?norm(extracted.title):'';const fullText=typeof extracted.fullText==='string'?extracted.fullText:'';
    if(!title||!norm(fullText)&&!rendered)throw new Error('冻结逐页标题或全文缺失：'+source.href);
    // Extraction itself is not the original. Check its text against the frozen raw document.
    const original=html(raw,source.href),rawText=norm(original.allText+' '+original.title);
    if(original.unsupported||!original.title&&!original.text.includes(title))throw new Error('冻结标题或 HTML 实体不能回指原件：'+source.href);
    // extract_page caps metadata titles at 300 characters; the raw title is authoritative.
    if(original.title)title=original.title;
    if(fullText.split(/\n+/).map(norm).filter(Boolean).some((part:string)=>!rawText.includes(part)))throw new Error('冻结全文不能逐段回指原件：'+source.href);
    const extractedLinks=(Array.isArray(extracted.links)?extracted.links:[]).flatMap((link:any)=>typeof link==='string'?[{url:link,text:'',where:'content'}]:typeof link?.url==='string'?[{url:link.url,text:typeof link.text==='string'?link.text:'',where:link.where}]:[]);
    // Required hrefs remain a union, but only the original may assign region and order.
    // A legacy extracted-only link is still required; it cannot invent a list member.
    const links=[...original.links,...extractedLinks.filter((link:{url:string})=>!original.links.some(existing=>existing.url===link.url)).map((link:{url:string;text:string})=>({...link,where:'unverified'}))];
    pages.push({id:record.id,url:source.href,path:pathOf(source),rawFile:record.rawFile,title,fullText,segments:original.segments,semanticFragments:original.semanticFragments,links,pageType:extracted.pageType||'',aliases:unique([record.id,source.href,pathOf(source)]),sourceEvidence:[record.rawFile,extractPath,...(rendered?[rendered.observationPath,rendered.screenshotPath]:[])],...(rendered?{rendered}:{})});
  }
  if(!pages.length)throw new Error('冻结来源没有必迁页面');
  if(new Set(pages.map(page=>page.id)).size!==pages.length)throw new Error('冻结来源存在重复页面身份');
  if(new Set(pages.map(page=>page.path)).size!==pages.length)throw new Error('冻结来源存在重复或冲突的页面 URL');
  // Candidate records establish identities only. Their truncated body/links never replace originals.
  if(snapshot.originals.some(item=>item.path==='data/page-groups.json')){
    const groups=JSON.parse(read('data/page-groups.json').toString());
    if(groups.source!==undefined&&groups.source!==run.sourceUrl||!Array.isArray(groups.pageGroups))throw new Error('冻结页面组索引与来源不一致');
    const groupIds=new Set<string>();
    for(const group of groups.pageGroups){
      if(typeof group.id!=='string'||!group.id||groupIds.has(group.id))throw new Error('冻结页面组身份缺失或重复');groupIds.add(group.id);
      if(typeof group.dataFile!=='string')continue;
      const index=JSON.parse(read(group.dataFile).toString());
      if(!Array.isArray(index.parts)||index.source!==undefined&&index.source!==run.sourceUrl||index.pageGroup!==undefined&&index.pageGroup!==group.id)throw new Error('冻结数据索引缺少分片或来源身份不一致');
      let total=0;const seenParts=new Set<string>(),seenUrls=new Set<string>(),seenIds=new Set<string>();
      for(const part of index.parts){
        if(typeof part.file!=='string'||seenParts.has(part.file))throw new Error('冻结数据分片缺少文件引用或重复');seenParts.add(part.file);
        const payload=JSON.parse(read(part.file).toString()),records=Array.isArray(payload)?payload:payload?.records;
        if(!Array.isArray(records)||!Number.isSafeInteger(part.count)||part.count<0||records.length!==part.count)throw new Error('冻结数据分片数量不一致');
        total+=records.length;
        for(const record of records){
          if(typeof record?.url!=='string'||!/^https?:\/\//i.test(record.url))throw new Error('候选记录缺少完整来源URL');
          const source=url(record.url,run.sourceUrl),page=pages.find(item=>item.url===source.href);
          if(source.origin!==url(run.sourceUrl,run.sourceUrl).origin||!page||seenUrls.has(source.href))throw new Error('候选记录没有唯一对应冻结来源页');seenUrls.add(source.href);
          if(record.path!==undefined&&record.path!==page.path)throw new Error('候选记录路径与冻结来源页不一致');
          if(record.sourceId!==undefined&&String(record.sourceId)!==''){
            const sourceId=String(record.sourceId);if(!['string','number'].includes(typeof record.sourceId)||seenIds.has(sourceId))throw new Error('候选记录来源身份重复或无效');seenIds.add(sourceId);
            page.aliases.push(sourceId,group.id+':'+sourceId,group.id+'/'+sourceId);
          }
        }
      }
      for(const count of [group.count,index.count])if(count!==undefined&&(!Number.isSafeInteger(count)||count<0||count!==total))throw new Error('冻结数据页面组总数与分片不一致');
    }
  }
  return pages;
}

export interface FrozenCollectionSourceInventory {
  version:1; collectionVersionId:string; snapshotHash:string; sourceUrl:string;
  pages:{id:string;url:string;path:string;aliases:string[];pageType:string;sourceEvidence:string[];memberUrls:string[]}[];
  /** Every URL identity is retained even when several URLs share the same original bytes. */
  assets:Record<'assets'|'files'|'stylesheets',{keys:string[];acquiredKeys:string[];originals:{sourceUrl:string;materialPath:string;sha256:string;size:number}[];issues:{sourceUrl?:string;reason:string}[]}>;
  coverage:{universe:'frozen-originals';excludedPages:{url:string;reason:string}[];acceptedAssetGapUrls:string[]};
  limitations:string[];
}
export interface CollectionTargetPreflight {
  version:1; state:'passed'|'limited'|'blocked'; binding:string;
  snapshotHash:string; manifestHash:string; checks:CollectionTargetCheck[];
  inventory?:FrozenCollectionSourceInventory;
}

/** Read-only source inventory for deterministic manifest construction, without a target request or model. */
export function frozenCollectionSourceInventory(task:AutomationTask,store:AutomationStore,directory:string):FrozenCollectionSourceInventory {
  const collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId||''),run=collections.forTask(task),input=store.version(task.versionId);
  if(!snapshot||!run||!input||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId||run.id!==snapshot.collectionId||run.inputVersionId!==task.versionId||input.contentUrl!==run.sourceUrl||store.task(snapshot.taskId)?.resourceId!==task.resourceId)throw new Error('来源清单无法绑定当前固定输入与冻结快照');
  collections.verify(snapshot);
  const read=frozenReader(collections,run,snapshot,directory),pages=sourcePages(read,run,snapshot),state=JSON.parse(read('.work/state.json').toString());
  const pageUrls=new Set(pages.map(page=>page.url));
  const assets={} as FrozenCollectionSourceInventory['assets'];
  for(const collection of ['assets','files','stylesheets'] as const){
    const rows=Array.isArray(state[collection])?state[collection]:[],keys:string[]=[],acquiredKeys:string[]=[];
    for(const row of rows)try{if(typeof row?.url!=='string')continue;const key=url(row.url,run.sourceUrl).href;keys.push(key);if(['saved','cached','deduped',...(collection==='stylesheets'?['read']:[])].includes(row.status))acquiredKeys.push(key);}catch{}
    const parsed=parseFrozenAssetSource({state,sourceUrl:run.sourceUrl,expectedKeys:unique(acquiredKeys),expectedCount:unique(acquiredKeys).length,readFrozen:read,collection});
    // An absent optional collection is not a fabricated source failure.
    assets[collection]={keys:unique(keys),acquiredKeys:unique(acquiredKeys),originals:parsed.assets,issues:state[collection]===undefined?[]:parsed.issues};
  }
  const excludedPages=(Object.values(state.urls||{}) as any[]).filter(record=>record?.action!=='keep'&&typeof record?.url==='string'&&!['asset','non-html'].includes(record?.reason)).map(record=>({url:record.url,reason:typeof record.reason==='string'?record.reason:'来源发现记录未纳入冻结必迁页'}));
  const acceptedAssetGapUrls=unique((snapshot.acceptedAssetGaps||[]).flatMap(batch=>batch.entries.map(entry=>entry.url)));
  return {version:1,collectionVersionId:snapshot.id,snapshotHash:snapshot.sha256,sourceUrl:run.sourceUrl,
    pages:pages.map(page=>({id:page.id,url:page.url,path:page.path,aliases:unique(page.aliases),pageType:page.pageType,sourceEvidence:page.sourceEvidence,
      // Relation identities must come from original content links, never a truncated candidate record.
      memberUrls:unique(html(read(page.rawFile).toString(),page.url).links.filter(link=>link.where==='content').map(link=>link.url).filter(link=>pageUrls.has(link)&&link!==page.url))})),
    assets,coverage:{universe:'frozen-originals',excludedPages,acceptedAssetGapUrls},limitations:[
      '身份全集只证明冻结原件覆盖范围；不能推定发现范围以外的原站页面、功能或数据已经完整。',
      ...(excludedPages.length?[`冻结发现索引有 ${excludedPages.length} 条未纳入必迁页的来源记录，必须保留其具体原因。`]:[]),
      ...Object.entries(assets).flatMap(([collection,value])=>value.issues.length?[`${collection} 有 ${value.issues.length} 项来源原件限制，不能用目标文件数或读取状态替代原字节。`]:[])]};
}

/** Source-only preflight; a limitation remains unresolved but does not prevent independent target reads. */
export function preflightCollectionTarget(options:{task:AutomationTask;manifest:RequirementManifest;store:AutomationStore;directory:string}):CollectionTargetPreflight {
  const {task,manifest,store,directory}=options,manifestHash=collectionHash(JSON.stringify(manifest)),checks:CollectionTargetCheck[]=[];
  let inventory:FrozenCollectionSourceInventory|undefined,snapshotHash='';
  const add=(id:string,reason:string,failureClass:'source-limitation'|'contract-tool-defect',requirementId?:string,evidence:string[]=[])=>checks.push({id:'preflight:'+id,kind:failureClass==='contract-tool-defect'?'binding':'data',status:'unverified',failureClass,reason,...(requirementId?{requirementId}:{}),evidence});
  try{
    inventory=frozenCollectionSourceInventory(task,store,directory);snapshotHash=inventory.snapshotHash;
    const snapshot=new CollectionStore(store,directory).snapshot(task.collectionVersionId||'')!;
    assertFrozenManifestPreserved(store,snapshot,manifest);
    const manifestOwner=store.task(manifest.taskId);
    if(task.requirementsId!==manifest.id||manifest.taskId!==task.id&&(!manifestOwner||manifestOwner.resourceId!==task.resourceId||manifestOwner.versionId!==task.versionId))add('manifest-binding','清单未绑定当前任务固定输入、资源和清单身份','contract-tool-defect');
    const ids=new Set<string>();for(const item of manifest.items){if(ids.has(item.id))add('duplicate:'+item.id,'清单要求身份重复','contract-tool-defect',item.id);ids.add(item.id);}
    const resolveKeys=(keys:readonly string[],id:string)=>{
      const selected:FrozenCollectionSourceInventory['pages']=[];
      for(const key of keys){const matches=inventory!.pages.filter(page=>page.aliases.includes(key));if(matches.length!==1||selected.some(page=>page.url===matches[0]?.url))add('identity:'+id+':'+key,'清单身份无法唯一回指冻结来源或同一页面重复计数：'+key,'contract-tool-defect',id);else selected.push(matches[0]);}
      return selected;
    };
    const scope=(refs:string[],id:string)=>{
      const selected=new Map<string,FrozenCollectionSourceInventory['pages'][number]>();
      if(!refs.length||unique(refs).length!==refs.length)add('scope:'+id,'关系引用要求为空或重复','contract-tool-defect',id);
      for(const ref of refs){const item=manifest.items.find(item=>item.id===ref);if(!item?.required||!(item.kind==='page'||item.kind==='data'&&(!item.dataIdentity||item.dataIdentity.kind==='page'))){add('scope:'+id+':'+ref,'关系引用不是必迁页面身份域：'+ref,'contract-tool-defect',id);continue;}
        const keys=item.kind==='page'?item.paths:item.expectedKeys||[];if(!keys.length||item.expectedCount!==null&&item.expectedCount!==keys.length||item.kind==='data'&&item.expectedCount===null)add('scope-count:'+id+':'+ref,'关系引用要求缺少明确身份全集和匹配数量','contract-tool-defect',id);
        for(const page of resolveKeys(keys,id))selected.set(page.url,page);
      }return selected;
    };
    for(const item of manifest.items.filter(item=>item.required)){
      if(item.kind==='data'&&item.dataIdentity?.kind==='relations'){
        const parents=scope(item.dataIdentity.parentRequirementIds,item.id),children=scope(item.dataIdentity.childRequirementIds,item.id);
        const keys=[...parents.values()].flatMap(page=>page.memberUrls.filter(member=>children.has(member)).map(member=>JSON.stringify([page.url,member]))),expected=item.expectedKeys||[];
        if(item.expectedCount!==keys.length||expected.length!==keys.length||new Set(expected).size!==expected.length||expected.some(key=>!keys.includes(key)))add('relations:'+item.id,'关系清单数量或完整逐边键集与冻结父子原件不一致','contract-tool-defect',item.id,[...parents.values()].flatMap(page=>page.sourceEvidence));
      }else if(item.kind==='data'&&item.dataIdentity?.kind==='assets'){
        const collections=new CollectionStore(store,directory),run=collections.forTask(task)!,read=frozenReader(collections,run,snapshot,directory),state=JSON.parse(read('.work/state.json').toString());
        const source=parseFrozenAssetSource({state,sourceUrl:inventory.sourceUrl,expectedKeys:item.expectedKeys,expectedCount:item.expectedCount,readFrozen:read});
        // Original-byte absence is a source boundary. Keys/count omissions are a manifest contract failure.
        const keySet=new Set(inventory.assets.assets.acquiredKeys),expected=item.expectedKeys||[];
        if(!Array.isArray(item.expectedKeys)||item.expectedCount!==expected.length||new Set(expected).size!==expected.length||[...keySet].some(key=>!expected.includes(key))||expected.some(key=>!inventory!.assets.assets.keys.includes(key)))add('assets-contract:'+item.id,'素材清单必须保留冻结来源URL全集和匹配数量','contract-tool-defect',item.id);
        for(const [index,issue] of source.issues.entries())add('assets-source:'+item.id+':'+index,issue.reason+(issue.sourceUrl?'：'+issue.sourceUrl:''),'source-limitation',item.id,['collection/.work/state.json']);
      }else if(item.kind==='page'||item.kind==='data'&&(!item.dataIdentity||item.dataIdentity.kind==='page')||item.kind==='template'&&!!item.expectedKeys?.length){
        const keys=item.kind==='page'?item.paths:item.expectedKeys||[];
        if(item.kind!=='page'&&(!keys.length||item.expectedCount===null)||item.expectedCount!==null&&item.expectedCount!==keys.length)add('count:'+item.id,'页面身份域必须具有完整键集与匹配数量','contract-tool-defect',item.id);
        resolveKeys(keys,item.id);
      }
    }
    if(manifest.items.some(item=>item.required&&item.kind==='data'&&item.dataIdentity?.kind==='assets'))for(const [index,issue] of inventory.assets.stylesheets.issues.entries())add('stylesheets:'+index,issue.reason+(issue.sourceUrl?'：'+issue.sourceUrl:''),'source-limitation',undefined,['collection/.work/state.json']);
  }catch(error){add('source',error instanceof Error?error.message:'冻结来源无法读取','contract-tool-defect');}
  const binding=collectionHash(JSON.stringify({version:1,taskId:task.id,inputVersionId:task.versionId,snapshotHash,manifestHash}));
  return {version:1,state:checks.some(check=>check.failureClass==='contract-tool-defect')?'blocked':checks.length?'limited':'passed',binding,snapshotHash,manifestHash,checks,...(inventory?{inventory}:{})};
}

function declaredSourceUrls(value:unknown,sourceOrigin:string,includeForeign=false):string[]{
  const result:string[]=[];
  const add=(candidate:unknown)=>{for(const text of strings(candidate))try{const parsed=url(text,sourceOrigin);if((includeForeign||parsed.origin===sourceOrigin)&&/^https?:\/\//i.test(text))result.push(parsed.href);}catch{}};
  const walk=(node:unknown)=>{if(Array.isArray(node)){for(const item of node)walk(item);return;}if(!object(node))return;for(const [key,value] of Object.entries(node as object)){if(['sourceurl','oldurl'].includes(key.toLowerCase()))add(value);else if(['name','key'].includes(key.toLowerCase())&&typeof value==='string'&&['sourceurl','oldurl'].includes(value.toLowerCase()))add(field(node,'values')??field(node,'value'));else if(typeof value==='object')walk(value);}};
  walk(value);return unique(result);
}
function rowObject(value:unknown):Record<string,any>|undefined {
  if(Array.isArray(value)&&value.every(cell=>typeof field(cell,'key')==='string'))return Object.fromEntries(value.map(cell=>[field(cell,'key'),field(cell,'value')]));
  return object(value);
}
function recordIdentity(row:TargetRow,name=row.identityKeyField||'id'):string|undefined {
  const value=name==='id'?row.id:field(row.value,name);
  return (typeof value==='string'&&value.trim()!==''||typeof value==='number'&&Number.isFinite(value))?String(value):undefined;
}

function assertFrozenManifestPreserved(store:AutomationStore,snapshot:CollectionSnapshot,current:RequirementManifest){
  if(snapshot.manifestId===current.id)return;
  const baseline=new ManifestStore(store).get(snapshot.manifestId);
  if(!baseline||baseline.taskId!==snapshot.taskId||current.revision<=baseline.revision)throw new Error('当前清单无法回指冻结采集清单基线');
  assertMigrationBaselinePreserved(baseline.migration,current.migration);
  for(const item of baseline.items.filter(item=>item.required)){
    const next=current.items.find(next=>next.id===item.id);
    if(!next||!next.required||next.kind!==item.kind||item.paths.some(path=>!next.paths.includes(path))||item.viewports.some(viewport=>!next.viewports.includes(viewport))||(item.expectedCount!==null&&(next.expectedCount===null||next.expectedCount<item.expectedCount))||(item.expectedKeys||[]).some(key=>!next.expectedKeys?.includes(key))||(item.samples||[]).some(sample=>!next.samples?.includes(sample)))throw new Error('当前清单删除、缩减或降级冻结采集必交付基线：'+item.id);
    assertRequirementDataIdentityPreserved(item,next);
  }
}

export function collectionTargetGate(report:CollectionTargetReport|undefined,task:AutomationTask,manifest:RequirementManifest){
  return !!report&&report.verifierVersion===COLLECTION_TARGET_VERIFIER_VERSION&&report.state==='complete'&&report.checks.length>0&&report.checks.every(check=>check.status==='verified')&&report.taskId===task.id&&report.inputVersionId===task.versionId&&report.collectionId===task.collectionId&&report.collectionVersionId===task.collectionVersionId&&report.manifestId===manifest.id&&report.manifestRevision===manifest.revision&&report.manifestHash===collectionHash(JSON.stringify(manifest))&&report.generatedSiteId===task.generatedSiteId&&!!task.siteRevision&&report.siteRevision===task.siteRevision;
}
export function latestCollectionTargetReport(store:AutomationStore,task:AutomationTask,manifest:RequirementManifest):CollectionTargetReport|undefined {
  return new CollectionTargetReports(store).latest({taskId:task.id,verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION,inputVersionId:task.versionId,collectionId:task.collectionId,collectionVersionId:task.collectionVersionId,manifestId:manifest.id,manifestRevision:manifest.revision,manifestHash:collectionHash(JSON.stringify(manifest)),generatedSiteId:task.generatedSiteId??undefined,siteId:store.site(task.generatedSiteId||'')?.siteId,siteRevision:task.siteRevision});
}

/** Standard frozen collection → current target verification. Read-only and independently persisted. */
export async function verifyCollectionTarget(options:VerifyCollectionTargetOptions):Promise<CollectionTargetReport>{
  const {task,manifest,store,vault,directory,signal}=options,collections=new CollectionStore(store,directory),snapshot=collections.snapshot(task.collectionVersionId||''),run=collections.forTask(task),site=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
  const binding=collectionHash(JSON.stringify({verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION,task:task.id,input:task.versionId,snapshot:task.collectionVersionId,snapshotHash:snapshot?.sha256,manifest:manifest.id,manifestHash:collectionHash(JSON.stringify(manifest)),revision:manifest.revision,site:site?.siteId,siteRevision:task.siteRevision,relationBindings:options.relationBindings||[]}));
  const report:CollectionTargetReport={version:1,verifierVersion:COLLECTION_TARGET_VERIFIER_VERSION,id:randomUUID(),taskId:task.id,inputVersionId:task.versionId,collectionId:task.collectionId||'',collectionVersionId:task.collectionVersionId||'',snapshotHash:snapshot?.sha256||'',manifestId:manifest.id,manifestRevision:manifest.revision,manifestHash:collectionHash(JSON.stringify(manifest)),generatedSiteId:task.generatedSiteId||'',siteId:site?.siteId||'',siteRevision:task.siteRevision||'',binding,state:'unverified',checkedAt:Date.now(),checkedPages:0,expectedPages:0,checks:[],artifacts:[],issues:[],limitations:['核对固定资料的 URL、正文、标题、链接、声明的页面/关系身份及显式素材映射；视觉与交互仍由独立评测核验，未冻结的素材原件不得推断。','页面 HTTP 客户端不提供 Location；页面重定向结果保留未验证，不以 3xx 或 200 自动放行。']};
  const work=resolve(directory,'automation-runs',task.id,'evidence');mkdirSync(work,{recursive:true,mode:0o700});
  store.db.exec('CREATE TABLE IF NOT EXISTS auto_collection_target_reports(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,binding TEXT NOT NULL,created_at INTEGER NOT NULL,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS auto_collection_target_checkpoints(binding TEXT PRIMARY KEY,json TEXT NOT NULL)');
  const previous=store.db.prepare('SELECT json FROM auto_collection_target_checkpoints WHERE binding=?').get(binding),checkpoint:Checkpoint=previous?JSON.parse(previous.json):{entries:{}};
  const saveCheckpoint=()=>store.db.prepare('INSERT INTO auto_collection_target_checkpoints VALUES(?,?) ON CONFLICT(binding) DO UPDATE SET json=excluded.json').run(binding,JSON.stringify(checkpoint));
  if(options.retryTransientFailures&&checkpoint.scanComplete){for(const [key,entry] of Object.entries(checkpoint.entries))if(entry.retryable)delete checkpoint.entries[key];checkpoint.scanComplete=false;saveCheckpoint();}
  const write=(kind:string,value:unknown)=>{
    const bytes=Buffer.from(JSON.stringify(store.sanitize(value))),sha256=collectionHash(bytes),identity=collectionHash(JSON.stringify([binding,kind,sha256]));
    const file:MaterialFile={id:identity,name:'collection-target-'+kind+'-'+identity+'.json',type:'application/json',role:'target',size:bytes.length,sha256};
    try{writeFileSync(resolve(work,file.name),bytes,{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const previous=readFileSync(resolve(work,file.name));if(previous.length!==file.size||collectionHash(previous)!==sha256)throw new Error('已持久化差异证据哈希变化：'+file.name);}
    report.artifacts.push(file);return file;
  };
  const bounded=(value:string,max:number)=>value.length<=max?value:value.slice(0,max)+'…（完整差异见证据）';
  const check=(value:CollectionTargetCheck)=>report.checks.push({...value,...(value.status!=='verified'?{failureClass:collectionVerificationFailureClass(value)}:{}),reason:bounded(value.reason,3000)});
  let requests=0;const maxRequests=options.maxRequests??50;if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>10000)throw new Error('B段单轮请求窗口不合法');
  const cached=async(key:string,read:()=>Promise<unknown>,retain=(value:any)=>true)=>{
    signal.throwIfAborted();const existing=checkpoint.entries[key];
    if(existing){let observed:any;try{if(!/^collection-target-observation-[a-f0-9]{64}\.json$/.test(existing.file.name))throw new Error('检查点证据名无效');const bytes=readFileSync(resolve(work,existing.file.name)),parsed=JSON.parse(bytes.toString());if(bytes.length===existing.file.size&&collectionHash(bytes)===existing.file.sha256&&parsed.binding===binding&&parsed.key===key)observed=parsed;}catch{}
      if(observed){report.artifacts.push(existing.file);if(observed.error)throw new CachedReadFailure(observed.error.message,existing.file.name);return {value:observed.value,evidence:existing.file.name};}delete checkpoint.entries[key];}
    if(requests>=maxRequests)throw new WindowEnded();requests++;
    let value:unknown;
    try{value=await read();}catch(error){signal.throwIfAborted();const message=error instanceof Error?error.message:'只读请求失败',file=write('observation',{binding,key,capturedAt:Date.now(),error:{message}});checkpoint.entries[key]={file,retryable:true};saveCheckpoint();throw new CachedReadFailure(message,file.name);}
    const file=write('observation',{binding,key,capturedAt:Date.now(),value});
    checkpoint.entries[key]={file,retryable:!retain(value)};saveCheckpoint();
    return {value,evidence:file.name};
  };
  const inspect=async(spec:unknown)=>cached('implementation:'+JSON.stringify(spec),()=> (options.dependencies?.inspect||inspectImplementation)(task,store,vault,signal,spec));
  try{
    if(!snapshot||!run||!site||!task.siteRevision||!task.collectionId||task.requirementsId!==manifest.id||snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==run.id||run.inputVersionId!==task.versionId||store.task(run.taskId)?.resourceId!==task.resourceId)throw new Error('B段输入、清单、来源快照或生成站身份未完整绑定');
    assertFrozenManifestPreserved(store,snapshot,manifest);
    if(store.siteState(site.id)?.revision!==task.siteRevision)throw new Error('B段目标站当前修订与任务不一致');
    const preflight=preflightCollectionTarget({task,manifest,store,directory});
    for(const entry of preflight.checks)check(entry);
    if(preflight.inventory){report.limitations.push(...preflight.inventory.limitations);report.expectedPages=preflight.inventory.pages.length;}
    if(preflight.state==='blocked'){
      for(const item of manifest.items.filter(item=>item.required&&item.kind==='data'))check({id:'data:'+item.id,kind:item.dataIdentity?.kind==='relations'?'relations':'data',status:'unverified',failureClass:'contract-tool-defect',requirementId:item.id,expectedKeys:item.expectedKeys,reason:'确定性来源/清单预检未通过；尚未请求目标，不能把来源或合同错误转为已证目标缺陷。',evidence:preflight.checks.flatMap(entry=>entry.evidence)});
      throw new Error('B段来源/清单确定性预检阻断，详见 preflight 检查；不能委托修站消除合同或来源绑定错误');
    }
    collections.verify(snapshot);const read=frozenReader(collections,run,snapshot,directory),pages=sourcePages(read,run,snapshot),sourceOrigin=url(run.sourceUrl,run.sourceUrl).origin,targetOrigin=url(task.siteUrl||site.url,task.siteUrl||site.url).origin;
    const acceptedEntries=(snapshot.acceptedAssetGaps||[]).flatMap(acceptance=>acceptance.entries),acceptedUrls=new Set(acceptedEntries.filter(entry=>entry.status==='failed').map(entry=>entry.url));
    const acceptedCount=new Set(acceptedEntries.map(entry=>JSON.stringify([entry.collection,entry.kind,entry.url,entry.status,entry.note]))).size;
    if(acceptedCount)report.limitations.push(`冻结快照记录人类接受的失败素材共 ${acceptedCount} 项（${snapshot.acceptedAssetGaps?.length||0} 批）。仅这些精确 URL 的原失败素材可缺失，不要求目标重新请求或恢复；来源页面链接、其他缺失链接、正文、标题、已取得素材、数据、关系和新增缺口仍须核验。接受索引：collection/site/accepted-source-gaps.json。`);
    const frozenState=JSON.parse(read('.work/state.json').toString()),sourcePageUrls=new Set(pages.map(page=>page.url));
    sourcePageUrls.add(url(run.sourceUrl,run.sourceUrl).href);
    for(const record of Object.values(frozenState.urls||{})){const row=object(record),value=row?.url;if(typeof value==='string'&&!['asset','non-html'].includes(row?.reason))try{sourcePageUrls.add(url(value,run.sourceUrl).href);}catch{}}
    const acceptedAssetLink=(value:string,base:string)=>{
      if(!acceptedUrls.has(value))return false;
      try{return !sourcePageUrls.has(url(value,base).href);}catch{return false;}
    };
    report.expectedPages=pages.length;check({id:'binding',kind:'binding',status:'verified',reason:'原件、资料、输入、清单和目标当前修订已绑定。',evidence:[]});
    const mapLink=(value:string,base:string)=>{try{const parsed=url(value,base,true);if(parsed.origin===sourceOrigin){const mapped=new URL(targetOrigin);mapped.pathname=parsed.pathname;mapped.search=parsed.search;mapped.hash=parsed.hash;return mapped.href;}return parsed.href;}catch{return value;}};
    const targetPages=new Map<string,ReturnType<typeof html>>(),evidenceByPage=new Map<string,string>();
    for(const page of pages){
      signal.throwIfAborted();const targetUrl=mapLink(page.url,run.sourceUrl);
      try{
        const response=await cached('http:'+targetUrl,()=> (options.dependencies?.readHttp||httpRead)(new URL(targetUrl),{signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),limit:16*1024*1024}),value=>value.status>=200&&value.status<300||[404,410].includes(value.status));
        const actual=response.value as Awaited<ReturnType<typeof httpRead>>,evidence=[response.evidence];report.checkedPages++;evidenceByPage.set(page.url,response.evidence);
        if(actual.status>=300&&actual.status<400){check({id:'page:'+page.path,kind:'page',status:'unverified',sourcePath:page.path,reason:'目标响应为重定向；未取得目标 Location 与最终正文，不能证明承接正确。',evidence});continue;}
        if(actual.status<200||actual.status>=300){check({id:'page:'+page.path,kind:'page',status:[404,410].includes(actual.status)?'missing':'unverified',sourcePath:page.path,reason:'目标路径响应 HTTP '+actual.status+'，尚未证明原页交付。',evidence});continue;}
        const target=html(actual.body,targetUrl);targetPages.set(page.url,target);
        const titleOk=target.title===page.title,missingText=missingCollectionText(page.semanticFragments.map(fragment=>fragment.linkUrl&&acceptedAssetLink(fragment.linkUrl,page.url)?{...fragment,linkUrl:undefined}:fragment),target,value=>mapLink(value,page.url),targetOrigin);
        const absentLinks=page.links.filter(link=>!target.links.some(actual=>collectionLinksEquivalent(mapLink(link.url,page.url),actual.url,targetOrigin))),acceptedMissingLinks=absentLinks.filter(link=>acceptedAssetLink(link.url,page.url)),missingLinks=absentLinks.filter(link=>!acceptedAssetLink(link.url,page.url));
        const status=target.unsupported?'unverified':!titleOk||missingText.length||missingLinks.length?'missing':'verified';
        const diff=write('page-difference',{sourceUrl:page.url,targetUrl,sourceEvidence:page.sourceEvidence,sourceTitle:page.title,actualTitle:target.title,missingText,missingLinks,acceptedMissingLinks});
        check({id:'page:'+page.path,kind:'page',status,sourcePath:page.path,...(target.unsupported?{failureClass:'contract-tool-defect' as const}:{}),differences:{missingTextFragments:missingText.slice(0,8).map(text=>text.slice(0,600)),missingLinkUrls:missingLinks.slice(0,8).map(link=>link.url),textTruncated:missingText.length>8||missingText.some(text=>text.length>600)},reason:status==='verified'?`逐页标题、原件语义文本片段及约定必迁链接在目标实际响应中一致。${acceptedMissingLinks.length?'已按冻结的人类记录接受 '+acceptedMissingLinks.length+' 条失败素材超链接缺失，见差异证据。':''}`:target.unsupported?'目标含暂未支持的 HTML 实体，保留未验证。':'目标实际正文、标题或链接与冻结来源不一致；HTTP 200 不构成通过。',evidence:[...evidence,diff.name]});
        if(page.rendered){
          try{
            const observed=targetRenderedObservation(task,store,work,targetUrl,page.rendered.viewport);
            if(!observed){check({id:'rendered:'+page.path,kind:'page',status:'unverified',sourcePath:page.path,reason:'缺少绑定本评测任务、目标当前修订、精确URL与视口的真实可见正文和截图观测；HTTP或脚本不能替代。',evidence:[]});continue;}
            const allowedFrames=new Set((page.rendered.frames||[]).flatMap(frame=>{try{return [mapLink(url(frame.url,page.url).href,page.url)];}catch{return [];}}));
            const usedFrames=observed.value.frames.filter(frame=>allowedFrames.has(frame.url));
            const visible=norm([observed.value.text,...usedFrames.map(frame=>frame.text)].join('\n'));
            const missingVisibleText=unique(page.rendered.visibleText.split(/\n+/).map(norm).filter(Boolean).filter(part=>!visible.includes(part)));
            const renderedDiff=write('rendered-difference',{sourceUrl:page.url,targetUrl,sourceEvidence:[page.rendered.observationPath,page.rendered.screenshotPath],targetObservation:observed.json.name,missingVisibleText,usedFrameUrls:usedFrames.map(frame=>frame.url),ignoredFrameUrls:observed.value.frames.filter(frame=>!allowedFrames.has(frame.url)).map(frame=>frame.url),boundary:'只比较冻结渲染可见正文；不证明地图/缩放/平移等交互已通过。交互仍须独立评测实际操作和取证。'});
            report.artifacts.push(observed.json,observed.image);
            check({id:'rendered:'+page.path,kind:'page',status:missingVisibleText.length?'missing':'verified',sourcePath:page.path,reason:missingVisibleText.length?'目标真实可见正文与冻结来源渲染证据不一致；脚本或未映射iframe内文本不计入可见交付。':'冻结来源渲染可见正文在绑定本任务、当前修订和精确URL的真实目标观测中一致；仅此文本核验通过，交互仍须独立实际操作。',evidence:[observed.json.name,observed.image.name,renderedDiff.name]});
          }catch(error){const failed=write('rendered-read-error',{sourceUrl:page.url,targetUrl,error:error instanceof Error?error.message:'无法读取真实渲染观测'});check({id:'rendered:'+page.path,kind:'page',status:'unverified',sourcePath:page.path,reason:'真实目标渲染证据不能核验：'+(error instanceof Error?error.message:'观测无效'),evidence:[failed.name]});}
        }
      }catch(error){if(error instanceof WindowEnded)throw error;signal.throwIfAborted();const evidence=write('read-error',{sourceUrl:page.url,message:error instanceof Error?error.message:'只读请求失败'});check({id:'page:'+page.path,kind:'page',status:'unverified',sourcePath:page.path,reason:'无法读取当前路径的实际响应。',evidence:[evidence.name]});}
    }
    const relationItems=manifest.items.filter(item=>item.required&&item.kind==='data'&&item.dataIdentity?.kind==='relations');
    const frozenScope=(ids:string[])=>{
      const selected=new Map<string,{page:SourcePage;requirements:string[]}>(),errors:string[]=[];
      if(!ids.length||unique(ids).length!==ids.length)errors.push('关系引用要求为空或重复');
      for(const id of ids){
        const requirement=manifest.items.find(item=>item.id===id);
        if(!requirement?.required||!(requirement.kind==='page'||requirement.kind==='data'&&(requirement.dataIdentity===undefined||requirement.dataIdentity.kind==='page'))){errors.push('关系引用不是必迁页面身份全集：'+id);continue;}
        const keys=requirement.kind==='page'?requirement.paths:requirement.expectedKeys||[];
        if(!keys.length||unique(keys).length!==keys.length||requirement.expectedCount!==null&&requirement.expectedCount!==keys.length||requirement.kind==='data'&&requirement.expectedCount===null){errors.push('关系引用缺少明确数量和身份全集：'+id);continue;}
        const seen=new Set<string>();
        for(const key of keys){const matches=pages.filter(page=>page.aliases.includes(key));if(matches.length!==1||seen.has(matches[0].url)){errors.push('关系引用不能唯一回指冻结页面：'+id+'/'+key);continue;}const page=matches[0],old=selected.get(page.url);seen.add(page.url);selected.set(page.url,{page,requirements:unique([...(old?.requirements||[]),id])});}
      }
      return {selected,errors};
    };
    const explicitRelationParents=new Set<string>();
    for(const item of relationItems){
      if(item.dataIdentity?.kind!=='relations')continue;
      const parents=frozenScope(item.dataIdentity.parentRequirementIds),children=frozenScope(item.dataIdentity.childRequirementIds);
      if(!parents.errors.length&&!children.errors.length)for(const sourceUrl of parents.selected.keys())explicitRelationParents.add(sourceUrl);
    }
    // Explicit frozen parent/child contracts own membership and order. The legacy
    // pageType heuristic cannot create a competing universe from every content href.
    const listings=pages.filter(page=>page.pageType==='list'&&!explicitRelationParents.has(page.url));
    for(const page of listings){
      const members=unique(page.links.filter(link=>link.where==='content').map(link=>{try{return url(link.url,page.url).href;}catch{return '';}}).filter(link=>pages.some(p=>p.url===link&&p.url!==page.url))),target=targetPages.get(page.url);
      if(!members.length){check({id:'listing:'+page.path,kind:'listing',status:'unverified',failureClass:'source-limitation',sourcePath:page.path,reason:'来源声明为列表但没有可核验成员身份，不能凭链接数量证明分页。',evidence:[evidenceByPage.get(page.url)||''].filter(Boolean)});continue;}
      const allSourceUrls=new Set(pages.filter(p=>p.pageType!=='list').map(p=>mapLink(p.url,run.sourceUrl)));
      const actual=target?unique(target.links.filter(link=>link.where==='content'&&allSourceUrls.has(link.url)).map(link=>link.url)):[],expected=members.filter(member=>pages.find(p=>p.url===member)?.pageType!=='list').map(member=>mapLink(member,run.sourceUrl));
      check({id:'listing:'+page.path,kind:'listing',status:!expected.length?'unverified':target&&JSON.stringify(actual)===JSON.stringify(expected)?'verified':target?'missing':'unverified',sourcePath:page.path,expectedKeys:expected,actualKeys:actual,reason:expected.length?'按冻结逐页列表核对成员身份和顺序；页码及查询参数分别保留。':'列表仅发现分页或其他列表链接，实体全集尚未取得。',evidence:[evidenceByPage.get(page.url)||''].filter(Boolean)});
    }
    const assetItems=manifest.items.filter(item=>item.required&&item.kind==='data'&&item.dataIdentity?.kind==='assets');
    const dynamic=manifest.items.filter(item=>item.required&&(item.kind==='data'&&(item.dataIdentity===undefined||item.dataIdentity.kind==='page')||item.kind==='template'&&!!item.expectedKeys?.length));
    const recordRequirements=manifest.items.filter(item=>item.required&&(item.kind==='page'||item.kind==='template'||item.kind==='data'&&(item.dataIdentity===undefined||item.dataIdentity.kind==='page')));
    if(dynamic.length||relationItems.length||assetItems.length){
      const rows:TargetRow[]=[];let inventoryComplete=true;
      const paged=async(kind:'content'|'rows',container:string)=>{
        const result:TargetRow[]=[];let expectedPages:number|undefined,expectedCount:number|undefined;const fingerprints=new Set<string>();
        for(let page=1;;page++){
          const observation=await inspect(kind==='content'?{kind,id:container,page}:{kind,table:container,page}),value=field(observation.value,'value'),list=field(value,'list'),totalPages=field(value,'totalPages'),totalCount=field(value,'totalCount'),pageNr=field(value,'pageNr');
          if(!Array.isArray(list)||!Number.isSafeInteger(totalPages)||totalPages<0||!Number.isSafeInteger(totalCount)||totalCount<0||pageNr!==page)throw new InventoryContractError('实现分页缺少完整页码、总页数、总量或记录列表');
          if(expectedPages!==undefined&&(expectedPages!==totalPages||expectedCount!==totalCount))throw new InventoryContractError('读取期间实现分页总量变化');expectedPages=totalPages;expectedCount=totalCount;
          if(totalPages===0&&totalCount!==0||totalPages>0&&page>totalPages||page<totalPages&&!list.length)throw new InventoryContractError('实现分页元数据与记录不一致');
          const fingerprint=collectionHash(JSON.stringify(list));if(list.length&&fingerprints.has(fingerprint))throw new InventoryContractError('实现接口重复返回相同分页');fingerprints.add(fingerprint);
          for(const raw of list){const row=rowObject(raw);if(!row)throw new InventoryContractError('实现记录形状不可识别');let id=field(row,'id');const primary=field(value,'primaryKey');if(kind==='rows'&&typeof primary==='string')id=field(row,primary);if(typeof id!=='string'&&typeof id!=='number')throw new InventoryContractError('实现记录缺少可核验主键');let full:unknown=row,evidence=[observation.evidence];
            if(kind==='content'){if(!/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(String(id)))throw new InventoryContractError('Content 记录身份不合法');const detail=await inspect({kind:'contentItem',id:String(id),page:1});full=field(detail.value,'value');evidence.push(detail.evidence);if(!object(full))throw new InventoryContractError('Content 全字段回读失败');}
            result.push({kind:kind==='content'?'content':'sqlite',container,id:String(id),value:full,evidence});}
          if(page>=totalPages)break;
        }
        if(result.length!==expectedCount||new Set(result.map(row=>row.id)).size!==result.length)throw new InventoryContractError('实现分页缺失或主键重复');return result;
      };
      let tableNames:string[]=[],folderIds:string[]=[],declarationsComplete=true;
      const inventoryFailures:{kind:'sqlite'|'content';evidence:string;contract:boolean}[]=[];
      const inventoryFailure=(kind:'sqlite'|'content',error:unknown,container?:string)=>{
        if(error instanceof WindowEnded)throw error;signal.throwIfAborted();inventoryComplete=false;
        const contract=error instanceof InventoryContractError,file=write('implementation-error',{kind,...(container?{container}:{}),failureClass:contract?'contract-tool-defect':'transient-incomplete',message:error instanceof Error?error.message:'实现读取失败'});
        inventoryFailures.push({kind,evidence:file.name,contract});
        if(container)check({id:'inventory:'+kind+':'+container,kind:'data',status:'unverified',failureClass:contract?'contract-tool-defect':'transient-incomplete',reason:`${kind==='sqlite'?'Sqlite 表':'Content 文件夹'} ${container} 不能完成真实身份与完整分页核验：${error instanceof Error?error.message:'只读请求失败'}；继续读取其余容器，不以临时行号替代身份。`,evidence:[file.name,...(error instanceof CachedReadFailure?[error.evidence]:[])]});
      };
      const declarationTable=(name:string)=>['collectionrecordbindings','collectionrelationbindings','collectionassetbindings'].includes(name.toLowerCase());
      try{
        const tables=await inspect({kind:'tables',page:1}),value=field(tables.value,'value');if(!Array.isArray(value)||value.some(table=>typeof table!=='string')||new Set(value).size!==value.length)throw new InventoryContractError('Sqlite 表列表形状未知');tableNames=value;
      }catch(error){declarationsComplete=false;inventoryFailure('sqlite',error);}
      for(const table of tableNames.filter(declarationTable))try{rows.push(...await paged('rows',table));}catch(error){declarationsComplete=false;inventoryFailure('sqlite',error,table);}
      const recordDeclarations=rows.filter(row=>row.kind==='sqlite'&&row.container.toLowerCase()==='collectionrecordbindings');
      const pointerKey=(row:TargetRow)=>JSON.stringify([row.kind,row.container,row.id]);
      const declarationPointer=(row:TargetRow)=>JSON.stringify([field(row.value,'targetKind'),field(row.value,'targetContainer'),String(field(row.value,'targetId')),field(row.value,'identityKeyField')??'id']);
      const declarationUrl=(row:TargetRow)=>{const value=field(row.value,'sourceUrl');try{if(typeof value!=='string'||!/^https?:\/\//i.test(value))return '';const parsed=url(value,sourceOrigin);return parsed.origin===sourceOrigin&&pages.some(page=>page.url===parsed.href)?parsed.href:'';}catch{return '';}};
      const validDeclaration=(row:TargetRow)=>recordRequirements.some(item=>item.id===field(row.value,'requirementId'))&&!!declarationUrl(row)&&['sqlite','content'].includes(field(row.value,'targetKind'))&&typeof field(row.value,'targetContainer')==='string'&&!!field(row.value,'targetContainer').trim()&&['string','number'].includes(typeof field(row.value,'targetId'))&&String(field(row.value,'targetId')).trim()!==''&&(field(row.value,'identityKeyField')===undefined||typeof field(row.value,'identityKeyField')==='string'&&!!field(row.value,'identityKeyField').trim())&&!(field(row.value,'targetKind')==='sqlite'&&declarationTable(field(row.value,'targetContainer')));
      const declaredFor=(sourceUrl:string,requirementId?:string)=>recordDeclarations.filter(row=>declarationUrl(row)===sourceUrl&&(requirementId===undefined||field(row.value,'requirementId')===requirementId));
      const onePointer=(declarations:TargetRow[])=>declarations.length>0&&declarations.every(validDeclaration)&&unique(declarations.map(declarationPointer)).length===1;
      // Narrow only when the complete explicit index covers every frozen page, including
      // listing parents, children and pagination URLs. Unknown data domains remain unresolved.
      const relationDeclarations=rows.filter(row=>row.kind==='sqlite'&&row.container.toLowerCase()==='collectionrelationbindings');
      const relationTables=[...(options.relationBindings||[]).map(binding=>binding.table),...relationDeclarations.map(row=>field(row.value,'tableName'))];
      const declaredTables=recordDeclarations.filter(row=>field(row.value,'targetKind')==='sqlite').map(row=>field(row.value,'targetContainer'));
      let narrow=declarationsComplete&&recordDeclarations.length>0&&recordDeclarations.every(validDeclaration)&&pages.every(page=>onePointer(declaredFor(page.url)))&&dynamic.every(item=>(item.expectedKeys||[]).every(key=>{const matches=pages.filter(page=>page.aliases.includes(key));return matches.length!==1||onePointer(declaredFor(matches[0].url,item.id));}))&&[...declaredTables,...relationTables].every(table=>typeof table==='string'&&tableNames.filter(name=>name.toLowerCase()===table.toLowerCase()).length===1);
      if(recordDeclarations.some(row=>!validDeclaration(row))){const file=write('record-binding-error',{declarations:recordDeclarations.map(row=>({id:row.id,valid:validDeclaration(row),value:row.value}))});check({id:'record-bindings',kind:'data',status:'unverified',failureClass:'contract-tool-defect',reason:'规范记录声明含未知要求、非冻结来源或无效记录指针，不能用于身份放行。',evidence:[file.name]});}
      if(dynamic.length||relationItems.length)try{
        const folders=await inspect({kind:'folders',page:1}),value=field(folders.value,'value');if(!Array.isArray(value))throw new InventoryContractError('Content 文件夹列表形状未知');
        const allFolders:any[]=[];const visit=(items:any[])=>{for(const item of items){if(!object(item)||typeof field(item,'id')!=='string')throw new InventoryContractError('Content 文件夹缺少身份');allFolders.push(item);const children=field(item,'children');if(children!==undefined){if(!Array.isArray(children))throw new InventoryContractError('Content 文件夹层次不完整');visit(children);}}};visit(value);
        folderIds=allFolders.map(folder=>field(folder,'id'));
        const declaredFolders=recordDeclarations.filter(row=>field(row.value,'targetKind')==='content').map(row=>field(row.value,'targetContainer'));if(declaredFolders.some(id=>folderIds.filter(found=>found===id).length!==1))narrow=false;
        for(const folder of allFolders.filter(folder=>!narrow||declaredFolders.includes(field(folder,'id')))){const id=field(folder,'id');try{rows.push(...await paged('content',id));}catch(error){inventoryFailure('content',error,id);}}
      }catch(error){inventoryFailure('content',error);}
      if(dynamic.length||relationItems.length){
        const needed=new Set([...declaredTables,...relationTables].map(table=>typeof table==='string'?table.toLowerCase():''));
        for(const table of tableNames.filter(table=>!declarationTable(table)&&(!narrow||needed.has(table.toLowerCase()))))try{rows.push(...await paged('rows',table));}catch(error){inventoryFailure('sqlite',error,table);}
      }
      for(const kind of ['sqlite','content'] as const){const failures=inventoryFailures.filter(failure=>failure.kind===kind);if(failures.length)check({id:'inventory:'+kind,kind:'data',status:'unverified',failureClass:failures.some(failure=>failure.contract)?'contract-tool-defect':'transient-incomplete',reason:`${kind==='sqlite'?'Sqlite':'Content'} 容器索引或完整分页未全部取得；已继续读取其余容器。缺少完整可靠声明时，全局不完整仍阻止数据与关系放行。`,evidence:failures.map(failure=>failure.evidence)});}
      const mappings=new Map<string,TargetRow[]>();
      for(const row of rows){
        if(row.kind==='sqlite'&&declarationTable(row.container))continue;
        const urls=declaredSourceUrls(row.value,sourceOrigin);if(urls.length!==1||!pages.some(page=>page.url===urls[0]))continue;
        // An independent mapping is evidence only when it points to one actual inventory record.
        const targetId=field(row.value,'targetId'),targetKind=field(row.value,'targetKind'),targetContainer=field(row.value,'targetContainer');
        const pointed=targetId!==undefined||targetKind!==undefined||targetContainer!==undefined;
        const targets=pointed?rows.filter(candidate=>candidate!==row&&candidate.id===String(targetId)&&candidate.kind===targetKind&&candidate.container===targetContainer):[row];
        if(targets.length===1)mappings.set(urls[0],[...(mappings.get(urls[0])||[]),{...targets[0],evidence:unique([...targets[0].evidence,...row.evidence])}]);
      }
      const deduplicate=(candidates:TargetRow[])=>{const byIdentity=new Map<string,TargetRow>();for(const row of candidates){const key=pointerKey(row),old=byIdentity.get(key);byIdentity.set(key,{...row,evidence:unique([...(old?.evidence||[]),...row.evidence])});}return [...byIdentity.values()];};
      for(const [sourceUrl,candidates] of mappings)mappings.set(sourceUrl,deduplicate(candidates));
      const canonical=(sourceUrl:string,requirementId?:string):TargetRow[]|undefined=>{
        const declarations=declaredFor(sourceUrl,requirementId);if(!declarations.length)return;
        if(!onePointer(declarations))return [];
        const declaration=declarations[0],targets=rows.filter(row=>!(row.kind==='sqlite'&&declarationTable(row.container))&&row.kind===field(declaration.value,'targetKind')&&row.container===field(declaration.value,'targetContainer')&&row.id===String(field(declaration.value,'targetId')));
        if(targets.length!==1||JSON.stringify(declaredSourceUrls(targets[0].value,sourceOrigin,true))!==JSON.stringify([sourceUrl]))return [];
        const identityKeyField=field(declaration.value,'identityKeyField')??'id',identity=recordIdentity(targets[0],identityKeyField);
        if(identity===undefined||rows.filter(row=>row.kind===targets[0].kind&&row.container===targets[0].container&&recordIdentity(row,identityKeyField)===identity).length!==1)return [];
        return [{...targets[0],identityKeyField,evidence:unique([...targets[0].evidence,...declarations.flatMap(row=>row.evidence)])}];
      };
      const legacyMappings=new Map(mappings);
      const mappingFor=(sourceUrl:string,requirementId:string)=>canonical(sourceUrl,requirementId)??(narrow?[]:legacyMappings.get(sourceUrl)||[]);
      // Relations have no requirement-specific canonical selector: conflicting canonical
      // declarations for one source page stay unresolved instead of selecting arbitrarily.
      for(const page of pages){const selected=canonical(page.url);if(selected!==undefined)mappings.set(page.url,selected);else if(narrow)mappings.delete(page.url);}
      const requiredUrls=new Set<string>();
      for(const item of dynamic){
        const expected=item.expectedKeys||[],selected:SourcePage[]=[],unresolved:string[]=[];if(!expected.length||item.expectedCount!==null&&item.expectedCount!==expected.length)unresolved.push('预期记录全集或数量未明确');
        for(const key of expected){const matches=pages.filter(page=>page.aliases.includes(key));if(matches.length!==1)unresolved.push(key);else{selected.push(matches[0]);requiredUrls.add(matches[0].url);}}
        const missingMappings=selected.filter(page=>mappingFor(page.url,item.id).length!==1),verified=inventoryComplete&&!unresolved.length&&!missingMappings.length;
        check({id:'data:'+item.id,kind:'data',requirementId:item.id,status:verified?'verified':'unverified',failureClass:inventoryComplete?'contract-tool-defect':'transient-incomplete',expectedKeys:expected,actualKeys:expected.filter(key=>{const page=selected.find(page=>page.aliases.includes(key));return !!page&&mappingFor(page.url,item.id).length===1;}),reason:verified?'冻结来源身份与完整后台分页的唯一记录对应；显式规范声明须同时回指真实记录及其 sourceUrl/oldUrl，数量相等未作为替代证明。':'缺少来源全集、唯一后台身份映射或完整分页，不能猜测 Content 字段或按数量通过。'+(unresolved.length?' 无法唯一定位：'+unresolved.join('、'):''),evidence:unique(selected.flatMap(page=>mappingFor(page.url,item.id).flatMap(row=>row.evidence)))});
      }
      const resolveRelation=(sourcePath:string)=>{
        const explicit=options.relationBindings?.filter(item=>item.sourcePath===sourcePath)||[],declarations=relationDeclarations.filter(row=>field(row.value,'sourcePath')===sourcePath);
        const candidates:CollectionRelationBinding[]=explicit.length?explicit:declarations.map(row=>({sourcePath,table:field(row.value,'tableName'),parentField:field(row.value,'parentField'),childField:field(row.value,'childField'),orderField:field(row.value,'orderField')||undefined,parentIdentityField:field(row.value,'parentIdentityField'),childIdentityField:field(row.value,'childIdentityField'),sourcePathField:field(row.value,'sourcePathField')}));
        const evidence=unique(declarations.flatMap(row=>row.evidence));
        if(!candidates.length)return {binding:undefined,evidence,error:''};
        if(candidates.length!==1)return {binding:undefined,evidence,error:'同一冻结列表存在多条关系声明，无法唯一选择。'};
        const candidate=candidates[0];
        if(!pages.some(page=>page.path===candidate.sourcePath)||[candidate.table,candidate.parentField,candidate.childField,...[candidate.orderField,candidate.parentIdentityField,candidate.childIdentityField,candidate.sourcePathField].filter(value=>value!==undefined)].some(value=>typeof value!=='string'||!value.trim()))return {binding:undefined,evidence,error:'关系声明缺少有效的冻结来源路径、表或字段。'};
        const actualTables=unique(tableNames.filter(table=>table.toLowerCase()===candidate.table.toLowerCase()));
        if(actualTables.length!==1)return {binding:undefined,evidence,error:'关系声明未指向唯一的已完整枚举实际数据表。'};
        const actualRows=rows.filter(row=>row.kind==='sqlite'&&row.container===actualTables[0]);
        if(!actualRows.length||actualRows.some(row=>[candidate.parentField,candidate.childField,...[candidate.orderField,candidate.sourcePathField].filter((value):value is string=>value!==undefined)].some(key=>field(row.value,key)===undefined)))return {binding:undefined,evidence,error:'关系表的实际记录未包含声明字段；缺少可证明的 schema 时保持未验证。'};
        return {binding:{...candidate,table:actualTables[0]},evidence,error:''};
      };
      const mappedScopeRecord=(sourceUrl:string,requirements:string[])=>{
        const candidates:TargetRow[]=[];
        for(const requirementId of requirements){const matches=mappingFor(sourceUrl,requirementId);if(matches.length!==1||JSON.stringify(declaredSourceUrls(matches[0].value,sourceOrigin,true))!==JSON.stringify([sourceUrl]))return [];candidates.push(matches[0]);}
        return unique(candidates.map(row=>JSON.stringify([pointerKey(row),row.identityKeyField||'id']))).length===1?deduplicate(candidates):[];
      };
      const frozenPaths=new Set(pages.map(page=>page.path));
      for(const item of relationItems){
        if(item.dataIdentity?.kind!=='relations')continue;
        const parents=frozenScope(item.dataIdentity.parentRequirementIds),children=frozenScope(item.dataIdentity.childRequirementIds),scopeErrors=[...parents.errors,...children.errors];
        const edges=new Map<string,SourcePage[]>(),sourceKeys:string[]=[];
        for(const {page} of parents.selected.values()){
          const original=html(read(page.rawFile).toString(),page.url),members=unique(original.links.filter(link=>link.where==='content').flatMap(link=>{try{return [url(link.url,page.url).href];}catch{return [];}}).filter(link=>children.selected.has(link)));
          edges.set(page.url,members.map(member=>children.selected.get(member)!.page));sourceKeys.push(...members.map(child=>JSON.stringify([page.url,child])));
        }
        const expected=item.expectedKeys||[],sourceSet=new Set(sourceKeys),sourceExact=item.expectedCount!==null&&item.expectedCount===sourceKeys.length&&expected.length===sourceKeys.length&&new Set(expected).size===expected.length&&expected.every(key=>sourceSet.has(key));
        const sourceEvidence=unique([...parents.selected.values(),...children.selected.values()].flatMap(entry=>entry.page.sourceEvidence));
        if(scopeErrors.length||!sourceExact){
          const difference=write('relation-source-difference',{requirementId:item.id,scopeErrors,manifestExpectedCount:item.expectedCount,manifestKeys:expected,frozenKeys:sourceKeys,sourceEvidence});
          check({id:'data:'+item.id,kind:'relations',requirementId:item.id,status:'unverified',expectedKeys:expected,actualKeys:[],reason:'显式关系清单必须与所引用冻结父/子全集及原件正文链接逐边一致；当前引用、数量或键集不闭合，不能改用页面ID或总数替代。',evidence:[difference.name]});continue;
        }
        let failed=false,unresolved=false;const actualKeys:string[]=[],evidence:string[]=[];
        for(const {page,requirements} of parents.selected.values()){
          const members=edges.get(page.url)||[],parent=mappedScopeRecord(page.url,requirements),mappedChildren=members.map(member=>mappedScopeRecord(member.url,children.selected.get(member.url)!.requirements)),declaration=resolveRelation(page.path),binding=declaration.binding;
          let status:'verified'|'missing'|'unverified'='unverified',reason=declaration.error||'未取得唯一真实父子记录、声明的关系字段或完整后台分页。',pageEvidence=[...declaration.evidence,...parent.flatMap(row=>row.evidence),...mappedChildren.flatMap(matches=>matches.flatMap(row=>row.evidence)),...[evidenceByPage.get(page.url)].filter((value):value is string=>!!value)];
          if(!members.length){
            const target=targetPages.get(page.url),targetChildren=new Set([...children.selected.keys()].map(child=>mapLink(child,page.url))),actualOutput=target?unique(target.links.filter(link=>link.where==='content'&&targetChildren.has(link.url)).map(link=>link.url)):[];
            let storageProven=false,extraRows:TargetRow[]=[],storageReason=declaration.error||'该零边页没有显式逐页关系范围声明；不能从其他页声明推定后台零边。';
            if(inventoryComplete&&binding){
              const all=rows.filter(row=>row.kind==='sqlite'&&row.container===binding.table);
              if(binding.sourcePathField){
                storageProven=true;extraRows=all.filter(row=>field(row.value,binding.sourcePathField!)===page.path);
                storageReason='已完整枚举显式逐页 sourcePath 范围；零边页不要求创建父记录或关系行。';
              }else if(parent.length===1){
                const identityField=binding.parentIdentityField||parent[0].identityKeyField||'id',parentKey=recordIdentity(parent[0],identityField),uniqueParent=parentKey!==undefined&&rows.filter(row=>row.kind===parent[0].kind&&row.container===parent[0].container&&recordIdentity(row,identityField)===parentKey).length===1;
                if(uniqueParent){storageProven=true;extraRows=all.filter(row=>recordIdentity(row,binding.parentField)===parentKey);storageReason='已完整枚举该页声明的唯一父身份范围。';}else storageReason='零边页声明没有 sourcePath 范围，父身份字段也不能唯一证明后台零边。';
              }else storageReason='零边页声明没有 sourcePath 范围，也没有唯一实际父身份；后台零边尚不能证明。';
              pageEvidence=unique([...pageEvidence,...all.flatMap(row=>row.evidence)]);
            }else if(!inventoryComplete)storageReason='后台分页未完整取得，无法证明零边页没有额外关系。';
            status=actualOutput.length||extraRows.length?'missing':target&&storageProven?'verified':'unverified';
            reason=actualOutput.length?'冻结原件确认零边，但目标正文出现额外子记录链接。':extraRows.length?'冻结原件确认零边，但显式逐页范围内存在额外后台关系。':!target?'冻结原件确认零边，但目标实际输出未取得；'+storageReason:storageProven?'冻结原件、目标正文及显式逐页后台范围均确认零边。':'冻结原件与目标正文已确认零边；'+storageReason;
            const difference=write('relation-zero-difference',{requirementId:item.id,sourcePath:page.path,sourceEvidence:page.sourceEvidence,expectedKeys:[],actualOutput,binding,storageProven,storageReason,extraRows:extraRows.map(row=>({id:row.id,value:row.value}))});pageEvidence.push(difference.name);
            if(status==='missing')failed=true;if(status==='unverified')unresolved=true;evidence.push(...pageEvidence);
            check({id:'relations:'+item.id+':'+page.path,kind:'relations',requirementId:item.id,sourcePath:page.path,status,expectedKeys:[],actualKeys:actualOutput.map(child=>{const source=[...children.selected.keys()].find(source=>mapLink(source,page.url)===child);return JSON.stringify([page.url,source]);}),reason,evidence:unique(pageEvidence)});continue;
          }
          if(inventoryComplete&&binding&&parent.length===1&&mappedChildren.every(matches=>matches.length===1)){
            const category=parent[0],records=mappedChildren.map(matches=>matches[0]),parentKey=recordIdentity(category,binding.parentIdentityField||category.identityKeyField||'id'),childFields=records.map(record=>binding.childIdentityField||record.identityKeyField||'id'),childKeys=records.map((record,index)=>recordIdentity(record,childFields[index]));
            const parentUnique=!!binding.sourcePathField||parentKey!==undefined&&rows.filter(row=>row.kind===category.kind&&row.container===category.container&&recordIdentity(row,binding.parentIdentityField||category.identityKeyField||'id')===parentKey).length===1;
            const childUnique=childKeys.every((key,index)=>key!==undefined&&rows.filter(row=>row.kind===records[index].kind&&row.container===records[index].container&&recordIdentity(row,childFields[index])===key).length===1)&&new Set(childKeys).size===childKeys.length;
            if(parentKey!==undefined&&parentUnique&&childUnique&&(binding.orderField||members.length<=1)){
              const all=rows.filter(row=>row.kind==='sqlite'&&row.container===binding.table),scoped=binding.sourcePathField?all.filter(row=>field(row.value,binding.sourcePathField!)===page.path):all.filter(row=>recordIdentity(row,binding.parentField)===parentKey);
              const actual=scoped.map(row=>({id:recordIdentity(row,binding.childField),parent:recordIdentity(row,binding.parentField),order:binding.orderField?recordIdentity(row,binding.orderField):undefined}));
              const validOrder=!binding.orderField||actual.every(row=>row.order!==undefined&&Number.isFinite(Number(row.order)))&&new Set(actual.map(row=>Number(row.order))).size===actual.length;
              if(binding.orderField&&validOrder)actual.sort((a,b)=>Number(a.order)-Number(b.order));
              const foreignScope=!!binding.sourcePathField&&all.some(row=>typeof field(row.value,binding.sourcePathField!)!=='string'||!frozenPaths.has(field(row.value,binding.sourcePathField!)));
              const target=targetPages.get(page.url),targetChildren=new Set([...children.selected.keys()].map(child=>mapLink(child,page.url))),expectedOutput=members.map(member=>mapLink(member.url,page.url)),actualOutput=target?unique(target.links.filter(link=>link.where==='content'&&targetChildren.has(link.url)).map(link=>link.url)):[];
              const matches=!!target&&!foreignScope&&actual.every(row=>row.parent===parentKey&&row.id!==undefined)&&new Set(actual.map(row=>row.id)).size===actual.length&&validOrder&&JSON.stringify(actual.map(row=>row.id))===JSON.stringify(childKeys)&&JSON.stringify(actualOutput)===JSON.stringify(expectedOutput);
              status=!target?'unverified':matches?'verified':'missing';reason=matches?'冻结原件的父页成员身份、目标输出、完整关系记录及声明顺序逐项一致。':!target?'目标父页实际输出未取得，后台关系不能代替页面交付。':'目标输出或完整关系表与冻结原件存在缺行、多余、重复、父子身份、分页范围或顺序差异。';
              const difference=write('relation-difference',{requirementId:item.id,sourcePath:page.path,sourceEvidence:page.sourceEvidence,binding,parentKey,expectedChildren:members.map((member,index)=>({sourceUrl:member.url,identity:childKeys[index]})),actual,expectedOutput,actualOutput,foreignScope,validOrder});pageEvidence=unique([...pageEvidence,...all.flatMap(row=>row.evidence),difference.name]);
              for(const row of actual){const index=childKeys.indexOf(row.id);if(index>=0)actualKeys.push(JSON.stringify([page.url,members[index].url]));}
            }else reason='父/子声明身份字段缺失或不唯一，或多成员关系缺少可证明顺序字段；不能猜测sourceId或分页所属。';
          }
          if(status==='missing')failed=true;if(status==='unverified')unresolved=true;evidence.push(...pageEvidence);
          check({id:'relations:'+item.id+':'+page.path,kind:'relations',requirementId:item.id,sourcePath:page.path,status,expectedKeys:members.map(member=>JSON.stringify([page.url,member.url])),reason,evidence:unique(pageEvidence)});
        }
        check({id:'data:'+item.id,kind:'relations',requirementId:item.id,status:failed?'missing':unresolved?'unverified':'verified',expectedKeys:expected,actualKeys,reason:failed?'完整冻结关系全集与目标实际关系存在已证实差异。':unresolved?'关系全集来源已闭合，但仍缺少唯一映射、字段、页范围或完整目标证据。':'全部冻结父页（含普通页面与分页）的关系身份和顺序逐边核验通过；总数未替代记录证据。',evidence:unique(evidence)});
      }
      for(const page of listings){
        if(explicitRelationParents.has(page.url))continue;
        const children=unique(page.links.filter(link=>link.where==='content').map(link=>{try{return url(link.url,page.url).href;}catch{return '';}}).filter(link=>requiredUrls.has(link)));if(!children.length)continue;
        const parent=mappings.get(page.url),declaration=resolveRelation(page.path),binding=declaration.binding;let verified=false,knownFailure=false,evidence:string[]=[...declaration.evidence];
        if(parent?.length===1&&children.every(child=>mappings.get(child)?.length===1)){
          const category=parent[0],members=children.map(child=>mappings.get(child)![0]);
          if(members.every(member=>member.kind==='content')&&category.kind==='content'){
            verified=members.every(member=>{const categories=field(member.value,'categories');if(!Array.isArray(categories))return false;return categories.some(group=>field(field(group,'categoryFolder'),'id')===category.container&&Array.isArray(field(group,'contents'))&&field(group,'contents').some((record:unknown)=>String(field(record,'id'))===category.id));});evidence=unique([...evidence,...members.flatMap(member=>member.evidence)]);
          }
          if(binding){const relations=rows.filter(row=>row.kind==='sqlite'&&row.container===binding.table),linked=relations.filter(row=>String(field(row.value,binding.parentField))===category.id),actual=linked.map(row=>{const order=binding.orderField?field(row.value,binding.orderField):undefined;return {id:String(field(row.value,binding.childField)),order:typeof order==='number'||typeof order==='string'&&order.trim()?Number(order):null};});
            const expected=members.map(member=>member.id);if(binding.orderField&&actual.every(row=>Number.isFinite(row.order)))actual.sort((a,b)=>a.order!-b.order!);
            verified=inventoryComplete&&(!binding.orderField||actual.every(row=>Number.isFinite(row.order))&&new Set(actual.map(row=>row.order)).size===actual.length)&&JSON.stringify(binding.orderField?actual.map(row=>row.id):actual.map(row=>row.id).sort())===JSON.stringify(binding.orderField?expected:[...expected].sort());knownFailure=inventoryComplete&&!verified;evidence=unique([...evidence,...relations.flatMap(row=>row.evidence)]);
          }
        }
        check({id:'relations:'+page.path,kind:'relations',sourcePath:page.path,status:verified?'verified':knownFailure?'missing':'unverified',reason:verified?'来源列表成员在目标实际输出和可读后台关系中均有对应证据。':'来源列表包含必迁动态记录，但后台分类/关系映射未取得或不一致；页面链接不代替存储关系。'+declaration.error,evidence});
      }
      const assetDeclarations=rows.filter(row=>row.kind==='sqlite'&&row.container.toLowerCase()==='collectionassetbindings');
      const frozenAssetUrls=new Set<string>();for(const collection of ['assets','files','stylesheets'])for(const row of Array.isArray(frozenState[collection])?frozenState[collection]:[])try{if(typeof row?.url==='string')frozenAssetUrls.add(url(row.url,run.sourceUrl).href);}catch{}
      if(assetItems.length&&assetDeclarations.some(row=>{try{return typeof field(row.value,'sourceUrl')!=='string'||!frozenAssetUrls.has(url(field(row.value,'sourceUrl'),run.sourceUrl).href);}catch{return true;}}))check({id:'asset-bindings',kind:'data',status:'unverified',reason:'素材声明含无效或越出冻结来源索引的身份，不能静默忽略。',evidence:unique(assetDeclarations.flatMap(row=>row.evidence))});
      const assetBinding=(row:TargetRow):CollectionAssetBinding=>({sourceUrl:field(row.value,'sourceUrl'),materialPath:field(row.value,'materialPath'),targetUrl:field(row.value,'targetUrl')});
      const assetEvidence=unique(assetDeclarations.flatMap(row=>row.evidence));
      const compareAssets=async(id:string,source:ReturnType<typeof parseFrozenAssetSource>,requirementId?:string)=>{
        const expected=new Set(source.expectedKeys),bindings=assetDeclarations.filter(row=>{try{return expected.has(url(field(row.value,'sourceUrl'),run.sourceUrl).href);}catch{return false;}}).map(assetBinding),plan=compareAssetTargets(source,bindings,[],targetOrigin),observations:AssetTargetObservation[]=[],evidence=[...assetEvidence];
        let transientRead=false;
        for(const targetUrl of plan.requests){
          try{const observed=await cached('asset:'+targetUrl,()=> (options.dependencies?.readAsset||readTargetAsset)(targetUrl,{targetBaseUrl:targetOrigin,allowedTargetUrls:plan.requests,signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])}),value=>value.status>=200&&value.status<300||[404,410].includes(value.status)),value=observed.value as AssetTargetObservation;observations.push(value);evidence.push(observed.evidence);if(!(value.status>=200&&value.status<300||[404,410].includes(value.status)))transientRead=true;}
          catch(error){if(error instanceof WindowEnded)throw error;signal.throwIfAborted();if(error instanceof CachedReadFailure)transientRead=true;const file=write('asset-read-error',{targetUrl,message:error instanceof Error?error.message:'目标素材原字节读取失败'});evidence.push(file.name);}
        }
        const result=compareAssetTargets(source,bindings,observations,targetOrigin),difference=write('asset-difference',{requirementId,source,bindings,result});evidence.push(difference.name);
        const status=result.state==='incomplete'?'missing':result.state==='complete'&&declarationsComplete?'verified':'unverified';
        check({id,kind:'data',requirementId,status,failureClass:source.issues.length?'source-limitation':!transientRead&&declarationsComplete?'contract-tool-defect':'transient-incomplete',expectedKeys:result.expectedKeys,actualKeys:result.actualKeys,reason:status==='verified'?'全部冻结素材来源URL经显式原件映射，对当前目标实际响应原字节逐项核对SHA256和字节数；文件去重不缩减来源身份。':status==='missing'?'目标素材原字节缺失或与冻结原件不一致；详情见逐URL差异证据。':'缺少冻结原始字节、完整来源keys/count、唯一素材声明或真实目标digest；读取状态及目标声明不能替代原件。',evidence:unique(evidence)});
      };
      for(const item of assetItems)await compareAssets('data:'+item.id,parseFrozenAssetSource({state:frozenState,sourceUrl:run.sourceUrl,expectedKeys:item.expectedKeys,expectedCount:item.expectedCount,readFrozen:read}),item.id);
      // Read CSS is an explicit frozen source obligation. Its original bytes cannot be
      // inferred from status=read or covered by acceptance of different failed assets.
      if(assetItems.length&&Array.isArray(frozenState.stylesheets)){
        const stylesheetKeys=unique<string>(frozenState.stylesheets.filter((row:any)=>row?.status==='read').flatMap((row:any)=>{try{return typeof row.url==='string'?[url(row.url,run.sourceUrl).href]:[];}catch{return [];}}));
        if(stylesheetKeys.length)await compareAssets('assets:stylesheets',parseFrozenAssetSource({state:frozenState,sourceUrl:run.sourceUrl,expectedKeys:stylesheetKeys,expectedCount:stylesheetKeys.length,readFrozen:read,collection:'stylesheets'}));
      }
    }
  }catch(error){if(error instanceof WindowEnded){report.state='pending';report.nextAt=Date.now()+3000;report.limitations.push('本轮只读请求窗口已结束；已核验响应按当前绑定保存，后续继续剩余对象，不缩减必迁全集。');}else{signal.throwIfAborted();const file=write('binding-error',{message:error instanceof Error?error.message:'B段无法核验'});check({id:'binding-error',kind:'binding',status:'unverified',reason:error instanceof Error?error.message:'B段无法核验',evidence:[file.name]});}}
  const current=store.task(task.id);if(!current||current.versionId!==task.versionId||current.requirementsId!==manifest.id||current.generatedSiteId!==task.generatedSiteId||current.collectionId!==task.collectionId||current.siteRevision!==task.siteRevision||current.collectionVersionId!==task.collectionVersionId||store.siteState(task.generatedSiteId||'')?.revision!==task.siteRevision||store.site(task.generatedSiteId||'')?.siteId!==report.siteId)check({id:'binding-changed',kind:'binding',status:'unverified',reason:'取证期间清单、目标修订或输入发生变化，当前结果不能用于放行。',evidence:[]});
  if(report.state!=='pending')report.state=report.checks.some(check=>check.status==='missing')?'incomplete':report.checkedPages!==report.expectedPages||report.checks.some(check=>check.status!=='verified')||!report.checks.length?'unverified':'complete';
  checkpoint.scanComplete=report.state!=='pending';saveCheckpoint();
  const retryable=Object.values(checkpoint.entries).filter(entry=>entry.retryable).length;
  if(retryable)report.limitations.push(`本次绑定保留 ${retryable} 个失败读取检查点，仅用于推进完整扫描，不代表核验通过；完成扫描后保持未验证，宿主可显式设置 retryTransientFailures=true 仅重试这些对象，成功响应继续复用。`);
  report.issues=report.checks.filter(check=>check.status==='missing'&&check.kind!=='binding').map(check=>({severity:'major',title:bounded('B段宿主核验：'+check.id,240),detail:bounded(check.reason,3000),evidence:check.evidence.slice(0,100)}));
  report.summary=summarizeCollectionTargetReport(report);
  report.artifacts=[...new Map(report.artifacts.map(file=>[file.name,file])).values()];
  const reports=new CollectionTargetReports(store),hash=reports.fingerprint(report),unchanged=reports.unchanged(report,hash);
  if(unchanged){store.event(task.id,`B段核验内容未变化，复用报告 ${unchanged.id}；仍保留当前核验状态 ${unchanged.state}`);return unchanged;}
  write('report',{...report,artifacts:[...report.artifacts]});
  reports.save(report,hash);store.event(task.id,`B段宿主核验 ${report.state}：本轮已覆盖 ${report.checkedPages}/${report.expectedPages} 个来源路径；报告 ${report.id}`);return report;
}
