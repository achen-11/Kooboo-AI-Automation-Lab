import type { Scenario, Scope } from './automation.js';
import type { UsageStage, UsageSummary } from './billing.js';
import type { TaskSummary } from './task-presentation.js';

export const siteDeliveryStates = {
  running: '处理中', queued: '排队中', attention: '需要处理',
  ready: '达到交付标准', 'needs-improvement': '未达标', unverified: '有待验证', 'awaiting-evaluation': '待评测',
} as const;
export const usageStageNames: Record<UsageStage, string> = {
  generation: '站点生成', followup: 'AI 跟进', evaluation: '独立评测',
  planning: '交付清单', experience: '经验学习', delivery: '交付核验',
};
export interface SiteDeliverySummary {
  id: string; generatedSiteId: string | null; resourceId: string; resourceName: string;
  siteUrl: string; scenario: Scenario; scope: Scope; detailTaskId: string | null;
  state: keyof typeof siteDeliveryStates; reason: string; targetScore: number;
  report: TaskSummary | null; usage: UsageSummary;
  stages: { stage: UsageStage; usage: UsageSummary }[];
  taskCount: number; createdAt: number; updatedAt: number;
}
export interface SiteDeliveryPage { items: SiteDeliverySummary[]; page: number; pages: number; total: number; pageSize: number }
