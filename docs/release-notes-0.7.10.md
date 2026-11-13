# Kooboo AI Automation Lab v0.7.10 发布说明

发布日期：2026-11-14。基于 `v0.7.9` 将 AI Site 模板参考分析与独立评测的单轮 `maxOutputTokens` 上限提高至 `16384`（与集合分析保持一致），并进一步收紧每批 `checkpoint` 提交粒度，避免带推理过程的多检查项批次命中 `max_output_tokens`。

## 修复内容

1. **参考分析与独立评测单轮输出上限提升**
   - `server/automation/template-analysis.ts` 与 `server/automation/template-workflow-evaluation.ts`：在请求预算策略中显式设置 `maxOutputTokens: 16384`，为思维链推理及多检查项结构化 JSON 输出提供充裕余量。

2. **分批 Checkpoint 粒度进一步收紧**
   - `server/automation/template-workflow-evaluation.ts`：将评测 SOP 中每批 `read(checkpoint)` 的推荐提交数量从 `2 到 3 个 view-viewport` 收紧为 `1 到 2 个 view-viewport`，并与 `collection` 环节保持一致的 `16384 output_tokens` 口径说明。

## 兼容与升级说明

- 无数据库结构调整；升级重启后可继续恢复未完成的独立评测与生成任务。
