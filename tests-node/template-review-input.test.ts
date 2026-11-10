import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareTemplateReviewInput } from '../server/automation/template-review-input.js';
import { followupTaskContext, followupReportComparison } from '../server/automation/followup-context.js';
import { planningImageInput } from '../server/automation/optimization-evidence.js';
import type { AutomationReport, AutomationTask, MaterialFile } from '../shared/automation.js';
import { defaultAutomationSettings } from '../shared/automation.js';

const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
test('review aid selects this batch, prefers planned captures and preserves all original pixels and citations',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-input-'));mkdirSync(resolve(work,'evidence'));
  try{
    const files:MaterialFile[]=[],observations:Record<string,{role:string;viewport:string;url:string}>={};
    const add=(viewport:'desktop'|'mobile',path:string,height=1)=>{const name=randomUUID()+'.png',data=Buffer.alloc(height*4);for(let y=0;y<height;y++){data[y*4]=y%251;data[y*4+3]=255;}const bytes=PNG.sync.write({width:1,height,data});writeFileSync(resolve(work,'evidence',name),bytes);const file:MaterialFile={id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:'target',viewport,settled:true};files.push(file);observations[name]={role:'target',viewport,url:'https://target.test'+path};return {file,data};};
    add('desktop','/');const chosen=add('desktop','/',4201);add('mobile','/');add('desktop','/about');
    writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({progress:[{files:[chosen.file.name]}]}));
    const task={id:randomUUID(),rule:{criteria:[{id:'hero',viewports:['desktop']}]}} as AutomationTask;
    const result=prepareTemplateReviewInput(work,{id:'criteria-desktop',task},files,observations,'https://target.test/','');
    assert.equal(result.images.length,1);assert.equal(result.images[0].file,chosen.file.name);
    assert.deepEqual(result.images[0].views.map(v=>('region' in v?v.region?.height:0)),[2048,2048,105]);
    const pixels=Buffer.concat(result.images[0].views.map(v=>PNG.sync.read(readFileSync(resolve(work,v.path))).data));assert.deepEqual(pixels,chosen.data);
    const draft=JSON.parse(readFileSync(resolve(work,'review-result-template.json'),'utf8'));assert.deepEqual(draft.assessments.map((a:any)=>[a.criterionId,a.viewport,a.score,a.passed]),[['hero','desktop',null,null]]);assert.deepEqual(draft.issues,[]);assert.equal(files.length,4);
  }finally{rmSync(work,{recursive:true,force:true});}
});

test('followup facts omit repeated SOP and historical briefs without changing persisted workflow',()=>{
  const task={context:'context',message:'message',optimization:{policy:{sop:'long quality SOP'},recoveryPolicy:{sop:'long recovery SOP'},rounds:[{number:0,generationTaskId:'generation',brief:'old giant repair',images:['old.png'],progress:{improved:true}}]},generation:{conversationId:'same',importedMaterials:{a:'hash'}},followup:{policy:defaultAutomationSettings.followup,lastAction:{action:'repair',reason:'known',message:'old giant repair'}}} as unknown as AutomationTask;
  const before=structuredClone(task),compact=followupTaskContext(task),json=JSON.stringify(compact);
  assert.ok(json.length<JSON.stringify(task).length);assert.ok(!json.includes('old giant repair'));assert.ok(!json.includes('long quality SOP'));assert.equal(compact.generation?.conversationId,'same');assert.equal(compact.optimization?.rounds[0].generationTaskId,'generation');assert.deepEqual(task,before);
});

test('report comparison preserves unknown scores and does not equate renamed issues or missing checks with resolution',()=>{
  const report={scores:[{viewport:'desktop',value:79},{viewport:'mobile',value:null}],assessments:[{criterionId:'hero',viewport:'desktop',score:79,passed:false}],issues:[{title:'Old clipping issue',severity:'major'}],coverage:{unverified:['Unknown source inventory']},completeness:{state:'incomplete',sourceComplete:false,checks:[{id:'pages',status:'partial'},{id:'forms',status:'unverified'}]}} as unknown as AutomationReport;
  const current=structuredClone(report);current.scores[0].value=86;current.assessments[0].score=86;current.assessments[0].passed=true;current.issues[0].title='Mobile content is clipped';current.completeness!.checks=current.completeness!.checks.slice(0,1);
  const before=structuredClone([current,report]),delta=followupReportComparison(current,report);
  assert.equal(delta.scores[0].change,7);assert.equal(delta.scores[1].change,null);assert.equal(delta.completeness.currentSourceComplete,false);
  assert.deepEqual(delta.completeness.checksNoLongerReported,['forms']);assert.deepEqual(delta.issueTitles.noLongerReported,['Old clipping issue']);assert.deepEqual(delta.issueTitles.newlyReported,['Mobile content is clipped']);
  assert.match(delta.note,/不证明问题已解决/);assert.equal('improved' in delta,false);assert.equal('resolved' in delta.issueTitles,false);assert.deepEqual([current,report],before);
  const initial=followupReportComparison(current);assert.equal(initial.hasPrevious,false);assert.ok(initial.scores.every(s=>s.previous===null&&s.change===null));assert.deepEqual(initial.issueTitles.newlyReported,[]);
});

test('planner retains both roles and viewports for a normal long-page evidence set above six MiB',()=>{
  const selected=[2.7,4.6,1.3,2].map(size=>({file:{name:randomUUID()+'.png',size:Math.floor(size*1024*1024)} as MaterialFile}));
  const result=planningImageInput(selected,new Set());assert.equal(result.available.length,4);assert.equal(result.attached.length,4);
  const resumed=planningImageInput(selected,new Set(selected.map(i=>i.file.name)));assert.equal(resumed.attached.length,0);assert.equal(resumed.previous.length,4);
});

test('review aid resolves a validated reference pair even when scoring observations contain targets only',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-reference-'));mkdirSync(resolve(work,'evidence'));
  try{
    const name=randomUUID()+'.png',bytes=PNG.sync.write({width:1,height:1,data:Buffer.from([1,2,3,255])}),jsonName=name.replace('.png','.json'),observation=Buffer.from(JSON.stringify({file:name,role:'reference',viewport:'desktop',url:'https://source.test/'}));
    const file:MaterialFile={id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:'reference',viewport:'desktop'},companion={...file,name:jsonName,type:'application/json',size:observation.length,sha256:createHash('sha256').update(observation).digest('hex')};
    writeFileSync(resolve(work,'evidence',name),bytes);writeFileSync(resolve(work,'evidence',jsonName),observation);
    const task={id:randomUUID(),rule:{criteria:[{id:'hero',viewports:['desktop']}]}} as AutomationTask;
    const input={id:'criteria-desktop',task};
    assert.equal(prepareTemplateReviewInput(work,input,[file,companion],{},'https://target.test/','https://source.test/').images[0].file,name);
    writeFileSync(resolve(work,'evidence',jsonName),'changed');assert.equal(prepareTemplateReviewInput(work,input,[file,companion],{},'https://target.test/','https://source.test/').images.length,0);
  }finally{rmSync(work,{recursive:true,force:true});}
});
