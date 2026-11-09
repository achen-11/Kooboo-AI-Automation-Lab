import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../server/automation/store.js';
import { Database } from '../server/runtime.js';
import { defaultAutomationSettings, type AutomationTask } from '../shared/automation.js';
import { dashboard, beijingDay } from '../server/automation/dashboard.js';
import { changePercent } from '../shared/dashboard.js';

function fixture(){const db=new Database(':memory:'),store=new AutomationStore(db);const settings=structuredClone(defaultAutomationSettings),resource=store.saveResource({name:'Template',scenario:'site-template',description:'',contentUrl:'https://source.test/',referenceUrl:'',files:[],externalId:'',externalSource:''});
  const create=(at:number,kind:AutomationTask['kind']='generation',parentId:string|null=null)=>{const task={...store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},settings)[0],kind,parentId,createdAt:at,status:'completed' as const,stopped:true};store.put(task);db.prepare('UPDATE auto_tasks SET created_at=? WHERE id=?').run(at,task.id);db.prepare('UPDATE auto_task_index SET created_at=? WHERE id=?').run(at,task.id);db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(task.id);db.prepare('DELETE FROM auto_timing_tasks WHERE task_id=?').run(task.id);return task;};
  const charge=(task:AutomationTask,at:number|null,cny:number|null)=>db.prepare('INSERT INTO auto_usage VALUES(?,?,?,?)').run(task.id,'codex',randomUUID(),JSON.stringify({stage:task.kind,startedAt:at,endedAt:at===null?null:at+1000,status:cny===null?'unknown':'completed',cny,tokens:{input:100,cached:80,output:20}}));
  return {db,store,create,charge};}

test('dashboard separates calendar spending from workflow cohorts and never treats unknown costs or missing history as zero',()=>{
  const f=fixture();try{const at=Date.parse('2026-11-09T12:00:00+08:00'),before=at-86400000,old=f.create(before),review=f.create(at,'evaluation',old.id),newTask=f.create(at),unknown=f.create(at),queued=f.create(at);queued.status='queued' as never;f.store.put(queued);
    f.charge(old,before,2);f.charge(review,at,4);f.charge(newTask,at,8);f.charge(unknown,at,null);f.charge(unknown,null,null);
    const result=dashboard(f.store,1,'site-template',at);
    assert.equal(result.current.knownCny,12);assert.equal(result.previous.knownCny,2);assert.equal(result.current.requests,3);assert.equal(result.current.missingCosts,1);assert.equal(result.unplacedRequests,1);
    assert.equal(result.previous.workflows,1,'child evaluation belongs to the original workflow');assert.equal(result.previous.averageCost,6,'full lifetime cost of this creation cohort');assert.equal(result.current.workflows,3);assert.equal(result.current.finished,2,'queued jobs are not finished samples');assert.equal(result.current.averageCost,8);assert.equal(result.current.costSamples,1);assert.equal(result.current.averageElapsedMs,null);assert.equal(result.current.timingSamples,0);assert.equal(result.current.averageModelMs,1000);assert.equal(result.current.modelSamples,1);
    assert.equal(result.daily[0].date,'2026-11-09');assert.equal(result.daily[0].averageCost,8);assert.equal(result.stages.find(s=>s.stage==='evaluation')!.knownCny,4);
    assert.equal(dashboard(f.store,1,'app-template',at).current.requests,0);
    assert.equal(beijingDay(Date.parse('2026-11-08T16:00:00Z')),'2026-11-09');assert.equal(changePercent(1,0),null);assert.equal(changePercent(null,1),null);assert.equal(changePercent(2,4),-50);
  }finally{f.db.close();}
});

test('dashboard averages complete lifecycle cohorts and unions overlapping model calls within each workflow',()=>{
  const f=fixture();try{const at=Date.parse('2026-11-09T01:00:00+08:00'),task=f.create(at),review=f.create(at+4000,'evaluation',task.id);f.charge(task,at,2);f.charge(task,at,2);f.charge(review,at,3);
    for(const item of [task,review])f.db.prepare('INSERT INTO auto_timing_tasks VALUES(?,?,?)').run(item.id,item.createdAt,item.createdAt);
    for(const [id,stage,start,end] of [[task.id,'queue',at,at+1000],[task.id,'generation',at+1000,at+4000],[review.id,'evaluation',at+4000,at+6000]])f.db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,stage,0,start,end,end);
    const result=dashboard(f.store,7,'site-template',at+9000);assert.equal(result.current.averageElapsedMs,6000);assert.equal(result.current.averageQueueMs,1000);assert.equal(result.current.averageModelMs,1000);assert.equal(result.current.averageCost,7);assert.equal(result.current.workflows,1);
  }finally{f.db.close();}
});
