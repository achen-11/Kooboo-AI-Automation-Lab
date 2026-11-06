import type { Run } from './types.js';

/** Execution can finish without producing a usable score. Keep that distinction in the API. */
export function scoringStatus(
  run: Pick<Run, 'status' | 'report'>
): 'pending' | 'failed' | 'unscored' | 'partial' | 'scored' {
  if (run.status === 'failed') return 'failed';
  if (run.status !== 'completed') return 'pending';
  if (run.report?.fidelityScore != null) return 'scored';
  return run.report?.completionScore != null ? 'partial' : 'unscored';
}
