# v0.9.6 验证记录

日期：2026-11-23。

基线：基于 `v0.9.5`（`8e4a898`）单次提交任务列表、任务详情与评测详情信息架构重构及浏览器视觉精修改动。

## 已完成自动化验证

- **定向前端组件与导航测试**（2026-11-23，`node --import tsx --test tests-node/site-delivery-list-component.test.mjs tests-node/task-recovery-component.test.mjs tests-node/live-comparison-component.test.mjs tests-node/task-site-input.test.mjs tests-node/site-report-navigation.test.ts tests-node/workflow-graph-component.test.mjs tests-node/task-detail-refactor-component.test.mjs`）：**33 项通过、0 项失败**：
  - `tests-node/site-delivery-list-component.test.mjs`（6 项）：验证快捷视图同步筛选、行内露出原因文案、单行安全 `恢复`（无 `force: true`、跳过未确认停止项）、复制站点地址与交付主链接优先；
  - `tests-node/task-detail-refactor-component.test.mjs`（2 项）：验证 `TaskOverviewHero` 优先展示交付地址/一键复制/评分/总成本且不在内部重复渲染恢复与打开按钮、无 `siteId` 时不误发站点请求，并验证 `SiteReports` 默认直达最新报告且 `CHECKS` 规则沉淀已下沉至折叠区；
  - `tests-node/task-recovery-component.test.mjs`（11 项）、`tests-node/live-comparison-component.test.mjs`（4 项，修复 `TaskReport` 仅 1 个「实时站点对比」按钮断言）、`tests-node/task-site-input.test.mjs`（6 项）、`tests-node/site-report-navigation.test.ts`（1 项）、`tests-node/workflow-graph-component.test.mjs`（3 项）：全部通过。
- **Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项通过、0 项失败**。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（退出码 `0`）。
- **`npm run build`**（Vite 2,902 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（退出码 `0`）。

## 实机浏览器视觉验收（`http://127.0.0.1:4180`，`1440x900`）

- 完成两轮只读浏览器巡检并保留截图核验：
  - 任务中心 `/#/tasks`：7 列（`976px` 宽）完整容纳在布局容器内，右侧 `快捷操作` 列与 `恢复`/`对比` 按钮零裁切，原因文案两行截断对齐；
  - 已完成任务（`快速实测 · HK建站自动交付DE · 清岚单页`）：概览 Banner 紧凑 4 格并排无重复大按钮、评测详情空建议卡贴合内容不拉伸、研发排障首屏展示执行日志；
  - 中断任务（`HK-DE 回退验证 Kinetic Awareness`）：Header 与 4 格 Hero 摘要清晰对齐，零重复恢复按钮。

## 交付方式与验证边界

- 从干净工作树单次提交并打标 `v0.9.6`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版执行**：全部 1,100+ 项全量回归测试套、在线自更新覆盖升级实机演练；此外 `tests-node/automation-ui.test.ts` 中既有后端 `execution` 区块字段断言差异属于基线已有问题，未在本前端重构范围改动。
