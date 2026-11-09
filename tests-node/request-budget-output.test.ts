import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/runtime.js';
import { RequestBudget } from '../server/automation/request-budget.js';

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
