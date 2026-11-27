import type { DeliveryRun, Scenario, Scope } from './automation.js';
import type { UsageBreakdownStage, UsageSummary } from './billing.js';
import type { ItemDisposition } from './dispositions.js';
import { generationStageNames } from './generation-stage.js';
import type { TaskSummary } from './task-presentation.js';

export const deliveryStatusNames: Record<DeliveryRun['status'], string> = {
  queued: '等待交付',
  running: '迁移中',
  uncertain: '迁移结果待核查',
  verifying: '交付核验中',
  completed: '交付核验完成',
  failed: '交付未完成',
};

export interface SiteDeliveryTarget {
  taskId: string;
  status: DeliveryRun['status'];
  targetUrl?: string;
}

export const siteDeliveryStates = {
  running: '处理中', queued: '排队中', attention: '需要处理',
  ready: '达到交付标准', generated: '生成完成', 'needs-improvement': '未达标', unverified: '有待验证', 'awaiting-evaluation': '待评测',
} as const;
export const siteDeliveryAddressFilters = {
  missing: '尚无可访问地址',
  accessible: '已有可访问地址',
} as const;
export type SiteDeliveryAddressFilter = keyof typeof siteDeliveryAddressFilters;
export const siteDeliveryDeliveryFilters = {
  undelivered: '尚未跨环境交付',
  deliverable: '当前可一键交付',
} as const;
export type SiteDeliveryDeliveryFilter = keyof typeof siteDeliveryDeliveryFilters;
export type SiteDeliveryActionCode =
  | 'ready'
  | 'already-delivered'
  | 'unsupported-env'
  | 'missing-token'
  | 'archived'
  | 'in-progress'
  | 'not-ready'
  | 'require-passed'
  | 'missing-site-url'
  | 'domain-reserved';
export interface SiteDeliveryAction {
  eligible: boolean;
  taskId?: string;
  forceEligible?: boolean;
  forceTaskId?: string;
  code: SiteDeliveryActionCode;
  reason?: string;
}
export type SiteDeliveryRecoveryAction = 'resume' | 'adjust-site-names' | 'confirm-stopped' | 'handoff-conversation';
export interface SiteDeliveryRecovery {
  action: SiteDeliveryRecoveryAction;
  taskId: string;
}
export function accessibleSiteUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function hasAccessibleSiteUrl(value: string): boolean {
  return Boolean(accessibleSiteUrl(value));
}
export function deliveredSiteUrl(delivery?: Pick<SiteDeliveryTarget, 'status' | 'targetUrl'> | null): string | undefined {
  return delivery?.status === 'completed' && delivery.targetUrl ? accessibleSiteUrl(delivery.targetUrl) : undefined;
}
export function deliveryTargetUrl(delivery?: Pick<SiteDeliveryTarget, 'status' | 'targetUrl'> | null): string | undefined {
  return delivery?.targetUrl ? accessibleSiteUrl(delivery.targetUrl) : undefined;
}
export function primarySiteUrl(siteUrl: string, delivery?: Pick<SiteDeliveryTarget, 'status' | 'targetUrl'> | null): { url: string; delivered: boolean } | null {
  const delivered = deliveredSiteUrl(delivery);
  if (delivered) return { url: delivered, delivered: true };
  const source = accessibleSiteUrl(siteUrl);
  return source ? { url: source, delivered: false } : null;
}
export interface ListSiteLinks {
  primary: { url: string; delivered: boolean; deliveryPending: boolean; badge?: string; title: string } | null;
  source?: string;
}
export function listSiteLinks(siteUrl: string, delivery?: Pick<SiteDeliveryTarget, 'status' | 'targetUrl'> | null): ListSiteLinks {
  const target = deliveryTargetUrl(delivery);
  const source = accessibleSiteUrl(siteUrl);
  if (target) {
    const delivered = delivery?.status === 'completed';
    const badge = delivered
      ? '已交付'
      : delivery?.status === 'verifying'
        ? '核验中'
        : delivery?.status === 'failed' || delivery?.status === 'uncertain'
          ? '待核验'
          : '交付站';
    const title = delivered
      ? `交付站（主链接）：${target}`
      : `交付站（${delivery ? deliveryStatusNames[delivery.status] : '未核验'}）：${target}`;
    return {
      primary: { url: target, delivered, deliveryPending: !delivered, badge, title },
      ...(source && source !== target ? { source } : {}),
    };
  }
  return source ? { primary: { url: source, delivered: false, deliveryPending: false, title: source } } : { primary: null };
}
export const usageStageNames: Record<UsageBreakdownStage, string> = {
  ...generationStageNames, followup: 'AI 跟进', evaluation: '独立评测',
  planning: '交付清单', experience: '经验学习', delivery: '交付核验',
};
export interface SiteDeliverySummary {
  id: string; generatedSiteId: string | null; resourceId: string; resourceName: string;
  siteUrl: string; environmentId: string; environmentName?: string; scenario: Scenario; scope: Scope; detailTaskId: string | null;
  state: keyof typeof siteDeliveryStates; reason: string; targetScore: number;
  recovery?: SiteDeliveryRecovery;
  deliveryAction?: SiteDeliveryAction;
  delivery?: SiteDeliveryTarget;
  report: TaskSummary | null; usage: UsageSummary;
  stages: { stage: UsageBreakdownStage; usage: UsageSummary }[];
  disposition?: ItemDisposition;
  resourceDisposition?: ItemDisposition;
  taskCount: number; createdAt: number; updatedAt: number;
}
export interface SiteDeliveryPage { items: SiteDeliverySummary[]; page: number; pages: number; total: number; pageSize: number; activeTotal?: number; attentionMissingAddress?: number; deliverableCount?: number; undeliveredCount?: number }
