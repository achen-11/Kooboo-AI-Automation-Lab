# Kooboo AI Automation Lab v0.9.14 发布说明

发布日期：2026-11-26

## 核心变更

### 1. 无人值守建站禁止收尾询问浏览器视觉验收（源头止血）
- 在 `server/automation/site-ui-rules.ts` 与 `harness/generation/references/site-ui-rules.md` 新增无人值守验收边界约束：页面落盘且基础检查通过后直接汇报结束，严禁调用 `ask_user_input` 询问是否允许打开浏览器或页面进行视觉验收（双端视觉检查由后续独立评测或人工接管）。
- 同步在 `CONTINUATION_REMINDER` 中追加同等收尾防回归提示，确保长度保持在校验预算内。

### 2. Followup 自动识别并收尾非阻塞浏览器视觉验收确认
- 在 `server/automation/followup.ts` 新增 `isBrowserVerificationConfirmAskUserInput`：精确匹配“页面已生成、仅在收尾询问是否允许打开页面/浏览器做视觉检查”的 `ask_user_input(kind="confirm")`，同时严格排除参考站失败决策、`kind="upload"`、以及删除/发布/支付/账号等敏感或破坏性确认。
- 在 `validateFollowupAction` 中拦截针对此类收尾确认的 `interrupt`，并同步更新 `executeFollowup` 提示词、`harness/followup/SKILL.md`、`harness/followup/references/failure-playbook.md` 与 `shared/automation.ts` 默认 Followup SOP：核实页面已落地后直接通过 `answer`（`confirmed: false, kind: "confirm", value: false`）推动 Kooboo 结束本轮并流转评测/交付。

### 3. UI 恢复动作对齐 `ask_user_input` 挂起态并支持 `confirm` 快捷提交（`P17`）
- 在 `shared/task-presentation.ts`、`server/automation/store.ts`、`server/automation/api.ts` 与 `server/automation/workflow-graph.ts` 暴露 `canAnswerPendingInput` 与 `'answer-pending-input'` 恢复动作，避免在等待回答 `ask_user_input` 时仍把主恢复按钮显示为「恢复任务」而陷入 Followup 空转。
- 在 `frontend/src/views/automation/TaskRecoveryActions.vue`、`TaskDetail.vue`、`TaskExecution.vue` 与 `TaskWorkflowGraph.vue` 将主按钮升级为「**回答 AI 确认**」并直接打开回答窗口（同时隐藏相邻重复入口）。
- 在 `shared/supplement.ts`、`server/automation/supplement.ts`、`server/automation/supplement-api.ts` 与 `TaskSupplementDialog.vue` 新增 `confirmDecision?: boolean` 支持：`kind="confirm"` 场景可直接在弹窗选择「同意并继续」或「跳过 / 拒绝并继续」提交（无需强迫填写非空备注或上传文件），提交后清理 `generation.pending` 并立即入队续跑。
- 在 `.agents/skills/diagnostic-triage/references/known-patterns.md` 沉淀脱敏故障模式 `P17`。

## 验证结果
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（0 错误）
- 针对性测试集（`site-ui-rules`、`task-supplement`、`task-recovery-component`、`task-detail-refactor-component`、`workflow-graph`、`workflow-graph-component`、`site-delivery`、`site-delivery-list-component` 共 61 个用例，以及 `followup.test.ts` 中 `host validation` 用例）：全部通过
- `npm run build`（Vite 前端生产构建与服务端编译）：通过
