# AI Chat 发送快照

生成任务详情 → 输入与配置 → **发送给 AI Chat**。

- 默认展示最近一次实际投递的完整文本，可复制全文；通过轮次选择器查看初始生成、跟进、修复批次和工具输入回答。
- 附图保存实际发送的 PNG 字节，可查看原图；不把 Base64 混入可复制文本。
- 展开“本次任务资料”读取这次投递绑定的任务包，包括执行路线、完整任务要求、经验与执行约束、交付清单、素材索引、来源证据等。缺失来源原件明确提示。复制资料会导出该包完整 sections JSON。
- 自动优化总任务汇总本流程内的生成/修复投递；单个修复任务查看自身记录。独立继续生成仍是新任务。
- 原来的“完整委托消息”改为“原始任务要求”，避免把组装前要求误认为真实发送原文。

## 数据与回执

`auto_generation_deliveries` 在调用远端 `deliver` 前保存不可覆盖的 payload 快照，绑定 taskId、输入版本、站点、packageId、conversationId、deliveryId 和图片哈希。回执只更新发送/执行状态，不重新渲染历史正文。

| 状态 | 含义 |
| --- | --- |
| 待发送 | 已保存快照，尚未进入远端发送步骤 |
| 发送结果待确认 | 已进入发送步骤，尚无匹配的接受回执；异常和重启后仍保留，不自动重发 |
| 已接受 | AI Chat 返回匹配的投递编号与会话回执 |
| 本轮执行结束/失败/中断 | 匹配站点、任务、会话、投递编号和新 runId 的终态；不表示独立质量验收通过 |

同一任务的后续发送各有独立记录。回答待输入工具时保存 answer JSON 和 callId，不伪装成普通文本 prompt。图片位于 `.data/generation-delivery-images/<sha256>.png`，读取时核对 SHA-256 和字节数。该目录与数据库一起备份；临时任务资料清理不删除发送图片或本地归档。

旧任务不回填推测正文。存在归档包时显示“此历史任务未保存发送原文”，仍可展开当时的任务资料。没有发送快照或资料包时，仅展示原始要求，并明确最终消息尚无快照。单独存在的归档包不能证明已经发送。

## 本机会话 API

- `GET /api/automation/tasks/:id/generation-deliveries`：轮次摘要与归档包元数据，不包含消息正文、answer 或包原文；用于详情页按需刷新。
- `GET /api/automation/tasks/:id/generation-deliveries/:deliveryId`：完整发送快照。
- `GET /api/automation/tasks/:id/generation-deliveries/:deliveryId/images/:index`：按发送顺序读取已登记图片字节。
- `GET /api/automation/tasks/:id/generation-context/:packageId`：该任务/优化流程所属的完整归档 sections，展开时才加载。

以上接口沿用本机 HttpOnly 会话，校验任务归属；只读查询不会启动生成或访问远端。原 generation-context 元数据接口保留。

此处记录 Lab 送入 AI Chat 的委托及资料。Kooboo 每轮发给模型的系统提示、历史、动态 Skill/工具结果和压缩状态不在此快照范围内；设置页模板变量编辑也不属于本次改动。

## 验证边界

使用临时数据库和模拟会话验证不可变原文、API 归属与认证、图片完整性、未知发送的恢复和工具回答。既有传输回归覆盖继续生成、修复分批与大资料包。模拟测试不证明真实模型执行和浏览器视觉验收。
