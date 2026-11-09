import type { Scenario } from './automation.js';
import type { TimingStage } from './timing.js';

export interface DashboardTotals {
  knownCny:number; requests:number; missingCosts:number; input:number; cached:number; output:number;
  workflows:number; finished:number; costSamples:number; averageCost:number|null;
  timingSamples:number; averageElapsedMs:number|null; averageQueueMs:number|null;
  modelSamples:number; averageModelMs:number|null;
}
export interface DashboardDay extends DashboardTotals { date:string }
export interface DashboardData {
  days:number; scenario:Scenario|'all'; timezone:'Asia/Shanghai'; generatedAt:number;
  current:DashboardTotals; previous:DashboardTotals; daily:DashboardDay[];
  stages:{stage:TimingStage; knownCny:number; requests:number; missingCosts:number; recordedMs:number; modelMs:number}[];
  unplacedRequests:number;
}
export function changePercent(current:number|null,previous:number|null):number|null {
  return current===null||previous===null||previous===0?null:(current-previous)/previous*100;
}
