export const scenarios = {
  materials: '资料建站', migration: '站点迁移', upgrade: '旧站升级', 'site-template': 'AI Site 模板', 'app-template': 'AI App 模板',
} as const;
export type Scenario = keyof typeof scenarios;
export type Scope = 'homepage' | 'site';
export type TaskStatus = 'queued' | 'running' | 'pending' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
export const taskStatusNames: Record<TaskStatus, string> = { queued: '排队中', running: '执行中', pending: '待跟进', cancelling: '正在停止', cancelled: '已取消', completed: '执行结束', failed: '执行失败' };
export interface MaterialFile { id: string; name: string; type: string; size: number; sha256: string; role?: 'target'|'reference'|'content'; viewport?: 'desktop'|'mobile' }
export interface ResourceInput { name: string; scenario: Scenario; description: string; contentUrl: string; referenceUrl: string; externalSource: string; externalId: string; files: MaterialFile[] }
export interface Resource extends ResourceInput { id: string; revision: number; createdAt: number; updatedAt: number }
export interface InputVersion extends ResourceInput { id: string; resourceId: string; revision: number; createdAt: number }
export interface GeneratedSite { id: string; resourceId: string; versionId: string; environmentId: string; siteId: string; name: string; url: string; createdAt: number }
export interface Criterion { id: string; label: string; weight: number; instruction: string; required: boolean; viewports: ('desktop'|'mobile'|'business')[]; scopes: Scope[] }
export interface AutomationRule { id: string; name: string; kind: 'site' | 'app'; scenarios?: Scenario[]; sop: string; references: string; criteria: Criterion[]; createdAt: number; hash: string }
export interface Assessment { criterionId: string; viewport: 'desktop' | 'mobile' | 'business'; score: number | null; reason: string; evidence: string[]; passed: boolean | null }
export interface AutomationReport { summary: string; assessments: Assessment[]; issues: { severity: 'critical' | 'major' | 'minor'; title: string; detail: string; evidence: string[] }[]; coverage: { verified: string[]; unverified: string[]; outOfScope: string[] }; scores: { viewport: string; value: number | null }[]; quality: 'passed' | 'failed' | 'unverified'; artifacts: MaterialFile[] }
export interface AutomationTask { id: string; kind: 'generation' | 'evaluation'; resourceId: string; versionId: string; resourceName: string; scenario: Scenario; scope: Scope; environmentId: string; generatedSiteId: string | null; parentId: string | null; message: string; status: TaskStatus; stopped: boolean; createdAt: number; updatedAt: number; error: string; context: string; threadId: string; rule: AutomationRule | null; report: AutomationReport | null; siteUrl: string; model: { name: string; endpoint: string } | null }
export interface AutomationSettings { enabled: boolean; autoEvaluate: boolean; generationConcurrency: number; evaluationConcurrency: number; timeoutMinutes: number; evaluationModel: string; evaluationEndpoint: string; prompts: Record<Scenario, string> }
export const defaultAutomationSettings: AutomationSettings = {
  enabled: false, autoEvaluate: true, generationConcurrency: 3, evaluationConcurrency: 1, timeoutMinutes: 60,
  evaluationModel: 'deepseek-flash-1017', evaluationEndpoint: '',
  prompts: {
    materials: '根据资料包从空白站点构建完整站点。优先使用 Kooboo 自带的 skill、reference 和 tools。',
    migration: '内容站同时作为视觉参考站。在 Sandbox 克隆内容站作为输入，从空白目标站完成迁移，保留内容与视觉设计。',
    upgrade: '先克隆内容站并导入资料包，在 Sandbox 克隆参考站；以内容站和资料包提供事实内容，以参考站提供设计方向，从空白起点重建升级站点。',
    'site-template': '在 Sandbox 克隆来源站，理解内容、结构与视觉设计，从空白站点构建 AI Site 模板。不得复用来源站图片等资源，图片使用 imagePlaceholder。',
    'app-template': '根据业务需求从空白站点构建 AI App，重视信息层级、交互体验与业务正确性，使用 Kooboo 现有 skill、reference 和 tools。',
  },
};
