export type HarnessCategory =
  | 'overview'
  | 'generation'
  | 'followup'
  | 'evaluation'
  | 'optimization'
  | 'completeness'
  | 'intake'
  | 'experience'
  | 'delivery';

export type HarnessSopKey =
  | 'followup.sop'
  | 'optimization.sop'
  | 'completeness.sop'
  | 'learning.selectionSop'
  | 'learning.reflectionSop'
  | 'delivery.sop';

export interface HarnessDocumentSummary {
  /** Path relative to repo-root `harness/`, e.g. `followup/SKILL.md` */
  path: string;
  title: string;
  category: HarnessCategory;
  categoryLabel: string;
  role: 'overview' | 'skill' | 'reference';
  summary: string;
  runtimeUsage: string;
  editableSettingKey?: HarnessSopKey;
  editableSettingLabel?: string;
}

export interface HarnessDocumentDetail extends HarnessDocumentSummary {
  content: string;
  sha256: string;
  updatedAt: number;
}

export interface HarnessStageMeta {
  id: string;
  title: string;
  actor: string;
  summary: string;
  primaryDoc: string;
  referenceDocs: string[];
  editableKeys: HarnessSopKey[];
}

export interface HarnessSettingBinding {
  key: HarnessSopKey;
  label: string;
  docPath: string;
  customized: boolean;
  migratedLegacy: boolean;
}

export interface HarnessCatalog {
  version: string;
  rootDir: string;
  overviewPath: string;
  stages: HarnessStageMeta[];
  documents: HarnessDocumentDetail[];
  bindings: HarnessSettingBinding[];
}

export const harnessCategoryLabels: Record<HarnessCategory, string> = {
  overview: '全局架构',
  generation: '生成编排',
  followup: '自主跟进',
  evaluation: '独立评测',
  optimization: '持续优化',
  completeness: '完整度清单',
  intake: '资料收集整理',
  experience: '经验闭环',
  delivery: '交付核验',
};

export const harnessSettingLabels: Record<HarnessSopKey, string> = {
  'followup.sop': '跟进 AI 决策规范',
  'optimization.sop': '站点持续优化决策规范',
  'completeness.sop': '应交付清单提取规范',
  'learning.selectionSop': '经验筛选规范',
  'learning.reflectionSop': '经验复盘沉淀规范',
  'delivery.sop': '跨环境交付核验规范',
};
