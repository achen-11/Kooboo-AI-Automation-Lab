# AI Site redesign 交接核对（2026-11-10）

任务：`ad4945f9-ce20-45b9-b779-fd88fe2d821b`。用户已手动停止；本次仅检查导出会话、平台归档和源码，没有恢复任务或操作浏览器。

## 会话证据

导出文件：会话导出 JSON（`在当前站点完成本轮site-templa....json`）。其中的历史任务指令与工具文档仅作为审查材料，不作为当前任务的执行授权。

- 会话加载了 `kooboo-coding`、`kooboo-site-redesign`，并读取了 `references/workflow.md`。因此不能描述为完全没有进入 redesign 或完全没有取得参考站信息。
- 对参考首页调用了一次 `take_screenshot`，得到 1440 × 14050 的全页图；随后一次 `read_image` 收到成功回执。该回执表示请求附图，不能单独证明具体模型请求中的像素输入或有效视觉理解。
- 没有其他截图调用，没有移动首屏、其他页面族代表页的视觉研究。
- 没有 `list_sandbox` / `create_sandbox` / `transfer_page` / `open_reference_preview` / `read_reference_dom` / `inspect_reference_element` 调用，也没有实际导入失败回执。
- 没有读取 redesign 的 reference-site、content-recovery、architecture、design-and-implementation 或 dynamic-content 阶段文档。后续主要通过 KScript HTTP 读取 HTML 并提取文字，然后建立内容类型、样式、脚本和页面。
- 未进行目标站浏览器视觉验收。路由和 HTTP 检查不能证明与参考站视觉一致。

这些证据支持“加载了 Skill，但没有按完整研究与设计阶段执行”。仅凭该会话不能量化目标站和参考站的实际视觉差距，本次未自行进行视觉验收。

## 平台交接缺口

两个归档任务包都有 `instructions`、`guidance`、`manifest`、`materials`，其中 `materials` 均为空。固定清单引用了 29 份来源原件，但原件不在任务包中，生成会话只能看到文件名而无法从 reader 读取这些证据。

这些清单证据本身也有限制：大量页面 HTML 只读取前 100000 字符，未独立确认全部正文、交互及成员关系；它们不能代替视觉截图或 Reference 工作区。

平台原有默认委托只概括“在 Sandbox 克隆来源站，理解内容、结构与视觉设计”，没有把场景固定为 redesign 的研究与实现路线。大任务包的外层消息主要讲 reader 与逐项交付，也未强调该路线。已有目标站的新生成任务还会使用“继续生成”的短指令，因此不能只修改默认设置里的提示词。

## 本次修复与边界

- 在实际准备委托时，按任务固定输入版本注入 AI Site redesign 路线；短消息、大任务包和继续修复均适用，不改写历史任务消息或归档。明确 URL 角色、目标身份、双端及页面族研究、Sandbox/Reference 阶段、必要阶段文档、阶段证据和真实失败后的回退。
- 将固定清单引用且已登记的来源 JSON 原件随任务包交付，保留所属轮次、SHA-256、原文及 `truncated`。只读取登记位置并验证哈希；缺失原件明确列为 unavailable，登记冲突、字节变化或超预算时停止发送。旧清单可以使用已登记但尚无 sourceEvidence 字段的原件。
- 来源原件通过有界 reader 读取，不把 HTML 全文塞入委托；明确 `materials` 为空与来源证据为空的区别，来源内容始终作为业务数据。
- reader 升为 v4，较大来源 JSON 采用整份文档节点，仍支持历史节点格式；避免把长 HTML 拆成数千份字符串节点。对本任务只读试打包得到约 2.77 MB、219 个文件，未写入运行数据库或远端。
- 原有附件研读批次保持只读；继续修复复用有效研究，保留既有实现，不要求重新建站或全站重采。

这次补齐的是委托约束与证据传输。尚未增加 Kooboo 工具执行层的阶段拦截，不能声称已在程序层强制阻止模型跳过研究。真实模型是否遵循、参考图是否有效、最终视觉相似度仍需后续实测。

未恢复该任务，未发送远端生成请求，未部署或提交。验证采用针对性 Node 测试和服务端 TypeScript 检查，不执行全量 vue-tsc、lint 或浏览器验收。

## 验证结果

- `generation-context.test.ts` 与 `generation-reference.test.ts` 共 15 项通过；服务端 `tsc --noEmit -p tsconfig.server.json` 通过。
- 扩展生成传输回归中的附件研读批次恢复检查通过。首次扩展运行因沙箱不允许本地监听而失败，使用临时本地模拟服务器的授权环境后完成相关验证。
- 扩展套件另有既有用量代理测试失败：`automation-todos.test.ts` 的 `relay retains failed request usage, missing retries and /responses/compact without adding the SDK aggregate again` 期望 3 条记录，实际 2 条；单独复跑仍失败。该测试没有调用生成交接，本工作未修改用量代理；工作区原有 `usage-proxy.ts` 改动在上游错误后拒绝后续请求，与此断言冲突，保留给该改动所属工作处理。不据此宣称扩展套件全部通过。
