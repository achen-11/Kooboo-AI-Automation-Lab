# v0.8.3：Kooboo GUID 校验兼容与迁移失败诊断留存修复

本版本基于 `v0.8.2`（`07105f2`）发布，合并修复了 HK→DE 实测与真实排障包排查中定位到的两类问题；**无需修改 Kooboo 服务端即可生效**。

## 问题根因

1. **Kooboo 非 RFC 4122 GUID 被 Zod `z.string().uuid()` 误拒（`Invalid UUID`）**：
   - Zod v4 的 `z.string().uuid()` 严格校验 RFC 4122 版本位（第 3 段首位 `[1-8]`）与变体位（第 4 段首位 `[89abAB]`）。
   - Kooboo 使用标准 .NET GUID 作为站点 / 模板 / 会话标识（例如 `1adbf7f5-d119-0a84-53bb-2ecddb7d9ff1`、`e3f7e688-16dc-c31f-21e7-0a8ed5899dfd`、`7b788f38-93d0-fbd5-ad79-a9aac09be3b6`），约 7/8 概率不满足 RFC 4122 位约束。因此即使 DE `POST https://launch.kooboo.nl/api/sitemigrate` 已成功创建目标站并返回 HTTP 200 回执，平台本地解析与人工补录回执仍会误报 `Invalid UUID` 并进入 `uncertain`；同类校验也影响站点绑定、模板引用与问题交接接口。
2. **迁移接口失败缺少诊断留存，且 `Bearer` 脱敏正则会破坏序列化 JSON**：
   - 跨环境迁移接口返回非 2xx（如 HTTP 500 / 502）或异常 HTTP 200 回执时，旧版 `executeDelivery` 仅保留状态码而丢弃响应体、链路头与耗时且不写失败事件，无法区分 DE 服务端异常、上游超时还是反代故障（例如 48.95s 后返回 HTTP 500 的历史排障包只能看到状态码）。
   - 同时，`server/app.ts` 与 `server/background-entry.ts` 中 `AutomationStore` 的脱敏正则 `Bearer\s+[^\s"',;]+` 未排除反斜杠 `\`，在 `JSON.stringify` 转义文本中出现 `Bearer ...\"` 时会连同转义符一并替换，造成持久化的 JSON 损坏。

## 主要改进

### 1. Kooboo `siteId` / `templateId` / `sessionId` 校验改为 `z.guid()`
- [`server/automation/delivery.ts`](../server/automation/delivery.ts)：`receiptSchema.siteId` 由 `z.string().uuid()` 改为 `z.guid()`，同时兼容自动迁移回执解析与人工补录回执。
- [`server/automation/api.ts`](../server/automation/api.ts)：更新 `optionalTemplateId`、`POST /api/automation/sites` 的 `siteId` 以及 `GET /api/automation/kooboo/templates/:templateId` 参数校验为 `z.guid()`。
- [`server/app.ts`](../server/app.ts)：更新 `/api/evaluations/:id/issue-handoffs` 与 `/api/evaluations/:id/issue-handoffs/:handoffId/receipt` 的 `siteId` / `sessionId` 为 `z.guid()`。

### 2. 跨环境迁移失败留存有界脱敏诊断与事件记录
- [`server/automation/delivery.ts`](../server/automation/delivery.ts)：
  - 当 `sitemigrate` 返回 `!response.ok` 时，按 **16 KiB** 与 **5 秒** 上限流式读取响应体，剥离 HTML `<script>` / `<style>` 与标签并提取标题/正文、折叠空白并脱敏（复用 `exportRedactor`，隐藏模型密钥、Kooboo 令牌、迁移令牌、`Bearer` 凭据及 URL 查询参数密钥）。
  - 提取常见链路追踪响应头（`x-request-id`、`x-correlation-id`、`cf-ray`、`traceparent`、`x-trace-id`、`x-amzn-requestid`）、`content-type` 与请求总耗时；精简摘要写入 `delivery.error`（≤300 字符摘要），完整脱敏诊断与事件明细写入任务事件日志（≤2000 字符摘要）。
  - 对 HTTP 200 但回执超长或 JSON/GUID 校验失败、以及网络/超时异常同样记录耗时、链路头与脱敏摘要事件，同时保持原有 `uncertain` 停机保护与禁止自动重发语义不变。

### 3. 修复 `Bearer` 脱敏正则破坏 JSON 转义字符串的问题
- [`server/app.ts`](../server/app.ts) 与 [`server/background-entry.ts`](../server/background-entry.ts)：将 `store` 脱敏正则更新为 `Bearer\s+[^\s"',;\\]+`，与 `server/diagnostics/redact.ts` 保持一致，避免嵌套序列化 JSON 中的 `\"` 转义被误伤。

## 兼容与升级说明

- **无需升级 Kooboo 服务端或调用方即可生效**。
- 请通过原安装目录的 `npm start` 启动，在侧栏版本号或「系统设置 → 检查更新」中检查并安装更新；既有配置、数据与凭证均保留。

## 验证边界

- 自动化测试新增 [`tests-node/delivery-diagnostics.test.ts`](../tests-node/delivery-diagnostics.test.ts)，与核心 Node 回归测试、Python 交付打包测试、`npm run check` 及 `npm run build` 一并在 `v0.8.3` 干净发布工作树中通过。
- 实测边界：在发布前已于同一研发环境完成真实 HK → DE 端到端链路验证（包含清岚单页经 GUID 修复及 `/delivery/receipt` 补录后完成 DE `verifyDelivery` 全部 5 项核验，以及用排障包 8.05 MiB `kooboo-site.zip` 实导入 HK 后 4.93s 成功迁移至 `*.kooboo.nl`）；但**未执行**目标用户机器上的实机在线自动更新流程。详情见 `docs/release-validation-0.8.3.md`。
