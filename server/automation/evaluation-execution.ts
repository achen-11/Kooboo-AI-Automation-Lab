import { randomUUID } from 'node:crypto';
import type { Database } from '../runtime.js';

export interface EvaluationExecution {taskId:string;token:string;ownerPid:number;threadId:string;startedAt:number;endedAt:number|null;state:'running'|'stopped'|'unconfirmed'}
/** A dead worker PID alone never proves that its SDK child and browser stopped. */
export class EvaluationExecutions {
  constructor(private db:Database){db.exec('CREATE TABLE IF NOT EXISTS auto_evaluation_executions(task_id TEXT PRIMARY KEY,json TEXT NOT NULL)');}
  get(taskId:string):EvaluationExecution|undefined {const row=this.db.prepare('SELECT json FROM auto_evaluation_executions WHERE task_id=?').get(taskId);return row?JSON.parse(row.json):undefined;}
  begin(taskId:string){const value:EvaluationExecution={taskId,token:randomUUID(),ownerPid:process.pid,threadId:'',startedAt:Date.now(),endedAt:null,state:'running'};this.db.prepare('INSERT OR REPLACE INTO auto_evaluation_executions VALUES(?,?)').run(taskId,JSON.stringify(value));return value.token;}
  thread(taskId:string,token:string,threadId:string){const value=this.get(taskId);if(value?.token===token){value.threadId=threadId;this.db.prepare('UPDATE auto_evaluation_executions SET json=? WHERE task_id=?').run(JSON.stringify(value),taskId);}}
  finish(taskId:string,token:string,confirmed:boolean){const value=this.get(taskId);if(value?.token===token){value.state=confirmed?'stopped':'unconfirmed';value.endedAt=confirmed?Date.now():null;this.db.prepare('UPDATE auto_evaluation_executions SET json=? WHERE task_id=?').run(JSON.stringify(value),taskId);}}
  observation(taskId:string){return {executor:'codex-evaluation',taskId,execution:this.get(taskId)||null,events:this.db.prepare('SELECT seq,time,message FROM auto_events WHERE task_id=? ORDER BY seq DESC LIMIT 8').all(taskId).reverse().map(row=>({...row,message:String(row.message).slice(0,1500)}))};}
}
