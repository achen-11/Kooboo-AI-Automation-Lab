# v0.9.2 验证记录

日期：2026-11-23。

基线：基于 `v0.9.1`（`5d414f52055adaa0f510b82743b4ab83b4319968`）合入跨环境迁移 `__engine_timeout__` 对齐提交 `0dd0c8a7922419bb77793a63c55a76c0964fa55c`（`0dd0c8a`）。

## 已完成自动化验证

- **跨环境交付与诊断回归测试**（2026-11-23，修复提交 `0dd0c8a` 后全部通过）：
  - `tests-node/delivery-diagnostics.test.ts`（开启本地 `127.0.0.1` 环回模拟服务）：**7 项通过、0 项失败**（`1.60s`），覆盖 `deliveryRequestUrl` 默认 `180` / 自定义 `240` / 非正数回退 / 既有 query 保留 / 显式非空 `__engine_timeout__` 保留、真实 `executeDelivery` HTTP 请求携带 `?__engine_timeout__=180` 与 `240` 且保持 `policy.endpoint` 不变，以及原有 Kooboo GUID 与迁移异常诊断用例。
  - `tests-node/auto-delivery.test.ts` & `tests-node/site-delivery.test.ts`（沙箱内非环回单元测试）：**22 项通过、0 项失败**（`1.82s`）。
- **Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项通过、0 项失败**（`0.124s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（exit code `0`）。
- **`npm run build`**（Vite 2,898 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（exit code `0`）。

## 交付方式与验证边界

- 从干净工作树提交版本元数据并打标 `v0.9.2`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版执行**：
  - 真实远端 HK → DE（`https://launch.kooboo.nl/api/sitemigrate`）全链路迁移验收（需等待 DE 服务端 `sitemigrate` 同步调整 `httpClient` 超时读取 `__engine_timeout__` 后联调确认）；
  - 本机在线自更新覆盖升级演练。
