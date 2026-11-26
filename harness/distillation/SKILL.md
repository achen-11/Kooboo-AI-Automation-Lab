# 反馈蒸馏与四层沉淀规范（Feedback Distillation）

外部评测、客户走查与同事复盘不再通过“弱模型自动复盘写入动态经验库”处理，而是通过 **人工/强模型评审 + 四层工程化分流** 沉淀进平台内置确定性能力与紧致规则中，并通过「AI 蓝图」对团队透明展示。

## 核心原则

1. **四层漏斗优先（`L1 > L2 > L3 > L4`）**：
   - **L1 · 确定性探针层**（`server/automation/visual-precheck.ts`、`browser.ts`）：首屏裁剪、低清图拉伸、重复图片 `src` / 重复徽章、仅首页子页死链、未本地化 `http://` 外链、图文等高失衡等可 100% 机检的客观信号，直接用代码拦截，绝不靠提示词硬扛。
   - **L2 · 评测红线与标定层**（`harness/evaluation/CHECKS.md`、`bounded-checker-rules.ts`、`checker-checks.ts`）：需要视觉与语义综合判定的高频反模式，绑定 `ruleId`、豁免条件与宿主封顶口径。
   - **L3 · 紧凑生成硬约束层**（`server/automation/site-ui-rules.ts`、`harness/generation/references/site-ui-rules.md`、`shared/automation.ts`）：必须在首轮生成即预防的普适约束，严格守住 `buildSiteUiHardRulesPrompt <= 1800` 字符预算，禁止堆砌提示词。
   - **L4 · 业务画像 / 任务输入层**：特定营销偏好（如外联控高、特定双语开关）先观察或按任务配置触发，避免污染全局硬规则。
2. **生成与评测双向对齐**：任何涉及风格、色彩策略或内容取舍的规则改动（如旧站 `upgrade` 场景的品牌色优先），必须同时校验生成端与评测端规则，严禁前后打架。
3. **晋升门槛**：客观技术/转化缺陷 1 次确认即晋升落地；审美或版式偏好先写入台账标记 `observing`，待 `>= 2` 个独立站点复现后再评估晋升。
4. **严格脱敏红线**：含真实客户名称、域名、电话、邮箱、地址的原始反馈只保存在本地未入库的 `.diagnostics/feedback/` 目录；进入 `harness/distillation/references/pattern-ledger.md` 的内容必须完全脱敏。

## 关联台账

- 已脱敏规律台账与 L1 确定性探针目录见：[pattern-ledger.md](references/pattern-ledger.md)
