import type { Scenario, Scope, TemplateUsageMode } from '../../shared/automation.js';

export const SITE_UI_RULES_VERSION = 'v1.2';

export interface SiteUiHardRulesOptions {
  scenario: Scenario;
  scope: Scope;
  templateMode?: TemplateUsageMode;
  isContinuation?: boolean;
}

const CONTINUATION_REMINDER =
  '【站点 UI 与去重防回归提示（v1.2）】继续遵守首屏完整居中、标题行数、图文等高（relative 外壳 + absolute object-fit:cover，覆写参考站失衡）、可见字≥12px（覆写10–11px小字）、<html lang>匹配目标语种（禁原生 <input type="date">）、反空旷（禁编造事实）及同页联系方式/CTA 按场景换词去重（H32）约束；严禁改动已达标稳定区段。';

/**
 * Builds compact, high-signal UI layout and deduplication hard rules (v1.2)
 * injected into initial site generation and concise continuation reminders.
 */
export function buildSiteUiHardRulesPrompt(options: SiteUiHardRulesOptions): string {
  if (options.scenario === 'app-template') {
    return '';
  }
  if (options.isContinuation) {
    return CONTINUATION_REMINDER;
  }

  const scopeLine =
    options.scope === 'homepage'
      ? '本次仅交付首页，不擅自扩展内页；'
      : '全站补齐所需内页并保持内页 H1 底部 ≤ 视口 70%；';

  const templateLine =
    options.templateMode === 'direct-template'
      ? '保留 Kooboo 模板原生 Page/Layout/View/kooboo-var.css 视觉 DNA 与骨架，原位修正上述版式、首屏与去重问题，不推倒重写，并一次完成代码落地（不要停在分析阶段）。'
      : '保留参考视觉 DNA（字体气质、色板、圆角、图像风格与签名元素），先在内部规划各 section 的图文高度关系与联系信息落点，直接一次完成代码落地（不要停在分析阶段）。';

  return [
    `【企业官网 UI 与版式硬约束（${SITE_UI_RULES_VERSION}，优先级：可读性>结构>版式平衡>一致性>视觉还原>动效）】`,
    `1. 单首页与清理：唯一首页 /，删 Home 2/3、Demos、All Pages 及 Lorem ipsum/Edit me/Your text here 占位；${scopeLine}`,
    '2. 首屏安全线与居中（1440×900/1280×800/390×844）：eyebrow+H1+副文+主CTA+主图完整可见；CTA底 ≤ vh−40（900高≤860/800高≤760）、主图底 ≤ vh、文本块 ≤640/560px、H1顶 ≥ 导航底+32；文字块中心落视口 44–56%（display:grid;align-content:center，禁 flex-end/超大 padding-top/100vh 底对齐）；超限时先精炼副文或略缩 H1（≥40px），保留业务事实。',
    '3. 标题行数与断行：首屏 H1 ≤3 行（优先2），H2/H3/卡片标题 ≤2 行，标签 1 行；末行禁单英文词或单汉字（text-wrap:balance + max-width + 必要时 &nbsp;），4 行即缩字号/加宽/精简措辞，禁 line-clamp 截断。',
    '4. 图文等高与纵排多图：双栏图文高度差 ≤ max(48px,短列8%)；媒体列用 position:relative;min-height:100% + img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}，禁仅写 height:100%；文字列高÷单图高（4:3按0.75×列宽）>1.4 拆2图纵排、>2.2 拆3图（每张≥180px、gap:16–24px、总高对齐）、>2.8 用 sticky 或拆 section，禁小图配长文；参考站失衡仍须按此重构。',
    '5. 文字与图片双可见：正文/按钮对比 ≥4.5:1、大字 ≥3:1；图上压字用方向性遮罩（文字侧55–70%、主体侧≤20%，禁全图>70%压黑），全屏图文占宽 ≤52%；图 opacity ≥0.6 且 object-fit:cover 不拉伸。',
    '6. 反空旷与事实保真：单屏空白 ≤40%、分栏短列 ≥ 长列75%、非首屏 section 内容占高 ≥50%、连续空白 ≤240px；按「提炼已有资料/旧站事实→补真实或合规 imagePlaceholder 配图→改单栏/调版式→减高度」修复，禁空 div/纯渐变填充，禁捏造统计数字或客户证言。',
    '7. 组件与本地化：任何可见字≥12px（覆写参考站10–11px小字；正文≥14推荐16、按钮≥14、页脚≥13文本列非按钮）；桌面≥1024吸顶导航（64–80px、边距对齐容器、禁汉堡）；卡片等高顶对齐 CTA 贴底，网格无空洞（3/6/9、4→4或2×2、5→3+2居中或2列），空数据隐藏/空态；价格表≥1024横3列等高；按钮≤3类且每屏主CTA≤1；表单含说明、label在上、框高44–48px、图标距边12–16px；暗色设 color-scheme:dark 与暗滚动条；8pt间距全站一档（96/120/160）；无横溢；动效仅 transform/opacity（≤800ms、≤24px、支持 prefers-reduced-motion 且无JS可见）；<html lang>匹配主语种，非中文站禁中文及原生 <input type="date">（改文本/自定义选择，防年/月/日）。',
    '8. 同页去重（H32，按同号/邮箱/地址计，轮播加 aria-hidden）：一次完整+一次精简——电话/邮箱≤3（正文≤1）、地址/时间≤2（正文≤1）、相同 CTA≤3（正文≤2，按区块换场景词）、同段/标题 0 重复、内容图≤2；Header 有号 Hero 不再放号；Contact 完整 Footer 仅精简行。',
    `9. 模板适配：${templateLine}`,
  ].join('\n');
}
