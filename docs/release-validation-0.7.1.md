# Kooboo AI Automation Lab v0.7.1 验证记录

验证日期：2026-11-14。

## 验证范围与命令

1. 自动化测试：`npm test`（`node scripts/test-node.mjs`）
   - 覆盖新增回归测试：`readiness script settles transform marquees, ignores 1x1 tracking pixels and promotes visible lazy images`（`tests-node/page-screenshots.test.ts`）与 `external capture completes after 10s readiness retry while target stays strict, and analysis exposes internalLinks`（`tests-node/template-workflow.test.ts`）。
   - 执行结果：982 项用例中 978 项通过、0 项失败、4 项既有环境条件跳过（`tests-node/page-screenshots.test.ts`、`tests-node/template-workflow.test.ts` 等均在全量运行中通过）。
2. 类型检查：`npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）
   - 执行结果：通过，0 错误。
3. 生产构建：`npm run build`（`vite build --config frontend/vite.config.ts && tsc -p tsconfig.server.build.json && node scripts/write-build-info.mjs`）
   - 执行结果：通过，2870 个前端模块与服务端 TS 构建完成，`git diff --check` 无空白错误。
4. 已知未覆盖边界
   - `npm test` 中的 4 项 `# SKIP` 为既有需要外部实机 Codex / Chromium 环境的跳过用例，不能替代真实参考站与本机 Kooboo 站点的端到端实测；本机服务重启后将使用 `Playo 128` 与 `Stageo Template` 完成端到端验证。
