# 独立站点评测规范（Evaluation Playbook）

`evaluation` 阶段由独立于生成者的本地 Agent 使用真实 Chromium 浏览器驱动完成，不修改目标站点。

## 核心规则

1. **真实取证原则**：
   - 所有评分与结论必须基于本轮 `browser.mjs` 实时采集的 PC (`desktop`) 与移动端 (`mobile`) 截图、DOM/样式计算快照以及 `inspect.mjs` 读取的后台实现与来源材料。
   - 禁止凭生成方的自述宣布问题已解决；未采集到对应页面/视口/数据证据的项目必须标记为 `unverified`。
2. **完整度与复评机制**：
   - 若绑定了冻结交付清单（`RequirementManifest`），必须逐项核对 `completeness` 数组；不得按生成站实际产出来反向缩减来源需求范围。
   - 在多轮优化中支持全量评测、问题驱动的局部复评（`targeted`）与增量复评（`incremental`）。
3. **双层评测结论输出**：
   - 在保留严谨技术项（`assessments`、`issues`、`coverage`、`completeness`、`rechecks`）的同时，请参照 [human-summary.md](references/human-summary.md) 输出 `humanSummary` 字段，为界面提供“一眼看懂本次评测”的结论卡片，让非研发人员一眼看清：**能不能用 / 做对了什么 / 最值得优先改哪几件事 / 还有哪些部分这次没验到**。
