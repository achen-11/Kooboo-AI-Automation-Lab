# Kooboo AI Automation Lab v0.7.9 发布说明

发布日期：2026-11-14。基于 `v0.7.8` 修复独立评测进程中断或重启后，已停止的 `evaluation:<taskId>` 孤立模型请求预占（`state='active'`）未能转为 `retained` 而持续阻塞后续恢复的问题。

## 修复内容

1. **已停止独立评测任务的孤立模型请求预占保留**
   - `server/automation/request-budget.ts`：新增共享函数 `retainAccountReservations(db, accountId, runKey?)`，在确认执行已停止后将该账号下未结算的 `active`/`unknown` 预占转为 `retained`，保留其保守 token 扣减与请求次数计数。
   - `server/automation/budget-recovery.ts`：`retainStoppedFollowupReservations` 在 `followup` 与 `planning` 之外同步覆盖 `evaluation:<taskId>`（`stage = 'evaluation'`），使手动/接口调用 `POST /api/automation/tasks/:id/resume` 可直接解除原已停止评测的并发预占阻塞。
   - `server/automation/store.ts`：`recover()` 在服务重启后自动续接已确认停止的 AI Site 模板评测时，以及 `server/automation/worker.ts` 在跟进决策执行 `retry` 评测前，均同步保留孤立评测预占并记录审计事件，避免恢复后立即命中 `同一预算仍有模型请求执行中`。

## 兼容与升级说明

- 无数据库结构调整；原有 `auto_model_requests` 中的孤立预占在 `POST /resume`、服务重启自动恢复及跟进重试时按保守预估值转为 `retained`，不清零历史额度、不取消未知用量标记。
