# Kooboo AI Automation Lab v0.7.4 发布说明

发布日期：2026-11-14。基于 `v0.7.3` 完善模型上下文预算受限时的会话自动解绑与整站模板多轮运行空间。

## 修复内容

1. **统一工作流会话重置规则（覆盖 `ModelBudgetExceeded` 与无进展循环）**
   - `server/automation/template-workflow-store.ts`：新增共享判定函数 `shouldResetWorkflowThread`，统一识别 `ModelBudgetExceeded`、`剩余预算不足以接收本次上下文`、`累计模型 token 已达到预算上限`、`本次 Agent 已达到模型请求次数上限`、`无进展循环` 及 `max_output_tokens` / `automation_request_too_large` / `context_length_exceeded`。
   - `server/automation/template-workflow-evaluation.ts` 与 `server/automation/template-analysis.ts`：任一受限失败都会自动解绑膨胀或卡死会话，保留已保存的 `view-drafts:` / `analysis-views:` 检查点与已采截图，后续恢复自动进入全新干净会话。

2. **整站模板分析与评测模型预算下限及按页看图约束**
   - `server/automation/template-analysis.ts` 与 `server/automation/template-workflow-evaluation.ts`：为 `scope === 'site'` 阶段保障至少 `15,000,000` token 上限（`scope === 'homepage'` 至少 `10,000,000`），避免多页多图站点因旧任务或历史重试累计预占触发上下文准入阻塞。
   - `server/automation/template-workflow-evaluation.ts`：在评测 SOP 中明确要求**按页面逐个读取 layout 与关键 PNG**（避免单次加载全站全部截图导致每轮图片上下文乘倍膨胀）。

## 兼容与升级说明

- 无数据库结构调整，历史请求计量与账本记录完全保留；升级并重启服务后，可继续恢复既有 `evaluation` / `prepare` 任务完成验收。
