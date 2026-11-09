export const updateProduct = 'Kooboo AI Automation Lab';
export const defaultUpdateRepository = 'achen-11/Kooboo-AI-Automation-Lab';
export interface UpdateSource { repository: string; token: string }
export interface PublicUpdateSource { repository: string; hasToken: boolean }
export interface UpdateManifest {
  schemaVersion: 1; product: typeof updateProduct; version: string; commit: string;
  publishedAt: string; minLauncher: number; dataVersion: 1; nodeMajor: number;
  collectionLockSha256: string;
  platforms: string[]; architectures: string[];
  archive: { name: string; size: number; sha256: string };
}
export interface UpdateRelease {
  id: number; version: string; notes: string; publishedAt: string; pageUrl: string;
  manifest: UpdateManifest; assetUrl: string; repository: string;
}
export type UpdatePhase = 'idle' | 'downloading' | 'preparing' | 'ready' | 'blocked' | 'backing-up' | 'switching' | 'restarting' | 'rolling-back' | 'completed' | 'failed' | 'cancelled';
export interface UpdateState {
  id: string; phase: UpdatePhase; message: string; version: string;
  updatedAt: number; bytes?: number; total?: number; rolledBack?: boolean;
}
export interface UpdateStatus {
  currentVersion: string; managed: boolean; source: PublicUpdateSource;
  checkedAt?: number; release?: UpdateRelease; available: boolean;
  state: UpdateState | null;
}
export const updateBusy = (phase?: UpdatePhase) => !!phase && ['downloading', 'preparing', 'ready', 'backing-up', 'switching', 'restarting', 'rolling-back'].includes(phase);
export function stableVersion(value: string): string {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) throw new Error('仅支持正式版本号，例如 v0.4.1');
  return match.slice(1).join('.');
}
export function compareVersions(left: string, right: string): number {
  const a = stableVersion(left).split('.').map(Number), b = stableVersion(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
