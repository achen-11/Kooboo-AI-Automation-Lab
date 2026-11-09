import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings, defaultOptimizationPolicy, type AutomationReport, type FollowupAction, type CollectionReportObservation } from '../shared/automation.js';
import { CollectionStore } from '../server/automation/collection/store.js';
import { collectionSourceGaps } from '../server/automation/collection/recollection.js';
import { followupActionSchema, validateFollowupAction } from '../server/automation/followup.js';
import { applyOptimizationAction, advanceOptimization } from '../server/automation/optimization.js';
import { ManifestStore } from '../server/automation/completeness.js';

function fixture(){
  const directory=mkdtempSync(resolve(tmpdir(),'collection-recollection-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory),settings=structuredClone(defaultAutomationSettings);
  const resource=store.saveResource({name:'Migration',scenario:'migration',contentUrl:'https://source.invalid',referenceUrl:'',description:'original',files:[],externalSource:'',externalId:''});
  const root=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:'',optimization:{...defaultOptimizationPolicy,maxRounds:5}},settings)[0];
  root.generatedSiteId=randomUUID();root.siteUrl='https://target.invalid';root.generation={prepared:true,conversationId:'original-conversation',deliveryId:'old-completed-delivery',deliveryState:'completed',importedMaterials:{'original-file':'original-hash'}};root.status='completed';root.stopped=true;
  store.saveSite({id:root.generatedSiteId,resourceId:root.resourceId,versionId:root.versionId,environmentId:'env',siteId:'physical-site',name:'Target',url:root.siteUrl,createdAt:Date.now()});store.beginSiteChange(root);
  const manifests=new ManifestStore(store),manifest=manifests.save(root,{sourceComplete:true,limitations:[],items:[{id:'original',title:'Original scope',kind:'page',required:true,source:'original',expectation:'all frozen pages',paths:['/123.aspx'],expectedCount:1,viewports:['desktop','mobile']}],evidence:[]},'human');
  const collections=new CollectionStore(store,directory),run=collections.create(root),workspace=collections.workspace(run);mkdirSync(resolve(workspace,'.work/raw'),{recursive:true});writeFileSync(resolve(workspace,'.work/raw/one.html'),'<html>original source</html>');writeFileSync(resolve(workspace,'source.md'),'original source');
  run.completed=['plan','discover','fetch','extract','assets','data','render','verify'];run.review={action:'ready'};run.checks=(['A1','A2','A3','A4','A5','A6','A7'] as const).map(id=>({id,status:'verified',reason:'evidence',evidence:[]}));const snapshot=collections.freeze(run,root,manifest.id);
  const evaluation=store.ensureEvaluation(root,settings),report:AutomationReport={summary:'Independent source gap',quality:'unverified',assessments:[],scores:[],issues:[{severity:'major',title:'来源资料缺少详情页',detail:'独立复核发现来源资料未采集 https://source.invalid/456.aspx?page=2 的完整正文，冻结原件缺失。',evidence:['source-read.json']}],coverage:{verified:[],unverified:[],outOfScope:[]},artifacts:[]};evaluation.report=report;evaluation.status='completed';evaluation.stopped=true;store.put(evaluation);
  root.optimization!.state='planning';root.optimization!.reportId=evaluation.id;root.optimization!.rounds[0].evaluationTaskId=evaluation.id;root.evaluationTaskId=evaluation.id;store.scheduleFollowup(root,settings.followup);root.followup!.executionStopped=true;
  const evidence='observation-current-report',reportObservations:Record<string,CollectionReportObservation>={[evidence]:{reportId:evaluation.id,sourceGaps:collectionSourceGaps(report)}};root.followup!.reportObservations=reportObservations;root.followup!.observations=[evidence];store.put(root);
  const action:FollowupAction={action:'collect',reason:'独立报告证明具体来源原件缺失，需要定向补采',evidence:[evidence],collectionObjective:{description:'补采缺失详情页的完整原始响应、全文及依赖资料',affectedObjects:['https://source.invalid/456.aspx?page=2'],evidence:[evidence],acceptance:'冻结新来源版本，原站对应详情全文、标题、链接和数据关系通过独立复评',operation:'discover',options:{seedUrls:['https://source.invalid/456.aspx?page=2'],maxPages:600}}};
  return {directory,db,store,vault,settings,root,collections,run,snapshot,manifest,evaluation,action,evidence,reportObservations,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('collect requires a concrete source deficiency observed through the current get_report',()=>{const f=fixture();try{
  const validate=(action:FollowupAction,observed=f.reportObservations)=>validateFollowupAction(action,f.root,{reportObservations:observed},new Set([f.evidence,'observation-get-task']));
  assert.equal(validate(f.action).action,'collect');
  assert.throws(()=>validate({...f.action,collectionObjective:{...f.action.collectionObjective!,evidence:['observation-get-task']}}),/get_report/);
  assert.throws(()=>validate({...f.action,collectionObjective:{...f.action.collectionObjective!,affectedObjects:['/not-observed.aspx']}}),/具体来源/);
  assert.throws(()=>validate({...f.action,collectionObjective:{...f.action.collectionObjective!,affectedObjects:['/']}}));
  assert.throws(()=>validate(f.action,{[f.evidence]:{reportId:'older-report',sourceGaps:f.reportObservations[f.evidence].sourceGaps}}),/get_report/);
  assert.throws(()=>validate(f.action,{[f.evidence]:{reportId:f.evaluation.id,sourceGaps:collectionSourceGaps({...f.evaluation.report!,issues:[],coverage:{verified:[],unverified:['全源站总数未知，https://source.invalid/456.aspx?page=2 是已有对象'],outOfScope:[]}})}}),/具体来源/);
  assert.throws(()=>validateFollowupAction(f.action,{...f.root,optimization:undefined},{reportObservations:f.reportObservations},new Set([f.evidence])),/普通恢复/);
  assert.equal(followupActionSchema.safeParse({...f.action,collectionObjective:{...f.action.collectionObjective!,operation:'run_code'}}).success,false);
  assert.equal(followupActionSchema.safeParse({...f.action,collectionObjective:{...f.action.collectionObjective!,payload:{code:'arbitrary'}}}).success,false);
}finally{f.close();}});

test('collect durably queues A then an explicit continuation on the same site and conversation, retaining old evidence and imports',()=>{const f=fixture();try{
  applyOptimizationAction(f.root,f.action,f.store,f.settings,f.directory);
  const root=f.store.task(f.root.id)!,child=f.store.task(root.optimization!.activeTaskId)!,run=f.collections.get(f.run.id)!;
  assert.equal(root.optimization!.state,'repairing');assert.equal(root.optimization!.rounds.length,2);assert.equal(child.generatedSiteId,f.root.generatedSiteId);assert.equal(child.versionId,f.root.versionId);assert.equal(child.generation!.conversationId,'original-conversation');assert.equal(child.generation!.prepared,false);assert.deepEqual(child.generation!.importedMaterials,{'original-file':'original-hash'});assert.equal(child.generation!.next!.action,'continue');assert.match(child.generation!.next!.message!,/A段通过后/);assert.match(child.generation!.next!.message!,/456.aspx/);
  assert.equal(run.status,'collecting');assert.equal(run.next!.operation,'discover');assert.deepEqual(run.next!.affectedObjects,f.action.collectionObjective!.affectedObjects);assert.equal(run.checks.length,0);assert.equal(run.review,undefined);assert.ok(run.completed.length<8);assert.equal(child.collectionVersionId,f.snapshot.id);assert.ok(f.collections.snapshot(f.snapshot.id));assert.equal(f.collections.original(f.snapshot,'.work/raw/one.html').toString(),'<html>original source</html>');assert.equal(f.store.task(f.evaluation.id)!.report!.summary,'Independent source gap');assert.equal(f.store.tasks().filter(task=>task.kind==='evaluation').length,1);
  advanceOptimization(root,f.store,f.settings);assert.equal(f.store.tasks().filter(task=>task.kind==='evaluation').length,1,'queued recollection cannot directly create a second evaluation');
  assert.throws(()=>validateFollowupAction({action:'evaluate',reason:'old loop completed',evidence:[f.evidence]},child,{siteReady:true},new Set([f.evidence])),/原执行停止|尚未发送/);
  assert.throws(()=>applyOptimizationAction(root,f.action,f.store,f.settings,f.directory),/质量分析/);assert.equal(f.store.tasks().filter(task=>task.kind==='generation').length,2);
}finally{f.close();}});

test('collect rejects cross-source seeds, shrinking scope, stale observations, uncertain delivery and a missing directory before scheduling work',()=>{for(const mode of ['host','shrink','stale','delivery','directory']){const f=fixture();try{
  if(mode==='host')f.action.collectionObjective!.options={seedUrls:['https://other.invalid/missing']};
  if(mode==='shrink')f.action.collectionObjective!.options={maxPages:300,maxDepth:6};
  if(mode==='shrink'){const run=f.collections.get(f.run.id)!;run.options.maxPages=600;f.collections.put(run);}
  if(mode==='stale')f.root.followup!.reportObservations={};
  if(mode==='delivery'){f.root.generation!.deliveryState='sending';f.store.put(f.root);}
  assert.throws(()=>applyOptimizationAction(f.root,f.action,f.store,f.settings,mode==='directory'?undefined:f.directory));
  assert.equal(f.store.tasks().filter(task=>task.kind==='generation').length,1);assert.equal(f.collections.get(f.run.id)!.status,'ready');
}finally{f.close();}}});

test('target implementation defects cannot masquerade as source collection gaps',()=>{const f=fixture();try{
  const target={version:1,id:'target-report',taskId:f.evaluation.id,inputVersionId:f.root.versionId,collectionId:f.run.id,collectionVersionId:f.snapshot.id,snapshotHash:f.snapshot.sha256,manifestId:f.manifest.id,manifestRevision:1,generatedSiteId:f.root.generatedSiteId!,siteId:'physical-site',siteRevision:f.root.siteRevision!,binding:'binding',state:'unverified',checkedAt:Date.now(),checkedPages:1,expectedPages:1,checks:[{id:'relations:/456.aspx?page=2',kind:'relations',status:'unverified',reason:'来源列表 /456.aspx?page=2 包含必迁动态记录，但后台分类/关系映射未取得或不一致。',evidence:[]},{id:'data:records',kind:'data',status:'unverified',reason:'缺少来源全集、唯一后台身份映射或完整分页，无法定位 /456.aspx?page=2。',evidence:[]}],artifacts:[],issues:[],limitations:[]} as const;
  const report={...f.evaluation.report!,issues:[{severity:'major' as const,title:'B段宿主核验：relations:/456.aspx?page=2',detail:target.checks[0].reason,evidence:[]},{severity:'major' as const,title:'目标站缺少对应实现',detail:'来源页面 /456.aspx?page=2 在目标站缺少后台分类关系。',evidence:[]}],collectionTarget:structuredClone(target) as any};
  assert.deepEqual(collectionSourceGaps(report),[]);
  assert.deepEqual(collectionSourceGaps({...report,issues:[{severity:'major',title:'来源资料不完整',detail:'全源站总数未知，/456.aspx?page=2 是已知页面。',evidence:[]}],collectionTarget:undefined}),[]);
  report.collectionTarget.checks.push({id:'binding-error',kind:'binding',status:'unverified',reason:'冻结原件不完整或已变化：.work/raw/missing.html',evidence:[]});
  assert.deepEqual(collectionSourceGaps(report),['冻结原件不完整或已变化：.work/raw/missing.html']);
}finally{f.close();}});
