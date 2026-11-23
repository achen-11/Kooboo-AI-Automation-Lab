# v0.9.5 验证记录

日期：2026-11-23。

基线：基于 `v0.9.4`（`8cdd19039f9fef9963dc4b26cc722bf41ac4d3e5` / `8cdd190`）开发并单次提交任务详情 Workflow 流程图可视化及自适应优化改动。

## 已完成自动化验证

- **定向 Node / Vue 组件与几何布局测试**（2026-11-23，`node --import tsx --test tests-node/workflow-graph.test.ts tests-node/workflow-graph-layout.test.ts tests-node/workflow-graph-component.test.mjs tests-node/task-recovery-component.test.mjs tests-node/queue-diagnostics.test.ts tests-node/queue-diagnostics-component.test.mjs`）：**35 项通过、0 项失败**：
  - `tests-node/workflow-graph.test.ts`：覆盖 `prepare` 阶段名称冲突卡点定位与凭据脱敏、暂停队列等待原因、AI 自动跟进支路、多轮自动优化闭环（含子评测视图、跨环境交付）、纯独立评测完整置灰骨架、多跳手动重评祖先回溯与缺失计时保持 `null`；
  - `tests-node/workflow-graph-layout.test.ts`：覆盖主干横排、同锚点支路避让、复杂拓扑零重叠、以及 `maxWidth` 为 `1080` 与 `960` 下的自适应无水平滚动与零遮挡；
  - `tests-node/workflow-graph-component.test.mjs`：覆盖 `TaskWorkflowGraph.vue` 卡点/警告徽标渲染、点击切换节点与触发恢复/补充/标签页动作、不可见页面跳过拉取以及旧服务 404 回退；
  - `tests-node/task-recovery-component.test.mjs`（11 项）、`tests-node/queue-diagnostics.test.ts` & `tests-node/queue-diagnostics-component.test.mjs`（15 项）：验证 `TaskDetail` 恢复流程与 `diagnoseTaskQueueReason` 抽取后队列诊断零回归。
- **Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项通过、0 项失败**（`0.096s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（退出码 `0`）。
- **`npm run build`**（Vite 2,902 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（退出码 `0`）。
- **本机实测验证**（`http://127.0.0.1:4180`）：在本地持久化任务数据上验证 `/api/automation/tasks/:id/workflow` 对多跳重评任务（`72689a9a-...`）返回完整 7 节点工作流（响应约 `13ms`），并在页面实测展示自适应无水平滚动画布。

## 交付方式与验证边界

- 从干净工作树单次提交并打标 `v0.9.5`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版执行**：
  - 全部 1,100+ 项全量回归套（本轮执行了所有与本次改动及公共模块直接相关的 35 项定向 Node/Vue 测试与 7 项 Python 打包边界测试）；
  - 在线自更新覆盖升级实机演练。
