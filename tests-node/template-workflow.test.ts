import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings, type AutomationTask, type MaterialFile } from '../shared/automation.js';
import type { TemplateLayoutSnapshot, TemplateView, TemplateViewport } from '../shared/template-workflow.js';
import { TemplateWorkflowStore, readTemplateEvidence, templateHash } from '../server/automation/template-workflow-store.js';
import { ensureTemplateAnalysis } from '../server/automation/template-analysis.js';
import { executeTemplateWorkflowEvaluation } from '../server/automation/template-workflow-evaluation.js';
import { runTemplateScript } from '../server/automation/template-checks.js';
import { planTemplateRegions } from '../server/automation/template-layout.js';
import { captureWorkflowScope } from '../server/automation/template-workflow-capture.js';
import type { evaluationBrowser } from '../server/automation/browser.js';
import type { localDecision } from '../server/automation/local-decision.js';
import { siteTemplateReferenceStudy, templateGenerationSources } from '../server/automation/generation-reference.js';
import { targetReached, advanceOptimization } from '../server/automation/optimization.js';
import { queueReflection, selectExperience } from '../server/automation/experience.js';
import { createApp } from '../server/app.js';
import { appendDesignerChecks, designerTemplateChecks } from '../shared/template-design.js';

const openInspection=(async()=>({readImplementation:async()=>{throw new Error('No backend evidence requested in this fixture');},close:async()=>{},programIndex:async()=>[],env:{INSPECTION_URL:'',INSPECTION_TOKEN:''}})) as typeof import('../server/automation/inspection-tools.js').inspectionTools;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function layout(url='https://source.test/',viewport:TemplateViewport='desktop'):TemplateLayoutSnapshot {return {url,viewport,width:viewport==='mobile'?390:1440,height:1000,elements:[{selector:'#hero',tag:'section',text:'Hello',rect:{x:24,y:0,width:300,height:1000},visible:true,lines:1,display:'block',position:'static',overflowX:'visible',paddingLeft:24,paddingRight:24,parentSelector:'body',signature:'static-hero'}],links:[],truncated:false,dependencyHash:'resources-v1',dependencyGaps:[]};}
function fixture(){const directory=mkdtempSync(resolve(tmpdir(),'workflow-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(directory),registry=new TemplateWorkflowStore(store),resource=store.saveResource({name:'Template',scenario:'site-template',description:'',contentUrl:'',referenceUrl:'https://source.test/',files:[],externalId:'',externalSource:''}),task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];registry.initialize(task);return {directory,db,store,vault,registry,resource,task,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
type Fixture=ReturnType<typeof fixture>;

test('adding designer groups preserves customized checks and does not duplicate existing groups',()=>{
  const custom={...structuredClone(designerTemplateChecks[0]),enabled:false,instruction:'Custom rule'};
  const merged=appendDesignerChecks([custom]);
  assert.equal(merged.length,designerTemplateChecks.length);
  assert.deepEqual(merged[0],custom);
  assert.deepEqual(appendDesignerChecks(merged),merged);
  merged[1].viewports.push('desktop');
  assert.equal(designerTemplateChecks[1].viewports.length,2,'draft edits cannot mutate the source definitions');
});
function fakeBrowser(f:Fixture,owner:AutomationTask,calls:{role:string;action:string;viewport:string}[],change?:(value:TemplateLayoutSnapshot)=>TemplateLayoutSnapshot,script?:(input:any)=>{position?:Record<string,unknown>;settled?:boolean;readiness?:Record<string,unknown>;receipt?:Record<string,unknown>}):typeof evaluationBrowser{return async(_urls,work,_signal,initial=[],checkpoint=()=>{},binding)=>{const artifacts=structuredClone(initial);return {artifacts,env:{EVALUATION_BROWSER_URL:'',EVALUATION_BROWSER_TOKEN:''},close:async()=>{},capture:async(raw:unknown)=>{const input=raw as {role:string;action:string;url:string;viewport:TemplateViewport;scope?:string;selectors?:string[]};calls.push(input);const measured=change?change(layout(input.url,input.viewport)):layout(input.url,input.viewport);if(input.action==='inspect_layout')return measured;
    const behavior=script?.(input)||{},name=randomUUID()+'.png',position={url:input.url,scrollX:0,scrollY:0,documentHeight:1000,viewportWidth:measured.width,viewportHeight:1000,matches:1,invalidSelector:false,visible:true,nestedScroll:false,horizontalOverflow:false,regionTop:0,regionBottom:1000,...behavior.position},observation={file:name,url:input.url,role:input.role,viewport:input.viewport,action:input.action,position,settlement:{settled:behavior.settled??true},...(behavior.readiness?{readiness:behavior.readiness}:{}),capture:{scope:input.scope||'page',...(input.scope==='regions'?{selectorIndex:(raw as any).startSelectorIndex||0}:{})},binding};
    // Real PNG signature is sufficient here; no image interpretation is simulated.
    for(const [filename,bytes,type] of [[name,Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex'),'image/png'],[name.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){mkdirSync(resolve(work,'evidence'),{recursive:true});writeFileSync(resolve(work,'evidence',filename),bytes);artifacts.push({id:randomUUID(),name:filename,type,size:bytes.length,sha256:hash(bytes),role:input.role as MaterialFile['role'],viewport:input.viewport,settled:behavior.settled??true});}checkpoint(artifacts);return {action:'take_page_screenshots',status:'complete',coverageComplete:true,screenshots:[observation],gaps:[],nextStartY:null,nextSelectorIndex:null,...behavior.receipt};}} as Awaited<ReturnType<typeof evaluationBrowser>>;};}
function analysisPayload(context:any){const captures=context.captures as {scope:{viewport:TemplateViewport};files:{name:string;type:string}[]}[];return {pages:[{path:'/',title:'Home',views:[{id:'hero',title:'Hero',role:'hero',required:true,layouts:captures.map(capture=>({viewport:capture.scope.viewport,selector:'#hero',evidence:capture.files.map(file=>file.name),intent:'Single hero',exceptions:'',constraints:[]}))}]}],contentMapping:'Template copy',manifest:{sourceComplete:true,limitations:[],items:[{id:'home',title:'Home',kind:'page',required:true,source:'https://source.test/',expectation:'Hero on both viewports',paths:['/'],expectedCount:1,viewports:['desktop','mobile']}],evidence:context.evidence.map((file:any)=>file.name)}};}
async function analyze(f:Fixture,calls:{role:string;action:string;viewport:string}[]=[]){let decisions=0;const decide=(async(options:any)=>{decisions++;return options.submit(analysisPayload(options.context));}) as typeof localDecision;await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:fakeBrowser(f,f.task,calls),decide});return decisions;}
function evaluateTask(f:Fixture,parent=f.task){const site=parent.generatedSiteId?f.store.site(parent.generatedSiteId)!:{id:randomUUID(),resourceId:f.resource.id,versionId:f.task.versionId,environmentId:f.task.environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:Date.now()};f.store.saveSite(site);parent.generatedSiteId=site.id;parent.siteUrl=site.url;f.store.beginSiteChange(parent);f.store.put(parent);return f.store.ensureEvaluation(parent,defaultAutomationSettings);}
function evaluationPayload(options:any,task:AutomationTask,fail=false){const {baseline,checklist,evidence,rule,manifest}=options.context;return {views:baseline.pages.flatMap((page:any)=>page.views.flatMap((view:any)=>(['desktop','mobile'] as const).map(viewport=>({pagePath:page.path,viewId:view.id,viewport,selector:fail?null:'#hero',presence:fail?'missing':'present',anchors:{},checks:checklist.checks.filter((check:any)=>check.enabled&&check.scopes.includes(task.scope)&&check.viewports.includes(viewport)).map((check:any)=>({checkId:check.id,status:check.kind==='presence'||check.kind==='order'||check.kind==='visual'?'passed':'not-applicable',score:100,expected:'Reference layout',actual:'Same layout',reason:'No interactive state/constraint for this static view',evidence:evidence.filter((file:any)=>file.type==='image/png'&&file.viewport===viewport).map((file:any)=>file.name)}))})))),review:{summary:'Independent review',assessments:rule.criteria.filter((criterion:any)=>criterion.scopes.includes(task.scope)).flatMap((criterion:any)=>criterion.viewports.map((viewport:string)=>({criterionId:criterion.id,viewport,score:100,passed:true,reason:'Verified',evidence:evidence.filter((file:any)=>file.type==='image/png'&&(viewport==='business'||file.viewport===viewport)).map((file:any)=>file.name)}))),issues:[],coverage:{verified:['Home'],unverified:[],outOfScope:[]},completeness:manifest.items.map((item:any)=>({id:item.id,status:'verified',reason:'Reviewed both viewports',evidence:evidence.filter((file:any)=>file.type==='image/png').map((file:any)=>file.name),checkedViewports:item.viewports,actualCount:1,sampledPaths:['/'],checkedKeys:[]}))}};}

test('checklists freeze at task creation; legacy tasks stay unsupported; baseline overwrite rejected',async()=>{const f=fixture();try{const old=f.task.templateWorkflow!.checklistId,latest=f.registry.publish({name:'Updated checks',checks:f.registry.current().checks});assert.notEqual(old,latest.id);assert.equal(f.registry.response(f.task).checklist?.id,old);const legacy=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'homepage',environmentId:f.task.environmentId,requirements:''},defaultAutomationSettings)[0];assert.equal(f.registry.response(legacy).supported,false);await analyze(f);const record=f.registry.get(f.task)!;record.baseline!.pages[0].views=[];assert.throws(()=>f.registry.put(record),/不可覆盖/);}finally{f.close();}});

test('source analysis captures dual viewport once and survives repeated calls; generator uses local baseline',async()=>{const f=fixture();try{const calls:any[]=[];assert.equal(await analyze(f,calls),1);const count=calls.length;await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:async()=>{throw new Error('must not open reference again');},decide:async()=>{throw new Error('must not reanalyze');}});assert.equal(calls.length,count);assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,2);assert.ok(f.task.requirementsId);assert.match(siteTemplateReferenceStudy(f.task,f.store,'target')!,/不得再采集参考站/);const image=f.registry.get(f.task)!.sourceEvidence.find(file=>file.type==='image/png')!;assert.ok(readTemplateEvidence(f.directory,image));writeFileSync(resolve(f.directory,'automation-runs',image.ownerTaskId,'evidence',image.name),'tampered');assert.throws(()=>readTemplateEvidence(f.directory,image),/已变化/);}finally{f.close();}});

test('frozen source handoff retains registered provenance and settlement without sending layout dumps',async()=>{
  const f=fixture();try{
    await analyze(f);
    const source=templateGenerationSources(f.task,f.store,f.directory);
    assert.ok(source.entries.length>0);assert.deepEqual(source.unavailable,[]);
    for(const entry of source.entries){
      const registered=f.registry.get(f.task)!.baseline!.evidence.find(file=>file.name===entry.name)!;
      assert.equal(entry.taskId,registered.ownerTaskId);assert.equal(entry.sha256,registered.sha256);
      const original=JSON.parse(readTemplateEvidence(f.directory,registered).toString()),value=entry.value as any;
      assert.notEqual(value.kind,'template-layout');
      if(original.file){assert.equal(value.url,original.url);assert.deepEqual(value.settlement,original.settlement);assert.equal(value.textTruncated,original.textTruncated);assert.equal(value.framesComplete,original.framesComplete);}
      else assert.deepEqual(value,original);
    }
  }finally{f.close();}
});

test('validated source capture is reused after interrupted AI analysis, without another screenshot',async()=>{const f=fixture();try{const calls:any[]=[],openBrowser=fakeBrowser(f,f.task,calls);await assert.rejects(()=>ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser,decide:async()=>{throw new Error('model connection stopped');}}),/connection/);const count=calls.length;await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser,decide:(async(options:any)=>options.submit(analysisPayload(options.context))) as typeof localDecision});assert.equal(calls.length,count);}finally{f.close();}});

test('source gaps remain a resumable analysis draft and cannot become a frozen generation baseline',async()=>{const f=fixture();try{const calls:any[]=[],openBrowser=fakeBrowser(f,f.task,calls);
  const result=await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser,decide:(async(options:any)=>{const payload=analysisPayload(options.context);payload.manifest.sourceComplete=false;payload.manifest.limitations=['Content mapping needs confirmation'] as any;return options.submit(payload);}) as typeof localDecision});
  assert.equal(result?.complete,false);assert.equal(f.registry.get(f.task)?.baseline,null);assert.equal(f.task.requirementsId,undefined);assert.equal(f.task.generatedSiteId,null);assert.deepEqual(f.registry.get(f.task)?.limitations,['Content mapping needs confirmation']);
  const count=calls.length;await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser,decide:(async(options:any)=>{assert.ok(options.context.analysisDraft);return options.submit(analysisPayload(options.context));}) as typeof localDecision});assert.equal(calls.length,count);assert.equal(f.registry.get(f.task)?.baseline?.complete,true);
}finally{f.close();}});

test('one review shares captures across all checks and business criteria; first pass ends without another audit',async()=>{const f=fixture();try{await analyze(f);const task=evaluateTask(f),calls:any[]=[];let reviews=0;await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,task,calls),decide:(async(options:any)=>{reviews++;return options.submit(evaluationPayload(options,task));}) as typeof localDecision});assert.equal(reviews,1);assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,2);assert.equal(calls.some(call=>call.role==='reference'),false);const evaluation=f.registry.evaluation(task.id)!;assert.equal(evaluation.checks.length,f.registry.checklist(f.task.templateWorkflow!.checklistId)!.checks.filter(check=>check.enabled).length*2);assert.equal(evaluation.quality,'passed');assert.equal(evaluation.complete,true);assert.equal(task.report?.quality,'passed');assert.ok(task.report?.completeness);assert.equal(task.report?.review,undefined);assert.equal(queueReflection(task,f.store),undefined,'passing reviews do not enqueue learning');await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:async()=>{throw new Error('completed report cannot re-run');}});}finally{f.close();}});

test('missing required view overrides an AI pass, creates stable issue; done requires a fresh independent pass',async()=>{const f=fixture();try{await analyze(f);const first=evaluateTask(f);await executeTemplateWorkflowEvaluation(first,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,first,[]),decide:(async(options:any)=>options.submit(evaluationPayload(options,first,true))) as typeof localDecision});const old=f.registry.evaluation(first.id)!;assert.equal(old.quality,'failed');assert.equal(old.issues.filter(issue=>issue.status==='open').length,2);first.status='completed';f.store.put(first);const repair=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:f.task.generatedSiteId!,parentId:first.id,versionId:f.task.versionId,requirements:'repair'},defaultAutomationSettings)[0];repair.createdAt=Date.now()+1;repair.repairEvidence={reportId:first.id,files:[]};f.store.put(repair);const second=evaluateTask(f,repair);second.createdAt=Date.now()+2;f.store.put(second);const calls:any[]=[];await executeTemplateWorkflowEvaluation(second,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,second,calls),decide:(async(options:any)=>options.submit(evaluationPayload(options,second))) as typeof localDecision});const current=f.registry.evaluation(second.id)!;assert.equal(current.issues.filter(issue=>issue.status==='done').length,2);assert.deepEqual(current.issues.map(issue=>issue.id).sort(),old.issues.map(issue=>issue.id).sort());assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,2);assert.equal(current.checks.filter(check=>check.checkId==='view-presence').every(check=>check.provenance==='measured'),true);}finally{f.close();}});

test('unchanged current dependencies permit static inheritance while retaining old evidence ownership',async()=>{const f=fixture();try{await analyze(f);const first=evaluateTask(f);await executeTemplateWorkflowEvaluation(first,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,first,[]),decide:(async(options:any)=>options.submit(evaluationPayload(options,first))) as typeof localDecision});const repair=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:f.task.generatedSiteId!,parentId:first.id,versionId:f.task.versionId,requirements:'unchanged'},defaultAutomationSettings)[0];repair.createdAt=Date.now()+1;const second=evaluateTask(f,repair);second.createdAt=Date.now()+2;const calls:any[]=[];await executeTemplateWorkflowEvaluation(second,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,second,calls),decide:(async(options:any)=>options.submit(evaluationPayload(options,second))) as typeof localDecision});const current=f.registry.evaluation(second.id)!;assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,0);assert.ok(current.checks.some(check=>check.provenance==='inherited'&&check.sourceTaskId===first.id));assert.ok(current.evidence.some(file=>file.role==='target'&&file.ownerTaskId===first.id&&file.siteRevision===first.siteRevision));assert.ok(current.captures.every(capture=>capture.mode==='inherited'));}finally{f.close();}});

test('region plan includes changed and neighboring views; global, unknown and incomplete mappings expand',()=>{const old=layout(),views:TemplateView[]=Array.from({length:6},(_,index)=>({id:'v'+index,title:'View',role:'section',required:true,layouts:[]})),mapping=Object.fromEntries(views.map(view=>[view.id,'#'+view.id]));old.elements=views.map((view,index)=>({...old.elements[0],selector:'#'+view.id,rect:{x:24,y:index*100,width:300,height:100},signature:view.id}));const current=structuredClone(old);current.elements[2].signature='changed';const plan=planTemplateRegions(views,'desktop',current,old,mapping);assert.equal(plan.mode,'regions');assert.deepEqual(plan.selectors,['#v1','#v2','#v3']);assert.deepEqual(plan.inherited,['v0','v4','v5']);assert.equal(planTemplateRegions(views,'desktop',{...current,dependencyHash:'global-changed'},old,mapping).mode,'page');assert.equal(planTemplateRegions(views,'desktop',{...current,dependencyHash:null},old,mapping).mode,'page');assert.equal(planTemplateRegions(views,'desktop',current,old,{}).mode,'page');});

test('runtime recaptures only changed region and neighbors while independently aggregating all views',async()=>{const f=fixture();try{
  const many=(value:TemplateLayoutSnapshot,changed=false)=>({...value,elements:Array.from({length:6},(_,index)=>({...value.elements[0],selector:'#v'+index,rect:{x:24,y:index*100,width:300,height:100},signature:changed&&index===2?'changed':'v'+index}))});
  await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:fakeBrowser(f,f.task,[],value=>many(value)),decide:(async(options:any)=>{const payload=analysisPayload(options.context),hero=payload.pages[0].views[0];payload.pages[0].views=Array.from({length:6},(_,index)=>({...hero,id:'v'+index,layouts:hero.layouts.map(item=>({...item,selector:'#v'+index}))}));return options.submit(payload);}) as typeof localDecision});
  const review=(options:any,task:AutomationTask)=>{const payload=evaluationPayload(options,task);for(const row of payload.views)row.selector='#'+row.viewId;return options.submit(payload);};
  const first=evaluateTask(f);await executeTemplateWorkflowEvaluation(first,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,first,[],value=>many(value)),decide:(async(options:any)=>review(options,first)) as typeof localDecision});
  const repair=f.store.create({resourceIds:[f.resource.id],kind:'generation',scope:'site',environmentId:f.task.environmentId,generatedSiteId:f.task.generatedSiteId!,parentId:first.id,versionId:f.task.versionId,requirements:'local change'},defaultAutomationSettings)[0];const second=evaluateTask(f,repair);second.createdAt=Date.now()+1;const calls:any[]=[];
  await executeTemplateWorkflowEvaluation(second,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,second,calls,value=>many(value,true)),decide:(async(options:any)=>review(options,second)) as typeof localDecision});
  const shots=calls.filter(call=>call.action==='take_page_screenshots');assert.equal(shots.length,2);assert.ok(shots.every(call=>call.scope==='regions'));assert.ok(shots.every(call=>JSON.stringify(call.selectors)===JSON.stringify(['#v1','#v2','#v3'])));const result=f.registry.evaluation(second.id)!;assert.equal(result.quality,'passed');assert.equal(result.checks.length,f.registry.checklist(f.task.templateWorkflow!.checklistId)!.checks.filter(check=>check.enabled).length*12);assert.ok(result.checks.some(check=>check.viewId==='v0'&&check.provenance==='inherited'));assert.ok(result.captures.some(capture=>capture.mode==='inherited'));
}finally{f.close();}});

test('script checks find desktop row/column drift and mobile gutter; changed copy does not produce a false CSS verdict',()=>{const f=fixture();try{const source=layout(),target=layout(),a={...source.elements[0],selector:'#title',text:'Title',rect:{x:24,y:0,width:100,height:30}},b={...a,selector:'#filter',rect:{x:300,y:0,width:100,height:30}};source.elements=[a,b];target.elements=[a,{...b,rect:{...b.rect,x:24,y:100}}];const relation=f.registry.current().checks.find(check=>check.kind==='relation')!,constraint={id:'row',checkId:relation.id,expected:'left/right',anchors:['#title','#filter'],relation:'left-of' as const};assert.equal(runTemplateScript(relation,[constraint],source,target,{'#title':'#title','#filter':'#filter'})?.passed,false);const gutter=f.registry.current().checks.find(check=>check.kind==='gutter')!;target.elements=[{...a,rect:{...a.rect,x:0}}];assert.equal(runTemplateScript(gutter,[{id:'g',checkId:gutter.id,expected:'24px',anchors:['#title']}],source,target,{'#title':'#title'})?.passed,false);const lines=f.registry.current().checks.find(check=>check.kind==='line-count')!;target.elements=[{...a,text:'Longer replacement copy',lines:2}];assert.equal(runTemplateScript(lines,[{id:'l',checkId:lines.id,expected:'one line',anchors:['#title'],preserveLines:true}],source,target,{'#title':'#title'}),undefined);}finally{f.close();}});

test('view drafts survive a disconnected reviewer and still require complete independent final validation',async()=>{const f=fixture();try{await analyze(f);const task=evaluateTask(f),calls:any[]=[];
  await assert.rejects(()=>executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,task,calls),decide:(async(options:any)=>{const payload=evaluationPayload(options,task);await options.read({kind:'checkpoint',input:{views:payload.views}});throw new Error('connection stopped after drafts');}) as typeof localDecision}),/connection stopped/);
  assert.equal(f.registry.evaluation(task.id),undefined);const before=calls.filter(call=>call.action==='take_page_screenshots').length;
  await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,task,calls),decide:(async(options:any)=>{assert.equal(options.context.draftViews.length,2);const payload=evaluationPayload(options,task);return options.submit({...payload,views:[]});}) as typeof localDecision});
  assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,before);assert.equal(f.registry.evaluation(task.id)?.quality,'passed');
}finally{f.close();}});

test('a static screenshot cannot certify a current interaction and foreign evidence cannot be borrowed',async()=>{const f=fixture();try{await analyze(f);const task=evaluateTask(f);
  await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,task,[]),decide:(async(options:any)=>{const payload=evaluationPayload(options,task);for(const row of payload.views){const check=row.checks.find((check:any)=>check.checkId==='interaction-review')!;check.status='passed';}assert.throws(()=>options.submit({...payload,views:payload.views.map((row:any)=>({...row,checks:row.checks.map((check:any)=>({...check,evidence:[randomUUID()+'.png']}))}))}),/不存在|其他流程/);return options.submit(payload);}) as typeof localDecision});
  assert.equal(f.registry.evaluation(task.id)?.quality,'unverified');assert.equal(f.registry.evaluation(task.id)?.checks.filter(check=>check.checkId==='interaction-review').every(check=>check.status==='unverified'),true);
}finally{f.close();}});

test('new unresolved checklist result cannot be accepted by legacy optimization scores',()=>{const f=fixture();try{const task={...f.task,optimization:{policy:{targetScore:85}}} as AutomationTask,report={quality:'unverified' as const,summary:'missing proof',scores:[{viewport:'desktop',value:100},{viewport:'mobile',value:100}],assessments:f.task.rule!.criteria.flatMap(criterion=>criterion.viewports.map(viewport=>({criterionId:criterion.id,viewport,score:100,passed:true}))),issues:[],completeness:{state:'complete' as const,sourceComplete:true}};assert.equal(targetReached(task,report),false);}finally{f.close();}});

for(const failed of [false,true])test(`optimization ${failed?'directly batches confirmed defects into repair':'finishes the first independent pass without a fixed audit'}`,async()=>{const f=fixture();try{
  await analyze(f);const task=evaluateTask(f),calls:any[]=[];
  await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{openInspection,openBrowser:fakeBrowser(f,task,calls),decide:(async(options:any)=>options.submit(evaluationPayload(options,task,failed))) as typeof localDecision});
  f.task.generation={prepared:true,conversationId:randomUUID(),deliveryState:'completed'};f.task.status='completed';f.task.stopped=true;
  task.status='completed';task.stopped=true;f.store.put(task);
  f.task.optimization={policy:defaultAutomationSettings.optimization!,state:'waiting-evaluation',rounds:[{number:0,revision:task.siteRevision!,generationTaskId:f.task.id,evaluationTaskId:task.id,startedAt:1}],activeTaskId:task.id,currentRevision:task.siteRevision!,reportId:null,noImprovement:0,reason:'',nextSteps:[],recoveryPolicy:defaultAutomationSettings.followup,threshold:85};f.store.put(f.task);
  const before=f.store.tasks().length;advanceOptimization(f.task,f.store,defaultAutomationSettings);
  if(failed){assert.equal(f.task.optimization.state,'repairing');const child=f.store.task(f.task.optimization.activeTaskId)!;assert.equal(child.kind,'generation');assert.equal(child.templateWorkflow?.rootTaskId,f.task.id);assert.equal(child.repairEvidence?.reportId,task.id);assert.match(child.message,/view|hero/);assert.equal(child.generation?.conversationId,f.task.generation.conversationId);assert.equal(f.task.followup,undefined,'no separate planner model is scheduled');}
  else {assert.equal(f.task.optimization.state,'completed');assert.equal(f.store.tasks().length,before,'no full-audit task is created');}
}finally{f.close();}});

test('API accepts reference-only input, publishes immutable checks and keeps legacy workflows unsupported',async()=>{const directory=mkdtempSync(resolve(tmpdir(),'workflow-api-')),f=await createApp({directory,serveWeb:false,startWorker:false});try{const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};const result=await f.app.inject({method:'POST',url:'/api/automation/resources',headers,payload:{name:'Template',scenario:'site-template',description:'',contentUrl:'',referenceUrl:'https://source.test/',externalSource:'',externalId:'',files:[]}});assert.equal(result.statusCode,201,result.body);const checks=await f.app.inject({url:'/api/automation/template-checklists',headers});assert.equal(checks.statusCode,200);const checklist=checks.json().items[0],published=await f.app.inject({method:'POST',url:'/api/automation/template-checklists',headers,payload:{name:'new',checks:checklist.checks}});assert.equal(published.statusCode,201,published.body);assert.equal(published.json().revision,2);const task=f.automationStore.create({resourceIds:[result.json().id],kind:'generation',scope:'homepage',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];const response=await f.app.inject({url:`/api/automation/tasks/${task.id}/template-workflow`,headers});assert.equal(response.json().supported,false);const unknown=await f.app.inject({url:`/api/automation/tasks/${task.id}/template-workflow/artifacts/${randomUUID()}.png`,headers});assert.equal(unknown.statusCode,404);}finally{await f.app.close();rmSync(directory,{recursive:true,force:true});}});

test('partial capture keeps the stable prefix across restarts and repairs only the unsettled position',async()=>{
  const f=fixture();try{
    const calls:any[]=[],attempts=new Map<number,number>();
    const open=fakeBrowser(f,f.task,calls,undefined,input=>{
      const y=input.startY||0,attempt=(attempts.get(y)||0)+1;attempts.set(y,attempt);
      const settled=y!==850||attempt>1,done=y>=3000;
      return {position:{scrollY:y,documentHeight:4000},settled,receipt:{coverageComplete:done&&settled,gaps:settled?[]:['Screenshot 1 did not settle: stableForMs=0.'],nextStartY:done?null:Math.min(3000,y+850),nextSelectorIndex:null}};
    });
    const work=resolve(f.directory,'automation-runs',f.task.id);mkdirSync(resolve(work,'evidence'),{recursive:true});
    const run=async()=>{const browser=await open({target:'',reference:'https://source.test/',content:''},work,new AbortController().signal,f.task.artifacts||[],files=>{f.task.artifacts=files;},{taskId:f.task.id,inputVersionId:f.task.versionId,siteRevision:''});return captureWorkflowScope({task:f.task,registry:f.registry,directory:f.directory,browser,role:'reference',url:'https://source.test/',viewport:'desktop',signal:new AbortController().signal});};
    const first=await run();assert.equal(first.scope.complete,false);
    const stablePrefix=first.files.find(file=>file.type==='image/png'&&file.settled)!;
    assert.deepEqual(calls.filter(call=>call.action==='take_page_screenshots').map((call:any)=>call.startY),[0,850,1700,2550]);
    const second=await run();assert.equal(second.scope.complete,true);
    assert.deepEqual(calls.filter(call=>call.action==='take_page_screenshots').map((call:any)=>call.startY),[0,850,1700,2550,3000,850]);
    assert.ok(second.files.some(file=>file.name===stablePrefix.name));
    assert.equal(second.files.filter(file=>file.type==='image/png').length,5);
    assert.ok(second.files.filter(file=>file.type==='image/png').every(file=>file.settled));
    const before=calls.length;await run();assert.equal(calls.length,before,'complete receipt does not re-open the reference page');
  }finally{f.close();}
});

test('persistent unsettled source evidence blocks model analysis and keeps its reusable frames',async()=>{
  const f=fixture();try{
    const calls:any[]=[],open=fakeBrowser(f,f.task,calls,undefined,()=>({settled:false,receipt:{coverageComplete:false,gaps:['Screenshot 1 did not settle: stableForMs=0.']}}));
    let decisions=0;const decide=(async()=>{decisions++;throw new Error('must not spend model tokens on incomplete capture');}) as typeof localDecision;
    const first=await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:open,decide});
    assert.equal(first?.complete,false);assert.equal(decisions,0);assert.equal(f.registry.get(f.task)?.baseline,null);assert.equal(f.task.generatedSiteId,null);
    assert.equal(calls.filter(call=>call.action==='inspect_layout').length,2);
    await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:open,decide});
    assert.equal(decisions,0);assert.equal(calls.filter(call=>call.action==='inspect_layout').length,2,'restart reuses saved layout while recapturing unsettled frames');
  }finally{f.close();}
});

test('source view checkpoints survive interruption and final submission revalidates their scope and evidence',async()=>{
  const f=fixture();try{
    const calls:any[]=[],open=fakeBrowser(f,f.task,calls);
    await assert.rejects(()=>ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:open,decide:(async(options:any)=>{
      assert.equal(options.context.submissionSchema,undefined);assert.equal(options.context.captures[0].layout.elements,undefined);
      assert.ok(options.context.readProtocol.layout);assert.ok(options.context.captures[0].frames[0].height);assert.ok(await options.read({kind:'schema',part:'checkpoint'}));
      const payload=analysisPayload(options.context),page=payload.pages[0],checkpoint={kind:'checkpoint',page:{path:'/',title:'Home'},views:page.views};
      await assert.rejects(()=>options.read({...checkpoint,page:{path:'https://other.test/',title:'Bad'}}),/越界/);
      await assert.rejects(()=>options.read({...checkpoint,views:page.views.map(view=>({...view,layouts:view.layouts.map(item=>({...item,evidence:[randomUUID()+'.png']}))}))}),/PNG/);
      await options.read(checkpoint);assert.equal(f.registry.get(f.task)?.baseline,null,'draft cannot freeze the reference');
      throw new Error('connection interrupted after checkpoint');
    }) as typeof localDecision}),/connection interrupted/);
    const before=calls.length;
    await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{openBrowser:open,decide:(async(options:any)=>{
      assert.equal(options.context.draftPages[0].views.length,1);
      const payload=analysisPayload(options.context);
      return options.submit({...payload,pages:[]});
    }) as typeof localDecision});
    assert.equal(calls.length,before);assert.equal(f.registry.get(f.task)?.baseline?.pages[0].views[0].id,'hero');
  }finally{f.close();}
});

test('incomplete target state resumes its capture instead of being cached as final evidence',async()=>{
  const f=fixture();try{
    await analyze(f);const task=evaluateTask(f),firstCalls:any[]=[];
    await assert.rejects(()=>executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{
      openInspection,openBrowser:fakeBrowser(f,task,firstCalls,undefined,()=>({settled:false,receipt:{coverageComplete:false,gaps:['Screenshot 1 did not settle: stableForMs=0.']}})),
      decide:(async()=>{throw new Error('interrupted before review');}) as typeof localDecision
    }),/interrupted before review/);
    const calls:any[]=[];await executeTemplateWorkflowEvaluation(task,f.store,f.vault,f.directory,new AbortController().signal,{
      openInspection,openBrowser:fakeBrowser(f,task,calls),decide:(async(options:any)=>{
        assert.equal(options.context.submissionSchema,undefined);
        assert.equal(options.context.baseline.evidence,undefined);
        assert.ok(options.context.evidence.every((file:any)=>file.sha256===undefined));
        assert.ok(options.context.evidence.filter((file:any)=>file.type==='image/png').every((file:any)=>file.settled===true),'superseded unsettled frames remain archived but cannot be cited as current evidence');
        const schema=await options.read({kind:'schema',input:{part:'checkpoint'}});assert.ok(schema.properties.views);
        const payload=evaluationPayload(options,task),stale=task.artifacts!.find(file=>file.type==='image/png'&&file.settled===false)!;
        assert.ok(stale);const invalid=structuredClone(payload);invalid.review.assessments[0].evidence=[stale.name];
        assert.throws(()=>options.submit(invalid),'business review cannot cite archived unstable captures either');
        return options.submit(payload);
      }) as typeof localDecision
    });
    assert.equal(calls.filter(call=>call.action==='take_page_screenshots').length,2);
    assert.ok(calls.filter(call=>call.action==='take_page_screenshots').every((call:any)=>call.maxScreenshots===1));
    assert.equal(f.registry.evaluation(task.id)?.quality,'passed');
  }finally{f.close();}
});

test('external capture completes after 10s readiness retry while target stays strict, and analysis exposes internalLinks',async()=>{
  const f=fixture();
  try{
    const readiness={stableForMs:600,pendingImages:0,brokenImages:0,runningAnimations:0,fontsReady:true};
    const work=resolve(f.directory,'automation-runs',f.task.id);
    mkdirSync(resolve(work,'evidence'),{recursive:true});
    const extCalls:any[]=[];
    const extBrowser=await fakeBrowser(
      f,
      f.task,
      extCalls,
      snapshot=>({...snapshot,links:['https://source.test/about','https://source.test/pricing']}),
      ()=>({settled:false,readiness})
    )({target:'',reference:'https://source.test/',content:''},work,new AbortController().signal,[],files=>{f.task.artifacts=files;},{taskId:f.task.id,inputVersionId:f.task.versionId,siteRevision:''});
    const extScope=await captureWorkflowScope({
      task:f.task,
      registry:f.registry,
      directory:f.directory,
      browser:extBrowser,
      role:'reference',
      url:'https://source.test/',
      viewport:'desktop',
      signal:new AbortController().signal
    });
    assert.equal(extScope.scope.complete,true);
    assert.equal(extCalls.filter(call=>call.action==='take_page_screenshots').length,2);

    const targetCalls:any[]=[];
    f.store.beginSiteChange(f.task);
    const targetBrowser=await fakeBrowser(
      f,
      f.task,
      targetCalls,
      undefined,
      ()=>({settled:false,readiness})
    )({target:'https://target.test/',reference:'',content:''},work,new AbortController().signal,f.task.artifacts||[],files=>{f.task.artifacts=files;},{taskId:f.task.id,inputVersionId:f.task.versionId,siteRevision:f.task.siteRevision!});
    const targetScope=await captureWorkflowScope({
      task:f.task,
      registry:f.registry,
      directory:f.directory,
      browser:targetBrowser,
      role:'target',
      url:'https://target.test/',
      viewport:'desktop',
      signal:new AbortController().signal
    });
    assert.equal(targetScope.scope.complete,false);

    let capturedInternalLinks:string[]=[];
    let capturedMinutes=0;
    f.task.completenessPolicy={...defaultAutomationSettings.completeness!,maxMinutes:3};
    await ensureTemplateAnalysis(f.task,f.store,f.vault,f.directory,new AbortController().signal,{
      openBrowser:fakeBrowser(
        f,
        f.task,
        [],
        snapshot=>({...snapshot,links:['https://source.test/about','https://source.test/pricing']})
      ),
      decide:(async(options:any)=>{
        capturedInternalLinks=options.context.captures[0]?.layout?.internalLinks||[];
        capturedMinutes=options.minutes;
        return options.submit(analysisPayload(options.context));
      }) as typeof localDecision
    });
    assert.deepEqual(capturedInternalLinks,['https://source.test/about','https://source.test/pricing']);
    assert.ok(capturedMinutes>=15,'site-scope template analysis guarantees at least 15 minutes');
  }finally{f.close();}
});
