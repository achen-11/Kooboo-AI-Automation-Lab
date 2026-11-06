import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { requestCompletion, testModel, testAgentModel, type Completion, type CompletionRequest, type AgentCompletionRequest } from '../server/lib/model.js';

const model = { endpoint: 'https://gateway.example/custom/deepseek/chat/completions', name: 'configured-model', apiKey: 'secret-test-key' };

test('tool transport accepts tool-only responses at the configured endpoint without forcing JSON response format',async()=>{
  const tools=[{type:'function' as const,function:{name:'get_task',parameters:{type:'object',properties:{}}}}];
  const transport:typeof fetch=async(input,init)=>{
    const request=new Request(input,init),body=await request.json() as any;
    assert.equal(request.url,model.endpoint);assert.deepEqual(body.tools,tools);assert.equal(body.tool_choice,'auto');assert.equal(body.response_format,undefined);
    const result=response();result.choices[0].message.content=null;
    result.choices[0].message.tool_calls=[{id:'one',type:'function',function:{name:'get_task',arguments:'{}'}}];
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  };
  assert.equal((await requestCompletion(model,[{role:'user',content:'start'}],10,undefined,transport,tools)).choices[0].message.tool_calls![0].id,'one');
});

test('agent capability probe consumes actual pixels, valid function calls and unpredictable tool receipts',async()=>{
  let calls=0;
  const complete:AgentCompletionRequest=async(_model,messages,tools)=>{
    calls++;
    assert.equal(tools[0].type,'function');
    if(calls===1){
      assert.ok(messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/png;base64,'))));
      const result=response();result.choices[0].message.content=null;result.choices[0].message.tool_calls=[{id:'colors',type:'function',function:{name:'submit_image_colors',arguments:'{"left":"red","right":"blue"}'}}];return result;
    }
    const tool=messages.at(-1)!;assert.equal(tool.role,'tool');return response(tool.content as string);
  };
  assert.equal((await testAgentModel(model,undefined,complete)).tools,true);assert.equal(calls,2);
  await assert.rejects(testAgentModel(model,undefined,async()=>response()),/工具调用测试/);
  calls=0;
  await assert.rejects(testAgentModel(model,undefined,async(...args)=>++calls===1?(()=>{const r=response();r.choices[0].message.tool_calls=[{id:'x',type:'function',function:{name:'submit_image_colors',arguments:'{"left":"red","right":"green"}'}}];return r;})():complete(...args)),/实际图片识别/);
});
function response(content = '{"left":"red","right":"blue"}'): Completion {
  return { choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null } }], usage: { total_tokens: 12 } };
}

test('SDK uses configured full endpoint, model and key, without retries or following redirects', async () => {
  let count = 0;
  const transport: typeof fetch = async (input, init) => {
    count++;
    const req = new Request(input, init);
    assert.equal(req.url, model.endpoint);
    assert.equal(req.headers.get('authorization'), 'Bearer secret-test-key');
    assert.equal(req.redirect, 'error');
    const body = await req.json() as Record<string, unknown>;
    assert.equal(body.model, model.name);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    return new Response(JSON.stringify(response()), { headers: { 'content-type': 'application/json' } });
  };
  const actual = await requestCompletion(model, [{ role: 'user', content: 'hello' }], 10, undefined, transport);
  assert.equal(actual.choices[0].message.content, response().choices[0].message.content);
  assert.equal(count, 1);
});

test('provider image rejection is actionable and credentials are redacted', async () => {
  let requests = 0;
  const transport: typeof fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ error: { message: `image_url unsupported secret-test-key Bearer another-secret https://bad.example/key`, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(requestCompletion(model, [{ role: 'user', content: 'hello' }], 10, undefined, transport), error => {
    assert.match((error as Error).message, /支持图片输入/);
    assert.doesNotMatch((error as Error).message, /secret-test-key|another-secret|bad\.example/);
    return true;
  });
  assert.equal(requests, 1);
});

test('abort reaches transport and ends the model request', async () => {
  const controller = new AbortController();
  const transport: typeof fetch = async (_input, init) => {
    controller.abort();
    assert.ok(init?.signal);
    throw new DOMException('aborted', 'AbortError');
  };
  await assert.rejects(requestCompletion(model, [{ role: 'user', content: 'hello' }], 10, controller.signal, transport), /模型请求已取消/);
});

test('model test sends real image and requires correct image answer', async () => {
  let observed = false;
  const complete: CompletionRequest = async (config, messages) => {
    assert.equal(config, model);
    const content = messages[1].content;
    assert.ok(Array.isArray(content));
    assert.ok(content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,iVBOR')));
    observed = true;
    return response();
  };
  assert.equal((await testModel(model, undefined, complete)).vision, true);
  assert.ok(observed);
  await assert.rejects(testModel(model, undefined, async () => response('{"ok":true}')), /未通过真实图片识别/);
  await assert.rejects(testModel(model, undefined, async () => response('not json')), /JSON/);
});

test('vision test image has complete PNG chunks, correct CRCs and actual red/blue pixel halves', async () => {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  let verified = false;
  await testModel(model, undefined, async (_configuration, messages) => {
    const content = messages[1].content;
    assert.ok(Array.isArray(content));
    const image = content.find(part => part.type === 'image_url');
    assert.ok(image?.type === 'image_url');
    const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const compressed: Buffer[] = [];
    let offset = 8, width = 0, height = 0, ended = false;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      assert.ok(end <= bytes.length, 'PNG chunk is complete');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, end - 4);
      assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)), `${type} CRC`);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        assert.equal(data[8], 8); assert.equal(data[9], 2);
      }
      if (type === 'IDAT') compressed.push(data);
      if (type === 'IEND') ended = true;
      offset = end;
    }
    assert.ok(ended); assert.equal(offset, bytes.length);
    const pixels = inflateSync(Buffer.concat(compressed)), stride = width * 3 + 1;
    assert.ok(width >= 80 && height >= 40);
    assert.equal(pixels.length, stride * height);
    for (let y = 0; y < height; y++) {
      assert.equal(pixels[y * stride], 0, 'unfiltered RGB row');
      assert.deepEqual([...pixels.subarray(y * stride + 1, y * stride + 4)], [255, 0, 0]);
      assert.deepEqual([...pixels.subarray(y * stride + 1 + width / 2 * 3, y * stride + 4 + width / 2 * 3)], [0, 0, 255]);
    }
    verified = true;
    return response();
  });
  assert.ok(verified);
});

test('invalid endpoint is rejected before any transport call', async () => {
  await assert.rejects(requestCompletion({ ...model, endpoint: 'https://user:pass@model.example/test' }, []), /无凭据/);
});
