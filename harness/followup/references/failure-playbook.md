# 常见故障判断与处置手册（Failure Playbook）

在调用 `act` 前，请先对照本手册判断问题属于“可自动恢复”还是“必须中断交由人工处理”。

## 1. 源站或参考站无法抓取（`source-access`）

- **典型信号**：
  - `Transfer/GetStatus` 已完成或稳定不再增加，但 `pages=0`；或 `Transfer/GetTaskStatus` 显示 `pages` 为 0。
  - 原站 / 参考站 URL 返回 403、404、5xx、超时、SSL 错误，或触发验证码 / 反爬拦截 / 登录墙。
- **正确处置**：
  - 若宿主尚未走完降级核查，可通过 `get_site` / `inspect_execution` 检查目标站与 Sandbox 是否已有可用页面；确认确实 0 页或目标网址无法访问时，**不要再用 `retry` 反复克隆同一个地址**，应直接 `interrupt`。
- **用户层建议措辞**：说明“原网站无法正常访问或抓取不到页面（可能网址有误、需要登录或开启了访问限制）”，并建议用户“1）在浏览器打开原网址确认能正常访问；2）如有反爬限制，先手动抓取或导入页面到站点后点击恢复继续；3）必要时更换可公开访问的网址”。

## 2. Kooboo 登录失效或权限不足（`target-auth`）

- **典型信号**：请求 Kooboo 接口返回 401/403、Token 过期、无权限创建或修改目标站点/Sandbox。
- **正确处置**：不要持续重试；立即 `interrupt`。
- **用户层建议**：提示用户前往「环境与凭据设置」重新登录或刷新对应 Kooboo 环境的授权，然后再回来点击恢复。

## 3. 模板导入失败或模板不可用（`template-source`）

- **典型信号**：`AISandbox/ImportFromTemplate` 或 `UseTemplate` 失败、模板 ID 不存在、预览地址不可达。
- **正确处置**：先核实 `get_site` 是否已经实际导入成功；若确认模板源本身失败且重试一次仍无效，直接 `interrupt`，引导用户在资料输入中确认模板市场选择或更换模板。

## 4. AI 挂起等待人工输入或缺少文件（`need-human-input`）

- **典型信号**：Kooboo 会话处于 `ask_user_input`，且原因是视觉截图取证失败、要求用户上传文件（`kind=upload`）、需要用户二选一业务确认或更换网址。
- **正确处置**：严禁代答或跳过视觉验证，必须 `interrupt`，把 AI 真正问的问题翻译成人话放进 `userActions`。
- **可自动收尾例外**：若页面已实际写入目标站（`probe_site` / `get_conversation` 已核实），仅在收尾阶段因 `ask_user_input(kind="confirm")` 询问“是否允许打开页面/浏览器进行桌面或手机视图视觉检查”，且不涉及删除/发布/支付/账号/参考站决策，应直接调用 `answer`（`confirmed: false, kind: "confirm", value: false` 并附无人值守跳过浏览器验收说明）让 Kooboo 结束本轮并交接后续评测。

## 5. AI 模型配置、额度或超时异常（`ai-model`）

- **典型信号**：Codex SDK 或 Kooboo AI 接口报 401、余额/配额不足、模型名无效、限流或请求连续超时。
- **正确处置**：单次网络抖动且有额度余地时可尝试 1 次 `retry`；若连续失败或提示余额/密钥无效，立即 `interrupt`，指导管理员检查「设置」中的模型 API Key、接口地址或余额。

## 6. 站点冲突或状态锁占用（`site-collision`）

- **典型信号**：目标站点名/子域名已被占用、任务中断恢复时目标站缺失或 Sandbox 已丢失。
- **正确处置**：检查报错是否为命名冲突；如果是，在 `userActions` 中提醒用户在当前中断卡片右侧的站点命名输入框直接修改站点名/子域名并重新提交。

## 7. 未预期运行时异常（`runtime`）

- 当以上分类均不命中且经过 `inspect_execution` / `get_conversation` 无法恢复推进时，`interrupt` 并清晰总结“当前做到哪一步、哪一步卡住了、重跑或人工检查前应先确认什么”，禁止把未消化的堆栈原文或 JSON 直接当给用户的提示。
- 若 `get_conversation` 因远端会话消息体过大而超时，且 `inspect_execution` 已返回明确终态（如 `failed` / `interrupted`），禁止重复重试 `get_conversation`，直接结合 `inspect_execution`、`get_task` 与 `probe_site` 的已有证据作出决策。

## 8. Kooboo 会话请求体超限（`413 Request Entity Too Large` / `payload_too_large_error`）

- **典型信号**：
  - `inspect_execution` 或 `get_conversation` 末条消息出现 `RequestEntityTooLarge`、`413 Request Entity Too Large`（`openresty` 网关 HTML）或 `payload_too_large_error` / `Failed to buffer the request body: length limit exceeded`。
- **正确处置**：
  - 历史中已读取的图片引用会在同一会话内持续带入请求，**严禁**对同一会话调用 `continue` 或 `retry`（即使要求“不再附加大图”也会立即再次失败）；必须直接 `interrupt`。
  - **严格核实实际写入进展**：对于 `upgrade`（旧站升级）任务，原样克隆的旧站本身就会返回 `HTTP 200`，**绝对不能仅凭 `probe_site` 为 200 就断定“新版首页已生成”**；必须结合 `get_conversation` 或 `inspect_execution` 确认是否真正调用过 `create_page` / `create_style` / `update_text_object`，在 `userSummary` 中如实告知用户“已生成待收尾”或“尚未写入新版页面”。
- **用户层建议**：告知用户不要删站重来，点击「换新会话继续」按钮（或在 Kooboo 后台为当前站点新建干净会话）即可保留站点与资料继续执行；若尚未写入任何新版页面，建议先压缩资料包中的超大实拍照片后再重新生成。
