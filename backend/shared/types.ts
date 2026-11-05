export type Stage = 'queued' | 'collecting' | 'scoring' | 'completed' | 'failed';
export type DimensionId = 'structure' | 'spacing' | 'typography' | 'imagery' | 'details';
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
}
export interface Evidence {
  targetUrl: string;
  targetTitle: string;
  text: string;
  readme: string | null;
  screenshots: Screenshot[];
  health: 'ok' | 'warning' | 'critical';
  issues: Issue[];
  fingerprint: string;
  stable: boolean;
  coverage: { requested: 'homepage' | 'site'; actual: 'homepage'; complete: boolean; note: string };
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
  snapshot: { rule: RuleSet; ruleHash: string; model: { endpoint: string; name: string } } | null;
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
  review: { decision: 'accepted' | 'rework'; note: string; createdAt: number; runId: string } | null;
}
export interface RuntimeSettings {
  threshold: number;
  paused: boolean;
  model: { endpoint: string; name: string; apiKey: string };
  environments: { id: string; name: string; origin: string; apiOrigin: string; token: string }[];
}
export interface PublicSettings extends Omit<RuntimeSettings, 'model' | 'environments'> {
  model: Omit<RuntimeSettings['model'], 'apiKey'> & { hasApiKey: boolean };
  environments: (Omit<RuntimeSettings['environments'][number], 'token'> & { hasToken: boolean })[];
  credentials: { ingestToken: string; readToken: string };
}
