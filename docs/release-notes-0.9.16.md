# Kooboo AI Automation Lab v0.9.16 发布说明

发布日期：2026-11-27

## 核心变更

### 1. 新增「强制交付」与异常交付人工核查后「强制重发」入口
- **人工初步验收强制交付（`force: true`）**：在生成/评测任务处于 `interrupted` / `failed` / `cancelled` 或未通过 `requirePassed` 门禁、但生成站已具备可访问地址时，支持经人工确认后跳过完成态与评测门禁直接排队跨环境交付（保留源站与硬性安全约束，标记 `delivery.forced = true`；强制交付完成后站点列表状态收敛为 `generated`）。
- **多端统一入口与防误触确认**：
  - 修复 `GET /api/automation/tasks/:id/sections/delivery` 在存在中断且无报告子评测时掩盖已完成生成任务的问题；`/summary` 同步暴露 `canForceDeliver` 与 `forceDeliverTaskId`。
  - 在任务详情页（头部与「更多」菜单弹窗确认）、交付页（内联确认与「人工强制交付」标签）及任务中心批量选择栏（内联确认）提供强制交付入口；常规「一键交付」筛选与 `deliverableCount` 口径保持不变。
- **异常交付核查后手动强制重发**：
  - 支持对已停止且无目标回执的 `uncertain` / `failed` 交付（含服务崩溃通过 `recover()` 恢复为无 `attemptedAt` 的 `uncertain` 场景）提供「已核查未建站，强制重发」二次确认入口，清除 `attemptedAt` 后重新入队。
  - `inspectTaskDeliveryEligibility`、`POST /delivery/retry { force: true }` 与 `AutomationWorker` 交付队列拾取均强制校验当前任务自身已确认停止且非运行中状态。
- **跨区迁移异常详情保留**：`executeDelivery` 新增 `formatFetchError` 递归提取并脱敏 `fetch` 底层 `error.cause`（如 `UND_ERR_SOCKET: other side closed`），提升排障可定位性。

### 2. 跨环境交付前清理 `/screenshots` 临时截图及截断安全保护（`6795b38` + 本次修复）
- 迁移前自动扫描并清理 Kooboo 媒体库 `/screenshots` 下未被页面引用的临时截图，避免无谓拉大站点导出包体积。
- 当遍历触发深度上限（`depth >= 8`）或目录数上限（`200`）截断时，记录未扫描子树并保护整条祖先链路不被误删，仅清理已确认无引用的图片与完整扫描干净的子目录。

### 3. 生成质量规则与无人值守 Followup 护栏增强（`6795b38`、`db026cc`）
- 加强参考站 UI 保真度、图片 `aspect-ratio` 防变形约束与禁止编造画廊规则。
- 扩展多语言 `P17` 浏览器验收确认与参考站 Sandbox 清理确认护栏，并在 `validateFollowupAction` 的 `answer` 分支对浏览器视觉验收确认同步强制要求 `confirmed === false`。

### 4. 非模板自动优化任务「换新会话继续」状态恢复与并发保护
- `/generation-context/handoff` 对非模板自动优化任务（含根任务与修复子轮次）同步恢复 `root.optimization.state` 并清除 `stoppedAt`，避免切换新会话后优化闭环中断。
- 在异步调用 Kooboo `AIConversation/List` / `Create` 前后通过事务重读最新任务状态并校验活动交付与同站并发状态，防止并发强制交付被过期快照覆盖。

## 验证结果
- 针对性测试全部通过（67 项通过，0 失败）：
  - `tests-node/auto-delivery.test.ts`、`tests-node/delivery-diagnostics.test.ts`、`tests-node/site-delivery.test.ts`、`tests-node/site-delivery-list-component.test.mjs`、`tests-node/task-delivery-component.test.mjs`、`tests-node/task-detail-refactor-component.test.mjs`、`tests-node/task-recovery-component.test.mjs`：65 项通过。
  - `tests-node/automation-todos.test.ts`（`general upgrade generation task hitting 413...`）与 `tests-node/followup.test.ts`（`isReferenceSandboxCleanupConfirmAskUserInput...`）：2 项通过。
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（退出码 0）。
- `npm run build`（Vite 前端生产构建与服务端编译）：通过（退出码 0）。
