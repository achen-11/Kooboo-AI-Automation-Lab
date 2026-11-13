# Kooboo AI Automation Lab v0.7.5 发布说明

发布日期：2026-11-14。基于 `v0.7.4` 补充模板独立评测的耗时下限、双端 PNG 证据/动态数据校验 SOP 约束及精准报错定位。

## 修复内容

1. **独立评测阶段活动耗时下限扩展**
   - `server/automation/template-workflow-evaluation.ts`：将 `scope === 'site'` 评测决策累计计时下限从 `15` 分钟提高至 `30` 分钟（`scope === 'homepage'` 从 `8` 分钟提高至 `15` 分钟），避免多页多区块模板任务在恢复重跑后因历史累计耗时接近上限而被提前中断。

2. **评测校验报错精确定位与 SOP 硬约束明确化**
   - `server/automation/template-workflow-evaluation.ts`：
     - 目标选择器、检查项集合、证据存在性及双端 `reference` / `target` PNG 校验失败时，在错误信息中附带精确的 `pagePath / viewId / viewport / checkId / missingRole` 上下文，减少模型反复试错提交。
     - 在评测 SOP 中明确要求：先 `read(layout role='target')` 获取实际测量的目标 CSS 选择器；每个 `passed`/`failed` 检查必须附带当前页当前视口的 `reference` + `target` PNG；无法确认预期总数或全部记录标识的 `data` 清单项不得标为 `verified`。

## 兼容与升级说明

- 无数据库结构调整；升级重启后可直接恢复停留在 `evaluation` 或已完成停止确认的既有任务继续交付。
