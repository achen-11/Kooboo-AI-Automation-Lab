# Kooboo AI Automation Lab v0.9.9 发布说明

发布日期：2026-11-24

## 核心变更

### 1. 外部 Admin 资源导入 API（`POST /api/v1/resources/import`）新增 `skipSourceTransfer` 配置并同步系统设置文档
- **资源级 `skipSourceTransfer` 与 `fallbackToMaterialsOnCloneFailure` 透传**：
  - `POST /api/v1/resources/import`、`POST /api/automation/resources` 与 `PUT /api/automation/resources/:id` 新增可选布尔字段 `skipSourceTransfer` 和 `fallbackToMaterialsOnCloneFailure`，保存在资源及其输入版本（`InputVersion`）中。
  - 创建生成任务（`POST /api/automation/tasks` 或从 Web 界面弹窗发起）时，若任务请求未显式覆盖，自动继承资源版本上的 `skipSourceTransfer` 配置。
- **「系统设置 → 外部 API」文档与资源详情同步**：
  - 更新「系统设置 → 外部 API → 外部 Admin 资源导入」请求示例与可选字段说明表。
  - 在资源编辑弹窗、资源详情、版本历史以及任务「输入与配置」页面展示当前资源的「原站克隆策略」。

### 2. 不传 `skipSourceTransfer` 时，多跳回退服务器全部克隆失败后默认自动触发资料包兜底
- **全链克隆 0 页默认自动降级为资料包继续生成**：
  - 对于 `upgrade`（旧站重构升级）生成任务，当未传 `skipSourceTransfer`（或传 `false`）且资源附带了资料包（`files` 非空）时，`fallbackToMaterialsOnCloneFailure` **默认自动开启（`true`）**（创建任务弹窗中亦默认勾选）。
  - 执行顺序：
    1. **显式传 `skipSourceTransfer: true`**：直接跳过原站克隆与跨环境回退，在所选环境建站并导入资料包生成；
    2. **未传 `skipSourceTransfer`（或为 `false`）**：优先在当前环境及回退环境链（如 `德国 -> 香港 -> 厦门`）依次尝试克隆原站；
    3. **回退链上所有服务器均克隆失败（0 页）**：只要资源附带了资料包（`files` 非空）且未显式禁用兜底（`fallbackToMaterialsOnCloneFailure !== false`），系统自动转为跳过原站克隆并用随附资料包继续生成，避免无谓停机；
    4. **无资料包或显式关闭自动兜底**：以 `source-access` 终态立即止损停机（0 Followup Token、0 经验复盘 Token）。

## 验证结果
- `tests-node/clone-environment-fallback.test.ts`（9 项测试全过，含 `POST /api/v1/resources/import` 传入 `skipSourceTransfer: true` 的自动继承，以及不传时 `fallbackToMaterialsOnCloneFailure` 默认自动开启并在全链 0 页后自动降级用资料包继续生成）。
- `npm run check`（前后端 TypeScript 类型检查 0 错误）与 `npm run build` 构建通过。
