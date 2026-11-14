# Kooboo AI Automation Lab v0.7.12 发布说明

发布日期：2026-11-14。基于 `v0.7.11` 修复 AI Site 模板生成看图链路、全站参考来源覆盖及既有站点独立延续流程继承问题。

## 修复内容

1. **专用研究 Sandbox 参考与修复截图交付**
   - `server/automation/generation-reference-media.ts`、`generation-context.ts`、`generation-reference.ts` 与 `generator.ts`：将冻结参考 PNG、修复问题截图及迁移首轮视觉基线上传至目标站专属隔离研究 Sandbox（`automation-ref-<siteId>`）并回读校验 SHA-256；通过 `kfile` `referenceImages` 索引下发 `imageId` 与 `sandbox`，引导生成 AI 使用 `read_image({imageId, sandbox})` 与 `process_image({imageId, sandbox, operation: "slice"})` 实际看图，不再依赖 bridge `imageInput`，也不污染生成站自身媒体库。

2. **模板源码压缩与全站路径覆盖门禁**
   - `server/automation/completeness.ts`：在 `sourceReader` 超预算时剥离超大内联 `<style>`、非 JSON/JSON-LD `<script>` 与长 `data:` URI，保留页面主体 DOM 与子页面链接（解决 Framer 等站点 `<head>` 样式膨胀导致子页面发现被截断的问题）。
   - `server/automation/template-workflow-capture.ts`、`template-analysis.ts` 与 `template-source-coverage.ts`：取消 30 条内部链接截断，要求所有已发现内部路径均进入 `manifest.items`（配齐双端基线）或显式归入 `excludedPaths`，禁止通过删减路径声明 `sourceComplete=true`。

3. **独立继续生成与独立评测继承新模板流程**
   - `server/automation/store.ts` 与 `template-workflow-store.ts`：支持既有站点在无 `parentId` 的继续生成与独立评测中自动继承同输入版本的 `templateWorkflow` 及最新 `requirementsId`，并拦截 `homepage` 基线站点直接发起全站继续生成导致的静默回退。

## 兼容与升级说明

- 无破坏性数据库结构调整；升级重启后可按既有检查点继续或新建 AI Site 模板任务。
- 与 Kooboo 侧配合修复的本地 Sandbox HTTPS `PreviewUrl` 升级见 Kooboo 仓库 `wg/batch-ai-site-templates` 分支。
