import type { Scenario, Scope } from './automation.js';
import { generationStageNames } from './generation-stage.js';

export const dashboardStageNames = {
  prepare: '准备与规划', generation: generationStageNames.generation, evidence: '程序取证', evaluation: 'AI 评测',
  repair: generationStageNames.repair, followup: '异常跟进', experience: '经验整理', delivery: '交付核验', other: '其他',
} as const;
export type DashboardStage = keyof typeof dashboardStageNames;
export type AnalyticsUnit = 'workflow' | 'generation' | 'evaluation';
export interface AnalyticsQuery {
  start: number; end: number; granularity: 'hour' | 'day'; scenario: Scenario | 'all'; scope: Scope | 'all';
  unit: AnalyticsUnit; page: number; compareStart?: number; compareEnd?: number;
}
export interface StageConsumption { stage: DashboardStage; knownCny: number; recordedMs: number; requests: number; missingCosts: number }
export interface EfficiencySummary {
  selected: number; completed: number; active: number; queued: number; failed: number; interrupted: number; cancelled: number; pending: number;
  missingStarts: number; costSamples: number; timingSamples: number; averageCost: number | null; averageMs: number | null;
  averageElapsedMs: number | null; elapsedSamples: number; knownCny: number; missingCosts: number;
  quality: { passed: number; failed: number; unverified: number; missing: number };
  stages: { stage: DashboardStage; averageCost: number | null; averageMs: number | null }[];
}
export interface AnalyticsBucket {
  start: number; end: number; stages: StageConsumption[]; queueMs: number; efficiency: EfficiencySummary;
}
export interface AnalyticsRun {
  id: string; taskId: string; rootId: string; name: string; scope: Scope; kind: AnalyticsUnit;
  startedAt: number | null; createdAt: number; endedAt: number | null;
  status: 'completed' | 'active' | 'queued' | 'failed' | 'interrupted' | 'cancelled' | 'pending';
  knownCny: number; missingCosts: number; requests: number; recordedMs: number; durationMs: number | null;
  elapsedMs: number | null; queueMs: number; modelMs: number; timingComplete: boolean; repairs: number;
  quality: 'passed' | 'failed' | 'unverified' | null;
  stages: StageConsumption[];
}
export interface DashboardAnalytics {
  generatedAt: number; timezone: 'Asia/Shanghai'; range: Pick<AnalyticsQuery, 'start' | 'end' | 'granularity'>;
  overview: { resources: number; sites: number; workflows: number; running: number; queued: number };
  consumption: {
    knownCny: number; recordedMs: number; queueMs: number; requests: number; missingCosts: number; unplacedRequests: number; stages: StageConsumption[];
    /** Null when any task active in this period lacks complete lifecycle timing. */
    executionMs: number | null;
    timing: { tasks: number; complete: number; incomplete: number };
  };
  efficiency: EfficiencySummary;
  comparison: { start: number; end: number; efficiency: EfficiencySummary } | null;
  buckets: AnalyticsBucket[];
  points: { id: string; name: string; startedAt: number; durationMs: number | null; knownCny: number; costComplete: boolean }[];
  pointTotal: number;
  runs: { items: AnalyticsRun[]; total: number; page: number; pages: number };
}
