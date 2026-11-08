# 生成浏览器无头模式讨论

日期：2026-11-08。用户反馈自动生成打开 Chrome for Testing 会抢夺焦点，询问无头模式对流程的影响。本轮只读项目及已安装依赖源码，未修改运行配置、重启服务或执行浏览器验收。

## 当前实现核对

- `server/automation/generation-session.ts:39` 用 `chromium.launchPersistentContext(profile, { headless: false })` 启动生成浏览器。每个任务使用 `.data/generation-browsers/<taskId>`；登录由已配置环境令牌写入 Cookie，不要求用户在弹出窗口手工登录。
- 生成通过加载完整 Kooboo AI Chat 页面，并用 `window.__koobooAutomation` 的 snapshot、deliver、selectConversation、acknowledgeUsage 接口执行。页面继续负责 stream/function-call 循环，状态读取和消息投递不依赖桌面窗口焦点。
- `server/automation/followup.ts` 复用 generationSession，因此生成和跟进需要同时遵守同一浏览器模式策略。
- `server/automation/browser.ts:14` 的评测浏览器已经 headless。生成模式切换应独立于评测配置。
- Kooboo `Frontend/src/api/ai/index.ts` 已设置 `openWhenHidden: true`；automation bridge 可暴露等待输入并接收程序化答复。它们是可行性证据，不是无头端到端成功证明。
- generator 的 `Transfer/ByLevel` 请求也有同名 headless 参数，但它属于服务端克隆方式，不能与生成浏览器窗口配置混为一谈或一起修改。

## 建议，尚未确认实施

正常自动化默认无头，保留显式有窗口的排障模式。生成仍运行完整 AI Chat 页面，沿用任务 profile、原站/原会话身份、投递回执、用量、取消和评测交接。无头运行失败不能自动另开有窗口浏览器重发委托。

优先考虑 `headless: true, channel: 'chromium'`，在不显示窗口的同时沿用完整 Chromium 可执行程序。当前安装的 Playwright 1.64.1 在 `node_modules/playwright-core/lib/coreBundle.js:44791` 的 getExecutableName 中明确：无 channel 且 headless 时选择 chromium-headless-shell；有 channel 时使用该 channel。应核对安装产物和健康检查，避免将换浏览器实现误当作单纯隐藏窗口。

人工直接观察窗口和临时点击会受影响；排障依靠平台状态、会话及证据，必要时明确停止/确认原执行后以有窗口模式恢复，避免同 profile 并发或重复生成。需要操作系统原生弹窗、文件选择器或特殊授权的工具要单独核验，不能用 bridge 的存在推断全部工具兼容。

首批真实验证应覆盖：登录/加载原会话、完整流与至少一次工具调用、等待输入后跟进、用量回收、可信终态到评测交接、取消与原 profile 恢复；记录是否出现窗口、任务成功率和异常。项目要求浏览器控制须单独获得用户授权，本轮未开展。无头不作为提高并发或减少模型 token 的依据；没有性能和真实任务验收数据前不承诺收益。

## 官方资料

下列为后续参考入口；本轮在线读取未取得正文，可执行程序选择的判断以本机依赖源码为依据。

- Playwright Browsers：`https://playwright.dev/docs/browsers`，Chromium headless shell 与 new headless mode 章节。
- Chrome Headless：`https://developer.chrome.com/docs/automation-and-testing/headless`。

结论：基于当前源码，切换具备明确可行性，核心自动化架构预计可保持；尚需以上真实流程验证，不能表述为已经跑通。

## 已确认与实施

用户确认全局配置项，随后明确授权实施。入口为“系统设置 → 任务执行 → 本机运行 → 高级设置 → 显示执行浏览器窗口”，默认关闭，不增加任务级配置或浏览器启动参数表单。

共享设置新增可选布尔字段 `showExecutionBrowser`，默认 false。既有加密配置缺少该字段时使用默认值；通过设置 API 显式开关可持久化，旧版客户端保存设置而不提供该字段时保留原值。前端沿用统一保存按钮及浮动成功消息。

生成与 AI 跟进复用的 generationSession 在启动时读取一次配置，以 `channel: 'chromium'` 固定完整 Chromium，关闭开关时 headless=true，开启时 headless=false。沿用任务原 profile、令牌注入、原会话、等待输入、投递回执、取消和清理。更改设置不会替换已运行的浏览器，浏览器启动失败也不会自动换模式或重发委托；评测浏览器及服务端克隆参数保持既有行为。

验证：生成配置与既有生成/跟进回归共 33 项，32 项通过，真实 Codex 沙箱用例按既有开关跳过。新增测试使用模拟浏览器覆盖旧配置默认、布尔校验、加密持久化、旧客户端保留设置、活动会话不受设置变更影响、恢复沿用 profile/会话、pending 答复、取消关闭和 profile 锁定时不重试。服务端 TypeScript 与设置页聚焦 Vue 类型检查通过。未控制真实浏览器、调用模型或宣称无头真实建站已验收。

前端及服务端生产构建通过（保留已有前端 chunk 大小警告），构建输出放在临时目录，未覆盖本机服务。4180 上的任务 `811861c7-5907-401f-84ee-be8ba171c98f` 仍在真实执行，后续进入 AI 跟进且有经验学习活动，因此本轮没有重启服务，设置入口及无头默认尚未在当前进程生效。待该流程空闲后再切换；工作树与当前运行构建还存在其他会话的改动差异，更新时需确认完整范围，避免覆盖其运行功能。未暂存或提交本轮改动。
