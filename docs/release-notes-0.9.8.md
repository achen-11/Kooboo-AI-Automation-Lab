# v0.9.8：源站克隆失败多跳自动路由、显式跳过与资料包降级协同，以及克隆失败零 Token 止损

本版本基于 `v0.9.7`（`9a85ab9`）发布，围绕 `upgrade`（旧站升级）在跨区环境下克隆原内容站返回 `0` 页的问题，完成**跨环境链式自动路由（如 `德国 -> 香港 -> 厦门`）、任务创建级「跳过原站克隆 / 克隆失败自动降级用资料包继续」分层策略，以及确认克隆失败后的零 Token 终态止损（彻底阻断无意义的 Followup 重试与 Experience 复盘消耗）**。

---

## 核心改进

### 1. 源站克隆失败多跳自动回退环境路由（`cloneFallbackEnvironmentId`）
- **环境级回退链配置**：[`SettingsView.vue`](../frontend/src/views/SettingsView.vue)、[`validation.ts`](../server/lib/validation.ts) 与 [`vault.ts`](../server/lib/vault.ts) 支持为每个 Kooboo 环境配置「克隆失败自动回退环境（`cloneFallbackEnvironmentId`）」，并在保存时严格校验自引用、不存在目标与循环引用（如 `A -> B -> A`），同时支持多跳无环链式路由（如 `德国 -> 香港 -> 厦门`）。
- **自动清理空站与多跳无缝切换**：[`generator.ts`](../server/automation/generator.ts) 与 [`store.ts`](../server/automation/store.ts) 在当前环境克隆原内容站（含 `Transfer/ByLevel` + 1 次 `Transfer/Single` 降级，或角色对调 `AISandbox/TransferByLevel`）仍返回 `0` 页时，先预检回退环境域名与模板 Sandbox 能力，通过后自动调用 `Site/Delete` 清理原环境 0 页空站、解除本地旧绑定、记录 `attemptedEnvironmentIds` 与 `cloneEnvironmentFallback` 审计轨迹，并切换至回退环境重新建站与克隆。
- **人工恢复兼容**：[`api.ts`](../server/automation/api.ts) 对已因 0 页克隆中断的历史任务，在配置回退环境后点击「恢复任务」会先核查原站点是否已手动导入页面，若仍为 `0` 页则直接触发跨环境回退切换，不重复在原环境空跑 `Transfer/Single`。

### 2. 「跳过原站克隆」与「自动路由回退」的四级无冲突优先级
在 [`CreateTaskDialog.vue`](../frontend/src/views/automation/CreateTaskDialog.vue)、[`api.ts`](../server/automation/api.ts)（`POST /api/automation/tasks`）、[`store.ts`](../server/automation/store.ts) 与 [`generator.ts`](../server/automation/generator.ts) 落地分层策略：
1. **优先级 1 — 显式跳过原站克隆（`skipSourceTransfer: true`）**：创建任务时若显式勾选或通过 API 传参 `skipSourceTransfer: true`，直接通过 `Site/Create`（或 `Template/Use`）创建空白目标站并导入资料包生成，**不调用 `Transfer/ByLevel`，也不触发跨环境回退路由**。
2. **优先级 2 — 原环境克隆 → 自动链式路由回退环境**：未勾选跳过时，优先在所选环境克隆；`0` 页时自动沿 `cloneFallbackEnvironmentId` 链式路由至下一环境重试克隆。
3. **优先级 3 — 克隆最终仍为 0 页时自动降级用资料包继续（`fallbackToMaterialsOnCloneFailure: true`）**：当任务随附离线资料文件（`files.length > 0`）且开启该选项时，若所有已尝试环境均返回 `0` 页，自动转为 `skipSourceTransfer: true` 并使用随附资料包在当前目标站继续生成，不中断停机。
4. **优先级 4 — 终态止损中断**：未开启自动降级（或无离线资料文件）时，所有环境尝试完毕仍为 `0` 页则立即以 `source-access` 终态中断。

### 3. 确认克隆失败后的零 Token 终态止损与建站错误透传
- **全链路阻断克隆失败后的模型调用**：
  - [`autonomy.ts`](../server/automation/autonomy.ts) 新增 `isConfirmedCloneFailure()`，在 `isAutonomousRetry()` 中对已确认的 0 页克隆失败直接返回 `false`。
  - [`worker.ts`](../server/automation/worker.ts) 与 [`followup.ts`](../server/automation/followup.ts) 在 `recoverTask`、`autonomousRecovery`、`runFollowup` 与 `validateFollowupAction` 中硬拦截已确认的克隆失败，禁止排入 Followup 或提交 `action="retry"`。
  - [`experience.ts`](../server/automation/experience.ts) 在 `queueReflection()` 中对准备阶段源站克隆失败及前置预检中断直接标记为 `跳过复盘`，避免在零模型执行的准备阶段中断后自动启动 Codex `experience` 复盘会话空耗数十万 tokens。
  - [`experience-store.ts`](../server/automation/experience-store.ts) 新增启动幂等迁移 `prepare-clone-zero-page-conflict-v1`，自动停用旧版从准备阶段 0 页克隆中断沉淀的 AI 经验，消除后续任务在 `selectExperience` 阶段的额外筛选调用。
- **补齐缺失 `transferTaskId` 终态拦截与建站错误详情**：
  - [`generator.ts`](../server/automation/generator.ts) 放开 `!taskId` 分支的 `Transfer/Single` 单页降级并在仍为 `0` 页时统一走回退环境或抛出 `zeroPageTransferError`（`FollowupRuntimeError`），不再抛 `Pending` 回流 Followup。
  - [`kooboo.ts`](../server/automation/kooboo.ts) 新增 `extractKoobooErrorDetail()`，在建站或接口调用返回非 2xx 时提取可读错误正文写入任务事件与异常提示。

---

## 验证记录
- **类型检查、针对性单测与构建**：`npm run check`、`npm run build` 及 `tests-node/clone-environment-fallback.test.ts`（9 项）、`tests-node/harness-and-diagnostics.test.ts`、`tests-node/automation-learning.test.ts`、`tests-node/transfer-wait.test.ts` 全部通过。
- **真实三跳链式路由验证（`德国 -> 香港 -> 厦门`）**：
  - 使用在德国与香港服务器均无法抓取的 `http://www.defrieseschaar.nl`（参考站 `https://1cc69a8797e0460ca333852a88ec375e.devday.cn`）在德国环境发起真实 `upgrade / homepage` 任务（`ba8a31f5-0591-4d97-894a-f0a2b401b5ef`）；
  - 系统在德国克隆 `0` 页后自动清理德国空站并切换至香港（`seq=50925`），在香港克隆 `0` 页后自动清理香港空站并切换至厦门（`seq=50932`），在厦门仅耗时 12 秒成功克隆原站（`pages: 1, images: 65`，`seq=50936`）并完成 22 份资料包上传与生成投递（`seq=50960`）。
