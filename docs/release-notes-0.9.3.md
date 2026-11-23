# v0.9.3：修复未建站中断恢复死循环并升级经验库自检与护栏

本版本基于 `v0.9.2`（`fbbb81b`）发布，针对准备阶段发生瞬时网络断连后出现「人工点击恢复任务不重新建站、AI 跟进连续中断、经验复盘自我强化并锁住恢复」的排障问题完成全链路修复，并在启动期自动无感清理历史冲突经验。

---

## 核心改进

### 1. 未尝试建站任务恢复直达重新排队（[`server/automation/api.ts`](../server/automation/api.ts)）
- 在 `POST /api/automation/tasks/:id/resume` 中新增 `preCreateGeneration` 分支：对于 `kind === 'generation' && !generatedSiteId && !generation?.createAttempted && !generation?.deliveryId && !generation?.legacySubmitted` 的中断任务，人工恢复时不再绕行 AI 跟进，直接重置状态为 `queued` 重新执行建站准备。
- 保留原有冻结输入、规则快照与累计用量，清理旧 `followup.threadId`，并在旧跟进窗口已耗尽时自动开启新窗口以备后续真实异常使用。

### 2. Kooboo 只读预检接口瞬时断连短退避重试（[`server/automation/kooboo.ts`](../server/automation/kooboo.ts)）
- 新增 `isTransientKoobooReadError` 与 `koobooClient` 短退避重试（默认 `[500ms, 1500ms]`）：仅对幂等只读 GET 请求（`body === undefined`，如 `Domain/Available`、`Site/IsUniqueName`、`Site/IsSubdomainAvailable` 等）在遇到 `socket hang up` / `ECONNRESET` / `ETIMEDOUT` 等瞬时传输错误时自动重试，绝不重试 POST 变更请求或超时/主动取消请求。

### 3. AI 跟进传输断连隔离、事件保底与会话上下文修复（[`server/automation/worker.ts`](../server/automation/worker.ts)、[`autonomy.ts`](../server/automation/autonomy.ts)、[`followup.ts`](../server/automation/followup.ts)、[`followup-context.ts`](../server/automation/followup-context.ts)）
- **0 token 传输断连不计入决策次数**：在 `worker.ts` 新增 `isFollowupTransportDisconnect`，当跟进模型在 0 token、0 工具观察前发生传输断连时回退 `followup.attempts` 并单独累计 `transportFailures` / `consecutiveTransportFailures`；连续达到上限时以 `ai-model` 类别明确中断，避免空耗跟进次数误导后续排查。
- **`get_task` 保留关键状态迁移事件**：新增 `selectFollowupTaskEvents`，确保入队、首次 `socket hang up` 及人工恢复等关键事件不被大量低层工具日志挤出最近事件窗口，并在 `get_task` 补充 `diagnostics`（含 `createAttempted`、`manualResumeAfterInterrupt`、`transportFailures`）。
- **中断后人工恢复重置会话与上下文说明**：`prepareManualFollowupResume` 在上一次跟进决策为 `interrupt` 时重置 `followup.threadId` 并写入 `manualResume.afterInterrupt`，在跟进宿主提示词中明确标注人工恢复重新检查及未发起建站的事实状态。
- **中断详情空值安全保护**：[`frontend/src/views/automation/TaskExecution.vue`](../frontend/src/views/automation/TaskExecution.vue) 为 `data.interruption` 的数组字段补充可选链保护，避免部分字段缺失时触发组件渲染异常。

### 4. 经验库代际退役、语义冲突自检与中断复盘去重（[`server/automation/experience-store.ts`](../server/automation/experience-store.ts)、[`experience.ts`](../server/automation/experience.ts)、[`task-index.ts`](../server/automation/task-index.ts)）
- **跟进经验代际（`runtimeEpoch`）自动退役**：在 `shared/experience.ts` 为 `Experience` 增加 `runtimeEpoch?: number`（`FOLLOWUP_RUNTIME_EPOCH = 1`）。服务启动初始化 `ExperienceStore` 时执行幂等升级检查（不按固定 UUID 硬编码、不物理删除数据、跳过最新修订为人工编辑的条目）：
  - 纯 `followup` 阶段的旧版 AI 经验通过 `actor: 'system'` 新修订自动置为 `enabled: false`（不设 `manualDisabled: true`，保留历史版本供人工按需恢复）；
  - 同时包含 `followup` 与 `generation` / `evaluation` 的跨阶段 AI 经验仅移除 `followup` 阶段标签并保留其余阶段经验；
  - [`frontend/src/views/automation/ExperiencesView.vue`](../frontend/src/views/automation/ExperiencesView.vue) 版本历史兼容展示 `system` 操作者。
- **Kooboo 域名规则语义冲突自检迁移**：新增 `auto_experience_migrations` 表记录一次性规则 `kooboo-subdomain-hyphen-conflict-v1`，自动停用仍启用的非人工经验中与 `shared/kooboo-domains.ts`（仅允许 `[a-z0-9_]`、禁止连字符 `-`）直接矛盾的建议。
- **宿主硬契约护栏注入**：在经验筛选、经验复盘及流程跟进宿主提示词中注入 `PLATFORM_HARD_CONTRACTS`，明确 Kooboo 命名规则、`!generatedSiteId && !createAttempted` 语义及冲突裁决原则。
- **中断复盘按真实执行进度指纹去重**：新增 `interruptionReflectionProgressKey`，对无独立报告的重复中断若真实执行进度未变化，直接记为跳过复盘，避免无效复盘自我强化并阻塞工作流恢复（人工点击复盘仍可强制发起）。
