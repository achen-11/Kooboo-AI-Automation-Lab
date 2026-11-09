import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/runtime.js';
import { TimingLedger, intervalUnion } from '../server/automation/timing.js';
import type { AutomationTask } from '../shared/automation.js';
import { formatDuration } from '../shared/timing.js';

function fixture() {
  const db=new Database(':memory:');
  db.exec('CREATE TABLE auto_usage(task_id TEXT, json TEXT)');
  const ledger=new TimingLedger(db);
  const task={id:'first',createdAt:1000,status:'queued',kind:'generation',stopped:true} as AutomationTask;
  return {db,ledger,task,close:()=>db.close()};
}

test('phase timing separates queue and nested planning, and unions concurrent site work',()=>{
  const f=fixture();try{
    const {ledger,task,db}=f;
    ledger.observe(task,true,1000);
    task.status='running';task.stopped=false;task.stage='prepare';ledger.observe(task,false,2000);
    db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run('planning',task.id,'planning',1,2500,3500,3500);
    task.stage='generation';ledger.observe(task,false,4000);
    task.status='completed';task.stopped=true;ledger.observe(task,false,6000);
    const next={...task,id:'review',kind:'evaluation',createdAt:5000,status:'running',stopped:false,stage:'evaluation'} as AutomationTask;
    ledger.observe(next,true,5000);next.status='completed';next.stopped=true;ledger.observe(next,false,8000);
    const summary=ledger.summary([task.id,next.id,task.id],9000);
    assert.equal(summary.elapsedMs,7000);assert.equal(summary.recordedMs,7000);assert.equal(summary.complete,true);assert.equal(summary.active,false);
    assert.deepEqual(summary.stages.map(row=>[row.stage,row.recordedMs]),[['queue',1000],['prepare',1000],['planning',1000],['generation',2000],['evaluation',3000]]);
    assert.equal(intervalUnion([[1,5],[2,3],[5,7],[10,12],[9,8]]),8);
  }finally{f.close();}
});

test('historical tasks expose request intervals without inventing lifecycle, unknown durations or serial totals',()=>{
  const f=fixture();try{
    for(const [id,stage,start,end,status] of [['old','evaluation',1000,4000,'completed'],['old','evaluation',2000,5000,'failed'],['old','followup',3000,6000,'completed'],['old','evaluation',7000,7000,'unknown'],['old','evaluation',null,8000,'completed']]){
      f.db.prepare('INSERT INTO auto_usage VALUES(?,?)').run(id,JSON.stringify({stage,startedAt:start,endedAt:end,status}));
    }
    const summary=f.ledger.summary(['old'],10000);
    assert.equal(summary.elapsedMs,null);assert.equal(summary.recordedMs,0);assert.equal(summary.modelMs,5000);assert.equal(summary.complete,false);assert.equal(summary.unknownRequests,2);
    assert.equal(summary.stages.find(row=>row.stage==='evaluation')!.modelMs,4000);
    assert.equal(summary.stages.find(row=>row.stage==='evaluation')!.requests,4);
    assert.equal(formatDuration(null),'未记录');assert.equal(formatDuration(3661000),'1 小时 1 分');
  }finally{f.close();}
});

test('restart counts execution only to its heartbeat, keeps durable queue time, and never claims complete timing',()=>{
  const f=fixture();try{
    const {task,ledger}=f;
    task.status='running';task.stopped=false;task.stage='evaluation';ledger.observe(task,true,1000);ledger.heartbeat(task.id,3000);
    const queued={...task,id:'waiting',status:'queued',stopped:true} as AutomationTask;ledger.observe(queued,true,1500);
    ledger.recover();
    let summary=ledger.summary([task.id],20000);
    assert.equal(summary.recordedMs,2000);assert.equal(summary.elapsedMs,null);assert.equal(summary.active,false);
    summary=ledger.summary([queued.id],20000);
    assert.equal(summary.recordedMs,18500);assert.equal(summary.active,true);assert.equal(summary.complete,true);
    task.status='queued';task.stopped=true;ledger.observe(task,false,21000);
    summary=ledger.summary([task.id],22000);
    assert.equal(summary.recordedMs,3000);assert.equal(summary.complete,false,'resuming must not fill in the unknown downtime');
  }finally{f.close();}
});

test('waiting for a followup slot is queue time rather than paid followup execution',()=>{
  const f=fixture();try{
    const {task,ledger}=f;
    task.status='following-up';task.followup={state:'waiting'} as AutomationTask['followup'];ledger.observe(task,true,1000);
    task.stopped=false;task.followup!.state='running';ledger.observe(task,false,5000);
    task.stopped=true;task.status='interrupted';ledger.observe(task,false,6000);
    assert.deepEqual(ledger.summary([task.id],9000).stages.map(row=>[row.stage,row.recordedMs]),[['queue',4000],['followup',1000]]);
  }finally{f.close();}
});
