# Kooboo AI Automation Lab v0.7.2 发布说明

发布日期：2026-11-14。基于 `v0.7.1` 的模板工作流预算与全站分析收口优化，解决整站模板任务在 `prepare`（以及复杂站点独立评测）阶段因 3–5 分钟累计决策超时而无法冻结基线的问题。

## 修复内容

1. **参考分析与逐项评测累计时间下限调整**
   - `shared/completeness.ts`：`defaultCompletenessSettings` 默认 `maxMinutes` 从 `3` 调整为 `15`、`maxRequests` 从 `20` 调整为 `120`。
   - `server/automation/template-analysis.ts` 与 `server/automation/template-workflow-evaluation.ts`：保障 `scope === 'site'` 至少具备 `15` 分钟（`scope === 'homepage'` 至少 `8` 分钟）及至少 `80` 次工具请求的执行空间，覆盖既有任务及历史 `5` 分钟配置，支持从已有采集产物和草稿断点续跑。

2. **整站参考分析 SOP 收口优化**
   - `server/automation/template-analysis.ts`：明确 `scope === 'site'` 只需精选 `Home` + 最多 `1–2` 个高代表性核心模板页完成双端截图分析；提醒模型结合 `decisionBudget.remainingMs` 及时提交检查点与基线，次要未单独截图的站内链接不放入 `manifest.items` 的待截图路径校验、改为写入 `manifest.limitations` 留待生成后阶段核验，不再因此阻塞基线冻结与站点创建。

## 兼容与升级说明

- 无数据库结构调整；升级并重启服务后，因 `v0.7.1` 5 分钟预算上限中断在 `prepare` 阶段的任务可直接恢复执行，复用已采集且校验哈希的参考截图继续分析、建站与评测。
