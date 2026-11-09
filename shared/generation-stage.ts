export const generationStageNames = { generation: '首次生成', repair: '修复生成' } as const;

/** Classify at read time so historical repair requests retain their original ledger records. */
export function generationStage<T extends string>(stage: T, round = 0): T | 'repair' {
  return stage === 'optimization' || stage === 'generation' && round > 0 ? 'repair' : stage;
}
