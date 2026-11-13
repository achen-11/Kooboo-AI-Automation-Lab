/** New AI Site template tasks only. Frontend and backend share this protocol. */
export type TemplateViewport = 'desktop' | 'mobile';
export type TemplateCheckStatus = 'passed' | 'failed' | 'unverified' | 'not-applicable';
export type TemplateCheckKind = 'presence' | 'order' | 'gutter' | 'relation' | 'line-count' | 'spacing' | 'visual' | 'interaction';
export interface TemplateCheckDefinition {
  id: string; title: string; enabled: boolean; kind: TemplateCheckKind;
  executor: 'script' | 'ai' | 'hybrid'; instruction: string;
  scopes: ('homepage' | 'site')[]; viewports: TemplateViewport[];
  required: boolean; severity: 'critical' | 'major' | 'minor'; weight: number;
  tolerancePx: number; exceptions: string;
}
export interface TemplateChecklistInput { name: string; checks: TemplateCheckDefinition[] }
export interface TemplateChecklist extends TemplateChecklistInput { id: string; revision: number; hash: string; createdAt: number }
export interface TemplateWorkflowBinding { version: 1; rootTaskId: string; checklistId: string }
export interface TemplateRect { x: number; y: number; width: number; height: number }
export interface TemplateLayoutElement {
  selector: string; tag: string; text: string; rect: TemplateRect; visible: boolean;
  lines: number | null; display: string; position: string; overflowX: string;
  paddingLeft: number; paddingRight: number; parentSelector: string | null;
  signature: string;
}
export interface TemplateLayoutSnapshot {
  url: string; viewport: TemplateViewport; width: number; height: number;
  elements: TemplateLayoutElement[]; links: string[]; truncated: boolean;
  /** Global script/style/image/font dependency hash; per-element signatures bind markup, geometry and ancestor styles. */
  dependencyHash: string | null; dependencyGaps: string[];
}
export interface TemplateConstraint {
  id: string; checkId: string; expected: string;
  /** Selectors are source anchors, not assumed to exist in the generated DOM. */
  anchors: string[]; relation?: 'left-of' | 'above' | 'aligned-left' | 'aligned-top';
  preserveLines?: boolean;
}
export interface TemplateViewLayout {
  viewport: TemplateViewport; selector: string; evidence: string[];
  intent: string; exceptions: string; constraints: TemplateConstraint[];
}
export interface TemplateView { id: string; title: string; role: string; required: boolean; layouts: TemplateViewLayout[] }
export interface TemplateBaselinePage { path: string; title: string; views: TemplateView[] }
export interface TemplateEvidence {
  name: string; ownerTaskId: string; role: 'reference' | 'content' | 'target';
  viewport?: TemplateViewport; url: string; type: string; sha256: string;
  size: number; siteRevision: string | null; href: string; settled?:boolean;
}
export interface TemplateBaseline {
  id: string; revision: number; createdAt: number; inputVersionId: string;
  referenceUrl: string; contentUrl: string | null; scope: 'homepage' | 'site';
  pages: TemplateBaselinePage[]; contentMapping: string; limitations: string[];
  complete: boolean; evidence: TemplateEvidence[]; checklistId: string;
  experienceGuidance?: {id:string;revision:number;guidance:string;reason:string}[];
}
export interface TemplateCheckResult {
  id: string; checkId: string; pagePath: string; viewId: string; viewport: TemplateViewport;
  status: TemplateCheckStatus; expected: string; actual: string; reason: string;
  score: number | null; evidence: string[]; measurements?: Record<string, number | string | boolean | null>;
  provenance: 'measured' | 'inherited' | 'unverified'; sourceTaskId: string;
  sourceRevision: string; inheritanceReason?: string;
}
export interface TemplateIssue {
  id: string; checkResultId: string; pagePath: string; viewId: string; viewport: TemplateViewport;
  title: string; severity: 'critical' | 'major' | 'minor'; expected: string; actual: string;
  acceptance: string; evidence: string[]; status: 'open' | 'done' | 'unverified';
}
export interface TemplateCaptureScope {
  pagePath: string; viewport: TemplateViewport; mode: 'page' | 'regions' | 'inherited';
  selectors: string[]; reason: string; evidence: string[]; complete: boolean;
  sourceTaskId?: string; sourceRevision?: string;
}
export interface TemplateEvaluation {
  taskId: string; siteRevision: string; baselineId: string; checklistId: string;
  createdAt: number; complete: boolean; quality: 'passed' | 'failed' | 'unverified';
  scores?: {viewport:TemplateViewport;value:number|null}[];
  checks: TemplateCheckResult[]; issues: TemplateIssue[]; captures: TemplateCaptureScope[];
  evidence: TemplateEvidence[];
}
export interface TemplateWorkflowResponse {
  supported: boolean; taskId: string; rootTaskId: string | null; version: 1 | null;
  phase: 'analysis' | 'generation' | 'evaluation' | 'repair' | 'completed' | 'interrupted' | null;
  checklist: TemplateChecklist | null; baseline: TemplateBaseline | null;
  evaluation: TemplateEvaluation | null; limitations: string[];
}
