export type Stage = 'queued' | 'collecting' | 'scoring' | 'completed' | 'failed';
export type DimensionId = string;
export interface Submission {
  schemaVersion: 1;
  attemptId: string;
  requestId: string;
  jobId: string;
  trigger: 'chat_stopped' | 'manual';
  occurredAt: number;
  target: { koobooOrigin: string; siteId: string };
  inputs: { sourceUrl?: string; referenceUrl?: string; materialsPath?: string };
  scope: 'homepage' | 'site';
  ruleSetVersion?: string;
}
export interface Issue {
  severity: 'critical' | 'major' | 'minor';
  dimension: string;
  title: string;
  detail: string;
  evidence: string[];
  capture?: { role: 'target' | 'reference'; viewport: 'desktop' | 'mobile'; stage: string };
}
export interface Screenshot {
  id: string;
  role: 'target' | 'reference';
  viewport: 'desktop' | 'mobile';
  region: string;
  file: string;
  url: string;
  capturedAt: number;
  width: number;
  height: number;
  /** Actual document scroll position for a viewport screenshot. */
  pageY?: number;
  sourceRunId?: string;
  captureMethod?: 'take_screenshot' | 'puppeteer' | 'playwright';
  sha256?: string;
  diagnostic?: boolean;
}
export interface Evidence {
  targetUrl: string;
  targetTitle: string;
  text: string;
  readme: string | null;
  screenshots: Screenshot[];
  health: 'ok' | 'warning' | 'critical' | 'unknown';
  issues: Issue[];
  fingerprint: string;
  stable: boolean;
  coverage: {
    requested: 'homepage' | 'site';
    actual: 'homepage';
    /** Whether the entire requested scope was covered. Homepage capture never completes a site request. */
    complete: boolean;
    /** Whether screenshot collection of the actual scope finished without geometric gaps. */
    captureComplete?: boolean;
    note: string;
  };
}
export interface Report {
  fidelityScore: number | null;
  completionScore: number | null;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  dimensions: { id: DimensionId; score: number; reason: string; evidence: string[] }[];
  issues: Issue[];
  health: Evidence['health'];
  model: { name: string; usage: Record<string, unknown> | null };
  coverage: Evidence['coverage'];
  stable: boolean;
  referenceStatus: 'available' | 'not_provided' | 'unavailable';
  calibrated: false;
  limitations?: string[];
  pairings?: { name: string; target: string[]; reference: string[] }[];
}
export interface RuleDraft {
  id: string;
  rule: RuleSet;
  revision: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface RuleSet {
  version: string;
  executor?: 'agent';
  name: string;
  threshold: number;
  dimensions: { id: DimensionId; label: string; weight: number; instruction: string }[];
  viewports: { id: 'desktop' | 'mobile'; width: number; height: number }[];
  prompt: string;
  capture: { version: string; maxHeight: number; timeoutMs: number; regions: number };
}
export interface Run {
  id: string;
  evaluationId: string;
  status: Stage;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  report: Report | null;
  evidence: Evidence | null;
  pipeline?: Pipeline | null;
  snapshot: {
    rule: RuleSet;
    ruleHash: string;
    model: { endpoint: string; name: string };
    collector?: string;
    sop?: { version: string; hash: string };
    executor?: { provider: 'openai-compatible'; model: string; kind?: 'tool-agent'; version?: string };
    execution?: {
      pageInfoTimeoutSeconds: number;
      runBudgetMs: number;
      leaseMs: number;
      screenshotProvider: 'take_screenshot' | 'playwright';
    };
  } | null;
}
export interface Evaluation {
  id: string;
  projectId: string;
  siteDomain: string | null;
  submission: Submission;
  targetUrl: string | null;
  createdAt: number;
  run: Run;
  needsReview: boolean;
  review: {
    decision: 'accepted' | 'rework';
    note: string;
    createdAt: number;
    runId: string;
  } | null;
}
export interface RuntimeSettings {
  updateSource?: import('./update.js').UpdateSource;
  automation?: import('./automation.js').AutomationSettings;
  threshold: number;
  paused: boolean;
  execution: { timeoutSeconds: number; captureAttempts: number };
  model: { endpoint: string; name: string; apiKey: string };
  environments: { id: string; name: string; origin: string; apiOrigin: string; token: string; defaultRootDomain?: string; delivery?: import('./automation.js').DeliveryPolicy & {token:string} }[];
}
export interface PublicSettings extends Omit<RuntimeSettings, 'model' | 'environments' | 'updateSource'> {
  model: Omit<RuntimeSettings['model'], 'apiKey'> & { hasApiKey: boolean };
  environments: (Omit<RuntimeSettings['environments'][number], 'token'|'delivery'> & { hasToken: boolean; delivery?:import('./automation.js').DeliveryPolicy & {hasToken:boolean} })[];
  credentials: { ingestToken: string; readToken: string };
}

export type StepId = 'prepare' | 'target' | 'reference' | 'check' | 'score' | 'report';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'reused';
export type RetryMode = 'failed' | 'all' | StepId;
export interface EvaluationStep {
  id: StepId;
  status: StepStatus;
  startedAt: number | null;
  finishedAt: number | null;
  message: string;
  error: string | null;
  sourceRunId?: string;
}
export interface CaptureCheckpoint {
  role: 'target' | 'reference';
  viewport: 'desktop' | 'mobile';
  status: StepStatus;
  evidence: Evidence | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  sourceRunId?: string;
}
export interface Pipeline {
  version: 1;
  retryMode: RetryMode;
  sourceRunId?: string;
  steps: EvaluationStep[];
  prepared: { targetUrl: string; readme: string | null; warnings: string[] } | null;
  captures: CaptureCheckpoint[];
  scoredReport: Report | null;
  agent?: AgentState;
}

export interface AgentState {
  captureAttempts?: Record<string, number>;
  version: 1;
  iterations: number;
  calls: { id: string; name: string; startedAt: number; finishedAt: number; status: 'completed' | 'failed'; summary: string }[];
  reviews: Record<string, { usable: boolean; reason: string; evidence: string[] }>;
  artifacts: { id: string; file: string; sourceIds: string[]; sha256: string }[];
  usage: Record<string, number>;
}
