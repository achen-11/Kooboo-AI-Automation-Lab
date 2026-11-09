import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AutomationTask } from '../../../shared/automation.js';
import type { CollectionCheck, CollectionObjective, CollectionRun, CollectionStage, CollectionReviewReceipt } from '../../../shared/collection.js';
import type { AutomationStore } from '../store.js';
import type { Vault } from '../../lib/vault.js';
import { CollectionStore } from './store.js';
import { CollectionBlocked, CollectionPending } from './errors.js';
import { collectionHash, runCollectionBridge, collectionEngineFingerprint, collectionEngineRoot } from './runtime.js';
import { localDecision, LocalDecisionInterrupted } from '../local-decision.js';
import { recordAutonomousAttempt } from '../autonomy.js';
import { selectExperience, adoptedGuidance } from '../experience.js';
import { ManifestStore, manifestInput, evidenceWriter } from '../completeness.js';
import { RequestBudget } from '../request-budget.js';
import { planCollectionPageWindow } from './page-window.js';
import { collectionReviewHistory } from './review-history.js';
import { acceptedAssetGapEvidencePath, acceptedAssetGapGuidance, acceptedAssetGapLimitations, assertAcceptedAssetGapIndex, acceptedCollectionAssetEntry, acceptedCollectionAssetFinding, failedCollectionAssetEntries } from './accepted-gaps.js';
import { captureSourceVisualBaseline, sourceVisualGuidance, sourceVisualIndexPath, sourceVisualRequired } from './source-visual.js';
import { sourceRenderedEvidencePath, sourceRenderedGuidance, assertSourceRenderedEvidenceIndex, sourceRenderedContentFinding, assertSourceRenderedManifest, captureSourceRenderedEvidence } from './source-rendered.js';

const stages:CollectionStage[]=['plan','discover','fetch','extract','assets','data','render','verify'];
const citation=z.object({path:z.string().min(1).max(1000),sha256:z.string().regex(/^[a-f0-9]{64}$/),quote:z.string().min(8).max(2000)}).strict();
const objective=z.object({description:z.string().min(10).max(4000),affectedObjects:z.array(z.string().min(1).max(8000)).min(1).max(10000),evidence:z.array(z.string()).min(1).max(100),acceptance:z.string().min(10).max(4000)}).strict();
const reviewSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('ready'),checks:z.array(z.object({id:z.enum(['A1','A2','A3','A4','A5','A6']),reason:z.string().min(20).max(6000),evidence:z.array(citation).min(1).max(50)}).strict()).length(6),discoveryBasis:z.string().min(40).max(8000),limitations:z.array(z.string().min(1)).max(100),manifest:z.object({limitations:manifestInput.shape.limitations,items:manifestInput.shape.items}).strict()}).strict(),
 z.object({action:z.literal('continue'),objective,operation:z.enum(['plan','discover','fetch','extract','assets','data','render','verify']),options:z.object({maxPages:z.number().int().min(300).max(10000).optional(),maxDepth:z.number().int().min(6).max(30).optional(),maxAssets:z.number().int().min(5000).max(50000).optional(),maxTotalBytes:z.number().int().min(2*1024**3).max(20*1024**3).optional(),delay:z.number().min(0.1).max(30).optional(),retryFailed:z.literal(true).optional(),seedUrls:z.array(z.url()).max(1000).optional()}).strict().optional()}).strict(),
 z.object({action:z.literal('rules'),objective,rules:z.record(z.string(),z.unknown()),sampleIds:z.array(z.string()).min(1).max(100),expectations:z.record(z.string(),z.unknown())}).strict(),
 z.object({action:z.literal('repair'),objective,patches:z.array(z.object({path:z.string(),content:z.string().max(300000)}).strict()).min(1).max(10),samples:z.array(z.object({id:z.string(),kind:z.enum(['failure','regression']),body:z.array(z.string().min(8)).min(1).max(50)}).strict()).min(2).max(30)}).strict(),
 z.object({action:z.literal('withdraw'),objective,kind:z.enum(['rule','repair']),trialId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}).strict(),
 z.object({action:z.literal('blocked'),reason:z.string().min(10).max(4000),evidence:z.array(citation).min(1).max(30),nextSteps:z.array(z.string().min(5)).min(1).max(10)}).strict(),
]);

export function collectionProgress(run:CollectionRun){return collectionHash(JSON.stringify({completed:run.completed,summary:run.summary,snapshot:run.snapshotHash,...(run.acceptedAssetGaps?.length?{acceptedAssetGaps:run.acceptedAssetGaps.map(item=>({id:item.id,stateHash:item.stateHash}))}:{}),...(run.sourceRenderedEvidence?.length?{sourceRenderedEvidence:run.sourceRenderedEvidence.map(item=>item.id)}:{})}));}
export function checkCollectionMechanics(collections:CollectionStore,run:CollectionRun):{checks:CollectionCheck[];records:any[];state:any;report:any}{
 const state=collections.json(run,'.work/state.json'),report=collections.json(run,'site/a-checklist.json'),records=Object.values(state.urls||{}) as any[];
 const gaps=(report.findings||[]).filter((f:any)=>f.severity==='gap');
 const expectedHost=new URL(run.sourceUrl).hostname.replace(/^www\./,''),hosts=(state.siteHosts||[]).map((h:string)=>h.replace(/^www\./,''));
 const checks:CollectionCheck[]=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'unverified',reason:'等待独立证据复核',evidence:[]}));
 const fail=(id:string,reason:string)=>{const check=checks.find(c=>c.id===id)!;check.status='failed';check.reason=reason;};
 let renderedValid=true;
 try{assertSourceRenderedEvidenceIndex(run,path=>collections.read(run,path));}catch(error){renderedValid=false;fail('A5',(error as Error).message);}
 if(state.source!==run.sourceUrl||hosts.some((h:string)=>h!==expectedHost))fail('A1','来源或主机与任务范围不一致');
 if(!records.length||records.some(r=>['pending','failed','over-limit'].includes(r.action)||r.reason==='depth-limit')||gaps.some((g:any)=>g.kind==='discovery'))fail('A2','发现对象尚未闭合；存在失败、待处理或窗口限制');
 const kept=records.filter(r=>r.action==='keep');
 if(!kept.length)fail('A3','没有可核验来源记录');
 for(const record of kept){
   if(!record.rawFile||record.status<200||record.status>=300)fail('A4','来源响应或原件缺失：'+record.id);
   else {try{if(collections.read(run,record.rawFile).length<20)fail('A4','原件内容异常：'+record.id);}catch{fail('A4','原件文件缺失：'+record.id);}}
   try{const data=collections.json(run,'.work/extract/'+record.id+'.json');if(!data.fullText&&!data.images?.length&&!data.forms?.length&&(!renderedValid||!run.sourceRenderedEvidence?.some(item=>item.pageId===record.id&&item.url===record.url)))fail('A5','提取正文为空：'+record.id);}catch{fail('A5','缺少逐页提取：'+record.id);}
 }
 let acceptedIndexValid=true;
 try{assertAcceptedAssetGapIndex(run,path=>collections.read(run,path));}catch(error){acceptedIndexValid=false;fail('A6',(error as Error).message);}
 try{for(const entry of failedCollectionAssetEntries(state))if(!acceptedIndexValid||!acceptedCollectionAssetEntry(run,entry))fail('A6','未接受的素材失败：'+entry.url+'；'+(entry.note||entry.status));}catch(error){acceptedIndexValid=false;fail('A6',(error as Error).message);}
 for(const finding of gaps){if(['page','redirect'].includes(finding.kind))fail('A4',finding.reason);if(finding.kind==='content'&&(!renderedValid||!sourceRenderedContentFinding(run,finding)))fail('A5',finding.reason);if(['asset','stylesheet'].includes(finding.kind)&&(!acceptedIndexValid||!acceptedCollectionAssetFinding(run,state,finding)))fail('A6',finding.reason);}
 if(renderedValid&&run.sourceRenderedEvidence?.length&&checks.find(check=>check.id==='A5')!.status!=='failed')checks.find(check=>check.id==='A5')!.reason='已保留静态原件与提取；对应empty-content有独立来源浏览器观察，动态文字和功能仍待A5独立复核与B段目标取证。';
 for(const asset of [...(state.assets||[]),...(state.files||[]),...(state.stylesheets||[])]){
   if(asset.status==='over-limit')fail('A6','素材窗口限制仍未处理：'+asset.url);
   if(!asset.localPath&&['saved','cached','deduped'].includes(asset.status))fail('A6','已取得素材缺少文件路径：'+asset.url);
   if(asset.localPath){try{
     const bytes=collections.read(run,asset.localPath);
     if(!bytes.length)fail('A6','素材文件为空：'+asset.localPath);
     if(asset.bytes!==undefined&&asset.bytes!==bytes.length)fail('A6','素材文件大小不一致：'+asset.localPath);
     if(asset.hash&&(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(asset.hash)||createHash(asset.hash.length===40?'sha1':'sha256').update(bytes).digest('hex')!==asset.hash))fail('A6','素材文件哈希不一致：'+asset.localPath);
   }catch{fail('A6','素材文件缺失：'+asset.localPath);}}
 }
 return {checks,records,state,report};
}

function validateCitation(value:z.infer<typeof citation>,collections:CollectionStore,run:CollectionRun,readHashes:Map<string,string>,readSpans:Map<string,string[]>){
 const bytes=collections.read(run,value.path),hash=collectionHash(bytes);if(hash!==value.sha256||readHashes.get(value.path)!==hash||!readSpans.get(value.path)?.some(span=>span.includes(value.quote))||!bytes.toString('utf8').includes(value.quote))throw new Error('复核证据必须引用本轮实际读取、哈希一致的原文片段：'+value.path);
}
export function reviewContext(collections:CollectionStore,run:CollectionRun,task:AutomationTask){
 const mechanics=checkCollectionMechanics(collections,run),records=mechanics.records;
 const previous=run.review as any,manifest=new ManifestStore(collections.store).get(task.requirementsId);
 return {task:{id:task.id,scenario:task.scenario,scope:task.scope,inputVersionId:task.versionId,sourceUrl:run.sourceUrl,requirements:task.message.slice(0,20000),requirementsTruncated:task.message.length>20000},collection:{id:run.id,options:run.options,completed:run.completed,checks:mechanics.checks,counts:mechanics.state.counts,totalObjects:records.length,findings:mechanics.report.findings?.slice(0,60),findingsTotal:mechanics.report.findings?.length,previousReview:previous?{action:previous.action,objective:previous.objective,repairStatus:previous.repairResult?.status,repairReason:previous.repairResult?.reason,repairDifferences:previous.repairResult?.differences?.slice(0,10)}:undefined,previousError:run.error},
   recovery:collectionReviewHistory(collections,run,task),
   acceptedAssetGaps:run.acceptedAssetGaps?.length?{guidance:acceptedAssetGapGuidance(run.acceptedAssetGaps),evidencePath:acceptedAssetGapEvidencePath,acceptanceIds:run.acceptedAssetGaps.map(item=>item.id)}:undefined,
   sourceRenderedEvidence:run.sourceRenderedEvidence?.length?{guidance:sourceRenderedGuidance(run),evidencePath:sourceRenderedEvidencePath,objects:run.sourceRenderedEvidence.map(item=>({id:item.id,pageId:item.pageId,url:item.url,observationPath:item.observationPath,screenshotPath:item.screenshotPath}))}:undefined,
   sourceContractNotice:'A5须区分静态可见正文与脚本/隐藏元数据。脚本文本或坐标不是静态可见正文，不得因存在于raw就追加fullText并标记hidden:false。动态地图/JS内容应调用read {kind:"rendered",url:已登记keep精确URL}自主取得真实PNG和可见DOM，再read file读取索引/观察并查看截图，交接required page/interaction功能项。旧Python回执browserSupported=false只描述Python bridge，不代表宿主rendered工具不可用，不据此请求人工或认定无法取证。素材接受不放宽正文证据。存在任务内repair时，核对原件、完整extract、采用receipt及宿主preflight（如有），必要时withdraw修复后重新提取/渲染/验证；不能为了交接而放宽B段回指契约。',
   index:{objects:records.slice(0,25).map(r=>({id:r.id,url:r.url,action:r.action,rawFile:r.rawFile,extract:'.work/extract/'+r.id+'.json'})),remaining:Math.max(0,records.length-25),paths:['site/discovery.json','site/completeness.json','site/a-checklist.json','site/coverage.csv','data/page-groups.json','.work/state.json',...(run.acceptedAssetGaps?.length?[acceptedAssetGapEvidencePath]:[]),...(run.sourceRenderedEvidence?.length?[sourceRenderedEvidencePath]:[]),...(existsSync(resolve(collections.workspace(run),'.work/platform-source-preflight.json'))?['.work/platform-source-preflight.json']:[])],lastOutcome:run.lastOutcome,adoptions:run.adoptions?.map(a=>({kind:a.kind,trialId:a.trialId,state:a.state,receiptPath:a.receiptPath})),note:'对象和发现列表必须用 read objects/findings 分页；原件与提取按路径读取。不要把已发现集合称作全源站。'},previousManifest:manifest?{id:manifest.id,revision:manifest.revision,totalItems:manifest.items.length,note:'用read kind=manifest分页读取。补采ready可只提交新增项和有变化的既有项；宿主保留其他所有既有项，拒绝缩减已有必迁基线。'}:undefined,submissionSchema:z.toJSONSchema(reviewSchema)};
}

export async function reviewCollection(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,collections:CollectionStore,run:CollectionRun,signal:AbortSignal,dependencies:{decide?:typeof localDecision;captureRendered?:typeof captureSourceRenderedEvidence}={}){
 const policy=task.completenessPolicy||vault.automation().completeness!;
 // The activity clock belongs to a window; model admission and repeated-request detection belong to the review.
 run.reviewAttempt++;run.status='reviewing';run.checks=checkCollectionMechanics(collections,run).checks;
 const id='collection-'+run.id+'-'+run.reviewAttempt;
 const initialAccount=run.reviewContinuation?.workId||id;
 new RequestBudget(store.db,{key:initialAccount,runKey:initialAccount,maxTokens:policy?.maxTokens||2000000,maxRequests:policy?.maxRequests||80,maxOutputTokens:16384});
 if(store.db.prepare("SELECT id FROM auto_model_requests WHERE account_id LIKE ? AND state IN ('active','unknown') LIMIT 1").get('collection-'+run.id+'-%'))throw new CollectionBlocked('先前采集复核请求尚未确认停止，不能通过新窗口绕过',['核对原模型请求和用量，再恢复当前采集任务。']);
 await selectExperience(task,'generation',store,vault,directory,signal);
 const sop=readFileSync(resolve(process.cwd(),'sop/automation-collection-v1/review.md'),'utf8')+adoptedGuidance(task,store,'generation');
 const binding=()=>collectionHash(JSON.stringify({contract:'collection-review-continuation-v1',schema:z.toJSONSchema(reviewSchema),task:{id:task.id,version:task.versionId,requirements:task.message,requirementsId:task.requirementsId,model:task.model||{name:vault.automation().evaluationModel,endpoint:vault.automation().evaluationEndpoint},policy},run:{input:run.inputVersionId,source:run.sourceUrl,engine:run.engineVersion,baseEngine:run.baseEngineVersion,currentEngine:collectionEngineFingerprint(),options:run.options,completed:run.completed,operations:run.operations,next:run.next,adoptions:run.adoptions,acceptedAssetGaps:run.acceptedAssetGaps,sourceRenderedEvidence:run.sourceRenderedEvidence},manifest:new ManifestStore(store).get(task.requirementsId),sop,files:['.work/state.json','site/a-checklist.json','site/discovery.json','site/completeness.json','site/coverage.csv','data/page-groups.json',acceptedAssetGapEvidencePath,sourceRenderedEvidencePath].map(path=>[path,existsSync(resolve(collections.workspace(run),path))?collectionHash(collections.read(run,path)):null])}));
 const receiptBytes=(receipt:CollectionReviewReceipt)=>receipt.kind==='requirements'?Buffer.from(task.message):receipt.kind==='engine'?readFileSync(resolve(collectionEngineRoot(),receipt.path.slice('engine:'.length))):collections.read(run,receipt.path);
 const receiptValid=(receipt:CollectionReviewReceipt)=>{try{const bytes=receiptBytes(receipt),text=bytes.toString('utf8');return collectionHash(bytes)===receipt.sha256&&Number.isSafeInteger(receipt.offset)&&Number.isSafeInteger(receipt.chars)&&receipt.offset>=0&&receipt.chars>=0&&receipt.offset<=text.length&&receipt.offset+receipt.chars<=text.length;}catch{return false;}};
 const currentBinding=binding(),previous=run.reviewContinuation;
 const continuing=Boolean(previous?.resumable&&previous.threadId&&previous.binding===currentBinding&&previous.readReceipts.every(receiptValid));
 const continuation=continuing?previous!:{workId:id,binding:currentBinding,resumable:false,readReceipts:[]};
 continuation.resumable=false;run.reviewContinuation=continuation;collections.put(run);
 const hashes=new Map<string,string>(),readSpans=new Map<string,string[]>(),receipts=continuation.readReceipts,work=resolve(directory,'collection-reviews',run.id,continuation.workId);
 const audit=resolve(work,'read-receipts.json');mkdirSync(work,{recursive:true,mode:0o700});
 const persist=()=>{writeFileSync(audit,JSON.stringify(receipts),{mode:0o600});collections.put(run);};
 const remember=(receipt:CollectionReviewReceipt,text:string)=>{if(receipt.kind!=='image'){hashes.set(receipt.path,receipt.sha256);readSpans.set(receipt.path,[...(readSpans.get(receipt.path)||[]),text]);}receipts.push(receipt);persist();};
 for(const receipt of receipts){if(receipt.kind==='image')continue;hashes.set(receipt.path,receipt.sha256);const text=receiptBytes(receipt).toString('utf8').slice(receipt.offset,receipt.offset+receipt.chars);readSpans.set(receipt.path,[...(readSpans.get(receipt.path)||[]),text]);}
 persist();
 const read=async(raw:unknown,readSignal:AbortSignal)=>{
   const spec=z.object({kind:z.enum(['file','objects','findings','resources','engine','requirements','manifest','diagnose','rendered']),path:z.string().max(1000).optional(),url:z.url().max(8000).optional(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(24000).default(12000),query:z.string().max(1000).optional()}).strict().parse(raw);
   if(spec.kind==='rendered'){
     if(!spec.url)throw new Error('来源浏览器取证需要本任务keep清单中的精确url');
     const evidence=await (dependencies.captureRendered||captureSourceRenderedEvidence)(collections,run,spec.url,{signal:readSignal});
     // Capturing is an authorized addition within this review. Its new index is not retroactively read.
     for(let index=receipts.length-1;index>=0;index--)if(receipts[index].path===sourceRenderedEvidencePath&&!receiptValid(receipts[index]))receipts.splice(index,1);
     if(hashes.get(sourceRenderedEvidencePath)!==collectionHash(collections.read(run,sourceRenderedEvidencePath))){hashes.delete(sourceRenderedEvidencePath);readSpans.delete(sourceRenderedEvidencePath);}continuation.binding=binding();persist();
     return {evidencePath:sourceRenderedEvidencePath,id:evidence.id,pageId:evidence.pageId,url:evidence.url,observationPath:evidence.observationPath,screenshotPath:evidence.screenshotPath,notice:'此回执不构成已读证据。用read kind=file读取索引和observation后，才能按实际sha256/quote引用；静态fullText不变，功能必须进入page/interaction清单。'};
   }
   if(spec.kind==='diagnose'){
     if(!spec.url)throw new Error('资源诊断需要已在本任务素材或样式表清单中的精确url');
     const {diagnoseCollectionResource}=await import('./diagnostics.js');
     return diagnoseCollectionResource(collections,run,spec.url,{signal:readSignal});
   }
   if(spec.kind==='manifest'){const value=new ManifestStore(store).get(task.requirementsId),text=JSON.stringify(value||null);return {text:text.slice(spec.offset,spec.offset+spec.limit),offset:spec.offset,totalChars:text.length,nextOffset:spec.offset+spec.limit<text.length?spec.offset+spec.limit:null};}
   if(spec.kind==='engine'||spec.kind==='requirements'){
     const allowed=['siteharvest/extract.py','siteharvest/discover.py','siteharvest/dataset.py','siteharvest/assets.py'];
     if(spec.kind==='engine'&&!allowed.includes(spec.path||''))throw new Error('只能读取允许修复的内置模块');
     const {collectionEngineRoot}=await import('./runtime.js'),text=spec.kind==='requirements'?task.message:readFileSync(resolve(collectionEngineRoot(),spec.path!),'utf8'),path=spec.kind==='requirements'?'requirements':'engine:'+spec.path,sha256=collectionHash(text);hashes.set(path,sha256);
     const span=text.slice(spec.offset,spec.offset+spec.limit);remember({kind:spec.kind,path,sha256,offset:spec.offset,chars:span.length},span);
     return {path,sha256,text:span,offset:spec.offset,totalChars:text.length,nextOffset:spec.offset+spec.limit<text.length?spec.offset+spec.limit:null};
   }
   if(spec.kind==='file'){
     if(!spec.path)throw new Error('读取证据需要path');const bytes=collections.read(run,spec.path);if(bytes.length>50*1024*1024)throw new Error('单个证据超过读取上限');
     if(spec.path.endsWith('.png')){const sha256=collectionHash(bytes);remember({kind:'image',path:spec.path,sha256,offset:0,chars:0},'');return {path:spec.path,sha256,imagePath:resolve(collections.workspace(run),spec.path),notice:'这是PNG原件路径，使用原生图片查看能力实际看图；引用逐字片段仍应read对应observation JSON。'};}
     const text=bytes.toString('utf8'),sha256=collectionHash(bytes);hashes.set(spec.path,sha256);const value={path:spec.path,sha256,offset:spec.offset,totalChars:text.length,text:text.slice(spec.offset,spec.offset+spec.limit),nextOffset:spec.offset+spec.limit<text.length?spec.offset+spec.limit:null};
     remember({path:spec.path,sha256,offset:spec.offset,chars:value.text.length},value.text);return value;
   }
   const state=collections.json(run,'.work/state.json');const rows=spec.kind==='objects'?Object.values(state.urls||{}):spec.kind==='resources'?[...(state.assets||[]).map((r:any)=>({...r,resourceKind:'image'})),...(state.files||[]).map((r:any)=>({...r,resourceKind:'document'})),...(state.stylesheets||[]).map((r:any)=>({...r,resourceKind:'stylesheet'}))].map((r:any)=>({resourceKind:r.resourceKind,url:r.url,status:r.status,note:r.note,pageId:r.pageId,pageUrl:r.pageUrl,role:r.role,localPath:r.localPath,bytes:r.bytes,hash:r.hash})):collections.json(run,'site/a-checklist.json').findings;
   const filtered=spec.query?rows.filter((r:any)=>JSON.stringify(r).includes(spec.query!)):rows,selected=filtered.slice(spec.offset,spec.offset+Math.min(spec.limit,100));
   const page=spec.kind==='objects'?selected.map((r:any)=>({id:r.id,url:r.url,path:r.path,action:r.action,reason:r.reason,status:r.status,title:r.title?.slice(0,300),pageType:r.pageType,lang:r.lang,depth:r.depth,words:r.words,rawFile:r.rawFile,pageFile:r.pageFile,extract:'.work/extract/'+r.id+'.json'})):selected;
   return {items:page,total:filtered.length,offset:spec.offset,nextOffset:spec.offset+page.length<filtered.length?spec.offset+page.length:null};
 };
 try{return await (dependencies.decide||localDecision)({task,store,vault,directory,id,workId:continuation.workId,resumeThreadId:continuing?continuation.threadId:undefined,onThreadStarted:threadId=>{continuation.threadId=threadId;collections.put(run);},stage:'planning',retainStoppedReservations:true,readAliases:['diagnose','resources','rendered'],minutes:policy?.maxMinutes||20,policy:{key:continuation.workId,runKey:continuation.workId,maxTokens:policy?.maxTokens||2000000,maxRequests:policy?.maxRequests||80,maxOutputTokens:16384},signal,context:{...reviewContext(collections,run,task),reviewContinuation:{resumed:continuing,readReceipts:receipts,note:'凭据绑定同一审查和当前文件哈希；仅补未读缺口，不要重读已覆盖片段。最终结果仍必须通过当前主机校验。'}},
   sop,read,
   submit:raw=>{
     if(continuation.binding!==binding()||!receipts.every(receiptValid))throw new Error('采集复核输入或已读证据已变化，需要新的独立复核');
     const result=reviewSchema.parse(raw);
     if(result.action==='ready'){
       if(stages.some(stage=>!run.completed.includes(stage)))throw new Error('尚未完成全部采集阶段，应安排具体continue目标');
       if(new Set(result.checks.map(c=>c.id)).size!==6)throw new Error('必须逐项复核A1–A6，不能重复');
       const mechanics=checkCollectionMechanics(collections,run);if(mechanics.checks.some(c=>c.status==='failed'))throw new Error('确定性检查存在缺口，应提交定向continue/rules/repair目标');
       for(const check of result.checks)for(const ref of check.evidence)validateCitation(ref,collections,run,hashes,readSpans);
       if(!result.checks.find(c=>c.id==='A2')!.evidence.some(e=>/discovery|state|raw/.test(e.path))||!result.checks.find(c=>c.id==='A5')!.evidence.some(e=>e.path.includes('.work/raw/')))throw new Error('入口发现与提取正确性须引用发现过程和实际原件');
       if(run.acceptedAssetGaps?.length&&!result.checks.find(c=>c.id==='A6')!.evidence.some(e=>e.path===acceptedAssetGapEvidencePath))throw new Error('A6必须实际读取并引用本任务素材接受索引，仅判断约定素材范围');
       if(run.sourceRenderedEvidence?.length){
         const evidence=result.checks.find(check=>check.id==='A5')!.evidence;
         if(!evidence.some(ref=>ref.path===sourceRenderedEvidencePath)||run.sourceRenderedEvidence.some(item=>!evidence.some(ref=>ref.path===item.observationPath)))throw new Error('A5必须实际读取并引用来源渲染索引和对应逐页观察，不能只引用capture回执');
         const previous=new ManifestStore(store).get(task.requirementsId),items=previous?[...previous.items.map(item=>result.manifest.items.find(next=>next.id===item.id)||item),...result.manifest.items.filter(item=>!previous.items.some(old=>old.id===item.id))]:result.manifest.items;
         assertSourceRenderedManifest(run,items);
       }
       run.checks=result.checks.map(c=>({id:c.id,status:'verified',reason:c.reason,evidence:c.evidence.map(e=>e.path+'#'+e.sha256)}));
       if(run.acceptedAssetGaps?.length)run.checks.find(c=>c.id==='A6')!.reason='约定素材范围通过；具体已接受失败见'+acceptedAssetGapEvidencePath+'。独立复核：'+run.checks.find(c=>c.id==='A6')!.reason;
       run.checks.push({id:'A7',status:'verified',reason:'宿主将共同冻结资料、原件索引、检查项、复核及清单，hash绑定输入版本',evidence:[]});
     }else if(result.action==='blocked'){for(const ref of result.evidence)validateCitation(ref,collections,run,hashes,readSpans);}
     else if(!result.objective.evidence.every(path=>hashes.has(path)))throw new Error('恢复目标须引用本轮实际读取的证据路径');
     delete run.reviewContinuation;run.review=result;collections.put(run);return result;
   }});}catch(error){
   if(error instanceof LocalDecisionInterrupted&&continuation.threadId&&continuation.binding===binding()&&receipts.every(receiptValid)&&!signal.aborted){continuation.resumable=true;persist();}
   else{delete run.reviewContinuation;collections.put(run);}
   throw error;
 }
}

export async function ensureSourceCollection(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal){
 if(!task.autonomy||task.kind!=='generation'||task.scope!=='site'||!['migration','upgrade'].includes(task.scenario))return;
 const collections=new CollectionStore(store,directory);let run=collections.forTask(task);
 if(task.collectionVersionId&&run?.revisionTaskId!==task.id){
   const snapshot=collections.reusableSnapshot(task.collectionVersionId,task.resourceId);
   if(snapshot.inputVersionId!==task.versionId||snapshot.collectionId!==task.collectionId)throw new CollectionBlocked('冻结采集快照与任务固定输入不一致',['恢复任务指定的快照及输入版本，禁止切换到后续采集版本。']);
   task.requirementsId ||= snapshot.manifestId;return;
 }
 if(!run){if(task.generatedSiteId)throw new CollectionBlocked('新策略任务缺少已冻结来源资料，禁止绕过A段接续生成',['补齐采集资料版本后沿用原任务恢复。']);run=collections.create(task);}
 if(run.inputVersionId!==task.versionId)throw new CollectionBlocked('采集与任务输入版本不一致',['核对固定输入和采集引用，禁止复用其他任务资料。']);
 if(run.baseEngineVersion&&run.baseEngineVersion!==collectionEngineFingerprint())throw new CollectionBlocked('采集引擎与当前任务固定版本不一致，保留检查点',['恢复任务固定的引擎版本，或通过受验证的版本迁移接续，不能默默切换。']);
 if(run.status==='ready'){
   const snapshot=collections.snapshot(run.materialVersionId||'');if(!snapshot)throw new CollectionBlocked('冻结采集资料索引缺失',['恢复对应资料快照后继续。']);collections.verify(snapshot);task.collectionVersionId=snapshot.id;task.requirementsId ||= run.manifestId;store.put(task);return;
 }
 const last=run.operations.at(-1);
 if(last?.status==='running'){
   // A process surviving the worker is not replayed until its own receipt is settled.
   let alive=false;if(last.pid)try{process.kill(last.pid,0);alive=true;}catch{}
   if(alive){if(Date.now()-last.startedAt>60*60000)throw new CollectionBlocked('先前采集进程仍存活且超过核对窗口，暂不重复启动',['核对操作 '+last.id+' 的存活进程和回执后恢复。']);throw new CollectionPending('等待先前采集操作回执',collectionProgress(run),true,Date.now()+15000);}
   const checkpoint=resolve(collections.workspace(run),'.work/platform-checkpoint.json');
   if(existsSync(checkpoint)){const value=JSON.parse(readFileSync(checkpoint,'utf8'));if(value.requestId===last.id&&value.status==='completed'){last.status='completed';last.finishedAt=Date.now();last.receipt=value.receipts;if(stages.includes(last.operation as CollectionStage)&&!run.completed.includes(last.operation as CollectionStage))run.completed.push(last.operation as CollectionStage);}else{last.status='failed';last.error='执行停止，保留阶段检查点后恢复';}}else{last.status='failed';last.error='未确认回执，保留幂等采集操作待恢复';}collections.put(run);
 }
 const nextStage=stages.find(stage=>!run!.completed.includes(stage)),planned=run.next;
 const needsDiagnosis=!planned&&last?.status==='failed'&&run.completed.includes('plan')&&existsSync(resolve(collections.workspace(run),'site/a-checklist.json'));
 if((nextStage||planned)&&!needsDiagnosis){
   delete run.reviewContinuation;
   const operation=planned?.operation||nextStage!,id=randomUUID();
   if(planned?.options){
     for(const name of ['maxPages','maxDepth','maxAssets','maxTotalBytes'] as const)if(planned.options[name]!==undefined&&planned.options[name]!<run.options[name])throw new Error('恢复不能缩小采集范围');
     for(const url of planned.options.seedUrls||[])if(new URL(url).hostname.replace(/^www\./,'')!==new URL(run.sourceUrl).hostname.replace(/^www\./,''))throw new Error('补采入口不能越出来源主机');
     Object.assign(run.options,planned.options);
   }
   const op={id,operation,status:'running' as const,startedAt:Date.now()};run.operations.push(op);run.status='collecting';collections.put(run);
   try{
     const result=await runCollectionBridge({directory,workspace:collections.workspace(run),requestId:id,operation,sourceUrl:run.sourceUrl,options:run.options,payload:planned?.payload,signal,onStarted:pid=>{Object.assign(op,{pid});collections.put(run!);}});
     Object.assign(op,{status:'completed',finishedAt:Date.now(),receipt:result.receipts||{summary:result.summary}});if(result.summary)run.summary=result.summary;run.error=undefined;
     const evidencePath='.work/platform-operations/'+id+'.json';mkdirSync(resolve(collections.workspace(run),'.work/platform-operations'),{recursive:true,mode:0o700});writeFileSync(resolve(collections.workspace(run),evidencePath),JSON.stringify(result,null,2),{mode:0o600});run.lastOutcome={operation,evidencePath,status:String((result.trial as any)?.status||(result.adoption as any)?.status||'completed')};
     if(nextStage&&!planned)run.completed.push(nextStage);
     if(planned){delete run.next;const index=stages.indexOf(operation as CollectionStage);if(index>=0)run.completed=stages.slice(0,index+1);}
     if(operation==='fetch'&&!run.next){const window=planCollectionPageWindow(run,collections.json(run,'.work/state.json'));if(window){run.next=window;store.event(task.id,'程序安排采集软窗口接续：'+window.description);}}
     if(operation==='rules_trial'&&(result.trial as any)?.status==='passed'&&result.reportSha256){run.next={...planned!,operation:'rules_apply',payload:{trialId:planned!.payload!.trialId,expectedTrialHash:result.reportSha256}};}
     if(operation==='rules_apply'&&(result.adoption as any)?.status==='applied'){
       run.adoptions ||= [];run.adoptions.push({kind:'rule',trialId:String(planned!.payload!.trialId),state:'adopted',receiptPath:String(result.receipt)});
     }
     if(operation==='rules_withdraw')for(const adoption of run.adoptions||[])if(adoption.kind==='rule'&&adoption.trialId===planned?.payload?.trialId)adoption.state='withdrawn';
     collections.put(run);store.event(task.id,'采集操作完成：'+operation+'；已保存检查点');
   }catch(error){
     Object.assign(op,{status:'failed',finishedAt:Date.now(),error:(error as Error).message});run.error=(error as Error).message;
     if(operation==='rules_apply'&&planned?.payload?.trialId){const path='.work/rule-trials/'+planned.payload.trialId+'/adoption/receipt.json';try{const receipt=collections.read(run,path);run.next={...planned,operation:'rules_withdraw',payload:{trialId:planned.payload.trialId,expectedReceiptHash:collectionHash(receipt)}};}catch{delete run.next;}}
     else if(planned)delete run.next;
     collections.put(run);signal.throwIfAborted();if(error instanceof CollectionBlocked)throw error;throw new CollectionPending('采集操作待恢复：'+run.error,collectionProgress(run));
   }
   throw new CollectionPending('本批采集完成，继续后续阶段',collectionProgress(run),true);
 }
 try{
   const result=await reviewCollection(task,store,vault,directory,collections,run,signal);
   if(result.action==='ready'){
     const input=store.version(task.versionId);
     const visual=input&&sourceVisualRequired(input)?await captureSourceVisualBaseline(collections,run,{signal}):undefined;
     if(visual)store.event(task.id,`来源视觉基线：${visual.templates.length} 种页面模板，${visual.templates.reduce((sum,template)=>sum+template.screens.length,0)} 张整页截图，${visual.styles.filter(row=>row.path).length} 个 CSS 原文${visual.limitations.length?`；${visual.limitations.length} 条限制见 collection/${sourceVisualIndexPath}`:''}`);
     run.summary={...run.summary as object,sourceCoverage:{status:'unknown',total:null,complete:false},scopeCoverage:{status:'complete',complete:true,basis:result.discoveryBasis},handoffReady:true,...(run.acceptedAssetGaps?.length?{acceptedAssetGaps:structuredClone(run.acceptedAssetGaps),acceptedAssetGapLimitations:acceptedAssetGapLimitations(run)}:{})};
     const manifests=new ManifestStore(store),artifacts:any[]=[],write=evidenceWriter(resolve(directory,'manifest-runs',task.id),artifacts,'content','source',file=>store.db.prepare('INSERT INTO auto_manifest_artifacts VALUES(?,?,?)').run(file.name,task.id,file.sha256));
     const evidence=write({collectionId:run.id,inputVersionId:task.versionId,checks:run.checks,review:run.review,inventory:collections.inventory(run)} as unknown) as {evidence:string};
     const previous=manifests.get(task.requirementsId),items=previous?[...previous.items.map(item=>result.manifest.items.find(next=>next.id===item.id)||item),...result.manifest.items.filter(item=>!previous.items.some(old=>old.id===item.id))]:result.manifest.items;
     const manifest=manifests.save(task,{...result.manifest,items,...(previous?.migration?{migration:previous.migration}:{}),sourceComplete:true,limitations:[...new Set([...(previous?.limitations||[]),...result.manifest.limitations,...result.limitations,...acceptedAssetGapLimitations(run),...(run.sourceRenderedEvidence?.length?[sourceRenderedGuidance(run)]:[]),'源站公开总量未知时保持未知；A段按已核验入口、分页及类型证据判定约定范围，未证明不可发现页面不存在。'])],evidence:[evidence.evidence]},'ai');
     collections.freeze(run,task,manifest.id);task.message+='\n\nA段采集已通过并冻结。资料版本 '+run.materialVersionId+'，清单 '+manifest.id+'。先读取 collection/site/ 与 collection/data/ 索引，按需读取逐页正文和素材；保留来源URL、身份、分类、分页与关系。候选数据有截断边界，完整正文以逐页资料与证据为准。禁止把全集展开到聊天。'+(visual?sourceVisualGuidance(visual):'');store.put(task);store.event(task.id,'A段通过，资料与清单已共同冻结；现在允许创建目标站');return;
   }
   if(result.action==='blocked'){run.status='blocked';run.error=result.reason;collections.put(run);throw new CollectionBlocked(result.reason,result.nextSteps);}
   const stop=recordAutonomousAttempt(task,'collection:'+result.action+('operation' in result?':'+result.operation:''),'采集复核要求定向修正',Date.now(),collectionProgress(run));store.put(task);
   if(stop)throw new CollectionBlocked(stop,['查看保存的采集原件、恢复目标和无进展历史，补齐新条件后沿用原任务恢复。']);
   if(result.action==='continue')run.next={...result.objective,operation:result.operation,options:result.options};
   else if(result.action==='rules')run.next={...result.objective,operation:'rules_trial',payload:{trialId:randomUUID(),rules:result.rules,sampleIds:result.sampleIds,expectations:result.expectations}};
   else if(result.action==='withdraw'){
     const active=run.adoptions?.find(a=>a.kind===result.kind&&a.trialId===result.trialId&&a.state==='adopted');if(!active)throw new Error('只能撤回当前任务实际采用且仍有效的版本');
     if(result.kind==='rule')run.next={...result.objective,operation:'rules_withdraw',payload:{trialId:active.trialId,expectedReceiptHash:collectionHash(collections.read(run,active.receiptPath))}};
     else{const {withdrawRepairFromCollectionWorkspace}=await import('./repair-apply.js');const outcome=await withdrawRepairFromCollectionWorkspace({workspace:collections.workspace(run),adoption:active.adoption as import('./repair.js').RepairAdoption,currentVersion:run.engineVersion,reason:result.objective.description,signal});active.state='withdrawn';run.engineVersion=outcome.version;run.completed=stages.slice(0,stages.indexOf('data'));}
   }
   else {await executeCollectionRepair(result,task,store,collections,run,directory,signal);}
   collections.put(run);throw new CollectionPending('已保存定向恢复目标：'+result.objective.description,collectionProgress(run),true);
 }catch(error){if(error instanceof CollectionPending||error instanceof CollectionBlocked)throw error;signal.throwIfAborted();run.error=(error as Error).message;collections.put(run);throw new CollectionPending('采集复核待接续：'+run.error,collectionProgress(run));}
}

// The actual OS isolation executor is loaded only for a task-scoped candidate.
async function executeCollectionRepair(result:Extract<z.infer<typeof reviewSchema>,{action:'repair'}>,task:AutomationTask,store:AutomationStore,collections:CollectionStore,run:CollectionRun,directory:string,signal:AbortSignal){
 const { runIsolatedRepair, adoptRepair }=await import('./repair.js');
 const { collectionEngineRoot, collectionPython }=await import('./runtime.js');
 const { readdirSync }=await import('node:fs');
 const root=collectionEngineRoot(),allowed=['siteharvest/extract.py','siteharvest/discover.py'];
 const samples=result.samples.map(sample=>{const state=collections.json(run,'.work/state.json'),record=(Object.values(state.urls) as any[]).find(r=>r.id===sample.id);if(!record?.rawFile)throw new Error('修复样本必须为已保存原件');const bytes=collections.read(run,record.rawFile);if(!sample.body.every(text=>bytes.toString('utf8').includes(text)))throw new Error('样本预期必须能在原件中逐字核对');return {id:sample.id,kind:sample.kind,sourcePath:resolve(collections.workspace(run),record.rawFile),sha256:collectionHash(bytes),url:record.url,expected:{body:sample.body,entities:[],links:[]},expectedVersion:collectionHash(JSON.stringify(sample.body))};});
 const files=readdirSync(resolve(root,'siteharvest')).filter(name=>name.endsWith('.py')).map(name=>{const path='siteharvest/'+name,sourcePath=resolve(root,path);return {path,sourcePath,sha256:collectionHash(readFileSync(sourcePath))};});
 const repairInput={candidate:{id:randomUUID(),taskId:task.id,baseVersion:run.engineVersion,entryPoint:'siteharvest/extract.py',patches:result.patches,reason:result.objective.description,evidenceIds:result.objective.evidence,affectedObjects:result.objective.affectedObjects},engineFiles:files,allowedPatchPaths:allowed,samples:samples.map(s=>{const current=collections.json(run,'.work/extract/'+s.id+'.json');return {...s,previousBody:current.fullText||'',expected:{body:current.fullText||'',entities:[],links:(current.links||[]).map((link:any)=>typeof link==='string'?link:link.url)},...(s.kind==='failure'?{bodyContains:s.expected.body}:{})};}),pythonPath:collectionPython(directory),signal};
 const outcome=await runIsolatedRepair(repairInput);
 store.event(task.id,'采集隔离修复结果：'+outcome.status);run.review={...result,repairResult:outcome};
 if(outcome.status==='passed'){
   const adoption=adoptRepair(repairInput,outcome,run.engineVersion);run.review={...result,repairResult:outcome,adoption};
   const {applyRepairToCollectionWorkspace}=await import('./repair-apply.js');
   const applied=await applyRepairToCollectionWorkspace({workspace:collections.workspace(run),input:repairInput,trial:outcome,adoption});
   run.review={...result,repairResult:outcome,adoption,application:applied};
   if(applied.application.status!=='completed')throw new CollectionPending('任务内隔离修复尚未应用：'+applied.application.status,collectionProgress(run));
   run.adoptions ||= [];run.adoptions.push({kind:'repair',trialId:outcome.id,state:'adopted',adoption,receiptPath:applied.receipt!.receipt});
   run.engineVersion=adoption.version;run.completed=stages.slice(0,stages.indexOf('data'));run.next=undefined;
   return;
 }
 throw new CollectionPending('隔离修复未通过：'+outcome.status,collectionProgress(run));
}
