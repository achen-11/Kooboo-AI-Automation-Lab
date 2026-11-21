# v0.8.0 验证记录

日期：2026-11-21。

基线为 `v0.7.16`（`8554aa03eff2ca2ed676f0e7a282a627bc74d33a`），包含模板市场引用与角色对调升级、Harness 蓝图与双层诊断、0 页克隆保护、单任务自动交付与交付主链接、任务资料补充与附件预览，以及旧版 Kooboo 环境兼容防呆保护。

## 已完成

- **19 个针对性及回归 Node / Vue 组件测试文件**合计 178 项用例执行完成：**177 项通过、0 项失败、1 项条件跳过**（`followup.test.ts` 中需显式开启 `AUTOMATION_CODEX_SANDBOX_TEST=1` 的本地 Codex CLI 沙箱探测用例）：
  - `kooboo-template-reference.test.ts`（覆盖模板检索/详情代理、直接模板与角色对调升级、参考 Sandbox，以及 `probeKoobooApiMethod` / `GET /api/automation/kooboo/capabilities` 对旧版 Kooboo `Api method Not Found` / `找不到API方法` / `404` / `500` 的判定与建站前防呆拦截）
  - `task-supplement.test.ts`（覆盖人工补充、跳过原站克隆、`ask_user_input` 媒体库回答、URL 替换覆盖、AI 辅助收集草稿/部分应用/取消/自动应用与已归档拦截）
  - `harness-and-diagnostics.test.ts`（覆盖 Harness 目录与设置自动升级/重置、`deriveHumanNotice` 双层诊断与旧版 Kooboo 接口异常归类、`pages=0` 降级中断与恢复）
  - `auto-delivery.test.ts`、`site-delivery-list-component.test.mjs`、`task-site-input.test.mjs`、`generation-reference-media.test.ts`、`site-delivery.test.ts`、`task-list.test.ts`、`queue-diagnostics.test.ts`、`followup.test.ts`、`automation-optimization.test.ts`、`updates.test.ts`、`live-comparison.test.ts`、`public-api.test.ts`、`generation-context.test.ts`、`generation-reference.test.ts`、`background-workers.test.ts`、`worker.test.ts`
- **7 项 Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）全部通过。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json` 与全量 `vue-tsc --noEmit -p tsconfig.web.json`）通过。
- **`npm run build`**（Vite 生产构建 + 服务端 TS 编译 + 构建信息生成）通过。

## 交付方式与限制

- 从打好标签的干净提交（`v0.8.0`）独立工作树执行 `scripts/package-platform.py --update --reuse-dependencies` 生成正式更新 ZIP、`.zip.sha256` 与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 校验远端标签提交后发布至 GitHub Release（工作区中无关探索草稿文档不纳入发布提交与更新包）。
- 以上自动化测试均基于本地模拟 HTTP 服务、本地临时目录与内存组件渲染；**不等同于**真实 HK / DE 远端 Kooboo 环境联调、真实外部 AI 模型调用、真实浏览器端到端生成、Windows 实机在线升级或全新机器 `npm ci` 离线安装的实机验收。
