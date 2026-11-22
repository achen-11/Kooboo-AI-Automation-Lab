# v0.9.0：Verification Engineering 有界评测、单步优化规划与 `CHECKS.md` 一错一规闭环

本版本合入 `v0.8.3`（`d83f041`）的 Kooboo 非 RFC 4122 GUID 校验兼容及跨环境交付脱敏诊断修复，并正式交付 **Verification Engineering（独立 Checker 有界重构 Phase 1–3）** 与 **单步有界优化规划**。无需修改 Kooboo 服务端即可生效。

---

## 核心特性与改进

### 1. 有界多模态评测管道（首页 · 多页全站 · 跨环境 `delivery`）
- **三段式架构（替代自由 Shell 探索）**：
  - **Stage 1（宿主确定性取证与预检）**：统一由宿主运行 `take_page_screenshots`（PC `1440×1000` / Mobile `390×844`，支持基于 `startY / nextStartY` 续采至 40 屏）、SHA-256 证据登记与 DOM/交互探针（`visual_precheck`，含 `HERO_SVG_PLACEHOLDER` 识别、`MOBILE_MENU_TRAPPED` 移动菜单展开/关闭探针、`internalLinks / seoMeta`、页内 `#anchor` 检测）。
  - **Stage 2（`read-only` 多模态有界评判）**：禁止网络与自由脚本，由宿主按视口与纵向切片拆分批次（每批 `<= 12` 图、并发度 `2`、`maxOutputTokens = 32768`），配合 `bounded-batch-cache.json` 断点缓存及 `code 1` 单批新会话自动重试（不拖垮并发兄弟批）。
  - **Stage 3（宿主硬封顶与范围清理）**：在 `applyBoundedVerdictCaps` 层硬性执行 `Critical ≤ 55`、`R-VISUAL-01 Major ≤ 70/75`、`R-LAYOUT-03 Major ≤ 72/75` 与通用 `Major ≤ 72/78` 并阻断 `ready` verdict；统一固化 `defaultOutOfScope`（含仅静态截图不可观测的 hover / 手风琴切换 / 路由跳转提示），恢复合格站 `passed` 通道。
- **跨环境 `delivery` 与 `.docx`/文件名兼容**：
  - `verifyDelivery` 改由宿主预采集目标/源站双端截图并运行单轮只读核验（剥离 `sourceReport.artifacts` 历史证据文件名避免死循环）；同步保留并合入 `v0.8.3` 的 `z.guid()` 校验及 `executeDelivery` 失败响应体/链路头脱敏诊断。
  - 修复 Kooboo 路由 `+` 转空格导致文件校验误报（`koobooSafeFilename`），并支持 `.docx` 补充资料纯文本兜底解析。

### 2. 单步有界优化规划与活跃场景闭环
- **单步只读多模态优化规划器（[`bounded-optimization-planner.ts`](../server/automation/bounded-optimization-planner.ts)）**：
  - 针对无工具诊断阻塞的 `materials / upgrade / migration` 自动优化，跳过原先 20+ 次的自由读库循环，由宿主预先聚合任务与最新/基线报告截图（上限 `12` 张 / `16 MiB`），通过 `sandboxMode: 'read-only'` + `networkAccessEnabled: false` 单步规划（含 `1/1` 本地格式修正），并由宿主强强制 Round 0 `improved: false`、防高分稳定区段退化与禁止公开页面泄露内部制作口径文案。
- **`materials` 自动优化与同修订报告识别**：
  - 放开 `materials` 场景启用「自动优化到目标」，按是否存在参考 URL 自适应检查 `optimizationEvidence`；当同修订手动重评已发布有效报告时，报告视图自动识别切换至最新有效报告。
- **场景入口收敛（历史只读兼容）**：
  - 新建资源与自动化主入口聚焦三大活跃场景（`materials` / `upgrade` / `migration`），历史 `site-template` / `app-template` 数据与报告完整保留只读兼容。

### 3. `CHECKS.md` 一错一规闭环与自动回归测试集（Phase 3）
- **版本化红线库（[`checker-checks.ts`](../server/automation/checker-checks.ts) & [`harness/evaluation/CHECKS.md`](../harness/evaluation/CHECKS.md)）**：
  - 默认内置 4 条核心种子红线（`R-VISUAL-01`、`R-VISUAL-02`、`R-LAYOUT-03`、`R-COVER-04`）与 5 条基线标定反例；人工新增/修订的规则、豁免条款、版本历史恢复记录与标定反例统一持久化在本地 SQLite，不反向改写源码 `CHECKS.md`。
- **评测主链路动态冻结与缓存联动**：
  - 每次单页与多页全站有界评测按任务 `scenario × scope` 冻结并写入工作目录 `CHECKS.md`（Hashes 记入 `report.checksSnapshot`），动态生成 `ruleId` Zod/JSON Schema 使新增规则编号即时生效，并在规则变更后自动失效旧批次缓存。
- **报告一键沉淀 UI 与回归验证台**：
  - 评测报告「问题清单」及每条问题卡片提供 **「沉淀为 CHECKS 规则」** 弹窗（[`PromoteCheckRuleDialog.vue`](../frontend/src/views/automation/PromoteCheckRuleDialog.vue)），支持「**新增红线规则（漏判/虚高）**」与「**追加规则豁免（误判纠偏）**」双模式，并直接勾选本次报告真实 PNG 作为标定夹具。
  - 「评测规则 → 红线规则（CHECKS.md）」管理台与 CLI 脚本 [`scripts/checks-regression.ts`](../scripts/checks-regression.ts) 支持一键运行 **0 Token 确定性回归（Prompt 注入 + 宿主封顶 + 磁盘 PNG 校验）**，CLI 另支持 `--live --case <id>` 读取真实磁盘 PNG 调模型复验。

---

## 合入 `v0.8.3` 修复明细
- 完整保留 `v0.8.3`（`d83f041`）的 `z.guid()` 非 RFC 4122 Kooboo GUID 校验扩展、`executeDelivery` 非 2xx / 畸形回执脱敏诊断留存，以及 [`server/app.ts`](../server/app.ts) / [`server/background-entry.ts`](../server/background-entry.ts) 的 `Bearer` 脱敏正则修正。
