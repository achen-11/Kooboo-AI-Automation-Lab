# v0.9.0 验证记录

日期：2026-11-22。

基线：合并 `v0.8.3`（`d83f041ac2c60880f18784c5506f8bc6dc4a70b7`）与 Verification Engineering Phase 1–3（`5da0b61`、`73038d8`、`f44c948`、`65f3681`）。

## 已完成自动化验证（合入 `v0.8.3` 后）

- **11 个核心与合并回归 Node 测试文件**合计 130 项用例（**129 项通过、0 项失败、1 项环境门控 `# SKIP`**［需开启 `AUTOMATION_CODEX_TEST` 的实 Codex 沙盒用例］，耗时 `11.01s`，开启本地环回端口测试）：
  - `tests-node/delivery-diagnostics.test.ts`（`v0.8.3` 非 RFC 4122 Kooboo GUID、`executeDelivery` 响应体/链路头脱敏诊断及 `Bearer` 脱敏保留转义）
  - `tests-node/auto-delivery.test.ts`、`tests-node/site-delivery.test.ts`
  - `tests-node/checker-checks.test.ts`（`CHECKS` 规则版本化、乐观并发锁、豁免沉淀、确定性回归、`executeEvaluation` 冻结与动态 `ruleId` 注入、批次缓存失效）
  - `tests-node/harness-and-diagnostics.test.ts`（16 篇 Harness 目录含 `evaluation/CHECKS.md` 与 `reset` API）
  - `tests-node/bounded-checker-rules.test.ts`、`tests-node/bounded-evaluator.test.ts`（含 `verifyDelivery` 有界交付测试）、`tests-node/bounded-site-evaluator.test.ts`
  - `tests-node/automation-optimization.test.ts`（含单步只读有界优化规划器与 `materials` 自动优化）
  - `tests-node/followup.test.ts`、`tests-node/automation.test.ts`
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）全部通过（`0.103s`）。
- **确定性 `CHECKS` 回归 CLI**（`node --import tsx scripts/checks-regression.ts --deterministic`）：针对本地 `.data/database.sqlite`（6 启用规则、7 标定用例含 2 条真实磁盘 PNG）**7/7 全部通过**。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json` 与 `vue-tsc --noEmit -p tsconfig.web.json`）：通过（exit code `0`）。
- **`npm run build`**（Vite 2,898 模块生产构建 + 服务端 TS 编译 + 构建信息生成）：通过（exit code `0`）。

## 真实站点与真机界面端到端实测（2026-11-21 ~ 11-22）

- **`materials/homepage` 同站 1:1 对照（`auto_f9579f55_e3b`，云隅精品咖啡馆）**：由旧版 50 req / 262.6s / ¥0.2740 优化至 2 req / 84.2s–101.8s / ¥0.0826–¥0.0958，并稳定识别移动全屏菜单关闭缺失（`MOBILE_MENU_TRAPPED`）。
- **`materials/site` 多页全站实测（`auto_7afb0300_537`，拾光建筑 3 页静态站）**：`389.3s / 9 req / ¥0.3541 / 90·78 failed`（较历史全站基线请求降 96%+、费用降 65%–79%）。
- **`materials` 模板建站 + 自动优化实测（`auto_cc5228d1_a78`，OVO 阀门 + `Vantage Precision` + 58 份图文资料）**：`290.6s / 79 req / ¥0.4284`，22,000px 超长页分段续采与 `6f0ac020` / `94209d22` / `0c845714` 两轮自动优化全真机跑通。
- **`upgrade` 模板 + 旧原站 + 补充资料闭环实测（`auto_8900fb2c_b80`，`Shiome` + `auto_f9579f55_e3b` + `.md`）**：Round 0 基线 `PC 78 / Mobile 84.2 (failed)` → **单步有界规划 `1 req / ¥0.0374`** → Round 1 修复复评 **`PC 91.4 / Mobile 90.4 (passed)`**，第 1 轮自动优化达标（全流程总计 `181 req / ¥1.2434`）。
- **Phase 3 真机 UI 实测（`http://127.0.0.1:4180`）**：在真实浏览器完成 `#/rules` 5/5 回归 → `#/tasks/...` 报告页为 `R-VISUAL-02` 追加豁免（`rev 2`）与新增 `R-CONTENT-02` → 版本历史 / 启停 / `#/harness` 展示 / 最终 7/7 回归通过。

## 交付方式与限制

- 从已合入 `v0.8.3` 的 `feat/kooboo-template-reference` 干净工作树提交并打标 `v0.9.0`；既有未提交的 `v0.8.3` 早期本地草稿已 `git stash` 暂存，未污染本次发布包；发布通过 `scripts/package-platform.py --update --reuse-dependencies` 与 `npm run release:publish` 完成，不包含本地 `.data/` 与个人运行凭证。
- **未在本地实机执行在线自更新覆盖升级演练**（与此前 `v0.8.x` 发布口径一致）；`gpt-6.1-sol` 价格快照待取得官方单价后另行配置。
