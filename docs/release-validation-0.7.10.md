# Kooboo AI Automation Lab v0.7.10 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查与全量测试：`npm run check && npm test && npm run build && git diff --check`
   - `tests-node/template-workflow.test.ts` 验证 `scope === 'site'` 参考分析与独立评测均设置 `maxOutputTokens: 16384`，评测 SOP 更新为 `16384 output_tokens` 上限与每批 `1 到 2` 个区块视口。
   - 执行结果：985 项用例中 981 项通过、0 项失败、4 项既有环境条件跳过；2870 个前端模块与服务端产物构建完成。
2. 打包与发布
   - 基于干净 `git worktree` 制作包含 `UPDATE_MANIFEST.json` 的平台更新包，并发布至 GitHub Releases `v0.7.10`。
3. 真机续跑验收计划
   - 升级重启后恢复 `c6efb9d3`（`Stageo Template` 独立评测），验证在 `16384 output_tokens` 单轮上限与 1–2 个区块视口粒度下顺利推进分批 `checkpoint` 并完成报告提交。
