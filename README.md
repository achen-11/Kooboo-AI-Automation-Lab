# Kooboo AI Automation Lab

统一管理资源库、生成 / 评测队列、报告、评测规则与系统设置，沿用 CPR 界面。新功能使用 `frontend/src/views/automation/`、`server/automation/` 和 `shared/automation.ts`；原有评测记录、接口和执行器保留。

同事首次安装请从 [部署与交接指南](docs/DEPLOYMENT_AND_HANDOFF.md) 开始，覆盖 Windows / macOS、Kooboo 与模型配置、单任务验证、更新备份及排障。仅打包当前平台可用 `python3 scripts/package-platform.py --output /tmp/kooboo-automation-lab.zip`；构建在临时目录完成，不携带个人运行数据。首次仍需联网安装依赖和 Chromium。

运行与验收边界、操作说明及新 API 见 [统一自动化说明](docs/UNIFIED_AUTOMATION.md)。新队列首次默认暂停，既有模型凭证与 Kooboo 环境配置保留。

项目目录：`/Users/achen/Priv/Yardi/AI-App/Kooboo-AI-Automation-Lab`。完整讨论与决策见 [讨论记录](docs/automation-evaluation-discussion.md)。

经验库、请求级预算与全站交付清单见 [经验学习与完整度](docs/experience-learning-and-completeness.md)。新增任务固定策略快照；已有配置和历史报告保留。

任务详情的“更多 → 导出排障包”可后台收集该生成站的全部关联任务、输入、会话、报告、证据与用量，并组合 Kooboo 原生完整站点 ZIP。未建站或 Kooboo 离线时仍可下载平台部分及缺失说明；关闭弹窗不停止导出，取消导出也不取消原任务。下载有效期为 24 小时。平台文本自动去除已知凭证；原生站点 ZIP 和二进制资料保留原始内容。范围、接口和验证边界见 [排障导出说明](docs/diagnostic-export-discussion-2026-11-08.md)。

---

# 保留的 Site Evaluator 功能

交付安装与 Git 更新见 [docs/HANDOFF.md](docs/HANDOFF.md)，Admin 查询契约见 [docs/PUBLIC_API.md](docs/PUBLIC_API.md)，同事的 Codex 入口见 [docs/CODEX_INTEGRATION.md](docs/CODEX_INTEGRATION.md)。

独立的站点 UI 评分平台，使用 Vue 前端与 Node.js 服务端。Kooboo 建站插件投递任务，后台 Worker 启动 Agent，由 Agent 按 SOP 自主调用采集、看图、审查和评分提交工具，并向 Admin 提供结果接口。

当前在本机运行，默认地址 `http://127.0.0.1:4180`。后续统一在 `Kooboo-AI-Automation-Lab` 目录维护；`../site_evaluator_impl` 保留为原独立评分平台，旧 `../ai_site_evaluator` 仅作历史来源。原 Kooboo 运行资源已从当前项目移除，旧实现可从 Git 历史查阅。

## 安装与启动

需要 Node.js 24 或以上版本，以及能访问生成站、参考站、模型和 Kooboo API 的网络。

```sh
npm install
npm run install:browser
npm run build
npm start
```

打开 `http://127.0.0.1:4180` 后自动连接本机工作区，无需手动进入或登录。会话失效时自动重新建立并最多重试一次请求，连接失败时可手动重试。关闭或刷新页面不影响后台任务。当前会话机制只用于本机工作区，生产网络部署的身份认证与访问控制另行设计。

开发时运行 `npm run dev` 启动 Node API 与 Worker；另开终端运行 `npm run dev:web` 可使用 `http://127.0.0.1:4181` 的前端热更新，API 代理到 4180。

API 自动启动独立的后台执行子进程，生成、评测、经验复盘与旧评测队列均在该进程运行。文件哈希、HTML 解析和程序核验不会占用 HTTP 事件循环。两个进程使用同一 SQLite WAL 数据库和加密配置，控制消息不携带密钥或完整任务；取消与退出仍等待执行器确认，关闭 API 时会一并优雅停止后台进程。后台意外退出后健康接口的 `workerReady` 为 `false`，不会静默重发结果不确定的委托。

`npm run dev` 会在后端或其依赖文件变动时重启 API 与 Worker，并中断在途任务。需要持续执行真实任务时，使用上面的 `npm run build`、`npm start` 运行已构建服务；源码编辑不会触发该进程重启。更新构建与切换服务应安排在活动任务停止后进行。若开发重启留下跟进用量未确认的请求，确认执行停止后点击“恢复任务”，系统保留预算预占与未知费用并继续原任务。

```sh
npm test
npm run check
npm run build
```

测试与构建不调用真实模型，也不代表完成浏览器视觉验收。可显式运行 `EVALUATOR_BROWSER_TEST=1 TSX_TSCONFIG_PATH=tsconfig.server.json node --import tsx --test tests-node/collector-browser.test.ts`，在本地静态页面验证真实滚动与截图坐标；普通测试默认跳过该浏览器用例。Chromium 由 Playwright 安装；浏览器是否能正确加载特定网站，需要真实采集验证。

## 目录与数据

- `server/`：可读的 Node API、后台 Worker、配置、SQLite 存储及 Playwright 采集器。
- `shared/`：前后端共享的业务类型与结果状态。
- `frontend/src/`：Vue 页面、阶段展示、截图对照与站点预览。
- `tests-node/`：服务端与采集流程的针对性测试。
- `sop/agent-site-ui-v1/`：新流程的人类 SOP 与平台 Agent 运行约定；`sop/site-ui-v1/` 保留旧流程。

构建输出到 `dist/` 与 `dist-server/`。原 Kooboo API、CodeBlock、Job、原生类型绑定及旧发布脚本已移除，部署使用 Node 服务，不需要 `kb push`。

运行数据默认保存在 `.data/`：任务、执行记录、规则和证据索引进入 SQLite，新截图原始 PNG 保存在 `.data/artifacts/`，索引记录 SHA-256；历史 SQLite 图片继续兼容读取；模型 API Key、Kooboo 环境令牌及插件投递/查询令牌随配置加密保存。加密主密钥为 `.data/master.key`，配置文件为 `.data/settings.enc`。备份时保留整个 `.data/`，恢复时同时恢复主密钥；不要只备份数据库，也不要重新生成已有密钥。运行数据、密钥、`.env` 和完整生成的 `kooboo.d.ts` 不得加入 Git。

任务调度、概览、通知与站点报告列表使用同库中的轻量任务索引，完整提示词、报告和证据继续保存在原记录中，按需读取。首次升级启动会自动补齐索引，后续任务更新与索引在同一事务内保存；费用列表按任务和阶段批量汇总原始账本，不修改费用记录。任务中心只轮询队列状态和站点列表，页面隐藏时暂停列表与详情的定时刷新。

B 段核验报告按固定输入、清单哈希、校验器版本、来源快照和站点修订建立轻量索引，获取最新报告只读取一份完整记录。旧报告自动补齐索引并保留原文；同一绑定下内容、证据与核验状态完全未变化时复用已有报告，执行事件继续记录本次检查，避免空转追加相同的大报告。不同输入、进度、证据或结果仍各自保存，不能把未验证结果去重成通过。

生成浏览器确认关闭后自动清理可再生的 HTTP、代码和 GPU 缓存，保留 Cookie、本地存储与会话恢复状态。已有已停止任务可运行 `node --import tsx scripts/trim-generation-cache.ts` 预览，增加 `--apply` 才会清理；可用 `--directory` 指定数据目录。脚本跳过活动任务、原生浏览器锁和符号链接，不删除浏览器配置目录、报告、原件或证据。

## 从 Kooboo 版本迁移

本项目已迁回 Node：1 个评测任务、5 条执行记录和 52 份证据文件已保留，旧 `site_evaluator_impl` Kooboo 评分站点已删除。以下工具供其他尚未迁移的实例使用，不能再从已删除的站点导入。

在新平台首次配置前执行：

```sh
npm run migrate:kooboo -- --destination .data
```

迁移工具读取旧评分站的数据和配置，写入本机数据目录；按工具提示提供旧站访问所需信息。已有模型、Kooboo 环境和插件投递/查询令牌应保留。完成迁移后检查任务历史、规则、截图及模型配置，再切换插件与 Admin 的接入地址。迁移和模型测试是两个独立步骤，配置导入不表示模型能力已验证。

## 首次验证

1. 启动服务并进入本机工作区；迁移已有数据，或在“环境连接”中填写 Kooboo 地址与服务端访问令牌。
2. 在“系统设置 → 模型接口”填写完整 Chat Completions 地址、模型名称与 API Key，保存后点击“测试连接”。测试发送真实图片，验证图片识别、工具调用及工具结果读取；兼容文本接口并不表示支持视觉评测。模型可换为 DeepSeek 或其他兼容服务，具体以实际能力测试结果为准。
3. 在“运行设置”选择单个阶段执行预算和每视口采集次数上限；默认分别为 300 秒和 2 次，可配置范围分别为 30–1800 秒和 1–3 次。预算用于单个视口采集及每次模型请求；页面导航超时、视口与采集范围继续在版本化评分规则中维护。
4. 新建一项首页评测，填写生成站地址和视觉参考站。查看每阶段状态、采集诊断和实际截图，再核对分项引用。没有视觉参考时不生成 UI 还原度。
5. 将插件投递接口改为 `http://127.0.0.1:4180/api/evaluations`，使用设置页提供的投递令牌；Admin 使用查询令牌读取结果。远程 Admin 无法直接访问此本机回环地址，需要后续部署或受控接入方案。

## 评测阶段与规则

流程分为资料准备、生成站采集、参考站采集、证据检查、模型评分、报告输出。任务进入持久队列后由 Node Worker 执行，管理页关闭后继续。执行记录按最新在前展示。

首次使用时默认规则为 `agent-ui-v1`；发布自定义版本后，新任务默认使用最近发布的版本，也可明确指定旧版本。Agent 根据冻结的 SOP 与本轮规则自主调用 `get_task`、`capture_page`、`read_images`、`submit_review`、`submit_assessment` 或 `report_blocked`。旧 `visual-v1` 继续执行原流程。暂不提供可视化流程构建器。

Playwright 在同一个页面中导航、有限滚动并等待字体和图片，保存桌面与移动视口的连续截图，跟随懒加载后的高度增长。Agent 可在次数和时限内调整等待并重采。overview 工具用真实截图生成带编号的图片表；每批实际像素输入模型后才接受审查引用，需要时可读取原图。必须看完每个视口的全部分段；整页诊断图不能代替分段证据。两站按语义区域配对，界面允许分别选择分段及使用报告中的配对导航。

每轮最多 80 次模型请求、120 次工具调用；每视口采集次数由运行设置限定，服务恢复后继续计数。工具参数和结果、模型响应、使用量、派生图片及来源、原始截图和报告均保存。关闭管理页不影响运行，停止服务保留检查点。新建评测默认使用新规则；旧记录和历史投递的幂等契约保留。

HTML 中未完成和损坏图片计数单独保存为 `*-image-load-diagnostics.json` 采集诊断，不自动进入问题清单、不影响页面可用性，也不关联首张截图。图片问题须由实际截图确认可见缺图、破图或加载占位，描述位置并引用对应分段。历史报告界面隐藏旧采集器生成的纯计数问题，保留原始报告及其他问题的操作序号。缺少截图、几何覆盖不完整、超过高度预算或截图期间继续增长仍阻止完整评分。

实际证据完整与请求范围完整分别记录：`coverage.captureComplete` 表示实际首页采集完整，`coverage.complete` 表示用户请求的范围已全部覆盖。全站请求仍只采集首页时可以输出明确标注的首页评分，保留 `requested=site`、`actual=homepage`、`complete=false`，不输出全站任务完成度，并强制注明范围局限，进入人工复核；这不代表全站评分通过。旧检查点没有可验证的实际采集完成标记时不自动升级，需要重新采集。

程序校验实际看图后提交的证据 ID、两站引用、移动截图和完整分项，计算加权总分。缺少证据、预算用尽或模型响应无效时保留失败和检查点。报告可从详情页下载 JSON，其中包含本轮规则与 SOP 版本快照。

“重试失败步骤”复用有效检查点；单步重试执行该阶段及其后续处理。例如重采参考站保留生成站截图，重新评分复用两站截图，重新输出报告复用已校验的评分。“完整重评”重新采集全部证据。截图通过来源轮次读取，历史记录保留；规则或采集器不兼容、证据丢失时不能直接沿用旧分数。

后续阶段重试发现缺失、损坏或视觉检查拒绝的截图时，可在本轮次数预算内补采该视口，其他有效视口继续复用。强制重采有效分支仍需选择对应采集阶段，避免重评分把成功证据全部重跑。

评分规则或采集器变化时重新采集；仅 SOP 更新时保留已完成的资料准备和截图，清除旧审查与评分，按新 SOP 重新看图、审查并评分。旧报告与原始证据保留在历史轮次，报告重试也不能绕过这项重新审查。

评分规则支持编辑草稿并发布新版本，发布版本不覆盖。编辑器支持新增、删除评分项，允许 1–30 项；每项名称、评分标准和权重可配置，发布时权重合计必须为 100%。草稿不参与评分。最近发布版本作为新任务的默认规则，明确指定版本的投递保持指定版本；已有任务、重试和历史投递继续保留原版本。每轮冻结规则、模型名称与接口、采集策略、SOP 版本和哈希。Agent 和旧评分流程均收到本轮完整维度配置，配置优先于评分指引中遗留的固定数量或维度示例。模型返回结构化分项与证据引用；程序拒绝缺项、重复项或未知项，校验引用并按本轮权重计算加权总分。没有参考时 UI 还原度为 `null`，没有可验证资料时任务完成度为 `null`。证据不足或模型结果无效时保留诊断，不把失败转换成零分。

当前覆盖首页静态视觉；全站请求会标记覆盖不足。截图不代表交互、动画、未采集页面和业务流程已经验收。规则尚未校准，分数用于辅助批量筛选与人工复核。

## 插件与 Admin 接口

站点唯一标识为 Kooboo 实际生成站的完整域名，参考站域名不作为站点键。同域名保留历史与多轮重评。

插件投递：

```http
POST /api/evaluations
Authorization: Bearer <投递令牌>
Idempotency-Key: <attemptId>
Content-Type: application/json
```

请求沿用 `schemaVersion: 1` 的站点任务协议，包含 `attemptId`、`requestId`、`jobId`、`trigger: "chat_stopped"`、`occurredAt`、`target: { koobooOrigin, siteId }`、`inputs`、`scope` 和可选的 `ruleSetVersion`。`Idempotency-Key` 必须等于 `attemptId`。`inputs` 可包含 `sourceUrl`、`referenceUrl` 和 `materialsPath`；内容来源地址不会自动当作视觉参考。

Admin 查询：

```http
GET /api/sites/{domain}/evaluations/latest
GET /api/sites/{domain}/evaluations
GET /api/jobs/{jobId}/evaluations/latest
GET /api/evaluations/{evaluationId}
GET /api/evaluations?needsReview=true
GET /api/evaluations?fidelityBelow=80&latestPerSite=true
Authorization: Bearer <查询令牌>
```

查询包含 `scoringStatus`：`pending` 为执行中，`failed` 为执行失败，`unscored` 为无有效分数，`partial` 为仅有任务完成度，`scored` 为已有 UI 还原度。`status=completed` 只表示执行生命周期结束；Admin 应结合评分状态、分数、置信度和覆盖情况决定后续处理。

管理页重试接口使用当前本机会话：

```http
POST /api/evaluations/{id}/runs
Content-Type: application/json

{ "mode": "reference", "sourceRunId": "当前轮次 UUID" }
```

`mode` 支持 `failed`、`all`、`prepare`、`target`、`reference`、`check`、`score`、`report`。`sourceRunId` 用于拒绝过期页面的重试请求；执行中不能并行重评。详情中的 `run.pipeline.steps` 与视口检查点提供阶段状态、耗时和错误。


## 报告复核与站点修复

截图对照默认连续浏览、两侧联动，可解除联动后独立切换。区域导航优先使用报告的语义配对；旧报告缺少配对时按分段顺序联动并明确提示。连续展示只裁剪重叠区域，不修改原始证据。问题下可展开对应截图，截图下同步显示当前可见证据关联的问题。

问题支持多选、忽略与恢复。状态按不可变的 run 和问题序号保存，忽略不改写原报告或原评分；历史轮次独立保存，发送修复仅允许当前已结束且有报告的轮次。

发送流程：选择问题 → 预览并确认所属站点 → 新窗口打开该站点 AI Chat → 新建修复会话 → 按正常 AI Chat 队列发送文本与真实 PNG 证据。站点通过已配置 Kooboo 环境的 Site/List 和生成站完整主机名匹配，不按站点名称猜测。图片按来源轮次与哈希校验，总量最多 32 MiB、100 张；超过时需分批发送。

此入口需要目标 Kooboo 环境运行包含 evaluationHandoff 接收端的管理前端；该接收端位于 Kooboo 仓库的 `Frontend/src/views/ai-chat/composables/useEvaluationHandoff.ts`。发送与接收两侧验证窗口、精确 origin、交接编号及站点 ID；URL 只放交接编号和来源，凭据与截图不放 URL。当前仅信任本机 4180/4181 端口的评测平台。浏览器必须允许新窗口并保留 opener，跨域隔离策略清除 opener 时无法自动交接。

“已接收”表示 AI Chat 消息已进入队列，不代表代码修复或重评通过。接收端以 sessionStorage 记录交接编号防止重复创建会话；接收中刷新、关闭窗口或回执超时，平台提示先检查站点会话，不能自动重发。忽略与交接元数据保存在本机 SQLite；当前不跟踪修复完成进度，不支持直接从原建站会话继续。

复核相关测试：`tests-node/comparison.test.ts`、`tests-node/issue-actions.test.ts`、`tests-node/repair-window.test.ts`。Kooboo 接收端的定向校验：在 Kooboo 仓库执行 `node Frontend/scripts/check-evaluation-handoff.cjs`。这些模拟与代码检查不代表真实浏览器或远端 AI Chat 验收。

## 制作交付包

先完成测试和构建并提交源码，再执行（Python 3）：

```sh
python3 scripts/package-delivery.py --plugin /path/to/kooboo_material_site_builder --output /path/outside/projects/new-delivery
```

生成插件、平台及组合 ZIP、版本清单与 SHA-256。仅复制 Git 源码与明确的插件文件目录、构建产物，不复制 `.data/`、`.env`、node_modules 或 Git 元数据。交付前重新构建两个项目，避免同版本旧产物。

## 站点迁移采集运行环境

新建全站迁移/升级任务先执行 A 段（原站→冻结资料），核验通过后才创建目标站；B 段（冻结资料→实际响应及后台数据）独立影响完整性和优化达标。实现说明见 `docs/site-migration-autonomous-design-v1-2026-11-08.md`。

平台内置 `engines/site-harvest` 与采集 SOP，不依赖个人 site-harvest skill。Windows/macOS 需 Node.js 24+、Python 3.12；运行 `npm run install:collection` 初始化项目数据目录中的独立 Python 环境，`npm run check:collection` 自检。安装器不安装 Python 本体、不改全局包或已有加密配置。自定义 `EVALUATOR_DATA_DIR` 时在相同环境执行安装命令。

普通采集与有限规则适配提供 Windows/macOS 分支；Windows 尚未实机验收。代码修复当前仅支持 macOS Seatbelt，隔离不可用时关闭该修复能力并保留缺口，不能改用无隔离执行。平台重启保留采集检查点、固定资料、任务用量；未知建站或消息投递不会自动重发。
