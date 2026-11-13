# Kooboo AI Automation Lab v0.7.6 发布说明

发布日期：2026-11-14。基于 `v0.7.5` 提高多页多区块整站模板在分析与独立评测阶段的模型请求次数下限，并在 SOP 中前置提醒 `read(implementation)` 只读后台核验要求。

## 修复内容

1. **参考分析与独立评测模型请求次数下限调整**
   - `server/automation/template-workflow-evaluation.ts`：`scope === 'site'` 评测 `maxRequests` 下限从 `80` 提高至 `300`（`homepage` 提高至 `180`），覆盖既有任务的 `200` 历史配置，避免多页面、分页 `read layout` 与分批 `checkpoint` 后再核验后台或断点恢复时撞到 `200` 次请求上限。
   - `server/automation/template-analysis.ts`：`scope === 'site'` 参考分析 `maxRequests` 下限从 `80` 提高至 `240`（`homepage` 提高至 `120`）。

2. **动态内容与实现核验 SOP 顺序提醒**
   - `server/automation/template-workflow-evaluation.ts`：明确要求包含动态内容 `data` 或实现核验项的任务在 `submit` 前按需调用 `read(implementation)` 获取只读后台依据，减少临近配额上限时的试错提交。

## 兼容与升级说明

- 无数据库结构调整；已持久化的 `view-drafts:` 阶段草稿与历史请求计数全部保留。升级并重启后，已完成区块草稿保存的任务可继续只读核对实现并提交最终报告。
