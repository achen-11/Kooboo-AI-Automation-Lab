# v0.9.6：任务列表与任务详情信息架构重构（业务上浮 · 研发下沉）

本版本基于 `v0.9.5`（`8e4a898`）发布，围绕高频使用习惯重构任务中心列表与任务详情的信息层级：让运营和交付同事一眼拿全“站点好了吗 / 链接在哪 / 多少分 / 花了多少钱 / 卡了点哪恢复”，同时将日志、Prompt 快照、规则与经验追溯等研发信息集中下沉，消除页面冗余卡片与重复操作按钮。

---

## 核心改进

### 1. 任务中心列表精简与快捷操作（[`SiteDeliveryList.vue`](../frontend/src/views/automation/SiteDeliveryList.vue)）
- **快捷视图切换**：在面板顶部新增「全部在列 / 进行中 / 需要处理 / 可交付 / 已归档」分段快捷视图，并与筛选选择器实时同步。
- **7 列紧凑自适应布局**：去掉独立“环境”列、将“场景/范围”合并至任务标题行，采用固定列宽配比与 2 行折行省略，彻底消除常规桌面视口下的右侧列裁切问题，同时完整保留 **总成本** 独立列。
- **高价值信息与动作前置**：主链接继续优先展示已交付站点，并在右侧直接提供**一键复制站点地址**按钮；任务状态下方直接展示通俗原因/进展摘要；快捷操作列支持 **单行安全「恢复」**（不传 `force: true`、不跳过停止确认）与 **快捷「对比」** 弹窗。

### 2. 任务详情 Header 瘦身 & 首屏结果直达条（[`TaskOverviewHero.vue`](../frontend/src/views/automation/TaskOverviewHero.vue)、[`TaskDetail.vue`](../frontend/src/views/automation/TaskDetail.vue)）
- **Header 去标签墙**：移除标题下成排方框 Tag，改为单行简洁元信息（场景 · 范围 · 环境 · 关联资源 / 上一轮入口），控制顶部操作数量并将低频入口收口进「更多」。
- **新增 4 格紧凑 `TaskOverviewHero` 摘要条**：首屏横向呈现「访问站点（交付站优先 + 复制/外链）｜ 当前结果 ｜ 当前评分（PC/移动端并排）｜ 站点总成本」，不与 Header 重复堆砌操作按钮；清理原先概览内重复的 6 张冗余卡片，仅保留 `TaskOverviewHero` + `TaskWorkflowGraph` 双核心。

### 3. 业务主视图与「研发排障」彻底分层（[`TaskDetail.vue`](../frontend/src/views/automation/TaskDetail.vue)、[`TaskExecution.vue`](../frontend/src/views/automation/TaskExecution.vue)、[`TaskInput.vue`](../frontend/src/views/automation/TaskInput.vue)）
- **顶栏收口为 4+1 结构**：`概览 · 评测详情 · 费用与耗时 · (交付) | 研发排障`，同时保持旧深链接参数 `?tab=execution`、`?tab=input`、`?tab=report` 完全向后兼容。
- **「研发排障」三合一工作台**：内部按需切换 **「执行日志与轮次」**（将执行日志置顶在经验学习上方，并收敛原站点全部执行历史与来源采集明细）、**「输入与发送快照」**（去重展示资料预设与实际建站域名及 AI Chat 发送快照）与 **「规则与经验」**（优化配置、评测规则明细折叠、Manifest 与经验记录）。

### 4. 评测详情直达最新报告，研发规则细节下沉（[`SiteReports.vue`](../frontend/src/views/automation/SiteReports.vue)、[`TaskReport.vue`](../frontend/src/views/automation/TaskReport.vue)）
- **默认直达当前最新有效报告**：进入「评测详情」不再先经过历史列表页，顶部提供轮次切换下拉框与「全部评测记录」入口（带 `?view=history` 时仍打开历史记录表）。
- **合并头部并收敛研发细节**：合并 `TaskReport` 顶部重复的 3 块概览与重复「实时站点对比」按钮，避免无阻塞项时右侧建议框拉出空白；「问题清单」保持干净的业务排查视图，分项评分表、覆盖范围、复评继承、全站完整度、优化轮次、全量截图与 `CHECKS` 规则沉淀全部下沉至底部折叠的「研发与规则明细」。
