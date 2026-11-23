# v0.9.4 验证记录

日期：2026-11-23。

基线：基于 `v0.9.3`（`b68d43034c7202001ca22002ce138434405001f7`）合入用户资料包图片直传媒体库功能提交 `b6ae6b330351288ff2841c42e86805d4e003052c`（`b6ae6b3`）。

## 已完成自动化验证

- **定向 Node 单元测试**（2026-11-23，`node --import tsx --test tests-node/automation-todos.test.ts tests-node/task-supplement.test.ts tests-node/generation-context.test.ts`）：共 46 项，44 项通过、2 项与本次改动无关的既有失败（`automation-todos.test.ts` 中 `repair batches resume accepted sends` 因参考图未登记失败；`task-supplement.test.ts` 中 `Harness catalog exposes intake/SKILL.md` 期望 15 篇文档实际为 16 篇）。本次涉及媒体库上传、分类与读取器的全部用例均通过：
  - `materialDestination`：验证用户图片映射至 `storage: 'mediaLibrary'` 与 `/materials/<相对子目录>/<安全文件名>`；
  - `Upload/Image` 媒体库直传、多图片格式（`svg / jpg / png / webp / gif / avif / ico / bmp`）上传与 MIME 推断、`collection/` 排除走 `Upload/File`、异常回执/大小不匹配拒绝、断点和旧任务兼容；
  - `AI-assisted intake` 与 `Manual supplement` 媒体库图片上传及 `ask_user_input(target='mediaLibrary')` 无 `kscript` 清单写入边界；
  - `automationMaterials()`（`generationContextReaderVersion = 7`）返回 `storage: 'mediaLibrary'` 与 `imageId` 并阻止文本读取。
- **全量 Node 回归套**（2026-11-23，`npm test`）：共 1,122 项，1,114 项通过、4 项环境开关跳过、4 项与本次改动无关的既有失败（除上述 2 项外，另含 `automation-ui.test.ts#L101` 与 `live-comparison-component.test.mjs#L454`）。
- **Python 交付打包边界测试**（`python3 -m unittest tests-python/test_platform_package.py`）：**7 项通过、0 项失败**（`0.100s`）。
- **`npm run check`**（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：通过（exit code `0`）。
- **`npm run build`**（Vite 2,898 模块生产构建 + 服务端 TS 编译 + `dist-server/build-info.json` 生成）：通过（exit code `0`）。

## 交付方式与验证边界

- 从干净工作树提交版本元数据并打标 `v0.9.4`；通过 `scripts/package-platform.py --update --reuse-dependencies` 生成更新包与 `UPDATE_MANIFEST.json`，并通过 `npm run release:publish` 发布到 GitHub Releases，不包含本地 `.data/` 与个人运行凭证。
- **未在本维护版执行**：
  - 真实远端 Kooboo 环境媒体库上传与端到端建站/评测实时运行验收；
  - 在线自更新覆盖升级实机演练。
