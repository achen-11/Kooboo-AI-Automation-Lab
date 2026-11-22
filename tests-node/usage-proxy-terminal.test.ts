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
import { RequestBudget } from '../server/automation/request-budget.js';
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

test('evaluation relay with maxConcurrent=2 executes two concurrent SSE batches and rejects a third concurrent request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-concurrent-'));
  const db = new Database(join(directory, 'db.sqlite'));
  const store = new AutomationStore(db), vault = new Vault(directory);

  let inFlight = 0, maxOverlap = 0, arrived = 0;
  let releasePair!: () => void;
  const bothArrived = new Promise<void>(resolve => { releasePair = resolve; });
  const upstream = createServer(async (req, res) => {
    let rawBody = '';
    for await (const chunk of req) rawBody += chunk;
    const tag = JSON.parse(rawBody || '{}').input;
    inFlight++;
    arrived++;
    maxOverlap = Math.max(maxOverlap, inFlight);
    if (arrived >= 2) releasePair();
    else await bothArrived;
    const usage = tag === 'desktop'
      ? { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } }
      : { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 0 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage } }) + '\n\n');
    inFlight--;
  });

  let releaseHold!: () => void, markTwoActive!: () => void;
  const hold = new Promise<void>(resolve => { releaseHold = resolve; });
  const twoActive = new Promise<void>(resolve => { markTwoActive = resolve; });
  let heldCount = 0;
  const heldUpstream = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    heldCount++;
    if (heldCount >= 2) markTwoActive();
    await hold;
    if (!res.destroyed) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n\n');
    }
  });

  let relay1: Awaited<ReturnType<typeof usageCapture>> | undefined;
  let relay2: Awaited<ReturnType<typeof usageCapture>> | undefined;
  try {
    await Promise.all([
      new Promise<void>(done => upstream.listen(0, '127.0.0.1', done)),
      new Promise<void>(done => heldUpstream.listen(0, '127.0.0.1', done)),
    ]);

    const id1 = randomUUID();
    const policy1 = { key: 'evaluation:' + id1, runKey: id1, maxRequests: 6, maxTokens: 3_000_000, maxOutputTokens: 16384, maxConcurrent: 2 };
    const endpoint1 = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    vault.update({ ...vault.get(), model: { endpoint: endpoint1, name: 'deepseek-flash-1017', apiKey: 'test' } });
    vault.updateAutomation({ ...defaultAutomationSettings, evaluationEndpoint: endpoint1 });
    relay1 = await usageCapture(id1, 'evaluation', store, vault, AbortSignal.timeout(5000), policy1);

    const post1 = (input: string) => fetch(relay1!.env.AUTOMATION_RESPONSES_URL + '/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + relay1!.env.EVALUATOR_MODEL_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash-1017', input }),
    });
    const [rDesktop, rMobile] = await Promise.all([post1('desktop'), post1('mobile')]);
    assert.equal(rDesktop.status, 200);
    assert.equal(rMobile.status, 200);
    await Promise.all([rDesktop.text(), rMobile.text()]);
    await relay1.close();
    assert.equal(relay1.error, undefined);
    relay1 = undefined;

    assert.equal(maxOverlap, 2, 'two batches must overlap in flight upstream');
    const entries = store.usage.entries(id1);
    assert.equal(entries.length, 2);
    assert.ok(entries.every(entry => entry.status === 'completed'));
    const summary = store.usage.summary(id1);
    assert.equal(summary.input, 220);
    assert.equal(summary.output, 50);
    assert.equal(summary.cached, 40);
    assert.equal(new RequestBudget(db, policy1).activeRequests(), 0);

    const id2 = randomUUID();
    const policy2 = { key: 'evaluation:' + id2, runKey: id2, maxRequests: 6, maxTokens: 3_000_000, maxOutputTokens: 16384, maxConcurrent: 2 };
    const endpoint2 = `http://127.0.0.1:${(heldUpstream.address() as { port: number }).port}`;
    vault.update({ ...vault.get(), model: { endpoint: endpoint2, name: 'deepseek-flash-1017', apiKey: 'test' } });
    vault.updateAutomation({ ...defaultAutomationSettings, evaluationEndpoint: endpoint2 });
    relay2 = await usageCapture(id2, 'evaluation', store, vault, AbortSignal.timeout(5000), policy2);

    const post2 = (input: string) => fetch(relay2!.env.AUTOMATION_RESPONSES_URL + '/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + relay2!.env.EVALUATOR_MODEL_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash-1017', input }),
    });
    const p1 = post2('desktop');
    const p2 = post2('mobile');
    await twoActive;

    const r3 = await post2('third');
    assert.equal(r3.status, 429);
    const body3 = JSON.parse(await r3.text());
    assert.equal(body3.error.code, 'automation_budget_exceeded');
    assert.match(body3.error.message, /同一预算仍有模型请求执行中/);
    assert.match(relay2.error?.message || '', /同一预算仍有模型请求执行中/);

    releaseHold();
    await Promise.allSettled([p1, p2]);
    await relay2.close();
    relay2 = undefined;
  } finally {
    releaseHold();
    await relay1?.close();
    await relay2?.close();
    upstream.closeAllConnections();
    heldUpstream.closeAllConnections();
    await Promise.allSettled([
      new Promise<void>(done => upstream.close(() => done())),
      new Promise<void>(done => heldUpstream.close(() => done())),
    ]);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
