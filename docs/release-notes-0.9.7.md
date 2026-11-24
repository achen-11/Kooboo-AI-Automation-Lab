# v0.9.7：参考站预检硬停机、首轮 `upgrade` 重构防误用与默认 `/responses` + `deepseek-flash`

本版本基于 `v0.9.6`（`16a6a9b`）发布，围绕排障复盘中暴露的“参考站不可达或无图时默认自由发挥”“首轮 `upgrade` 误沿用源站样式”以及“默认评测接口与模型名过期”三个核心问题完成全链路加固。

---

## 核心改进

### 1. 参考站可达性前置预检与建站前人工决策闭环
- 新增 [`reference-preflight.ts`](../server/automation/reference-preflight.ts) 与 [`generator.ts`](../server/automation/generator.ts) 建站前预检门禁：对 `upgrade` 与非模板工作流的 `site-template` 外链 `referenceUrl`，在创建 Kooboo 站点及消耗模型 Token 之前先执行快速 HTTP 检测，并在遇到 `401/403/429`、疑似 WAF/Cloudflare 挑战或空白 SPA 壳时自动升级到 Playwright Chromium 二阶段实测。
- 预检失败立即中断并保留零站点消耗状态，支持操作者在 [`TaskSupplementDialog.vue`](../frontend/src/views/automation/TaskSupplementDialog.vue) / 补充资料接口（[`supplement.ts`](../server/automation/supplement.ts)、[`supplement-api.ts`](../server/automation/supplement-api.ts)）完成三选一人工决策：
  1. **更换参考站 URL**：人工恢复或提交补充后清理失败 preflight 标记并重新校验；
  2. **手动上传参考截图并跳过外链预检**：标记 `skipReferencePreflight`，**不**误跳过健康内容站（`contentUrl`）克隆；
  3. **明确授权无参考自由设计**：标记 `allowFreeDesignWithoutReference`，明确授权后才允许仅依据内容站与资料包自由设计。

### 2. AI 跟进护栏与 `upgrade` 视觉强约束
- [`followup.ts`](../server/automation/followup.ts)：`validateFollowupAction` 禁止 Followup Agent 对涉及参考站失败、图片补充或自由设计决策的 `ask_user_input`（含 `choice`/`confirm`/`text`/`upload`）自动调用 `answer` 代答，强制 `interrupt` 交由人工决策。
- [`generation-reference.ts`](../server/automation/generation-reference.ts) 与 [`automation.ts`](../shared/automation.ts)：将 `upgrade` 纳入严格参考视觉还原契约与硬停机护栏（禁止因图片尺寸偏小或品牌名偏长擅自改版，保留真实业务图片素材），并与 `direct-template`、`skipReferencePreflight` 及 `allowFreeDesignWithoutReference` 模式清晰区分。

### 3. 修复首轮 `upgrade` 措辞误导
- [`generation-context.ts`](../server/automation/generation-context.ts) 与 [`generator.ts`](../server/automation/generator.ts)：区分首轮 `upgrade` 重构与续改/修复/模板原位适配（通过 `isInitialDelivery`、`parentId`、`repairEvidence`、`optimizationRound`、`deliveryId` 及 `direct-template` 判定）。
- 首轮 `upgrade` 不再下发容易误导 AI 的“沿用已有内容与实现”，明确要求把目标站克隆自源站的页面/CSS 仅作内容与事实基线、严格按参考站视觉重建，并清理克隆带入的第三方预览横幅/脚本（如 `launch.kooboo.nl/banner.js`）。

### 4. 默认接口与模型统一为 `/responses` + `deepseek-flash`
- [`shared/automation.ts`](../shared/automation.ts)、[`bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts)、[`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 与 [`vault.ts`](../server/lib/vault.ts)：将默认评测模型由已下线的 `deepseek-flash-1017` 调整为 `deepseek-flash`，默认接口设为 `https://api.deepseek.com/responses`，并在读取设置时自动将遗留 `/chat/completions` 规范为 `/responses`。
- [`frontend/src/views/automation/SettingsView.vue`](../frontend/src/views/automation/SettingsView.vue) 与 [`frontend/src/views/SettingsView.vue`](../frontend/src/views/SettingsView.vue)：直接展示与保存完整 `/responses` 接口并在保存评测模型时同步清理遗留 `/chat/completions` 字段。
- [`usage-proxy.ts`](../server/automation/usage-proxy.ts)：当模型上游返回非 2xx 错误时，安全提取脱敏后的错误详情附加至任务事件与异常说明，便于快速定位接口/模型配置问题。

---

## 验证记录
- **类型检查、针对性单测与构建**：`npm run check`、`npm run build` 及相关 `tests-node/` 回归测试通过（`tests-node/reference-preflight.test.ts`、`followup.test.ts`、`generation-context.test.ts`、`generation-reference.test.ts`、`automation.test.ts`、`usage-proxy-terminal.test.ts` 等；既有真实 Codex 沙箱用例在沙箱隔离下按原逻辑跳过）。
- **真实模型与站点端到端验证**：
  - 本机配置 `https://api.deepseek.com/responses` + `deepseek-flash` 后，`POST /api/automation/model/test` 真实图片识别与工具调用验证通过（`ok: true, vision: true, tools: true`）。
  - 使用原站 `http://www.annekeboot.com/` 与参考站 `https://caac1cf62aee48b5b3204b43205b39e0.devday.cn` 在香港 Kooboo 环境实跑 `upgrade / homepage`（即使远端无 headless 截图，AI 仍通过参考 Sandbox `agentReady: true` 读取设计体系完成视觉重建），独立有界多模态评测原始得分桌面端 `83.2` / 移动端 `82`（`hero` 86/88、`structure` 88/83 均通过；因前台文案暴露平台名称命中文案红线 `R-CONTENT-02` 硬封顶至 `78`）。
