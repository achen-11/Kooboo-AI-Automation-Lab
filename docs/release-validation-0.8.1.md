# v0.8.1 验证记录

日期：2026-11-21。

基线为 `v0.8.0`（`81469867676d6d76105882302e4be19569845c76`），针对源站克隆部分页面永久挂起导致准备阶段静默空转至 60 分钟上限的问题，为 `waitForTransferPages` 增加 2 分钟停滞检测、5 分钟等待上限与 `Transfer/GetTaskStatus` 交叉核验，并在克隆等待期间持续写入进度事件与刷新更新时间。

## 已完成

- **8 个针对性及核心回归 Node 测试文件**合计 103 项用例执行完成：**102 项通过、0 项失败、1 项条件跳过**（`followup.test.ts` 中需显式开启 `AUTOMATION_CODEX_SANDBOX_TEST=1` 的本地 Codex CLI 沙箱探测用例）：
  - `tests-node/transfer-wait.test.ts`（6 项全过：覆盖部分页面永久 `done=false` 停滞放行、0 页停滞、慢速推进触达 `maxWaitMs` 上限、正常快速完成、`allowInitialCheck` 恢复快捷放行、`executeGeneration` 等待与完成事件写入）
  - `tests-node/harness-and-diagnostics.test.ts`、`tests-node/kooboo-template-reference.test.ts`、`tests-node/task-supplement.test.ts`、`tests-node/root-domains.test.ts`、`tests-node/followup.test.ts`、`tests-node/updates.test.ts`、`tests-node/worker.test.ts`
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）全部通过（0.102s）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json` 与 `vue-tsc --noEmit -p tsconfig.web.json`）通过（exit code 0）。
- **`npm run build`**（Vite 生产构建 + 服务端 TS 编译 + 构建信息生成）通过（exit code 0）。

## 交付方式与限制

- 从 `v0.8.0` 分出的独立干净工作树提交并打标 `v0.8.1`，执行 `scripts/package-platform.py --update --reuse-dependencies` 生成正式更新 ZIP、`.zip.sha256` 与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 校验远端标签提交后发布至 GitHub Release；未改动 `/Users/achen/Priv/Yardi/Kooboo`，且保留主工作区未提交的开发草稿。
- 以上自动化测试均基于本地模拟 HTTP 服务与内存状态；**不等同于**真实线上 HK / DE Kooboo 环境联调、真实外部 AI 模型调用或实机在线更新的端到端验收。
