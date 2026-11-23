# v0.9.1 验证记录

日期：2026-11-23。

基线：基于 `v0.9.0`（`467b1da`）合入首次生成与异常跟进性能优化提交 `8c142a6e94149890d5ade57ce05afa0f53bd0527`（`8c142a6`）。

## 已完成自动化验证

- **生成与上下文 3 个核心 Node 测试文件**（`tests-node/generation-browser-settings.test.ts`、`tests-node/generation-context.test.ts`、`tests-node/generation-delivery.test.ts`）：**28 项全部通过**（`2.66s`），覆盖首次桥接冷加载分段等待/页内 `reload` 恢复/登录跳转快速失败、`automationBatch` 混合批读/预算分页/错误隔离与委托提示检查，以及发送回执幂等性。
- **跟进与诊断 2 个 Node 测试文件**（`tests-node/followup.test.ts`、`tests-node/harness-and-diagnostics.test.ts`，开启本地 `127.0.0.1` 环回测试服务）：**32 项通过、0 项失败、1 项环境门控 `# SKIP`**（需开启 `AUTOMATION_CODEX_TEST` 的实 Codex 沙盒用例，耗时 `9.70s`），覆盖 `httpRead` `gzip` / `brotli` 透明解压与字节预算限制、Followup 单轮 `get_conversation` 超时防连撞保护及双层故障诊断。
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项全部通过**（`0.110s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（exit code `0`）。
- **`npm run build`**（Vite 2,898 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（exit code `0`）。

## 交付方式与验证边界

- 从干净工作树提交版本元数据并打标 `v0.9.1`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版重新执行真实香港 Kooboo 远端建站联调及本地在线自更新覆盖升级演练**（相关桥接重载、HTTP 压缩与 `get_conversation` 超时防连撞均已由针对性单元测试覆盖）。
