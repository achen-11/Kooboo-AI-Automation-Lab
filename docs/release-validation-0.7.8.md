# Kooboo AI Automation Lab v0.7.8 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查与全量测试：`npm run check && npm test && npm run build && git diff --check`
   - `tests-node/template-workflow.test.ts` 更新断言验证 `scope === 'site'` 参考分析与独立评测的 `maxTokens` 下限提升至 `50,000,000`，且上下文透出 `draftProgress` 完成度字段。
   - 执行结果：984 项用例中 980 项通过、0 项失败、4 项既有环境条件跳过；2870 个前端模块与服务端产物构建完成。
2. 打包与发布
   - 基于合入远端 `v0.7.7` 后的干净 `git worktree` 制作包含 `UPDATE_MANIFEST.json` 的平台更新包，并发布至 GitHub Releases `v0.7.8`。
3. 真机续跑验收计划
   - 升级重启后恢复 `da8309ff`（`Playo 128` 独立评测）并续跑/跟进 `c6efb9d3`（`Stageo Template` 独立评测），验证在累计消耗超过 `15,000,000` 缓存输入 token 后仍可基于 `50,000,000` 下限及完整 `view-drafts:` 进度安全完成最终报告提交。
