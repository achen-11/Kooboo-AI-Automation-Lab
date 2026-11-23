# v0.9.1：首次生成冷加载恢复、HTTP 压缩传输与批量上下文读取优化

本版本为 `v0.9.0` 的维护优化版，聚焦解决诊断包中暴露的**首次生成桥接冷加载长时间干等、异常跟进重复撞超时、跨区拉取长会话传输慢，以及上下文碎步读取轮次过多**四类平台侧耗时瓶颈。无需修改 Kooboo 服务端即可生效。

---

## 核心改进

### 1. 首次生成桥接冷加载分段超时与页内刷新恢复（[`generation-session.ts`](../server/automation/generation-session.ts)）
- **分段等待与自动刷新**：将原有的 `page.goto(120s) + waitForFunction(180s)` 单段干等改造为分段超时（默认 `gotoTimeoutMs = 45s`、`readyTimeoutMs = 45s`、`retryReadyTimeoutMs = 60s`、`maxReloads = 2`）。
- **按页面状态分流处理**：
  - 打开后若跳转到非 `/_admin/ai-chat` 路径（如登录失效跳转登录页），立刻按登录令牌异常快速失败，不再等待 3 分钟。
  - 若 `__koobooAutomation` 桥接尚未挂载，保留当前浏览器缓存直接在页内 `page.reload()` 重试，避免耗尽近 5 分钟后将整轮退回 Followup 再重新走一遍恢复流程。
  - 若桥接已挂载但会话仍在初始化，则不刷新页面、记录进度事件后直接续等下一时间段。

### 2. Kooboo 客户端透明 HTTP 压缩传输（[`kooboo.ts`](../server/automation/kooboo.ts)）
- `httpRead` 请求头默认携带 `Accept-Encoding: gzip, deflate, br`，按响应 `Content-Encoding` 透明解压 `gzip` / `x-gzip` / `deflate` / `br`（`204` / `304` 状态码跳过解压直接返回空响应）。
- 解压流继续严格执行 `limit` 解压后字节预算上限与单次 settle 错误收敛，显著降低跨区拉取 `AIConversation/GetMessages` 等大 JSON 时的传输耗时。

### 3. Followup 中 `get_conversation` 超时防连撞保护（[`followup.ts`](../server/automation/followup.ts) & [`failure-playbook.md`](../harness/followup/references/failure-playbook.md)）
- 在单次 `executeFollowup` 轮次内记录已超时的会话标识：首次调用 `get_conversation` 因远端会话过大或网络超时失败时返回明确指导，同轮内再次尝试调用 `get_conversation` 将被立即拦截，防止连续触发 120s HTTP 超时浪费跟进时间窗口与模型轮次。
- 同步在《常见故障判断与处置手册》中补充指引：当 `get_conversation` 因超大消息体超时而 `inspect_execution` 已返回明确终态时，直接依据 `inspect_execution`、`get_task` 与 `probe_site` 证据决策。

### 4. 批量上下文读取 `automationBatch` 与只读编排 / 精简思考提示（[`generation-context.ts`](../server/automation/generation-context.ts)）
- 将上下文阅读器升级至 `generationContextReaderVersion = 6`，新增 `automationBatch(requests)`：支持单次 `run_kscript` 聚合最多 `12` 项 `materials` / `read` / `summary` / `materialRead` 请求（单批总返回上限 `12,000` 字符，超限通过 `nextIndex` 分页续读），单项缺失或二进制材料错误隔离在单条 `ok: false` 结果中而不中断整批。
- 在 `kfile` 生成委托指令中补充：
  - 优先使用 `automationBatch` 减少零碎 `run_kscript` 往返；
  - 多步只读探测与准备工作（如批量 `list_site_object`、参考 Sandbox 建立与源码结构提炼、批量 `image_resize`）可在单个 `run_kscript` 中通过 `k.ai.callFunction(name, args)` 编排执行，但最终写站对象（`create_page` / `create_style` / `create_script` / `update_text_object`）、`run_skill_script`（Preflight）与预览诊断必须继续走标准工具调用以保证平台 Completion Ledger 账本准确；
  - 写站前精简 `<reasoning>` 思考，禁止在思考文本中逐字默写整份 CSS / HTML / JS 后再写工具参数。
