import { generationStageNames } from './generation-stage.js';
export const timingStageNames = {
  queue: '排队等待', prepare: '资料准备', planning: '交付清单', ...generationStageNames,
  evaluation: '独立评测', evidence: '程序取证', optimization: '优化分析', followup: '异常跟进',
  experience: '经验学习', handoff: '交接评测', delivery: '交付核验',
} as const;
export type TimingStage = keyof typeof timingStageNames;
export interface TimingSummary {
  /** Null when the historical lifecycle was not recorded. Never derive it from updatedAt. */
  elapsedMs: number | null;
  recordedMs: number;
  modelMs: number;
  complete: boolean;
  active: boolean;
  unknownRequests: number;
  stages: { stage: TimingStage; recordedMs: number; modelMs: number; requests: number }[];
}
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '未记录';
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' 分 ' + seconds % 60 + ' 秒';
  return Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分';
}
