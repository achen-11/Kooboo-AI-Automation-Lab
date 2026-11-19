# v0.7.16 验证记录

日期：2026-11-19。

基线为正式版 `v0.7.15`（`4425e7e4359ca87c5ed737a4df810962bf42c561`），在独立工作区实施，仅包含任务中心“尚无可访问地址”筛选与安全批量“一键恢复”改动，不包含原开发目录中的未提交 `0.7.14` 阶段标签页及负责人流程改动。

## 已完成

- 69 项针对性 Node 与 Vue 组件测试全部通过（0 失败、0 跳过）：`site-delivery.test.ts`、`automation-performance.test.ts`、`task-list.test.ts`、`site-delivery-list-component.test.mjs`、`queue-diagnostics.test.ts`、`queue-diagnostics-component.test.mjs`、`task-recovery-component.test.mjs`、`updates.test.ts`。
- 新增后端与前端测试覆盖：
  - `GET /api/automation/site-deliveries` 按 `address=missing|accessible` 过滤、非法值 `400` 校验、`attentionMissingAddress` 统计以及仅基于任务索引投影 `recovery` 元数据（不读取 `auto_tasks` 全表）。
  - `hasAccessibleSiteUrl` / `siteLink` 对合法 HTTP(S) 与非法/非 HTTP(S) 地址的一致判定。
  - Vue 内存渲染组件测试验证「需处理 · 尚无可访问地址」一键切换、工具栏联动与重置、多选批量「一键恢复」（`resume` 与 `adjust-site-names` 不传 `force: true`）、跳过未确认停止（`confirm-stopped`）任务及内联原因列表与未确认提示。
- 7 项 Python 交付包边界测试（`tests-python/test_platform_package.py`）全部通过。
- `npm run check`（`tsc --noEmit -p tsconfig.server.json` 与全量 `vue-tsc --noEmit -p tsconfig.web.json`）通过。
- `npm run build` 生产构建与 `git diff --check` 通过。
- 同等功能交互已由操作者在本地 `http://127.0.0.1:4180/#/tasks` 验收通过。

## 交付方式与限制

使用干净提交生成正式更新 ZIP、`.zip.sha256` 校验文件与 `UPDATE_MANIFEST.json`（复用了本机匹配的 `node_modules` 构建），并通过 `npm run release:publish` 校验远端 `v0.7.16` 标签与清单基线提交一致后创建并发布 GitHub Release。

以上验证不等同于 Windows 实机在线升级、全新离线机器 `npm ci` 安装或真实外部模型/Kooboo 建站执行验收。
