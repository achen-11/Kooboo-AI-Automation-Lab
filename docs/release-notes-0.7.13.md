# Kooboo AI Automation Lab v0.7.13 发布说明

发布日期：2026-11-14。基于 `v0.7.12` 真机验证反馈，修复研究 Sandbox 命名截断、Framer 滚动渐显区段漏测、长页面布局索引截断以及全站参考分析预算过紧 4 个问题。

## 修复内容

1. **研究 Sandbox 站名长度合规与旧站兼容复用**
   - `server/automation/generation-reference-media.ts`：新增 `researchSandboxName(siteId)`，将 `siteId` 编码为 33 字符 `autoref-<25位base36>`，确保拼接 Kooboo `__ai_sandbox__` 前缀后总长不超过 47 字符（`<= 50` 上限），避免 Kooboo `SiteNameToFolderName` 截断导致首轮 `read_image` 触发 `sandbox_not_found` 或二轮修复无法按名找回同一研究 Sandbox；同时保留对已有 36 字符截断旧名 `automation-ref-...` 的识别复用。

2. **滚动触发式隐藏区段（`opacity: 0`）补扫入库**
   - `server/automation/template-layout.ts`：`layoutInventory()` 在检测到首屏外存在 `opacity: 0` 元素时自动分步滚动页面触发 Framer `whileInView` 动画并记录曾显影元素，再重置回顶部读取全页布局；永久保持 `opacity: 0` 的弹窗/遮罩仍维持排除。

3. **长页面候选区段去重扩展与分页扩容**
   - `server/automation/template-workflow-capture.ts`：将 `form` 纳入地标标签，去除同一包装层级冗余 `div`，将连续重复同级条目上限收束为每组 2 项并将 `candidates` 上限提升至 120 项，防止跑马灯等列表挤占页尾区段；`compactLayout()` 默认每页返回条数从 20 扩至 60（支持 1–120 可配）。
   - `server/automation/template-analysis.ts` 与 `template-workflow-evaluation.ts`：`read(layout)` 工具与协议示例透传可配 `limit`。

4. **全站 `prepare` 参考分析累计活动时间与工具调用额度对齐**
   - `server/automation/template-analysis.ts` 与 `local-decision.ts`：`site` 范围 `analysisMinutes` 从 15 分钟提升至 `Math.max(policy.maxMinutes, liveCompleteness?.maxMinutes || 0, 45)`，`analysisRequests` 提升至 `320`、`analysisTokens` 至 `60000000`，同时让单轮决策工具调用上限与 `policy.maxRequests` 对齐。

## 升级说明

- 无破坏性数据库结构调整。注意升级后若需验证 Framer 长页的修复效果，请对既有未完成 `prepare` 的全站任务使用新任务重新采集以刷新 `layout` 索引；已有 `Playo 128` 修复子任务等旧研究 Sandbox 任务可自动复用原有 36 字符研究 Sandbox。
