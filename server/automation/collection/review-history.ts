import { readdirSync, statSync } from 'node:fs';
import type { AutomationTask } from '../../../shared/automation.js';
import type { CollectionRun } from '../../../shared/collection.js';
import { safeCollectionPath } from './runtime.js';
import type { CollectionStore } from './store.js';

/** A bounded index of host observations; neither diagnoses nor proposals reset recovery history. */
export function collectionReviewHistory(collections: CollectionStore, run: CollectionRun, task: AutomationTask) {
  const history = task.autonomy?.history;
  const totals: Record<string, { completed: number; failed: number; running: number }> = {};
  for (const operation of run.operations) {
    const total = totals[operation.operation] ||= { completed: 0, failed: 0, running: 0 };
    total[operation.status]++;
  }
  const diagnostics: { metadataPath: string; status: unknown; outcome: unknown; summary: string; at: unknown }[] = [];
  try {
    const root = collections.workspace(run);
    const candidates = readdirSync(safeCollectionPath(root, '.work/diagnostics'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.name))
      .flatMap(entry => {
        const path = `.work/diagnostics/${entry.name}/metadata.json`;
        try { return [{ path, time: statSync(safeCollectionPath(root, path)).mtimeMs }]; } catch { return []; }
      }).sort((a, b) => b.time - a.time).slice(0, 8);
    for (const candidate of candidates) {
      try {
        const bytes = collections.read(run, candidate.path);
        if (bytes.length > 256 * 1024) continue;
        const value = JSON.parse(bytes.toString());
        if (value.binding?.collectionId !== run.id || value.binding?.inputVersionId !== run.inputVersionId) continue;
        diagnostics.push({ metadataPath: candidate.path, status: value.status, outcome: value.outcome, summary: String(value.summary || '').slice(0, 400), at: value.startedAt });
      } catch { /* Broken diagnostics cannot become evidence or prevent review. */ }
    }
  } catch { /* No diagnostic has been saved yet. */ }
  return {
    counters: history ? { noProgress: history.noProgress, strategyReturns: history.strategyReturns } : undefined,
    attempts: history?.failures.slice(-8).map(f => ({ strategy: f.strategy, reason: f.reason.slice(0, 500), progressKey: f.progressKey, at: f.at })),
    operationTotals: totals,
    operations: run.operations.slice(-8).map(op => ({ operation: op.operation, status: op.status, startedAt: op.startedAt, finishedAt: op.finishedAt, error: op.error?.slice(0, 500), evidencePath: op.status === 'completed' ? `.work/platform-operations/${op.id}.json` : undefined })),
    diagnostics,
    note: 'operationTotals 是实际执行次数；attempts 可能包含防循环拦截而未执行的提案。相同输入、方法及失败下不要再次原样重试。先读取诊断 metadataPath 核对资源URL、实际Referer和响应，再决定有依据的新方法或明确外部阻塞；诊断本身不能消除素材缺口，也不能重置历史。',
  };
}
