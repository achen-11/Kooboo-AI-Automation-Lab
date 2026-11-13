# Kooboo AI Automation Lab v0.7.6 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查与全量测试：`npm run check && npm test && npm run build && git diff --check`
   - `tests-node/template-workflow.test.ts` 新增断言验证 `scope === 'site'` 参考分析至少分配 `240` 次模型请求、独立评测至少分配 `300` 次模型请求。
   - 执行结果：984 项用例中 980 项通过、0 项失败、4 项既有环境条件跳过；2870 个前端模块与服务端产物构建完成。
2. 打包与发布
   - 基于干净 `git worktree` 制作包含 `UPDATE_MANIFEST.json` 的平台更新包，并发布至 GitHub Releases `v0.7.6`。
3. 真机续跑验收计划
   - 升级重启后恢复 `da8309ff`（`Playo 128` 独立评测），复用已落盘的 `82,288` 字节 `view-drafts:` 检查点完成 `read(implementation)` 并提交评测报告；协同追踪 `0e4159b2`（`Stageo Template`）全链路完成。
