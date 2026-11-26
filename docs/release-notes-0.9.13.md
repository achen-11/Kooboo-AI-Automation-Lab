# Kooboo AI Automation Lab v0.9.13 发布说明

发布日期：2026-11-26

## 核心变更

### 1. 克隆环境回退自动交付修复（`P16`）
- 修复从无跨环境交付配置的环境（如德国）克隆 0 页并自动回退至已开启自动交付的备用环境（如厦门）后，`homepage` 等任务完工未自动触发跨环境交付的问题（`server/automation/generator.ts`、`worker.ts`、`workflow-graph.ts`）。
- 改为在回退链路最终落定（克隆成功或降级用资料包）时才按最终环境的 `resolveEnvironmentDelivery` 同步 `task.autoDelivery`，避免多跳回退中中间环境的 `auto=true` 策略污染最终环境；同时保留人工显式关闭的 `autoDelivery=false`，并在回退到无交付环境时清理过时标记。
- 移除 `shouldAutoDeliver` 与 `workflow-graph.ts` 在 `autoDelivery === undefined` 兜底分支中陈旧的 `scope === 'site'` 限制。

### 2. 任务中心批量一键交付
- 后端 `GET /api/automation/site-deliveries`（`server/automation/site-delivery.ts`、`shared/site-delivery.ts`）按 `queueDelivery` 同一套门禁与冻结阈值实时计算每行 `deliveryAction`（区分 `unsupported-env`、`missing-token`、`require-passed`、`already-delivered`、`archived`、`in-progress` 等），并新增 `delivery=undelivered` / `delivery=deliverable` 筛选及 `deliverableCount` / `undeliveredCount` 统计。
- 前端任务中心（`frontend/src/views/automation/SiteDeliveryList.vue`）新增「**批量交付**」入口：
  - 筛选未跨环境交付的站点（包括已停机但生成与评测完成且满足门禁的站点），**未启用交付的环境或暂不满足条件的站点复选框自动置灰并显示原因**，表头全选仅勾选可交付项；
  - 轮询刷新时自动裁剪已失格的勾选，支持普通模式与批量模式下点击「**一键交付**」批量排队并展示逐项失败明细与 `?tab=delivery` 跳转链接。

### 3. 升级站首页根路由校正（`P15`）与接口兼容
- 当旧首页被改名保留 `DefaultStart` 而 `/` 已有在线页面时，`reconcileRootHomepageUrl`（`server/automation/kooboo.ts`）自动校正 `siteUrl` 并同步 `Page/DefaultRouteUpdate`；`site-ui-rules.ts` 禁止改名旧首页路由。
- `koobooClient` 安全兼容空响应体；`server/automation/site-domains.ts` 与 `tests-node/site-domains.test.ts` 补齐对应域名校验覆盖。

### 4. L1 视觉预检与运维资源清理增强
- 新增 L1 WCAG 对比度、地址去重、吸顶滚动探针并更新规律台账（`server/automation/visual-precheck.ts`、`harness/distillation/references/pattern-ledger.md`）。
- 任务确认到达终态后自动清理可再生的生成浏览器配置目录（`server/automation/generation-cache.ts`、`scripts/trim-generation-cache.ts`），并增加过期离线排障导出目录的启动与定时自动清理（`server/diagnostics/service.ts`）。

## 验证结果
- `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（0 错误）
- 针对性测试集（11 个测试文件，覆盖 `clone-environment-fallback`、`auto-delivery`、`workflow-graph`、`site-delivery`、`site-delivery-list-component`、`worker`、`diagnostics`、`generation-cache`、`site-domains`、`site-ui-rules`、`visual-precheck`）：107/107 全部通过
- `npm run build`（Vite 前端生产构建与服务端编译）：通过
