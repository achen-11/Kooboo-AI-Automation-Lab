# Kooboo AI Automation Lab v0.7.3 发布说明

发布日期：2026-11-14。基于 `v0.7.2` 修复模板逐项评测阶段的 `8192 output_tokens` 截断死循环与 `prepare` 阶段断点恢复路径问题。

## 修复内容

1. **逐项评测增量分批 SOP 与超限会话自动重置**
   - `server/automation/template-workflow-evaluation.ts`：
     - 将评测 SOP 从“一次批量审查所有页面/view/双端”改为**按页面与视口分批增量审查**，明确告知上游单轮 `8192 output_tokens` 上限，要求每次 `read checkpoint` 仅提交 `2–3` 个 `view-viewport` 的简练结论（体量不超过 `4KB`），跳过 `context.draftViews` 已保存项并在全部保存后以 `views: []` 提交汇总。
     - 当模型决策因 `max_output_tokens`、`automation_request_too_large` 或 `context_length_exceeded` 失败时，自动清空已膨胀的 `template-evaluation-thread:<taskId>` 会话绑定，同时保留已持久化的 `view-drafts:` 阶段草稿，确保后续恢复从干净短会话增量续跑。

2. **AI Site 模板 `prepare` 阶段直接断点恢复**
   - `server/automation/api.ts`：`POST /api/automation/tasks/:id/resume` 针对携带 `templateWorkflow` 且仍处于 `stage === 'prepare'`、尚未建站与发出的模板生成任务（`!generatedSiteId && !createAttempted && !deliveryId && !legacySubmitted`），直接刷新跟进策略并将原任务重新入队执行参考分析，避免被历史 `followup` 旧报错再次拦截中断，同时保留原有固定输入、已采集截图与累计费用统计。

## 兼容与升级说明

- 无数据库结构调整；升级重启后可直接恢复停在 `evaluation`（`max_output_tokens`）或 `prepare` 的既有模板任务，继续复用已保存站点与参考/目标截图。
