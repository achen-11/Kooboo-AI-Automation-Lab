# 给同事的 Codex

先读仓库根 `AGENTS.md`、`README.md`，再读本文件和 `docs/PUBLIC_API.md`。改 runtime、构建或部署前另读 `.kooboo-ai/specs/frontend.md`。

## 项目与入口

- Vue UI：`frontend/src/`；独立 Node API：`server/app.ts`；入口：`server/main.ts`。
- Admin v1 查询：`server/public-api.ts`，共享业务类型：`shared/types.ts`，分数状态：`shared/result.ts`。
- 队列及持久化：`server/lib/store.ts`；Worker：`server/worker.ts`；实际采集/模型行为在 `server/lib/`。
- SOP：`sop/agent-site-ui-v1/`；不要恢复历史 Kooboo API/CodeBlock/Job，不运行 `kb push`。
- 快速验证：`npm test`、`npm run check`、`npm run build`。普通测试不执行真实浏览器或付费模型调用。

## 在 Admin 仓库接入

1. 找到 Admin 的后端服务、配置注入和业务任务 ID。向同事索取评分 API 基地址和查询令牌，以服务端环境变量配置，不硬编码。
2. 使用 `examples/admin-query.mjs` 和 `docs/PUBLIC_API.md` 建立服务端 client。看板用 summary，详情用 report，排错才取 full。
3. 平台投递成功仅代表已接收；轮询并分别处理 lifecycle status 与 scoringStatus，null 分数、部分覆盖和人工复核状态必须保留。
4. 当前状态以 evaluationId upsert，执行历史以 runId 保存；业务关联使用 jobId、requestId、attemptId、实际生成站域名。不要将来源/参考站当作生成站。
5. 图片需要后端代理鉴权。先校验返回的相对路径只指向配置基地址，再转发，不能发送令牌到任意 URL。
6. 做超时、分页、退避、404/401 处理。updatedSince 用重叠窗口并周期全量对账；没有事务 change feed，不承诺严格无遗漏同步。
7. 编写 Admin 自己的接口测试，覆盖 pending/failed/partial/scored、null 分数、coverage 不完整、分页及鉴权错误。没有用户授权，不控制浏览器、不真实迁移、不真实调用付费模型。

若还需 Admin 发起建站，请读随交付插件的 `ADMIN_INTEGRATION.md`；通过 Chrome runtime 消息打开 builder/runner，不能直接访问扩展 URL。新同事先跑通单任务并人工信任来源，再接批量。

## 维护边界

API v1 采用显式字段投影，不直接序列化 Vault、原始 pipeline 或 Agent trace；保持旧插件接口向后兼容。新增筛选必须严格校验，并补 `tests-node/public-api.test.ts`。生成 PNG 不塞进列表 JSON。新规则发布新版本，不原地覆盖。

`.data/` 是本机所有任务、证据、主密钥和加密配置。更新源码、安装依赖、构建均不得覆盖或清空它。不要将现有 `.env`、API Key 或运行数据加入 Git/压缩包。Launch 定制凭证由插件内部处理，不能改成 Kooboo 登录 token。

现有本机管理登录没有用户密码，不能直接公开整个服务。对外只代理明确的 API 路径，保留读/写令牌隔离；公网 UI 和用户认证是后续独立设计，不能为方便联调放开所有 Host/Origin。
