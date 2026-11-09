import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { Database } from '../server/runtime.js';
import { RequestBudget, ModelBudgetExceeded } from '../server/automation/request-budget.js';
import { usageCapture } from '../server/automation/usage-proxy.js';
import { defaultAutomationSettings, type AutomationReport, type MaterialFile } from '../shared/automation.js';
import { defaultLearningSettings, type ExperienceInput } from '../shared/experience.js';
import { ExperienceStore } from '../server/automation/experience-store.js';
import { selectExperience, adoptedGuidance, queueReflection, reflectExperience } from '../server/automation/experience.js';
import { localDecision } from '../server/automation/local-decision.js';
import { ManifestStore, validateCompleteness, inspectImplementation, sourceReader } from '../server/automation/completeness.js';
import { validateResult } from '../server/automation/evaluator.js';
import { codexClient } from '../server/automation/codex-client.js';
import { targetReached } from '../server/automation/optimization.js';
import type { Requirement, RequirementCheck } from '../shared/completeness.js';
import { inspectionTools } from '../server/automation/inspection-tools.js';
import { createAutonomousExecution } from '../shared/autonomy.js';

const experience:ExperienceInput={title:'先查交付记录',scenarios:['site-template'],stages:['generation','followup','evaluation'],conditions:'续建前不确定原会话状态',exclusions:'没有原会话',guidance:'查询实际交付回执后再决定，不重复发送。'};
test('a stopped collection decision retains only its own unknown reservation and preserves historical blockers and charges',async()=>{
  const f=await fixture();try{
    const task=f.create();task.autonomy=createAutonomousExecution('Complete collection');
    const policy={key:'collection-review',runKey:'one',maxTokens:100000,maxRequests:4},budget=new RequestBudget(f.automationStore.db,policy);
    budget.reserve('historical',Buffer.from('{}'));budget.complete('historical',null);const before=budget.state().spent;
    const createClient=(()=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){
      f.automationStore.db.prepare('INSERT INTO auto_model_requests(id,account_id,run_key,state,charged) VALUES(?,?,?,?,?)').run('this-window',policy.key,policy.runKey,'unknown',1234);
      throw new Error('test connection timeout');
    })()})})})) as unknown as typeof codexClient;
    await assert.rejects(localDecision({task,store:f.automationStore,vault:f.vault,directory:f.directory,id:randomUUID(),stage:'planning',sop:'test',context:{},policy,minutes:1,signal:new AbortController().signal,createClient,retainStoppedReservations:true,submit:()=>true}),/connection timeout/);
    assert.equal(f.automationStore.db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get('this-window').state,'retained');assert.equal(f.automationStore.db.prepare('SELECT state FROM auto_model_requests WHERE id=?').get('historical').state,'unknown');assert.equal(budget.state().unknown,1);assert.equal(budget.state().spent,before+1234);
  }finally{await f.close();}
});
const report=():AutomationReport=>({summary:'独立评测',assessments:[],scores:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},quality:'unverified',artifacts:[]});
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'learning-test-')),f=await createApp({directory,serveWeb:false,startWorker:false}),login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
  const environmentId=randomUUID();f.vault.update({threshold:80,paused:true,model:{endpoint:'https://models.invalid',name:'test',apiKey:'fake-key'},environments:[{id:environmentId,name:'test',origin:'http://kooboo.invalid',apiOrigin:'http://kooboo.invalid',token:'fake-env'}]});
  const r=f.automationStore.saveResource({name:'Source',scenario:'site-template',description:'页面与动态产品',contentUrl:'https://source.invalid',referenceUrl:'',externalSource:'',externalId:'',files:[]});
  const create=(scope:'homepage'|'site'='homepage',parentId?:string)=>f.automationStore.create({resourceIds:[r.id],environmentId,kind:'generation',scope,requirements:'',parentId},f.vault.automation())[0];
  return {...f,directory,headers,environmentId,resource:r,create,async close(){await f.app.close();rmSync(directory,{recursive:true,force:true});}};
}
test('request admission clamps output, persists cumulative use across sessions and stops unknown or repeated requests',()=>{
  const db=new Database(':memory:');try{
    const policy={key:'shared',runKey:'one',maxTokens:10000,maxRequests:3},b=new RequestBudget(db,policy);
    const outgoing=JSON.parse(b.reserve('a',Buffer.from(JSON.stringify({input:'Hello',max_output_tokens:90000}))).toString());assert.equal(outgoing.max_output_tokens,8192);
    assert.throws(()=>b.reserve('parallel',Buffer.from('{}')),ModelBudgetExceeded);b.complete('a',{input_tokens:1000,output_tokens:100});
    assert.equal(new RequestBudget(db,{...policy,runKey:'two'}).state().spent,1100);
    b.reserve('b',Buffer.from('{}'));b.complete('b',null);assert.equal(b.state().unknown,1);assert.ok(b.state().spent>1100);
    assert.throws(()=>new RequestBudget(db,{...policy,runKey:'new',maxTokens:20000}).reserve('c',Buffer.from('{}')),/缺少完整 usage/);
    const repeat=new RequestBudget(db,{key:'repeat',runKey:'one',maxTokens:100000,maxRequests:20});for(let i=0;i<3;i++){repeat.reserve(String(i),Buffer.from('{}'));repeat.complete(String(i),{input_tokens:1,output_tokens:1});}assert.throws(()=>repeat.reserve('four',Buffer.from('{}')),/无进展循环/);
    const compact=new RequestBudget(db,{key:'compact',runKey:'one',maxTokens:10000,maxRequests:2});assert.throws(()=>compact.reserve('compact',Buffer.from('{"__compact":true}')),/压缩接口/);assert.equal(compact.state().requests,0);
  }finally{db.close();}
});
test('higher defaults do not rewrite saved quotas; manual resume preserves tokens, attempts, clock and budget account',async()=>{
  const f=await fixture();try{
    assert.equal(defaultAutomationSettings.followup.maxTokens,10000000);const saved={...f.vault.automation(),followup:{...defaultAutomationSettings.followup,maxTokens:2000000},learning:{...defaultLearningSettings,use:false}};f.vault.updateAutomation(saved);
    const key=readFileSync(join(f.directory,'master.key'));assert.equal(f.vault.automation().followup.maxTokens,2000000);
    const t=f.create();f.automationStore.scheduleFollowup(t,saved.followup);t.followup!.tokens=123456;t.followup!.attempts=3;t.followup!.elapsedMs=789;t.status='interrupted';f.automationStore.put(t);const budgetId=t.followup!.budgetId;
    const settings=await f.app.inject({method:'PUT',url:'/api/automation/settings',headers:f.headers,payload:{...saved,learning:undefined,followup:{...saved.followup,maxTokens:20000000,maxRequests:90}}});assert.equal(settings.statusCode,200);assert.equal(settings.json().learning.use,false);
    const resumed=await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/resume`,headers:f.headers});assert.equal(resumed.statusCode,200);const run=resumed.json().followup;assert.equal(run.tokens,123456);assert.equal(run.attempts,3);assert.equal(run.elapsedMs,789);assert.equal(run.budgetId,budgetId);assert.equal(run.policy.maxTokens,20000000);assert.deepEqual(readFileSync(join(f.directory,'master.key')),key);
  }finally{await f.close();}
});
test('experience history is optimistic, AI cannot override manual disable, and phase snapshots stay frozen',async()=>{
  const f=await fixture();try{
    const es=new ExperienceStore(f.automationStore),e=es.save(experience,{actor:'human',reason:'测试'}),task=f.create();let calls=0;
    const decide=(async options=>{calls++;return options.submit({reason:'适用于当前阶段',selected:[{id:e.id,revision:1,reason:'有原会话'}]});}) as typeof localDecision;
    await selectExperience(task,'generation',f.automationStore,f.vault,f.directory,new AbortController().signal,decide);assert.equal(calls,1);
    es.save({...experience,guidance:'新建议'},{id:e.id,revision:1,actor:'human',reason:'修正'});
    await selectExperience(task,'generation',f.automationStore,f.vault,f.directory,new AbortController().signal,decide);assert.equal(calls,1);assert.match(adoptedGuidance(task,f.automationStore,'generation'),/查询实际交付回执/);assert.doesNotMatch(adoptedGuidance(task,f.automationStore,'generation'),/新建议/);
    assert.throws(()=>es.save(experience,{id:e.id,revision:1,actor:'ai',reason:'旧版'}),/已更新/);
    const disabled=es.save(experience,{id:e.id,revision:2,enabled:false,actor:'human',reason:'暂不采用'});assert.equal(disabled.manualDisabled,true);assert.throws(()=>es.save(experience,{id:e.id,revision:3,enabled:true,actor:'ai',reason:'尝试恢复'}),/人工停用/);assert.equal(es.candidates(task,'generation').length,0);
    const restored=await f.app.inject({method:'POST',url:`/api/automation/experiences/${e.id}/restore`,headers:f.headers,payload:{from:1,revision:3,reason:'回看初版'}});assert.equal(restored.statusCode,200);assert.equal(restored.json().revision,4);assert.equal(restored.json().enabled,false);assert.equal(es.history(e.id,1,2).items.length,2);
  }finally{await f.close();}
});
test('experience library filters scenarios and stages before pagination, combined with title and status',async()=>{
  const f=await fixture();try{
    const es=new ExperienceStore(f.automationStore);
    const add=(title:string,scenarios:ExperienceInput['scenarios'],stages:ExperienceInput['stages'],enabled=true)=>es.save({...experience,title,scenarios,stages,guidance:title+'的执行建议'},{actor:'human',reason:'筛选测试',enabled});
    const both=add('导航共用经验',['site-template','materials'],['generation','evaluation']);
    const generation=add('导航生成经验',['site-template'],['generation']);
    add('导航停用经验',['site-template'],['evaluation'],false);
    add('资料评测经验',['materials'],['evaluation']);
    add('跟进经验',['site-template'],['followup']);
    async function get(query=''){
      const response=await f.app.inject({url:'/api/automation/experiences'+query,headers:f.headers});
      assert.equal(response.statusCode,200);return response.json();
    }
    assert.equal((await get()).total,5);
    assert.equal((await get('?scenario=site-template')).total,4);
    assert.equal((await get('?stage=evaluation')).total,3);
    const selected=await get('?scenario=site-template&stage=generation&enabled=true&search='+encodeURIComponent('导航'));
    assert.equal(selected.total,2);assert.deepEqual(new Set(selected.items.map((e:{id:string})=>e.id)),new Set([both.id,generation.id]));
    const first=await get('?scenario=site-template&stage=generation&pageSize=1');
    const second=await get('?scenario=site-template&stage=generation&pageSize=1&page=2');
    assert.equal(first.total,2);assert.equal(first.pages,2);assert.equal(first.items.length,1);assert.equal(second.page,2);assert.equal(second.total,2);assert.notEqual(first.items[0].id,second.items[0].id);
    const disabled=await get('?scenario=site-template&stage=evaluation&enabled=false');
    assert.equal(disabled.total,1);assert.equal(disabled.items[0].enabled,false);
    const clamped=await get('?scenario=materials&stage=evaluation&pageSize=1&page=99');
    assert.equal(clamped.total,2);assert.equal(clamped.page,2);
    const empty=await get('?scenario=materials&stage=followup&page=99');
    assert.deepEqual({total:empty.total,pages:empty.pages,page:empty.page,items:empty.items},{total:0,pages:1,page:1,items:[]});
    for(const query of ['?scenario=unknown','?stage=unknown'])assert.equal((await f.app.inject({url:'/api/automation/experiences'+query,headers:f.headers})).statusCode,400);
  }finally{await f.close();}
});
test('new evidence deduplicates reflection, workflow shares learning budget, failed reflection rolls back and keeps valid report',async()=>{
  const f=await fixture();try{
    const es=new ExperienceStore(f.automationStore),root=f.create(),child=f.create('homepage',root.id);child.report=report();child.report.summary='本轮独立评测';child.status='completed';f.automationStore.put(child);
    const run=queueReflection(child,f.automationStore)!;assert.equal(queueReflection(child,f.automationStore)!.id,run.id);assert.equal(es.workflow(child).id,root.id);assert.equal(run.budgetId,'experience:'+root.id);
    const event=f.automationStore.events(child.id)[0],newInput={...experience,title:'新经验',guidance:'仅在当前条件成立时核查证据'};
    const good=(async options=>options.submit({reason:'有明确证据',changes:[{input:newInput,enabled:true,reason:'本次错误可复用',evidence:['event:'+event.seq]}],outcomes:[]})) as typeof localDecision;
    await reflectExperience(run,f.automationStore,f.vault,f.directory,new AbortController().signal,good);assert.equal(es.run(run.id)!.status,'completed');assert.equal(es.page().total,1);
    child.report.summary='新的独立报告';f.automationStore.put(child);const second=queueReflection(child,f.automationStore)!;assert.notEqual(second.id,run.id);assert.equal(second.budgetId,run.budgetId);
    const bad=(async options=>options.submit({reason:'无来源',changes:[{input:{...newInput,title:'不能写入'},enabled:true,reason:'伪造证据',evidence:['event:does-not-exist']}],outcomes:[]})) as typeof localDecision;
    await reflectExperience(second,f.automationStore,f.vault,f.directory,new AbortController().signal,bad);assert.equal(es.run(second.id)!.status,'failed');assert.equal(es.page().total,1);assert.equal(f.automationStore.task(child.id)!.report!.summary,'新的独立报告');
    second.status='running';es.put(second);es.recover();assert.equal(es.run(second.id)!.status,'failed');
    const response=await f.app.inject({url:`/api/automation/tasks/${root.id}/learning?pageSize=1`,headers:f.headers});assert.equal(response.statusCode,200);assert.equal((await f.app.inject({url:'/api/automation/experiences'})).statusCode,401);
  }finally{await f.close();}
});
test('reflection seeds cited evidence, pages other captures and declares an empty library without dumping execution output',async()=>{
  const f=await fixture();try{
    const task=f.create();task.report=report();task.report.issues=[{severity:'minor',title:'阅读顺序',detail:'经独立报告发现层级问题',evidence:['image-1.png']}];
    task.report.artifacts=Array.from({length:300},(_,i)=>({id:randomUUID(),name:`image-${i}.png`,type:'image/png',size:1,sha256:'0'.repeat(64)}));task.status='completed';f.automationStore.put(task);f.automationStore.event(task.id,'执行记录'.repeat(2000));
    const run=queueReflection(task,f.automationStore)!,decide=(async options=>{
      const c=options.context as {library:{total:number};evidence:string[];evidenceTotal:number;events:{id:string;message:string;truncated:boolean}[]};assert.equal(c.library.total,0);assert.ok(c.evidenceTotal>=300);assert.ok(c.evidence.length<15);assert.ok(c.evidence.some(id=>id.endsWith(':image-1.png')));assert.ok(JSON.stringify(c).length<12000);assert.equal(c.events.at(-1)!.truncated,true);
      const page=await options.read!({kind:'evidence',page:2},options.signal) as {items:{id:string}[];total:number};assert.equal(page.items.length,20);assert.equal(page.total,300);assert.ok(page.items[0].id.endsWith(':image-20.png'));
      const full=await options.read!({id:c.events.at(-1)!.id},options.signal) as {message:string};assert.ok(full.message.length>300);options.onThreadStarted?.('persisted-reflection-thread');
      return options.submit({reason:'没有需要新增的经验',changes:[],outcomes:[]});
    }) as typeof localDecision;
    await reflectExperience(run,f.automationStore,f.vault,f.directory,new AbortController().signal,decide);const saved=new ExperienceStore(f.automationStore).run(run.id)!;assert.equal(saved.status,'completed');assert.equal(saved.threadId,'persisted-reflection-thread');
  }finally{await f.close();}
});
const dataItem:Requirement={id:'products',title:'产品',kind:'data',required:true,source:'资料目录',expectation:'全部动态记录与路由对应',paths:['/products/a','/products/b'],expectedCount:2,expectedKeys:['a','b'],viewports:['business']};
const check:RequirementCheck={id:'products',status:'verified',reason:'全量记录对账',evidence:['implementation-proof.json'],checkedViewports:['business'],actualCount:2,sampledPaths:[],checkedKeys:['a','b']};
const proof:MaterialFile={id:randomUUID(),name:'implementation-proof.json',type:'application/json',size:1,sha256:'0'.repeat(64),role:'target'};
test('manifest revisions preserve required scope and fullsite checks reject missing records, screenshot-only proof and absent viewport paths',async()=>{
  const f=await fixture();try{
    const task=f.create('site'),ms=new ManifestStore(f.automationStore),manifest=ms.save(task,{sourceComplete:true,limitations:[],items:[dataItem],evidence:[]},'human');
    assert.throws(()=>ms.save(task,{sourceComplete:true,limitations:[],items:[],evidence:[]},'ai'));
    assert.throws(()=>ms.save(task,{sourceComplete:true,limitations:[],items:[{...dataItem,expectedCount:1,expectedKeys:['a'],paths:['/products/a']}],evidence:[]},'ai'),/缩减/);
    assert.equal(validateCompleteness([check],manifest,[proof]).state,'complete');assert.throws(()=>validateCompleteness([{...check,checkedKeys:['a']}],manifest,[proof]),/全部记录标识/);assert.throws(()=>validateCompleteness([{...check,evidence:[]}],manifest,[]),/证据/);assert.throws(()=>validateCompleteness([],manifest,[proof]),/逐项/);
    assert.equal(validateCompleteness([{...check,status:'unverified'}],manifest,[proof]).state,'unverified');assert.equal(validateCompleteness([{...check,status:'missing'}],manifest,[proof]).state,'incomplete');assert.equal(validateCompleteness([check],{...manifest,sourceComplete:false},[proof]).state,'unverified');
    const page={...dataItem,id:'pages',kind:'page' as const,paths:['/one','/two'],viewports:['desktop','mobile'] as ('desktop'|'mobile')[]},pixels=[...['desktop','mobile'] as const].map(v=>({...proof,name:v+'.png',type:'image/png',viewport:v}));
    assert.throws(()=>validateCompleteness([{...check,id:'pages',sampledPaths:['/one','/two'],checkedViewports:['desktop','mobile'],evidence:pixels.map(p=>p.name)}],{...manifest,items:[page]},pixels,Object.fromEntries(pixels.map(p=>[p.name,{url:'https://target.test/one',role:'target',viewport:p.viewport!}]))),/two.*缺少/);
    const child=f.create('site',task.id);assert.equal(child.requirementsId,manifest.id);assert.equal(child.requirementsEnabled,true);assert.notEqual(f.create('homepage').requirementsEnabled,true);
  }finally{await f.close();}
});
test('fullsite completeness is independent from visual score and required to reach optimization goal',async()=>{
  const f=await fixture();try{
    const task=f.create('site'),manifest=new ManifestStore(f.automationStore).save(task,{sourceComplete:true,limitations:[],items:[dataItem],evidence:[]},'human');task.rule={...task.rule!,criteria:[{id:'implementation',label:'实现',weight:100,instruction:'检查',required:true,viewports:['business'],scopes:['site']}]};
    const raw={summary:'UI好',assessments:[{criterionId:'implementation',viewport:'business',score:95,reason:'证据',evidence:[proof.name],passed:true}],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},completeness:[{...check,status:'missing'}]};
    const result=validateResult(raw,task,[proof],80,false,manifest);assert.equal(result.scores[0].value,95);assert.equal(result.quality,'failed');assert.throws(()=>validateResult({...raw,completeness:undefined},task,[proof],80,false,manifest));
    task.optimization={policy:{targetScore:85,maxRounds:3,maxCostCny:null,sop:'test'}} as typeof task.optimization;result.scores=[{viewport:'desktop',value:99},{viewport:'mobile',value:99}];assert.equal(targetReached(task,result),false);
    delete task.optimization;task.report=result;task.status='completed';f.automationStore.put(task);const response=await f.app.inject({url:`/api/automation/tasks/${task.id}/completeness?pageSize=1`,headers:f.headers});assert.equal(response.json().total,1);assert.equal(response.json().items[0].status,'missing');
  }finally{await f.close();}
});
async function listen(server:ReturnType<typeof createServer>){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:ReturnType<typeof createServer>){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
test('relay stops the second request before upstream, including a new relay session using the same account',async()=>{
  const f=await fixture();let calls=0,output=0;
  const upstream=createServer(async(req,res)=>{calls++;let text='';for await(const c of req)text+=c;output=JSON.parse(text).max_output_tokens;res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:0}}}})+'\n\n');});let relay:Awaited<ReturnType<typeof usageCapture>>|undefined;
  try{const endpoint=await listen(upstream);f.vault.update({...f.vault.get(),model:{endpoint,name:'test',apiKey:'fake-key'}});const task=f.create(),policy={key:'followup-test',runKey:'same',maxTokens:100000,maxRequests:1};relay=await usageCapture(task.id,'followup',f.automationStore,f.vault,new AbortController().signal,policy);
    const call=()=>fetch(relay!.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers:{authorization:'Bearer '+relay!.env.EVALUATOR_MODEL_KEY,'content-type':'application/json'},body:JSON.stringify({model:'test',input:'hello',max_output_tokens:90000})});
    let response=await call();assert.equal(response.status,200);await response.text();assert.equal(output,8192);await relay.close();relay=await usageCapture(task.id,'followup',f.automationStore,f.vault,new AbortController().signal,policy);response=await call();assert.equal(response.status,429);assert.equal(calls,1);assert.ok(relay.error instanceof ModelBudgetExceeded);assert.equal(new RequestBudget(f.automationStore.db,policy).state().spent,110);
  }finally{await relay?.close();await close(upstream);await f.close();}
});
test('relay records an actionable transport failure while preserving unknown usage and reservation',async()=>{
  const f=await fixture(),upstream=createServer(req=>req.socket.destroy());let relay:Awaited<ReturnType<typeof usageCapture>>|undefined;
  try{
    const endpoint=await listen(upstream);f.vault.update({...f.vault.get(),model:{endpoint,name:'test',apiKey:'fake-key'}});const task=f.create(),policy={key:'transport',runKey:'same',maxTokens:100000,maxRequests:3};
    relay=await usageCapture(task.id,'experience',f.automationStore,f.vault,new AbortController().signal,policy);
    const result=await fetch(relay.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers:{authorization:'Bearer '+relay.env.EVALUATOR_MODEL_KEY,'content-type':'application/json'},body:'{}'});assert.equal(result.status,502);assert.match(await result.text(),/模型上游连接失败/);assert.match(relay.error!.message,/预占保留/);
    const entries=f.automationStore.usage.entries(task.id);assert.equal(entries.length,1);assert.equal(entries[0].tokens,null);assert.match(entries[0].note,/模型上游连接失败/);assert.ok(!entries[0].note.includes('fake-key'));const state=new RequestBudget(f.automationStore.db,policy).state();assert.equal(state.unknown,1);assert.ok(state.spent>0);
  }finally{await relay?.close();await close(upstream);await f.close();}
});
test('implementation inspection uses fixed read-only contracts and rejects arbitrary methods, SQL, origins and paths',async()=>{
  const f=await fixture();const requests:string[]=[];const server=createServer((req,res)=>{requests.push(req.method+' '+req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({totalCount:2,list:[{id:'a'},{id:'b'}]}));});
  try{const endpoint=await listen(server);f.vault.update({...f.vault.get(),environments:f.vault.get().environments.map(e=>({...e,apiOrigin:endpoint}))});const task=f.create('site');task.generatedSiteId=randomUUID();f.automationStore.saveSite({id:task.generatedSiteId,resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId:randomUUID(),name:'target',url:endpoint,createdAt:Date.now()});
    await inspectImplementation(task,f.automationStore,f.vault,new AbortController().signal,{kind:'rows',table:'products',page:2});assert.match(requests[0],/^GET .*Sqlite\/Data\?/);assert.match(requests[0],/pageNr=2/);assert.match(requests[0],/table=products/);
    await inspectImplementation(task,f.automationStore,f.vault,new AbortController().signal,{kind:'products',page:2});assert.match(requests[1],/^POST .*productManagement\/PagingList\?/);
    await assert.rejects(inspectImplementation(task,f.automationStore,f.vault,new AbortController().signal,{kind:'run_kscript',sql:'delete'}));assert.equal(requests.length,2);
    const reader=sourceReader(task,f.automationStore,f.directory,v=>v);await assert.rejects(reader({kind:'source',url:endpoint},new AbortController().signal),/来源站域名/);
  }finally{await close(server);await f.close();}
});
test('local AI commits only through authenticated validated host submission and does not infer success from an essay',async()=>{
  const f=await fixture();try{
    let committed=false,threadId='';const task=f.create();
    const createClient=((_v:Parameters<typeof codexClient>[0],_d:string,env:Record<string,string>)=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){
      const call=(payload:unknown,key=env.DECISION_TOOLS_TOKEN)=>fetch(env.DECISION_TOOLS_URL,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload)});
      yield {type:'thread.started',thread_id:'decision-thread'};
      const budget=await call({tool:'budget'});assert.equal(budget.status,200);assert.equal((await budget.json()).remainingTokens,10000);const ctx=await call({tool:'context'});assert.equal((await ctx.json()).decisionBudget.remainingRequests,2);
      assert.equal((await call({tool:'context'},'wrong')).status,401);assert.equal((await call({tool:'submit',result:{invalid:true}})).status,400);assert.equal((await call({tool:'submit',result:{ok:true}})).status,200);yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};
    })()})})})) as unknown as typeof codexClient;
    const result=await localDecision({task,store:f.automationStore,vault:f.vault,directory:f.directory,id:randomUUID(),stage:'experience',sop:'test',context:{},policy:{key:'job',runKey:'one',maxTokens:10000,maxRequests:2},minutes:1,signal:new AbortController().signal,createClient,onThreadStarted:id=>{threadId=id;},submit:raw=>{assert.deepEqual(raw,{ok:true});committed=true;return 'accepted';}});assert.equal(result,'accepted');assert.equal(committed,true);assert.equal(threadId,'decision-thread');
    const essayClient=(()=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'建议这样做'}};})()})})})) as unknown as typeof codexClient;
    const base={task,store:f.automationStore,vault:f.vault,directory:f.directory,stage:'experience' as const,sop:'test',context:{},policy:{key:'essay',runKey:'one',maxTokens:10000,maxRequests:2},minutes:1,signal:new AbortController().signal,createClient:essayClient,submit:()=>true};
    await assert.rejects(localDecision({...base,id:randomUUID()}),/未提交有效结果/);
    f.automationStore.db.prepare('INSERT INTO auto_decision_clock VALUES(?,?,NULL,NULL)').run('expired',60000);
    await assert.rejects(localDecision({...base,id:'expired'}),/恢复不会重置计时/);
  }finally{await f.close();}
});
test('manual unknown-usage acknowledgement retains the reservation and missing billing, without resetting tokens',async()=>{
  const f=await fixture();try{
    const t=f.create(),id=randomUUID(),policy={key:'unknown',runKey:'same',maxTokens:10000,maxRequests:4},budget=new RequestBudget(f.automationStore.db,policy);budget.reserve(id,Buffer.from('{}'));budget.complete(id,null);
    f.automationStore.usage.record(t.id,{id,source:'codex',stage:'experience',model:'test',endpoint:'https://models.invalid',startedAt:1,endedAt:2,status:'failed',basis:'request',raw:null});const spent=budget.state().spent;
    const endpoint=`/api/automation/tasks/${t.id}/budget/acknowledge`,payload={requestId:id,reason:'人工已核查原请求停止，保留估算占用'};
    assert.equal((await f.app.inject({method:'POST',url:endpoint,payload})).statusCode,401);
    const result=await f.app.inject({method:'POST',url:endpoint,headers:f.headers,payload});assert.equal(result.statusCode,200);assert.equal(result.json().retainedTokens,spent);assert.equal(budget.state().spent,spent);assert.equal(budget.state().unknown,0);assert.equal(f.automationStore.task(t.id)!.usage!.missing,1);
  }finally{await f.close();}
});
test('explicit read aliases preserve host validation and cannot submit a decision',async()=>{
  const f=await fixture();try{
    const task=f.create(),reads:unknown[]=[];let committed=false;
    const createClient=((_v:Parameters<typeof codexClient>[0],_d:string,env:Record<string,string>)=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){
      const call=(payload:unknown)=>fetch(env.DECISION_TOOLS_URL,{method:'POST',headers:{authorization:'Bearer '+env.DECISION_TOOLS_TOKEN,'content-type':'application/json'},body:JSON.stringify(payload)});
      assert.equal((await call({tool:'diagnose',url:'https://known.example/asset'})).status,200);
      assert.equal((await call({tool:'diagnose',input:{url:'https://known.example/asset',kind:'submit'}})).status,200);
      assert.equal((await call({tool:'diagnose',url:'https://unknown.example/asset'})).status,400);
      assert.equal((await call({tool:'network',url:'https://known.example/asset'})).status,400);
      assert.equal(committed,false);assert.equal((await call({tool:'submit',result:{ok:true}})).status,200);
      yield {type:'turn.completed',usage:{input_tokens:0,output_tokens:0}};
    })()})})})) as unknown as typeof codexClient;
    const result=await localDecision({task,store:f.automationStore,vault:f.vault,directory:f.directory,id:randomUUID(),stage:'planning',sop:'test',context:{},policy:{key:'read-alias',runKey:'one',maxTokens:10000,maxRequests:2},minutes:1,signal:new AbortController().signal,createClient,readAliases:['diagnose'],read:async raw=>{assert.deepEqual(raw,{url:'https://known.example/asset',kind:'diagnose'});reads.push(raw);return {saved:true};},submit:raw=>{assert.deepEqual(raw,{ok:true});committed=true;return true;}});
    assert.equal(result,true);assert.equal(committed,true);assert.equal(reads.length,2);
  }finally{await f.close();}
});
test('a reflection draft without a tool envelope is host-validated and can be replayed after the model request limit without a new request',async()=>{
  const f=await fixture();try{
    const task=f.create(),policy={key:'exhausted-draft',runKey:'same',maxTokens:10000,maxRequests:1},budget=new RequestBudget(f.automationStore.db,policy);budget.reserve('used',Buffer.from('{}'));budget.complete('used',{input_tokens:100,output_tokens:10});
    const draft={reason:'报告支持一项可复用检查',changes:[],outcomes:[]};let validations=0;
    const createClient=((_v:Parameters<typeof codexClient>[0],_d:string,env:Record<string,string>)=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){
      const response=await fetch(env.DECISION_TOOLS_URL,{method:'POST',headers:{authorization:'Bearer '+env.DECISION_TOOLS_TOKEN,'content-type':'application/json'},body:JSON.stringify(draft)});assert.equal(response.status,200);yield {type:'turn.completed',usage:{input_tokens:0,output_tokens:0}};
    })()})})})) as unknown as typeof codexClient;
    const result=await localDecision({task,store:f.automationStore,vault:f.vault,directory:f.directory,id:randomUUID(),stage:'experience',sop:'恢复同一次已生成提交',context:{},policy,minutes:1,signal:new AbortController().signal,createClient,submit:value=>{validations++;assert.deepEqual(value,draft);return 'validated';}});
    assert.equal(result,'validated');assert.equal(validations,1);assert.equal(budget.state().requests,1);assert.equal(budget.state().spent,110);assert.equal(f.automationStore.usage.entries(task.id).length,0);
  }finally{await f.close();}
});
test('independent source review can extend a manifest but cannot remove old requirements; source evidence is hashed and readable',async()=>{
  const f=await fixture(),server=createServer((_req,res)=>res.end('<html><a href="/one">One</a></html>'));let tools:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    const endpoint=await listen(server);f.automationStore.saveResource({...f.resource,contentUrl:endpoint},f.resource.id,f.resource.revision);const task=f.create('site'),ms=new ManifestStore(f.automationStore),original=ms.save(task,{sourceComplete:false,limitations:['待复核'],items:[dataItem],evidence:[]},'human');
    tools=await inspectionTools(task,f.automationStore,f.vault,f.directory,join(f.directory,'automation-runs',task.id),[],new AbortController().signal);
    const call=(value:unknown)=>fetch(tools!.env.INSPECTION_URL,{method:'POST',headers:{authorization:'Bearer '+tools!.env.INSPECTION_TOKEN,'content-type':'application/json'},body:JSON.stringify(value)});
    const read=await call({tool:'source',input:{kind:'source',role:'content'}});assert.equal(read.status,200);const evidence=(await read.json()).evidence;
    const next={sourceComplete:true,limitations:[],items:[dataItem,{id:'page',title:'页面',kind:'page',required:true,source:evidence,expectation:'双端页面',paths:['/one'],expectedCount:1,viewports:['desktop','mobile']}],evidence:[evidence]};
    const extended=await call({tool:'extend_manifest',input:next});assert.equal(extended.status,200);const revision=(await extended.json()).manifest;assert.equal(revision.revision,2);assert.notEqual(revision.id,original.id);
    assert.equal((await call({tool:'extend_manifest',input:{...next,items:next.items.slice(1)}})).status,400);assert.equal(ms.get(task.requirementsId)!.id,revision.id);
    const url=`/api/automation/tasks/${task.id}/manifest/evidence/${evidence}`;assert.equal((await f.app.inject({url,headers:f.headers})).statusCode,200);writeFileSync(join(f.directory,'manifest-runs',task.id,'evidence',evidence),'changed');assert.equal((await f.app.inject({url,headers:f.headers})).statusCode,409);
  }finally{await tools?.close();await close(server);await f.close();}
});
test('exhausted evidence reads still allow bounded manifest queries and gap-preserving updates',async()=>{
  const f=await fixture();let sourceReads=0;const server=createServer((_req,res)=>{sourceReads++;res.end('<html>Source</html>');});let tools:Awaited<ReturnType<typeof inspectionTools>>|undefined;
  try{
    const endpoint=await listen(server);f.automationStore.saveResource({...f.resource,contentUrl:endpoint},f.resource.id,f.resource.revision);const task=f.create('site'),ms=new ManifestStore(f.automationStore);
    ms.save(task,{sourceComplete:false,limitations:['范围尚未完整'],items:[dataItem],evidence:[]},'human');
    tools=await inspectionTools(task,f.automationStore,f.vault,f.directory,join(f.directory,'automation-runs',task.id),[],new AbortController().signal);
    const call=(value:unknown)=>fetch(tools!.env.INSPECTION_URL,{method:'POST',headers:{authorization:'Bearer '+tools!.env.INSPECTION_TOKEN,'content-type':'application/json'},body:JSON.stringify(value)});
    const source=await call({tool:'source',input:{kind:'source',role:'content'}});assert.equal(source.status,200);const evidence=(await source.json()).evidence;
    for(let i=1;i<300;i++){const r=await call({tool:'unsupported'});assert.equal(r.status,400);await r.text();}
    const exhausted=await call({tool:'source',input:{kind:'source',role:'content'}});assert.equal(exhausted.status,400);assert.match((await exhausted.json()).error,/只读取证达到/);assert.equal(sourceReads,1);
    const manifest=await call({tool:'manifest'});assert.equal(manifest.status,200);assert.equal((await manifest.json()).manifest.sourceComplete,false);
    const next={sourceComplete:false,limitations:['来源取证已耗尽，未覆盖部分仍待核验'],items:[dataItem],evidence:[evidence]};
    const extended=await call({tool:'extend_manifest',input:next});assert.equal(extended.status,200);const revision=(await extended.json()).manifest;assert.equal(revision.revision,2);assert.equal(revision.sourceComplete,false);assert.deepEqual(revision.limitations,next.limitations);
    assert.equal((await call({tool:'extend_manifest',input:{...next,items:[{...dataItem,required:false}]}})).status,400);
    for(let i=3;i<20;i++){const r=await call({tool:'manifest'});assert.equal(r.status,200);await r.json();}
    const controlLimit=await call({tool:'manifest'});assert.equal(controlLimit.status,400);assert.match((await controlLimit.json()).error,/清单查询与补充达到/);assert.equal(ms.get(task.requirementsId)!.id,revision.id);assert.equal(sourceReads,1);
  }finally{await tools?.close();await close(server);await f.close();}
});
test('source material reads retain binary originals and do not decode images as fabricated text',async()=>{
  const f=await fixture();try{
    const {createHash}=await import('node:crypto'),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aouUAAAAASUVORK5CYII=','base64'),file={id:randomUUID(),name:'images/logo.png',type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    mkdirSync(join(f.directory,'materials'),{recursive:true});writeFileSync(join(f.directory,'materials',file.id),bytes);f.automationStore.saveResource({...f.resource,files:[file]},f.resource.id,f.resource.revision);const task=f.create('site');let evidence:unknown;
    const reader=sourceReader(task,f.automationStore,f.directory,v=>{evidence=v;return {evidence:'file-proof',result:v};}),value=await reader({kind:'material',id:file.id},new AbortController().signal) as {imagePath:string};assert.equal(value.imagePath,join(f.directory,'materials',file.id));assert.deepEqual(readFileSync(value.imagePath),bytes);assert.equal('text' in (evidence as object),false);assert.equal('imagePath' in (evidence as object),false);
    writeFileSync(value.imagePath,'changed');await assert.rejects(reader({kind:'material',id:file.id},new AbortController().signal),/资料校验失败/);
  }finally{await f.close();}
});
