# v0.8.2：创建任务默认自动交付偏好冻结修复

本版本基于 `v0.8.1` 发布，修复排查实际排障包发现的 **API 创建任务未传 `autoDelivery` 时，环境「默认开启（任务完成后自动交付）」偏好在仅首页（`scope: "homepage"`）等任务上未自动生效** 的问题；**无需修改 Kooboo 服务端**即可生效。

## 问题根因

1. 在 `v0.8.0` 引入单任务 `autoDelivery` 与环境默认交付偏好（`env.delivery.auto`）后，平台前端 `CreateTaskDialog.vue` 在环境已启用交付且具备迁移令牌时，会主动把 `env.delivery.auto` 读出并随创建请求显式传给后端。
2. 但当外部系统（如 `kooboo-workbench`）或脚本直接调用 `POST /api/automation/tasks` 且请求体省略 `autoDelivery` 时，后端不会从环境的 `delivery` 配置补齐并冻结 `task.autoDelivery`，而是保持为 `undefined`。
3. 评测完成后，`AutomationWorker.shouldAutoDeliver()` 在 `autoDelivery === undefined` 时会退回旧版兼容兜底逻辑 `config.auto && evalTask.scope === 'site' && ['migration', 'upgrade'].includes(evalTask.scenario)`，导致 `scope: "homepage"` 或其他场景在已开启 `env.delivery.auto = true` 时被静默跳过、既不入队交付也不写入失败事件或通知。

## 主要改进

### 1. 创建任务事务内按环境配置冻结默认 `autoDelivery`（`POST /api/automation/tasks`）
- 在 `server/automation/api.ts` 的幂等创建事务内，结合目标环境配置与目标站点交付状态解析 `defaultAutoDelivery`：当请求未显式传入 `autoDelivery`、目标环境已启用跨环境交付且关联站点尚未有过交付记录时，冻结为 `Boolean(env.delivery.token && env.delivery.auto)`。
- 保持原有幂等请求哈希基于原始请求体计算，使同一 `Idempotency-Key` 重试始终返回创建时已冻结的 `autoDelivery` 状态，不受后续环境设置切换影响。

### 2. 非致命兜底与优先级约定（`AutomationStore.create`）
- 在 `server/automation/store.ts` 中保持优先级：`显式传入 input.autoDelivery` > `父任务 parent.autoDelivery` > `环境默认 defaultAutoDelivery && Boolean(rule)`。
- 未显式传入 `autoDelivery` 时，如遇到缺少迁移令牌或当前场景/范围无适用已发布评测规则（包含混合场景批量建任务），不会误触发 `409` 拦截，而是安全冻结为 `autoDelivery: false`（站点已交付或环境未启用交付时保持 `undefined`）；显式传入 `autoDelivery: true` 的前置校验与历史直接调用 `store.create` 的旧任务兼容逻辑均保持不变。

## 兼容与升级说明

- **无需更新 Kooboo 服务端或调用方即可生效**：本次修复位于 Automation Lab 服务端创建任务接口层，调用方省略 `autoDelivery` 时即可自动继承目标环境的默认交付偏好；调用方也可继续按需显式传 `true` / `false` 覆盖。
- 请通过原安装目录的 `npm start` 启动，在侧栏版本号或「系统设置 → 检查更新」中检查并安装更新；既有配置、数据与凭证均保留。

## 验证边界

- 验证覆盖 `tests-node/auto-delivery.test.ts` 新增端到端用例（模拟 `kooboo-workbench` 省略 `autoDelivery` 发起 `upgrade` + `homepage` 任务、自动转交评测并在高分 `failed` 且 `requirePassed=false` 时自动入队交付；`auto=false` 冻结及幂等重放不回溯触发；缺失令牌/无适用规则/已交付站点/未启用交付环境非致命降级；父任务 `autoDelivery=false` 优先于环境默认）及相关核心 Node 回归测试、Python 交付打包测试、全量 TypeScript / Vue 类型检查与生产构建。
- 以上验证基于本地模拟 HTTP 服务与内存测试；**未执行**针对真实线上 HK / DE Kooboo 环境、真实外部 AI 模型调用或实机在线升级流程的端到端验收。详情见 `docs/release-validation-0.8.2.md`。
