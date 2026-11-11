import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';

async function until(check:()=>boolean,timeout=10000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for background state');await delay(20);}}

test('unexpected worker rejection preserves redacted diagnostics and leaves API available without replaying jobs',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'background-failure-'));
  const f=await createApp({directory,serveWeb:false,backgroundEntry:new URL('./fixtures/background-crash.ts',import.meta.url)});
  try{
    const file=resolve(directory,'background-worker-failures.jsonl');
    await until(()=>existsSync(file)&&readFileSync(file,'utf8').includes('unexpected-exit'));
    const raw=readFileSync(file,'utf8'),entries=raw.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(raw.includes('private-test-secret'),false);
    assert.ok(entries.some(entry=>entry.kind==='uncaught-exception'&&entry.origin==='unhandledRejection'&&entry.message.includes('[redacted]')));
    assert.ok(entries.some(entry=>entry.kind==='unexpected-exit'&&entry.code===1));
    if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
    const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
    assert.equal((await f.app.inject({url:'/api/session',headers})).statusCode,200);
    assert.equal((await f.app.inject({url:'/api/health',headers})).json().workerReady,false);
    assert.equal(f.automationStore.tasks().length,0);
  }finally{await f.app.close();rmSync(directory,{recursive:true,force:true});}
});

test('HTTP and persisted cancellation remain responsive while the executor CPU is blocked',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'background-isolation-'));
  const f=await createApp({directory,serveWeb:false,backgroundEntry:new URL('./fixtures/background-blocker.ts',import.meta.url)});
  let pid=0;
  try{
    const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
    const store=f.automationStore,resource=store.saveResource({name:'CPU fixture',scenario:'materials',description:'',contentUrl:'',referenceUrl:'',externalSource:'',externalId:'',files:[]});
    const task=store.create({resourceIds:[resource.id],kind:'generation',scope:'homepage',environmentId:randomUUID(),requirements:''},defaultAutomationSettings)[0];
    f.vault.updateAutomation({...defaultAutomationSettings,enabled:true});
    await until(()=>existsSync(resolve(directory,'cpu-started')));
    pid=JSON.parse(readFileSync(resolve(directory,'automation-worker.lock'),'utf8')).pid;
    assert.notEqual(pid,process.pid);
    assert.equal(f.automationWorker.owns(task.id),true,'the durable claim covers the first ownership IPC race');
    const started=performance.now();
    for(let i=0;i<5;i++)assert.equal((await f.app.inject({url:'/api/session',headers})).statusCode,200);
    assert.equal((await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/cancel`,headers})).statusCode,200);
    assert.ok(performance.now()-started<1500,'HTTP/control must not wait for the three-second CPU block');
    assert.equal(store.task(task.id)!.status,'cancelling');
    await until(()=>store.header(task.id)?.status==='cancelled'&&!f.automationWorker.owns(task.id));
    assert.equal(store.task(task.id)!.stopped,true);
    assert.equal((await f.app.inject({url:'/api/health',headers})).json().workerReady,true);
  }finally{await f.app.close();}
  try{
    assert.equal(existsSync(resolve(directory,'automation-worker.lock')),false,'graceful shutdown releases the executor lock');
    if(pid)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the production background entry boots and stops against the existing encrypted configuration',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'background-production-'));
  try{
    const f=await createApp({directory,serveWeb:false});
    try{
      const pid=JSON.parse(readFileSync(resolve(directory,'automation-worker.lock'),'utf8')).pid;
      assert.notEqual(pid,process.pid);
      assert.equal(f.automationWorker.owns(randomUUID()),false);
      const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
      assert.equal((await f.app.inject({url:'/api/health',headers})).json().workerReady,true);
    }finally{await f.app.close();}
    assert.equal(existsSync(resolve(directory,'automation-worker.lock')),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('unconfirmed interruptions do not imply background ownership or restart followups and can be confirmed stopped',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'background-interrupted-'));
  const f=await createApp({directory,serveWeb:false});
  try{
    const login=await f.app.inject({method:'POST',url:'/api/login'}),headers={cookie:String(login.headers['set-cookie']).split(';')[0]};
    const store=f.automationStore,settings=f.vault.automation();
    const resource=store.saveResource({name:'Interrupted review',scenario:'materials',description:'',contentUrl:'',referenceUrl:'',externalSource:'',externalId:'',files:[]});
    const site={id:randomUUID(),resourceId:resource.id,versionId:store.versions(resource.id)[0].id,environmentId:'',siteId:randomUUID(),name:'Existing',url:'https://generated.invalid/',createdAt:Date.now()};store.saveSite(site);
    const task=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'homepage',environmentId:'',generatedSiteId:site.id,requirements:''},settings)[0];
    task.stopped=false;store.scheduleFollowup(task,settings.followup);
    store.interrupt(task,{reason:'Original execution was lost',evidence:['retained-evidence'],attempted:[],nextSteps:['Confirm the original execution has stopped'],resumeFrom:'Keep the existing site and evidence'});
    const before=store.task(task.id)!,events=store.events(task.id).length;
    store.recover();store.recover();
    assert.deepEqual(store.task(task.id),before,'restart must preserve explicit interruption and its evidence');
    assert.equal(store.events(task.id).length,events);
    assert.equal(f.automationWorker.owns(task.id),false,'an unresolved stop flag is not an executor claim');
    const waiting=store.create({resourceIds:[resource.id],kind:'evaluation',scope:'homepage',environmentId:'',generatedSiteId:site.id,requirements:''},settings)[0];
    assert.equal(store.claim('evaluation',1),undefined,'unknown original execution still reserves capacity');
    const overview=await f.app.inject({url:'/api/automation/overview?view=status',headers});
    assert.deepEqual(overview.json().queue,{generation:0,evaluation:0,queued:1});
    const confirmed=await f.app.inject({method:'POST',url:`/api/automation/tasks/${task.id}/confirm-stopped`,headers});
    assert.equal(confirmed.statusCode,200,confirmed.body);
    assert.equal(confirmed.json().stopped,true);assert.equal(confirmed.json().followup.executionStopped,true);
    assert.equal(confirmed.json().status,'interrupted');assert.deepEqual(confirmed.json().interruption,before.interruption);
    assert.equal(store.claim('evaluation',1)?.id,waiting.id,'confirmation releases the reserved slot');
    assert.equal(f.automationWorker.owns(waiting.id),true,'a committed running claim still covers the first IPC update');
    const running=store.task(waiting.id)!;running.status='pending';store.put(running);
    assert.equal(f.automationWorker.owns(waiting.id),false,'a pending historical claim is not owned');
    running.status='following-up';store.scheduleFollowup(running,settings.followup);running.followup!.state='running';store.put(running);
    assert.equal(f.automationWorker.owns(waiting.id),true,'an executing followup remains protected');
  }finally{await f.app.close();rmSync(directory,{recursive:true,force:true});}
});
