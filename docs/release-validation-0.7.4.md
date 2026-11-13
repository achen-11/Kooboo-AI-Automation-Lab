# Kooboo AI Automation Lab v0.7.4 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 类型检查：`npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）
   - 执行结果：0 错误通过。
2. 自动化测试：`npm test`（`node scripts/test-node.mjs`）
   - `tests-node/template-workflow.test.ts` 扩展验证：
     - 验证 `ensureTemplateAnalysis` 与 `executeTemplateWorkflowEvaluation` 对 `scope === 'site'` 至少分配 `15,000,000` token 预算；
     - 验证遇到 `max_output_tokens` 或 `剩余预算不足以接收本次上下文` 时均自动重置会话绑定，同时保留已有阶段检查点草稿。
   - 执行结果：984 项用例中 980 项通过、0 项失败、4 项既有环境条件跳过。
3. 差异与工作区检查：`git diff --check`
   - 执行结果：0 错误通过。
4. 构建与真机恢复计划
   - 提交打标 `v0.7.4` 并执行 `npm run build` 后重启服务，解绑并恢复 `da8309ff`（Playo 128 独立评测），配合 `0e4159b2`（Stageo Template 已进入建站阶段）完成双样本全链路验收。
