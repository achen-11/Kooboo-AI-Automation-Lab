import type { AutomationTask } from './automation.js';

export interface QueueTaskReference {
  id: string;
  resourceName: string;
  kind: AutomationTask['kind'];
  status: AutomationTask['status'];
  updatedAt: number;
  target: 'task' | 'delivery';
  canConfirmStopped: boolean;
}
export type QueueWaitCode = 'paused' | 'worker-unavailable' | 'maintenance' | 'capacity' | 'retry-delay' | 'autonomy-stopped' | 'domain' | 'migration-read' | 'optimization' | 'site-busy' | 'state-changed' | 'ready';
export interface QueueWaitingTask extends QueueTaskReference {
  scope: AutomationTask['scope'];
  reason: { code: QueueWaitCode; message: string; blockers: QueueTaskReference[]; blockingCount: number; nextAt?: number };
}
export interface QueueDiagnostics {
  checkedAt: number;
  enabled: boolean;
  workerReady: boolean;
  maintenance: boolean;
  capacity: Record<AutomationTask['kind'], { executing: number; occupied: number; unconfirmed: number; limit: number }>;
  waiting: { items: QueueWaitingTask[]; total: number; page: number; pages: number; pageSize: number };
  reservations: { items: QueueTaskReference[]; total: number; page: number; pages: number; pageSize: number };
}
