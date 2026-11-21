# v0.8.1：源站克隆停滞防死等与准备阶段进度提示修复

本版本基于 `v0.8.0` 发布，针对排查实际任务排障包发现的 **源站克隆部分页面卡死导致任务静默空转 60 分钟** 问题进行修复；**无需修改 Kooboo 服务端**即可生效。

## 问题根因

在 `upgrade` 场景准备阶段（`prepare`）等待 Kooboo 源站克隆时：
1. 当 Kooboo 侧部分内页抓取出错、挂起或服务进程波动，留下少数永久未完成（`done = false`）的 `TransferPage` 记录时，`Transfer/GetStatus` 仍会持续返回非空页面列表。
2. 原 `waitForTransferPages` 在页面列表非空时只判断 `pages.every(p => p.done === true)`，既没有停滞超时与总等待上限，也没有交叉查询 `Transfer/GetTaskStatus` 兜底，导致任务一直空转到单任务 60 分钟超时（`timeoutMinutes: 60`）。
3. 由于一直未进入后续 AI 生成阶段，模型用量为零；且轮询期间未记录进度事件或刷新 `updatedAt`，任务列表和概览页均看不到任何提示。

## 主要改进

### 1. 源站克隆停滞检测与兜底放行（`waitForTransferPages`）
- **停滞检测（2 分钟）**：跟踪 `Transfer/GetStatus` 中总页数与已完成页数的变化时间；若连续 **120 秒**没有任何推进（与 .NET 默认请求超时及 Kooboo `Transfer/GetTaskStatus` 的 2 分钟任务 TTL 对齐），自动触发 `Transfer/GetTaskStatus` 交叉核验。
- **克隆等待上限（5 分钟）**：即使进度缓慢推进，单次克隆等待最多持续 **300 秒**，避免准备阶段长期占用执行队列。
- **按实得页面数分流处理**：
  - 若已有页面实际入库（`pages > 0`，例如首页及部分页面已完成），记录“部分完成、保留已导入页面并继续后续流程”的明确事件后放行进入资料导入与生成阶段；
  - 若核验确认仍为 `pages = 0`，则沿用 `v0.8.0` 的 `Transfer/Single` / 源站 Sandbox 兜底重试与 `FollowupRuntimeError` 人话中断引导。

### 2. 克隆阶段可见进度事件与更新时间刷新
- 在旧版 `Transfer/ByLevel` 克隆等待开始时立即写入事件「正在等待内容站克隆完成：...」。
- 等待期间每 15 秒向任务事件流写入一次「已完成 X/Y 页（已等待 N 秒）」并同步刷新任务更新时间，使任务列表「最近更新」、任务详情「最新进展」和「执行记录」都能直接看到当前克隆状态。

## 兼容与升级说明

- **无需更新 Kooboo 服务端**：本次修复完全位于 Automation Lab 调度与等待逻辑层，可直接兼容当前 HK / DE 等已有 Kooboo 环境。
- 请通过原安装目录的 `npm start` 启动，在侧栏版本号或「系统设置 → 检查更新」中检查并安装更新；既有配置、数据与凭证均保留。

## 验证边界

- 验证覆盖新增 `tests-node/transfer-wait.test.ts`（模拟部分页面永久卡死、0 页停滞、慢速推进触达上限、正常快速完成、恢复时 `GetTaskStatus` 快捷放行与 `executeGeneration` 进度事件写入）及相关核心 Node 回归测试、Python 交付打包测试、全量 TypeScript / Vue 类型检查与生产构建。
- 以上验证基于本地模拟 HTTP 服务与内存测试；**未执行**针对真实线上 HK / DE Kooboo 环境、真实外部 AI 模型调用或实机在线升级流程的端到端验收。详情见 `docs/release-validation-0.8.1.md`。
