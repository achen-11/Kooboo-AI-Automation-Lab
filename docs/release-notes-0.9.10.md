# Kooboo AI Automation Lab v0.9.10 发布说明

发布日期：2026-11-25

## 核心变更

### 1. 设置页交互与 Kooboo 连接体验优化
- **底部悬浮保存条与快捷键**：
  - 在「系统设置」与「Kooboo 连接」页面新增底部 `sticky` 悬浮保存条（含未保存状态提示、`放弃修改` 与 `保存设置` 按钮）以及 `⌘S / Ctrl+S` 快捷键保存，无需滚动回顶部。
  - 外层设置页支持记住当前标签页（`sessionStorage`），并在离开未保存的 `Kooboo 连接` 或 `评测模型` 标签页时弹出确认防丢；顶部补充 `添加环境` 与 `全部收起 / 全部展开`，新增环境自动展开、平滑滚动入视并聚焦名称输入框，移除已配置环境增加二次确认。
  - 各环境「测试连接」按钮仅受当前环境自身连接变更与登录状态约束；为默认迁移令牌、环境覆盖令牌、评测模型 API Key 与外部 API 令牌补充显示/隐藏切换。
- **浏览器窗口登录自动捕获 `jwt_token`（支持 Google / SSO）**：
  - 新增 `POST /api/environments/browser-login/start`、`GET /api/environments/browser-login/:sessionId` 与 `POST /api/environments/browser-login/:sessionId/cancel`（仅限本地会话），优先拉起本机正式 `Google Chrome`（回退 `Microsoft Edge` / `Chromium`）并复用独立登录 Profile，兼容 Google OAuth 弹窗与邮箱/手机/OTP 验证码流程。
  - 登录成功后自动捕获 `jwt_token`、验证 `Site/List` 权限并加密保存，同时保留「账号密码登录」与「高级：手动填写访问令牌」兜底入口。
- **「默认跨环境迁移服务」全局配置（优先默认 + 支持覆盖）**：
  - 支持在顶部统一配置默认迁移接口（内置默认 `https://launch.kooboo.nl/api/sitemigrate`，支持环境变量 `EVALUATOR_DELIVERY_ENDPOINT` / `EVALUATOR_DELIVERY_TOKEN` 预置）与加密保存的默认迁移服务令牌。
  - 若已有环境配置过迁移令牌且全局默认尚未设置，支持通过 `POST /api/settings/delivery-defaults/adopt-token` 在加密库内部一键复用为全局默认（全程不回显明文）；各环境勾选跨环境交付后默认直接继承，按需展开覆盖或一键恢复默认。

### 2. 生成后置流程与跨环境交付策略开关
- **按需关闭自动评测与经验学习**：
  - 「任务执行」设置页新增「后置流程开关」，支持配置生成完成后是否自动创建独立评测任务，以及是否启用经验沉淀与经验注入；创建任务弹窗同步支持 `仅生成（不评测）`、`生成并评测` 与 `自动优化到目标` 模式。
- **生成后直接跨环境交付与可选跳过 AI 视觉核验**：
  - 关闭自动评测后，支持在生成完成直接触发跨环境交付，并可在环境交付配置中按需关闭「迁移后启用 AI 双端截图核验」（关闭后仅执行目标站 HTTP 可达性检查，零额外 token），同步更新任务列表、工作流图与交付面板展示。

## 验证结果
- `npm run check`（服务端 `tsc --noEmit` 与前端 `vue-tsc --noEmit`）0 错误通过。
- `npm run build`（Vite 前端构建与服务端 TypeScript 编译）通过。
- 针对性测试集（`tests-node/delivery-defaults.test.ts`、`tests-node/environment-browser-login.test.ts`、`tests-node/environment-login.test.ts`、`tests-node/auto-delivery.test.ts`、`tests-node/delivery-diagnostics.test.ts`、`tests-node/site-delivery.test.ts`、`tests-node/workflow-graph.test.ts`、`tests-node/task-site-input.test.mjs`）全部通过。
