export type UsageSource = 'kooboo'|'codex';
export type UsageStage = 'generation'|'followup'|'evaluation'|'delivery'|'experience'|'planning';
export interface TokenUsage { input: number; output: number; cached: number|null; reasoning: number|null }
export interface PriceSnapshot { id:string; verifiedAt:number; effectiveFrom:number; source:string; currency:'CNY'; models:string[]; peak:{cached:number;input:number;output:number}; offpeak:{cached:number;input:number;output:number}; holidays:Record<string,string[]> }
export interface UsageObservation { id:string; source:UsageSource; stage:UsageStage; model:string; responseModel?:string; responseId?:string; endpoint:string; startedAt:number; endedAt:number; status:'completed'|'failed'|'unknown'; basis:'request'|'sdk-turn'; raw:Record<string,unknown>|null; note?:string }
export interface UsageEntry extends UsageObservation { taskId:string; tokens:TokenUsage|null; price:PriceSnapshot|null; band:'peak'|'offpeak'|'mixed'|'unknown'; cny:number|null; note:string }
export interface UsageSummary { requests:number; priced:number; input:number; output:number; cached:number; knownCny:number; missing:number; estimated:boolean; children:string[] }
