import type { EvaluationStep, Run } from '../../../shared/types.js';

export function stageDuration(run: Run, value: Pick<EvaluationStep, 'startedAt' | 'finishedAt' | 'status'>, capture = false): string {
  // Agent step timestamps mark tool submissions, not the model work leading to them.
  if (!capture && (run.pipeline?.agent || run.snapshot?.executor?.kind === 'tool-agent')) return '';
  if (!['completed', 'failed'].includes(value.status) || value.startedAt == null || value.finishedAt == null) return '';
  const elapsed = value.finishedAt - value.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 1000) return '';
  const seconds = Math.round(elapsed / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
