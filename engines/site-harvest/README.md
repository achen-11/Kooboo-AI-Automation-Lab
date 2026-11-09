# 内置站点采集引擎 v1

Python 核心已收编到本目录，不在运行时读取个人 skill。`upstream-snapshot.json` 保留导入时原核心文件哈希；平台新增响应原件分层、JSON bridge 和有限规则能力。命令行原核心入口 `harvest.py` 保留供开发排障，平台只调用 `bridge.py`。

依赖为 Python 3.12、lxml 6.1.1，见 `engine-version.json` 和 `requirements.lock`。统一初始化入口在项目 `scripts/install-collection.mjs`。运行 `node scripts/install-collection.mjs` 会在项目 `.data/collection-runtime` 创建 venv，并只向这个 venv 安装锁定依赖；`COLLECTION_PYTHON` 可指向已管理的 Python 3.12。Windows 用 `Scripts/python.exe`，macOS 用 `bin/python`。`--check` 仅检查，不安装。未随源码捆绑 Python 本体，缺少兼容解释器时明确失败；Windows 安装尚待实机验收。

## JSON 协议 1

执行 `python -B <项目绝对路径>/engines/site-harvest/bridge.py`，stdin 为一个 JSON 对象，stdout 只返回一行 JSON；人类日志及 `stage-start` 事件在 stderr。入口根据自身文件定位模块，不依赖 cwd。2MiB 是请求传输限制，不是业务资料裁剪范围。

```json
{
  "protocolVersion": 1,
  "requestId": "platform-operation-id",
  "operation": "plan",
  "workspace": "/absolute/platform-owned/task-version-directory",
  "sourceUrl": "https://example.test/",
  "authorization": {"network": true},
  "options": {"maxPages": 300, "maxDepth": 6, "maxAssets": 5000, "maxTotalBytes": 2147483648}
}
```

`workspace` 由 Node 根据任务解析，不应暴露为模型任意本机路径参数。bridge 拒绝 engine 源码路径、工作区内符号链接和状态文件的越界路径。它不替代 Node 的目录授权、租约和进程隔离。

| operation | 字段与行为 |
|---|---|
| selfcheck | 无 workspace；返回实际版本、源码哈希、解释器/依赖兼容性和操作列表 |
| plan | sourceUrl 必需；新目录或同源恢复，建立 .work/state.json |
| discover | 从原站 sitemap/入口发现 URL；已有v2清单时保留编号转fetch接续，并标recovered |
| fetch | 有限抓取与从缓存展开入口，失败页仅 retryFailed 时重试 |
| extract | 从已存 HTML 提取；保留当前已采用规则或隔离修复，原件/回执变化必须先新试跑 |
| assets | 按 maxAssets/maxTotalBytes 预算处理素材，超限继续记为缺口 |
| data | 候选数据化；不能代替原件或完整提取 |
| render | 输出逐页内容和素材/页面/发现报告 |
| verify | 文件机械检查、A1–A7 保守报告；不宣称交接完成 |
| batch | stages 默认以上 plan→verify，也可指定不重复的阶段子序列；有界批次，不是全站完成标记 |
| status | 读取机械摘要、检查点及首批产物，不启动采集 |
| artifacts | cursor=0，limit=100（最多500）；返回全目录索引的分页，nextCursor=null 表示索引结束 |
| rules_trial | 仅在已注册已保存 HTML 上试跑有限配置，详见下文 |
| rules_apply | 只采用绑定哈希的通过试跑，重提取及重建资料，并保留旧版本 |
| rules_withdraw | 哈希绑定采用回执，恢复未被后续采用覆盖的旧提取，保留撤回记录 |

plan/discover/fetch/assets 及包含这些阶段的 batch 必须显式 `authorization.network=true`；bridge 不支持 browser、force 或任意 shell/code 参数。Node 应为进程设置超时/终止及持久操作身份。核心仍有各阶段有限页面/深度/素材/响应大小/网络超时限制；阶段中断不使成果变成“完整”。

`options` 只允许 maxPages（1..10000）、maxDepth（0..30）、maxAssets（1..50000）、maxTotalBytes（1..20GiB）、delay（0..30秒）、retryFailed（bool）、seedUrls（已确认 URL 数组）、language、excludePrefixes、mode（A/B）、minRecords。普通续跑保持已有上限。排除项需要平台范围依据；不以配置排除失败页面来放行。

```json
{
  "protocolVersion": 1,
  "requestId": "platform-operation-id",
  "ok": true,
  "result": {
    "summary": {
      "mechanicalStatus": "needs-review",
      "knownGaps": 0,
      "pendingReviews": 2,
      "sourceCoverage": {"status":"unknown","total":null,"complete":false},
      "scopeCoverage": {"status":"unverified","complete":false},
      "handoffReady": false
    },
    "receipts": [{"stage":"plan","status":"executed","finishedAt":"ISO-8601"}],
    "checkpoint": ".work/platform-checkpoint.json",
    "checklist": "site/a-checklist.json",
    "artifacts": {"items":[],"total":0,"cursor":0,"nextCursor":null}
  }
}
```

`ok:true` / 退出0只代表请求已执行。核验发现缺口仍可返回 ok:true，具体以 summary/checklist 为准。失败为 `{protocolVersion:1,requestId,ok:false,error:{code,message}}`、退出1。首次 plan 的操作启动身份由 Node 持久化，plan 成功后才写包内检查点，避免预建元数据使目录不再为空。规则试跑和采用有各自持久回执。

## 有限规则试跑及采用

规则容器支持 host/pathPrefix/language/requiredSelector 适用条件；正文容器、字段、分页、素材与关系选择器。选择器仅支持 `//tag[@attr='value']/tag`、`//tag[@attr]` 和字段内 `.//tag` 这类路径；不支持函数、union、上级路径、脚本或扩展函数。

```json
{
  "protocolVersion":1,
  "operation":"rules_trial",
  "workspace":"/absolute/platform-owned/task-version-directory",
  "trialId":"candidate-1-samples-1",
  "sampleIds":["u00001"],
  "rules": {
    "schemaVersion":1,"version":"candidate-1","baseVersion":"default-1",
    "issueEvidence":["site/a-checklist.json"],
    "appliesTo":{"hosts":["example.test"],"pathPrefixes":["/products/"],"languages":["en"]},
    "container":"//article",
    "fields":{"title":{"selector":".//h1","required":true}},
    "pagination":{"selector":"//a[@rel='next']","attribute":"href"},
    "assets":{"selector":"//img[@src]","attribute":"src"},
    "relations":{"selector":"//a[@class='category']","attribute":"href"}
  },
  "expectations":{"u00001":{"recordCount":1,"containsText":["Width","42"],"fieldValues":{"title":["Saved product"]}}}
}
```

1..200 个样本只从 state 的 ID 解析；每个保存 HTML 超过8MiB或容器超过10000时明确失败，无静默截断。字段支持 attribute、multiple、required。多个值填单值字段、适用条件不匹配、空容器或必填项缺失会记录失败。分页输出只是线索，`paginationExhausted=null`。

输出在 `.work/rule-trials/<trialId>/`，含 rules.json、expectations.json、逐样本结果与 report.json；同 trialId 拒绝覆盖。结果有 trial.status（passed/failed/unverified）、report 路径与 reportSha256。没有有效固定预期时为 unverified；空数组不构成核验依据。样本结果保存完整容器 HTML/text、字段/链接、原件引用及哈希。

采用请求为 `{protocolVersion:1,operation:'rules_apply',workspace,trialId,expectedTrialHash:<reportSha256>}`。校验报告、规则、固定预期、样本结果及原件未变化后，只更新该试跑的 sampleIds。原提取备份到 `adoption/<id>.previous.json`、原状态到 previous-state.json，采用输出到 `<id>.applied.json`。新的通用提取仍保留 fullText 与整页素材，规则容器影响 blocks/tables/headings；单容器的 title/description/canonical 可覆盖对应字段，完整规则字段在 ruleExtraction 中。重跑 data/render/verify 并保留 receipt.json；重复采用或中断后盲目重试会拒绝，需平台先核对回执并恢复/回退。

采用不会把规则推广到全部页面或全局默认，不自动发起分页/素材/关系的新网络操作；这些线索由平台形成后续受控操作。固定预期与样本通过也不证明全站语义完成。

采用返回 `receiptSha256`。实际撤回请求为 `{protocolVersion:1,operation:'rules_withdraw',workspace,trialId,expectedReceiptHash:<采用回执哈希>}`；支持 applied/applying/interrupted 的采用回执，核对原件与当前派生内容、当前采用身份，拒绝覆盖后续新版本。只恢复受影响对象的 previous JSON/状态字段和此前采用指针，保留其他对象与历史；无此前指针时显式标 baseline，规则历史标 withdrawn。随后重建 data/render/verify，撤回记录保存在 `adoption/withdrawal.json`，返回撤回回执及 nextStages（extract/data/render/verify）。中断回执必须由宿主先读取、核对状态，再发起恢复；不盲目重放已经开始的撤回。

`state.activeExtractionAdoptions[id]={kind:'rules'|'repair',trialId}` 记录当前对象采用来源，避免规则与代码修复历史互相覆盖；`{kind:'baseline'}` 明确回到普通引擎。历史 state=withdrawn 不回放。隔离修复由宿主写 `repairAdoptions` 及 `.work/code-repairs/<trialId>/<id>.applied.json`，extract 对照已应用回执、原件哈希和输出哈希后跳过这些对象；回执未完成、原件或输出变化时明确失败，要求重新隔离验证。引擎不会直接执行候选代码。

## 原件与资料边界

`.work/state.json` 仍是 v2 核心检查点。urls 的键是稳定 URL key，记录 id/url/path/action/reason/depth/sources/status/finalUrl/rawFile/pageFile 等；数字路径、.aspx 和有语义查询参数保留。actions 包括 keep/alias/failed/exclude/over-limit，不能把“发现数”当真实源站总量。

| 路径 | 证据层次 |
|---|---|
| .work/responses/<id>.body + .json | 解压后、文本解码前 HTTP body 和状态/编码/跳转/哈希；不声称为 wire capture，不保存 Set-Cookie 等响应头 |
| .work/raw/<id>.html | 解码后的 UTF-8 保存 HTML；历史样本可能仅有这一层；渲染 DOM 必须在状态中另标 |
| .work/extract/<id>.json | fullText、blocks、metadata、图片/链接/表单等提取产物 |
| site/evidence/<id>.json、site/pages/** | 上传资料的提取证据与逐页 Markdown |
| data/** | 启发式候选记录；summary500字、段落20000字、标题/单元格等有长度限制、每条链接最多20、CSV正文4000字；过滤共享导航及隐藏块，不是无损唯一依据 |
| images/**、files/** | 保存素材；PDF正文与图片OCR仍未提供 |
| site/a-checklist.json | A1–A7 缺口与未验证项，始终保留独立复核及版本冻结要求 |
| site/evidence-layers.json | 机器可读层次与候选截断说明 |

不修改冻结资料版本。Node 负责新版本目录、独立复核、清单与证据共同冻结，以及 A/B 段交接。引擎自身从不将 sourceCoverage 或 scopeCoverage 升级为完成。

## 离线验证

```sh
.data/collection-runtime/bin/python -B -m unittest discover -s tests-python -p 'test_*.py'
node scripts/install-collection.mjs --check
```

2026-11-08：macOS arm64 本机受管理 Python 3.12.14 / lxml 6.1.1，52项离线测试通过（33项迁入回归及19项桥接/规则/原件/隔离修复保护/故障恢复回归）。完整阶段链使用网络 stub；无真实网站采集、模型、浏览器或 Windows 验收。候选代码执行隔离由平台另行实现，有限规则能力不构成任意代码隔离已验收。
