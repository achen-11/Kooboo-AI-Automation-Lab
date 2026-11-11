import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { formatTemplateReviewDigest, prepareTemplateReviewInput } from '../server/automation/template-review-input.js';
import { followupTaskContext, followupReportComparison } from '../server/automation/followup-context.js';
import { planningImageInput } from '../server/automation/optimization-evidence.js';
import type { AutomationReport, AutomationTask, MaterialFile } from '../shared/automation.js';
import type { RequirementManifest } from '../shared/completeness.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { templateBatchGuidanceContract } from '../server/automation/evaluator.js';

const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle');
test('review aid selects this batch, prefers planned captures and indexes originals without long-image slicing',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-input-'));mkdirSync(resolve(work,'evidence'));
  try{
    const files:MaterialFile[]=[],observations:Record<string,{role:string;viewport:string;url:string}>={};
    const add=(viewport:'desktop'|'mobile',path:string,height=1)=>{const name=randomUUID()+'.png',data=Buffer.alloc(height*4);for(let y=0;y<height;y++){data[y*4]=y%251;data[y*4+3]=255;}const bytes=PNG.sync.write({width:1,height,data});writeFileSync(resolve(work,'evidence',name),bytes);const file:MaterialFile={id:randomUUID(),name,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:'target',viewport,settled:true};files.push(file);observations[name]={role:'target',viewport,url:'https://target.test'+path};return {file,data};};
    add('desktop','/');const chosen=add('desktop','/',4201);add('mobile','/');add('desktop','/about');
    writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({progress:[{files:[chosen.file.name]}]}));
    const task={id:randomUUID(),rule:{criteria:[{id:'hero',viewports:['desktop']}]}} as AutomationTask;
    const result=prepareTemplateReviewInput(work,{id:'criteria-desktop',task},files,observations,'https://target.test/','');
    assert.equal(result.images.length,1);assert.equal(result.images[0].file,chosen.file.name);
    assert.deepEqual(result.images[0].views,[{path:'evidence/'+chosen.file.name}]);
    const pixels=Buffer.concat(result.images[0].views.map(v=>PNG.sync.read(readFileSync(resolve(work,v.path))).data));assert.deepEqual(pixels,chosen.data);
    const draft=JSON.parse(readFileSync(resolve(work,'review-result-template.json'),'utf8'));assert.deepEqual(draft.assessments.map((a:any)=>[a.criterionId,a.viewport,a.score,a.passed]),[['hero','desktop',null,null]]);assert.deepEqual(draft.issues,[]);assert.equal(files.length,4);
  }finally{rmSync(work,{recursive:true,force:true});}
});

test('followup facts omit repeated SOP and historical briefs without changing persisted workflow',()=>{
  const task={context:'context',message:'message',optimization:{policy:{sop:'long quality SOP'},recoveryPolicy:{sop:'long recovery SOP'},rounds:[{number:0,generationTaskId:'generation',brief:'old giant repair',images:['old.png'],progress:{improved:true}}]},generation:{conversationId:'same',importedMaterials:{a:'hash'}},followup:{policy:defaultAutomationSettings.followup,lastAction:{action:'repair',reason:'known',message:'old giant repair'}}} as unknown as AutomationTask;
  const before=structuredClone(task),compact=followupTaskContext(task),json=JSON.stringify(compact);
  assert.ok(json.length<JSON.stringify(task).length);assert.ok(!json.includes('old giant repair'));assert.ok(!json.includes('long quality SOP'));assert.equal(compact.generation?.conversationId,'same');assert.equal(compact.optimization?.rounds[0].generationTaskId,'generation');assert.deepEqual(task,before);
});

test('review index retains every planned viewport frame at the same URL instead of deduplicating to the first screen',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-frames-'));mkdirSync(resolve(work,'evidence'));
  try{
    const files:MaterialFile[]=[],observations:Record<string,{url:string;role:string;viewport:string}>={},names:string[]=[],id=randomUUID();
    for(const [index,scrollY] of [0,850,1700].entries()){
      const name=randomUUID()+'.png',json=name.replace('.png','.json'),location={url:'https://target.test/',role:'target',viewport:'desktop'};
      const observation={...location,file:name,capture:{id,index:index+1},position:{scrollY}};
      for(const [file,bytes,type] of [[name,Buffer.from('viewport pixels'),'image/png'],[json,Buffer.from(JSON.stringify(observation)),'application/json']] as const){writeFileSync(resolve(work,'evidence',file),bytes);files.push({id:randomUUID(),name:file,type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:'target',viewport:'desktop',settled:true});}
      observations[name]=location;names.push(name);
    }
    writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({progress:[{files:files.map(f=>f.name)}]}));
    const task={id:randomUUID(),rule:{criteria:[{id:'layout',viewports:['desktop']}]}} as AutomationTask;
    const result=prepareTemplateReviewInput(work,{id:'desktop',task},files,observations,'https://target.test/','');
    assert.deepEqual(result.images.map(i=>i.file),names);
    assert.deepEqual(result.images.map(i=>(i.position as {scrollY:number}).scrollY),[0,850,1700]);
    assert.ok(result.images.every(i=>i.views.length===1&&i.views[0].path==='evidence/'+i.file));
  }finally{rmSync(work,{recursive:true,force:true});}
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

test('inline review digest includes schema map, batch scope, program facts, scrollY positions and bare citation reminder',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-digest-'));mkdirSync(resolve(work,'evidence'));
  try{
    const files:MaterialFile[]=[],observations:Record<string,{url:string;role:string;viewport:string}>={},captureId=randomUUID();
    const makePair=(role:'target'|'reference',viewport:'desktop'|'mobile',url:string,scrollY:number)=>{
      const name=randomUUID()+'.png',pngBytes=PNG.sync.write({width:1,height:1,data:Buffer.from([10,20,30,255])});
      const obsBytes=Buffer.from(JSON.stringify({file:name,role,viewport,url,capture:{id:captureId,index:1},position:{scrollY}}));
      writeFileSync(resolve(work,'evidence',name),pngBytes);
      writeFileSync(resolve(work,'evidence',name.replace('.png','.json')),obsBytes);
      files.push(
        {id:randomUUID(),name,type:'image/png',size:pngBytes.length,sha256:createHash('sha256').update(pngBytes).digest('hex'),role,viewport,settled:true},
        {id:randomUUID(),name:name.replace('.png','.json'),type:'application/json',size:obsBytes.length,sha256:createHash('sha256').update(obsBytes).digest('hex'),role,viewport,settled:true},
      );
      if(role==='target')observations[name]={url,role,viewport};
      return name;
    };
    const targetHome=makePair('target','desktop','https://target.test/',0);
    const targetFold=makePair('target','desktop','https://target.test/',920);
    const refHome=makePair('reference','desktop','https://source.test/',0);
    writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({progress:[{files:[targetHome,targetFold,refHome]}]}));

    const manifest:RequirementManifest={
      id:'manifest-1',taskId:'task-1',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',
      items:[
        {id:'static-pages',title:'Static Pages',kind:'page',required:true,source:'nav',expectation:'All static pages',paths:['/','/about'],expectedCount:2,viewports:['desktop','mobile']},
        {id:'article-detail',title:'Article Detail',kind:'template',required:true,source:'blog',expectation:'Dynamic detail',paths:[],samples:['/blog/hello'],expectedCount:null,viewports:['desktop']},
      ],
    };
    const task={id:'task-1',rule:{criteria:[{id:'hero-layout',label:'Hero Layout',weight:40,instruction:'Check hero hierarchy and spacing',required:true,viewports:['desktop'],scopes:['site']}]}} as unknown as AutomationTask;
    const batch={
      id:'mixed-batch',
      task,
      manifest,
      rechecks:[{id:'issue-1',kind:'issue' as const,severity:'major' as const,title:'Hero CTA clipped on mobile',detail:'Button overflows container',locations:[{role:'target',url:'https://target.test/',viewport:'mobile',type:'image' as const}]}],
    };
    const reviewInput=prepareTemplateReviewInput(work,batch,files,observations,'https://target.test/','https://source.test/');
    const digest=formatTemplateReviewDigest({
      batch,
      reviewInput,
      manifest,
      reviewFacts:{
        pages:[{
          id:'static-pages',
          paths:[
            {path:'/',viewports:[{viewport:'desktop',state:'captured',settled:true,navigationStatus:200}]},
            {path:'/about',viewports:[{viewport:'desktop',state:'captured',settled:false,navigationStatus:200},{viewport:'mobile',state:'missing',settled:false,navigationStatus:null}]},
          ],
        }],
        records:[{id:'articles-data',state:'verified',expectedCount:12,actualCount:12,missingCount:0,unexpectedCount:0,emptyFieldCount:0}],
      },
    });

    assert.equal(digest,formatTemplateReviewDigest({batch,reviewInput,manifest,reviewFacts:{pages:[{id:'static-pages',paths:[{path:'/',viewports:[{viewport:'desktop',state:'captured',settled:true,navigationStatus:200}]},{path:'/about',viewports:[{viewport:'desktop',state:'captured',settled:false,navigationStatus:200},{viewport:'mobile',state:'missing',settled:false,navigationStatus:null}]}]}],records:[{id:'articles-data',state:'verified',expectedCount:12,actualCount:12,missingCount:0,unexpectedCount:0,emptyFieldCount:0}]}}));
    assert.ok(digest.length<=8000);
    assert.ok(!digest.includes('⚠️ 必读提示'));
    for(const token of [
      'task.json: {task,input,site,manifest,batchId,rechecks,reassessment,programFacts,capturePlan,evidenceManifest}',
      'review-input.json:',
      'review-facts.json: {pages,records,fullFacts,note}',
      'review-result-template.json: {summary,assessments,issues,coverage,completeness?,rechecks?}',
      'hero-layout | desktop | weight=40 | required | Hero Layout — Check hero hierarchy and spacing',
      'static-pages | page | required | desktop,mobile | paths(2): /, /about | expectedCount=2 | Static Pages',
      'source: nav | expectation: All static pages',
      'article-detail | template | required | desktop | samples(1): /blog/hello | Article Detail',
      'source: blog | expectation: Dynamic detail',
      'issue-1 | issue | major | Hero CTA clipped on mobile | mobile:https://target.test/',
      'detail: Button overflows container',
      'static-pages: partial (paths=2, settled=1, gaps=/about(desktop:unsettled,mobile:missing))',
      'articles-data: verified (expected=12, actual=12, missing=0, unexpected=0, emptyFields=0)',
      `evidence/${targetHome} | target | desktop | scrollY=0 | settled | https://target.test/`,
      `evidence/${targetFold} | target | desktop | scrollY=920 | settled | https://target.test/`,
      `evidence/${refHome} | reference | desktop | scrollY=0 | settled | https://source.test/`,
      '禁止带 evidence/ 前缀',
    ])assert.ok(digest.includes(token),`expected digest to include: ${token}`);

    const criteriaOnlyBatch={id:'criteria-desktop',task};
    const criteriaDigest=formatTemplateReviewDigest({batch:criteriaOnlyBatch,reviewInput});
    assert.match(criteriaDigest,/本批完整度交付项 \(completeness\): none/);
    assert.match(criteriaDigest,/本批原问题\/缺口复验 \(rechecks\): none/);
    assert.match(criteriaDigest,/程序对账摘要 \(review-facts\.json\): none/);
  }finally{rmSync(work,{recursive:true,force:true});}
});

test('inline review digest enforces default 8000 and custom 6500 char caps on 130+ images with overflow pointer while leaving original PNGs untouched',()=>{
  const work=mkdtempSync(resolve(tmpdir(),'review-digest-cap-'));mkdirSync(resolve(work,'evidence'));
  try{
    const files:MaterialFile[]=[],observations:Record<string,{url:string;role:string;viewport:string}>={};
    const originalHashes=new Map<string,string>(),captureId=randomUUID();
    for(let i=0;i<130;i++){
      const name=randomUUID()+'.png';
      const pngBytes=PNG.sync.write({width:2,height:2,data:Buffer.from([i%255,(i*3)%255,(i*7)%255,255,1,2,3,255,4,5,6,255,7,8,9,255])});
      const sha256=createHash('sha256').update(pngBytes).digest('hex');
      originalHashes.set(name,sha256);
      const url=`https://target.test/catalog/category-${Math.floor(i/5)}/item-${i}?filter=featured`;
      const obsBytes=Buffer.from(JSON.stringify({file:name,role:'target',viewport:'desktop',url,capture:{id:captureId,index:i+1},position:{scrollY:(i%5)*800}}));
      writeFileSync(resolve(work,'evidence',name),pngBytes);
      writeFileSync(resolve(work,'evidence',name.replace('.png','.json')),obsBytes);
      files.push(
        {id:randomUUID(),name,type:'image/png',size:pngBytes.length,sha256,role:'target',viewport:'desktop',settled:true},
        {id:randomUUID(),name:name.replace('.png','.json'),type:'application/json',size:obsBytes.length,sha256:createHash('sha256').update(obsBytes).digest('hex'),role:'target',viewport:'desktop',settled:true},
      );
      observations[name]={url,role:'target',viewport:'desktop'};
    }
    const paths=[...new Set(Object.values(observations).map(o=>new URL(o.url).pathname+new URL(o.url).search))];
    writeFileSync(resolve(work,'capture-plan.json'),JSON.stringify({progress:[{files:files.filter(f=>f.type==='image/png').map(f=>f.name)}]}));
    const manifest:RequirementManifest={
      id:'manifest-large',taskId:'task-large',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',
      items:[{id:'catalog-pages',title:'Catalog Pages',kind:'page',required:true,source:'sitemap',expectation:'Every catalog item',paths,expectedCount:paths.length,viewports:['desktop']}],
    };
    const task={id:'task-large',rule:{criteria:[]}} as unknown as AutomationTask;
    const batch={id:'completeness-1',task,manifest};
    const reviewInput=prepareTemplateReviewInput(work,batch,files,observations,'https://target.test/','');
    assert.equal(reviewInput.images.length,130);

    const defaultDigest=formatTemplateReviewDigest({batch,reviewInput,manifest});
    assert.ok(defaultDigest.length<=8000,`expected default digest length <= 8000, got ${defaultDigest.length}`);
    assert.ok(defaultDigest.length>6500,`expected default 8000 cap to fit more image rows than 6500, got ${defaultDigest.length}`);
    assert.match(defaultDigest,/另有 \d+ 张已登记截图未内联（共 130 张）.*review-input\.json/);
    assert.match(defaultDigest,/本批评分指标 \(criteria\): none/);
    assert.match(defaultDigest,/\(\+122 more — 必读 task\.json\.manifest\.items\)/);
    assert.ok(defaultDigest.includes('⚠️ 必读提示'));

    const customDigest=formatTemplateReviewDigest({batch,reviewInput,manifest,maxChars:6500});
    assert.ok(customDigest.length<=6500,`expected custom digest length <= 6500, got ${customDigest.length}`);
    assert.match(customDigest,/另有 \d+ 张已登记截图未内联（共 130 张）.*review-input\.json/);

    for(const [name,expectedHash] of originalHashes){
      const diskBytes=readFileSync(resolve(work,'evidence',name));
      assert.equal(createHash('sha256').update(diskBytes).digest('hex'),expectedHash);
    }
  }finally{rmSync(work,{recursive:true,force:true});}
});

test('inline review digest includes full completeness expectation, source, expectedCount, dataIdentity and inputDescription so semantic changes alter the digest',()=>{
  const task={id:'task-sem',rule:{criteria:[]}} as unknown as AutomationTask;
  const reviewInput={batchId:'completeness-1',note:'',images:[]} as unknown as ReturnType<typeof prepareTemplateReviewInput>;
  const makeManifest=(expectation:string):RequirementManifest=>({
    id:'manifest-sem',taskId:'task-sem',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',
    items:[{
      id:'lead-form',
      title:'在线报名表单与关联校验',
      kind:'interaction',
      required:true,
      source:'需求规格书第 4.2 节交互验收条款',
      expectation,
      paths:['/contact','/apply'],
      expectedCount:2,
      expectedKeys:['email','phone','departmentId'],
      dataIdentity:{kind:'relations',parentRequirementIds:['departments'],childRequirementIds:['leads']},
      viewports:['desktop','mobile'],
    }],
  });

  const manifestSave=makeManifest('提交后保存记录');
  const manifestReject=makeManifest('校验失败时禁止提交');
  const digestSave=formatTemplateReviewDigest({
    batch:{id:'completeness-1',task,manifest:manifestSave},
    reviewInput,
    manifest:manifestSave,
    inputDescription:'企业官网改版：报名表单需按部门关联写入后台并拦截非法邮箱。',
  });
  const digestReject=formatTemplateReviewDigest({
    batch:{id:'completeness-1',task,manifest:manifestReject},
    reviewInput,
    manifest:manifestReject,
    inputDescription:'企业官网改版：报名表单需按部门关联写入后台并拦截非法邮箱。',
  });

  assert.notEqual(digestSave,digestReject);
  assert.ok(digestSave.includes('expectation: 提交后保存记录'));
  assert.ok(!digestSave.includes('校验失败时禁止提交'));
  assert.ok(digestReject.includes('expectation: 校验失败时禁止提交'));
  assert.ok(!digestReject.includes('提交后保存记录'));

  for(const token of [
    '1b. 资料与业务说明 (task.json.input.description): 企业官网改版：报名表单需按部门关联写入后台并拦截非法邮箱。',
    'paths(2): /contact, /apply',
    'expectedCount=2',
    'expectedKeys(3): email, phone, departmentId',
    'dataIdentity={"kind":"relations","parentRequirementIds":["departments"],"childRequirementIds":["leads"]}',
    'source: 需求规格书第 4.2 节交互验收条款',
  ])assert.ok(digestSave.includes(token),`expected digestSave to include: ${token}`);
  assert.ok(!digestSave.includes('⚠️ 必读提示'));
  assert.ok(!digestSave.includes('已截断'));

  const modelManifest={
    items:manifestSave.items.map(i=>({...i,expectedKeys:undefined,expectedKeyCount:38})),
  };
  const digestWithKeyCount=formatTemplateReviewDigest({
    batch:{id:'completeness-1',task,manifest:manifestSave},
    reviewInput,
    manifest:modelManifest,
  });
  assert.ok(digestWithKeyCount.includes('expectedKeyCount=38'));
  assert.ok(!digestWithKeyCount.includes('⚠️ 必读提示'));
});

test('inline review digest includes full recheck detail, interaction flags and implementation request payloads',()=>{
  const task={id:'task-recheck',rule:{criteria:[]}} as unknown as AutomationTask;
  const reviewInput={batchId:'regression-issues',note:'',images:[]} as unknown as ReturnType<typeof prepareTemplateReviewInput>;
  const makeBatch=(detail:string)=>({
    id:'regression-issues',
    task,
    rechecks:[{
      id:'issue-1',
      kind:'issue' as const,
      severity:'critical' as const,
      title:'报名接口与移动端抽屉交互异常',
      detail,
      locations:[
        {role:'target',url:'https://target.test/apply',viewport:'mobile',type:'image' as const,interaction:true},
        {role:'target',url:'https://target.test/',viewport:'business',type:'implementation' as const,request:{kind:'code',id:'api-apply-submit'}},
      ],
    }],
  });

  const detailA='移动端点击立即提交按钮后未展示字段必填报错，且后台 api-apply-submit 缺少空值拦截分支，需同时复验交互态截图与代码实现。';
  const detailB='抽屉导航展开后遮挡预约表单底部提交按钮，关闭按钮点击无响应且 api-apply-submit 返回 500 错误。';
  const digestA=formatTemplateReviewDigest({batch:makeBatch(detailA),reviewInput});
  const digestB=formatTemplateReviewDigest({batch:makeBatch(detailB),reviewInput});

  assert.notEqual(digestA,digestB);
  assert.ok(digestA.includes(`detail: ${detailA}`));
  assert.ok(digestB.includes(`detail: ${detailB}`));
  assert.ok(digestA.includes('mobile:https://target.test/apply(interaction=true)'));
  assert.ok(digestA.includes('implementation:{"kind":"code","id":"api-apply-submit"}'));
  assert.ok(!digestA.includes('⚠️ 必读提示'));
});

test('inline review digest emits explicit [已截断，必读 task.json...] markers and ⚠️ 必读提示 whenever contract fields or lists are clipped',()=>{
  const reviewInput={batchId:'overlong-batch',note:'',images:[]} as unknown as ReturnType<typeof prepareTemplateReviewInput>;

  // 1) Medium instruction (> 68 chars, <= 600 chars) is preserved in full without silent ellipsis chopping.
  const mediumInstruction='检查首屏主视觉标题层级、副标题行高、主次按钮对比度、背景图裁切比例以及桌面端 1440px 与导航栏留白一致性，不得出现文字重叠或按钮折行截断。'.repeat(2);
  assert.ok(mediumInstruction.length>120&&mediumInstruction.length<=600);
  const mediumTask={id:'t-med',rule:{criteria:[{id:'hero',label:'Hero',weight:50,instruction:mediumInstruction,required:true,viewports:['desktop'],scopes:['site']}]}} as unknown as AutomationTask;
  const mediumDigest=formatTemplateReviewDigest({batch:{id:'criteria-desktop',task:mediumTask},reviewInput});
  assert.ok(mediumDigest.includes(mediumInstruction));
  assert.ok(!mediumDigest.includes('…'));
  assert.ok(!mediumDigest.includes('⚠️ 必读提示'));

  // 2) Overlong instruction, expectation, source, detail, inputDescription, paths (> 8) and expectedKeys (> 8).
  const longInstruction='规'.repeat(620);
  const longExpectation='验'.repeat(625);
  const longSource='源'.repeat(215);
  const longDetail='复'.repeat(630);
  const longDescription='资'.repeat(520);
  const manyPaths=Array.from({length:10},(_,i)=>`/section-${i}/${'p'.repeat(130)}`);
  const manyKeys=Array.from({length:11},(_,i)=>`record-key-${i}`);
  const manyLocations=Array.from({length:7},(_,i)=>({
    role:'target',
    url:`https://target.test/loc-${i}`,
    viewport:'desktop',
    type:'image' as const,
  }));

  const overlongTask={id:'t-long',rule:{criteria:[{id:'c1',label:'Long Criterion',weight:100,instruction:longInstruction,required:true,viewports:['desktop'],scopes:['site']}]}} as unknown as AutomationTask;
  const overlongManifest:RequirementManifest={
    id:'m-long',taskId:'t-long',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',
    items:[{
      id:'item-long',
      title:'Long Item',
      kind:'page',
      required:true,
      source:longSource,
      expectation:longExpectation,
      paths:manyPaths,
      expectedCount:10,
      expectedKeys:manyKeys,
      viewports:['desktop'],
    }],
  };
  const overlongDigest=formatTemplateReviewDigest({
    batch:{
      id:'mixed-overlong',
      task:overlongTask,
      manifest:overlongManifest,
      rechecks:[{id:'r1',kind:'issue',severity:'major',title:'Many locs & long detail',detail:longDetail,locations:manyLocations}],
    },
    reviewInput,
    manifest:overlongManifest,
    inputDescription:longDescription,
  });

  for(const marker of [
    '[已截断，必读 task.json.input.description]',
    '[已截断，必读 task.json.task.rule.criteria]',
    '[已截断，必读 task.json.manifest.items]',
    '(+2 more — 必读 task.json.manifest.items)',
    '[expectedKeys 已省略，必读 task.json.manifest.items]',
    '(+1 more — 必读 task.json.rechecks)',
    '[已截断，必读 task.json.rechecks]',
    '⚠️ 必读提示：上方部分验收要求、路径或说明存在截断/省略，动手判断前必须用 jq 读取 task.json 对应完整字段！',
  ])assert.ok(overlongDigest.includes(marker),`expected overlongDigest to include marker: ${marker}`);

  // 3) Tight maxChars fallback on contract sections still respects cap and emits ⚠️ 必读提示.
  const tightDigest=formatTemplateReviewDigest({
    batch:{id:'criteria-desktop',task:mediumTask},
    reviewInput,
    maxChars:512,
  });
  assert.ok(tightDigest.length<=512,`expected tightDigest.length <= 512, got ${tightDigest.length}`);
  assert.ok(tightDigest.includes('⚠️ 必读提示'));
});

test('templateBatchGuidanceContract enforces jq task.json lookup on truncation/business context and scopes pure criteria-* batches away from extend_manifest',()=>{
  const task={id:'task-guidance',rule:{criteria:[{id:'visual',label:'Visual',weight:100,instruction:'核查首屏品牌字号与留白',required:true,viewports:['desktop'],scopes:['site']}]}} as unknown as AutomationTask;
  const reviewInput={batchId:'criteria-desktop',note:'',images:[]} as unknown as ReturnType<typeof prepareTemplateReviewInput>;
  const manifest:RequirementManifest={
    id:'manifest-g',taskId:'task-guidance',revision:1,createdAt:1,sourceComplete:true,limitations:[],evidence:[],actor:'human',
    items:[{id:'pages',title:'Pages',kind:'page',required:true,source:'导航栏',expectation:'校验失败时禁止提交',paths:['/'],expectedCount:1,viewports:['desktop','mobile']}],
  };

  const criteriaBatch={id:'criteria-desktop',task};
  const criteriaDigest=formatTemplateReviewDigest({
    batch:criteriaBatch,
    reviewInput,
    inputDescription:'B2B 工业设备官网：询盘表单校验失败时禁止提交',
  });
  const criteriaGuidance=templateBatchGuidanceContract({
    batch:criteriaBatch,
    siteUrl:'https://target.test/',
    sourceUrl:'https://source.test/',
    hasFullSiteManifest:true,
    inlineDigest:'\n'+criteriaDigest+'\n',
  });
  assert.ok(criteriaGuidance.includes('1b. 资料与业务说明 (task.json.input.description): B2B 工业设备官网：询盘表单校验失败时禁止提交'));
  assert.ok(criteriaGuidance.includes('严禁浪费轮次运行 ls、wc、find 或 jq keys 探测目录布局或 JSON 键名'));
  assert.ok(criteriaGuidance.includes("必须用 jq 按字段读取 task.json（如 jq '.input.description, .manifest.items' task.json），绝不能在要求被截断时盲猜验收标准"));
  assert.ok(criteriaGuidance.includes('本批为全站评测中的纯视口视觉指标批次：只核对本视口视觉指标及当前入口页可见取证缺口，不调用 manifest/extend_manifest 审查全站页面清单，也不把其他内页清单遗漏写入本批 coverage.unverified（全站来源与交付清单覆盖由 completeness 批次专门负责）。'));
  assert.ok(!criteriaGuidance.includes('发现清单遗漏可 extend_manifest；宿主将按新增完整范围重分批'));

  const completenessBatch={id:'completeness-1',task:{...task,rule:{...task.rule!,criteria:[]}},manifest};
  const completenessDigest=formatTemplateReviewDigest({
    batch:completenessBatch,
    reviewInput,
    manifest,
    inputDescription:'B2B 工业设备官网：询盘表单校验失败时禁止提交',
  });
  const completenessGuidance=templateBatchGuidanceContract({
    batch:completenessBatch,
    siteUrl:'https://target.test/',
    sourceUrl:'https://source.test/',
    hasFullSiteManifest:true,
    inlineDigest:'\n'+completenessDigest+'\n',
  });
  assert.ok(completenessGuidance.includes('source: 导航栏 | expectation: 校验失败时禁止提交'));
  assert.ok(completenessGuidance.includes('expectedCount=1'));
  assert.ok(completenessGuidance.includes('发现清单遗漏可 extend_manifest；宿主将按新增完整范围重分批'));
  assert.ok(!completenessGuidance.includes('本批为全站评测中的纯视口视觉指标批次'));
});
