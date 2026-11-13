# Kooboo AI Automation Lab v0.7.5 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查与全量测试：`npm run check && npm test && git diff --check`
   - `tests-node/template-workflow.test.ts` 新增断言验证 `scope === 'site'` 评测至少分配 `30` 分钟累计决策时钟，并验证选择器校验失败信息包含精准 `pagePath / viewId / viewport` 上下文。
   - 执行结果：984 项用例中 980 项通过、0 项失败、4 项既有环境条件跳过。
2. 生产构建与打包发布：`npm run build`、干净 `git worktree` 打包 `UPDATE_MANIFEST.json` 并发布至 GitHub Releases `v0.7.5`。
3. 真机恢复验证计划
   - 重启服务至 `v0.7.5` 后：
     - 先核对无残留 Chromium 进程并调用 `confirm-stopped` + `resume` 恢复 `0e4159b2`（`Stageo Template` 原建站会话与站点 `4686d8e0`）；
     - 恢复 `da8309ff`（`Playo 128` 独立评测）在 `30` 分钟时钟及新 SOP 约束下完成报告提交。
