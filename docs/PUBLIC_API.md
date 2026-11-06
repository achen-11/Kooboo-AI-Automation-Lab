# Admin 评测数据 API v1

平台版本：0.4.0。协议版本：1。本接口是对外接入契约，现有插件 `/api/evaluations` 投递和查询协议继续保留。

## 地址与认证

本机基地址 `http://127.0.0.1:4180`；远程部署使用自己的 HTTPS API 域名。所有请求都需要：

```http
Authorization: Bearer <系统设置中的查询令牌>
```

这里的“公开 API”指受认证的对外接口。查询令牌只读，不能投递任务、修改设置、重评或发送修复。投递令牌、Kooboo 登录令牌和 Launch 的定制凭证互不替代。当前查询令牌能读取此实例的全部评测，尚无多租户隔离、按用户授权或令牌轮换界面；不同团队需要隔离时分别部署实例。

推荐 `Admin 浏览器 → Admin 后端 → 评分 API`，令牌放 Admin 服务端环境变量。不要放网页源码、URL 或日志。接口不开放任意网页 Origin 的 CORS。跨机器接入见 [HANDOFF.md](HANDOFF.md) 和 `deploy/nginx-api.conf.example`。

## 接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/evaluations` | 全量分页、筛选、站点最新结果、增量轮询 |
| `GET /api/v1/evaluations/{evaluationId}` | 指定一次评测的当前轮次 |
| `GET /api/v1/evaluations/{evaluationId}/runs` | 历史执行轮次，分页 |
| `GET /api/v1/evaluations/{evaluationId}/runs/{runId}/events` | 本轮日志，分页或从 seq 继续 |
| `GET /api/v1/evaluations/{evaluationId}/runs/{runId}/report` | 本轮报告及规则快照，未生成返回 404 |
| `GET /api/v1/evaluations/{evaluationId}/runs/{runId}/artifacts/{file}` | PNG 证据，优先使用响应中的 artifactUrl |

评测、轮次 ID 为 UUID。未知记录或不属于该评测的轮次返回 404。截图按所属评测、轮次及保存的来源索引读取，不能任意读取文件。响应链接均为同源相对路径；不要把 API 查询令牌拼到链接中。

## 数据颗粒度

列表和历史轮次默认 `detail=summary`，单条详情默认 `detail=report`。

| detail | 返回内容 | 推荐场景 |
| --- | --- | --- |
| `summary` | 身份、状态、两种分数、置信度、覆盖情况、规则/模型名称、时间；评测对象另有复核信息和页面链接 | 列表、看板、轮询 |
| `report` | summary + `report`（分项分、问题、配对、引用、usage、限制等原始评分内容） | Admin 详情页、分析 |
| `full` | report + `evidence`、`snapshot`、`stages`、`captures`、`actions`；评测对象另有 `submission` | 排错、证据导出、审计 |

`full` 只展开当前对象，不递归附带所有历史、日志或 PNG。历史和日志用专门的分页接口读取。`captures` 保留尚未汇总或失败时的部分证据。`snapshot` 包含规则、规则哈希、SOP 和执行配置，不包含私有模型 endpoint、密钥及 Agent 的本机文件路径。报告与证据可能含站点正文和资料内容，查询令牌应按业务数据权限保管。

## 列表参数

参数均可省略，多个筛选按 AND 合并。参数名、枚举和布尔值严格校验，未知参数返回 400，避免拼写错误默默查询全部数据。

| 参数 | 类型/默认值 | 含义 |
| --- | --- | --- |
| `detail` | summary / report / full | 颗粒度 |
| `page` | 整数，默认 1，最大 1000000 | 从 1 开始 |
| `pageSize` | 整数，默认 10，1–100 | full 时最大为 10 |
| `order` | desc / asc，默认 desc | 按平台接收时间 createdAt 排序，同时间按 evaluationId 稳定排序 |
| `domain` | 完整生成站域名，也接受 URL | 规范化为主机名，保留子域，不合并 www；不是参考站 |
| `jobId` | 字符串，1–200 字符 | Admin 业务任务精确匹配 |
| `requestId` | 字符串，1–200 字符 | 插件请求精确匹配 |
| `attemptId` | 字符串，1–200 字符 | 一次评测投递精确匹配 |
| `status` | queued / collecting / scoring / completed / failed | 生命周期 |
| `scoringStatus` | pending / failed / unscored / partial / scored | 分数可用状态 |
| `needsReview` | true / false | 两种值均为精确筛选 |
| `latestPerSite` | true / false，默认 false | 每个已确认生成域名只保留最新投递；未解析域名的记录逐条保留 |
| `fidelityBelow` | 数字 0–101 | 还原度严格小于此值，排除 null；101 可包含所有有效分 |
| `ruleSetVersion` | 字符串，1–80 字符 | 当前轮实际/冻结规则版本 |
| `createdFrom` | Unix 毫秒，含边界 | 平台接收时间下界 |
| `createdBefore` | Unix 毫秒，不含边界 | 平台接收时间上界 |
| `updatedSince` | Unix 毫秒，含边界 | 当前执行、复核、日志及问题操作的更新时间下界 |
| `updatedBefore` | Unix 毫秒，不含边界 | 更新时间上界 |

`latestPerSite=true` **先**按 `occurredAt`、`createdAt`、ID 选出每站最新投递，**再**应用其他筛选。因此最新评测失败时，不会悄悄回退到旧的成功分数。若要所有历史低分，使用 `latestPerSite=false`。

响应示例（缩略字段仅作阅读示意，真实接口还会返回其他 summary 字段）：

```json
{
  "apiVersion": 1,
  "items": [{
    "evaluationId": "UUID",
    "runId": "UUID",
    "jobId": "admin-job-123",
    "requestId": "request-123",
    "attemptId": "attempt-123",
    "siteDomain": "generated.example.com",
    "status": "completed",
    "scoringStatus": "scored",
    "fidelityScore": 77.6,
    "completionScore": null,
    "confidence": "medium",
    "coverage": { "requested": "site", "actual": "homepage", "complete": false, "captureComplete": true, "note": "仅覆盖首页" },
    "needsReview": true,
    "ruleSetVersion": "agent-ui-v1",
    "modelName": "configured-model",
    "createdAt": 1793923200000,
    "updatedAt": 1793923260000,
    "reportUrl": "/#/evaluations/UUID"
  }],
  "total": 1,
  "page": 1,
  "pageSize": 25,
  "hasMore": false,
  "generatedAt": 1793923261000
}
```

`total` 为本次筛选后的数量。越界页返回空 items。列表和历史都按响应中的 hasMore 遍历，不猜测固定总页数。单条详情直接返回对象，含 apiVersion；历史对象使用 runId，createdAt/updatedAt 是该轮时间，评测对象 createdAt 是接收时间，updatedAt 包括后续人工操作。

## 历史和日志参数

- `/runs` 接受 `detail`、`page`、`pageSize`，最新轮次在前；full 同样每页最多 10。
- `/events` 接受 `page`、`pageSize`、`afterSeq`（默认 0）。seq 严格大于 afterSeq，按 seq 升序返回。轮询时保存最后成功消费的 seq，下次用 `page=1&afterSeq=...`。
- `/{evaluationId}` 只接受 detail；`/report` 和截图接口不接受查询参数。

## Admin 调用示例

```sh
# 在自己的终端设置，不提交真实令牌
export EVALUATOR_BASE_URL='http://127.0.0.1:4180'
read -r -s EVALUATOR_READ_TOKEN
export EVALUATOR_READ_TOKEN

# 看板：每站最新、低于 80、需要复核
curl --fail-with-body --get "$EVALUATOR_BASE_URL/api/v1/evaluations" \
  -H "Authorization: Bearer $EVALUATOR_READ_TOKEN" \
  --data-urlencode 'latestPerSite=true' --data-urlencode 'fidelityBelow=80' \
  --data-urlencode 'needsReview=true' --data-urlencode 'detail=summary'

# 指定业务任务的全部评测报告
curl --fail-with-body --get "$EVALUATOR_BASE_URL/api/v1/evaluations" \
  -H "Authorization: Bearer $EVALUATOR_READ_TOKEN" \
  --data-urlencode 'jobId=admin-job-123' --data-urlencode 'detail=report'

# 完整数据；用真实 UUID 替换占位符
curl --fail-with-body "$EVALUATOR_BASE_URL/api/v1/evaluations/EVALUATION_UUID?detail=full" \
  -H "Authorization: Bearer $EVALUATOR_READ_TOKEN"

# Node 24 示例，逐页读取所有报告，按 evaluationId 在 Admin 入库
node examples/admin-query.mjs
```

同一 jobId 可能有多次 attempt，同一 evaluationId 又可能有多个 runId。Admin 数据库至少保存 evaluationId 和 runId，推荐同时保存 jobId、attemptId、siteDomain。不要按 jobId 或来源域名覆盖历史。

## 增量同步与一致性

首次完整分页，后续使用 `updatedSince` 反复拉取变化记录，按 evaluationId upsert 当前状态；需要执行历史时，再拉 `/runs` 并按 runId upsert。建议每 15–30 秒轮询，超时或 5xx 退避重试；401/403 先排查配置。

本版分页为实时查询，不是数据库快照，也没有删除订阅。并发写入可能改变分页位置；增量窗口使用服务器 generatedAt 作为参考，保留时间重叠并周期性全量对账，避免单次遍历后永久跳过数据。更新过程改变本地时钟、复核阈值或直接改数据库时，也应全量对账；阈值改变可影响 needsReview，但不会逐行改更新时间。对严格快照导出或大规模仓库同步，应另行设计 change feed，不能把此轮询当作无遗漏事务日志。当前实例仍沿用本地数据存储与内存筛选，建议大批量先取 summary，再按需展开详情。

## 分数与错误处理

`pending` 表示仍在执行，`failed` 表示失败，`unscored` 为结束但无有效分，`partial` 为仅有任务完成度，`scored` 为已有 UI 还原度。null 是不可评估，不能变成零分。`status=completed` 只表示执行结束；分数存在也不自动等于验收通过。应同时检查 confidence、coverage、needsReview 和 report.limitations。

站点尚未解析时 siteDomain/targetUrl 可为 null；全站请求实际只采首页时，coverage.complete=false，仍可能有首页评分。忽略问题不改写原报告和分数，full.actions 独立返回处理记录。

400 参数错误；401 令牌错误或权限不符；403 Host/Origin 不受信任；404 记录、报告或证据不存在；500 平台故障。JSON 错误形如 `{ "error": "原因" }`。JSON 默认不缓存，截图也需要鉴权。Admin 如要显示截图，应由自己的后端携令牌代理，前端不能直接用裸 artifactUrl 绕过认证。reportUrl 指管理页，远程只读 API 部署默认不开放管理页。
