import type { RuleSet } from '../../shared/types.js';
export const executionLeaseMs = 5 * 60 * 1000;
export const modelTimeoutSeconds = 1800;
export function executionPlan(rule: RuleSet, hasReference: boolean, agentSeconds = 600) {
  const pageCount = rule.viewports.length * (hasReference ? 2 : 1);
  return { pageInfoTimeoutSeconds: Math.ceil(rule.capture.timeoutMs / 1000),
    runBudgetMs: (pageCount + 1) * agentSeconds * 1000 + 120000,
    leaseMs: executionLeaseMs, screenshotProvider: 'playwright' as const };
}
