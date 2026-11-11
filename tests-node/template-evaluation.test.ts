import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { Vault } from '../server/lib/vault.js';
import { ManifestStore } from '../server/automation/completeness.js';
import { executeEvaluation, codexClient } from '../server/automation/evaluator.js';
import { evaluationBrowser, evaluationCapturePolicy } from '../server/automation/browser.js';
import type { ScreenshotReceipt } from '../server/automation/page-screenshots.js';
import { defaultAutomationSettings, defaultOptimizationPolicy, type MaterialFile } from '../shared/automation.js';
import { defaultLearningSettings } from '../shared/experience.js';

for(const absoluteSourcePaths of [false,true])test(`template execution (${absoluteSourcePaths?'absolute source URLs':'relative paths'}) performs host captures, independent short reviews, local preflight and full aggregation without a real model or browser`,async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'template-execution-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(resolve(directory,'vault'));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,model:[]}));});
  let opens=0,closes=0,threads=0,captures=0,preflights=0;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,environmentId=randomUUID();
    vault.update({...vault.get(),model:{endpoint:origin+'/v1',name:'test-model',apiKey:'fake-test-key'},environments:[{id:environmentId,name:'Test',origin,apiOrigin:origin,token:'fake-test-token'}]});
    const settings=structuredClone(defaultAutomationSettings);settings.learning={...defaultLearningSettings,use:false,collect:false};vault.updateAutomation({...settings,evaluationEndpoint:origin+'/v1',evaluationModel:'test-model'});
    const resource=store.saveResource({name:'Template',scenario:'site-template',description:'all pages',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalSource:'',externalId:''});
    const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:''},settings)[0];task.kind='evaluation';task.siteRevision='current';task.generatedSiteId=randomUUID();task.status='running';task.stopped=false;task.learningPolicy={...defaultLearningSettings,use:false,collect:false};task.rule={...task.rule!,criteria:[{id:'visual',label:'Visual',weight:100,instruction:'Review actual layout',required:true,viewports:['desktop','mobile'],scopes:['site']}]};
    store.saveSite({id:task.generatedSiteId,resourceId:resource.id,versionId:task.versionId,environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:Date.now()});store.put(task);
    new ManifestStore(store).save(task,{sourceComplete:true,limitations:[],evidence:[],items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'Fixed',expectation:'both paths and viewports',paths:absoluteSourcePaths?['https://source.test/','https://source.test/about?lang=zh']:['/','/about'],expectedCount:2,viewports:['desktop','mobile']}]},'human');
    let activeFiles:MaterialFile[]=[],currentTask=task,changeAbout=false,sourceGap=false;
    const openBrowser:typeof evaluationBrowser=async(_urls,work,_signal,initial,checkpoint,binding)=>{opens++;activeFiles=structuredClone(initial||[]);assert.equal(binding?.viewportEvidence,true);return {artifacts:activeFiles,env:{EVALUATION_BROWSER_URL:'mock',EVALUATION_BROWSER_TOKEN:'mock'},capture:async(raw:unknown)=>{
      captures++;const slot=raw as {action:string;role:'target'|'reference';viewport:'desktop'|'mobile';url:string;fullPage?:boolean};
      assert.equal(slot.action,'take_page_screenshots');assert.notEqual(slot.fullPage,true);
      const screenshots:ScreenshotReceipt[]=[],captureId=randomUUID(),height=slot.viewport==='mobile'?844:1000;
      for(const [index,scrollY] of [0,500].entries()){
        const file=randomUUID()+'.png',bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
        const observation={...slot,file,text:changeAbout&&slot.role==='target'&&slot.viewport==='mobile'&&new URL(slot.url).pathname==='/about'?'Changed about page':'Stable content',position:{url:slot.url,scrollX:0,scrollY,documentHeight:height+500,viewportHeight:height,viewportWidth:slot.viewport==='mobile'?390:1440,matches:0,invalidSelector:false,visible:false,nestedScroll:false,horizontalOverflow:false,regionTop:0,regionBottom:0},capture:{id:captureId,index:index+1,scope:'page' as const,policy:evaluationCapturePolicy},readiness:{settled:true,images:1,pendingImages:0,brokenImages:0,runningAnimations:0,fontsReady:true,stableForMs:500},binding:{...binding,capturePolicy:evaluationCapturePolicy},settlement:{settled:true}};
        for(const [name,data,type] of [[file,bytes,'image/png'],[file.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(work,'evidence',name),data);activeFiles.push({id:randomUUID(),name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),type,role:slot.role,viewport:slot.viewport,settled:true});}
        screenshots.push(observation);checkpoint?.(activeFiles);
      }
      const gap=sourceGap&&slot.role==='reference';
      return {action:'take_page_screenshots',status:gap?'partial':'complete',coverageComplete:!gap,screenshots,gaps:gap?['reference entrance animation did not settle']:[],nextStartY:null,nextSelectorIndex:null};
    },close:async()=>{closes++;}};};
    const createClient=((_vault:Vault,_directory:string,env:Record<string,string>)=>({startThread:()=>{threads++;return {runStreamed:async(prompt:string)=>{const work=resolve(directory,'automation-runs',currentTask.id),context=JSON.parse(readFileSync(resolve(work,'task.json'),'utf8'));const match=/evaluation-result-[a-f0-9-]{36}\.json/.exec(prompt);assert.ok(match);const resultFile=match[0];const raw={summary:context.batchId,assessments:context.task.rule.criteria.flatMap((c:any)=>c.viewports.map((viewport:string)=>({criterionId:c.id,viewport,score:90,passed:true,reason:'Actual pixels in mock review',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.viewport===viewport&&new URL(JSON.parse(readFileSync(resolve(work,'evidence',f.name.replace('.png','.json')),'utf8')).url).pathname==='/').map(f=>f.name)}))),issues:[],...(context.rechecks?{rechecks:context.rechecks.map((t:any)=>({id:t.id,status:'resolved',reason:'Mock current path/viewport checked',evidence:activeFiles.filter(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='mobile').map(f=>f.name)}))}:{}),coverage:{verified:['reviewed'],unverified:[],outOfScope:[]},...(context.manifest?{completeness:context.manifest.items.map((item:any)=>({id:item.id,status:'verified',reason:'All required path/viewports inspected',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.role==='target').map(f=>f.name),checkedViewports:['desktop','mobile'],actualCount:2,sampledPaths:item.paths,checkedKeys:[]}))}:{})};writeFileSync(resolve(work,resultFile),JSON.stringify(raw));
      const response=await fetch(env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({tool:'validate_result',resultFile})});assert.equal(response.status,200,await response.text());preflights++;
      return {events:(async function*(){yield {type:'thread.started',thread_id:randomUUID()};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({resultFile})}};yield {type:'turn.completed',usage:{input_tokens:100,output_tokens:50}};})()};}};},resumeThread:()=>{throw new Error('template batches must use independent short threads');}})) as unknown as typeof codexClient;
    await executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient});assert.equal(opens,1);assert.equal(closes,1);assert.equal(captures,8);assert.equal(threads,3);assert.equal(preflights,3);assert.equal(task.report?.quality,'passed');assert.equal(task.report?.assessments.length,2);assert.equal(task.report?.completeness?.state,'complete');assert.equal(store.evaluations.get(task.id)?.state,'stopped');
    await executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient});assert.equal(captures,8,'same revision reuses registered captures');assert.equal(threads,3,'validated batch checkpoints prevent repeated model calls');
    // A repair with equal current proof needs one targeted issue review, retaining the full report.
    const oldMobile=task.report!.artifacts.find(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='mobile')!;
    task.report!.issues=[{severity:'major',title:'Mobile text',detail:'Check the previous issue',evidence:[oldMobile.name]}];store.put(task);
    const repair=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,generatedSiteId:task.generatedSiteId!,requirements:'fix',parentId:task.id,optimizationRootId:task.id,ruleSnapshot:task.rule!},settings)[0];
    repair.repairEvidence={reportId:task.id,files:[]};store.put(repair);
    const targeted=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:task.generatedSiteId!,requirements:'targeted',parentId:repair.id,optimizationRootId:task.id,ruleSnapshot:task.rule!},settings)[0];targeted.requirementsId=task.requirementsId;targeted.siteRevision='repaired';targeted.status='running';targeted.stopped=false;store.put(targeted);currentTask=targeted;
    const before=threads;
    await executeEvaluation(targeted,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-before,1,'only the original issue needs a model review when all dependencies are equal');assert.equal(targeted.report?.quality,'passed');assert.equal(targeted.report?.assessments.length,2);assert.equal(targeted.report?.completeness?.state,'complete');assert.equal(targeted.report?.review?.baselineTaskId,task.id);assert.equal(targeted.report?.review?.inheritedAssessments.length,2);assert.equal(targeted.report?.rechecks?.[0].status,'resolved');
    const after=threads;
    await executeEvaluation(targeted,store,vault,directory,new AbortController().signal,{openBrowser,createClient});assert.equal(threads,after,'resuming targeted review revalidates and reuses the issue checkpoint');
    // A changed inner path only reopens its own completeness slice and original issue.
    const inner=targeted.report!.artifacts.find(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='mobile'&&new URL(JSON.parse(readFileSync(resolve(directory,'automation-runs',targeted.id,'evidence',f.name.replace('.png','.json')),'utf8')).url).pathname==='/about')!;
    targeted.report!.issues=[{severity:'major',title:'About content',detail:'Verify about page',evidence:[inner.name]}];store.put(targeted);
    const nextRepair=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,generatedSiteId:task.generatedSiteId!,requirements:'fix about',parentId:task.id,optimizationRootId:task.id,ruleSnapshot:task.rule!},settings)[0];nextRepair.repairEvidence={reportId:targeted.id,files:[]};store.put(nextRepair);
    const partial=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:task.generatedSiteId!,requirements:'targeted about',parentId:nextRepair.id,optimizationRootId:task.id,ruleSnapshot:task.rule!},settings)[0];partial.requirementsId=task.requirementsId;partial.siteRevision='about-fixed';partial.status='running';partial.stopped=false;store.put(partial);currentTask=partial;changeAbout=true;
    const partialStart=threads;
    await executeEvaluation(partial,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-partialStart,2,'only changed page completeness and its old issue are reviewed');assert.equal(partial.report?.quality,'passed');assert.equal(partial.report?.completeness?.state,'complete');assert.equal(partial.report?.assessments.length,2);assert.deepEqual(partial.report?.review?.inheritedPagePaths?.[0].paths,[absoluteSourcePaths?'https://source.test/':'/']);assert.equal(partial.report?.review?.inheritedAssessments.length,2);
    currentTask=task;
    task.siteRevision='reference-unverified';store.put(task);sourceGap=true;
    store.db.exec("DELETE FROM auto_template_captures WHERE json_extract(json,'$.files[0].role')='reference'");
    await executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(task.report?.quality,'unverified','a model pass cannot erase incomplete reference-page capture');
    assert.ok(task.report?.coverage.unverified.some(gap=>gap.includes('reference')&&gap.includes('逐屏取证未完成')));
    sourceGap=false;
    task.siteRevision='next';store.put(task);const failedClient=(()=>({startThread:()=>({runStreamed:async()=>{throw new Error('upstream socket closed before completion');}})})) as unknown as typeof codexClient;
    await assert.rejects(executeEvaluation(task,store,vault,directory,new AbortController().signal,{openBrowser,createClient:failedClient}),/无法确认.*停止.*原始失败：upstream socket closed/);
    assert.ok(store.events(task.id).some(e=>e.message==='独立评测未完成：upstream socket closed before completion'));assert.equal(store.evaluations.get(task.id)?.state,'unconfirmed');
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});

test('intermediate optimization reassessment incrementally inherits untargeted pages and viewports when shared layout bytes change, while fullAuditRequired runs full verification',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'template-incremental-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(resolve(directory,'vault'));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,model:[]}));});
  let threads=0;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,environmentId=randomUUID();
    vault.update({...vault.get(),model:{endpoint:origin+'/v1',name:'test-model',apiKey:'fake-test-key'},environments:[{id:environmentId,name:'Test',origin,apiOrigin:origin,token:'fake-test-token'}]});
    const settings=structuredClone(defaultAutomationSettings);settings.learning={...defaultLearningSettings,use:false,collect:false};vault.updateAutomation({...settings,evaluationEndpoint:origin+'/v1',evaluationModel:'test-model'});
    const resource=store.saveResource({name:'Template',scenario:'site-template',description:'all pages',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalSource:'',externalId:''});
    const siteId=randomUUID();
    const paths=['/','/about','/contact','/pricing','/faq','/privacy','/terms'];
    const basePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
    const root=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:'',optimization:{...defaultOptimizationPolicy,targetScore:85,maxRounds:3}},settings)[0];
    root.generatedSiteId=siteId;root.siteUrl='https://target.test/';root.learningPolicy={...defaultLearningSettings,use:false,collect:false};
    root.rule={...root.rule!,criteria:[{id:'visual',label:'Visual',weight:100,instruction:'Review actual layout',required:true,viewports:['desktop','mobile'],scopes:['site']}]};
    store.saveSite({id:siteId,resourceId:resource.id,versionId:root.versionId,environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:Date.now()});
    store.put(root);
    const manifest=new ManifestStore(store).save(root,{sourceComplete:true,limitations:[],evidence:[],items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'Fixed',expectation:'all paths and viewports',paths,expectedCount:paths.length,viewports:['desktop','mobile']}]},'human');
    let activeFiles:MaterialFile[]=[],currentTask=root,sharedHeaderRevision='v1';
    const openBrowser:typeof evaluationBrowser=async(_urls,work,_signal,initial,checkpoint,binding)=>{
      activeFiles=structuredClone(initial||[]);
      return {artifacts:activeFiles,env:{EVALUATION_BROWSER_URL:'mock',EVALUATION_BROWSER_TOKEN:'mock'},capture:async(raw:unknown)=>{
        const slot=raw as {action:string;role:'target'|'reference';viewport:'desktop'|'mobile';url:string};
        const screenshots:ScreenshotReceipt[]=[],captureId=randomUUID(),height=slot.viewport==='mobile'?844:1000;
        for(const [index,scrollY] of [0,500].entries()){
          const file=randomUUID()+'.png';
          const bytes=slot.role==='target'?Buffer.concat([basePng,Buffer.from(sharedHeaderRevision)]):basePng;
          const observation={...slot,file,text:slot.role==='target'?`Header ${sharedHeaderRevision} on ${new URL(slot.url).pathname}`:'Reference stable',position:{url:slot.url,scrollX:0,scrollY,documentHeight:height+500,viewportHeight:height,viewportWidth:slot.viewport==='mobile'?390:1440,matches:0,invalidSelector:false,visible:false,nestedScroll:false,horizontalOverflow:false,regionTop:0,regionBottom:0},capture:{id:captureId,index:index+1,scope:'page' as const,policy:evaluationCapturePolicy},readiness:{settled:true,images:1,pendingImages:0,brokenImages:0,runningAnimations:0,fontsReady:true,stableForMs:500},binding:{...binding,capturePolicy:evaluationCapturePolicy},settlement:{settled:true}};
          for(const [name,data,type] of [[file,bytes,'image/png'],[file.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(work,'evidence',name),data);activeFiles.push({id:randomUUID(),name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),type,role:slot.role,viewport:slot.viewport,settled:true});}
          screenshots.push(observation);checkpoint?.(activeFiles);
        }
        return {action:'take_page_screenshots',status:'complete',coverageComplete:true,screenshots,gaps:[],nextStartY:null,nextSelectorIndex:null};
      },close:async()=>{}};
    };
    const batchesRun:string[]=[];
    const createClient=((_vault:Vault,_directory:string,env:Record<string,string>)=>({startThread:()=>{threads++;return {runStreamed:async(prompt:string)=>{
      const work=resolve(directory,'automation-runs',currentTask.id),context=JSON.parse(readFileSync(resolve(work,'task.json'),'utf8'));
      batchesRun.push(context.batchId);
      const match=/evaluation-result-[a-f0-9-]{36}\.json/.exec(prompt);assert.ok(match);const resultFile=match[0];
      const obsUrl=(name:string)=>JSON.parse(readFileSync(resolve(work,'evidence',name.replace('.png','.json')),'utf8')).url as string;
      const raw={
        summary:context.batchId,
        assessments:context.task.rule.criteria.flatMap((c:any)=>c.viewports.map((viewport:string)=>({criterionId:c.id,viewport,score:91,passed:true,reason:'Reviewed pixels',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.viewport===viewport&&new URL(obsUrl(f.name)).pathname==='/').map(f=>f.name)}))),
        issues:[],
        ...(context.rechecks?{rechecks:context.rechecks.map((t:any)=>({id:t.id,status:'resolved',reason:'Desktop homepage fixed',evidence:activeFiles.filter(f=>f.role==='target'&&f.type==='image/png'&&t.locations.some((l:any)=>l.viewport===f.viewport&&l.url===obsUrl(f.name))).map(f=>f.name)}))}:{}),
        coverage:{verified:['reviewed'],unverified:[],outOfScope:[]},
        ...(context.manifest?{completeness:context.manifest.items.map((item:any)=>({id:item.id,status:'verified',reason:'Reviewed batch paths',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.role==='target'&&item.paths.some((p:string)=>new URL(p,'https://target.test/').href===obsUrl(f.name))).map(f=>f.name),checkedViewports:['desktop','mobile'],actualCount:item.paths.length,sampledPaths:item.paths,checkedKeys:[]}))}:{}),
      };
      writeFileSync(resolve(work,resultFile),JSON.stringify(raw));
      const response=await fetch(env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({tool:'validate_result',resultFile})});
      assert.equal(response.status,200,await response.text());
      return {events:(async function*(){yield {type:'thread.started',thread_id:randomUUID()};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({resultFile})}};yield {type:'turn.completed',usage:{input_tokens:100,output_tokens:50}};})()};
    }};},resumeThread:()=>{throw new Error('short threads expected');}})) as unknown as typeof codexClient;

    const baseline=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'initial',parentId:root.id,optimizationRootId:root.id,optimizationRound:0,ruleSnapshot:root.rule!},settings)[0];
    baseline.requirementsId=manifest.id;baseline.siteRevision='rev-0';baseline.status='running';baseline.stopped=false;baseline.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(baseline);
    currentTask=baseline;
    await executeEvaluation(baseline,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads,4,'initial full evaluation runs criteria-desktop, criteria-mobile, completeness-1, completeness-2');
    const homeDesktop=baseline.report!.artifacts.find(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='desktop'&&new URL(JSON.parse(readFileSync(resolve(directory,'automation-runs',baseline.id,'evidence',f.name.replace('.png','.json')),'utf8')).url).pathname==='/')!;
    baseline.report!.issues=[{severity:'major',title:'Desktop hero nav spacing',detail:'Fix desktop homepage header',evidence:[homeDesktop.name]}];
    baseline.report!.quality='failed';store.put(baseline);

    // Repair edits shared header/footer, shifting target PNG bytes across ALL 7 pages on both viewports.
    sharedHeaderRevision='v2-global-header-fix';
    const repair=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'fix desktop hero header',parentId:root.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    repair.siteRevision='rev-1';repair.repairEvidence={reportId:baseline.id,files:[homeDesktop.name]};store.put(repair);

    const intermediate=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'intermediate reassessment',parentId:repair.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    intermediate.requirementsId=manifest.id;intermediate.siteRevision='rev-1';intermediate.status='running';intermediate.stopped=false;intermediate.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(intermediate);
    currentTask=intermediate;batchesRun.length=0;const beforeIntermediate=threads;
    await executeEvaluation(intermediate,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeIntermediate,3,'intermediate incremental reassessment skips criteria-mobile and completeness-2');
    assert.deepEqual(batchesRun,['criteria-desktop','completeness-1','regression-issues']);
    assert.equal(intermediate.report?.review?.mode,'incremental');
    assert.equal(intermediate.report?.review?.scopeComplete,false);
    assert.deepEqual(intermediate.report?.review?.inheritedAssessments,['visual:mobile']);
    assert.deepEqual(intermediate.report?.review?.deferredAssessments,['visual:mobile']);
    assert.deepEqual(intermediate.report?.review?.inheritedPagePaths,[{id:'pages',paths:['/about','/contact','/pricing','/faq','/privacy','/terms']}]);
    assert.deepEqual(intermediate.report?.review?.deferredPagePaths,[{id:'pages',paths:['/about','/contact','/pricing','/faq','/privacy','/terms']}]);
    assert.equal(intermediate.report?.quality,'passed');
    assert.equal(intermediate.report?.completeness?.state,'complete');

    // Final full-site audit on the same revision disables Tier 2 incremental carry-forward and verifies all changed pages/viewports.
    const audit=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'final full audit',parentId:repair.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    audit.requirementsId=manifest.id;audit.siteRevision='rev-1';audit.fullAuditRequired=true;audit.status='running';audit.stopped=false;audit.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(audit);
    currentTask=audit;batchesRun.length=0;const beforeAudit=threads;
    await executeEvaluation(audit,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeAudit,5,'full audit re-verifies all changed criteria and completeness batches plus regression rechecks');
    assert.deepEqual(batchesRun,['criteria-desktop','criteria-mobile','completeness-1','completeness-2','regression-issues']);
    assert.equal(audit.report?.review?.mode,'targeted');
    assert.equal(audit.report?.review?.scopeComplete,true);
    assert.equal(audit.report?.review?.inheritedAssessments.length,0);
    assert.equal(audit.report?.review?.inheritedPagePaths?.length||0,0);
    assert.deepEqual(audit.report?.review?.deferredAssessments,[]);
    assert.deepEqual(audit.report?.review?.deferredRequirements,[]);
    assert.deepEqual(audit.report?.review?.deferredPagePaths,[]);
    assert.equal(audit.report?.quality,'passed');
    assert.equal(audit.report?.completeness?.state,'complete');
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});

test('chained byte-equal round cannot launder un-audited incremental judgments into scopeComplete=true and final audit executes real model review on deferred slices',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'template-deferred-provenance-')),db=new Database(':memory:'),store=new AutomationStore(db),vault=new Vault(resolve(directory,'vault'));
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,model:[]}));});
  let threads=0;
  try{
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`,environmentId=randomUUID();
    vault.update({...vault.get(),model:{endpoint:origin+'/v1',name:'test-model',apiKey:'fake-test-key'},environments:[{id:environmentId,name:'Test',origin,apiOrigin:origin,token:'fake-test-token'}]});
    const settings=structuredClone(defaultAutomationSettings);settings.learning={...defaultLearningSettings,use:false,collect:false};vault.updateAutomation({...settings,evaluationEndpoint:origin+'/v1',evaluationModel:'test-model'});
    const resource=store.saveResource({name:'Template',scenario:'site-template',description:'deferred provenance',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalSource:'',externalId:''});
    const siteId=randomUUID();
    const basePng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64');
    const root=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,requirements:'',optimization:{...defaultOptimizationPolicy,targetScore:85,maxRounds:3}},settings)[0];
    root.generatedSiteId=siteId;root.siteUrl='https://target.test/';root.learningPolicy={...defaultLearningSettings,use:false,collect:false};
    root.rule={...root.rule!,criteria:[{id:'hero',label:'Hero',weight:100,instruction:'Review hero',required:true,viewports:['desktop','mobile'],scopes:['site']}]};
    store.saveSite({id:siteId,resourceId:resource.id,versionId:root.versionId,environmentId,siteId:randomUUID(),name:'Target',url:'https://target.test/',createdAt:Date.now()});
    store.put(root);
    const manifest=new ManifestStore(store).save(root,{
      sourceComplete:true,limitations:[],evidence:[],
      items:[
        {id:'pages',title:'Pages',kind:'page',required:true,source:'Fixed',expectation:'home and about',paths:['/','/about'],expectedCount:2,viewports:['desktop','mobile']},
        {id:'about-only',title:'About standalone check',kind:'page',required:true,source:'Fixed',expectation:'about standalone',paths:['/about'],expectedCount:1,viewports:['desktop','mobile']},
        {id:'seo-meta',title:'SEO Meta',kind:'seo',required:true,source:'Fixed',expectation:'meta tags on about',paths:[],expectedCount:null,viewports:['desktop']},
      ],
    },'human');

    let activeFiles:MaterialFile[]=[],currentTask=root,changeHeader='r0';
    const openBrowser:typeof evaluationBrowser=async(_urls,work,_signal,initial,checkpoint,binding)=>{
      activeFiles=structuredClone(initial||[]);
      return {artifacts:activeFiles,env:{EVALUATION_BROWSER_URL:'mock',EVALUATION_BROWSER_TOKEN:'mock'},capture:async(raw:unknown)=>{
        const slot=raw as {action:string;role:'target'|'reference';viewport:'desktop'|'mobile';url:string};
        const screenshots:ScreenshotReceipt[]=[],captureId=randomUUID(),height=slot.viewport==='mobile'?844:1000;
        for(const [index,scrollY] of [0,500].entries()){
          const file=randomUUID()+'.png';
          const bytes=slot.role==='target'?Buffer.concat([basePng,Buffer.from(changeHeader)]):basePng;
          const observation={...slot,file,text:slot.role==='target'?`Header ${changeHeader} on ${new URL(slot.url).pathname}`:'Reference stable',position:{url:slot.url,scrollX:0,scrollY,documentHeight:height+500,viewportHeight:height,viewportWidth:slot.viewport==='mobile'?390:1440,matches:0,invalidSelector:false,visible:false,nestedScroll:false,horizontalOverflow:false,regionTop:0,regionBottom:0},capture:{id:captureId,index:index+1,scope:'page' as const,policy:evaluationCapturePolicy},readiness:{settled:true,images:1,pendingImages:0,brokenImages:0,runningAnimations:0,fontsReady:true,stableForMs:500},binding:{...binding,capturePolicy:evaluationCapturePolicy},settlement:{settled:true}};
          for(const [name,data,type] of [[file,bytes,'image/png'],[file.replace('.png','.json'),Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(work,'evidence',name),data);activeFiles.push({id:randomUUID(),name,size:data.length,sha256:createHash('sha256').update(data).digest('hex'),type,role:slot.role,viewport:slot.viewport,settled:true});}
          screenshots.push(observation);checkpoint?.(activeFiles);
        }
        return {action:'take_page_screenshots',status:'complete',coverageComplete:true,screenshots,gaps:[],nextStartY:null,nextSelectorIndex:null};
      },close:async()=>{}};
    };

    const batchesRun:{batchId:string;criteria:string[];requirements:{id:string;paths:string[]}[]}[]=[];
    const createClient=((_vault:Vault,_directory:string,env:Record<string,string>)=>({startThread:()=>{threads++;return {runStreamed:async(prompt:string)=>{
      const work=resolve(directory,'automation-runs',currentTask.id),context=JSON.parse(readFileSync(resolve(work,'task.json'),'utf8'));
      batchesRun.push({
        batchId:context.batchId,
        criteria:(context.task.rule.criteria||[]).flatMap((c:any)=>c.viewports.map((v:string)=>`${c.id}:${v}`)),
        requirements:(context.manifest?.items||[]).map((i:any)=>({id:i.id,paths:i.paths})),
      });
      const match=/evaluation-result-[a-f0-9-]{36}\.json/.exec(prompt);assert.ok(match);const resultFile=match[0];
      const obsUrl=(name:string)=>JSON.parse(readFileSync(resolve(work,'evidence',name.replace('.png','.json')),'utf8')).url as string;
      const raw={
        summary:context.batchId,
        assessments:context.task.rule.criteria.flatMap((c:any)=>c.viewports.map((viewport:string)=>({criterionId:c.id,viewport,score:92,passed:true,reason:'Reviewed pixels',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.viewport===viewport&&new URL(obsUrl(f.name)).pathname==='/').map(f=>f.name)}))),
        issues:[],
        ...(context.rechecks?{rechecks:context.rechecks.map((t:any)=>({id:t.id,status:'resolved',reason:'Desktop homepage fixed',evidence:activeFiles.filter(f=>f.role==='target'&&f.type==='image/png'&&t.locations.some((l:any)=>l.viewport===f.viewport&&l.url===obsUrl(f.name))).map(f=>f.name)}))}:{}),
        coverage:{verified:['reviewed'],unverified:[],outOfScope:[]},
        ...(context.manifest?{completeness:context.manifest.items.map((item:any)=>item.kind==='seo'
          ?{id:item.id,status:'verified',reason:'Reviewed SEO on about',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.role==='target'&&f.viewport==='desktop'&&new URL(obsUrl(f.name)).pathname==='/about').map(f=>f.name),checkedViewports:['desktop'],actualCount:null,sampledPaths:[],checkedKeys:[]}
          :{id:item.id,status:'verified',reason:'Reviewed batch paths',evidence:activeFiles.filter(f=>f.type==='image/png'&&f.role==='target'&&item.paths.some((p:string)=>new URL(p,'https://target.test/').href===obsUrl(f.name))).map(f=>f.name),checkedViewports:['desktop','mobile'],actualCount:item.paths.length,sampledPaths:item.paths,checkedKeys:[]})}:{}),
      };
      writeFileSync(resolve(work,resultFile),JSON.stringify(raw));
      const response=await fetch(env.INSPECTION_URL,{method:'POST',headers:{Authorization:'Bearer '+env.INSPECTION_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({tool:'validate_result',resultFile})});
      assert.equal(response.status,200,await response.text());
      return {events:(async function*(){yield {type:'thread.started',thread_id:randomUUID()};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({resultFile})}};yield {type:'turn.completed',usage:{input_tokens:100,output_tokens:50}};})()};
    }};},resumeThread:()=>{throw new Error('short threads expected');}})) as unknown as typeof codexClient;

    // 1. eval0: initial full review on r0
    const eval0=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'eval0',parentId:root.id,optimizationRootId:root.id,optimizationRound:0,ruleSnapshot:root.rule!},settings)[0];
    eval0.requirementsId=manifest.id;eval0.siteRevision='r0';eval0.status='running';eval0.stopped=false;eval0.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(eval0);
    currentTask=eval0;
    await executeEvaluation(eval0,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads,3,'eval0 runs criteria-desktop, criteria-mobile, completeness-1');
    const r0HomeDesktop=eval0.report!.artifacts.find(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='desktop'&&new URL(JSON.parse(readFileSync(resolve(directory,'automation-runs',eval0.id,'evidence',f.name.replace('.png','.json')),'utf8')).url).pathname==='/')!;
    eval0.report!.issues=[{severity:'major',title:'Desktop hero nav',detail:'Fix desktop homepage header',evidence:[r0HomeDesktop.name]}];
    eval0.report!.quality='failed';store.put(eval0);

    // 2. repair1 -> eval1 on r1: shared header changes bytes on BOTH / and /about across desktop and mobile; only desktop / was targeted.
    changeHeader='r1-shared-header';
    const repair1=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'repair1',parentId:root.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    repair1.siteRevision='r1';repair1.repairEvidence={reportId:eval0.id,files:[r0HomeDesktop.name]};store.put(repair1);

    const eval1=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'eval1',parentId:repair1.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    eval1.requirementsId=manifest.id;eval1.siteRevision='r1';eval1.status='running';eval1.stopped=false;eval1.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(eval1);
    currentTask=eval1;batchesRun.length=0;const beforeEval1=threads;
    await executeEvaluation(eval1,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeEval1,3,'eval1 runs criteria-desktop, completeness-1 (only /), and regression-issues');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['criteria-desktop','completeness-1','regression-issues']);
    assert.deepEqual(batchesRun[1].requirements,[{id:'pages',paths:['/']}]);
    assert.equal(eval1.report?.review?.mode,'incremental');
    assert.equal(eval1.report?.review?.scopeComplete,false);
    assert.deepEqual(eval1.report?.review?.deferredAssessments,['hero:mobile']);
    assert.deepEqual(eval1.report?.review?.deferredRequirements,['about-only','seo-meta']);
    assert.deepEqual(eval1.report?.review?.deferredPagePaths,[{id:'pages',paths:['/about']},{id:'about-only',paths:['/about']}]);

    // Suppose eval1 still had a desktop / issue so optimization enters Round 2 (repair2 -> eval2 on r2).
    const r1HomeDesktop=eval1.report!.artifacts.find(f=>f.role==='target'&&f.type==='image/png'&&f.viewport==='desktop'&&new URL(JSON.parse(readFileSync(resolve(directory,'automation-runs',eval1.id,'evidence',f.name.replace('.png','.json')),'utf8')).url).pathname==='/')!;
    eval1.report!.issues=[{severity:'major',title:'Desktop CTA polish',detail:'Adjust desktop CTA',evidence:[r1HomeDesktop.name]}];
    eval1.report!.quality='failed';store.put(eval1);

    // 3. repair2 -> eval2 on r2 where bytes on r2 are 100% IDENTICAL to r1 (changeHeader stays 'r1-shared-header', zero pixel delta from r1 to r2).
    const repair2=store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'repair2',parentId:root.id,optimizationRootId:root.id,optimizationRound:2,ruleSnapshot:root.rule!},settings)[0];
    repair2.siteRevision='r2';repair2.repairEvidence={reportId:eval1.id,files:[r1HomeDesktop.name]};store.put(repair2);

    const eval2=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'eval2',parentId:repair2.id,optimizationRootId:root.id,optimizationRound:2,ruleSnapshot:root.rule!},settings)[0];
    eval2.requirementsId=manifest.id;eval2.siteRevision='r2';eval2.status='running';eval2.stopped=false;eval2.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(eval2);
    currentTask=eval2;batchesRun.length=0;const beforeEval2=threads;
    await executeEvaluation(eval2,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    store.put(eval2);
    assert.equal(threads-beforeEval2,1,'eval2 inherits genuinely reviewed hero:desktop & / via Tier 1, keeps deferred slices via Tier 2, and runs regression-issues');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['regression-issues']);
    assert.equal(eval2.report?.review?.mode,'incremental','byte-equality against eval1 MUST NOT launder deferred judgments into targeted');
    assert.equal(eval2.report?.review?.scopeComplete,false,'eval2 must preserve scopeComplete=false');
    assert.deepEqual([...(eval2.report?.review?.inheritedAssessments||[])].sort(),['hero:desktop','hero:mobile']);
    assert.deepEqual(eval2.report?.review?.deferredAssessments,['hero:mobile']);
    assert.deepEqual(eval2.report?.review?.inheritedRequirements,['pages','about-only','seo-meta']);
    assert.deepEqual(eval2.report?.review?.deferredRequirements,['about-only','seo-meta']);
    assert.deepEqual(eval2.report?.review?.deferredPagePaths,[{id:'pages',paths:['/about']},{id:'about-only',paths:['/about']}]);

    // 4a. Final audit on r1 with parentId = eval1.id: executes real model batch threads for criteria-mobile and /about (+ seo-meta), while keeping Tier 1 for genuinely reviewed hero:desktop and /.
    const auditOnR1=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'audit r1',parentId:eval1.id,optimizationRootId:root.id,optimizationRound:1,ruleSnapshot:root.rule!},settings)[0];
    auditOnR1.requirementsId=manifest.id;auditOnR1.siteRevision='r1';auditOnR1.fullAuditRequired=true;auditOnR1.status='running';auditOnR1.stopped=false;auditOnR1.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(auditOnR1);
    currentTask=auditOnR1;batchesRun.length=0;const beforeAuditR1=threads;
    await executeEvaluation(auditOnR1,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeAuditR1,3,'audit on r1 (parentId=eval1) runs criteria-mobile, completeness-1 (/about + seo-meta), and regression-issues');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['criteria-mobile','completeness-1','regression-issues']);
    assert.deepEqual(batchesRun[0].criteria,['hero:mobile']);
    assert.deepEqual(batchesRun[1].requirements,[{id:'pages',paths:['/about']},{id:'about-only',paths:['/about']},{id:'seo-meta',paths:[]}]);
    assert.equal(auditOnR1.report?.review?.mode,'targeted');
    assert.equal(auditOnR1.report?.review?.scopeComplete,true);
    assert.deepEqual(auditOnR1.report?.review?.inheritedAssessments,['hero:desktop']);
    assert.deepEqual(auditOnR1.report?.review?.inheritedPagePaths,[{id:'pages',paths:['/']}]);
    assert.deepEqual(auditOnR1.report?.review?.deferredAssessments,[]);
    assert.deepEqual(auditOnR1.report?.review?.deferredRequirements,[]);
    assert.deepEqual(auditOnR1.report?.review?.deferredPagePaths,[]);

    // 4b. Final audit on r2 with parentId = repair2.id (baseline = eval1, r2 bytes === r1 bytes): executes real model batch threads for criteria-mobile and /about (+ seo-meta).
    const auditOnR2ViaRepair=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'audit r2 via repair2',parentId:repair2.id,optimizationRootId:root.id,optimizationRound:2,ruleSnapshot:root.rule!},settings)[0];
    auditOnR2ViaRepair.requirementsId=manifest.id;auditOnR2ViaRepair.siteRevision='r2';auditOnR2ViaRepair.fullAuditRequired=true;auditOnR2ViaRepair.status='running';auditOnR2ViaRepair.stopped=false;auditOnR2ViaRepair.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(auditOnR2ViaRepair);
    currentTask=auditOnR2ViaRepair;batchesRun.length=0;const beforeAuditR2Repair=threads;
    await executeEvaluation(auditOnR2ViaRepair,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeAuditR2Repair,3,'audit on r2 (parentId=repair2) executes real model batches for deferred slices despite byte-equal r1->r2');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['criteria-mobile','completeness-1','regression-issues']);
    assert.equal(auditOnR2ViaRepair.report?.review?.mode,'targeted');
    assert.equal(auditOnR2ViaRepair.report?.review?.scopeComplete,true);
    assert.deepEqual(auditOnR2ViaRepair.report?.review?.deferredAssessments,[]);
    assert.deepEqual(auditOnR2ViaRepair.report?.review?.deferredRequirements,[]);
    assert.deepEqual(auditOnR2ViaRepair.report?.review?.deferredPagePaths,[]);

    // 4c. Final audit on r2 with parentId = eval2.id (exact advanceOptimization flow): executes real model batch threads for criteria-mobile and completeness-1 (/about + seo-meta).
    const auditOnR2ViaEval2=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'audit r2 via eval2',parentId:eval2.id,optimizationRootId:root.id,optimizationRound:2,ruleSnapshot:root.rule!},settings)[0];
    auditOnR2ViaEval2.requirementsId=manifest.id;auditOnR2ViaEval2.siteRevision='r2';auditOnR2ViaEval2.fullAuditRequired=true;auditOnR2ViaEval2.status='running';auditOnR2ViaEval2.stopped=false;auditOnR2ViaEval2.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(auditOnR2ViaEval2);
    currentTask=auditOnR2ViaEval2;batchesRun.length=0;const beforeAuditR2Eval2=threads;
    await executeEvaluation(auditOnR2ViaEval2,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeAuditR2Eval2,2,'audit on r2 (parentId=eval2) executes criteria-mobile and completeness-1 while reusing resolved issue and reviewed slices');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['criteria-mobile','completeness-1']);
    assert.deepEqual(batchesRun[0].criteria,['hero:mobile']);
    assert.deepEqual(batchesRun[1].requirements,[{id:'pages',paths:['/about']},{id:'about-only',paths:['/about']},{id:'seo-meta',paths:[]}]);
    assert.equal(auditOnR2ViaEval2.report?.review?.mode,'targeted');
    assert.equal(auditOnR2ViaEval2.report?.review?.scopeComplete,true);
    assert.deepEqual(auditOnR2ViaEval2.report?.review?.deferredAssessments,[]);
    assert.deepEqual(auditOnR2ViaEval2.report?.review?.deferredRequirements,[]);
    assert.deepEqual(auditOnR2ViaEval2.report?.review?.deferredPagePaths,[]);

    // 4d. Legacy report fixture without deferred* fields (scopeComplete=false only) treats inherited* as deferred under fullAuditRequired.
    const legacyBaseline=store.task(eval2.id)!;
    delete legacyBaseline.report!.review!.deferredAssessments;
    delete legacyBaseline.report!.review!.deferredRequirements;
    delete legacyBaseline.report!.review!.deferredPagePaths;
    store.put(legacyBaseline);
    const auditLegacy=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId,generatedSiteId:siteId,requirements:'audit legacy',parentId:legacyBaseline.id,optimizationRootId:root.id,optimizationRound:2,ruleSnapshot:root.rule!},settings)[0];
    auditLegacy.requirementsId=manifest.id;auditLegacy.siteRevision='r2';auditLegacy.fullAuditRequired=true;auditLegacy.status='running';auditLegacy.stopped=false;auditLegacy.learningPolicy={...defaultLearningSettings,use:false,collect:false};store.put(auditLegacy);
    currentTask=auditLegacy;batchesRun.length=0;const beforeAuditLegacy=threads;
    await executeEvaluation(auditLegacy,store,vault,directory,new AbortController().signal,{openBrowser,createClient});
    assert.equal(threads-beforeAuditLegacy,3,'legacy report without deferred* treats all inherited slices as deferred and runs full model review');
    assert.deepEqual(batchesRun.map(b=>b.batchId),['criteria-desktop','criteria-mobile','completeness-1']);
    assert.equal(auditLegacy.report?.review?.scopeComplete,true);
    assert.deepEqual(auditLegacy.report?.review?.deferredAssessments,[]);
  }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});
