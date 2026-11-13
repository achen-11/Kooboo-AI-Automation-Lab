# Kooboo AI Automation Lab v0.7.1 发布说明

发布日期：2026-11-14。基于 `v0.7.0` 的模板工作流热修复版本，解决两类参考站分析在 `prepare` 阶段死锁阻塞站点生成的问题。

## 修复内容

1. **外部参考站动效与懒加载图片就绪判定优化**
   - `server/automation/page-screenshots.ts`：视口稳定检查忽略 `<= 1×1` 的追踪像素图片；将可见的 `loading="lazy"` 未完成图片切换为 `eager`；在检测元素几何变化时忽略 CSS `transform` 与无限循环 WAAPI 动画造成的 `x/y` 位移抖动（如 Framer 无限滚动条/跑马灯）。
   - `server/automation/browser.ts`：对外部来源执行 10 秒补采重试时（`role !== 'target'` 且 `settleTimeoutMs >= 10000`），临时启用 `prefers-reduced-motion: 'reduce'`，结束后恢复 `'no-preference'`。
   - `server/automation/template-workflow-capture.ts`：遍历批次数（`traversalBatches < 4`）与遍历后单帧补采批次数（`retryBatches < 16`）分离，确保多于 3 个未静止帧的页面可在单次采集中逐帧重试；外部参考站全页覆盖且完成 10 秒降噪重试后，若所有未静止帧均无坏图、无有限时长运行中动画、字体就绪且无横向溢出（`stableForMs >= 500 || pendingImages === 0`），允许保留未静止帧提示并完成参考采集；目标站（`role === 'target'`）仍保持严格静止校验。

2. **整站参考分析 SOP 与站内链接暴露**
   - `server/automation/template-workflow-capture.ts`：`analysisCaptureIndex` 增加最多 30 条同源 `internalLinks` 供分析阶段参考。
   - `server/automation/template-analysis.ts`：在分析上下文补充 `retryGuidance` 与 `previousLimitations`；更新参考分析 SOP，明确 `scope === 'site'` 时通过只读工具补采代表性子页面，并将未触发交互态、推断的字体/色值 Token、展示框噪声及图片版权占位说明记录到 `manifest.limitations`，不再将此类说明误判为 `sourceComplete = false` 而永久阻塞基线冻结与站点生成。

## 兼容与升级说明

- 本版本无数据库表结构与配置格式变更；现有 `.data/`、加密配置、规则快照与任务历史可直接保留。
- 升级后对此前因上述两类问题中断在 `prepare` 阶段的任务，可直接复用或重新发起任务完成基线冻结与站点生成。
