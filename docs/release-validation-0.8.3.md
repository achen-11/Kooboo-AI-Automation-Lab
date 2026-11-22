# v0.8.3 验证记录

日期：2026-11-22。

基线为 `v0.8.2`（`07105f2b055931065293656757be25e7de86a909`），合并修复 Kooboo 非 RFC 4122 GUID 校验误报 `Invalid UUID`（`z.guid()`）与跨环境迁移失败脱敏有界诊断留存、`Bearer` 脱敏正则破坏 JSON 转义问题。

## 已完成

- **11 个针对性及核心回归 Node 测试文件**合计 117 项用例全部通过（**117 项通过、0 项失败**）：
  - 在沙箱内运行 6 个不依赖本地环回端口的测试文件（60 项通过、0 项失败，耗时 `4.00s`）：`tests-node/auto-delivery.test.ts`、`tests-node/site-delivery.test.ts`、`tests-node/task-site-input.test.mjs`、`tests-node/worker.test.ts`、`tests-node/updates.test.ts`、`tests-node/queue-diagnostics.test.ts`。
  - 因沙箱禁止本地 `127.0.0.1` 环回套接字连接（`connect EPERM 127.0.0.1`），在关闭沙箱限制下运行另外 5 个本地模拟 HTTP 服务测试文件（57 项通过、0 项失败，耗时 `7.06s`）：`tests-node/delivery-diagnostics.test.ts`（新增 6 项，覆盖非 RFC 4122 Kooboo GUID 在 `deliveryReceipt` / `executeDelivery` / `/delivery/receipt` / `/api/automation/sites` / `/api/automation/resources` / `/api/automation/kooboo/templates/:templateId` / `/api/evaluations/:id/issue-handoffs` 与 `/receipt` 的兼容与非法值拦截、HTTP 500 JSON 脱敏与 `x-request-id` / 耗时留存及持久化 JSON 往返、HTTP 502 超大 HTML 剥离脱敏与长度有界、`HTTP 500` 空响应体、HTTP 200 非 JSON 畸形回执解析诊断事件，以及 `Bearer` 脱敏正则保留 JSON 转义测试）、`tests-node/diagnostics.test.ts`、`tests-node/root-domains.test.ts`、`tests-node/transfer-wait.test.ts`、`tests-node/harness-and-diagnostics.test.ts`。
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）全部通过（`0.096s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json` 与 `vue-tsc --noEmit -p tsconfig.web.json`）通过（exit code 0）。
- **`npm run build`**（Vite 生产构建 + 服务端 TS 编译 + 构建信息生成）通过（exit code 0）。

## 交付方式与限制

- 从 `v0.8.2` 分出的独立干净工作树提交并打标 `v0.8.3`，执行 `scripts/package-platform.py --update --reuse-dependencies` 生成正式更新 ZIP、`.zip.sha256` 与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 校验远端标签提交后发布至 GitHub Release；未改动 `/Users/achen/Priv/Yardi/Kooboo`，且保留主工作区未提交的开发草稿。
- 自动化测试基于本地模拟服务与内存状态；发版前同一天已在本地环境实测跑通真实 HK → DE 端到端流程（GUID 修复及回执补录后完成 DE 5 项交付核验，以及 8.05 MiB `kooboo-site.zip` 导入 HK 后 4.93s 成功迁移至 DE），但**未执行**实机在线自更新升级流程验收。
