# Site Evaluator · Kooboo

独立维护的 Kooboo 评分站点。源项目 `../ai_site_evaluator` 保留，运行不再依赖 Node API/Worker；Node 24 只用于本地构建、测试、发布和迁移脚本。

后续功能与修复统一在本项目维护。旧 `ai_site_evaluator` 仅作历史来源保留，本地服务已关闭，不再作为运行入口。

## 开发与发布

```sh
npm install
npm run check
npm test
npm run build
npm run preflight
npm run push
npm run smoke
```

`npm run dev` 只启动本地前端，未配置 API 代理；实际联调使用构建后的 Kooboo 站点。没有默认开启 `kb sync`。

源码位于 `backend/` 与 `frontend/src/`；`src/` 是生成目录，不直接编辑。构建失败不会替换上次可部署资源。站点根入口 `/`，Vue hash 路由；资源 URL 是 `/assets/*`。

Git 只维护源码、构建脚本和测试；`src/`、构建缓存、`.env` 和运行数据均忽略。完整生成的 `kooboo.d.ts` 可能带入环境敏感配置，已移除并忽略；本项目类型检查使用 `backend/k-types.d.ts` 中核对过的最小原生 API 声明。拉取类型文件后也不要将其加入提交。

构建时生成独立加密密钥，写入忽略的 `.env` 与服务端 CodeBlock `src/code/evaluator-secret.ts`。不要将这些文件提交 Git，不要丢失或重新生成运行中站点的密钥。

## 运行条件

- Kooboo 开启站点 Job，站点已发布。`src/job/evaluator.ts` 每 10 秒检查持久队列，每次处理一项；Job 使用 Kooboo 的长运行脚本入口。
- 服务器启用 Puppeteer，并有 Chromium 或允许 Kooboo 下载浏览器。健康检查只能确认 API 可用，不能证明浏览器启动成功；首次真实评测才会实际调用浏览器。
- 服务器能访问被评测站点、参考站、模型和配置中的 Kooboo API 地址。原本的 `localhost` 地址始终指向评分站所在服务器，部署到另一台服务器时需要重新配置。
- 管理页使用此站点组织的 Kooboo 管理员账号登录（或组织所有者）。插件与 Admin 使用独立的投递、读取令牌。
- 侧栏底部提供退出登录入口，调用 Kooboo 登出并清除当前登录 Cookie。

运行数据和截图保存在此 Kooboo 站点 SQLite；配置通过 Kooboo AES 加密，密钥保存为服务端 CodeBlock。管理 API 不向匿名用户开放。SQLite 中的截图只能通过鉴权 API 读取；截图中间文件在读取后删除。

队列接收幂等、规则发布和重评通过 SQLite 事务完成；单 Worker、5 分钟执行租约、4 分钟任务预算，租约失效最多恢复三次。无法取得可信证据或模型结果时保留失败/未知状态。旧执行者不能覆盖新执行结果。

备份应包含站点 SQLite、服务端资源及加密密钥；按 Kooboo 站点备份方式执行，恢复时一同恢复。不要只备份前端目录。

## 原 Node 平台配置迁移

```sh
npm run migrate:node -- ../ai_site_evaluator/.data
```

迁移脚本读取本地旧平台加密配置，仅经已登录管理员的 HTTPS 请求导入。保留模型、环境、筛选设置以及投递/读取令牌；不输出凭据。

本次来源无评测和草稿，且只有内置规则，因此只需导入配置。脚本会在发现历史评测、草稿或不同发布规则时停止，避免遗漏数据；目标只允许尚未配置且无任务时首次导入。同一来源重复执行不会覆盖后续编辑。

## 首次验证与插件切换

1. 打开 `https://site_evaluator_impl.localkooboo.com`，用此站点组织的 Kooboo 管理员账号登录。
2. 在「系统设置 → 模型配置」点击测试，确认已保存的配置支持图片输入与 JSON 输出。迁移与健康检查不会实际调用模型。
3. 在「评测任务 → 新建评测」填入一个生成站点和对应参考站，先选首页；等待报告后检查桌面、移动截图和评分证据。
4. 在建站插件的评测接入配置中，将投递地址改为 `https://site_evaluator_impl.localkooboo.com/api/evaluations`。投递与读取令牌已迁移，可以沿用；Admin 查询请求也需改用本站域名。插件已有配置不会被迁移脚本自动修改。

2026-11-05 已完成首次配置导入：1 个 Kooboo 环境，模型配置及投递/读取令牌核对通过；来源无历史评测。旧平台及其数据目录保留。

## 保留的业务契约

- 站点键为实际生成的完整域名；参考域名不作为站点键。同域保留历史与重评。
- UI 还原度、任务完成度、页面健康独立；没有参考时还原度为 `null`，没有 README 时完成度为 `null`。
- 五个评分维度、草稿编辑、不可覆盖的发布版本、每轮规则/模型/采集快照。
- 模型保存后提供图片 + JSON 测试按钮；测试最多 50 秒，评分 Job 模型调用最多 90 秒。
- 首页桌面/移动截图对照、问题证据、低分/需复核筛选、人工复核、域名历史。

API 沿用原 `/api/evaluations`、`/api/jobs/{jobId}/evaluations/latest`、`/api/sites/{domain}/evaluations/latest` 等协议。插件 POST 的 `Idempotency-Key` 必须等于 `attemptId`。接入地址与令牌在系统设置中获取。

## 采集差异

Kooboo 当前公开 API 的 DOM 读取与截图各自导航；原 Playwright 采集器的同会话逐段滚动、网络事件监测无法直接沿用。此实现使用原生 Puppeteer 截整页，再在独立的空白浏览器页面内通过 Canvas 切出顶部、中部、底部像素。不会把目标页面代码交给服务端执行。

检测到懒加载图片、页面超高、参考缺失时标记覆盖不足；正文或高度变化时标记不稳定。超高页面只截顶部，不伪造中部和底部证据。报告与快照记录实际采集方式。全站任务仍只覆盖首页，需人工复核。

## 验证边界

`npm test` 使用真实临时 SQLite 和模拟的 Kooboo 绑定，验证迁移逻辑、权限和裁切坐标。`npm run smoke` 验证部署后的 HTTP/API、静态资源和 Cookie 登录会话，不启动浏览器或模型，不代表视觉验收与真实评分贯通。

2026-11-05 的验证结果：类型检查、构建、Preflight 和 9 项测试通过；线上入口及 JS/CSS、配置导入、匿名管理接口拒绝访问、登录 Cookie 保持、退出时清除 Cookie 及退出后的会话拒绝访问、Job 心跳已通过 HTTP 验证。尚未执行真实 Puppeteer 采集、模型评分或浏览器视觉验收。

Preflight 沿用 CLI skill 的扫描器，并对其命中的 Vue/Zod `ctx` 属性与代码字符串做 AST 复核，避免把第三方属性误判为 Express handler；薄 API 文件直接委托 `k.request/k.response` 调度器。
