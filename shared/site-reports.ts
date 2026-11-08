import type { AutomationReport, Scope, TaskStatus } from './automation.js';

export interface SiteEvaluationRecord {
  id: string; scope: Scope; status: TaskStatus; stopped: boolean; createdAt: number;
  optimizationRound?: number;
  report: Pick<AutomationReport, 'quality' | 'scores'> | null;
  reportCurrent: boolean;
}

export interface SiteReportPage {
  items: SiteEvaluationRecord[]; total: number; page: number; pages: number; pageSize: number;
  currentReportId: string | null; scope: Scope; targetScore: number;
}
