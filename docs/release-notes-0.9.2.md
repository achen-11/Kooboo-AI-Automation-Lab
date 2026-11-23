# v0.9.2：跨环境迁移请求对齐 `__engine_timeout__` 参数

本版本基于 `v0.9.1`（`5d414f5`）发布，针对 DE 服务器跨环境迁移排障中定位的 Kooboo 脚本引擎与平台客户端超时不一致问题，在平台侧发起迁移请求时自动透传 `?__engine_timeout__=<timeoutSeconds>` 参数。

---

## 核心改进

### 1. 迁移请求自动对齐 `__engine_timeout__`（[`server/automation/delivery.ts`](../server/automation/delivery.ts)）
- 新增 `deliveryRequestUrl(endpoint, timeoutSeconds)` 辅助函数并在 `executeDelivery` 中调用：
  - 以当前连接/任务冻结的 `delivery.policy.timeoutSeconds`（默认 **180 秒**，非正数或非法数值回退至 `180`）作为目标时限。
  - 若目标 `endpoint` URL 尚未包含非空的 `__engine_timeout__` 查询参数，则自动追加 `?__engine_timeout__=<seconds>`，并完整保留已有的其他查询参数。
  - 若 `endpoint` 已显式指定非空 `__engine_timeout__`（如 `?__engine_timeout__=300`），则尊重显式配置不覆盖。
  - 仅作用于实际 `fetch` 请求地址，不改写持久化保存的 `delivery.policy.endpoint`，避免影响同一连接的策略一致性校验与既有展示。
- 客户端 `AbortSignal.timeout(timeoutSeconds * 1000)` 同步使用规范化后的 `timeoutSeconds`，与 `__engine_timeout__` 保持一致。

### 2. 排障分析文档与单元测试补充
- 新增排障分析文档 [DE 服务器跨环境迁移失败分析报告](de-delivery-failure-analysis-2026-11-23.md)，记录本次排障包（`ced6df2c-7681-4bfb-8977-c25107f9ed1c`）的时间线、Kooboo 源码双层超时对照（Jint 引擎默认 60 秒 vs `k.net.url` 硬编码 45 秒 vs `k.net.httpClient.send` 显式超时）以及后续配合建议。
- 在 [`tests-node/delivery-diagnostics.test.ts`](../tests-node/delivery-diagnostics.test.ts) 新增 `deliveryRequestUrl` 边界用例及 `executeDelivery` 本地模拟服务端到端请求校验（验证默认 `180`、自定义 `240` 及 `policy.endpoint` 保持原值）。

---

## 配合说明（DE 服务端）

- Kooboo 站点在请求级同时受 **Jint 引擎超时（`__engine_timeout__`，默认 60 秒）** 与脚本内部 HTTP 客户端超时（`k.net.url` 硬编码 45 秒 / `k.net.httpClient.send` 显式 `timeout` 参数）约束。
- 平台侧 `v0.9.2` 已默认传入 `?__engine_timeout__=180`；DE 端 `launch.kooboo.nl` 上的 `sitemigrate` 脚本需同步改用 `k.net.httpClient.send` 并读取 `__engine_timeout__` 设置下游 HTTP 超时，才能使整条迁移链路的超时上限完全对齐。
