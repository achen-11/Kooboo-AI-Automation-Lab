import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../server/runtime.js';
import { Vault } from '../server/lib/vault.js';
import { AutomationStore } from '../server/automation/store.js';
import { usageCapture } from '../server/automation/usage-proxy.js';
import { defaultAutomationSettings } from '../shared/automation.js';

for (const completed of [true, false]) test(`relay distinguishes SDK disconnect ${completed ? 'after completion' : 'before completion'}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-terminal-'));
  const db = new Database(join(directory, 'db.sqlite'));
  const store = new AutomationStore(db), vault = new Vault(directory), id = randomUUID();
  let calls = 0;
  const wire = 'data: ' + JSON.stringify(completed
    ? { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } }
    : { type: 'response.output_text.delta', delta: 'unfinished' }) + '\n\n';
  const upstream = createServer((_req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Providers may leave the transport open after the terminal Responses event.
    res.write(wire);
  });
  let relay: Awaited<ReturnType<typeof usageCapture>> | undefined;
  try {
    await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
    const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    vault.update({ ...vault.get(), model: { endpoint, name: 'deepseek-flash-1017', apiKey: 'test' } });
    vault.updateAutomation({ ...defaultAutomationSettings, evaluationEndpoint: endpoint });
    relay = await usageCapture(id, 'evaluation', store, vault, AbortSignal.timeout(5000));
    const request = () => fetch(relay!.env.AUTOMATION_RESPONSES_URL + '/responses', {
      method: 'POST', headers: { authorization: 'Bearer ' + relay!.env.EVALUATOR_MODEL_KEY }, body: '{}',
    });
    const first = await request(), reader = first.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), wire);
    await reader.cancel();
    const deadline = Date.now() + 2000;
    while (!store.usage.entries(id)[0]?.endedAt || store.usage.entries(id)[0]?.status === 'unknown') {
      if (Date.now() > deadline) throw new Error('relay did not settle the request');
      await new Promise(done => setTimeout(done, 10));
    }
    if (completed) {
      assert.equal(relay.error, undefined);
      assert.equal(store.usage.entries(id)[0].status, 'completed');
      assert.equal(store.usage.entries(id)[0].tokens?.input, 100);
      const second = await request();
      assert.equal(second.status, 200);
      await second.body!.cancel();
      assert.equal(calls, 2, 'the next model request must reach upstream');
    } else {
      assert.match(relay.error!.message, /SDK 已关闭模型连接/);
      assert.equal(store.usage.entries(id)[0].status, 'failed');
      assert.equal(store.usage.entries(id)[0].tokens, null);
    }
  } finally {
    await relay?.close();
    upstream.closeAllConnections();
    await new Promise<void>(done => upstream.close(() => done()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for(const mode of ['recover','exhaust','partial'] as const)test(`evaluation relay bounds transport retries: ${mode}`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'relay-retry-')),db=new Database(join(directory,'db.sqlite'));
  const store=new AutomationStore(db),vault=new Vault(directory),id=randomUUID();let calls=0;
  const upstream=createServer((_req,res)=>{
    calls++;
    if(mode==='recover'&&calls>1){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:0}}}})+'\n\n');}
    else if(mode==='partial'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({type:'response.output_text.delta',delta:'partial'})+'\n\n');setTimeout(()=>res.destroy(),20);}
    else res.destroy();
  });let relay:Awaited<ReturnType<typeof usageCapture>>|undefined;
  try{
    await new Promise<void>(done=>upstream.listen(0,'127.0.0.1',done));const endpoint=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
    vault.update({...vault.get(),model:{endpoint,name:'deepseek-flash-1017',apiKey:'test'}});vault.updateAutomation({...defaultAutomationSettings,evaluationEndpoint:endpoint});
    relay=await usageCapture(id,'evaluation',store,vault,AbortSignal.timeout(5000));
    const response=await fetch(relay.env.AUTOMATION_RESPONSES_URL+'/responses',{method:'POST',headers:{authorization:'Bearer '+relay.env.EVALUATOR_MODEL_KEY},body:'{}'});await response.text();await relay.close();relay=undefined;
    const entries=store.usage.entries(id);assert.equal(calls,mode==='recover'?2:mode==='exhaust'?3:1);assert.equal(entries.length,calls);
    assert.equal(entries[0].status,'failed');assert.equal(entries[0].tokens,null,'lost usage stays unknown, never free');
    assert.equal(entries.at(-1)!.status,mode==='recover'?'completed':'failed');if(mode==='recover')assert.equal(entries.at(-1)!.tokens?.input,10);
  }finally{await relay?.close();upstream.closeAllConnections();await new Promise<void>(done=>upstream.close(()=>done()));db.close();rmSync(directory,{recursive:true,force:true});}
});
