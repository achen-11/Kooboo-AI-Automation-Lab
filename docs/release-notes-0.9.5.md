# v0.9.5：任务详情 Workflow 流程图可视化与自适应卡点定位

本版本基于 `v0.9.4`（`8cdd190`）发布，为任务详情「概览」页新增面向非开发人员的 **Workflow 流程可视化与卡点定位视图**，帮助快速看清任务当前进度、卡点原因与下一步操作，同时对前后端渲染和查询链路做了针对性性能优化。

---

## 核心改进

### 1. 完整端到端工作流骨架与卡点定位（[`shared/workflow-graph.ts`](../shared/workflow-graph.ts)、[`server/automation/workflow-graph.ts`](../server/automation/workflow-graph.ts)）
- 新增只读投影接口 `GET /api/automation/tasks/:id/workflow`（由 `buildTaskWorkflowGraph` 构建），基于持久化的任务状态、生成检查点、A 段采集（`CollectionStore`）、模板基线（`TemplateWorkflowStore`）、优化轮次、`TimingLedger` 实测耗时与 `deriveHumanNotice` 生成脱敏流程图数据。
- **完整流程骨架**：主干始终完整展示「**环境与资料准备 → AI 生成建站 → 独立评测 → 质量达标判定 → 跨环境交付**」（适用场景另展示前置「原站采集 / 参考基线分析」），下方始终呈现「**自动优化修复**」闭环以及实际触发过的「**AI 自动跟进 / 经验复盘沉淀**」支路；未到达或未开启节点以置灰虚线态呈现，缺失阶段计时保持 `null` 不虚构。
- **多跳祖先回溯与语义徽标**：打开多跳手动重评后的评测任务时自动沿 `parentId` 链及站点索引回溯到原始生成任务，同时在评测节点保留当前查看轮次的得分与问题；徽标按严重程度清晰区分 **「卡在这里」**（中断/失败）、**「排队等待」**（排队阻塞原因）与 **「需关注」**（已完成评测但有待改进项）。

### 2. 自适应无水平滚动画布与交互式节点检查器（[`frontend/src/lib/workflow-graph-layout.ts`](../frontend/src/lib/workflow-graph-layout.ts)、[`frontend/src/views/automation/TaskWorkflowGraph.vue`](../frontend/src/views/automation/TaskWorkflowGraph.vue)、[`frontend/src/views/automation/TaskDetail.vue`](../frontend/src/views/automation/TaskDetail.vue)、[`frontend/src/views/automation/TemplateWorkflowOverview.vue`](../frontend/src/views/automation/TemplateWorkflowOverview.vue)）
- **自适应容器宽度**：`computeWorkflowLayout` 根据容器 `maxWidth` 动态调整节点宽度与列间距，结合 `ResizeObserver` 监听与极窄视口 `fitScale` 等比兜底，在桌面端完整展示全部节点且零水平滚动条；移动端自动切换为纵向步骤条。
- **零遮挡避让布局**：将回环（`未达标 · 进入修复` / `修复后复评`）和支路连线标签统一排布在主干与支路间的开放通道内，多边同节点底部端口自动分散，并对标签边界盒执行节点避让与碰撞错开；卡点徽标内联放入卡片底栏，释放顶部标题完整宽度。
- **一键定位与操作直达**：点击任意节点（或使用键盘方向键）即可在下方检查器查看通俗说明、检查点列表、双端分数与实测耗时，并可直接触发恢复执行、调整站点名称、补充资料/AI 收集或跳转对应标签页；对无 `/workflow` 接口的旧服务端自动静默回退原进度条。

### 3. 前后端性能优化（[`server/automation/queue-diagnostics.ts`](../server/automation/queue-diagnostics.ts)、[`server/automation/workflow-graph.ts`](../server/automation/workflow-graph.ts)、[`frontend/src/views/automation/TaskWorkflowGraph.vue`](../frontend/src/views/automation/TaskWorkflowGraph.vue)）
- **消除请求期 DDL 与全表扫描**：通过 `WeakMap` 按 `AutomationStore` 实例缓存子 Store，避免每次接口请求重复执行 `CREATE TABLE IF NOT EXISTS` 与经验迁移检查；抽取 O(1) 单任务排队诊断 `diagnoseTaskQueueReason`，无需为单个流程图反序列化队列中的无关任务；经验学习记录查询限定最近 20 条。
- **零空转重绘与按需挂载**：移除 60fps 持续重绘的 `box-shadow` 脉冲与 SVG `stroke-dashoffset` 帧动画，改为轻量静态强调边框；仅渲染当前视口（桌面画布或移动端列表）对应的 DOM，并在页面隐藏（`document.hidden`）时暂停请求、恢复可见后再补刷。
