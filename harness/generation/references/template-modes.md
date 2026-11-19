# Kooboo 模板市场与旧站升级模式（Template Modes）

当任务选用 Kooboo 模板市场作为设计参考时，支持两种使用模式（`templateUsageMode`）：

## 1. 直接基于模板构建（`direct-template`）

适用场景：新建站点或 **旧站升级（`upgrade`）+ Kooboo 模板**（未指定保留旧站点直改时默认启用）。

### 角色对调原则（Role-Swap）

在「旧站升级 + 直接使用模板」下，为避免 AI 从零手写模板源码或误在原站点结构里破坏模板组件：

1. **目标生成站**：直接导入选定的 Kooboo 模板（原生语法、组件、样式与版式完整就绪）。
2. **只读源站 Sandbox（`sourceSandbox`）**：通过 `AISandbox/TransferByLevel` 将用户的 **旧内容站（`contentUrl`）** 克隆到只读源站 Sandbox 中。
3. **预览与评测对齐**：
   - 在目标生成站中，AI 从 `sourceSandbox` 和已导入资料包读取真实业务文案、产品/文章数据与合法图片，套用并替换到目标 Kooboo 模板中。
   - 独立评测时，若需要视觉设计对照，仍以模板市场在当前环境的预览地址（`previewUrl`）作为视觉参考基准，而真实内容完整度以 `sourceSandbox` 与资料包为准。

## 2. 模板仅作 Sandbox 视觉参考（`reference-sandbox`）

适用场景：已有明确的目标站点实体需要原地改造，或显式选择“仅把模板放进 Sandbox 当参考”。

1. 目标生成站保持原站点路径：若为 `upgrade`，则先将 `contentUrl` 克隆至目标站。
2. 通过 `AISandbox/ImportFromTemplate` 将选定 Kooboo 模板导入只读参考 Sandbox（`referenceTemplateSandbox`）。
3. Kooboo AI 通过 Sandbox 工具只读查阅参考模板的布局、样式与组件规范，并在目标站实施改造。
