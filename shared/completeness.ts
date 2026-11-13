import type { MigrationBaseline } from './migration.js';

export type RequirementKind = 'page' | 'template' | 'data' | 'interaction' | 'implementation' | 'seo' | 'workflow';
/** The unit counted by a data requirement. Legacy requirements default to page records. */
export type RequirementDataIdentity =
  | { kind: 'page' }
  | { kind: 'relations'; parentRequirementIds: string[]; childRequirementIds: string[] }
  | { kind: 'assets' };
export interface CompletenessSettings {enabled:boolean;maxTokens:number;maxMinutes:number;maxRequests:number;sop:string}
export const defaultCompletenessSettings:CompletenessSettings={enabled:true,maxTokens:10000000,maxMinutes:15,maxRequests:120,sop:'从冻结资料与源站建立应交付清单，不按已生成产物缩减范围。核对导航、sitemap、静态页面、动态数据、模板、交互与业务流程。来源范围不明必须明确缺口，不得宣布100%完整。静态页面覆盖PC和移动端；动态内容核对全部记录标识、数量和URL，模板声明边界样本；Content/Commerce/Sqlite存储、动态路由与取值必须有实现证据。迁移/升级核对URL映射和SEO；模板使用替代图片及示例内容，不要求继承原站搜索权重。'};
export interface Requirement {
  id: string; title: string; kind: RequirementKind; required: boolean;
  source: string; expectation: string; paths: string[]; expectedCount: number | null;
  viewports: ('desktop' | 'mobile' | 'business')[];
  expectedKeys?: string[];
  dataIdentity?: RequirementDataIdentity;
  samples?:string[];
  /** Explicit read-only storage identity; never infer a collection from a similar title. */
  records?: { storage:'content'|'sqlite'|'commerce'; container?:string; keyField:string; requiredFields?:string[] };
}
export interface RequirementManifest {
  id: string; taskId: string; revision: number; createdAt: number;
  sourceComplete: boolean; limitations: string[]; items: Requirement[];
  evidence: string[]; actor: 'human' | 'ai';
  sourceEvidence?:{taskId:string;name:string;sha256:string}[];
  migration?: MigrationBaseline;
}
export type RequirementStatus = 'verified' | 'partial' | 'missing' | 'unverified' | 'excluded';
export interface RequirementCheck {
  id: string; status: RequirementStatus; reason: string; evidence: string[];
  checkedViewports: ('desktop' | 'mobile' | 'business')[];
  actualCount: number | null; sampledPaths: string[];
  checkedKeys?:string[];
}
export interface CompletenessReport {
  manifestId: string; manifestRevision: number; sourceComplete: boolean;
  state: 'complete' | 'incomplete' | 'unverified'; checks: RequirementCheck[];
}
export const requirementKindNames: Record<RequirementKind, string> = { page: '页面', template: '动态模板', data: '动态内容', interaction: '导航与交互', implementation: '实现规范', seo: '迁移与 SEO', workflow: '业务流程' };
export const requirementStatusNames: Record<RequirementStatus, string> = { verified: '已验证完成', partial: '部分完成', missing: '缺失或错误', unverified: '未验证', excluded: '按要求排除' };
