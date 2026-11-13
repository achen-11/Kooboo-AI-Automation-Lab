import type { TemplateCheckDefinition } from './template-workflow.js';

/** Adapted from the designer's AI网页生成规范.md and AI-Prompt.txt, 2026-11-13. */
export const templateDesignPrompt = `按冻结参考基线生成可用的 AI Site 模板，保留字体气质、色板、圆角、图片比例、版式节奏与签名元素。图片继续使用 imagePlaceholder，不复用参考素材；真实业务事实只来自冻结资料，演示内容明确保持为演示。
先把 Template DNA、当前范围内的页面/区块顺序和主 CTA 写进基线设计意图，再用一致的颜色、字号、间距、容器与动效 tokens 实现。已有完整基线直接执行，不重复研究或等待用户批准结构。
发生冲突时优先可读性、信息结构、一致性，再保留视觉还原与动效；具体例外及原因写进基线。避免将所有模板改成同一种导航、网格或间距。
首屏的价值主张与主要行动应可见；文字不被裁切，正文至少14px，可见文字至少12px。同组组件对齐、密度合理，空数据采用空状态。控制台错误、占位文案、空链接、横向溢出与不可操作控件应修复。保持页面语言、日期与货币一致。
表单提供可访问名称及明确反馈；支持键盘、可见焦点与 reduced-motion。动效结束后内容可读，无 JS 时核心内容仍可访问。
吸顶导航、桌面菜单形式、价格列数、页脚列数、H1行数、首屏坐标与间距数值是模板相关约束，应结合参考、实际视口、语言和内容冻结，不作为所有站点的统一版式。
生成侧报告改动与源码检查结果；逐项 pass/fail 和问题关闭由 Lab 使用当前站点独立取证判定。证据不足保留未验证，不凭自述宣称通过。`;

const groups = [
  ['designer-first-screen', '首屏与文字可读性', 'H02/H04/H05：检查本区块文字裁切、字号与断行。Hero还检查价值主张和主CTA首屏可见。正文≥14px，可见文字≥12px；版权允许12px。1440×900时CTA底部≤860、1280×800时≤760仅在实际对应视口取证后判断；桌面标题≤2行、移动≤3行作为默认，保留已声明的模板/语言例外。没有相关文字或Hero的子项说明不适用。'],
  ['designer-components', '组件与布局一致性', 'H06–H12/H14/H17/H18/H23：仅检查本区块实际包含的组件。同组卡片对齐、无无意空洞，按钮和间距遵守基线tokens；表单有标题、label和可用控件，固定区域可完整访问；空数据有空状态。价格表、导航和页脚沿用已冻结模板形式，不机械要求三列价格、吸顶或特定列数。无相关组件可说明不适用。'],
  ['designer-responsive', '响应式与内容遮挡', 'H03/H09/H18/H21：在实际桌面/移动视口检查横向溢出、导航与弹层遮挡、固定区域超高、缩放和组件重排。仅基线明确要求吸顶时验证吸顶。局部裁切轮播不等于整页横向溢出，满宽背景不等于正文贴边。其他宽度未采集保留未验证，不声称覆盖1440/1280/390三档。'],
  ['designer-content', '内容、语言与页面语义', 'H01/H13/H22/H24：检查本区块的残留演示菜单、Lorem ipsum/Edit me/Your text here、空链接及语言/日期/货币不一致。唯一首页、页面H1和SEO仅在页面级上下文核查，首页任务不扩展内页。中文品牌名和明确演示数据可声明例外；imagePlaceholder是模板要求，不作为残留占位文案缺陷。'],
  ['designer-accessibility', '可访问性与对比度', 'H12/H16/H24：检查本区块可访问名称、图片alt、标签、焦点及文字可读性。正文对比度≥4.5:1，大字≥3:1，图上文字按实际背景确认。数值需测量或可验证样式，不凭截图猜比值；键盘、菜单、表单反馈必须有实际操作前后证据，静态截图不能证明通过。无对应元素可说明不适用。'],
  ['designer-motion-dna', '动效与模板特征', 'H15/H19/H20：对比本区块字体、主色、圆角、图像比例和签名元素；暗色控件与滚动条协调。动效优先transform/opacity，默认文字动效≤800ms、位移≤24px且支持reduced-motion和无JS可读性。动态行为必须有实际模式/时序证据，最终截图不能证明动效、无JS或reduced-motion已验收；静态区块不强行添加动效。'],
] as const;

export const designerTemplateChecks: TemplateCheckDefinition[] = groups.map(([id, title, instruction]) => ({
  id, title, instruction, enabled: true, kind: 'visual', executor: 'ai',
  scopes: ['homepage', 'site'], viewports: ['desktop', 'mobile'], required: id !== 'designer-motion-dna',
  severity: 'major', weight: id === 'designer-motion-dna' ? 0 : 1, tolerancePx: 0,
  exceptions: '按区块实际组成与冻结基线判断；不适用需写明依据，证据不足为unverified。不得以模板风格为理由放过不可读或不可操作的缺陷。',
}));

/** Add missing designer groups while preserving existing edits and disabled checks. */
export function appendDesignerChecks(checks: TemplateCheckDefinition[]): TemplateCheckDefinition[] {
  const ids = new Set(checks.map(check => check.id));
  return [...checks, ...structuredClone(designerTemplateChecks.filter(check => !ids.has(check.id)))];
}
