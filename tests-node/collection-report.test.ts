import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AutomationReport } from '../shared/automation.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { CollectionTargetReport } from '../shared/collection-target.js';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { checkpointCollectionReport, finishPendingCollectionReport, mergeCollectionTargetReport, collectionTargetRepairContext } from '../server/automation/collection/report.js';
import { targetReached } from '../server/automation/optimization.js';

function report():AutomationReport{return {summary:'Independent review',quality:'passed',assessments:[{criterionId:'one',viewport:'desktop',score:90,passed:true,reason:'actual image',evidence:['desktop.png']},{criterionId:'one',viewport:'mobile',score:90,passed:true,reason:'actual image',evidence:['mobile.png']}],scores:[{viewport:'desktop',value:90},{viewport:'mobile',value:90}],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},artifacts:[],completeness:{state:'complete',checks:[],manifestId:'manifest',manifestRevision:1} as any};}
const target=(state:CollectionTargetReport['state']):CollectionTargetReport=>({version:1,id:'target-report',taskId:'evaluation',inputVersionId:'input',collectionId:'collection',collectionVersionId:'snapshot',snapshotHash:'hash',manifestId:'manifest',manifestRevision:1,generatedSiteId:'site',siteId:'physical',siteRevision:'revision',binding:'binding',state,checkedAt:1,checkedPages:1,expectedPages:1,checks:[{id:'page:/1',kind:'page',status:state==='complete'?'verified':state==='incomplete'?'missing':'unverified',reason:'observed',evidence:['actual.json']}],artifacts:[{id:'actual',name:'actual.json',type:'application/json',size:1,sha256:'hash'}],issues:state==='incomplete'?[{severity:'major',title:'Missing original body',detail:'Actual response differs',evidence:['actual.json']}]:[],limitations:[]});

test('program target evidence lowers AI verdict and carries actual evidence without promoting failures',()=>{
  for(const state of ['incomplete','unverified','complete'] as const){const value=report();mergeCollectionTargetReport(value,target(state));assert.equal(value.quality,state==='incomplete'?'failed':state==='unverified'?'unverified':'passed');assert.equal(value.completeness?.state,state==='incomplete'?'incomplete':state==='unverified'?'unverified':'complete');assert.equal(value.artifacts[0].name,'actual.json');}
  const failed=report();failed.quality='failed';failed.completeness!.state='incomplete';mergeCollectionTargetReport(failed,target('complete'));assert.equal(failed.quality,'failed');assert.equal(failed.completeness?.state,'incomplete');
});

test('high independent scores cannot complete an absent, failed or stale B gate',()=>{
  const value=report(),task:any={collectionVersionId:'snapshot',versionId:'input',generatedSiteId:'site',siteRevision:'revision',scope:'site',requirementsEnabled:true,optimization:{currentRevision:'revision',policy:{targetScore:85}},rule:{criteria:[{id:'one',required:true,scopes:['site'],viewports:['desktop','mobile']}]}};
  assert.equal(targetReached(task,value),false);for(const state of ['pending','unverified','incomplete'] as const){value.collectionTarget=target(state);assert.equal(targetReached(task,value),false);}
  value.collectionTarget=target('complete');assert.equal(targetReached(task,value),true);value.collectionTarget.siteRevision='old';assert.equal(targetReached(task,value),false);
});

test('repair planner receives bounded source objects while full B evidence is retained',()=>{
  const full=target('incomplete');full.checks=Array.from({length:120},(_,i)=>({...full.checks[0],kind:'data' as const,id:'data:'+i,expectedKeys:Array.from({length:100},(_,n)=>String(n))}));full.checks.push({...full.checks[0],id:'relations:main',kind:'relations',expectedKeys:['a','b'],actualKeys:['b','c']});
  const context=collectionTargetRepairContext(full)!,[records,relations]=context.confirmedTargetFailures;assert.equal(context.confirmedTargetFailureCount,121);assert.equal(context.confirmedTargetFailures.length,2);assert.equal(context.omitted.confirmedTargetFailures,0);
  assert.deepEqual([records.id,records.count,records.sampleIds,records.expectedCount,records.expectedKeys?.length],['data:{n}',120,['data:0','data:1','data:2'],100,6]);
  assert.deepEqual([relations.id,relations.count,relations.missingKeys,relations.unexpectedKeys],['relations:main',1,['a'],['c']]);assert.equal(full.checks.length,121);assert.equal(full.checks[0].expectedKeys?.length,100);
});

test('repeated page differences reach the planner as template groups with complete page counts',()=>{
  const full=target('incomplete');
  full.checks=Array.from({length:300},(_,i)=>({id:`page:/cn/show/${i}`,kind:'page' as const,status:'missing' as const,sourcePath:`/cn/show/${i}`,reason:'differs',evidence:[`diff-${i}.json`],differences:{missingTextFragments:['[ 返 回 ]',`独有正文 ${i}`,...(i<120?['官方网站']:[])],missingLinkUrls:[],textTruncated:false}}));
  full.checks.push({id:'page:/cn/category/2',kind:'page',status:'verified',sourcePath:'/cn/category/2',reason:'ok',evidence:[]});
  const context=collectionTargetRepairContext(full)!,[back,unique,official]=context.defectGroups;
  assert.equal(context.targetRepairAllowed,true);assert.equal(context.defectGroupsApproximate,true);assert.equal(context.confirmedTargetFailureCount,300);assert.deepEqual(context.confirmedTargetFailures,[]);
  assert.deepEqual([back.template,back.kind,back.key,back.pages,back.templatePages],['/cn/show/{n}','navigation','[ 返 回 ]',300,300]);assert.equal(back.samplePaths.length,3);
  assert.deepEqual([unique.key,unique.pages,unique.uniqueFragments],['各页独有片段',300,300]);assert.deepEqual([official.key,official.pages],['官方网站',120]);
  assert.ok(JSON.stringify(context).length<12000);
});

test('binding errors with zero checked paths remain verification gaps even when no concrete source gaps were found',()=>{
  const full=target('unverified');full.checkedPages=0;full.expectedPages=0;full.checks=[{id:'binding-error',kind:'binding',status:'unverified',reason:'冻结数据分片数量不一致',evidence:['collection-target-binding-error.json']}];
  const before=structuredClone(full),context=collectionTargetRepairContext(full)!;
  assert.equal(context.state,'unverified');assert.equal(context.unresolved,1);assert.equal(context.checkedPages,0);assert.equal(context.targetRepairAllowed,false);assert.equal(context.confirmedTargetFailureCount,0);assert.deepEqual(context.confirmedTargetFailures,[]);assert.equal(context.verificationGapCount,1);assert.deepEqual(context.defectGroups,[]);assert.equal(context.verificationGaps[0].status,'unverified');assert.equal(context.verificationGaps[0].reason,'冻结数据分片数量不一致');
  for(const boundary of ['sourceGaps=[]','不表示来源完整','不能据此把 binding-error 转为目标修复事项','不得委托 Kooboo 修站 AI 修改冻结资料','平台代码','保持 unverified/未通过门槛'])assert.ok(context.guidance.includes(boundary));
  assert.deepEqual(full,before);const merged=report();mergeCollectionTargetReport(merged,full);assert.equal(merged.quality,'unverified');assert.equal(merged.completeness!.state,'unverified');
});

test('confirmed missing target content remains repairable with its original reason, keys and evidence',()=>{
  const full=target('incomplete');full.checks=[{id:'binding',kind:'binding',status:'verified',reason:'Current inputs and target revision match',evidence:[]},{id:'page:/1',kind:'page',status:'missing',sourcePath:'/1',reason:'Actual target response omits frozen body',expectedKeys:['source-one'],actualKeys:[],evidence:['target-body-difference.json']}];
  const context=collectionTargetRepairContext(full)!;
  assert.equal(context.state,'incomplete');assert.equal(context.unresolved,1);assert.equal(context.targetRepairAllowed,true);assert.equal(context.confirmedTargetFailureCount,1);assert.equal(context.verificationGapCount,0);assert.deepEqual(context.verificationGaps,[]);assert.deepEqual(context.defectGroups.map(group=>[group.template,group.pages,group.evidence]),[['/{n}',1,['target-body-difference.json']]]);
});

test('non-binding unverified reads and identity declarations never become confirmed target repair work',()=>{
  const full=target('unverified');full.checks=[{id:'inventory:sqlite',kind:'data',status:'unverified',reason:'权限不足，未取得完整后台分页',evidence:['implementation-error.json']},{id:'data:records',kind:'data',status:'unverified',reason:'冻结来源全集或唯一映射未取得',evidence:[]},{id:'rendered:/1',kind:'page',status:'unverified',reason:'没有当前修订的浏览器观测',evidence:[]}];
  const context=collectionTargetRepairContext(full)!;assert.equal(context.targetRepairAllowed,false);assert.equal(context.confirmedTargetFailureCount,0);assert.equal(context.verificationGapCount,3);assert.equal(context.unresolved,3);assert.ok(context.verificationGaps.every(check=>check.status==='unverified'));
});

test('mixed reports retain verification gaps while allowing only confirmed target failures',()=>{
  const full=target('incomplete');full.checks.push({id:'data:records',kind:'data',status:'unverified',reason:'来源全集未闭合',evidence:[]});
  const context=collectionTargetRepairContext(full)!;assert.equal(context.targetRepairAllowed,true);assert.equal(context.confirmedTargetFailureCount,1);assert.equal(context.defectGroups[0].samplePaths[0],'/1');assert.equal(context.verificationGapCount,1);assert.equal(context.verificationGaps[0].id,'data:records');assert.equal(context.unresolved,2);assert.match(context.guidance,/verificationGaps 继续未验证/);
});

for(const status of ['unverified','missing'] as const){
  test(`a ${status} binding gap prevents target delegation despite a missing target observation`,()=>{
    const full=target('incomplete');full.checks.push({id:'binding-changed',kind:'binding',status,reason:'目标修订或输入绑定已变化',evidence:[]});
    const context=collectionTargetRepairContext(full)!;assert.equal(context.state,'incomplete');assert.equal(context.unresolved,2);assert.equal(context.targetRepairAllowed,false);assert.equal(context.confirmedTargetFailureCount,1);assert.equal(context.verificationGapCount,1);assert.equal(context.verificationGaps[0].kind,'binding');assert.equal(context.defectGroups[0].pages,1);
  });
}

test('a pending or unverified gate cannot authorize target repair from an inconsistent missing observation',()=>{
  for(const state of ['pending','unverified'] as const){const full=target(state);full.checks[0].status='missing';const context=collectionTargetRepairContext(full)!;assert.equal(context.state,state);assert.equal(context.targetRepairAllowed,false);assert.equal(context.confirmedTargetFailureCount,1);}
  assert.equal(collectionTargetRepairContext(undefined),undefined);
});

test('scoring checkpoint is immutable and rejects stale snapshot before further model or target access',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'collection-report-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory);
  try{const resource=store.saveResource({name:'Source',scenario:'migration',contentUrl:'https://source.invalid/',referenceUrl:'',description:'',files:[],externalSource:'',externalId:''});const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:'',requirements:''},defaultAutomationSettings)[0];task.collectionVersionId='snapshot';task.siteRevision='revision';task.requirementsId='manifest';task.rule={hash:'rule'} as any;const value=report();assert.equal(checkpointCollectionReport(task,value,store),true);value.summary='mutated';assert.equal(task.collectionPendingReport?.report.summary,'Independent review');task.collectionVersionId='other';await assert.rejects(finishPendingCollectionReport(task,store,vault,directory,AbortSignal.timeout(1000)),/不一致/);assert.ok(task.collectionPendingReport);assert.equal(task.report,null);}
  finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
