# v0.9.4：用户资料包图片直传目标站媒体库

本版本基于 `v0.9.3`（`b68d430`）发布，将建站资料包与常规补充资料中的用户图片类资源从站点文件（`CmsFile`）切换为直接上传至目标站 Kooboo **媒体库**，方便后台统一管理与 Kooboo AI 直接识图/裁剪引用。

---

## 核心改进

### 1. 图片分类、排除规则与媒体库目录规划（[`server/automation/materials.ts`](../server/automation/materials.ts)）
- **覆盖全部常用图片格式**：同时按 MIME 类型与扩展名兜底识别 `png`、`jpg`、`jpeg`、`webp`、`svg`、`gif`、`avif`、`ico`、`bmp`。
- **排除平台侧采集文件**：A 段来源采集目录 `collection/`（如来源视觉基线截图与渲染观测证据）保持排除在目标站媒体库之外，继续走原有 `kfile` / `CmsFile` 路径，避免污染目标站媒体库。
- **简洁可读的媒体库路径**：用户图片采用 `/materials/<安全相对子目录>/<安全文件名>`（例如 `images/logo.svg` 上传至媒体库目录 `/materials/images`，避免与旧站克隆 `/images/*` 冲突，也不再拼接两段 UUID）；非图片二进制文件继续保持原 `CmsFile` 路径。

### 2. 媒体库直传、回执校验与幂等兼容（[`server/automation/kooboo-materials.ts`](../server/automation/kooboo-materials.ts)、[`shared/automation.ts`](../shared/automation.ts)、[`server/automation/followup-context.ts`](../server/automation/followup-context.ts)）
- 常规资料导入（`mode: 'materials'`）与人工/AI 辅助补充资料中的用户图片均通过 `/_api/v2/Upload/Image?SiteId=<siteId>&provider=default` 上传到目标站媒体库。
- 严格校验回执数组首项需含有效 `id` 或 `url`，且若返回 `size` 须与原文件字节数一致；在 `GenerationCheckpoint` 新增 `importedMedia`（记录 `sha256`、`id`、`url`），并在 `followupTaskContext` 中剥离以精简跟进上下文。
- 保留断点和旧任务兼容：已记录 `importedMedia` 的图片续传时直接跳过重复上传；升级前已完成 `CmsFile` 导入的历史任务（仅有 `importedMaterials` 无 `importedMedia`）由 `resolveTaskMaterialEntry` 兼容解析回原 `CmsFile` 路径。

### 3. 建站、补充与阅读器全链路联动（[`server/automation/generator.ts`](../server/automation/generator.ts)、[`server/automation/supplement.ts`](../server/automation/supplement.ts)、[`server/automation/generation-context.ts`](../server/automation/generation-context.ts)）
- [`generator.ts`](../server/automation/generator.ts) 调整为先完成素材上传、再通过 `resolveTaskMaterialEntry` 构建任务包 `materials` 索引，确保写入 `_automation-manifests/<taskId>.json` 与 `automationMaterials()` 的是媒体库实际返回的 `destination`（URL）、`storage: 'mediaLibrary'` 与 `imageId`。
- [`supplement.ts`](../server/automation/supplement.ts) 在普通补充资料（`mode === 'materials'`）包含媒体库图片时同步刷新 `_automation-manifests/<taskId>.json`，同时保持 `ask_user_input(target='mediaLibrary')` 交互回答不额外触发 `kscript` 清单写入。
- 将 `generationContextReaderVersion` 升级至 `7`，在 `automationMaterials()`（严格保持 Jint ES5 语法）中返回 `imageId`，并在委托提示词中说明媒体库图片可直接用于页面 `<img src>` 与 `read_image` / `image_resize`。

### 4. 配套 Kooboo 端说明
- 常见的 1–2 层资料路径（如 `/materials/logo.svg`、`/materials/images/xxx.jpg`）在 Kooboo 媒体库根目录即可直接正常展示；对于 3 层及以上深层虚拟目录在 Kooboo 后台文件夹树中的递归判重缺陷，已同步在 Kooboo 仓库修复 `FolderRepository.PathHasSubObject`（提交 `2beca84e9`）。
