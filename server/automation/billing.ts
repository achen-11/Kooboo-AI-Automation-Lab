import { randomUUID } from 'node:crypto';
import type { Database } from '../runtime.js';
import type { PriceSnapshot, TokenUsage, UsageEntry, UsageObservation, UsageSummary, UsageStage } from '../../shared/billing.js';

// Calendar source: https://www.gov.cn/zhengce/content/202511/content_7047090.htm (verified 2026-11-07).
// DeepSeek explicitly makes all weekends offpeak, including government make-up workdays.
const holidayRanges=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
const days=holidayRanges.flatMap(([from,to])=>Array.from({length:Number(to.slice(3))-Number(from.slice(3))+1},(_,i)=>`2026-${from.slice(0,3)}${String(Number(from.slice(3))+i).padStart(2,'0')}`));
export const initialPrice:PriceSnapshot={id:'deepseek-flash-2026-11-07',verifiedAt:Date.parse('2026-11-07T00:00:00+08:00'),effectiveFrom:Date.parse('2026-11-07T00:00:00+08:00'),source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',currency:'CNY',models:['deepseek-flash','deepseek-flash-1017','DeepSeek-V4.1-Flash-1017','deepseek-v4-flash','deepseek-v4-flash-vision-exp'],peak:{cached:0.04,input:2,output:8},offpeak:{cached:0.02,input:1,output:4},holidays:{'2026':days}};
function count(value:unknown):number|null { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null; }
/** Accept provider usage, never context-window meters. Reasoning is already included in output. */
export function normalizeUsage(raw:Record<string,unknown>|null):TokenUsage|null {
  if(!raw)return null;
  const r=raw as any;
  const input=count(r.input_tokens??r.prompt_tokens??r.inputTokens??r.inputTokenCount??r.promptTokens),output=count(r.output_tokens??r.completion_tokens??r.outputTokens??r.outputTokenCount??r.completionTokens);
  if(input===null||output===null)return null;
  const cached=count(r.input_tokens_details?.cached_tokens??r.prompt_tokens_details?.cached_tokens??r.prompt_cache_hit_tokens??r.cached_input_tokens??r.cachedInputTokens??r.cachedInputTokenCount);
  const missed=count(r.prompt_cache_miss_tokens);
  const actual=cached??(missed!==null?input-missed:null);
  if(actual!==null&&(actual<0||actual>input))return null;
  return {input,output,cached:actual,reasoning:count(r.output_tokens_details?.reasoning_tokens??r.completion_tokens_details?.reasoning_tokens??r.reasoning_output_tokens??r.reasoningTokens??r.reasoningTokenCount)};
}
export function priceBand(time:number,price:PriceSnapshot):'peak'|'offpeak'|'unknown' {
  const date=new Date(time+8*3600000),day=date.toISOString().slice(0,10),weekday=date.getUTCDay(),hour=date.getUTCHours()+date.getUTCMinutes()/60;
  if(weekday===0||weekday===6)return 'offpeak';
  if(!(hour>=9&&hour<12||hour>=14&&hour<18))return 'offpeak';
  const holidays=price.holidays[day.slice(0,4)];if(!holidays)return 'unknown';
  if(holidays.includes(day))return 'offpeak';
  return (hour>=9&&hour<12||hour>=14&&hour<18)?'peak':'offpeak';
}
export function calculateUsage(observation:UsageObservation,taskId:string,price:PriceSnapshot|null):UsageEntry {
  const tokens=normalizeUsage(observation.raw);let band:UsageEntry['band']='unknown',cny:number|null=null,note=observation.note||'';
  if(price&&observation.startedAt>=price.effectiveFrom){
    band=priceBand(observation.startedAt,price);
    // Inspect interval boundaries too: a long call may pass through an entire peak window.
    for(let at=observation.startedAt;at<=observation.endedAt;at=Math.min(observation.endedAt,at+60000)){
      if(priceBand(at,price)!==band){band='mixed';break;}if(at===observation.endedAt)break;
    }
    if(tokens&&tokens.cached!==null&&(band==='peak'||band==='offpeak')){
      const rate=price[band];cny=(tokens.cached*rate.cached+(tokens.input-tokens.cached)*rate.input+tokens.output*rate.output)/1e6;
    }
  }
  if(!tokens)note+=' 用量缺失或不完整。';
  else if(tokens.cached===null)note+=' 缓存命中用量缺失，金额待核算。';
  if(!price)note+=' 无匹配的官方端点 / 模型价格。';
  if(band==='mixed')note+=' 请求跨越费率时段，官方未明确边界归属，金额待核算。';
  if(band==='unknown')note+=' 缺少适用日期的价格或节假日日历。';
  if(observation.basis==='sdk-turn')note+=' SDK 轮次汇总，不能证明每次请求时刻及失败重试的用量。';
  return {...observation,taskId,tokens,price,band,cny,note:note.trim()};
}
export function mergeUsage(values: UsageSummary[], children: string[] = []): UsageSummary {
  const result: UsageSummary = { requests: 0, priced: 0, input: 0, output: 0, cached: 0, knownCny: 0, missing: 0, estimated: true, children };
  for (const value of values) for (const key of ['requests', 'priced', 'input', 'output', 'cached', 'knownCny', 'missing'] as const) result[key] += value[key];
  return result;
}
export class UsageLedger {
  constructor(private db:Database){db.exec('CREATE TABLE IF NOT EXISTS auto_usage(task_id TEXT NOT NULL,source TEXT NOT NULL,event_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(task_id,source,event_id)); CREATE TABLE IF NOT EXISTS auto_prices(id TEXT PRIMARY KEY,json TEXT NOT NULL)');if(!this.prices().length)this.publish(initialPrice);}
  prices():PriceSnapshot[]{return this.db.prepare('SELECT json FROM auto_prices ORDER BY rowid').all().map(r=>JSON.parse(r.json));}
  publish(price:Omit<PriceSnapshot,'id'> & {id?:string}){const value={...price,id:price.id||randomUUID()};this.db.prepare('INSERT INTO auto_prices VALUES(?,?)').run(value.id,JSON.stringify(value));return value;}
  price(endpoint:string,model:string,at:number){let official=false;try{official=new URL(endpoint).hostname==='api.deepseek.com';}catch{}return official?this.prices().filter(p=>p.effectiveFrom<=at&&p.models.some(m=>m.toLowerCase()===model.toLowerCase())).at(-1)||null:null;}
  record(taskId:string,value:UsageObservation,price=this.price(value.endpoint,value.model,value.startedAt)){
    const row=calculateUsage(value,taskId,price);this.db.prepare('INSERT OR IGNORE INTO auto_usage VALUES(?,?,?,?)').run(taskId,value.source,value.id,JSON.stringify(row));return row;
  }
  complete(taskId:string,value:UsageObservation,price:PriceSnapshot|null){
    const row=calculateUsage(value,taskId,price);this.db.prepare('UPDATE auto_usage SET json=? WHERE task_id=? AND source=? AND event_id=?').run(JSON.stringify(row),taskId,value.source,value.id);return row;
  }
  entries(taskId:string):UsageEntry[]{return this.db.prepare('SELECT json FROM auto_usage WHERE task_id=? ORDER BY rowid').all(taskId).map(r=>JSON.parse(r.json));}
  page(taskId:string,children:string[],page:number,pageSize:number,stage?:UsageStage){
    const ids=[...new Set([taskId,...children])],where=`task_id IN (${ids.map(()=>'?').join(',')})${stage?" AND json_extract(json,'$.stage')=?":''}`,args=[...ids,...(stage?[stage]:[])];
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS total FROM auto_usage WHERE ${where}`).get(...args).total);
    const pages=Math.max(1,Math.ceil(total/pageSize)),current=Math.min(page,pages);
    const items=this.db.prepare(`SELECT json FROM auto_usage WHERE ${where} ORDER BY json_extract(json,'$.startedAt') DESC,rowid DESC LIMIT ? OFFSET ?`).all(...args,pageSize,(current-1)*pageSize).map(r=>JSON.parse(r.json) as UsageEntry);
    return {items,total,page:current,pageSize,pages};
  }
  summary(taskId:string,children:string[]=[],stage?:UsageStage):UsageSummary{
    const ids=[...new Set([taskId,...children])];
    const row=this.db.prepare(`SELECT COUNT(*) AS requests,COUNT(json_extract(json,'$.cny')) AS priced,COALESCE(SUM(json_extract(json,'$.tokens.input')),0) AS input,COALESCE(SUM(json_extract(json,'$.tokens.output')),0) AS output,COALESCE(SUM(json_extract(json,'$.tokens.cached')),0) AS cached,COALESCE(SUM(json_extract(json,'$.cny')),0) AS knownCny FROM auto_usage WHERE task_id IN (${ids.map(()=>'?').join(',')})${stage?" AND json_extract(json,'$.stage')=?":''}`).get(...ids,...(stage?[stage]:[]));
    return {requests:Number(row.requests),priced:Number(row.priced),input:Number(row.input),output:Number(row.output),cached:Number(row.cached),knownCny:Number(row.knownCny),missing:Number(row.requests)-Number(row.priced),estimated:true,children};
  }
  /** One ledger scan for an entire list, rather than one scan per task/site/stage. */
  grouped(taskIds?: string[]) {
    const ids = taskIds ? [...new Set(taskIds)] : undefined;
    const result = new Map<string, Map<UsageStage, UsageSummary>>();
    if (ids && !ids.length) return result;
    const rows = this.db.prepare(`SELECT task_id, json_extract(json,'$.stage') AS stage,
      COUNT(*) AS requests, COUNT(json_extract(json,'$.cny')) AS priced,
      COALESCE(SUM(json_extract(json,'$.tokens.input')),0) AS input,
      COALESCE(SUM(json_extract(json,'$.tokens.output')),0) AS output,
      COALESCE(SUM(json_extract(json,'$.tokens.cached')),0) AS cached,
      COALESCE(SUM(json_extract(json,'$.cny')),0) AS knownCny
      FROM auto_usage ${ids ? `WHERE task_id IN (${ids.map(() => '?').join(',')})` : ''}
      GROUP BY task_id, json_extract(json,'$.stage')`).all(...(ids || []));
    for (const row of rows) {
      const stages = result.get(row.task_id) || new Map<UsageStage, UsageSummary>();
      stages.set(row.stage, { requests: Number(row.requests), priced: Number(row.priced), input: Number(row.input), output: Number(row.output), cached: Number(row.cached), knownCny: Number(row.knownCny), missing: Number(row.requests) - Number(row.priced), estimated: true, children: [] });
      result.set(row.task_id, stages);
    }
    return result;
  }
}
