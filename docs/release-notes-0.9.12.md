# Kooboo AI Automation Lab v0.9.12 发布说明

发布日期：2026-11-26

## 核心变更

### 1. 克隆内容站原图优先复用策略
- 当任务配置了内容站且克隆成功（包括直接目标站克隆以及 `direct-template` 旧站升级下的角色对调 `sourceSandbox`）时，在首轮生成、续建委托、生成上下文（`generation-context.ts`）与有界持续优化规划（`bounded-optimization-planner.ts`）阶段均自动注入真实原图复用引导。
- 明确要求优先复用原内容站已导入或 `sourceSandbox` 中的真实图片资源，严禁把可用原站图片替换成 `imagePlaceholder`，仅在原站及资料包确无可用配图的非豁免展示位使用 `imagePlaceholder` 真实配图。

### 2. 外部反馈四层蒸馏沉淀与 `upgrade` 品牌色双向对齐
- **生成与评测双向对齐（选项 A）**：`upgrade` 场景保持参考站布局与版式节奏，但品牌主色、强调色与 Logo 优先对齐原内容站及商家行业气质（仅在原站无明确品牌色时沿用参考站色板）；同步调整 `shared/automation.ts`、`server/automation/site-ui-rules.ts` 与评测端 `server/automation/bounded-checker-rules.ts`，消除生成端与评测端色彩标准冲突。
- **新增 L1 确定性 DOM / 视觉探针信号（`server/automation/visual-precheck.ts`、`browser.ts`）**：
  - 扩展 `HERO_FOLD_CLIPPED.overlayCardBottom`，拦截 PC/移动端首屏 Hero 浮层信息卡被视口底边截断。
  - 新增 `LOW_RES_IMAGE_UPSCALE`（识别 `naturalWidth < 600px` 低清旧图被拉伸至宽幅横幅或大图容器）、`HOMEPAGE_SUBPAGE_LINK`（识别 `homepage` 范围下仍指向未生成子页的 404 死链）与 `EXTERNAL_OR_INSECURE_ASSET`（识别残留未本地化外链与 `http://` 混合内容资源）。
  - 收紧 `CONTENT_DUPLICATION`：捕获同一张业务实拍图在同页重复使用 `>= 2` 次，以及首屏 Hero 创立年份/定位徽章连续复读（`heroRepeatedBadges >= 2`）。
- **新增 L2 红线 `R-TRUST-01` 与 compact 生成硬约束（`site-ui-rules.ts`、`CHECKS.md`、`checker-checks.ts`）**：
  - 完整保留原站多热线与 `tel:` / `mailto:` 转化入口（严禁文案写 24/7 却丢失紧急手机热线）；缺合作品牌 Logo 时直接删去或改纯文字信任条，严禁把实拍照片缩成灰白小图冒充 Logo 墙，严禁在仅首页范围生成 404 子页死链或残留外部图片资源。

### 3. 沉淀知识接入「AI 蓝图（`#/harness`）」并彻底移除旧经验库与自动复盘
- 新增 Git 跟踪的 `harness/distillation/SKILL.md` 与 `harness/distillation/references/pattern-ledger.md`（收录脱敏规律台账 `PAT-001`–`PAT-010` 与 L1 确定性探针目录），并注册至 `shared/harness.ts` 与 `server/automation/harness.ts`（共 16 篇蓝图文档、8 个阶段、4 项可覆盖 SOP），在「AI 蓝图」界面透明可读。
- 彻底移除旧动态经验库与弱模型自动复盘机制（删除 `ExperiencesView.vue`、`LearningSettings.vue`、`TaskLearning.vue`、`experience.ts`、`experience-store.ts`、`learning-api.ts`、`shared/experience.ts` 与 `harness/experience/`），将 `PLATFORM_HARD_CONTRACTS` 迁移至 `server/automation/followup-context.ts`。
- 完整保留 `.data/` SQLite 历史表列、旧配置加载兼容，以及历史 `experience` 用量/耗时/诊断导出数据的只读展示兼容。

### 4. 稳定性与会话交接修复（合入 `ac3e438`、`3bfcc19`）
- 新增 Kooboo 生成会话 413 溢出防护与同站新会话无缝交接机制。
- 收敛源站克隆轮询超时预算，并防止环境回退克隆完成后仍误报 `source-access` 中断。

## 验证结果
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（0 错误）。
- 针对性测试集（110 项 TypeScript 测试 + 13 项 Vue 组件测试，覆盖 `harness-and-diagnostics`、`task-supplement`、`budget-recovery`、`workflow-graph`、`workflow-graph-layout`、`automation-performance`、`template-efficiency`、`template-workflow`、`generation-context`、`dispositions`、`template-workflow-components`、`task-recovery-component`）：123/123 全部通过。
- `npm run build`（Vite 前端生产构建与服务端编译）：通过。
