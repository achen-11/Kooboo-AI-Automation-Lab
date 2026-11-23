# v0.9.3 验证记录

日期：2026-11-23。

基线：基于 `v0.9.2`（`fbbb81bc2ef7bcce1b31e29af11d2376114622f6`）合入未建站恢复直达排队、Kooboo 只读重试、Followup 传输断连隔离及经验库代际/语义自检修复提交 `13d9947b6651bcb306e17aae9a46eef6537accf6`（`13d9947`）。

## 已完成自动化验证

- **核心恢复、跟进与经验自检回归测试**（2026-11-23，提交 `13d9947` 对应代码全部通过）：
  - `tests-node/automation-learning.test.ts`、`tests-node/budget-recovery.test.ts`、`tests-node/followup.test.ts`、`tests-node/automation-performance.test.ts`、`tests-node/template-workflow.test.ts`、`tests-node/template-efficiency.test.ts`：**123 项通过、0 项失败、1 项环境开关跳过**（需 `AUTOMATION_CODEX_SANDBOX_TEST=1` 的真实 Codex 沙箱测试），覆盖：
    - 未尝试建站中断任务经 `POST /api/automation/tasks/:id/resume` 直达 `queued` 并在旧窗口耗尽时开启新跟进窗口；
    - `koobooClient` 对幂等 GET 的瞬时断连重试及对 POST/已取消调用的不重试边界；
    - 0 token 模型传输断连与真实决策次数隔离、`selectFollowupTaskEvents` 事件保留、`interrupt` 后人工恢复重置 `threadId`；
    - 经验库 `FOLLOWUP_RUNTIME_EPOCH` 启动期旧版纯 `followup` 退役 / 跨阶段剥离 / 人工条目保留 / 幂等性；
    - `kooboo-subdomain-hyphen-conflict-v1` 语义冲突自动停用 / 合规规则零误伤 / 人工条目不覆盖；
    - `PLATFORM_HARD_CONTRACTS` 提示词注入与 `interruptionReflectionProgressKey` 重复中断跳过及人工复盘覆盖。
- **Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项通过、0 项失败**（`0.116s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（exit code `0`）。
- **`npm run build`**（Vite 2,898 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（exit code `0`）。

## 交付方式与验证边界

- 从干净工作树提交版本元数据并打标 `v0.9.3`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版执行**：
  - 真实远端 Kooboo 环境建站与 Codex 上游实时网络验收；
  - 带有历史真实 `.data/` 数据库的在线自更新覆盖升级实机演练（相关迁移已在构造模拟老库的 SQLite 单元测试中验证幂等通过）。
