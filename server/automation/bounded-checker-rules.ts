import type { Assessment, Criterion, Scenario, Scope } from '../../shared/automation.js';
import type { EvaluationHumanSummary, EvaluationVerdict } from '../../shared/human-diagnostics.js';

export const BOUNDED_CHECKER_RULES_VERSION = 'bounded-v1';

export type BuiltinAntiPatternRuleId = 'R-VISUAL-01' | 'R-VISUAL-02' | 'R-LAYOUT-03' | 'R-COVER-04';
export type AntiPatternRuleId = BuiltinAntiPatternRuleId | (string & {});

export interface AntiPatternRule {
  id: AntiPatternRuleId;
  title: string;
  severity: 'critical' | 'major' | 'minor';
  trigger: string;
  exemptions: readonly string[];
  criterionCap: number | null;
  viewportCap: number | null;
  action: string;
}

export const DEFAULT_ANTI_PATTERN_RULES: readonly AntiPatternRule[] = [
  {
    id: 'R-VISUAL-01',
    title: '非豁免场景下禁止用大块 SVG 充当主视觉或展示卡片',
    severity: 'major',
    trigger:
      'Hero 主视觉或精选作品/产品/服务展示卡片中缺少真实高质量图片（或 Kooboo 推荐的 imagePlaceholder 真实配图 <img>），而用大面积纯几何线条/渐变/光锥等 <svg> 或纯 CSS 图形充当视觉主体。',
    exemptions: [
      '工具型 SaaS 界面示意',
      '技术架构图 / 流程图',
      '数据可视化图表',
      '品牌 Logo 与小尺寸 UI 功能图标',
    ],
    criterionCap: 70,
    viewportCap: 75,
    action: '判定 Major；对应维度封顶 ≤ 70、对应视口封顶 ≤ 75，强制 quality=failed 且 verdict 不得为 ready。',
  },
  {
    id: 'R-VISUAL-02',
    title: '配图语义、语种与品牌语境一致',
    severity: 'minor',
    trigger:
      '页面配图出现与站点语种/品牌违和的外语价签/招牌文字、无关第三方设备或竞品 Logo 抢镜，或配图与所属业务卡片语义明显不符。',
    exemptions: ['明确作为展示对象的真实商品原包装/跨国品牌原物'],
    criterionCap: 72,
    viewportCap: 78,
    action: '局部卡片配图记 Minor 并要求替换；若出现在 Hero 或核心卖点主图则升格为 Major（对应维度 ≤ 72、视口 ≤ 78）。',
  },
  {
    id: 'R-LAYOUT-03',
    title: '移动端首屏对齐与防截断硬线',
    severity: 'major',
    trigger:
      '出现横向溢出（scrollWidth > clientWidth）、固定 Header 遮挡 H1/首屏内容、移动端主体/CTA 严重错位、页脚/卡片内容被截断，或移动端导航菜单展开后缺少可见可点击的关闭入口／遮罩拦截关闭按钮。',
    exemptions: [],
    criterionCap: 72,
    viewportCap: 75,
    action: '判定 Major；对应维度封顶 ≤ 72、对应视口封顶 ≤ 75，禁止被基础结构通过项稀释为高分。',
  },
  {
    id: 'R-COVER-04',
    title: '必检项未验证比例过高禁出满分或高分放行',
    severity: 'major',
    trigger:
      '必检项目或关键页面范围存在缺失证据导致未验证，禁止仅因局部已验项全部通过而给出 90–100 分或直接 passed。',
    exemptions: [],
    criterionCap: null,
    viewportCap: 78,
    action: '分离质量得分与覆盖率；存在未验必检项时保留 unverified 或降档拦截，不得宣称完整通过。',
  },
] as const;

export interface OutOfScopeContext {
  scenario: Scenario;
  scope: Scope;
  hasReference: boolean;
  hasMaterials: boolean;
  hasBackendAccess?: boolean;
}

export function defaultOutOfScope(ctx: OutOfScopeContext): string[] {
  const items: string[] = [
    '正式域名上线、DNS 解析、搜索引擎收录与线上排名权重；当前为预览环境',
    '完整键盘焦点顺序、读屏无障碍专项审计与减少动态效果偏好验证（非本轮必检项）',
  ];
  if (ctx.scope === 'homepage') {
    items.push('其他静态内页、多页路由与全站信息架构；当前任务范围为仅首页');
    items.push(
      '仅基于静态逐屏截图无法直接观测的细粒度动态交互态（如悬停 hover 样式、折叠手风琴/标签页点击切换与展开动效、以及跳转到内页或外部地址的实际路由目标；移动端导航菜单开关由宿主程序探针独立核验）',
    );
  }
  if (!ctx.hasReference) {
    items.push('参考站逐像素视觉对比；本次未提供参考站或模板视觉参考');
  }
  if (!ctx.hasMaterials) {
    items.push('原始素材版权授权与原始上传文件逐项映射核对；本次未提供原始素材清单');
  }
  if (!ctx.hasBackendAccess) {
    items.push('后台 CMS/Commerce/Sqlite 动态数据模型与站点源码内部实现审计（本次仅基于前台公开渲染页面验收）');
    if (ctx.scope === 'homepage') {
      items.push('静态展示表单的真实后端提交、服务端校验与业务写入回调（当前为静态预览页面）');
    }
  }
  return items;
}

const REAL_CAPTURE_GAP_GUARD =
  /截图缺失|缺少[^，。；]*截图|未采集|未能打开|页面[^，。；]*失败|加载失败|必需区块|关键交互[^，。；]*失败|页脚[^，。；]*裁切|首屏[^，。；]*缺失/i;

const BOILERPLATE_OUT_OF_SCOPE_PATTERNS: readonly RegExp[] = [
  /正式域名|线上上线|DNS\s*解析|搜索引擎收录|未来.*权重|搜索权重/i,
  /键盘[^，。；]*焦点(?:顺序|完整性)?|读屏无障碍|无障碍专项|减少动态效果偏好|hover[／/]focus\s*细节/i,
  /素材授权|版权来源|版权归属/i,
];

function matchesPresetScopeBoilerplate(line: string, presetOutOfScope: string[]): boolean {
  const joinedPreset = presetOutOfScope.join('\n');
  if (
    joinedPreset.includes('原始素材版权') &&
    /(?:资料包清单为空|未提供.*原始素材|缺少原始图片).*(?:无法核对|素材来源|映射)/i.test(line)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('参考站') &&
    /(?:未提供参考站|缺少参考站).*(?:对比|映射)/i.test(line)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('其他静态内页') &&
    /(?:仅首页|其他内页|其他页面).*(?:范围外|未扩展|不属于本次)/i.test(line)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('后台 CMS/Commerce/Sqlite') &&
    /(?:缺少后台|仅有前台|无法从公开页面确认).*(?:CMS|Commerce|Sqlite|内容模型|动态数据|后台实现)/i.test(line)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('静态展示表单') &&
    /(?:静态展示|静态演示|纯展示).*(?:表单|提交|校验)|(?:表单|预约).*(?:提交|校验).*(?:静态展示|静态演示)/i.test(line)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('细粒度动态交互态') &&
    (/(?:手风琴|折叠项|折叠步骤|常见问题|FAQ|合作流程|标签页|轮播|滚动动效|悬停(?:状态|样式|反馈)?).*(?:展开|收起|切换|动效|闭合态|静态截图|默认选中|默认展开|仅(?:提供|有).*?(?:截图|画面)|未提供.*截图|未呈现|交互反馈)/i.test(
      line,
    ) ||
      /(?:导航|页脚|卡片|按钮|CTA|隐私|条款|链接|外链).*(?:点击|跳转|目标页|实际目标|链接目标).*(?:未提供|无法(?:核验|确认|验证)|静态截图)/i.test(
        line,
      ) ||
      /静态截图.*(?:无法(?:核验|确认|验证)|未提供).*(?:链接|跳转|点击|手风琴|折叠|悬停|交互)/i.test(line))
  ) {
    return true;
  }
  return false;
}

export function classifyUnverifiedLeaks(
  unverified: string[],
  presetOutOfScope: string[],
): { keptUnverified: string[]; movedToOutOfScope: string[] } {
  const keptUnverified: string[] = [];
  const movedToOutOfScope: string[] = [];
  const presetSet = new Set(presetOutOfScope.map(item => item.trim()).filter(Boolean));

  for (const raw of unverified) {
    const line = raw.trim();
    if (!line) continue;
    if (REAL_CAPTURE_GAP_GUARD.test(line)) {
      keptUnverified.push(line);
      continue;
    }
    const isBoilerplate =
      presetSet.has(line) ||
      BOILERPLATE_OUT_OF_SCOPE_PATTERNS.some(pattern => pattern.test(line)) ||
      matchesPresetScopeBoilerplate(line, presetOutOfScope);
    if (isBoilerplate) {
      movedToOutOfScope.push(line);
    } else {
      keptUnverified.push(line);
    }
  }

  return { keptUnverified, movedToOutOfScope };
}

export interface BoundedCheckerPromptInput {
  scenario: Scenario;
  scope: Scope;
  siteUrl?: string;
  description: string;
  criteria: Criterion[];
  presetOutOfScope: string[];
  precheckDigest?: string;
  imageManifestLines: string[];
  hasReference: boolean;
  viewports?: ('desktop' | 'mobile')[];
  siblingViewports?: ('desktop' | 'mobile')[];
  pageScopeNote?: string;
  materialNotes?: string;
  extraGuidance?: string;
  antiPatternRules?: readonly AntiPatternRule[];
}

export function buildBoundedCheckerPrompt(input: BoundedCheckerPromptInput): string {
  const allowedViewports = input.viewports?.length ? new Set(input.viewports) : null;
  const criteriaLines = input.criteria
    .filter(c => c.scopes.includes(input.scope))
    .map(c => {
      const vps = allowedViewports
        ? c.viewports.filter((v): v is 'desktop' | 'mobile' => v !== 'business' && allowedViewports.has(v))
        : c.viewports;
      if (!vps.length) return '';
      return `- ${c.id}（${c.label}，权重 ${c.weight}%，${c.required ? '必过项' : '常规项'}，视口 [${vps.join(', ')}]）：${c.instruction}`;
    })
    .filter(Boolean)
    .join('\n');

  const activeRules = input.antiPatternRules ?? DEFAULT_ANTI_PATTERN_RULES;
  const ruleLines = activeRules.length
    ? activeRules
        .map(
          r =>
            `- ${r.id} [${r.severity.toUpperCase()}] ${r.title}：${r.trigger}${
              r.exemptions.length ? `（豁免：${r.exemptions.join('、')}）` : ''
            } → ${r.action}`,
        )
        .join('\n')
    : '- （当前任务范围未启用额外红线规则，仍执行通用 Major/Critical 与默认评分边界）';

  const outOfScopeLines = input.presetOutOfScope.map(item => `- ${item}`).join('\n');
  const hasAttachedReference =
    input.hasReference && input.imageManifestLines.some(line => line.includes('role=reference'));
  const manifestBlock = (() => {
    if (!input.imageManifestLines.length) return '- （无附加截图）';
    if (!hasAttachedReference) {
      return input.imageManifestLines.map(item => `- ${item}`).join('\n');
    }
    const targetLines = input.imageManifestLines.filter(line => line.includes('role=target'));
    const refLines = input.imageManifestLines.filter(line => line.includes('role=reference'));
    const otherLines = input.imageManifestLines.filter(
      line => !line.includes('role=target') && !line.includes('role=reference'),
    );
    const groups: string[] = [];
    if (targetLines.length) {
      groups.push('目标站（target）截图：', ...targetLines.map(item => `- ${item}`));
    }
    if (refLines.length) {
      groups.push('参考/源站（reference）截图：', ...refLines.map(item => `- ${item}`));
    }
    if (otherLines.length) {
      groups.push('其他证据文件：', ...otherLines.map(item => `- ${item}`));
    }
    return groups.join('\n');
  })();
  const referenceEvidenceRule = hasAttachedReference
    ? `\n重要（参考站证据硬性要求）：本批同时附带了目标站（role=target）与参考站（role=reference）截图；每一条已评分（score !== null）的 assessments[].evidence 都必须同时引用至少 1 张同视口 target 文件名和至少 1 张同视口 reference 文件名（严禁只填 target），否则将被平台校验拒绝。`
    : '';

  const sections = [
    `你是独立、严苛、只看真实证据的网页质量验收 Checker（规则版本 ${BOUNDED_CHECKER_RULES_VERSION}）。`,
    `【核心立场（Default = No）】`,
    `- 你不是创作者的公关，禁止为粗糙占位图、廉价几何装饰、排版瑕疵写“融为一体”“克制高级”之类的美化评语。`,
    `- 任何证据缺失、视觉敷衍、核心缺陷都默认按不通过处理，先找问题、再定分档。`,
    ``,
    `【硬性执行约束（禁止自由探索 & 强制中文）】`,
    `- 你处于只读多模态单步评审模式：严禁运行任何 shell 命令、严禁探测目录、严禁读取源码或发起网络请求。`,
    `- 仅依据下方任务需求、程序预检事实（precheck-facts）以及随本消息直接传入的真实截图（local_image）进行视觉与语义核验，并在本轮直接返回符合 outputSchema 的严格 JSON。`,
    `- 所有文本字段（summary、assessments[].reason、issues[].title、issues[].detail、coverage.verified/unverified/outOfScope、humanSummary 全部字段）必须严格使用简体中文输出，严禁使用英文评语或中英重复翻译条目。`,
    `- 请控制内部思考简洁高效，禁止逐张复述全部截图像素细节或做冗长铺陈；直接提炼关键视觉/排版/业务缺陷与对应证据文件名，尽快输出紧凑且合法的 JSON，避免因思考过长耗尽输出额度。`,
    ``,
    `【任务背景】`,
    `- 场景：${input.scenario} | 范围：${input.scope} | 本批视口：${input.viewports?.length ? input.viewports.join(' + ') : 'desktop + mobile'} | 目标站：${input.siteUrl || '离线历史证据'} | 视觉参考站：${input.hasReference ? '有（见附带 reference 截图）' : '无'}`,
    ...(input.pageScopeNote?.trim() ? [`- 本批核验范围：${input.pageScopeNote.trim()}`] : []),
    `- 业务/建站需求摘要：\n${input.description.trim() || '（无额外描述）'}`,
  ];

  if (input.materialNotes?.trim()) {
    sections.push('', '【冻结文字资料与附件清单】', input.materialNotes.trim());
  }
  if (input.extraGuidance?.trim()) {
    sections.push('', '【额外专项检查要求】', input.extraGuidance.trim());
  }

  const siblingNote = input.siblingViewports?.length
    ? (() => {
        const siblingNames = input.siblingViewports
          .map(v => (v === 'desktop' ? '桌面端（desktop）' : '移动端（mobile）'))
          .join('、');
        return `注意：本批仅为并行多批次中的部分视口（另一视口 ${siblingNames} 由并行批次独立核验），严禁把“${siblingNames}视口未提供证据 / 本轮仅提供当前视口证据”写入 coverage.outOfScope 或 coverage.unverified。`;
      })()
    : '';

  sections.push(
    ``,
    `【评分分档锚点（必须严格对应，严禁普遍打 90–95）】`,
    `- 90–100：商业可交付级。零 Critical 与 Major；主视觉与展示卡片采用真实高质量图片或合规 imagePlaceholder 实景/商品图（无廉价 SVG 充数）；双端排版、字号、换行、对比度细腻。`,
    `- 75–84：结构可用但明显平庸或粗糙。无阻断性硬伤，但存在多处 Minor 视觉/排版瑕疵、图文语义略偏或视觉层次一般。`,
    `- 60–74：存在明确 Major 缺陷（如非豁免场景下用几何 SVG 替代主视觉、移动端错位/溢出、图文严重违和、模板残留），不可交付。`,
    `- < 60：存在 Critical 阻断故障（白屏、核心区块缺失、严重遮挡不可读等）。`,
    ``,
    `【反模式红线清单（命中即必须在 issues 报告，并如实注明 ruleId）】`,
    ruleLines,
    `特别说明：即使任务未提供素材图（无图模式），Kooboo 也应通过 imagePlaceholder 填充真实配图（<img>），不得在非豁免的展示性行业页面里用简单几何 SVG 撑 Hero 或项目卡片。`,
    ``,
    `【本轮适用评分指标】`,
    criteriaLines || '- （无适用指标）',
    ``,
    `【程序预检事实（0 模型成本确定性信号，必须逐条结合截图核实）】`,
    input.precheckDigest?.trim() || '- （本次未附带 DOM 预检摘要）',
    ``,
    `【宿主已冻结的范围外事项（coverage.outOfScope）】`,
    outOfScopeLines,
    `重要：上述范围外事项宿主会在合并阶段自动写入最终 coverage.outOfScope，严禁把它们写进 coverage.unverified！你在输出 JSON 的 coverage.outOfScope 中只需填写**额外新增**的范围外事项（无新增可返回 []），不要抄写或改写上述已有条目。只有本轮范围内必需核验但附带截图/事实确实缺失的内容，才允许写入 coverage.unverified。`,
    ...(siblingNote ? [siblingNote] : []),
    ``,
    `【本轮附带的真实截图清单（issues / assessments 的 evidence 只能填写下方存在的裸文件名）】${referenceEvidenceRule}`,
    manifestBlock,
  );

  return sections.join('\n');
}

export interface BoundedIssue {
  severity: 'critical' | 'major' | 'minor';
  title: string;
  detail: string;
  evidence: string[];
  ruleId?: AntiPatternRuleId | string | null;
  viewport?: 'desktop' | 'mobile' | 'both' | null;
  criterionId?: string | null;
}

export interface BoundedPrecheckSignalRef {
  code: string;
  ruleId?: AntiPatternRuleId;
  severityHint: 'critical' | 'major' | 'minor';
  viewport: 'desktop' | 'mobile';
  summary: string;
}

export interface BoundedVerdictInput {
  assessments: Assessment[];
  issues: BoundedIssue[];
  criteria: Criterion[];
  threshold: number;
  coverage: { verified: string[]; unverified: string[]; outOfScope: string[] };
  presetOutOfScope?: string[];
  humanSummary?: EvaluationHumanSummary;
  precheckSignals?: BoundedPrecheckSignalRef[];
  antiPatternRules?: readonly AntiPatternRule[];
}

export interface BoundedVerdictResult {
  assessments: Assessment[];
  scores: { viewport: string; value: number | null }[];
  rawScores: { viewport: string; value: number | null }[];
  quality: 'passed' | 'failed' | 'unverified';
  coverage: { verified: string[]; unverified: string[]; outOfScope: string[] };
  issues: BoundedIssue[];
  humanSummary?: EvaluationHumanSummary;
  capNotes: string[];
}

function computeViewportScores(
  assessments: Assessment[],
  criteria: Criterion[],
): { viewport: string; value: number | null }[] {
  const viewports = [...new Set(assessments.map(a => a.viewport))];
  return viewports.map(viewport => {
    const rows = assessments.filter(a => a.viewport === viewport);
    const weight = rows.reduce((sum, a) => sum + (criteria.find(c => c.id === a.criterionId)?.weight || 0), 0);
    const hasNull = rows.some(a => a.score === null);
    const value =
      hasNull || !weight
        ? null
        : Math.round(
            (rows.reduce((sum, a) => sum + a.score! * (criteria.find(c => c.id === a.criterionId)?.weight || 0), 0) /
              weight) *
              10,
          ) / 10;
    return { viewport, value };
  });
}

function isVisualSvgPlaceholderIssue(issue: BoundedIssue): boolean {
  if (issue.ruleId === 'R-VISUAL-01') return true;
  const text = `${issue.title} ${issue.detail}`;
  return /R-VISUAL-01|HERO_SVG_PLACEHOLDER|CARD_SVG_PLACEHOLDER|廉价.*svg|几何\s*svg|svg\s*占位|svg\s*充数/i.test(
    text,
  );
}

function affectedVisualViewports(
  issue: BoundedIssue,
  availableViewports: string[],
): ('desktop' | 'mobile')[] {
  const visual = availableViewports.filter(
    (vp): vp is 'desktop' | 'mobile' => vp === 'desktop' || vp === 'mobile',
  );
  if (issue.viewport === 'desktop' || issue.viewport === 'mobile') {
    return visual.includes(issue.viewport) ? [issue.viewport] : [];
  }
  return visual;
}

export function normalizeScopeKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，。；、：:（）()[\]【】"'`·/\\-]+/g, '');
}

const ENGLISH_OUT_OF_SCOPE_DUPLICATE =
  /^(?:Production domain launch|Full keyboard focus order|Other static inner pages|Source-asset copyright|Backend CMS, Commerce)/i;

function isPresetOutOfScopeDuplicate(
  line: string,
  presetOutOfScope: string[],
  presetNorms: Set<string>,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (presetNorms.has(normalizeScopeKey(trimmed))) return true;
  if (ENGLISH_OUT_OF_SCOPE_DUPLICATE.test(trimmed)) return true;

  const joinedPreset = presetOutOfScope.join('\n');
  if (
    joinedPreset.includes('正式域名上线') &&
    /正式域名|DNS\s*解析|搜索引擎收录|线上排名权重/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('键盘焦点顺序') &&
    /键盘[^，。；]*焦点|读屏无障碍|减少动态效果偏好/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('其他静态内页') &&
    /其他静态内页|多页路由|全站信息架构|仅首页/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('参考站逐像素视觉对比') &&
    /参考站.*视觉对比|未提供参考站/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('原始素材版权') &&
    /原始素材版权|原始上传文件.*核对|未提供原始素材/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('后台 CMS/Commerce/Sqlite') &&
    /(?:后台|CMS|Commerce|Sqlite|内容管理|商务与数据库).*(?:动态数据模型|站点源码|内部实现)/i.test(trimmed)
  ) {
    return true;
  }
  if (
    joinedPreset.includes('静态展示表单') &&
    /(?:静态展示|静态演示).*表单.*(?:提交|校验|回调)/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

export function applyBoundedVerdictCaps(input: BoundedVerdictInput): BoundedVerdictResult {
  const criteria = input.criteria;
  const activeRules = input.antiPatternRules ?? DEFAULT_ANTI_PATTERN_RULES;
  const assessments: Assessment[] = input.assessments.map(a => ({ ...a, evidence: [...a.evidence] }));
  const rawScores = computeViewportScores(assessments, criteria);
  const availableViewports = rawScores.map(s => s.viewport);
  const viewportCapMap = new Map<string, number>();
  const capNotes: string[] = [];

  for (const issue of input.issues) {
    if (issue.severity === 'minor') continue;
    const viewports = affectedVisualViewports(issue, availableViewports);

    if (issue.severity === 'critical') {
      const matchedRule = issue.ruleId
        ? activeRules.find(r => r.id === issue.ruleId)
        : undefined;
      const critCriterionCap =
        matchedRule?.criterionCap != null ? Math.min(55, matchedRule.criterionCap) : 55;
      const critViewportCap =
        matchedRule?.viewportCap != null ? Math.min(55, matchedRule.viewportCap) : 55;
      const rulePrefix = matchedRule ? `${matchedRule.id} ` : '';
      for (const vp of viewports) {
        const prev = viewportCapMap.get(vp);
        if (prev === undefined || critViewportCap < prev) viewportCapMap.set(vp, critViewportCap);
      }
      if (issue.criterionId) {
        for (const a of assessments) {
          if (a.criterionId === issue.criterionId && (!viewports.length || viewports.includes(a.viewport as 'desktop' | 'mobile'))) {
            if (a.score !== null && a.score > critCriterionCap) {
              capNotes.push(`${a.criterionId}(${a.viewport}) 因 ${rulePrefix}Critical 缺陷「${issue.title}」由 ${a.score} 封顶至 ${critCriterionCap}`);
              a.score = critCriterionCap;
            }
            a.passed = false;
          }
        }
      }
      continue;
    }

    // Major issues: use rule-specific caps when defined, otherwise generic major caps (72 / 78)
    const isSvgRule = isVisualSvgPlaceholderIssue(issue);
    const matchedRule = issue.ruleId
      ? activeRules.find(r => r.id === issue.ruleId)
      : undefined;
    const criterionCap = matchedRule?.criterionCap ?? (isSvgRule ? 70 : 72);
    const vpCap = matchedRule?.viewportCap ?? (isSvgRule ? 75 : 78);
    const targetCriterionId =
      issue.criterionId ||
      (isSvgRule ? (/hero|首屏/i.test(`${issue.title} ${issue.detail}`) ? 'hero' : 'sections') : null);

    if (targetCriterionId) {
      for (const a of assessments) {
        if (
          a.criterionId === targetCriterionId &&
          (!viewports.length || viewports.includes(a.viewport as 'desktop' | 'mobile'))
        ) {
          if (a.score !== null && a.score > criterionCap) {
            capNotes.push(
              `${a.criterionId}(${a.viewport}) 因 ${matchedRule ? `${matchedRule.id} ` : isSvgRule ? 'R-VISUAL-01 ' : ''}Major 缺陷「${issue.title}」由 ${a.score} 封顶至 ${criterionCap}`,
            );
            a.score = criterionCap;
          }
          a.passed = false;
        }
      }
    }

    for (const vp of viewports) {
      const prev = viewportCapMap.get(vp);
      if (prev === undefined || vpCap < prev) viewportCapMap.set(vp, vpCap);
    }
  }

  const recomputedAfterCriterionCap = computeViewportScores(assessments, criteria);
  const scores = recomputedAfterCriterionCap.map(s => {
    const cap = viewportCapMap.get(s.viewport);
    if (s.value !== null && cap !== undefined && s.value > cap) {
      capNotes.push(`${s.viewport} 视口总分因 Major/Critical 缺陷硬封顶，由 ${s.value} 压低至 ${cap}`);
      return { viewport: s.viewport, value: cap };
    }
    return s;
  });

  const presetOutOfScope = input.presetOutOfScope || [];
  const { keptUnverified, movedToOutOfScope } = presetOutOfScope.length
    ? classifyUnverifiedLeaks(input.coverage.unverified, presetOutOfScope)
    : { keptUnverified: [...input.coverage.unverified], movedToOutOfScope: [] };

  const dedup = (items: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of items) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = normalizeScopeKey(trimmed) || trimmed;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  };
  const presetNorms = new Set(presetOutOfScope.map(item => normalizeScopeKey(item)).filter(Boolean));
  const filteredModelOutOfScope = presetOutOfScope.length
    ? input.coverage.outOfScope.filter(
        item => !isPresetOutOfScopeDuplicate(item, presetOutOfScope, presetNorms),
      )
    : input.coverage.outOfScope;
  const coverage = {
    verified: dedup(input.coverage.verified),
    unverified: dedup(keptUnverified),
    outOfScope: dedup([...presetOutOfScope, ...filteredModelOutOfScope, ...movedToOutOfScope]),
  };

  const hasBlockingIssue = input.issues.some(i => i.severity === 'critical' || i.severity === 'major');
  const requiredFailed = assessments.some(
    a => criteria.find(c => c.id === a.criterionId)?.required && a.passed === false,
  );
  const belowThreshold = scores.some(s => s.value !== null && s.value < input.threshold);
  const failed = hasBlockingIssue || requiredFailed || belowThreshold;
  const unverified = !assessments.length || assessments.some(a => a.score === null) || coverage.unverified.length > 0;
  const quality: 'passed' | 'failed' | 'unverified' = failed ? 'failed' : unverified ? 'unverified' : 'passed';

  let humanSummary = input.humanSummary
    ? {
        ...input.humanSummary,
        highlights: [...input.humanSummary.highlights],
        topFixes: [...input.humanSummary.topFixes],
      }
    : undefined;

  if (humanSummary && humanSummary.verdict === 'ready') {
    if (quality === 'failed') humanSummary.verdict = 'needs-fixes';
    else if (quality === 'unverified') humanSummary.verdict = 'incomplete-check';
  }

  return {
    assessments,
    scores,
    rawScores,
    quality,
    coverage,
    issues: input.issues.map(i => ({ ...i, evidence: [...i.evidence] })),
    ...(humanSummary ? { humanSummary } : {}),
    capNotes,
  };
}

function normalizedBigrams(text: string): Set<string> {
  const norm = normalizeScopeKey(text);
  const grams = new Set<string>();
  if (norm.length < 2) {
    if (norm) grams.add(norm);
    return grams;
  }
  for (let i = 0; i <= norm.length - 2; i++) {
    grams.add(norm.slice(i, i + 2));
  }
  return grams;
}

function bigramOverlap(a: Set<string>, b: Set<string>): { shared: number; dice: number } {
  if (!a.size || !b.size) return { shared: 0, dice: 0 };
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) shared++;
  }
  return { shared, dice: (2 * shared) / (a.size + b.size) };
}

function extractAsciiTokens(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_./:-]{4,}/g) || [];
  return new Set(matches);
}

/**
 * Removes false single-viewport "only desktop/mobile evidence provided" outOfScope entries
 * emitted by parallel per-viewport batches when the combined run covers both viewports.
 */
export function filterCrossBatchOutOfScopeLeaks(
  items: string[],
  coveredViewports: ReadonlySet<'desktop' | 'mobile'>,
): string[] {
  if (!(coveredViewports.has('desktop') && coveredViewports.has('mobile'))) {
    return items.map(s => s.trim()).filter(Boolean);
  }
  return items
    .map(s => s.trim())
    .filter(Boolean)
    .filter(
      line =>
        !/(?:本轮|本批|本次)仅提供(?:桌面端|PC\s*端|移动端)证据/i.test(line) &&
        !/^(?:桌面端|PC\s*端|移动端)(?:视口)?的?(?:布局|视觉|页面|交互).*(?:仅提供|未提供|不在本批|由其他批次)/i.test(
          line,
        ),
    );
}

/**
 * Drops cross-slice coverage disclaimers emitted by multi-slice homepage batches once full-page
 * screenshots have been captured with zero captureGaps.
 */
export function filterCrossSliceCoverageLeaks(items: string[], hasMultiSlice: boolean): string[] {
  if (!hasMultiSlice) return items.map(s => s.trim()).filter(Boolean);
  return items
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => {
      if (
        /(?:本批|本段|本轮|本片|当前(?:批次|分段|切片))[^。；]*(?:仅含|仅包含|仅展示|仅覆盖|未提供|未包含|仅提供|缺少|不包含|未纳入)[^，。；]*(?:首屏|Hero|页脚|footer|底部|顶部|其余区段|其他区段|上下区段|下半[部段]|上半[部段]|另一视口|桌面端|移动端|视口|scrollY)/i.test(
          line,
        )
      ) {
        return false;
      }
      if (
        /(?:首屏|Hero|其余区段|其他区段|页脚|底部|顶部|桌面端|移动端)[^，。；]*(?:未在(?:本批|本段|本片)中提供|由(?:并行|其他|其余)(?:批次|分段|切片)[^，。；]*(?:核验|负责|检查|覆盖))/i.test(
          line,
        )
      ) {
        return false;
      }
      return true;
    });
}

/**
 * Drops optimistic "no blocking issues" highlights carried over from a passing batch when
 * the merged report verdict is not ready/passed.
 */
export function filterContradictoryHighlights(
  highlights: string[],
  quality: 'passed' | 'failed' | 'unverified',
  verdict: EvaluationVerdict,
): string[] {
  if (quality === 'passed' && verdict === 'ready') {
    return highlights.map(s => s.trim()).filter(Boolean);
  }
  return highlights
    .map(s => s.trim())
    .filter(Boolean)
    .filter(
      line =>
        !/(?:均不阻断|不构成.*阻断|无阻断|可正常交付|均可直接交付|未发现(?:任何)?(?:严重|主要|重大|阻断|关键|Critical|Major)[^，。；]*缺陷|零(?:严重|主要|重大|Critical|Major)|已发现的瑕疵仅为.*(?:均不阻断|轻微))/i.test(
          line,
        ),
    );
}

/**
 * Merges minor cross-viewport paraphrases of the same underlying issue (e.g. desktop vs mobile
 * reporting semi-transparent header overlap or mm/dd/yyyy date placeholder) without collapsing
 * distinct minors on the same viewport or unrelated findings.
 */
export function areCrossViewportMinorDuplicates(a: BoundedIssue, b: BoundedIssue): boolean {
  if (a.severity !== 'minor' || b.severity !== 'minor') return false;
  if (a.viewport === 'both' || b.viewport === 'both' || a.viewport === b.viewport) return false;
  if ((a.ruleId || '') !== (b.ruleId || '')) return false;
  if (a.criterionId && b.criterionId && a.criterionId !== b.criterionId) {
    const compat = new Set(['structure', 'sections']);
    if (!(compat.has(a.criterionId) && compat.has(b.criterionId))) return false;
  }

  const titleA = normalizedBigrams(a.title);
  const titleB = normalizedBigrams(b.title);
  const titleSim = bigramOverlap(titleA, titleB);
  if (titleSim.dice >= 0.35) return true;

  const tokensA = extractAsciiTokens(`${a.title} ${a.detail}`);
  const tokensB = extractAsciiTokens(`${b.title} ${b.detail}`);
  let sharedToken = false;
  for (const tok of tokensA) {
    if (tokensB.has(tok)) {
      sharedToken = true;
      break;
    }
  }
  if (sharedToken && titleSim.shared >= 2) return true;

  if (titleSim.shared >= 4) return true;

  if (titleSim.shared >= 3) {
    const combinedA = normalizedBigrams(`${a.title} ${a.detail.slice(0, 80)}`);
    const combinedB = normalizedBigrams(`${b.title} ${b.detail.slice(0, 80)}`);
    if (bigramOverlap(combinedA, combinedB).dice >= 0.20) return true;
  }

  return false;
}

export function deduplicateBatchTexts(items: string[], max: number, similarityThreshold = 0.42): string[] {
  const seenExact = new Set<string>();
  const keptGrams: Set<string>[] = [];
  const out: string[] = [];

  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeScopeKey(trimmed) || trimmed;
    if (seenExact.has(key)) continue;

    const grams = normalizedBigrams(trimmed);
    const isNearDuplicate =
      grams.size >= 4 && keptGrams.some(prev => bigramOverlap(prev, grams).dice >= similarityThreshold);
    if (isNearDuplicate) continue;

    seenExact.add(key);
    keptGrams.push(grams);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

const HUMAN_VERDICT_SEVERITY: Record<EvaluationVerdict, number> = {
  blocked: 4,
  'needs-fixes': 3,
  'incomplete-check': 2,
  ready: 1,
};

export function pickStrictestHeadline(summaries: readonly EvaluationHumanSummary[]): string {
  const valid = summaries.filter(s => s.headline.trim().length > 0);
  if (!valid.length) return '';
  return [...valid].sort((a, b) => HUMAN_VERDICT_SEVERITY[b.verdict] - HUMAN_VERDICT_SEVERITY[a.verdict])[0].headline.trim();
}
