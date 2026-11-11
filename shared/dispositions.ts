export type DispositionState = 'active' | 'completed' | 'discarded';
export type DispositionFilter = DispositionState | 'all';
export type DispositionTargetKind = 'resource' | 'delivery';

export interface ItemDisposition {
  state: 'completed' | 'discarded';
  note: string;
  updatedAt: number;
}

export const dispositionStateNames: Record<DispositionState, string> = {
  active: '在列',
  completed: '已完成',
  discarded: '已舍弃',
};

export const dispositionFilterOptions: { value: DispositionFilter; label: string }[] = [
  { value: 'active', label: '在列' },
  { value: 'completed', label: '已完成' },
  { value: 'discarded', label: '已舍弃' },
  { value: 'all', label: '全部归档状态' },
];

export const discardReasonPresets = ['环境过时', '生成效果不佳', '测试验证', '需求变更'] as const;

export function effectiveDisposition(disposition?: ItemDisposition | null): DispositionState {
  return disposition?.state || 'active';
}

export function matchesDispositionFilter(disposition: ItemDisposition | null | undefined, filter?: DispositionFilter | ''): boolean {
  if (!filter || filter === 'all') return true;
  return effectiveDisposition(disposition) === filter;
}
