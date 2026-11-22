import type { Scenario, Scope } from './automation.js';

export type CheckRuleSeverity = 'critical' | 'major' | 'minor';
export type CheckReviewKind = 'missed-defect' | 'false-positive' | 'calibration';
export type CheckRuleSource = 'builtin' | 'human-review';

export const CHECK_RULE_ID_PATTERN = /^R-[A-Z0-9]+-\d{2,3}$/;

export const checkRuleCategoryPrefixes = {
  'R-VISUAL': '视觉素材',
  'R-LAYOUT': '布局与适配',
  'R-CONTENT': '内容与文案',
  'R-COVER': '完整度与覆盖',
  'R-CUSTOM': '自定义红线',
} as const;

export type CheckRuleCategoryPrefix = keyof typeof checkRuleCategoryPrefixes;

export interface CheckerCheckRule {
  id: string;
  title: string;
  severity: CheckRuleSeverity;
  trigger: string;
  exemptions: string[];
  criterionCap: number | null;
  viewportCap: number | null;
  action: string;
  scenarios: Scenario[];
  scopes: Scope[];
  enabled: boolean;
  source: CheckRuleSource;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceReportId?: string;
  sourceTaskId?: string;
  sourceSiteUrl?: string;
  reviewKind?: CheckReviewKind;
  rationale?: string;
}

export interface CheckerCheckRuleInput {
  id: string;
  title: string;
  severity: CheckRuleSeverity;
  trigger: string;
  exemptions: string[];
  criterionCap: number | null;
  viewportCap: number | null;
  action: string;
  scenarios: Scenario[];
  scopes: Scope[];
  enabled?: boolean;
  source?: CheckRuleSource;
  sourceReportId?: string;
  sourceTaskId?: string;
  sourceSiteUrl?: string;
  reviewKind?: CheckReviewKind;
  rationale?: string;
}

export interface CheckerCheckRevision {
  ruleId: string;
  revision: number;
  actor: 'system' | 'human';
  reason: string;
  snapshot: CheckerCheckRule;
  createdAt: number;
}

export interface CheckerCalibrationSimulatedIssue {
  severity: CheckRuleSeverity;
  title: string;
  detail: string;
  ruleId: string | null;
  viewport: 'desktop' | 'mobile' | 'both';
  criterionId: string | null;
}

export interface CheckerCalibrationExpected {
  quality: 'passed' | 'failed' | 'unverified';
  maxDesktopScore?: number | null;
  maxMobileScore?: number | null;
  minDesktopScore?: number | null;
  minMobileScore?: number | null;
  requireRuleInPrompt: boolean;
  requireCapNote?: boolean;
  expectedExemptionText?: string;
}

export interface CheckerCalibrationCase {
  id: string;
  ruleId: string;
  title: string;
  kind: 'should-catch' | 'should-pass';
  scenario: Scenario;
  scope: Scope;
  source: CheckRuleSource;
  sourceReportId?: string;
  sourceTaskId?: string;
  sourceSiteUrl?: string;
  evidenceFiles: string[];
  notes: string;
  viewport: 'desktop' | 'mobile' | 'both';
  criterionId: string | null;
  simulatedIssue?: CheckerCalibrationSimulatedIssue;
  expected: CheckerCalibrationExpected;
  createdAt: number;
}

export interface CheckerCalibrationInput {
  title: string;
  kind: 'should-catch' | 'should-pass';
  scenario: Scenario;
  scope: Scope;
  sourceReportId?: string;
  sourceTaskId?: string;
  sourceSiteUrl?: string;
  evidenceFiles?: string[];
  notes?: string;
  viewport?: 'desktop' | 'mobile' | 'both';
  criterionId?: string | null;
  simulatedIssue?: CheckerCalibrationSimulatedIssue;
  expected?: Partial<CheckerCalibrationExpected>;
}

export interface CheckerChecksSnapshot {
  hash: string;
  markdown: string;
  rules: CheckerCheckRule[];
  calibrations: CheckerCalibrationCase[];
}

export interface ChecksSnapshotMeta {
  hash: string;
  ruleIds: string[];
  ruleCount: number;
}

export interface ChecksRegressionAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ChecksRegressionCaseResult {
  caseId: string;
  ruleId: string;
  title: string;
  kind: 'should-catch' | 'should-pass';
  passed: boolean;
  assertions: ChecksRegressionAssertion[];
  evidenceStatus: 'verified' | 'missing-on-disk' | 'synthetic';
  observedQuality: 'passed' | 'failed' | 'unverified';
  observedScores: { viewport: string; value: number | null }[];
}

export interface ChecksRegressionReport {
  generatedAt: number;
  checksHash: string;
  total: number;
  passed: number;
  failed: number;
  mode: 'deterministic';
  modeNote: string;
  results: ChecksRegressionCaseResult[];
}
