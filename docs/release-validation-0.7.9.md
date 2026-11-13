# Kooboo AI Automation Lab v0.7.9 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查与全量测试：`npm run check && npm test && npm run build && git diff --check`
   - `tests-node/budget-recovery.test.ts` 新增用例验证已停止 `site-template` 独立评测在调用 `POST /resume` 与服务重启执行 `store.recover()` 时，均会将孤立 `active` 评测模型请求预占转为 `retained` 并保留原 `spent` 计数，解除 `同一预算仍有模型请求执行中` 阻塞。
   - 执行结果：985 项用例中 981 项通过、0 项失败、4 项既有环境条件跳过；2870 个前端模块与服务端产物构建完成。
2. 打包与发布
   - 基于干净 `git worktree` 制作包含 `UPDATE_MANIFEST.json` 的平台更新包，并发布至 GitHub Releases `v0.7.9`。
3. 真机续跑验收计划
   - 升级重启后，验证 `c6efb9d3`（`Stageo Template` 独立评测）遗留的孤立 `active` 请求预占自动转为 `retained`，无须人工清理 SQLite 即可安全恢复评测直至完成报告。
