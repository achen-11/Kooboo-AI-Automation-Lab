# 人工中断补充与本地 AI 资料收集规范（Intake Playbook）

当自动化任务因原站无法抓取（`source-access`）或 Kooboo AI 挂起等待人工补充素材（`ask_user_input`）而中断时，本阶段负责借助本机工具采集、整理并结构化补充资料包，交由人工确认（或按设置自动）导入目标站点继续生成。

## 上下文字段约定（`context.json`）

- `collectSourceUrl`：**操作者本次指定并授权采集的来源网址**。即使该网址托管在测试或预览域名（例如参考成品站或备用站点），只要 `collectSourceUrl` 非空，就必须先调用 `fetch_url` 真正访问并抓取其页面正文、导航、截图与配图；不要把 `originalFailedContentUrl`（原任务已失败的旧地址）误当成 `collectSourceUrl`，也不要仅因域名相似就跳过抓取。
- `originalFailedContentUrl`：原任务中断前尝试抓取失败的旧内容站地址，仅作背景参考。
- `targetSiteUrl`：当前任务在 Kooboo 的目标生成站地址；禁止把目标模板站的占位文案当作真实门店/业务来源。
- `userNote` 与 `uploadedInputFiles`：操作者填写的补充要求与附带原始素材。

## 工具调用格式（`node tools.mjs`）

所有工具均通过 `node tools.mjs` 提交 JSON 调用（若包含多行正文，强烈建议先写入临时 JSON 文件如 `req.json` 后执行 `node tools.mjs @req.json`，避免 shell 引号转义损坏 JSON）：

1. **抓取公开网页与配图（`fetch_url`）**：
   ```json
   {
     "tool": "read",
     "input": {
       "kind": "fetch_url",
       "url": "https://example.com/",
       "captureImages": true
     }
   }
   ```
   - 由宿主启动本地无头 Chromium 渲染页面并返回标题、正文、`headings`、`navLinks`、`screenshotRelPath`（如 `screenshots/home.png`）以及已下载的图片列表 `imageFiles`（如 `assets/home-img-1.png`）。
   - 单次任务最多抓取 6 个代表性页面；对站内导航发现的核心栏目页也可按需抓取 1～2 个，以丰富素材。

2. **读取用户附带素材（`read_input_file`）**：
   ```json
   {
     "tool": "read",
     "input": {
       "kind": "read_input_file",
       "fileId": "上传文件UUID"
     }
   }
   ```

3. **写入整理后的 Markdown 资料文档（`write_doc`）**：
   ```json
   {
     "tool": "read",
     "input": {
       "kind": "write_doc",
       "path": "intake-brief.md",
       "content": "# 整理简报\n\n..."
     }
   }
   ```
   - 推荐输出总览文档 `intake-brief.md`，栏目较多时可拆分为 `pages/home.md`、`pages/<slug>.md`。
   - 文档应按「品牌名称与定位 / 核心栏目与导航 / 页面正文与关键卖点 / 已采集截图与图片资源对照表 / 仍缺失待确认项」组织，方便目标 Kooboo 站 AI 直接读取与套用。

4. **最终提交收集结果（`submit`）**：
   ```json
   {
     "tool": "submit",
     "result": {
       "headline": "已整理首页等 2 个页面文案、2 张截图与 5 张配图",
       "collectedFrom": ["https://example.com/"],
       "highlights": ["提取完整品牌定位与导航结构", "捕获高清首屏截图与核心产品配图"],
       "gaps": [],
       "selectedFiles": [
         "intake-brief.md",
         "screenshots/home.png",
         "assets/home-img-1.png"
       ]
     }
   }
   ```
   - `headline`：一句话概括收集到的页面/图片数量与可用性（不超过 60 字，面向非技术人员，不出现内部 UUID 或代码字段名）。
   - `selectedFiles`：必须填写 `write_doc` 写入的文档路径及 `fetch_url` 返回的 `screenshotRelPath` / `imageFiles[].relPath` 原始相对路径。

## 诚实与安全原则

- 若访问页面仍返回 HTTP 错误、空白或缺少个别产品图，请如实将具体缺口写入 `gaps` 数组和 `intake-brief.md` 的待确认项，绝不编造联系方式、价格、案例数字或品牌历史。
- 禁止试图访问未写入 `context.json` 或与采集无关的内部管理接口。
