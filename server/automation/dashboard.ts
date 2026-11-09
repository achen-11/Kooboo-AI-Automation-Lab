import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scenarios } from '../../shared/automation.js';
import type { DashboardData, DashboardDay, DashboardTotals } from '../../shared/dashboard.js';
import { timingStageNames, type TimingStage } from '../../shared/timing.js';
import type { AutomationStore } from './store.js';
import { registerDashboardAnalyticsApi } from './dashboard-analytics.js';
import { generationStage } from '../../shared/generation-stage.js';

const dayMs=86400000,offset=8*3600000;
export const beijingDay=(time:number)=>new Date(time+offset).toISOString().slice(0,10);
const empty=():DashboardTotals=>({knownCny:0,requests:0,missingCosts:0,input:0,cached:0,output:0,workflows:0,finished:0,costSamples:0,averageCost:null,timingSamples:0,averageElapsedMs:null,averageQueueMs:null,modelSamples:0,averageModelMs:null});

/** Calendar spend and creation cohorts have separate denominators. No task/event bodies leave this projection. */
export function dashboard(store:AutomationStore,days:number,scenario:DashboardData['scenario'],now=Date.now()):DashboardData {
  const start=Math.floor((now+offset)/dayMs)*dayMs-offset-(days-1)*dayMs,previousStart=start-days*dayMs;
  const all=store.headers(),byId=new Map(all.map(t=>[t.id,t]));
  const rootId=(id:string)=>{let current=id;const seen=new Set<string>();while(!seen.has(current)){seen.add(current);const task=byId.get(current);const parent=task?.optimizationRootId||(task?.kind==='evaluation'?task.parentId:null);if(!parent||!byId.has(parent))return current;current=parent;}return [...seen].sort()[0];};
  const groups=new Map<string,string[]>();
  for(const task of all){const root=rootId(task.id);if(scenario!=='all'&&byId.get(root)?.scenario!==scenario)continue;const ids=groups.get(root)||[];ids.push(task.id);groups.set(root,ids);}
  const owners=new Map([...groups].flatMap(([root,ids])=>ids.map(id=>[id,root] as const)));
  const current=empty(),previous=empty(),daily:DashboardDay[]=Array.from({length:days},(_,i)=>({date:beijingDay(start+i*dayMs),...empty()}));
  const dayMap=new Map(daily.map(day=>[day.date,day]));
  const stages=new Map<TimingStage,DashboardData['stages'][number]>();
  const stage=(name:TimingStage)=>{let value=stages.get(name);if(!value){value={stage:name,knownCny:0,requests:0,missingCosts:0,recordedMs:0,modelMs:0};stages.set(name,value);}return value;};
  const cohortCosts=new Map<string,{known:number;missing:number;requests:number}>();let unplacedRequests=0;
  // One ledger scan: JSON is reduced to aggregate columns by SQLite, never sent to the client.
  const rows=store.db.prepare(`SELECT task_id,json_extract(json,'$.stage') stage,
    CASE WHEN json_type(json,'$.startedAt') IN ('integer','real') THEN CAST((json_extract(json,'$.startedAt')+${offset})/${dayMs} AS INTEGER) ELSE NULL END day,
    COUNT(*) requests,COUNT(json_extract(json,'$.cny')) priced,COALESCE(SUM(json_extract(json,'$.cny')),0) cost,
    COALESCE(SUM(json_extract(json,'$.tokens.input')),0) input,COALESCE(SUM(json_extract(json,'$.tokens.cached')),0) cached,COALESCE(SUM(json_extract(json,'$.tokens.output')),0) output
    FROM auto_usage GROUP BY task_id,stage,day`).all();
  for(const row of rows){const root=owners.get(row.task_id);if(!root)continue;const cost=cohortCosts.get(root)||{known:0,missing:0,requests:0};cost.known+=Number(row.cost);cost.missing+=Number(row.requests)-Number(row.priced);cost.requests+=Number(row.requests);cohortCosts.set(root,cost);
    if(row.day===null){unplacedRequests+=Number(row.requests);continue;}
    const at=Number(row.day)*dayMs-offset;if(at<previousStart||at>=start+days*dayMs)continue;
    const targets=at>=start?[current,dayMap.get(beijingDay(at))!]:[previous];
    for(const target of targets){target.knownCny+=Number(row.cost);target.requests+=Number(row.requests);target.missingCosts+=Number(row.requests)-Number(row.priced);target.input+=Number(row.input);target.cached+=Number(row.cached);target.output+=Number(row.output);}
    const name=generationStage(row.stage,byId.get(row.task_id)?.optimizationRound);
    if(at>=start&&Object.hasOwn(timingStageNames,name)){const value=stage(name);value.knownCny+=Number(row.cost);value.requests+=Number(row.requests);value.missingCosts+=Number(row.requests)-Number(row.priced);}
  }
  const selected=new Map([...groups].filter(([root])=>byId.get(root)!.createdAt>=previousStart&&byId.get(root)!.createdAt<start+days*dayMs));
  const timing=store.timing.summaries(selected,now);
  const sums=new Map<DashboardTotals,{cost:number;elapsed:number;queue:number;model:number}>();
  for(const [root,ids] of selected){const task=byId.get(root)!,at=task.createdAt,summary=timing.get(root)!;
    const finished=ids.every(id=>{const item=byId.get(id)!;return item.stopped&&['completed','cancelled','failed','interrupted'].includes(item.status);})&&(!task.optimization||['completed','stopped'].includes(task.optimization.state));
    const settled=finished&&!summary.active;
    const targets=at>=start?[current,dayMap.get(beijingDay(at))!]:[previous];const cost=cohortCosts.get(root);
    for(const target of targets){const sum=sums.get(target)||{cost:0,elapsed:0,queue:0,model:0};target.workflows++;if(finished)target.finished++;
      if(settled&&cost?.requests&&cost.missing===0){target.costSamples++;sum.cost+=cost.known;}
      if(settled&&summary.elapsedMs!==null){target.timingSamples++;sum.elapsed+=summary.elapsedMs;sum.queue+=summary.stages.find(s=>s.stage==='queue')?.recordedMs||0;}
      if(settled&&cost?.requests&&summary.unknownRequests===0){target.modelSamples++;sum.model+=summary.modelMs;}
      sums.set(target,sum);
    }
    if(at>=start)for(const item of summary.stages){const value=stage(item.stage);value.recordedMs+=item.recordedMs;value.modelMs+=item.modelMs;}
  }
  for(const [target,sum] of sums){target.averageCost=target.costSamples?sum.cost/target.costSamples:null;target.averageElapsedMs=target.timingSamples?sum.elapsed/target.timingSamples:null;target.averageQueueMs=target.timingSamples?sum.queue/target.timingSamples:null;target.averageModelMs=target.modelSamples?sum.model/target.modelSamples:null;}
  return {days,scenario,timezone:'Asia/Shanghai',generatedAt:now,current,previous,daily,stages:[...stages.values()],unplacedRequests};
}

export function registerDashboardApi(app:FastifyInstance,store:AutomationStore){
  registerDashboardAnalyticsApi(app,store);
  app.get('/api/automation/dashboard',async request=>{const input=z.object({days:z.coerce.number().int().min(1).max(90).default(14),scenario:z.enum(['all',...Object.keys(scenarios)] as ['all',...Array<keyof typeof scenarios>]).default('site-template')}).parse(request.query);return dashboard(store,input.days,input.scenario);});
}
