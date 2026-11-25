# Kooboo AI Automation Lab v0.9.11 发布说明

发布日期：2026-11-25

## 核心变更

### 1. 企业官网 UI 与版式硬约束（v1.2）融入生成、预检与 CHECKS 闭环
- **生成阶段硬约束注入（覆盖旧站升级、资料建站、迁移与模板适配）**：
  - 新增 `server/automation/site-ui-rules.ts` 与 `harness/generation/references/site-ui-rules.md`（注册至 `server/automation/harness.ts` 共 17 篇运行蓝图文档），并在 `server/automation/generator.ts` 中注入紧凑约束（≤ 1800 字符），兼顾 `direct-template` 原位改造与其他生成模式。
  - 针对参考站继承问题与本地化细节强化约束：强制可见文字 `>= 12px`（覆写参考站 10–11px 小字）、双栏图文失衡时按 `relative + absolute object-fit:cover` 或纵排多图重构、`<html lang>` 严格匹配目标主语种且非中文站禁止残留中文及原生 `<input type="date">`（避免隐式出现 `年/月/日`），以及按区块替换 CTA 场景词并遵循 H32 同页去重。
- **0-token 浏览器 DOM 预检扩展与探针降噪**：
  - 扩展 `server/automation/visual-precheck.ts` 对首屏安全线（`HERO_FOLD_CLIPPED`）、垂直居中（`HERO_OFF_CENTER`）、双栏图文失衡（`SPLIT_HEIGHT_IMBALANCE`）、标题行数超限（`TITLE_LINES_EXCEEDED`）、空旷区段（`SECTION_AIR_GAP`）、图片可见性（`IMAGE_VISIBILITY_ISSUE`）、同页重复（`CONTENT_DUPLICATION`）、最小字号（`MIN_FONT_SIZE`）、桌面吸顶导航/汉堡菜单（`NAV_NOT_STICKY`、`DESKTOP_HAMBURGER_NAV`）及语种/原生日期输入（`LOCALE_OR_DATE_ISSUE`）的检测。
  - 完成三项探针降噪：过滤 `>= 3` 个同宽（±15%）兄弟卡片网格与 `ARTICLE`/`LI`/`A` 容器防止误报 `SPLIT_HEIGHT_IMBALANCE`；移动端堆叠 Hero 结合首屏内主图底部修正 `centerPct`；将移动端 `H1` 距导航底最小间距阈值放宽为 `24px`，并自动关联 `ruleId`。
- **Phase 2 `CHECKS` 内置规则与增量播种**：
  - 在 `server/automation/bounded-checker-rules.ts`、`harness/evaluation/CHECKS.md` 与 `server/automation/checker-checks.ts` 中新增 `R-LAYOUT-04`（Major，维度 ≤ 75 / 视口 ≤ 78）、`R-TYPO-01`（Major，维度 ≤ 75 / 视口 ≤ 78）与 `R-DUPE-01`（Minor）三条内置规则及对应标定用例（`cal-r-layout-04-catch`、`cal-r-typo-01-catch`、`cal-r-dupe-01-catch`）。
  - 将 `CheckerChecksStore.seedDefaultsIfEmpty()` 升级为按规则与标定 `id` 增量幂等补齐，既有 `.data/` 数据库升级启动即可自动接入新种子规则且不覆盖人工定制修订。

### 2. 任务工作流图按已启用阶段动态适配节点（合入 `f51f881`）
- 优化 `server/automation/workflow-graph.ts` 与 `frontend/src/lib/workflow-graph-layout.ts`，根据任务实际启用的阶段动态收敛流程图节点，不再展示未开启的评测、质量门禁、自动优化或经验学习节点。
- 支持纯独立评测（单节点）、仅生成且不评测/不交付（紧凑 2 节点，并在开启全局 `learning.collect` 但尚无评测时正确隐藏学习节点）、生成后直连 HTTP 交付（3 节点）、多跳手动重评回溯生成祖先，以及评测未通过时将交付节点标记为跳过。

## 验证结果
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）0 错误通过。
- `npm run build`（Vite 前端构建、`tsc -p tsconfig.server.build.json` 与 `write-build-info.mjs`）通过。
- 针对性测试集（`tests-node/site-ui-rules.test.ts`、`tests-node/visual-precheck.test.ts`、`tests-node/checker-checks.test.ts`、`tests-node/bounded-checker-rules.test.ts`、`tests-node/harness-and-diagnostics.test.ts`、`tests-node/task-supplement.test.ts`、`tests-node/workflow-graph.test.ts`、`tests-node/workflow-graph-layout.test.ts`）全部通过。
