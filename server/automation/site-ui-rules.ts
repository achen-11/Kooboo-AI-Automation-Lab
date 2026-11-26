import type { AutomationTask, InputVersion, Scenario, Scope, TemplateUsageMode } from '../../shared/automation.js';

export const SITE_UI_RULES_VERSION = 'v1.2';

export type ClonedContentImageSource =
  | { kind: 'target-site'; contentUrl: string }
  | { kind: 'source-sandbox'; contentUrl: string; sandbox: string; siteId: string };

/**
 * Resolves whether the current task has a real content site whose clone actually succeeded
 * (either directly into the target site or into a read-only source Sandbox for role-swapped upgrades).
 * Returns undefined for `site-template`/`app-template`, skipped/degraded clones, or unfinished clones.
 */
export function resolveClonedContentImageSource(
  task: Pick<AutomationTask, 'scenario' | 'generation'>,
  input?: Pick<InputVersion, 'contentUrl'> | null,
): ClonedContentImageSource | undefined {
  if (task.scenario !== 'upgrade' && task.scenario !== 'migration') {
    return undefined;
  }
  const gen = task.generation;
  if (!gen || gen.skipSourceTransfer) {
    return undefined;
  }
  const contentUrl = (gen.overrideContentUrl || input?.contentUrl || '').trim();
  if (!contentUrl) {
    return undefined;
  }
  if (gen.referenceTemplate?.mode === 'direct-template') {
    const sandbox = gen.sourceSandbox?.sandbox?.trim() || '';
    const siteId = gen.sourceSandbox?.siteId?.trim() || '';
    if (gen.sourceSandbox?.complete === true && sandbox && siteId) {
      return { kind: 'source-sandbox', contentUrl, sandbox, siteId };
    }
    return undefined;
  }
  if (gen.transferComplete === true) {
    return { kind: 'target-site', contentUrl };
  }
  return undefined;
}

/**
 * Builds generation/continuation guidance enforcing priority reuse of real images
 * from a successfully cloned content site over `imagePlaceholder` or template demo media.
 */
export function buildClonedContentImageGuidance(
  task: Pick<AutomationTask, 'scenario' | 'generation'>,
  input?: Pick<InputVersion, 'contentUrl'> | null,
  options?: { isContinuation?: boolean },
): string {
  const source = resolveClonedContentImageSource(task, input);
  if (!source) {
    return '';
  }
  if (options?.isContinuation) {
    return source.kind === 'source-sandbox'
      ? `【原内容站图片优先防回归】原内容站（${source.contentUrl}）已成功克隆至只读源站 Sandbox「${source.sandbox}」，修复或补图时必须优先复用原内容站真实图片资源（再考虑随附资料图），仅在原站确无可用图时才以 imagePlaceholder 兜底，严禁把已正确使用的原站实图替换为占位图或残留模板演示图。`
      : `【原内容站图片优先防回归】原内容站（${source.contentUrl}）已成功克隆至当前目标站，修复或补图时必须优先从当前站点媒体库（Image/File）复用原内容站真实图片资源（再考虑随附资料图），仅在原站确无可用图时才以 imagePlaceholder 兜底，严禁把已正确使用的原站实图替换为占位图。`;
  }
  if (source.kind === 'source-sandbox') {
    return [
      '【原内容站图片资源优先策略（内容站已成功克隆至只读源站 Sandbox）】',
      `1. 原内容站（${source.contentUrl}）已成功克隆至只读源站 Sandbox「${source.sandbox}」（siteId：${source.siteId}）。品牌 Logo、产品/服务实拍、团队、案例、门店/环境及首屏主图等展示位，必须优先盘点并复用原内容站中的真实图片资源（先用带 sandbox: "${source.sandbox}" 的 list_site_object 盘点 Image / File 并核对克隆页面与样式中的有效图片路径，再迁移/本地化到目标站媒体库或有效站内路径后引用），严禁绕过原站可用图片直接大面积使用 imagePlaceholder 或残留模板演示图。`,
      '2. 图片选用优先级：已克隆原内容站真实可用图片 > 随附资料包/客户上传图片 > imagePlaceholder（仅限原站确无对应图片、图片破损/分辨率严重不足或构图明显不适配时兜底）；若原图比例与新容器不同，优先使用 object-fit: cover、object-position 或合适裁切适配，而非轻易弃用原图。',
      '3. 严禁在目标站直接热链仅在 Sandbox 内有效或易失效的临时预览地址，确保目标站页面所有 <img> 均使用目标站可稳定访问的站内图片资源。',
    ].join('\n');
  }
  return [
    '【原内容站图片资源优先策略（内容站已成功克隆至目标站）】',
    `1. 原内容站（${source.contentUrl}）已成功克隆至当前目标站。按参考站重构新版页面与样式时，仅重构视觉布局与代码架构，严禁丢弃已克隆进当前站点媒体库（Image）与文件库（File）的原内容站真实图片资源；先通过 list_site_object 盘点当前站点已有的原站 Image / File 资产，品牌 Logo、产品/服务实拍、团队、案例、门店/环境及首屏主图等展示位必须优先直接引用原内容站已克隆图片，严禁绕过原站可用图片改用 imagePlaceholder 或复制参考站图片。`,
    '2. 图片选用优先级：当前目标站已克隆的原内容站真实可用图片 > 随附资料包/客户上传图片 > imagePlaceholder（仅限原站确无对应图片、图片破损/分辨率严重不足或构图明显不适配时兜底）；若原图比例与新容器不同，优先使用 object-fit: cover、object-position 或合适裁切适配，而非轻易弃用原图。',
    '3. 清理旧站样式、脚本或多余页面时，严禁误删仍在使用的原内容站真实业务图片。',
  ].join('\n');
}

export interface SiteUiHardRulesOptions {
  scenario: Scenario;
  scope: Scope;
  templateMode?: TemplateUsageMode;
  isContinuation?: boolean;
}

const CONTINUATION_REMINDER =
  '【站点 UI 与去重防回归提示（v1.2）】继续遵守首屏完整（含浮层卡）、图文等高（relative 外壳 + absolute object-fit:cover，覆写参考站失衡）、可见字≥12px（覆写10–11px小字）、<html lang>匹配目标语种（禁原生 <input type="date">）、禁假素材/编造及同页去重（H32，内容图≤1、按场景换词）与防404锚点约束；严禁改动已达标稳定区段。';

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
      ? '本次仅交付首页，不擅自扩展内页，导航/按钮改 #anchor 页内锚点防 404；'
      : '全站补齐所需内页并保持内页 H1 底部 ≤ 视口 70%；';

  const isUpgrade = options.scenario === 'upgrade';
  const templateLine =
    options.templateMode === 'direct-template'
      ? isUpgrade
        ? '保留 Kooboo 模板原生 Page/Layout/View/kooboo-var.css 布局骨架，品牌主色/强调色优先对齐原内容站与商家气质（原站无明确主色再沿用模板色板），原位修正首屏、图文与去重并一次落地。'
        : '保留 Kooboo 模板原生 Page/Layout/View/kooboo-var.css 视觉 DNA 与骨架，原位修正上述版式、首屏与去重问题，不推倒重写，并一次完成代码落地（不要停在分析阶段）。'
      : isUpgrade
        ? '保留参考视觉 DNA（布局骨架、字体层级与版式节奏；品牌主色/强调色优先对齐原内容站与商家气质，原站无明确主色再沿用参考色板），先规划图文高度与联系落点，直接一次完成代码落地。'
        : '保留参考视觉 DNA（字体气质、色板、圆角、图像风格与签名元素），先在内部规划各 section 的图文高度关系与联系信息落点，直接一次完成代码落地（不要停在分析阶段）。';

  return [
    `【企业官网 UI 与版式硬约束（${SITE_UI_RULES_VERSION}，优先级：可读性>结构>平衡>一致性>视觉还原>动效）】`,
    `1. 单首页与清理：唯一首页 /，删 Home 2/3、Demos、All Pages 及 Lorem ipsum/Edit me/Your text here；${scopeLine}`,
    '2. 首屏安全线（1440×900/1280×800/390×844）：eyebrow+H1+副文+主CTA+主图完整；CTA底 ≤ vh−40（860/760）、主图与浮层卡片底 ≤ vh、文本 ≤640/560px、H1顶 ≥ 导航底+32；文字中心落 44–56%（grid;align-content:center，禁 flex-end/100vh 底对齐）；首屏同年/定位标签最多1次；超限精炼副文或微缩 H1（≥40px）。',
    '3. 标题行数与断行：H1 ≤3 行（优先2），H2/H3/卡题 ≤2 行，标签 1 行；末行禁单英词/单汉字（text-wrap:balance + max-width + &nbsp;），4 行即缩字号/加宽/精简，禁 line-clamp 截断。',
    '4. 图文等高与纵排多图：双栏高差 ≤ max(48px,短列8%)；媒体列 position:relative;min-height:100% + img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}，禁仅 height:100%；文高÷单图高（4:3按0.75×列宽）>1.4 拆2图、>2.2 拆3图（≥180px、gap:16–24px），>2.8 用 sticky/拆节，禁小图配长文；参考站失衡仍须按此重构。',
    '5. 图文可见及选图：正文/按钮对比 ≥4.5:1、大字 ≥3:1；压字用方向性遮罩（文字侧55–70%、主体侧≤20%，禁全图>70%压黑），全屏图文占宽 ≤52%；图 opacity ≥0.6 且 object-fit:cover；Hero 主图匹配定位，<600px 老图禁铺大横幅/大卡（改小卡/图文横排），资源本地化禁外部/http://热链。',
    '6. 反空旷与保真：空白 ≤40%、短列 ≥75%、内容占高 ≥50%、连续空白 ≤240px；缺 Logo/指标素材删槽位或改文字信任条，禁灰白实拍图充 Logo 墙及硬凑数字；多电话（座机+24/7热线）全保留标用途并用 tel:/mailto:；按「旧站/资料事实→补原站/资料实图（无图再用 imagePlaceholder）→调版式→减高度」修复，禁捏造统计数字或客户证言。',
    '7. 组件与本地化：可见字≥12px（覆写参考站10–11px小字；正文≥14、按钮≥14、页脚≥13文本列）；≥1024吸顶导航（64–80px、禁汉堡）；卡等高 CTA 贴底、网格无空洞、空数据隐藏；价格表≥1024横3列；按钮≤3类、每屏主CTA≤1；表单含说明、label在上、框高44–48px；暗色设 color-scheme:dark；8pt间距全站一档（96/120/160）；无横溢；动效仅 transform/opacity（≤800ms、≤24px、prefers-reduced-motion 且无JS可见）；<html lang>匹配主语种，非中文站禁中文及原生 <input type="date">。',
    '8. 同页去重（H32，轮播加 aria-hidden）：一次完整+一次精简——电话/邮箱≤3（正文≤1）、地址/时间≤2（正文≤1）、相同 CTA≤3（正文≤2，按区块换场景词）、同段/标题 0 重复、内容图≤1（禁 Hero 与下方复用同图）、首屏同标签≤1；Header 有号 Hero 不放号；Contact 完整 Footer 仅精简行。',
    `9. 模板适配：${templateLine}`,
  ].join('\n');
}
