# v0.8.2 验证记录

日期：2026-11-22。

基线为 `v0.8.1`（`b1b570a16248d9d4d71355aaa5880b14c7778f6d`），修复 `POST /api/automation/tasks` 在请求未显式传入 `autoDelivery` 时未按目标环境默认交付偏好（`env.delivery.auto`）冻结任务 `autoDelivery`、导致仅首页（`scope: "homepage"`）等外部创建任务落入旧版 `scope === 'site'` 兜底而跳过自动交付的问题。

## 已完成

- **8 个针对性及核心回归 Node 测试文件**合计 89 项用例全部通过（**89 项通过、0 项失败**）：
  - 在沙箱内运行 5 个不依赖本地环回端口的测试文件（47 项全过）：`tests-node/auto-delivery.test.ts`（9 项全过，含新增 2 项针对省略 `autoDelivery` 时按环境默认偏好冻结、跨 `homepage` 范围自动触发评测与入队交付、`auto=false` 幂等重放不回溯触发、缺令牌/无规则/混合批次/已交付站点/未启用交付环境非致命降级，以及父任务 `autoDelivery=false` 优先于环境默认偏好的测试）、`tests-node/task-site-input.test.mjs`、`tests-node/worker.test.ts`、`tests-node/updates.test.ts`、`tests-node/queue-diagnostics.test.ts`。
  - 因沙箱禁止本地 `127.0.0.1` 环回套接字连接（`connect EPERM 127.0.0.1`），在关闭沙箱限制下运行另外 3 个本地模拟 HTTP 服务测试文件（42 项全过）：`tests-node/root-domains.test.ts`、`tests-node/transfer-wait.test.ts`、`tests-node/harness-and-diagnostics.test.ts`。
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）全部通过（0.114s）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json` 与 `vue-tsc --noEmit -p tsconfig.web.json`）通过（exit code 0）。
- **`npm run build`**（Vite 生产构建 + 服务端 TS 编译 + 构建信息生成）通过（exit code 0）。

## 交付方式与限制

- 从 `v0.8.1` 分出的独立干净工作树提交并打标 `v0.8.2`，执行 `scripts/package-platform.py --update --reuse-dependencies` 生成正式更新 ZIP、`.zip.sha256` 与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 校验远端标签提交后发布至 GitHub Release；未改动 `/Users/achen/Priv/Yardi/Kooboo`，且保留主工作区未提交的开发草稿。
- 以上自动化测试均基于本地模拟服务与内存状态；**不等同于**真实线上 HK / DE Kooboo 环境联调、真实 `kooboo-workbench` 调用、真实外部 AI 模型调用或实机在线更新的端到端验收。
