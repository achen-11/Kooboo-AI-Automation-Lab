# 生成编排规范（Generation Playbook）

`generation` 阶段由 Automation Lab Node 宿主驱动准备动作，再把建站/改站工作委托给 Kooboo AI 会话执行。

## 执行步骤

1. **输入校验与版本冻结**：校验目标名称、场景、参考来源（外部 URL 或 Kooboo 模板市场 ID）、附件列表与目标环境可用性，冻结为不可变 `InputVersion`。
2. **采集与视觉基线准备（按场景触发）**：
   - 当任务绑定了来源采集或模板分析时，先确保 `collection` 资料包及来源视觉基线就绪。
   - 若涉及 Kooboo 模板市场（`referenceTemplateId`），自动解析当前目标环境对应的 `previewUrl`，避免跨环境预览失真。
3. **站点与源站克隆准备**：
   - 创建或复用当前任务绑定的目标站点（禁止覆盖已有同名站点）。
   - 根据场景与模板使用模式准备对应站点与只读 Sandbox（详见 [template-modes.md](references/template-modes.md)）。
   - **源站克隆防死锁护栏**：监控 `Transfer/GetStatus` 时区分“正在抓取进行中”与“已完成但 `pages=0`”。若轮询连续稳定或返回全部完成仍为 0 页，立即核对 `Transfer/GetTaskStatus` 并将 1 次降级重试纳入预算（旧流程重试 `Transfer/Single`，角色对调流程重建 1 次 `AISandbox/TransferByLevel`）；若依然为 0 页或未返回页数，立刻按可理解的“源站抓取失败（`source-access`）”明确中断，绝不无限轮询或重复投递同一个失败任务。
4. **结构化指令投递与幂等恢复**：
   - 通过 `GenerationDeliveryStore` 生成唯一 `deliveryId`，确保进程重启或网络抖动后不会向 Kooboo 重复发送不确定状态的建站请求。
   - 若建站会话挂起在 `ask_user_input` 或中途中断，交由 Followup Agent 查证后安全推进或中断给人工处理。
