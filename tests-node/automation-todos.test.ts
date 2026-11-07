import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings, defaultDeliveryPolicy } from '../shared/automation.js';
import { initialPrice, calculateUsage, normalizeUsage, priceBand } from '../server/automation/billing.js';
import type { UsageObservation } from '../shared/billing.js';
import { materialPath, uniqueMaterialPaths, packageGroups } from '../shared/materials.js';
import { usageCapture } from '../server/automation/usage-proxy.js';
import { queueDelivery, executeDelivery, expectedDeliveryPaths } from '../server/automation/delivery.js';
import { AutomationWorker } from '../server/automation/worker.js';

const time=(s:string)=>Date.parse(s+'+08:00');
const obs=(patch:Partial<UsageObservation>={}):UsageObservation=>({id:'request',source:'codex',stage:'evaluation',model:'deepseek-flash-1017',endpoint:'https://api.deepseek.com',startedAt:time('2026-11-09T09:30:00'),endedAt:time('2026-11-09T09:31:00'),status:'completed',basis:'request',raw:{input_tokens:1000000,output_tokens:100000,input_tokens_details:{cached_tokens:200000},output_tokens_details:{reasoning_tokens:50000}},...patch});
async function fixture(){const directory=mkdtempSync(join(tmpdir(),'todos-test-'));const f=await createApp({directory,serveWeb:false,startWorker:false});const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};const env=randomUUID(),target=randomUUID();f.vault.update({threshold:80,paused:true,model:{endpoint:'https://api.deepseek.com',name:'deepseek-flash-1017',apiKey:'test-key'},environments:[{id:env,name:'HK',origin:'https://hk.test',apiOrigin:'https://hk.test',token:'test-hk',delivery:{...defaultDeliveryPolicy,enabled:true,targetEnvironmentId:target,token:'test-migration'}},{id:target,name:'DE',origin:'https://de.test',apiOrigin:'https://de.test',token:'test-de'}]});const resource=f.automationStore.saveResource({name:'Materials',scenario:'migration',description:'',contentUrl:'https://content.test',referenceUrl:'',externalId:'',externalSource:'',files:[]});const site={id:randomUUID(),resourceId:resource.id,versionId:f.automationStore.versions(resource.id)[0].id,environmentId:env,siteId:randomUUID(),name:'Generated',url:'https://generated.test',createdAt:Date.now()};f.automationStore.saveSite(site);const create=(kind:'generation'|'evaluation'='evaluation')=>{const task=f.automationStore.create({resourceIds:[resource.id],kind,scope:'site',environmentId:env,generatedSiteId:site.id,requirements:''},defaultAutomationSettings)[0];task.requirementsEnabled=false;task.learningPolicy={...task.learningPolicy!,use:false,collect:false};f.automationStore.put(task);return task;};const done=()=>{const t=create();t.status='completed';t.report={summary:'source report',assessments:[],issues:[],coverage:{verified:[],unverified:[],outOfScope:[]},scores:[],quality:'passed',artifacts:[]};f.automationStore.put(t);return t;};return {...f,directory,headers,env,target,resource,site,create,done,async close(){await f.app.close();rmSync(directory,{recursive:true,force:true});}};}
async function listen(server:ReturnType<typeof createServer>){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:ReturnType<typeof createServer>){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}

test('evaluation relay forwards image contexts above 32 MiB unchanged and rejects oversized requests before upstream',async()=>{
  const f=await fixture();let forwarded=0,receivedHash='';
  const upstream=createServer(async(req,res)=>{forwarded++;const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);receivedHash=createHash('sha256').update(Buffer.concat(chunks)).digest('hex');res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:100,output_tokens:5,cached_input_tokens:0}}})+'\n\n');});
  const origin=await listen(upstream);let capture:Awaited<ReturnType<typeof usageCapture>>|undefined;
  try{
    f.vault.updateAutomation({...defaultAutomationSettings,evaluationEndpoint:origin});const task=f.done();
    capture=await usageCapture(task.id,'evaluation',f.automationStore,f.vault,AbortSignal.timeout(20000));
    const headers={Authorization:'Bearer '+capture.env.EVALUATOR_MODEL_KEY,'Content-Type':'application/json'};
    const body=JSON.stringify({model:'deepseek-flash-1017',input:[{image_url:'data:image/png;base64,'+'a'.repeat(33*1024*1024)}]});
    const result=await fetch(capture.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers,body});assert.equal(result.status,200);await result.text();
    assert.equal(receivedHash,createHash('sha256').update(body).digest('hex'));assert.equal(f.automationStore.usage.entries(task.id)[0].tokens?.input,100);
    const denied=await new Promise<{status:number;body:string}>((resolve,reject)=>{const req=httpRequest(capture!.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers:{...headers,'Content-Length':String(129*1024*1024)}},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode!,body:text}));});req.on('error',reject);req.end();});
    assert.equal(denied.status,413);assert.equal(JSON.parse(denied.body).error.code,'automation_request_too_large');assert.equal(forwarded,1);
  }finally{await capture?.close();await close(upstream);await f.close();}
});

test('DeepSeek costs use Beijing peak/offpeak, calendar, cache and inclusive reasoning without inventing missing usage',()=>{
  assert.equal(priceBand(time('2026-11-09T08:59:59'),initialPrice),'offpeak');assert.equal(priceBand(time('2026-11-09T09:00:00'),initialPrice),'peak');assert.equal(priceBand(time('2026-11-09T12:00:00'),initialPrice),'offpeak');assert.equal(priceBand(time('2026-11-09T14:00:00'),initialPrice),'peak');assert.equal(priceBand(time('2026-11-09T18:00:00'),initialPrice),'offpeak');assert.equal(priceBand(time('2026-11-07T10:00:00'),initialPrice),'offpeak');assert.equal(priceBand(time('2026-10-01T10:00:00'),initialPrice),'offpeak');assert.equal(priceBand(time('2027-01-04T10:00:00'),initialPrice),'unknown');
  assert.equal(calculateUsage(obs(),'task',initialPrice).cny,2.408);assert.equal(calculateUsage(obs({startedAt:time('2026-11-09T13:00:00'),endedAt:time('2026-11-09T13:01:00')}),'task',initialPrice).cny,1.204);
  for(const range of [['2026-11-09T08:59:00','2026-11-09T09:01:00'],['2026-11-09T08:00:00','2026-11-09T19:00:00']]){const row=calculateUsage(obs({startedAt:time(range[0]),endedAt:time(range[1])}),'task',initialPrice);assert.equal(row.band,'mixed');assert.equal(row.cny,null);}
  assert.equal(calculateUsage(obs({raw:{input_tokens:10,output_tokens:1}}),'task',initialPrice).cny,null);assert.equal(calculateUsage(obs({raw:null,status:'failed'}),'task',initialPrice).tokens,null);
  assert.deepEqual(normalizeUsage({inputTokenCount:100,outputTokenCount:30,cachedInputTokenCount:25,reasoningTokenCount:20}),{input:100,output:30,cached:25,reasoning:20});assert.equal(normalizeUsage({input_tokens:1,output_tokens:2,cached_input_tokens:3}),null);
});

test('usage ledger deduplicates retries by event identity, freezes price history, sums automatic child exactly once and exposes read API',async()=>{const f=await fixture();try{
  const parent=f.create('generation');parent.status='completed';f.automationStore.put(parent);const child=f.automationStore.ensureEvaluation(parent,defaultAutomationSettings);
  f.automationStore.usage.record(parent.id,obs());f.automationStore.usage.record(parent.id,obs());f.automationStore.usage.record(child.id,obs({id:'child',stage:'evaluation'}));f.automationStore.usage.record(child.id,obs({id:'failed',raw:null,status:'failed'}));
  const original=f.automationStore.usage.entries(parent.id)[0];f.automationStore.usage.publish({...initialPrice,id:undefined,effectiveFrom:Date.now(),peak:{input:99,cached:1,output:99}});assert.deepEqual(f.automationStore.usage.entries(parent.id)[0],original);
  const total=f.automationStore.task(parent.id)!.usage!;assert.equal(total.requests,3);assert.equal(total.input,2000000);assert.equal(total.knownCny,4.816);assert.equal(total.missing,1);
  const read={authorization:`Bearer ${f.vault.credentials.readToken}`};const report=await f.app.inject({url:`/api/v1/automation/reports/${child.id}`,headers:read});assert.equal(report.json().usageEntries.length,2);assert.equal(report.json().task.usage.requests,2);
  for(const url of ['/api/automation/prices',`/api/automation/tasks/${child.id}/delivery`])assert.equal((await f.app.inject({method:'POST',url,headers:read,payload:{}})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/automation/overview',headers:f.headers})).json().tasks.find((t:any)=>t.id===parent.id).usage.knownCny,total.knownCny);
}finally{await f.close();}});

test('folder paths and grouping retain nested packages and reject traversal, case collisions and file/directory conflicts',()=>{
  assert.equal(materialPath('images/产品 one.svg'),'images/产品 one.svg');for(const path of ['/root','../x','images/../x','C:/x','a\\b','a//b','a/./b','a\0b'])assert.throws(()=>materialPath(path));
  assert.throws(()=>uniqueMaterialPaths([{name:'Images/a.JPG'},{name:'images/A.jpg'}]),/重复/);assert.throws(()=>uniqueMaterialPaths([{name:'images'},{name:'images/a.jpg'}]),/文件和目录/);
  const {groups,loose}=packageGroups([{path:'One/README.md'},{path:'One/images/a.jpg'},{path:'Two/images/a.jpg'},{path:'shared.txt'}],false);assert.deepEqual(groups.map(g=>[g.name,g.files.map(f=>f.path)]),[['One',['README.md','images/a.jpg']],['Two',['images/a.jpg']]]);assert.equal(loose[0].path,'shared.txt');
});

test('material uploads and resource import are path-safe and idempotent across lost creation receipts',async()=>{const f=await fixture();try{
  const uploaded=await f.app.inject({method:'POST',url:'/api/automation/files',headers:f.headers,payload:{name:'images/logo.svg',type:'image/svg+xml',content:Buffer.from('<svg/>').toString('base64')}});assert.equal(uploaded.statusCode,201);const file=uploaded.json();assert.equal(readFileSync(join(f.directory,'materials',file.id),'utf8'),'<svg/>');
  for(const path of ['../a','C:/x','a\\b'])assert.equal((await f.app.inject({method:'POST',url:'/api/automation/files',headers:f.headers,payload:{name:path,type:'text/plain',content:''}})).statusCode,400);
  const payload={...f.resource,id:undefined,files:[file]};const headers={...f.headers,'idempotency-key':'resource-import-test-01'};
  const first=await f.app.inject({method:'POST',url:'/api/automation/resources',headers,payload}),second=await f.app.inject({method:'POST',url:'/api/automation/resources',headers,payload});assert.equal(first.statusCode,201);assert.equal(first.json().id,second.json().id);assert.equal((await f.app.inject({method:'POST',url:'/api/automation/resources',headers,payload:{...payload,name:'changed'}})).statusCode,409);
  assert.equal((await f.app.inject({method:'POST',url:'/api/automation/resources',headers:f.headers,payload:{...payload,files:[file,file]}})).statusCode,400);
}finally{await f.close();}});

test('followup budget counts active Agent time, excludes historical wall time and settles only saved heartbeat after crash',async()=>{const f=await fixture();let worker:AutomationWorker|undefined;try{
  f.vault.updateAutomation({...defaultAutomationSettings,enabled:true});const t=f.create('generation');t.status='pending';t.stopped=true;f.automationStore.scheduleFollowup(t,defaultAutomationSettings.followup);t.followup!.startedAt=Date.now()-86400000;t.followup!.elapsedMs=20;f.automationStore.put(t);let calls=0;
  worker=new AutomationWorker(f.automationStore,f.vault,f.directory,{generation:async()=>{},evaluation:async()=>{}},()=>true,async()=>{calls++;await new Promise(r=>setTimeout(r,15));return {action:'wait',reason:'原站仍在工作',evidence:['e'],waitSeconds:300};});await worker.tick();await new Promise(r=>setTimeout(r,50));const waiting=f.automationStore.task(t.id)!;assert.equal(calls,1);assert.equal(waiting.status,'following-up');assert.ok(waiting.followup!.elapsedMs!>=30&&waiting.followup!.elapsedMs!<500);assert.equal(waiting.followup!.activeStartedAt,undefined);
  await new Promise(r=>setTimeout(r,30));assert.equal(f.automationStore.task(t.id)!.followup!.elapsedMs,waiting.followup!.elapsedMs);
  waiting.stopped=false;waiting.followup!.activeStartedAt=1000;waiting.followup!.activeHeartbeatAt=1200;waiting.followup!.elapsedMs=50;f.automationStore.put(waiting);f.automationStore.recover();assert.equal(f.automationStore.task(t.id)!.followup!.elapsedMs,250);
}finally{await worker?.stop();await f.close();}});

test('delivery configuration encrypts independent credentials and local environments keep delivery optional',async()=>{const f=await fixture();try{
  const publicSettings=f.vault.public();assert.equal(publicSettings.environments[0].delivery?.hasToken,true);assert.ok(!JSON.stringify(publicSettings).includes('test-migration'));assert.equal(publicSettings.environments[1].delivery,undefined);assert.ok(!readFileSync(join(f.directory,'settings.enc')).includes(Buffer.from('test-migration')));
  const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>({...e,token:'',delivery:e.delivery?{...e.delivery,token:''}:undefined}))});assert.equal(f.vault.get().environments[0].delivery!.token,'test-migration');
  const t=f.done();queueDelivery(t,f.automationStore,f.vault);assert.equal(queueDelivery(t,f.automationStore,f.vault).delivery!.id,t.delivery!.id);assert.ok(!JSON.stringify(t.delivery).includes('test-migration'));
  const other=f.done();assert.throws(()=>queueDelivery(other,f.automationStore,f.vault),/已有关联交付/);
}finally{await f.close();}});

test('migration preserves source report, saves successful target before verification and never re-posts uncertain delivery',async()=>{const f=await fixture();let requests=0;const targetId=randomUUID();const server=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{siteId:f.site.siteId,homePageLink:f.site.url}]));return;}requests++;let body='';for await(const c of req)body+=c;const input=JSON.parse(body);assert.deepEqual(input,{siteUrl:'https://generated.test',token:'test-migration'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({siteId:targetId,siteUrl:'https://target.test'}));});const endpoint=await listen(server);try{
  const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>e.id===f.env?{...e,apiOrigin:endpoint,delivery:{...e.delivery!,endpoint}}:e)});const t=f.done(),report=structuredClone(t.report);queueDelivery(t,f.automationStore,f.vault);let verifications=0;
  const verify=async(task:typeof t)=>{verifications++;assert.equal(f.automationStore.task(task.id)!.delivery!.target!.siteId,targetId);task.delivery!.status='completed';};
  await executeDelivery(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(2000),verify);assert.equal(requests,1);assert.equal(verifications,1);assert.deepEqual(t.report,report);assert.equal(t.environmentId,f.env);await executeDelivery(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(2000),verify);assert.equal(requests,1);assert.equal(verifications,2);
  delete t.delivery!.target;t.delivery!.status='uncertain';await assert.rejects(()=>executeDelivery(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(2000),verify),/禁止自动再次发送/);assert.equal(requests,1);
}finally{await close(server);await f.close();}});

test('unknown migration response remains uncertain, blocks source mutation and can adopt a receipt without another migration',async()=>{const f=await fixture();const server=createServer((req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{siteId:f.site.siteId,homePageLink:f.site.url}]));}else res.end('not-json');});const endpoint=await listen(server);try{
  const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>e.id===f.env?{...e,apiOrigin:endpoint,delivery:{...e.delivery!,endpoint}}:e)});const t=f.done();queueDelivery(t,f.automationStore,f.vault);await executeDelivery(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(2000),async()=>assert.fail('must not verify without receipt'));assert.equal(t.delivery!.status,'uncertain');const g=f.create('generation');assert.equal(f.automationStore.claim('generation',1),undefined);assert.ok(g);
  const read={authorization:`Bearer ${f.vault.credentials.readToken}`};const payload={siteId:randomUUID(),siteUrl:'https://target.test'};assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/delivery/receipt`,headers:read,payload})).statusCode,401);assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/delivery/receipt`,headers:f.headers,payload})).statusCode,200);assert.equal(f.automationStore.task(t.id)!.delivery!.status,'queued');
}finally{await close(server);await f.close();}});

test('delivery restart preserves target receipts and derives check paths solely from hashed source evidence',async()=>{const f=await fixture();try{
  const t=f.done();queueDelivery(t,f.automationStore,f.vault);t.delivery!.status='running';t.delivery!.attemptedAt=Date.now();f.automationStore.put(t);f.automationStore.recover();assert.equal(f.automationStore.task(t.id)!.delivery!.status,'uncertain');
  t.delivery!.target={siteId:randomUUID(),siteUrl:'https://target.test'};t.delivery!.status='verifying';f.automationStore.put(t);f.automationStore.recover();assert.equal(f.automationStore.task(t.id)!.delivery!.status,'queued');
  const bytes=Buffer.from(JSON.stringify({url:'https://generated.test/products/one'})),name=randomUUID()+'.json';const dir=join(f.directory,'automation-runs',t.id,'evidence');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,name),bytes);t.report!.artifacts=[{id:randomUUID(),name,type:'application/json',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),role:'target'}];assert.deepEqual(expectedDeliveryPaths(t,f.directory),['/','/products/one']);writeFileSync(join(dir,name),'changed');assert.deepEqual(expectedDeliveryPaths(t,f.directory),['/']);
}finally{await f.close();}});

test('Codex relay captures individual SSE requests and failures, forwards bytes and never double-counts SDK turn totals',async()=>{const f=await fixture();let upstreamAuth='';const wire='event: response.completed\r\ndata: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:50}}}})+'\r\n\r\n';const upstream=createServer((req,res)=>{upstreamAuth=req.headers.authorization||'';res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(wire.slice(0,20));setTimeout(()=>res.end(wire.slice(20)),5);});const origin=await listen(upstream);let capture:Awaited<ReturnType<typeof usageCapture>>|undefined;try{
  f.vault.updateAutomation({...defaultAutomationSettings,evaluationEndpoint:origin});const t=f.done();capture=await usageCapture(t.id,'evaluation',f.automationStore,f.vault,AbortSignal.timeout(5000));const headers={Authorization:'Bearer '+capture.env.EVALUATOR_MODEL_KEY,'Content-Type':'application/json'};assert.equal((await fetch(capture.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',body:'{}'})).status,401);
  const r=await fetch(capture.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers,body:JSON.stringify({model:'deepseek-flash-1017',input:'PRIVATE_PROMPT'})});assert.equal(await r.text(),wire);assert.equal(upstreamAuth,'Bearer test-key');capture.fallback({input_tokens:1000,output_tokens:100,cached_input_tokens:0},Date.now());const entries=f.automationStore.usage.entries(t.id);assert.equal(entries.length,1);assert.equal(entries[0].tokens!.input,100);assert.equal(entries[0].tokens!.cached,50);assert.ok(!JSON.stringify(entries).includes('PRIVATE_PROMPT'));
}finally{await capture?.close();await close(upstream);await f.close();}});

test('material manifest maps normalized Kooboo filenames and evaluation copies real directory paths with integrity checks',async()=>{
  const {materialDestination,copyEvaluationMaterials}=await import('../server/automation/materials.js');const f=await fixture();try{
    const bytes=Buffer.from('<svg/>'),file={id:randomUUID(),name:'images/hero banner.svg',type:'image/svg+xml',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};mkdirSync(join(f.directory,'materials'),{recursive:true});writeFileSync(join(f.directory,'materials',file.id),bytes);
    const mapping=materialDestination(f.resource.id,f.site.versionId,file);assert.equal(mapping.text,false);assert.equal(mapping.filename,file.id+'.svg');assert.ok(mapping.path.endsWith('/images/'+file.id+'.svg'));
    const work=join(f.directory,'copy');mkdirSync(work);copyEvaluationMaterials(f.directory,work,[file]);assert.equal(readFileSync(join(work,'materials','images','hero banner.svg'),'utf8'),'<svg/>');assert.equal(JSON.parse(readFileSync(join(work,'materials-manifest.json'),'utf8'))[0].name,file.name);
    writeFileSync(join(f.directory,'materials',file.id),'corrupt');assert.throws(()=>copyEvaluationMaterials(f.directory,work,[file]),/校验失败/);
  }finally{await f.close();}
});

test('material preparation accepts Kooboo v2 null receipts only with matching persisted assets',async()=>{
  const {executeGeneration}=await import('../server/automation/generator.js');const {materialDestination}=await import('../server/automation/materials.js');const f=await fixture();let origin='';const uploads:string[]=[],scripts:string[]=[];
  const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method==='GET'){const url=new URL(req.url!,origin);res.end(url.pathname==='/_api/v2/File/List'?JSON.stringify({files:{list:[{url:url.searchParams.get('path')+'/'+url.searchParams.get('keyword'),size:6}],totalPages:1}}):url.pathname==='/_api/v2/Site/List'?JSON.stringify([{siteId:f.site.siteId,homePageLink:origin+'/'}]):'true');return;}let body='';for await(const c of req)body+=c;if(req.url?.startsWith('/_api/v2/Upload/File')){uploads.push(body);res.end('null');}else{scripts.push(JSON.parse(body).arguments.code);res.end(JSON.stringify({contents:[{result:true}]}));}});
  origin=await listen(server);try{
    const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>e.id===f.env?{...e,apiOrigin:origin}:e)});
    const files=[{name:'README.md',text:'![hero](images/hero banner.svg)',type:'text/markdown'},{name:'images/hero banner.svg',text:'<svg/>',type:'image/svg+xml'}].map(x=>{const bytes=Buffer.from(x.text),file={id:randomUUID(),name:x.name,type:x.type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};mkdirSync(join(f.directory,'materials'),{recursive:true});writeFileSync(join(f.directory,'materials',file.id),bytes);return file;});
    f.automationStore.saveResource({...f.resource,files},f.resource.id,f.resource.revision);const t=f.create('generation');t.generation={deliveryState:'completed'};
    await executeGeneration(t,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000));assert.equal(uploads.length,1);assert.ok(uploads[0].includes('filename="'+files[1].id+'.svg"'));assert.ok(uploads[0].includes(`materials/${f.resource.id}/${t.versionId}/images`));assert.equal(scripts.length,2);assert.ok(scripts[1].includes('_automation-manifests/'));assert.ok(t.message.includes(materialDestination(f.resource.id,t.versionId,files[1]).path));assert.equal(t.generation.prepared,true);assert.equal(t.stage,'handoff');
  }finally{await close(server);await f.close();}
});

test('material preparation resumes confirmed files and rejects HTTP success without persistence',async()=>{
  const {executeGeneration}=await import('../server/automation/generator.js');const {materialDestination}=await import('../server/automation/materials.js');const f=await fixture();
  const uploads:string[]=[],scripts:string[]=[];let origin='',receipt:unknown=null,confirmation:'missing'|'wrong-path'|'wrong-size'|'match'='missing';
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');const url=new URL(req.url!,origin);
    if(req.method==='GET'){
      if(url.pathname==='/_api/v2/File/List'){res.end(JSON.stringify({files:{list:confirmation==='missing'?[]:[{url:confirmation==='wrong-path'?'/elsewhere':url.searchParams.get('path')+'/'+url.searchParams.get('keyword'),size:confirmation==='wrong-size'?123:6}],totalPages:1}}));return;}
      res.end(url.pathname==='/_api/v2/Site/List'?JSON.stringify([{siteId:f.site.siteId,homePageLink:origin+'/'}]):'true');return;
    }
    let body='';for await(const chunk of req)body+=chunk;
    if(url.pathname==='/_api/v2/Upload/File'){uploads.push(body);res.end(JSON.stringify(receipt));}
    else {scripts.push(JSON.parse(body).arguments.code);res.end(JSON.stringify({contents:[{result:true}]}));}
  });
  origin=await listen(server);try{
    const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>e.id===f.env?{...e,apiOrigin:origin}:e)});
    const files=[{name:'README.md',text:'Source content',type:'text/markdown'},{name:'DH Trading/images/badge.svg',text:'<svg/>',type:'image/svg+xml'}].map(x=>{const bytes=Buffer.from(x.text),file={id:randomUUID(),name:x.name,type:x.type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};mkdirSync(join(f.directory,'materials'),{recursive:true});writeFileSync(join(f.directory,'materials',file.id),bytes);return file;});
    f.automationStore.saveResource({...f.resource,files},f.resource.id,f.resource.revision);let task=f.create('generation');task.generation={deliveryState:'completed'};
    for(const mismatch of ['missing','wrong-path','wrong-size'] as const){
      confirmation=mismatch;await assert.rejects(executeGeneration(task,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000)),/上传资料未确认/);
      task=f.automationStore.task(task.id)!;assert.equal(task.generation?.importedMaterials?.[files[0].id],files[0].sha256);assert.equal(task.generation?.importedMaterials?.[files[1].id],undefined);assert.notEqual(task.generation?.prepared,true);
    }
    confirmation='match';for(const invalid of [false,{success:false},'true']){receipt=invalid;await assert.rejects(executeGeneration(task,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000)),/回执异常/);}
    receipt=true;await executeGeneration(task,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000));
    assert.equal(scripts.length,2,'confirmed README is not rewritten; only the final manifest is added');assert.equal(uploads.length,7);assert.equal(task.generation?.prepared,true);assert.ok(task.message.includes('README.md → kfile:'));assert.ok(task.message.includes(materialDestination(task.resourceId,task.versionId,files[1]).path));
    assert.equal(task.generation?.importedMaterials?.[files[1].id],files[1].sha256);assert.equal(task.stage,'handoff');
  }finally{await close(server);await f.close();}
});

test('a completed generation receipt still allows an explicit continuation in the original conversation',async()=>{
  const {executeGeneration}=await import('../server/automation/generator.js');const f=await fixture();let origin='';
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url?.startsWith('/_api/v2/Site/List')?JSON.stringify([{siteId:f.site.siteId,homePageLink:origin+'/'}]):'true');});
  origin=await listen(server);try{
    const raw=f.vault.get();f.vault.update({...raw,environments:raw.environments.map(e=>e.id===f.env?{...e,apiOrigin:origin}:e)});
    const task=f.create('generation'),conversationId=randomUUID(),previousDelivery=randomUUID();
    task.generation={prepared:true,deliveryState:'completed',deliveryId:previousDelivery,conversationId,next:{action:'continue',reason:'Chat stopped without a homepage',message:'Continue the original homepage task using the imported materials.',evidence:['verified-original-conversation']}};
    let delivered:Parameters<Awaited<ReturnType<typeof import('../server/automation/generation-session.js').generationSession>>['deliver']>[0]|undefined,closed=0;
    const openSession:typeof import('../server/automation/generation-session.js').generationSession=async()=>({
      snapshot:async()=>({version:1,taskId:task.id,siteId:f.site.siteId,conversationId,runId:'verified-run',ready:true,running:false,state:'completed',observedAt:Date.now(),pending:null,context:[],outcome:{conversationId,runId:'verified-run',status:'completed',time:Date.now()},delivery:{id:delivered?.id||previousDelivery,state:'accepted',conversationId}}),
      deliver:async input=>{delivered=input;return {id:input.id,state:'accepted',conversationId};},close:async()=>{closed++;},
    });
    await executeGeneration(task,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000),openSession);
    assert.equal(delivered?.conversationId,conversationId);assert.match(delivered?.text||'',/Continue the original homepage/);assert.notEqual(delivered?.id,previousDelivery);assert.equal(task.generation.next,undefined);assert.equal(task.generation.deliveryState,'completed');assert.equal(task.stage,'handoff');assert.equal(closed,1);assert.equal(f.automationStore.sites().length,1);
    await executeGeneration(task,f.automationStore,f.vault,f.directory,AbortSignal.timeout(3000),async()=>{throw new Error('A retry without an explicit continuation must not redeliver');});
    assert.equal(closed,1);
  }finally{await close(server);await f.close();}
});

test('relay retains failed request usage, missing retries and /responses/compact without adding the SDK aggregate again',async()=>{const f=await fixture();let count=0;const upstream=createServer((req,res)=>{count++;if(count===1){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.failed',response:{status:'failed',usage:{input_tokens:20,output_tokens:5,cached_input_tokens:0}}})+'\n\n');}else if(req.url==='/responses/compact'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({usage:{input_tokens:10,output_tokens:3,cached_input_tokens:0}}));}else{res.writeHead(429,{'Content-Type':'application/json'});res.end('{"error":"rate limit"}');}});const origin=await listen(upstream);let capture:Awaited<ReturnType<typeof usageCapture>>|undefined;try{
  f.vault.updateAutomation({...defaultAutomationSettings,evaluationEndpoint:origin});const t=f.done();capture=await usageCapture(t.id,'followup',f.automationStore,f.vault,AbortSignal.timeout(5000));const headers={Authorization:'Bearer '+capture.env.EVALUATOR_MODEL_KEY,'Content-Type':'application/json'};for(const path of ['/responses','/responses','/responses/compact']){const result=await fetch(capture.env.AUTOMATION_RESPONSES_URL+path,{method:'POST',headers,body:JSON.stringify({model:'deepseek-flash-1017'})});await result.text();}
  capture.fallback({input_tokens:500,output_tokens:100,cached_input_tokens:0},Date.now());const entries=f.automationStore.usage.entries(t.id);assert.equal(entries.length,3);assert.equal(entries[0].status,'failed');assert.equal(entries[0].tokens!.input,20);assert.equal(entries[1].status,'failed');assert.equal(entries[1].tokens,null);assert.equal(entries[2].tokens!.input,10);
}finally{await capture?.close();await close(upstream);await f.close();}});

test('delivery gate, local capability and unconfirmed browser stop never bypass the host queue',async()=>{const f=await fixture();try{
  const t=f.done();t.report!.quality='failed';f.automationStore.put(t);assert.throws(()=>queueDelivery(t,f.automationStore,f.vault),/评测通过/);
  t.report!.quality='passed';t.environmentId=f.target;f.automationStore.put(t);assert.throws(()=>queueDelivery(t,f.automationStore,f.vault),/未启用/);t.environmentId=f.env;f.automationStore.put(t);queueDelivery(t,f.automationStore,f.vault);
  t.delivery!.status='failed';t.delivery!.target={siteId:randomUUID(),siteUrl:'https://target.test'};t.delivery!.stopped=false;f.automationStore.put(t);const created=f.create('generation');assert.equal(f.automationStore.claim('generation',1),undefined);assert.ok(created);
  assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/delivery/verify`,headers:f.headers})).statusCode,409);
  assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/delivery/confirm-stopped`,headers:f.headers})).statusCode,200);assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${t.id}/delivery/verify`,headers:f.headers})).statusCode,200);
}finally{await f.close();}});
