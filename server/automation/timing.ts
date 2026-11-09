import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../runtime.js';
import type { AutomationTask } from '../../shared/automation.js';
import { timingStageNames, type TimingStage, type TimingSummary } from '../../shared/timing.js';
import type { AutomationStore } from './store.js';
import { generationStage } from '../../shared/generation-stage.js';

interface Span { task_id: string; stage: TimingStage; started_at: number; ended_at: number | null; heartbeat: number; layer: number }
interface TimingRecord { task_id:string; created_at:number; tracked_from:number }
interface RequestInterval { task_id:string; stage:string; start:number|null; end:number|null; status:string }
const phases = new Set(Object.keys(timingStageNames));
const stageFor = (task: AutomationTask): TimingStage | null => {
  if (task.status === 'queued') return 'queue';
  if (task.status === 'following-up') {
    if(task.followup?.state==='waiting')return 'queue';
    return !task.stopped&&task.followup?.state==='running'?(task.stage==='optimization'?'optimization':'followup'):null;
  }
  if (task.stopped) return null;
  if (!['running', 'cancelling'].includes(task.status)) return null;
  return phases.has(task.stage || '') ? task.stage as TimingStage : task.kind;
};

export function intervalUnion(intervals: readonly (readonly [number, number])[]): number {
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).toSorted((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop);
  }
  return total;
}

/** Worker lifecycle timing is independent of events, billing and task updatedAt. */
export class TimingLedger {
  constructor(private db: Database, private generationRound: (taskId: string) => number = () => 0) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_timing_tasks(task_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,tracked_from INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_timing_spans(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,stage TEXT NOT NULL,layer INTEGER NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,heartbeat INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auto_timing_task ON auto_timing_spans(task_id,layer,ended_at);
      CREATE UNIQUE INDEX IF NOT EXISTS auto_timing_current ON auto_timing_spans(task_id) WHERE ended_at IS NULL AND layer=0;`);
  }
  observe(task: AutomationTask, fresh: boolean, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO auto_timing_tasks VALUES(?,?,?)').run(task.id,task.createdAt,fresh?task.createdAt:now);
    const current = this.db.prepare('SELECT id,stage FROM auto_timing_spans WHERE task_id=? AND layer=0 AND ended_at IS NULL').get(task.id);
    const stage = stageFor(task);
    if (current?.stage === stage) {this.heartbeat(task.id,now);return;}
    if (current) this.db.prepare('UPDATE auto_timing_spans SET ended_at=?,heartbeat=? WHERE id=?').run(now,now,current.id);
    if (stage) this.db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(randomUUID(),task.id,stage,0,now,null,now);
  }
  heartbeat(taskId: string, now = Date.now()) {
    this.db.prepare('UPDATE auto_timing_spans SET heartbeat=? WHERE task_id=? AND ended_at IS NULL').run(now,taskId);
  }
  activity(taskId: string, stage: TimingStage) {
    const id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO auto_timing_spans VALUES(?,?,?,?,?,?,?)').run(id,taskId,stage,1,now,null,now);
    const timer = setInterval(() => this.db.prepare('UPDATE auto_timing_spans SET heartbeat=? WHERE id=? AND ended_at IS NULL').run(Date.now(),id),1000); timer.unref();
    return () => { clearInterval(timer);const end = Date.now();this.db.prepare('UPDATE auto_timing_spans SET ended_at=?,heartbeat=? WHERE id=? AND ended_at IS NULL').run(end,end,id); };
  }
  recover() {
    // A crash leaves no trustworthy end time. Exclude downtime and mark the lifecycle incomplete.
    this.db.exec(`UPDATE auto_timing_tasks SET tracked_from=MAX(tracked_from,created_at+1) WHERE task_id IN (SELECT task_id FROM auto_timing_spans WHERE ended_at IS NULL AND stage<>'queue');
      UPDATE auto_timing_spans SET ended_at=heartbeat WHERE ended_at IS NULL AND stage<>'queue';`);
  }
  summary(taskIds: string[], now = Date.now()): TimingSummary {
    return this.summaries(new Map([['summary',taskIds]]),now).get('summary')!;
  }
  /** Read compact columns in bounded batches, rather than scanning a ledger once per workflow. */
  summaries(groups:ReadonlyMap<string,string[]>,now=Date.now()) {
    const ids=[...new Set([...groups.values()].flat())],spans:Span[]=[],records:TimingRecord[]=[],requests:RequestInterval[]=[];
    for(let offset=0;offset<ids.length;offset+=500){
      const batch=ids.slice(offset,offset+500),marks=batch.map(()=>'?').join(',');
      spans.push(...this.db.prepare(`SELECT task_id,stage,layer,started_at,ended_at,heartbeat FROM auto_timing_spans WHERE task_id IN (${marks})`).all(...batch) as Span[]);
      records.push(...this.db.prepare(`SELECT task_id,created_at,tracked_from FROM auto_timing_tasks WHERE task_id IN (${marks})`).all(...batch) as TimingRecord[]);
      requests.push(...this.db.prepare(`SELECT task_id,json_extract(json,'$.stage') stage,json_extract(json,'$.startedAt') start,json_extract(json,'$.endedAt') end,json_extract(json,'$.status') status FROM auto_usage WHERE task_id IN (${marks})`).all(...batch) as RequestInterval[]);
    }
    const rounds = new Map(ids.map(id => [id, this.generationRound(id)]));
    for (const span of spans) span.stage = generationStage(span.stage, rounds.get(span.task_id));
    for (const request of requests) request.stage = generationStage(request.stage, rounds.get(request.task_id));
    const byTask=<T extends {task_id:string}>(rows:T[])=>{const result=new Map<string,T[]>();for(const row of rows){const own=result.get(row.task_id)||[];own.push(row);result.set(row.task_id,own);}return result;};
    const s=byTask(spans),r=byTask(records),q=byTask(requests);
    return new Map([...groups].map(([key,group])=>{const unique=[...new Set(group)];return [key,summarizeTiming(unique,unique.flatMap(id=>s.get(id)||[]),unique.flatMap(id=>r.get(id)||[]),unique.flatMap(id=>q.get(id)||[]),now)];}));
  }
}

function summarizeTiming(ids:string[],spans:Span[],records:TimingRecord[],requests:RequestInterval[],now:number):TimingSummary {
    if(!ids.length)return {elapsedMs:null,recordedMs:0,modelMs:0,complete:false,active:false,unknownRequests:0,stages:[]};
    const intervals = new Map<TimingStage, [number,number][]>(), model = new Map<TimingStage, [number,number][]>();
    const add = (map: typeof intervals, stage: TimingStage, start: number, end: number) => { if (end > start) {const list=map.get(stage)||[];list.push([start,end]);map.set(stage,list);} };
    // Attribute nested planning/learning exclusively, so they are not counted again as generation/evaluation.
    for (const id of ids) {
      const own = spans.filter(span => span.task_id === id);
      const points = [...new Set(own.flatMap(span => [span.started_at,span.ended_at ?? now]))].sort((a,b)=>a-b);
      for (let i=1;i<points.length;i++) {
        const start=points[i-1], end=points[i];
        const owner=own.filter(span=>span.started_at<=start&&(span.ended_at??now)>=end).sort((a,b)=>b.layer-a.layer||b.started_at-a.started_at)[0];
        if(owner)add(intervals,owner.stage,start,end);
      }
    }
    const requestTimeKnown=(request:typeof requests[number])=>request.status!=='unknown'&&typeof request.start==='number'&&typeof request.end==='number'&&Number.isFinite(request.start)&&Number.isFinite(request.end)&&request.end>=request.start;
    for(const request of requests)if(phases.has(request.stage)&&requestTimeKnown(request))add(model,request.stage as TimingStage,request.start!,request.end!);
    const complete=records.length===ids.length&&records.every(record=>record.tracked_from<=record.created_at);
    const active=spans.some(span=>span.ended_at===null);
    const start=records.length?Math.min(...records.map(record=>Number(record.created_at))):now;
    const end=spans.length?Math.max(...spans.map(span=>span.ended_at??now)):start;
    const stages=(Object.keys(timingStageNames) as TimingStage[]).map(stage=>({stage,recordedMs:intervalUnion(intervals.get(stage)||[]),modelMs:intervalUnion(model.get(stage)||[]),requests:requests.filter(request=>request.stage===stage).length})).filter(stage=>stage.recordedMs||stage.requests);
    return {elapsedMs:complete?Math.max(0,end-start):null,recordedMs:intervalUnion([...intervals.values()].flat()),modelMs:intervalUnion([...model.values()].flat()),complete,active,unknownRequests:requests.filter(request=>!requestTimeKnown(request)).length,stages};
}

export function registerTimingApi(app: FastifyInstance, store: AutomationStore) {
  const params=z.object({id:z.string().uuid()});
  app.get('/api/automation/tasks/:id/timing',async(request,reply)=>{
    const {id}=params.parse(request.params),task=store.header(id);
    return task?store.timing.summary(task.workflowIds):reply.code(404).send({error:'任务不存在'});
  });
  app.get('/api/automation/site-deliveries/:id/timing',async(request,reply)=>{
    const {id}=params.parse(request.params);
    if(!store.site(id))return reply.code(404).send({error:'生成站不存在'});
    return store.timing.summary(store.headers(id).map(task=>task.id));
  });
}
