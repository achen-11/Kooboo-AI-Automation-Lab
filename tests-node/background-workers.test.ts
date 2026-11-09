import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';

async function until(check:()=>boolean,timeout=10000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for background state');await delay(20);}}

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
