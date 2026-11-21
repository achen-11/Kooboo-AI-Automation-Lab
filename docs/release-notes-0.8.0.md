# v0.8.0：模板市场引用与旧版 Kooboo 防呆、任务资料补充、Harness 蓝图与单任务自动交付

本版本基于 `v0.7.16` 演进发布，重点包含四项核心能力，并针对 **Automation Lab 先行发布、部分 Kooboo 服务器（如 HK 环境）尚未同步更新** 的过渡期增加了多层防呆保护。

## 主要改进

### 1. Kooboo 模板市场引用与旧版环境兼容防呆保护
- **支持从 Kooboo 模板市场选取参考/基座模板**：
  - 资源创建/编辑支持切换「外部参考站 URL」或「Kooboo 模板市场」（`KoobooTemplatePickerDialog` 搜索或按模板 UUID 查询，不猜测默认预览域）。
  - 支持两种使用方式：**直接模板建站（`direct-template`）**（`Template/Use` 原位适配；`upgrade` 场景配合 `AISandbox/TransferByLevel` 做旧站只读源站角色对调）与 **克隆到参考 Sandbox（`reference-sandbox`）**（`AISandbox/ImportFromTemplate`，已有生成站继续生成时自动走隔离参考 Sandbox）。
- **旧版 Kooboo 环境多层防呆保护**：
  - 新增 `GET /api/automation/kooboo/capabilities` 无副作用能力探测（基于 Kooboo `ApiManager` 路由解析顺序，识别 `Api method Not Found` / `找不到API方法` / `404`，60 秒缓存，支持「重新检测」；对 `5xx`/网络超时记为 `unknown` 不误杀）。
  - **建站前硬拦截**：`executeGeneration` 在调用 `Template/Use` 或 `Site/Create` 建站之前先探测所需新接口；若目标环境为旧版 Kooboo，直接以环境不兼容提示停止执行，**不创建半成品站点**。
  - **选模板与建站弹窗提前提醒/拦截**：在 `KoobooTemplatePickerDialog` 与 `CreateTaskDialog` 提前提示当前环境不支持的模板模式并在提交时阻止误操作；非模板建站与非升级直接模板建站不受影响。

### 2. 任务资料补充与附件预览
- **面向中断/阻塞生成任务的资料补充弹窗（`TaskSupplementDialog`）**：
  - 支持 **人工补充**：直接上传补充文件（图片、文档/压缩包等），填写补充说明，替换原内容站/参考站地址（`overrideContentUrl` / `overrideReferenceUrl`），或标记跳过原站克隆（`skipSourceTransfer`）。
  - 支持 **AI 辅助收集整理**：输入参考/官网 URL 或原始素材后由 Playwright 抓取文本与图片并经本地 AI 整理草稿（`harness/intake/SKILL.md`），预览勾选或自动应用到任务。
  - 若任务因 `ask_user_input`（如请求上传媒体库图片或确认）挂起，应用补充资料时自动上传到目标媒体库/CMS 文件区、同步资料映射清单（`_automation-manifests/<taskId>.json`），并安全回答挂起调用或延续原会话。
- **附件在线预览弹窗（`MaterialPreviewDialog`）**：资源输入版本与资料列表中支持图片、文本/Markdown/JSON 等常见附件的快速在线预览与下载。

### 3. Harness 运行蓝图、双层人话诊断与 0 页克隆保护
- **Harness 运行蓝图与内置 SOP 同步**：集中管理 `harness/` 下 8 个阶段的运行规范、参考文档及设置页自定义状态；新增 `/harness` 蓝图查看页（`HarnessView`），未自定义的内置 SOP 随新版自动升级，用户手动修改保持保留并支持一键重置。
- **双层结果输出（人话摘要 + 技术详情）**：任务执行摘要、任务列表、通知与评测报告生成面向非开发同事的中文诊断结论（`humanNotice` / `humanSummary`，剥离 UUID、内部字段名、内部路径与时间戳），默认折叠保留完整技术排障细节。
- **0 页克隆防死循环保护**：`waitForTransferPages` 在源站克隆持续返回 0 页时避免无限轮询，旧版流程尝试 `Transfer/Single` 单页降级抓取 1 次；仍为 0 页时明确中断并给出排查建议与补充资料入口。

### 4. 单任务自动交付、环境默认偏好与交付主链接
- **单任务级自动跨环境交付**：在建站/评测创建弹窗支持按任务勾选「完成后自动跨环境交付」，并可一键保存为当前 Kooboo 环境的默认偏好；支持非优化任务在关闭全局自动评测时按 `autoDelivery=true` 强制补齐评测门禁后再触发交付；自动优化未达标停止时不自动交付。
- **交付主链接优先展示**：跨环境交付完成后，在任务列表、生成站卡片、任务详情与 `/api/v1/automation/tasks/:id/result` 中优先展示 `deliveredUrl`（标注「已交付」），同时保留源站链接入口。

## 兼容与升级提醒

- **关于 HK 等尚未更新的 Kooboo 环境**：
  - 既有建站流程（空白建站、站点迁移、外部参考站 URL 升级/模板）、自动交付、Harness 蓝图、双层人话诊断、0 页克隆保护与任务资料补充功能**均不依赖近期 Kooboo 后端改动**，可直接正常工作。
  - 若环境尚未更新至包含 `AISandbox/TransferByLevel` / `AISandbox/ImportFromTemplate` 的版本，请暂用「外部参考站 URL」替代 Kooboo 模板市场中的「旧站升级 + 直接模板建站」或「参考 Sandbox」模式（系统亦会自动提示并拦截）。
- 请通过原安装目录的 `npm start` 启动，在侧栏版本号或「系统设置 → 检查更新」中检查并安装更新；既有配置、数据与凭证均保留。

## 验证边界

- 验证覆盖全部相关 Node 后端与 Vue 组件自动化测试、Python 交付打包测试、全量 TypeScript / Vue 类型检查、生产构建与受管理更新包构建检查。
- 仅基于本地模拟 HTTP 服务与内存渲染完成了上述验证；**未执行**针对真实线上 HK / DE Kooboo 环境、真实外部 AI 模型调用、真实浏览器端到端生成或 Windows 实机在线升级的验收。详情见 `docs/release-validation-0.8.0.md`。
