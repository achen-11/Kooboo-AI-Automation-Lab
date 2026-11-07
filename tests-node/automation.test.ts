import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, type AutomationTask } from '../shared/automation.js';
import { AutomationWorker, type Execute } from '../server/automation/worker.js';
import { responsesBaseUrl, validateResult } from '../server/automation/evaluator.js';
import { UnconfirmedStop } from '../server/automation/errors.js';

const resourceInput={name:'Migration sample',scenario:'migration' as const,description:'公司介绍与产品目录',contentUrl:'https://content.test/',referenceUrl:'',externalSource:'external-admin',externalId:'001',files:[]};
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'automation-test-'));
  const services=await createApp({directory,serveWeb:false,startWorker:false});
  const login=await services.app.inject({method:'POST',url:'/api/login'});
  const cookie=String(login.headers['set-cookie']).split(';')[0];
  const headers={cookie};
  const environmentId=randomUUID();
  services.vault.update({threshold:80,paused:true,execution:{timeoutSeconds:300,captureAttempts:2},model:{endpoint:'https://model.test/v1',name:'test',apiKey:'test-only-key'},environments:[{id:environmentId,name:'Test',origin:'https://kooboo.test',apiOrigin:'https://kooboo.test',token:'test-only-token'}]});
  const save=async(input=resourceInput)=>(await services.app.inject({method:'POST',url:'/api/automation/resources',headers,payload:input})).json();
  return {...services,directory,headers,environmentId,save,async close(){await services.app.close();rmSync(directory,{recursive:true,force:true});}};
}

test('resource versions and one-to-many sites retain frozen task inputs; batch submission is atomic and idempotent',async()=>{
  const f=await fixture();try{
    const first=await f.save(),second=await f.save({...resourceInput,externalId:'002'});
    const input={resourceIds:[first.id,second.id],kind:'generation',scope:'homepage',environmentId:f.environmentId,requirements:'保持内容'};
    const headers={...f.headers,'idempotency-key':'batch-request-0001'};
    const created=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers,payload:input});assert.equal(created.statusCode,201);
    const tasks=created.json().items as AutomationTask[];assert.equal(tasks.length,2);
    const retry=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers,payload:input});assert.deepEqual(retry.json(),created.json());assert.equal(f.automationStore.tasks().length,2);
    const conflict=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers,payload:{...input,scope:'site'}});assert.equal(conflict.statusCode,409);
    const update=await f.app.inject({method:'PUT',url:`/api/automation/resources/${first.id}`,headers:f.headers,payload:{...resourceInput,description:'Updated content',revision:1}});assert.equal(update.statusCode,200);
    assert.equal(f.automationStore.version(tasks[0].versionId).description,resourceInput.description);
    assert.equal(f.automationStore.versions(first.id).length,2);
    assert.equal((await f.app.inject({method:'PUT',url:`/api/automation/resources/${first.id}`,headers:f.headers,payload:{...resourceInput,revision:1}})).statusCode,409);
    const invalid=await f.app.inject({method:'POST',url:'/api/automation/tasks',headers:{...f.headers,'idempotency-key':'atomic-invalid'},payload:{...input,resourceIds:[first.id,randomUUID()]}});assert.equal(invalid.statusCode,409);assert.equal(f.automationStore.tasks().length,2);
    for(let i=0;i<2;i++)assert.equal((await f.app.inject({method:'POST',url:'/api/automation/sites',headers:f.headers,payload:{resourceId:first.id,environmentId:f.environmentId,siteId:randomUUID(),name:'Site '+i,url:`https://site-${i}.test`}})).statusCode,200);
    assert.equal(f.automationStore.sites(first.id).length,2);
  }finally{await f.close();}
});

test('external import updates versions atomically and report read tokens have no write access',async()=>{
  const f=await fixture();try{
    const ingest={authorization:`Bearer ${f.vault.credentials.ingestToken}`},read={authorization:`Bearer ${f.vault.credentials.readToken}`};
    const first=await f.app.inject({method:'POST',url:'/api/v1/resources/import',headers:ingest,payload:[resourceInput]});assert.equal(first.statusCode,200);
    const next=await f.app.inject({method:'POST',url:'/api/v1/resources/import',headers:ingest,payload:[{...resourceInput,description:'revision 2'}]});assert.equal(next.statusCode,200);assert.equal(first.json().items[0].id,next.json().items[0].id);assert.equal(next.json().items[0].revision,2);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/resources/import',headers:read,payload:[resourceInput]})).statusCode,401);
    assert.equal((await f.app.inject({url:'/api/v1/automation/reports',headers:ingest})).statusCode,401);
    assert.equal((await f.app.inject({url:'/api/v1/automation/reports',headers:read})).statusCode,200);
    const r=next.json().items[0];const site={id:randomUUID(),resourceId:r.id,versionId:f.automationStore.versions(r.id)[0].id,environmentId:f.environmentId,siteId:randomUUID(),name:'Generated',url:'https://generated.test',createdAt:Date.now()};f.automationStore.saveSite(site);
    const task=f.automationStore.create({resourceIds:[r.id],kind:'evaluation',scope:'site',environmentId:f.environmentId,generatedSiteId:site.id,requirements:''},defaultAutomationSettings)[0];
    const publicList=await f.app.inject({url:'/api/v1/automation/reports?externalSource=external-admin&externalId=001',headers:read});assert.equal(publicList.json().total,1);assert.equal(publicList.json().items[0].id,task.id);assert.equal(publicList.json().items[0].report,null);
    assert.equal((await f.app.inject({url:'/api/v1/automation/reports?externalId=other',headers:read})).json().total,0);
    assert.equal((await f.app.inject({url:`/api/v1/automation/reports/${task.id}`,headers:read})).statusCode,200);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/followup`,headers:read,payload:{requirements:'edit'}})).statusCode,401);
  }finally{await f.close();}
});

test('rules accept variable criteria with required checks, scope and viewport applicability; publication never rewrites tasks',async()=>{
  const f=await fixture();try{
    const resource=await f.save();const site={id:randomUUID(),resourceId:resource.id,versionId:f.automationStore.versions(resource.id)[0].id,environmentId:f.environmentId,siteId:randomUUID(),name:'Generated',url:'https://generated.test',createdAt:Date.now()};f.automationStore.saveSite(site);
    const create=()=>f.automationStore.create({resourceIds:[resource.id],kind:'evaluation',scope:'homepage',environmentId:f.environmentId,generatedSiteId:site.id,requirements:''},defaultAutomationSettings)[0];
    const before=create();const original=before.rule!;assert.deepEqual(original.criteria.map(c=>c.weight),[40,40,20]);
    const payload={name:'Custom completeness',kind:'site',sop:'Custom SOP',references:'Case notes',criteria:[{id:'completeness',label:'完整度',weight:100,instruction:'检查动态数据与路由证据',required:true,viewports:['desktop','mobile'],scopes:['homepage','site']}]};
    const published=await f.app.inject({method:'POST',url:'/api/automation/rules',headers:f.headers,payload});assert.equal(published.statusCode,201);
    const after=create();assert.equal(after.rule?.id,published.json().id);assert.deepEqual(f.automationStore.task(before.id)!.rule,original);
    const invalid=await f.app.inject({method:'POST',url:'/api/automation/rules',headers:f.headers,payload:{...payload,criteria:[{...payload.criteria[0],weight:60}]}});assert.equal(invalid.statusCode,400);
  }finally{await f.close();}
});

test('global queue limits span batches and keep a site locked until execution actually settles',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;try{
    const resource=await f.save();const settings={...defaultAutomationSettings,enabled:true,generationConcurrency:2};f.vault.updateAutomation(settings);
    const create=()=>f.automationStore.create({resourceIds:[resource.id],kind:'generation',scope:'homepage',environmentId:f.environmentId,requirements:''},settings)[0];
    const a=create(),b=create(),c=create();const releases=new Map<string,()=>void>();const signals=new Map<string,AbortSignal>();
    const execute:Execute=async(task,_s,_v,_d,signal)=>{signals.set(task.id,signal);await new Promise<void>(resolve=>releases.set(task.id,resolve));signal.throwIfAborted();};
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:execute,evaluation:execute},()=>true);
    await worker.tick();assert.equal(releases.size,2);assert.equal(f.automationStore.task(c.id)!.status,'queued');
    const current=f.automationStore.task(a.id)!;current.status='cancelling';f.automationStore.put(current);worker.cancel(a.id);assert.equal(signals.get(a.id)?.aborted,true);
    await worker.tick();assert.equal(f.automationStore.task(c.id)!.status,'queued','abort request alone must not release a slot');
    releases.get(a.id)!();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.automationStore.task(a.id)!.status,'cancelled');assert.equal(f.automationStore.task(c.id)!.status,'running');
    releases.get(b.id)!();releases.get(c.id)!();await new Promise(resolve=>setTimeout(resolve,20));
    const site={id:randomUUID(),resourceId:resource.id,versionId:f.automationStore.versions(resource.id)[0].id,environmentId:f.environmentId,siteId:randomUUID(),name:'Same target',url:'https://generated.test',createdAt:Date.now()};f.automationStore.saveSite(site);
    const g=f.automationStore.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:f.environmentId,generatedSiteId:site.id,requirements:''},settings)[0];
    f.automationStore.create({resourceIds:[resource.id],kind:'evaluation',scope:'site',environmentId:f.environmentId,generatedSiteId:site.id,requirements:''},settings);
    assert.equal(f.automationStore.claim('generation',2)?.id,g.id);assert.equal(f.automationStore.claim('evaluation',1),undefined);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('recovered executions remain pending and locked until explicitly confirmed; no silent redelivery',async()=>{
  const f=await fixture();try{
    const r=await f.save();const t=f.automationStore.create({resourceIds:[r.id],kind:'generation',scope:'homepage',environmentId:f.environmentId,requirements:''},defaultAutomationSettings)[0];
    f.automationStore.claim('generation',1);f.automationStore.recover();assert.equal(f.automationStore.task(t.id)!.status,'pending');assert.equal(f.automationStore.task(t.id)!.stopped,false);
    assert.equal(f.automationStore.claim('generation',1),undefined);
    const stopped=await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/confirm-stopped`,headers:f.headers});assert.equal(stopped.statusCode,200);assert.equal(stopped.json().stopped,true);
    assert.equal(f.automationStore.tasks().length,1);
  }finally{await f.close();}
});

test('weighted scores are computed by the platform; missing evidence, null scores, and required failures retain their meaning',async()=>{
  const f=await fixture();try{
    const r=await f.save();const site={id:randomUUID(),resourceId:r.id,versionId:f.automationStore.versions(r.id)[0].id,environmentId:f.environmentId,siteId:randomUUID(),name:'Target',url:'https://generated.test',createdAt:Date.now()};f.automationStore.saveSite(site);
    const task=f.automationStore.create({resourceIds:[r.id],kind:'evaluation',scope:'homepage',environmentId:f.environmentId,generatedSiteId:site.id,requirements:''},defaultAutomationSettings)[0];
    const file={id:randomUUID(),name:randomUUID()+'.png',type:'image/png',size:100,sha256:'a'.repeat(64),role:'target' as const,viewport:'desktop' as const};
    const mobile={...file,id:randomUUID(),name:randomUUID()+'.png',viewport:'mobile' as const};
    const artifacts=[file,mobile];
    const result={summary:'Verified',assessments:task.rule!.criteria.flatMap((c,i)=>c.viewports.map(viewport=>({criterionId:c.id,viewport,score:[100,80,60][i],reason:'Evidence reviewed',evidence:[viewport==='mobile'?mobile.name:file.name],passed:true}))),issues:[],coverage:{verified:['首页'],unverified:[] as string[],outOfScope:['内页']}};
    assert.deepEqual(validateResult(result,task,artifacts,80).scores,[{viewport:'desktop',value:84},{viewport:'mobile',value:84}]);
    assert.equal(validateResult(result,task,artifacts,80).quality,'passed');
    const unknown=structuredClone(result);unknown.coverage.unverified=['交互没有验证'];assert.equal(validateResult(unknown,task,artifacts,80).quality,'unverified');
    assert.throws(()=>validateResult(result,task,[],80),/证据/);
    assert.throws(()=>validateResult(result,task,[file],80),/证据/);
    assert.throws(()=>validateResult(result,task,artifacts,80,true),/角色/);
    const duplicate=structuredClone(result);duplicate.assessments.push(duplicate.assessments[0]);assert.throws(()=>validateResult(duplicate,task,artifacts,80),/指标与视口/);
    task.rule!.criteria[0].required=true;result.assessments[0].passed=false;assert.equal(validateResult(result,task,artifacts,80).quality,'failed');
  }finally{await f.close();}
});

test('attachment ingestion validates metadata and blocks path traversal without requiring README',async()=>{
  const f=await fixture();try{
    const response=await f.app.inject({method:'POST',url:'/api/automation/files',headers:f.headers,payload:{name:'资料/说明.txt',type:'text/plain',content:Buffer.from('Materials').toString('base64')}});assert.equal(response.statusCode,201);
    const saved=await f.app.inject({method:'POST',url:'/api/automation/resources',headers:f.headers,payload:{...resourceInput,files:[response.json()]}});assert.equal(saved.statusCode,201);
    const malicious=await f.app.inject({method:'POST',url:'/api/automation/files',headers:f.headers,payload:{name:'../escape',type:'text/plain',content:'eA=='}});assert.equal(malicious.statusCode,400);
    const forged=await f.app.inject({method:'POST',url:'/api/automation/resources',headers:f.headers,payload:{...resourceInput,externalId:'002',files:[{...response.json(),sha256:'b'.repeat(64)}]}});assert.equal(forged.statusCode,409);
  }finally{await f.close();}
});

test('generation automatically hands evaluation the original input version even if resource data changed',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;try{
    const r=await f.save();const settings={...defaultAutomationSettings,enabled:true,autoEvaluate:true};f.vault.updateAutomation(settings);
    const original=f.automationStore.create({resourceIds:[r.id],kind:'generation',scope:'homepage',environmentId:f.environmentId,requirements:''},settings)[0];
    const generation:Execute=async task=>{
      f.automationStore.saveResource({...resourceInput,description:'new inputs after kickoff'},r.id,r.revision);
      const site={id:randomUUID(),resourceId:r.id,versionId:task.versionId,environmentId:f.environmentId,siteId:randomUUID(),name:'Auto generated',url:'https://generated.test/',createdAt:Date.now()};f.automationStore.saveSite(site);task.generatedSiteId=site.id;task.siteUrl=site.url;
    };
    const evaluation:Execute=async()=>{};
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation,evaluation},()=>true);
    await worker.tick();await new Promise(resolve=>setTimeout(resolve,30));
    const tasks=f.automationStore.tasks();const result=tasks.find(t=>t.kind==='evaluation')!;assert.ok(result);assert.equal(result.parentId,original.id);assert.equal(result.versionId,original.versionId);assert.equal(result.scope,'homepage');assert.equal(result.status,'completed');assert.equal(tasks.length,2);
  }finally{if(worker)await worker.stop();await f.close();}
});

test('Responses base URL conversion supports existing full Chat Completions endpoint without exposing URL credentials',()=>{
  assert.equal(responsesBaseUrl('https://api.deepseek.com/chat/completions'),'https://api.deepseek.com');
  assert.equal(responsesBaseUrl('https://provider.test/v1/responses'),'https://provider.test/v1');
  assert.equal(responsesBaseUrl('https://provider.test/v1/'),'https://provider.test/v1');
  assert.throws(()=>responsesBaseUrl('https://provider.test/v1?key=secret'));
  assert.throws(()=>responsesBaseUrl('https://name:secret@provider.test/v1'));
});

test('failed cancellation cleanup creates a clear interruption and keeps the slot until stop can be confirmed',async()=>{
  const f=await fixture();let worker:AutomationWorker|undefined;try{
    const r=await f.save();const settings={...defaultAutomationSettings,enabled:true,generationConcurrency:1};f.vault.updateAutomation(settings);
    const task=f.automationStore.create({resourceIds:[r.id],kind:'generation',scope:'homepage',environmentId:f.environmentId,requirements:''},settings)[0];
    let reject:(e:Error)=>void=()=>{};
    const execute:Execute=async()=>new Promise<void>((_resolve,fail)=>{reject=fail;});
    worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:execute,evaluation:execute},()=>true);
    await worker.tick();const running=f.automationStore.task(task.id)!;running.status='cancelling';f.automationStore.put(running);worker.cancel(task.id);reject(new UnconfirmedStop('Cleanup not confirmed'));
    await new Promise(resolve=>setTimeout(resolve,20));
    const after=f.automationStore.task(task.id)!;assert.equal(after.status,'interrupted');assert.equal(after.stopped,false);assert.match(after.error,/Cleanup/);assert.ok(after.interruption?.nextSteps.length);assert.equal(f.automationStore.notices().length,1);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/confirm-stopped`,headers:f.headers})).statusCode,200);
  }finally{if(worker)await worker.stop();await f.close();}
});
