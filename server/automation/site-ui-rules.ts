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
      : `【原内容站图片优先防回归】原内容站（${source.contentUrl}）已成功克隆至当前目标站，修复或补图时必须优先从当前站点媒体库（Image/File）复用原内容站真实图片资源（再考虑随附资料图），仅在原站确无可用图时才以 imagePlaceholder 兜底，严禁把已正确使用的原站实图替换为占位图。重写根路径 / 首页时须原位更新或先删旧页再建 /，严禁用 update_object_route 改名旧首页路由以免默认起始页漂移。`;
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
    '4. 首页路由与默认起始页保护：重构根路径 `/` 首页时，必须原位更新克隆得到的原 `/` 页面对象（或先删除旧 `/` 页面再创建新 `/` 页面），严禁用 `update_object_route` 将旧首页改名为 `/oud-home`、`/old-home` 等备份路径后再另建 `/`——旧页面保留的默认起始页（StartPage / DefaultStart）标记会导致站点首页链接指向旧页。',
  ].join('\n');
}

export interface SiteUiHardRulesOptions {
  scenario: Scenario;
  scope: Scope;
  templateMode?: TemplateUsageMode;
  isContinuation?: boolean;
}

const CONTINUATION_REMINDER =
  '【站点 UI 防回归（v1.2）】首屏完整、图文等高（relative+absolute）、img[width][height]配height:auto、可见字≥12px（覆写10–11px小字）、<html lang>匹配（禁 <input type="date">）、禁编造、H32去重与锚点；严禁改动已达标稳定区段；收尾禁调 ask_user_input 询问打开浏览器/页面做视觉验收或删除临时参考 Sandbox。';

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
      : '全站补齐所需内页，内页H1底≤视口70%；';

  const isUpgrade = options.scenario === 'upgrade';
  const templateLine =
    options.templateMode === 'direct-template'
      ? isUpgrade
        ? '保留 Kooboo 模板原生 Page/Layout/View/kooboo-var.css 骨架，品牌主色/强调色优先对齐原内容站与商家气质（无则用模板色），原位修首屏图文去重一次落地。'
        : '保留 Kooboo 模板原生 Page/Layout/View/kooboo-var.css 视觉 DNA 与骨架，原位修首屏图文去重，一次完成代码落地。'
      : isUpgrade
        ? '保留参考视觉 DNA（骨架、Header 主 CTA 形态、核心交互/色块签名区块，不得轻易退化为普通 2×2 卡片；品牌主色/强调色优先对齐原内容站与商家气质，无则用参考色），直接一次完成代码落地。'
        : '保留参考视觉 DNA（骨架、Header 主 CTA 形态、核心交互/色块签名区块、字体、色板、圆角与图风，不得轻易退化为普通 2×2 卡片），直接一次完成代码落地。';

  return [
    `【企业官网 UI 与版式硬约束（${SITE_UI_RULES_VERSION}：可读性>结构>平衡>一致性>视觉还原>动效）】`,
    `1. 单首页与清理：唯一首页 /，禁将旧 / 改名备份（原位改或删后重建），删 Home 2/3、Demos、All Pages 及 Lorem ipsum/Edit me/Your text here；${scopeLine}`,
    '2. 首屏（1440/1280/390）：eyebrow+H1+副文+主CTA+主图完整；CTA底≤vh−40、浮层卡片底 ≤ vh、文≤640/560、H1顶≥导航底+32；居中44–56%（grid居中，禁底对齐/100vh）；首屏同年/定位标签最多1次；超限精炼或缩H1≥40。',
    '3. 标题断行：H1≤3行，H2/H3/卡题≤2行，标签1行；末行禁单字（text-wrap:balance+max-width+&nbsp;），4行即缩字加宽精简，禁line-clamp。',
    '4. 图文等高：双栏高差≤max(48px,短列8%)；媒体列 position:relative;min-height:100%+img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}（禁仅height:100%）；文高÷4:3图高>1.4拆2图、>2.2拆3图（≥180px），>2.8用sticky/拆节，禁小图配长文；禁对高差悬殊列用 align-content:space-between 拉出大段空洞；参考站失衡仍须按此重构。',
    '5. 图文可见及选图：对比≥4.5:1/大字≥3:1；方向遮罩（文侧55–70%、图侧≤20%），全屏文占≤52%；图opacity≥0.6且object-fit:cover；写img[width][height]须配img{height:auto}或父盒aspect-ratio+子图height:100%，禁仅width:100%+aspect-ratio漏height；Hero匹配定位，<600px 老图禁铺大横幅/大卡（改小卡/横排），禁外链。',
    '6. 反空旷与保真：空白≤40%、短列≥75%、内容≥50%、连续空白≤240px；缺Logo/指标删槽或改文字条，禁灰白实拍图充 Logo 墙及硬凑数字；多电话（座机+24/7热线）全保留标用途并用 tel:/mailto:；按「事实→补实图/imagePlaceholder→调版式→减高」修，禁捏造统计数字或客户证言；禁凑节奏自造参考站没有的带标题冗余画廊（缺社媒/新图沿用原结构或省略）。',
    '7. 组件本地化：可见字≥12px（覆写参考站10–11px小字；正文按钮≥14、页脚≥13）；≥1024吸顶导航（64–80px、禁汉堡）；卡等高CTA贴底、无空洞、空数据隐藏；价格表≥1024横3列；按钮≤3类/屏主CTA≤1；表单含说明label高44–48px；暗色color-scheme:dark；8pt间距；无横溢；动效仅transform/opacity（≤800ms/24px、reduced-motion与无JS可见）；<html lang>匹配主语种，非中文禁中文及原生 <input type="date">。',
    '8. 同页去重（H32，轮播加aria-hidden）：电话/邮箱≤3（正文≤1）、地址/时间≤2（正文≤1）、相同CTA≤3（正文≤2，按区块换场景词）、同段/标题0重复、内容图≤1（禁 Hero 与下方复用同图）、首屏同标签≤1；Header有号Hero不放；Contact完整Footer精简1次。',
    `9. 模板适配：${templateLine}`,
    '10. 无人值守：落盘通过即结束，严禁调用 ask_user_input 询问是否允许打开浏览器或页面进行视觉验收（由评测/人工接管），也禁止询问是否删除临时 reference-* 参考 Sandbox（默认保留）。',
  ].join('\n');
}
