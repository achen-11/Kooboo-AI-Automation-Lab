import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/runtime.js';
import { RequestBudget, retainAccountReservations } from '../server/automation/request-budget.js';

test('larger collection output windows are opt-in and still bounded by requested and remaining tokens',()=>{
  const db=new Database(':memory:');
  try{
    const reserve=(key:string,maxOutputTokens?:number,requested?:number,maxTokens=100000)=>{
      const budget=new RequestBudget(db,{key,runKey:key,maxTokens,maxRequests:1,maxOutputTokens});
      return JSON.parse(budget.reserve(key,Buffer.from(JSON.stringify({input:'hello',...(requested===undefined?{}:{max_output_tokens:requested})}))).toString()).max_output_tokens;
    };
    assert.equal(reserve('default'),8192);
    assert.equal(reserve('collection',16384),16384);
    assert.equal(reserve('requested',16384,1000),1000);
    assert.equal(reserve('capped',16384,90000),16384);
    const available=reserve('remaining',16384,undefined,1000);
    assert.ok(available>0&&available<1000);
  }finally{db.close();}
});

test('maxConcurrent defaults to single-flight, shares remaining token cap across concurrent reservations, and retains all active rows on recovery',()=>{
  const db=new Database(':memory:');
  try{
    for(const invalid of [0,-1,1.5]){
      assert.throws(()=>new RequestBudget(db,{key:`bad-${invalid}`,runKey:'bad',maxTokens:10000,maxRequests:2,maxConcurrent:invalid}),/模型预算配置不合法/);
    }

    const single=new RequestBudget(db,{key:'single-flight',runKey:'r1',maxTokens:100000,maxRequests:5});
    single.reserve('s1',Buffer.from(JSON.stringify({input:'one'})));
    assert.equal(single.activeRequests(),1);
    assert.throws(()=>single.reserve('s2',Buffer.from(JSON.stringify({input:'two'}))),/同一预算仍有模型请求执行中/);

    const concurrent=new RequestBudget(db,{key:'concurrent-2',runKey:'r2',maxTokens:10000,maxRequests:5,maxConcurrent:2});
    const body1=JSON.parse(concurrent.reserve('c1',Buffer.from(JSON.stringify({input:'desktop'}))).toString());
    assert.equal(body1.max_output_tokens,8192);
    const body2=JSON.parse(concurrent.reserve('c2',Buffer.from(JSON.stringify({input:'mobile'}))).toString());
    assert.ok(body2.max_output_tokens>0&&body2.max_output_tokens<2000,'second concurrent request sees remaining capacity after first active reservation');
    assert.equal(concurrent.activeRequests(),2);
    assert.throws(()=>concurrent.reserve('c3',Buffer.from(JSON.stringify({input:'overflow'}))),/同一预算仍有模型请求执行中/);

    concurrent.complete('c1',{input_tokens:100,output_tokens:50});
    assert.equal(concurrent.activeRequests(),1);
    concurrent.reserve('c3',Buffer.from(JSON.stringify({input:'repair'})));
    assert.equal(concurrent.activeRequests(),2);

    const retained=retainAccountReservations(db,'concurrent-2');
    assert.equal(retained.count,2);
    assert.equal(concurrent.activeRequests(),0);
    assert.equal(concurrent.state().unknown,0);
  }finally{db.close();}
});
