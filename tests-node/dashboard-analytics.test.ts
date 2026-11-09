import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { AutomationStore } from '../server/automation/store.js';
import { Database } from '../server/runtime.js';
import { defaultAutomationSettings, type AutomationTask } from '../shared/automation.js';
import type { AnalyticsQuery } from '../shared/dashboard-analytics.js';
import { dashboardAnalytics, registerDashboardAnalyticsApi } from '../server/automation/dashboard-analytics.js';

const minute=60000, hour=60*minute;
const at=(time:string)=>Date.parse('2026-11-09T'+time+':00+08:00');
function fixture(){
  const db=new Database(':memory:'),store=new AutomationStore(db),settings=structuredClone(defaultAutomationSettings);
  const resource=store.saveResource({name:'Example',scenario:'site-template',description:'',contentUrl:'https://example.test',referenceUrl:'',files:[],externalId:'',externalSource:''});
  function task(created=at('11:40'),kind:AutomationTask['kind']='evaluation',status:AutomationTask['status']='completed'){
    const item={...store.create({resourceIds:[resource.id],kind:'generation',scope:'site',environmentId:randomUUID(),requirements:''},settings)[0],kind,status,stopped:!['running','following-up','cancelling'].includes(status),createdAt:created};
    store.put(item);db.prepare('UPDATE auto_tasks SET created_at=? WHERE id=?').run(created,item.id);db.prepare('UPDATE auto_task_index SET created_at=? WHERE id=?').run(created,item.id);
    db.prepare('DELETE FROM auto_timing_tasks WHERE task_id=?').run(item.id);db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(item.id);return item;
  }
  function span(item:AutomationTask,start:number,end:number|null,stage:string=item.kind,layer=0,heartbeat=end??start){
    db.prepare('INSERT OR IGNORE INTO auto_timing_tasks VALUES(?,?,?)').run(item.id,item.createdAt,item.createdAt);
    db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(randomUUID(),item.id,stage,layer,start,end,heartbeat);
  }
  function charge(item:AutomationTask,start:number|null,cost:number|null,stage:string=item.kind){db.prepare('INSERT INTO auto_usage VALUES(?,?,?,?)').run(item.id,'codex',randomUUID(),JSON.stringify({stage,startedAt:start,endedAt:start===null?null:start+minute,cny:cost,status:cost===null?'unknown':'completed',endpoint:'SECRET-ENDPOINT',raw:{secret:'SECRET-USAGE'}}));}
  const query=(overrides:Partial<AnalyticsQuery>={})=>({start:at('11:00'),end:at('13:00'),granularity:'hour',scenario:'site-template',scope:'all',unit:'evaluation',page:1,...overrides}) as AnalyticsQuery;
  return {db,store,resource,task,span,charge,query,run:(overrides:Partial<AnalyticsQuery>={},now=at('18:00'))=>dashboardAnalytics(store,query(overrides),now)};
}

test('cross-hour work is split for consumption and counted once, in its start cohort, for full-duration efficiency',()=>{
  const f=fixture();try{const task=f.task();f.span(task,at('11:40'),at('11:50'),'queue');f.span(task,at('11:50'),at('12:30'));f.charge(task,at('12:10'),4);
    const result=f.run();assert.equal(result.buckets.length,2);
    assert.equal(result.buckets[0].stages.reduce((n,s)=>n+s.recordedMs,0),10*minute);assert.equal(result.buckets[1].stages.reduce((n,s)=>n+s.recordedMs,0),30*minute);
    assert.equal(result.buckets[0].efficiency.averageMs,40*minute);assert.equal(result.buckets[0].efficiency.averageCost,4);assert.equal(result.buckets[1].efficiency.selected,0);assert.equal(result.buckets[1].efficiency.averageMs,null);
    assert.equal(result.consumption.queueMs,10*minute);assert.equal(result.efficiency.averageMs,40*minute);assert.equal(result.runs.items[0].startedAt,at('11:50'));
    const narrow=f.run({start:at('12:00'),end:at('13:00')});assert.equal(narrow.consumption.recordedMs,30*minute);assert.equal(narrow.efficiency.selected,0);
  }finally{f.db.close();}
});

test('incomplete historical timing is never presented as a complete cumulative execution total', () => {
  const f=fixture();try {
    const timed=f.task(),historical=f.task(at('11:45'),'generation','interrupted');
    f.span(timed,at('11:50'),at('12:30'));f.charge(timed,at('12:10'),2);f.charge(historical,at('12:15'),3);
    const result=f.run();
    assert.equal(result.consumption.recordedMs,40*minute);
    assert.equal(result.consumption.executionMs,null);
    assert.deepEqual(result.consumption.timing,{tasks:2,complete:1,incomplete:1});
    assert.equal(result.consumption.knownCny,5,'missing lifecycle timing must not hide charges');
    const older=f.task(at('10:00'),'generation');f.charge(older,at('10:59'),1);
    f.db.prepare("UPDATE auto_usage SET json=json_set(json,'$.endedAt',?) WHERE task_id=?").run(at('11:10'),older.id);
    const narrow=f.run({start:at('11:00'),end:at('11:10')});
    assert.equal(narrow.consumption.requests,0);
    assert.equal(narrow.consumption.executionMs,null,'requests crossing into a period still expose missing execution timing');
    assert.deepEqual(narrow.consumption.timing,{tasks:1,complete:0,incomplete:1});
    const future=f.run({start:at('19:00'),end:at('20:00')});
    assert.equal(future.consumption.executionMs,0);assert.equal(future.consumption.timing.tasks,0);
  }finally{f.db.close();}
});

test('complete parallel tasks add their execution time; partial recovery makes the total incomplete', () => {
  const f=fixture();try {
    const first=f.task(),second=f.task();f.span(first,at('11:50'),at('12:10'));f.span(second,at('11:55'),at('12:15'));
    let result=f.run();assert.equal(result.consumption.executionMs,40*minute);assert.deepEqual(result.consumption.timing,{tasks:2,complete:2,incomplete:0});
    f.db.prepare('UPDATE auto_timing_tasks SET tracked_from=created_at+1 WHERE task_id=?').run(second.id);
    result=f.run();assert.equal(result.consumption.executionMs,null);assert.equal(result.consumption.recordedMs,40*minute);assert.deepEqual(result.consumption.timing,{tasks:2,complete:1,incomplete:1});
    assert.equal(result.buckets.reduce((sum,b)=>sum+b.stages.reduce((sum,s)=>sum+s.recordedMs,0),0),40*minute);
  }finally{f.db.close();}
});

test('long old work does not contaminate a newer start cohort; comparison includes its full lifetime after the selected hour',()=>{
  const f=fixture();try{const old=f.task(),fresh=f.task(at('13:00'));f.span(old,at('11:50'),at('13:10'));f.span(fresh,at('13:05'),at('13:20'));f.charge(old,at('13:01'),8);f.charge(fresh,at('13:10'),2);
    const result=f.run({start:at('13:00'),end:at('14:00'),compareStart:at('11:00'),compareEnd:at('12:00')});
    assert.equal(result.efficiency.averageMs,15*minute);assert.equal(result.comparison!.efficiency.averageMs,80*minute);assert.equal(result.comparison!.efficiency.averageCost,8);
    assert.equal(result.consumption.recordedMs,25*minute);assert.equal(result.consumption.knownCny,10);
  }finally{f.db.close();}
});

test('unfinished, failed and interrupted tasks remain visible without becoming completed efficiency samples',()=>{
  const f=fixture();try{const good=f.task(),active=f.task(at('11:40'),'evaluation','running'),failed=f.task(at('11:40'),'evaluation','failed'),interrupted=f.task(at('11:40'),'evaluation','interrupted'),queued=f.task(at('11:40'),'evaluation','queued');
    f.span(good,at('11:50'),at('12:10'));f.span(active,at('11:50'),null,'evaluation',0,at('12:05'));f.span(failed,at('11:50'),at('12:00'));f.span(interrupted,at('11:50'),at('12:00'));f.span(queued,at('11:40'),null,'queue');
    for(const item of [good,active,failed,interrupted])f.charge(item,at('11:55'),1);
    const result=f.run({},at('12:10'));assert.equal(result.efficiency.selected,5);assert.equal(result.efficiency.completed,1);assert.equal(result.efficiency.active,1);assert.equal(result.efficiency.queued,1);assert.equal(result.efficiency.failed,1);assert.equal(result.efficiency.interrupted,1);
    assert.equal(result.efficiency.averageMs,20*minute);assert.equal(result.efficiency.costSamples,1);assert.equal(result.consumption.knownCny,4);assert.equal(result.runs.items.find(r=>r.id===active.id)!.recordedMs,15*minute,'open work stops at trusted heartbeat');
  }finally{f.db.close();}
});

test('nested evidence replaces outer evaluation time; parallel tasks accumulate without double-counting nested work',()=>{
  const f=fixture();try{const first=f.task(),second=f.task();f.span(first,at('11:50'),at('12:30'));f.span(first,at('12:00'),at('12:10'),'evidence',1);f.span(second,at('11:50'),at('12:30'));
    const result=f.run();assert.equal(result.efficiency.averageMs,40*minute);assert.equal(result.consumption.recordedMs,80*minute);assert.equal(result.consumption.stages.find(s=>s.stage==='evidence')!.recordedMs,10*minute);
    assert.equal(result.efficiency.stages.reduce((sum,s)=>sum+(s.averageMs||0),0),result.efficiency.averageMs);
  }finally{f.db.close();}
});

test('unconfirmed interrupted executions are not advertised as actively running or confirmed finished',()=>{
  const f=fixture();try{const item=f.task(at('11:40'),'evaluation','interrupted');item.stopped=false;f.store.put(item);f.db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(item.id);f.span(item,at('11:50'),at('12:00'));
    const result=f.run();assert.equal(result.efficiency.active,0);assert.equal(result.efficiency.interrupted,1);assert.equal(result.runs.items[0].endedAt,null);assert.equal(result.runs.items[0].durationMs,null);assert.equal(result.efficiency.timingSamples,0);
  }finally{f.db.close();}
});

test('workflow groups automatic handoffs and repairs but preserves independent manual reviews and later continuations',()=>{
  const f=fixture();try{const root=f.task(at('11:00'),'generation'),auto=f.task(at('11:30')),manual=f.task(at('11:40')),continuation=f.task(at('11:45'),'generation'),repair=f.task(at('11:46'),'generation');
    root.evaluationTaskId=auto.id;auto.parentId=root.id;manual.parentId=root.id;repair.optimizationRootId=root.id;repair.optimizationRound=1;
    for(const item of [root,auto,manual,repair]){f.store.put(item);f.db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(item.id);}
    f.span(root,at('11:01'),at('11:20'));f.span(auto,at('11:30'),at('11:40'));f.span(manual,at('11:41'),at('11:43'));f.span(continuation,at('11:46'),at('11:48'));f.span(repair,at('11:47'),at('11:50'));
    for(const item of [root,auto,manual,continuation,repair])f.charge(item,at('11:50'),1);
    const result=f.run({unit:'workflow'});assert.equal(result.efficiency.selected,3);assert.equal(result.overview.workflows,3);assert.equal(result.runs.items.find(r=>r.id===root.id)!.knownCny,3);assert.equal(result.runs.items.find(r=>r.id===root.id)!.repairs,1);
    assert.equal(result.consumption.stages.find(s=>s.stage==='repair')!.knownCny,1);
  }finally{f.db.close();}
});

test('custom minute boundaries, half-open membership, unknown costs and incomplete timing retain their meaning',()=>{
  const f=fixture();try{const historical=f.task(at('11:50')),unknown=f.task(at('11:51')),zero=f.task(at('11:52'));
    f.charge(historical,at('11:55'),5);f.charge(historical,at('12:00'),9);f.charge(historical,null,null);f.charge(unknown,at('11:56'),null);f.charge(zero,at('11:57'),0);
    f.span(unknown,at('11:51'),at('11:58'));f.span(zero,at('11:52'),at('11:58'));
    const result=f.run({start:at('11:50'),end:at('12:00')});assert.equal(result.consumption.knownCny,5);assert.equal(result.consumption.missingCosts,1);assert.equal(result.consumption.unplacedRequests,1);
    assert.equal(result.efficiency.missingStarts,1);assert.equal(result.efficiency.averageCost,0);assert.equal(result.efficiency.costSamples,1);assert.equal(result.efficiency.timingSamples,2);assert.equal(result.buckets[0].efficiency.selected,2);
    const serialized=JSON.stringify(result);assert.ok(!serialized.includes('SECRET-'));assert.ok(!serialized.includes('endpoint'));assert.ok(!serialized.includes('raw'));
  }finally{f.db.close();}
});

test('global counts stay global; scenario/scope filters and paginated details use the same selected population',()=>{
  const f=fixture();try{for(let i=0;i<23;i++){const item=f.task(at('11:40')+i);f.span(item,at('11:50')+i,at('12:00')+i);f.charge(item,at('11:55'),1);}
    const home=f.task();home.scope='homepage';f.store.put(home);f.db.prepare('DELETE FROM auto_timing_spans WHERE task_id=?').run(home.id);f.span(home,at('11:50'),at('12:00'));f.charge(home,at('11:55'),99);
    const result=f.run({scope:'site',page:2});assert.equal(result.efficiency.selected,23);assert.equal(result.runs.total,23);assert.equal(result.runs.items.length,3);assert.equal(result.runs.page,2);assert.equal(result.consumption.knownCny,23);assert.equal(result.overview.resources,1);
    const empty=f.run({scenario:'app-template'});assert.equal(empty.overview.workflows,24);assert.equal(empty.efficiency.selected,0);assert.equal(empty.consumption.knownCny,0);
  }finally{f.db.close();}
});

test('analytics API validates ranges and comparison pairs and serves aggregates only',async()=>{
  const f=fixture(),app=Fastify();registerDashboardAnalyticsApi(app,f.store);
  app.setErrorHandler((_error,_request,reply)=>reply.code(400).send({error:'invalid'}));
  try{for(const suffix of ['start=2&end=1','start=0&end=999999999999','start=0&end=3600000&compareStart=1','start=0&end=3600000&unit=invalid']){const response=await app.inject({method:'GET',url:'/api/automation/dashboard/analytics?'+suffix});assert.equal(response.statusCode,400);}
    const response=await app.inject({method:'GET',url:'/api/automation/dashboard/analytics?start='+at('11:00')+'&end='+at('13:00')+'&granularity=hour'});assert.equal(response.statusCode,200);assert.equal(response.json().buckets.length,2);
  }finally{await app.close();f.db.close();}
});
