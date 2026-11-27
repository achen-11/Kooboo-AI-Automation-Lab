# Kooboo AI Automation Lab v0.9.15 发布说明

发布日期：2026-11-27

## 核心变更

### 1. 修复已确认失败生成任务点击「恢复任务」陷入 Followup 原地 `interrupt` 死循环（`P18`）
- 在 `server/automation/api.ts` 的 `POST /api/automation/tasks/:id/resume` 新增 `failedGenerationContinuation` 直排续跑分支：对已准备（`prepared=true`）、已接受发送（`deliveryState="accepted"`）、无待输入调用（`pending=null`）、终态已确认为 `failed`/`interrupted` 且非 `413` 超载、非 `site-template`、非优化规划态的生成任务，点击「恢复任务」直接写入 `generation.next`（`action="continue"`，附带 `retryOf`）并将任务置为 `queued` 续跑（按需开启新一轮 Followup 预算窗口并保留累计用量），不再回流 Followup 空转。
- 严格保留 `413` 超载会话走「换新会话继续」、`site-template` 走既有重试护栏契约，以及 `deliveryState="sending"`、挂起 `pending` 与取消重启的安全边界。

### 2. 为非 `413` 失败生成会话暴露次级「换新会话继续」按钮
- 在 `shared/task-presentation.ts` 新增 `canSwitchGenerationConversation`，并通过 `TaskSummary`、`server/automation/api.ts`（`/sections/execution`）及 `server/automation/store.ts`（启动索引自动回填）同步透出 `canSwitchConversation`。
- 在 `frontend/src/views/automation/TaskRecoveryActions.vue` 中，当主恢复按钮为「恢复任务」且任务满足换新会话条件时，紧随其后展示次级按钮「**换新会话继续**」，点击直接调用 `/generation-context/handoff`，保留当前站点与全部资料开启干净新会话。

### 3. Followup 人工恢复同 `runId` 防原地中断护栏
- 在 `shared/automation.ts`（`FollowupManualResume`）与 `server/automation/autonomy.ts`（`prepareManualFollowupResume`）中记录恢复前的 `previousRunId` 与 `previousDeliveryId`。
- 在 `server/automation/followup.ts` 的 `validateFollowupAction` 与人工恢复 Prompt 中增加护栏：当仍走 Followup 的人工恢复首轮查得 `inspect_execution` 返回的仍是同一历史失败 `runId` 且会话可发送（`canSend !== false`、无 `pending`、无 413/鉴权/源站/冲突/待输入硬阻断）时，禁止直接再次 `interrupt`。
- 在 `.agents/skills/diagnostic-triage/references/known-patterns.md` 沉淀脱敏故障模式 `P18`。

### 4. 批量跨环境交付列表过滤不可交付站点（`80d5245`）
- 在 `frontend/src/views/automation/SiteDeliveryList.vue` 的批量交付模式中过滤掉不支持跨环境交付的站点，并更新 `tests-node/site-delivery-list-component.test.mjs` 回归测试。

## 验证结果
- 针对性测试通过：
  - `tests-node/budget-recovery.test.ts` 与 `tests-node/task-recovery-component.test.mjs`：27 项全部通过（0 失败）。
  - `tests-node/followup.test.ts` 与 `tests-node/automation-todos.test.ts` 相关回归（`manual resume clears the historical retry guard`、`validateFollowupAction blocks immediate interrupt on identical previousRunId`、`general upgrade generation task hitting 413`）：3 项全部通过（0 失败）。
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（退出码 0）。
- `npm run build`（Vite 前端生产构建与服务端编译）：通过（退出码 0）。
