# Verification Engineering：独立评测 Checker 重构探索与方案记录

- **创建日期**：2026-11-20
- **最后更新**：2026-11-22
- **状态**：已完成 **Phase 1 / 1.1 / 1.2 单页真机实测收敛**（`auto_f9579f55_e3b`：`29d7a053` 旧版 → `c9059ef6` Phase 1 → `33a45716` Phase 1.1 → `72689a9a` Phase 1.2）并完成 **Phase 2 / 2.1 多页全站（`materials/site` · `upgrade/site` · `migration/site`）实现、弹性修复及 `auto_7afb0300_537` 真实 3 页站点端到端实机验收**（`dc70a363`：`9 req / 6m29s / ¥0.3541 / 90·78 failed`）；待按需推进 **Phase 3（`CHECKS.md` 一错一规闭环与 `delivery` 真机对比）**
- **方法论灵感**：`@distortgeekin` — *Verification Engineering: How to Build AI Agents You Never Have to Check*（2026-11-12）
- **平台角色映射**：
  - **Maker**：Kooboo AI Chat（建站与修复）
  - **Checker**：Kooboo AI Automation Lab 独立评测与交付核验模块
- **项目硬约束（遵循 `AGENTS.md`）**：
  1. 统一自动化模块保留 Codex SDK（支持配置 Responses 地址、模型与加密 API Key，默认 `deepseek-flash-1017`，禁止修改全局 Codex 配置）。
  2. 验证模型识图能力时，必须输入真实图片，不能用纯文本或模拟单元测试代替。
  3. 保留阶段检查点、证据所属来源轮次的引用、带版本的规则与 SOP 快照，以及 Admin 集成约定。
  4. 不通过删减覆盖范围、跳过双端核验或把未知伪装为通过来制造降本提速。

---

## 一、方法论锚点（从文章沉淀到本项目的 6 条原则）

1. **`"Done" is a claim, a check is proof`**：完成只是 Maker 的宣称，带证据的检查才是证明。
2. **完成度分级（Level 0 → Level 5）**：当前平台在客观留痕上已具备 Level 3–4 骨架（独立会话、真实 Playwright 截图、SHA-256 哈希绑定、nonce 提交防伪），但因为**打分虚高不敢盲信 + `unverified` 机械卡死**，既没有做到让人工真正放心不复核（真 Level 4），也没跑通自动放行（Level 5）。
3. **`Maker ≠ Checker` 且隔离推理过程**：Checker 使用独立 Codex 线程，不读取 Maker 的生成思路与自圆其说，只看冻结标准与真实结果（须继续坚守）。
4. **`Default = No` + 前置 Pass/Fail 标准**：当前规则偏主观描述，缺少严苛分档锚点与缺陷封顶机制，导致模型默认偏向给高分夸赞。
5. **确定性事实交给程序，模型只做视觉/语义/交互判断**：当前 Checker 仍承担大量 Shell 探索、读目录、找规律与重复查证工作，这是贵和慢的核心根因。
6. **`One Rule Per Mistake`（一错一规）**：人工每次复核抓到的漏判，不再停留在单次对话修补，而是沉淀为一条版本化的前置检查规则（`CHECKS.md` / 规则快照）和标定反例，确保同类问题不再靠人工抓第二次。

---

## 二、当前现状基线（基于 2026-11-07 ~ 11-20 本机只读账本与源码）

> 数据来源：本机只读 `.data/database.sqlite`（共 241 条 `auto_tasks`、46,182 条 `auto_usage` 账本记录）及源码 [`server/automation/evaluator.ts`](../../server/automation/evaluator.ts)、[`template-workflow-evaluation.ts`](../../server/automation/template-workflow-evaluation.ts)、[`template-checks.ts`](../../server/automation/template-checks.ts)、[`delivery.ts`](../../server/automation/delivery.ts)、[`probe.ts`](../../server/automation/probe.ts)。以下仅保留脱敏聚合指标与案例事实，不含任何密钥或敏感运行数据。

### 2.1 成本基线

- **全库已计价累计（`deepseek-flash`）**：
  - 独立评测（`evaluation`）：**¥177.42**（25,289 次请求）
  - 生成与修复（`generation`）：**¥91.53**（10,925 次请求）
  - 异常跟进（`followup`）：¥24.53（3,496 次请求）
  - 经验学习（`experience`）：¥19.72（3,325 次请求）
  - 清单规划（`planning`）：¥11.63（1,995 次请求）
  - 跨环境交付核验（`delivery`）：¥1.43（116 次请求，仅 11-20 单例）
  - **结论**：历史累计纯评测开销接近生成的 **2 倍**。

- **分时期 / 场景同口径配对对比**（排除无价格快照的 `gpt-6.1-sol` 后，按同站点首轮生成 vs 首轮评测统计）：

| 时期 / 场景 | 样本规模 | 首轮生成中位 | 首轮评测中位 | 首轮 `评测/(生成+评测)` | 整站 `评测(+交付)/总费用` |
| :--- | :--- | ---: | ---: | ---: | ---: |
| `site-template/site`（11-07~11-10） | 26 评 / 12 生 | ¥0.78 | ¥1.01（P90 ¥4.39） | — | 约 54%–70% |
| `site-template/site`（11-11 批量） | 36 评 / 10 生 | ¥1.14 | ¥1.72（P90 ¥3.79） | 58.8%（中位） | 当日全盘 **63.9%** |
| `site-template/site`（11-14 v0.7） | 3 评（+1 中断） | ¥0.75 | ¥1.24（另 1 例中断 ¥3.30） | **57%–65%** | **43%–66%** |
| `homepage`（11-19~11-20 实测） | 3 组已计价配对 | ¥0.41（¥0.37–¥0.75） | ¥0.37（¥0.24–¥0.43） | **24%–51%（中位 50%）** | **21%–77%** |

- **当前成本核心发现**：
  1. 单页场景的纯评测绝对费用已降至 **¥0.24–¥0.43**，但因为生成也降到 **¥0.37–¥0.75**，**评测占比中位数仍维持在约 50%**；全站模板首轮占比仍高达 **57%–65%**。
  2. **跨环境 `delivery` 成为新成本黑洞**：11-20 `edc98e9c` 首轮生成 ¥0.41（34 次请求）、源站评测 ¥0.43（37 次请求），但交付核验（`stage=delivery`）烧掉 **¥1.43（116 次请求）**，把整单核验占比推升至 **77%**。
  3. **未计价口径提醒**：11-14 ~ 11-19 期间有 **643 条 `gpt-6.1-sol` 请求**（规划 409、评测 143、跟进 91，累计约 5,087 万输入 / 18.4 万输出 token）因 `auto_prices` 缺少该模型价格快照在账本记为 `null`，看总金额时需留意这部分隐性消耗。

### 2.2 效率基线

- **`site-template/site`**：
  - 11-11 批量：生成耗时中位 21.9m vs 评测耗时中位 **40.9m**（约 **1.9x**，296 次请求）。
  - 11-14 v0.7：生成耗时中位 11.0m vs 评测耗时中位 **22.6m**（约 **2.0x**，232 次请求；另有 1 例中断跑了 67.7m）。同时 15 条 `auto_template_workflows` 中仅 3 条最终进入并完成 `auto_template_evaluations`。
- **`homepage`（11-19~11-20）**：
  - 生成耗时 3.8–5.6m（中位 4.8m，34–51 次请求） vs 纯评测耗时 3.8–11.7m（中位 5.5m，37–89 次请求）。
  - 其中 `edc98e9c` 加上 `delivery` 核验后总计耗时 **21.2m**（约首轮生成的 **5.5x**）。
- **典型低效现场证据**：
  1. **`evaluator.ts` 非模板评测“现场读平台源码学工具”**（11-20 `edc98e9c`）：非模板分支的 prompt（第 305 行）只写了 `snapshot` / `screenshot` / `navigate` 等动作而未说明 `take_page_screenshots`，导致模型 `PageDown` 失败后直接用 `rg` 和 `sed` 翻读平台自身源码 `server/automation/browser.ts` 与 `page-screenshots.ts`，又用 `curl` 抓回完整 HTML/JS/CSS 自行检查，白白浪费十几轮模型调用。
  2. **`delivery.ts` 证据混淆与无预算死循环**（11-20 `edc98e9c`）：`delivery.ts` 第 92 行调用 `usageCapture(task.id, 'delivery', ...)` 未传入 `RequestBudgetPolicy`；同时第 93 行写入 `delivery/task.json` 的 `sourceReport` 包含了源站评测报告里的旧证据文件名，模型混用旧文件名反复触发第 108 行的 `交付核验引用了不存在的证据` 校验报错并持续重试。

### 2.3 效果与“分数虚高”实锤案例

近 7 天已完成的 12 份评测呈现典型的**“分数偏宽虚高 + `unverified` 机械卡死”两极失真**：

1. **核心反例 #1（人工定性锚点）：`edc98e9c` 星禾空间（建筑灯光设计工作室，2026-11-20）**
   - **客观画面问题**：作为“建筑灯光设计工作室”官网，首屏 Hero 右侧主视觉（以及下方 3 个精选项目卡片）使用极简陋的纯几何抽象 SVG（同心半圆 + 三角形渐变光锥 + 细线 + 圆点）充当视觉主体，完全达不到商业交付的质感与行业说服力。
   - **Checker 原判定**：给出 **Hero Desktop = 96 / Mobile = 95，总分 Desktop 92.6 / Mobile 94.4，0 Critical / 0 Major，仅 1 条 Minor（桌面端区块大标题断行失衡），`humanSummary.verdict = "ready"`**。甚至在 `hero(desktop)` 评语中将其高度夸赞为：
     > *“右侧纯 CSS/SVG 抽象光影视觉与深色摄影棚式背景融为一体。首屏留白充足，品牌气质明确……”*
   - **根因诊断**：规则中缺少针对“廉价几何 SVG 充数 / 缺少真实视觉素材”的反模式红线，模型被深色背景与衬线排版的“表面高级感”误导，对简陋 SVG 做了合理化美化。

2. **核心反例 #2：v0.7 Checklist 算分公式严重稀释核心缺陷**
   - [`template-workflow-evaluation.ts`](../../server/automation/template-workflow-evaluation.ts#L119-L134) 中：`passed` 未指定分值默认计 `100`，`failed` 计 `0`，`unverified` 与 `not-applicable` 设为 `null` 并**直接从分母剔除**；而 `auto_template_checklists` 中 13 项有效检查权重全部为 `w=1`。
   - **`da8309ff`（Playo 128，11-14）**：同一生成站，旧三维评分已经把移动端打到 **68 分**（`hero(mobile)=58`、`sections(mobile)=60`，检出 13 个 Major），但新 Checklist 因为大量基础结构/留白/换行项拿 100 且 52 项未验证被剔除，算出 **Desktop 95.4 / Mobile 94.5**——**虚高 26.5 分**。
   - **`c6efb9d3`（Stageo 歌剧院，11-14）**：196 项检查中 30 项 `unverified`（含 12 项交互、12 项可访问性）被直接剔除分母，其余 140 项全部计 100 分，算出 **Desktop 100 / Mobile 100**（旧报告 92 / 91，0 issues）。

3. **核心反例 #3：近期 12 份完成评测 `quality = passed` 为 0 份**
   - 11-13 ~ 11-20 已完成的 12 份评测中，4 份 `failed`，8 份 `unverified`，**0 份 `passed`**。
   - 模型一边给 90–95 分、将 `humanSummary.verdict` 写为 `ready`，一边习惯性把“预览环境缺少生产 SEO/上线证明”“无原始图片版权证明”“非目标要求范围的后台动态模型证明”写入 `coverage.unverified` 而非 `outOfScope`。
   - 而 [`evaluator.ts`](../../server/automation/evaluator.ts#L69-L72) 规定只要 `coverage.unverified` 非空就判定 `quality = 'unverified'`，导致自动交付被拦死（如 `edc98e9c` 记录 `自动交付未启动：当前交付策略要求源站评测通过`）。

---

## 三、B 方向目标架构：三段式有界验证管道（Bounded Verification Pipeline）

核心思路：**把 Checker 从“自主跑命令行探索的通用 Agent”收敛为“程序全量预检 + 宿主直传实图的有界多模态评判 + 宿主硬裁决”**。

### 3.1 目标 KPI 验收线

> **优先级已确认（2026-11-21）**：**效率与效果为 P0 核心指标**。费用不强求硬性远低于生成费用，但只要请求数从几十/上百次收敛到 1–3 次、消除无效长会话与重试循环，成本自然会大幅下降。

| 维度 | 当前现状基线 | 目标验收线 |
| :--- | :--- | :--- |
| 效果与防虚高校准（P0） | 星禾空间 Hero 96、总体 92.6/94.4 `ready`；近 7 天 0% `passed` | 星禾空间稳定检出 Hero SVG Major 且拉低至 **≤ 70 分（非 `ready`）**；真实合格站可稳定输出 `passed` |
| 单页评测请求数与耗时（P0） | 37–89 次请求 / 3.8–11.7 分钟 | **1–3 次请求 / ≤ 1–2 分钟** |
| 全站 / 多页单轮评测（P0） | 232–296 次请求 / 22.6–40.9 分钟 | **请求数下降 ≥ 75% / 耗时 ≤ 生成的 0.5x–0.8x** |
| 跨环境 `delivery` 核验（P0） | 116 次请求 / ¥1.43 / ~17 分钟（单次含重试） | **≤ 2 次请求 / ≤ ¥0.05 / ≤ 30 秒** |
| 评测费用参考线（跟随指标） | 单页中位 ~50%（加 delivery 达 77%）；全站 57%–65% | 单页目标约 **生成费用的 15%–20%**（¥0.05–¥0.10 级）；全站 **≤ 25%–35%** |

### 3.2 核心技术依据（已核实可行）

- 检查已安装的 [`node_modules/@openai/codex-sdk/dist/index.d.ts`](../../node_modules/@openai/codex-sdk/dist/index.d.ts#L197-L265) 及 [`server/automation/probe.ts`](../../server/automation/probe.ts#L13-L15)：
  - `Thread.runStreamed` 原生支持 `UserInput[]` 多模态数组输入：`[{ type: 'text', text }, { type: 'local_image', path }, ...]` 配合 `outputSchema`。
  - 支持 `sandboxMode: 'read-only'` 与 `networkAccessEnabled: false`。
- 因此无需更换 Codex SDK，即可直接把原本需要模型“读源码 + 跑工具找图 + 读图”的几十轮交互，压缩成**宿主预先备好证据并直接把本地截图输入多模态上下文**的极少轮次评审。

### 3.3 管道结构设计

```text
[Stage 1: 宿主确定性采集 + 程序预检]  (0 次模型调用, 0 Token 费用)
   ├─ Playwright 统一 take_page_screenshots (PC 1440×1000 / Mobile 390×844, SHA-256 绑定)
   ├─ DeterministicPrecheck (单次 page.evaluate + DOM/网络/交互烟雾探针 -> precheck-facts.json)
   └─ 后台与清单对账 (prepareTemplateFacts / collectionProgramEvidence)
          │
          ▼  最小化打包: local_image[] + precheck-facts.json + 冻结规则/outOfScope + outputSchema
[Stage 2: 有界多模态 Checker]  (Codex SDK read-only, 无网络, 无自由探索脚本, 强预算护栏)
   ├─ 单页默认 maxRequests = 3 (1次主评 + 1次修正 + 1次预留)
   ├─ 全站按页/批切分, 每批 maxRequests = 2~3
   └─ 必须针对预检标出的风险信号(如 HERO_ONLY_GEOMETRIC_SVG)逐条给出视觉裁定
          │
          ▼
[Stage 3: 宿主确定性裁决]  (硬性封顶 + 覆盖率分离 + Level 4 证据包)
   ├─ 严苛分档锚点 + Default = No 评分约束
   ├─ 宿主缺陷封顶 (Critical 视口 ≤ 55 / Major 维度 ≤ 72, 视口 ≤ 78, 且均判 failed)
   ├─ Checklist 分数与验证覆盖率分离 (禁止高 unverified 剔除分母后得高分)
   └─ 宿主按场景/输入自动固定 coverage.outOfScope, 恢复合法站点 passed 通道
```

#### Stage 1：宿主确定性采集 + 程序预检（0 次模型调用）
1. **统一逐屏取证**：所有场景（含 `materials` / `upgrade` 等非模板场景）统一由宿主在进模型前完成 `take_page_screenshots`（PC + Mobile）与哈希登记，不再由模型自行探索怎么截长图。
2. **新增 `DeterministicPrecheck`（输出紧凑 `precheck-facts.json`）**：
   - **视觉素材与廉价 SVG 探针（针对 Hero 与核心内容卡片）**：
     - 统计首屏区域（Hero）及各主要 `<section>` / 卡片容器内的真实 `<img>`（数量、加载是否完成、`naturalWidth × naturalHeight`、占首屏/容器面积比）与 `<svg>`（外接框宽高、占视口/容器面积比、基础几何图元 `<circle>/<rect>/<line>/<path>/<polygon>` 数量）。
     - 自动输出客观事实标记，例如 `HERO_ONLY_GEOMETRIC_SVG`（Hero 视觉主位无真实 `<img>`/照片且被大尺寸几何 `<svg>` 占据）、`CARD_GEOMETRIC_SVG_PLACEHOLDER`、`BROKEN_OR_EMPTY_IMAGE`。程序不越俎代庖做语义判断，但强制将这些信号高亮送入 Checker。
   - **布局与排版硬伤探针**：双端横向溢出（`scrollWidth > clientWidth`）、元素超出视口或父容器被裁切、固定 Header 遮挡正文、大标题末行单字孤行检测、极小字号（< 12px 正文）初筛。
   - **模板残留与链接/交互烟雾探针**：原模板品牌名/占位词文本扫描、空 `href` 或死链检查、页内锚点点击前后 `scrollY` 变化校验、移动菜单按钮展开前后可见性 / `aria-expanded` 状态切换检查。
   - **后台与清单对账**：继续复用 `prepareTemplateFacts` 与 `collectionProgramEvidence`。

#### Stage 2：有界多模态 Checker
- **收敛权限与上下文**：`sandboxMode: 'read-only'`、`networkAccessEnabled: false`，不向工作目录投放 `browser.mjs` / `inspect.mjs` 等自由执行脚本；所有信息通过 `precheck-facts.json` 与精选 `local_image` 直接送达。
- **预算硬护栏**：`evaluator.ts` 与 `delivery.ts` 全部接入 `RequestBudgetPolicy`，单页强制 `maxRequests = 3`，全站每批 `maxRequests = 2~3`，彻底杜绝“数百次请求滚雪球”。
- **必须先做的真实图片技术验证（遵循 `AGENTS.md`）**：
  - 需通过真实图片小规模实测确认 `deepseek-flash` 经由 Codex SDK 单次 `UserInput[]` 传入 **4–8 张 `local_image`** 时的实际表现：上限张数、单张分辨率/像素预算（注意参考此前 `390×10075` 超长图拒收经验，坚持逐屏分段截图而非拼接长图）、token 计费构成及对细节瑕疵（如廉价 SVG、外语价签、断行）的识别稳定度。

#### Stage 3：宿主确定性裁决
- **严苛分档锚点 + `Default = No`**：在所有规则与 SOP 中明确分数刻度：
  - `90–100`：仅授予零 Critical/Major、视觉素材达到真实商业交付水准（不得用简单几何 SVG 冒充主视觉）、双端体验细腻的页面；
  - `75–84`：结构可用，但存在明显视觉平庸、素材协调瑕疵或局部排版粗糙；
  - `< 70`：存在首屏视觉敷衍/廉价占位、移动端错位遮挡或核心内容缺陷。
- **宿主硬性缺陷封顶（Score Cap）**：`validateResult` 层直接强制约束——出现 `critical` 问题则对应视口总分封顶 **≤ 55** 且 `quality = failed`；出现 `major` 问题则对应维度封顶 **≤ 72**、对应视口封顶 **≤ 78** 且 `quality = failed`。不依赖模型是否自觉在打分时手软。
- **重构 v0.7 Checklist 算分逻辑**：
  - 将**质量得分**与**验证覆盖率（verifiedRatio）**分离计算与展示；
  - 废弃“简单结构项 100 分等权平均稀释核心缺陷”与“大量 `unverified` 项剔除分母后仍输出 100 分”的做法；必检交互/可访问性项若未验证，明确标记未验并限制最终通过态与高分上限。
- **宿主自动固化 `coverage.outOfScope`**：按任务 `scenario × scope × hasReference × hasMaterials` 由宿主预设范围外条目，同时在 prompt 严格禁止模型把预设范围外事项塞进 `coverage.unverified`，让真正合格的页面能顺畅产出 `quality = passed`。

#### Stage 4（同步止血）：跨环境 `delivery.ts` 与价格账本修复
1. **`delivery.ts` 重构**：
   - 目标站由宿主完成可达性检查 + HTTP/DOM/文本对比 + 双端 `take_page_screenshots`，随后单次（最多 2 次）`local_image` 传入目标与源站成对截图做视觉一致性复核。
   - **彻底隔离旧证据元数据**：从 `delivery/task.json` 移除 `sourceReport.artifacts` 文件名，只传脱敏文字摘要与本次采集的目标/源站证据清单，根除 `交付核验引用了不存在的证据` 重试循环。
   - 为 `usageCapture(task.id, 'delivery', ...)` 补上 `RequestBudgetPolicy`（上限 3 次请求）。
2. **`auto_prices` 补齐**：核实并补充 `gpt-6.1-sol` 等在用模型的价格快照（若无法确认官方单价，则在 UI 明确标示“未配置单价，费用未核算”，防止显示 ¥0.00 误导判断）。

---

## 四、“一错一规（`CHECKS.md`）”首批反模式种子库

把目前从真实历史任务中人工抓到的 4 类典型错漏/虚高问题沉淀为首批版本化硬规则：

| 规则 ID | 来源案例 | 规则内容与触发条件 | 程序预检信号 | 裁决与封顶动作 |
| :--- | :--- | :--- | :--- | :--- |
| **`R-VISUAL-01`** | `edc98e9c` 星禾空间（2026-11-20） | **非豁免场景下使用大块 `<svg>` 充当主视觉/展示卡片一律拦截**：Kooboo 在无素材图时推荐走 `imagePlaceholder`（见 `Kooboo.Web/Api/Implementation/AI/AiSiteBuilder.cs:146-152`，通过 `ImagePlaceholder.RedirectAsync` 返回真实配图 URL 并渲染为 `<img>`），而非手绘抽象几何 SVG 占位。因此无论是有图还是无图模式，Hero 主视觉或展示卡片若用大块 `<svg>` 充数，一律按 Major 拦截。*（仅豁免 4 类：工具型 SaaS 界面示意、技术架构页、数据图表、品牌 Logo 与小尺寸 UI 图标）*<br>注：`shared/automation.ts` 与 `harness/optimization/SKILL.md` 旧文案曾将 `imagePlaceholder` 限制为“仅 AI Site 模板使用”，后续场景收敛时需同步修正。 | `HERO_SVG_PLACEHOLDER` / `CARD_SVG_PLACEHOLDER`（无真实 `<img>` 且存在大面积非图表 `<svg>`） | 判定 **Major**；`hero` / 对应维度封顶 **≤ 70**，对应视口封顶 **≤ 75**，强制 `quality = failed`，`humanSummary.verdict ≠ ready` |
| **`R-VISUAL-02`** | `729e055e` / `55f1d6eb` 晨光烘焙、`1e3450f5` 青禾咖啡馆（11-19） | **配图语义、语种与品牌语境一致**：中文站点出现不搭调的外语价签/招牌文字、第三方无关品牌/设备 Logo 抢镜，或图片与所在卡片品类明显不符。 | 卡片文本与图片实体/OCR 语义异常提示（待配合视觉复核确认） | 局部配图记 **Minor**（要求替换）；出现在 Hero 或核心卖点图升格为 **Major** |
| **`R-LAYOUT-03`** | `da8309ff` Playo 128（11-14） | **移动端首屏对齐与防截断硬线**：移动端首屏严重错位、内容区裁切、页脚被截断或出现横向溢出。 | `HORIZONTAL_OVERFLOW` / `CLIPPED_AT_END` / 元素越界检测 | 判定 **Major**；移动端视口封顶 **≤ 75** 且 `quality = failed`，禁止被简单区块结构 100 分稀释 |
| **`R-COVER-04`** | `c6efb9d3` Stageo 歌剧院（11-14） | **必检项未验证比例过高禁出满分/高分**：v0.7 Checklist 中交互或关键项大量为 `unverified` 时，严禁剔除分母后给出 90+/100 分或 `passed`。 | `unverified_required_ratio > 阈值` | 强制分离质量分与覆盖率；存在关键未验证项时禁止 `passed` 或 90+ 综合评级 |

---

## 五、分阶段落地路线与场景收敛规划

> **现实前提（2026-11-21）**：本地 Kooboo 站点已清零，Automation Lab 任务列表已舍弃清空；但 `.data/automation-runs/` 磁盘仍完整保留 4 组近期真实评测截图与观察记录，可直接支撑离线实图验证：
> - `edc98e9c` 星禾空间（`materials/homepage`，23 张 PNG）
> - `729e055e` 晨光烘焙第 1 轮（`upgrade/homepage`，46 张 PNG）
> - `1e3450f5` 青禾精品咖啡馆（`materials/homepage`，59 张 PNG）
> - `55f1d6eb` 晨光烘焙第 2 轮（`upgrade/homepage`，48 张 PNG）

1. **Phase 0A：盘上现成实图离线多模态 A/B 验证**
   - 本轮已落地 3 个独立基础模块（未改动现有主链路）：
     - 规则与封顶引擎：[`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts)
     - 确定性视觉预检探针：[`server/automation/visual-precheck.ts`](../server/automation/visual-precheck.ts)
     - 离线实图 A/B 基准脚本：[`scripts/phase0-bounded-checker-bench.ts`](../scripts/phase0-bounded-checker-bench.ts)
   - 利用盘上保留的 4 组历史 PNG 跑 `--dry-run` 与 `--live` 对比，实测验证 Codex SDK `local_image` 多图输入表现、请求数（目标 1 次主评）、耗时、Token 消耗，以及 `edc98e9c` 星禾空间是否稳定检出 Hero SVG Major 并拉低分数、正常站点（如 `55f1d6eb` / `1e3450f5`）能否走通 `passed`。

#### Phase 0A `--live` 实测 A/B 对比结果（2026-11-21，`deepseek-flash`，单轮传入 8 张 `local_image`）

| 站点 / 场景 | 版本 | 轮次 / 请求数 | 耗时 | 估算费用 | Token 明细 | 评分（D / M） | Hero（D / M） | 质量态 / Verdict | 关键检出问题 |
| :--- | :--- | ---: | ---: | ---: | :--- | :---: | :---: | :---: | :--- |
| **`edc98e9c` 星禾空间**<br>(`materials/homepage`) | **旧版** | 37 req（含 delivery 共 153 req） | 3.8m（全单 21.2m） | ¥0.4290（全单 ¥1.8592） | — | `92.6 / 94.4` | `96 / 95` | `unverified` / `ready` | 漏掉 Hero/卡片廉价 SVG，仅报 1 Minor |
| **`edc98e9c` 星禾空间**<br>(`materials/homepage`) | **新版** | **1 轮** | **60.6s** | **¥0.0517** | in 21,463 (cached 7,680) / out 9,432 (reason 7,298) | **`73.6 / 70.0`** | **`66 / 62`** | **`failed` / `needs-fixes`** | **2 个 `R-VISUAL-01` Major**（Hero 光锥抽象图形 + 3 张项目卡光斑替代实景）+ 1 Minor（单字孤行） |
| **`55f1d6eb` 晨光烘焙**<br>(`upgrade/homepage`) | **旧版** | 65 req | 5.5m | ¥0.3168 | — | `94.8 / 94.4` | `96 / 96` | `unverified` / `ready` | 1 Minor，但被 3 条无关 `unverified` 锁死 |
| **`55f1d6eb` 晨光烘焙**<br>(`upgrade/homepage`) | **新版** | **1 轮** | **79.3s** | **¥0.0547** | in 21,149 (cached 13,824) / out 11,767 (reason 10,261) | **`92.2 / 90.8`** | **`93 / 91`** | **`passed` / `ready`** | 1 Minor（Hero 图角标注对比度偏低）；有效区分 `outOfScope` 后正常放行 |

**Phase 0A 实测关键发现**：
1. **单轮直传 8 张 `local_image` + `outputSchema` 在 `deepseek-flash` 上一次成功**：请求数压到 **1 轮**，耗时压到 **60.6s / 79.3s**（原 3.8m / 5.5m），单轮纯评测成本压到 **¥0.0517 / ¥0.0547**（降幅 **88% / 83%**）。
2. **盲区与虚高彻底逆转**：即便在无实时 DOM 预检的纯看图回放条件下，`edc98e9c` 模型自主识别出 Hero 抽象光锥和三张卡片渐变光斑违反 `R-VISUAL-01`（甚至未等宿主封顶介入，模型自身原始打分已压到 `73.6 / 70.0`），并准确定位出桌面端“始”字孤行；`55f1d6eb` 则正常给到 `passed / ready`，打破了近 7 天 0% `passed` 的僵局。
3. **带入 Phase 1 的 2 项调优细节**：
   - **语言显式约束**：`55f1d6eb` 实测中部分 JSON 文本字段受英文 schema/引用影响输出了英文（导致 `outOfScope` 出现中英双份拼接）；Phase 1 需在 `buildBoundedCheckerPrompt` 明确要求所有说明与摘要字段必须用简体中文输出。
   - **单页全覆盖传图上限放宽**：`edc98e9c` 共有 4 张桌面 + 7 张移动逐屏图（共 11 张），`--max-images 8` 仅抽样 4 张移动端时，Checker 诚实识别出中间 2 屏未被截图覆盖而写入 `unverified`；`55f1d6eb` 8 张抽样（每端 2 张）未覆盖到页尾配图细微语种差异。Phase 1 接入 `take_page_screenshots` 后，单页应传入全部逐屏分段图（例如 10–14 张全覆）而非硬截断为 8 张（并先用真实图片验证单轮 12–16 张 `local_image` 稳定性，超限则拆为桌面批 + 移动批）。

2. **Phase 0B：新生成本地站点全链路真机验收（Stage 1 + Stage 2 + Stage 3）**
   - 在本机 Kooboo 环境通过真实浏览器新建无图资料站「Phase0B 实测-云隅精品咖啡馆」（`materials/homepage`，生成任务 `f9579f55-e3b0-40da-81b2-bee153cf65ce`，线上预览地址 `https://auto_f9579f55_e3b.localkooboo.com/`）。
   - 因首次生成完成时后台仍驻留构建前旧进程，意外获得了**同一站点**在**旧版 Shell 自由探索评测（`29d7a053`）**与**重启加载 Phase 1 初版后有界多模态评测（`c9059ef6`）**的 1:1 实机对照样本：

#### Phase 0B 同站 1:1 真机实测对比表（`auto_f9579f55_e3b` · 云隅咖啡馆 · `deepseek-flash`）

| 阶段 / 方案 | 任务 ID | 执行方式 | 总耗时 | 请求数 | Tokens（输入 / 缓存 / 输出） | 估算费用 | 占单次全流程成本 | 评分（D / M） | 质量态 / Verdict | 实测检出与表现 |
| :--- | :--- | :--- | ---: | ---: | :--- | ---: | ---: | :---: | :---: | :--- |
| **生成（含 3 次跟进）** | `f9579f55` | Kooboo AI Chat + 内置跟进 | 362.0s (6m02s) | 76 (41+35) | in 4,228,118 (cached 4,114,688) / out 57,206 | **¥0.4246** | — | — | `executed` | 首屏与单品卡片均使用 `imagePlaceholder` 真实咖啡摄影（0 个 `<svg>`） |
| **旧版评测（对照基线）** | `29d7a053` | Codex CLI Shell 自由探索（`browser.mjs` / `inspect.mjs` / `curl`） | 262.6s (4m22s) | **50** | in 3,532,756 (cached 3,434,624) / out 26,798 | **¥0.2740** | **39.2%**（占生成比 64.5%） | `93.6 / 84.2` | `failed` / `needs-fixes` | 点击移动汉堡菜单检出 1 Major（全屏菜单缺关闭入口）+ 1 Minor（固定页头透字与锚点留边） |
| **Phase 1 初版有界评测** | `c9059ef6` | 两批串行（desktop 6 图 + mobile 11 图）纯 `read-only` + `local_image` + `visual_precheck` | 227.7s (3m48s) | **2**（**-96.0%**） | in 43,567 (cached 22,784) / out 29,989 | **¥0.1412**（**-48.5%**） | **25.0%**（占生成比 33.3%） | `90.2 / 91.0` | `unverified` / `incomplete-check` | 零次补错直接过校验；准确识别真实摄影未误触发 `R-VISUAL-01`、抓出固定页头透字及 `mm/dd/yyyy` 日期未汉化（4 条 Minor），但暴露下方 4 项真机问题 |
| **Phase 1.1 修复复测** | `33a45716` | **2 批并行**（18 张实图含移动菜单展开 PNG + `maxConcurrent: 2`）+ `MOBILE_MENU_TRAPPED` 探针 | **84.2s** (1m24s)<br>（**-67.9% / 3.1x**） | **2**（**-96.0%**） | in 44,125 (cached 28,672) / out 16,636 | **¥0.0826**（**-69.9%**） | **16.3%**（占生成比 19.5%） | **`89.4 / 72.6`** | **`failed` / `needs-fixes`** | **4 项修复全真机验证通过**：`captureGaps=[]` 且 `unverified=[]`、双批并行 55s 完成、成功捕获 `R-LAYOUT-03` Major（移动菜单无关闭入口 + 实图 `f3033ba3...png`）、`outOfScope` 预设 6 条零重复 |
| **Phase 1.2 合并微调复测** | `72689a9a` | **2 批并行** + 跨批视口隔离提示 + 跨端同类 Minor 合并 + `internalLinks`/`seoMeta` | **101.8s** (1m42s)<br>（**-61.2%**） | **2**（**-96.0%**） | in 44,496 (cached 27,648) / out 19,595 | **¥0.0958**（**-65.0%**） | **18.4%**（占生成比 22.6%） | **`92.6 / 74.4`** | **`failed` / `needs-fixes`** | 单视口 `outOfScope` 泄漏彻底消除（精确 6 条）；PC+移动半透明页头问题自动合并（4 条独立 `issues`）；稳定抓出 `MOBILE_MENU_TRAPPED` Major；另暴露静态表单/无缺陷套话 2 处规则补丁并已落地单测 |

**Phase 0B 实测暴露的问题与 Phase 1.1 / 1.2 真机复测结论**：
1. **有限动画误触发 `unverified` 死锁（已修并真机验证通过）**：桌面 6 屏与移动 11 屏均 100% 覆盖文档高度且 `0 pending images, 0 broken images, fontsReady=true`（模型两批均判 `verdict: ready`、`unverified: []`），但首 2 屏因 `1 running finite animations` 返回 `Screenshot 1/2 did not settle` 写入 `receipt.gaps`，[`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 原逻辑将全部 `!receipt.coverageComplete` 的提示无差别写入 `captureGaps → unverified`，导致健康站点被锁死为「有待验证」。Phase 1.1 新增 `extractBlockingCaptureGaps` 分流，仅把真实缺图、资源未加载或覆盖截断计入 `unverified`。复测 `33a45716` & `72689a9a`：`captureGaps` 持续为空、`captureNotes` 正常记录 4 条动画说明；针对 `72689a9a` 中模型将「静态展示表单提交与校验」写入 `unverified` 的情况，随后在 `defaultOutOfScope`（`homepage && !hasBackendAccess`）与 `classifyUnverifiedLeaks` 补入精确静态表单范围外约束，并在 `visual-precheck.ts` 增加确定性 `#anchor` 锚点目标自检（`anchorCheck`）。
2. **总耗时偏慢（227.7s → 84.2s ~ 101.8s，较旧版提速 2.6x–3.1x）**：`c9059ef6` Playwright 采集耗时 39s（对 4 屏有限动画空等满 `4000ms`），模型两批串行等待 185s（`97s + 88s`）。Phase 1.1 将 target 逐屏静止等待收敛至 `settleTimeoutMs: 2000`，将多视口批次改为 `Promise.all` / `runWithConcurrency(..., 2)` 并行，并针对首次真机试跑 `72736935` 暴露的 [`request-budget.ts`](../server/automation/request-budget.ts) 单飞并发锁（`同一预算仍有模型请求执行中`）在 `RequestBudgetPolicy` 新增可选 `maxConcurrent`（仅有界评测开启 `maxConcurrent: 2`，保持其余阶段单飞约束）。复测 `33a45716` / `72689a9a` 两批并行零冲突零重试。
3. **跨批 `issues` / `outOfScope` / `humanSummary` 合并（Phase 1.2 真机验证生效并完成细节兜底）**：Phase 1.1 先完成 6 条预设 `outOfScope` 零重复；Phase 1.2 实测 `72689a9a` 进一步真机验证：**（a）** 消除 `"桌面端视口的布局与交互验收（本轮仅提供移动端证据）"` 跨批泄漏；**（b）** 跨视口同类 Minor 自动合并（PC 2 图与移动 3 图的固定导航叠影合并为 `issues[0]`，总 issue 从 6 条收敛为 4 条）。针对 `72689a9a` 留存的 `"未发现严重或主要缺陷"` 乐观套话，已扩展 `filterContradictoryHighlights` 正则并加入单测回归。
4. **移动菜单交互缺陷检测盲区（已修并两轮真机稳定命中）**：旧版 `29d7a053` 通过点击移动汉堡菜单抓出“全屏菜单无关闭入口、汉堡按钮被遮罩拦截”的真实 `major` 问题，而初版仅做静态滚屏截图未触达菜单交互。Phase 1.1 在 [`visual-precheck.ts`](../server/automation/visual-precheck.ts) 与 [`browser.ts`](../server/automation/browser.ts) 新增移动端汉堡开关展开/关闭确定性探针（`inspectMobileMenuStateInPage` / `probeMobileMenuInPage`），仅在发现无关闭入口或关闭失效时自动截留 `visual_precheck` 展开态 PNG 并触发 `MOBILE_MENU_TRAPPED`（归入 `R-LAYOUT-03` Major）。`33a45716` 与 `72689a9a` 两轮真机均稳定拦截全屏遮罩并判定 **`failed / needs-fixes`**。

> **当前验收边界**：Phase 1 / 1.1 / 1.2 单页链路与 **Phase 2 / 2.1 多页全站链路**均已完成真实站点端到端实测（单页 `auto_f9579f55_e3b` `33a45716`/`72689a9a` + 3 页全站 `auto_7afb0300_537` `dc70a363`），并与本地 `npm run check`、72 项核心回归单测及 `npm run build` 交叉验证；带真实源站的 `upgrade/site` 实机对比、跨环境 `delivery` 真机对比以及 `anchorCheck` 页内锚点实站点命中样本待按需补充。

#### Phase 2 多页全站真机实测对比（`auto_7afb0300_537` · 拾光建筑设计事务所 · 3 页 · `deepseek-flash`）

> 测试站点为通过本机 Kooboo AI Chat 真实生成的无图静态 3 页站（`/`、`/projects`、`/about`），均通过 `imagePlaceholder` 生成真实建筑摄影 `<img>`（0 个 `<svg>`），并已冻结 8 项 `manifest`（`4587c780`，`sourceComplete: true`）。

| 对照维度 / 任务 ID | 执行方式与上限策略 | 耗时 | 请求数 | Tokens（输入 / 缓存 / 输出［推理］） | 估算费用 | 评分（PC / M） | 质量态 / 完整度 | 实测现象与结论 |
| :--- | :--- | ---: | ---: | :--- | ---: | :---: | :---: | :--- |
| **历史全站基线（11-11 / 11-14 v0.7 中位）** | 旧自由探索 Agent / 分片批 + Shell | **22.6–40.9m** | **232–296** | — | **¥1.01–¥1.72** | 易受未验剔除分母虚高 | — | 评测耗时为生成的 **1.9x–2.0x**，频繁超时中断 |
| **本站点生成（`7afb0300`）** | Kooboo AI Chat 生成（含 15 req 清单规划） | 513.2s (8m33s) | 生成 45 + 规划 15 | gen: in 3,168,519 (cached 3,089,792) / out 47,006 | **¥0.3285**（+清单 ¥0.0888） | — | `executed` | 交付 `/`、`/projects`、`/about` 三页，页面文案残留少量"占位/演示"声明及"书山"配图错配 |
| **Phase 2.0 首次试测（`d63d583f`）** | `maxOutputTokens: 16384`，无单批重试与断点缓存 | 499.9s（中断） | 9（含 2 笔 `missing`） | in 166,186 (cached 133,760) / out 87,244 | ¥0.3841（中断作废） | — | `interrupted` | Stage 1 零缺口采集 36 PNG + 8 份后台索引；但 6–10 图批次思考吃满 `16384/16384` 输出额度（0 JSON）触发 Codex CLI `code 1`，`Promise.all` 连带中止兄弟批 |
| **Phase 2.1 修复实测（`dc70a363`）** | **`maxOutputTokens: 32768`** + 紧凑思考约束 + 单批崩溃新会话重试 + 断点缓存（5 视觉批并行 + 1 业务批） | **389.3s** (6m29s)<br>（较历史降 **71%–84%**） | **9**（**-96.1% ~ -97.0%**） | in 217,259 (cached 166,528) / out 75,003 (reason **59,616**) | **¥0.3541**（**-64.9% ~ -79.4%**） | **`90 / 78`**<br>（Mobile 80.1 封顶压至 78） | **`failed` / `needs-fixes`**；清单 `6 verified / 2 unverified` | **一次零跟进、零 `code 1` 崩溃完结**（单批最高输出 15,917 ≤ 32,768）；精确检出 **1 Major**（首页移动端公开残留"实景摄影占位"等演示声明）、**1 Minor `[R-VISUAL-02]`**（精选页「书山」图文不符及跨页配图不一致）及 **12 Minor**（示例邮箱、英文日期占位、三页 SEO title 未区分等）；全简体中文，`outOfScope` 仅 5 条零重复 |

**Phase 2.1 真机收口补充观察（供后续微调参考）**：
1. **`32768` 输出窗口 + 紧凑思考提示直接消除 `code 1` 中断**：`dc70a363` 中 9 次请求均在 `2.7s–111.0s` 内正常结束（`missing: 0`，单次最高 `output_tokens = 15,917`，接近但恰好越过旧 `16,384` 危险区），未触发一次单批崩溃重试。
2. **移动菜单正常通过时仍有一处可优化小瑕疵**：`/` 移动端预检证实 `mobileMenu.closeWorked === true`（且业务/完整度批凭预检结果将 `shared-navigation-mobile-close` 判为 `verified`），但因为无缺陷时不附带菜单展开态 PNG，两个移动视觉批（`/` 与 `/about`）诚实把“菜单展开后关闭按钮无截图”记入 `unverified`；后续若希望全无瑕疵的 3 页站可直接拿下 `passed`，可在 `visual_precheck` 为首页无条件留存 1 张菜单展开探针图（多 1 张图即可消除该条 `unverified`）。
3. **8 项交付清单真实识别 6 `verified` + 2 `unverified`**：静态表单阻止提交行为、纯前端无独立 CSS 代码文件时的响应式断点规则未因有截图而越权判过，严格遵循 *Verification Engineering*“只依证据裁决”原则。

3. **Phase 1：单页主场景切入 + `delivery.ts` 止血 + 场景入口收敛（2026-11-21 已实施；1.1/1.2 已真机闭环）**
   - 业务场景**保留三大活跃场景：`materials`（资料建站）、`upgrade`（旧站升级）、`migration`（站点迁移）**；已将上述活跃场景的单页（`homepage`）评测通过 [`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 接入三段式有界 Checker（保留原有报告结构、版本快照与 Admin 接口兼容）。
   - 已完成 [`delivery.ts`](../server/automation/delivery.ts) 宿主预采集 + `read-only` 单轮（含最多 1 次格式修正）核验 + `RequestBudgetPolicy` 上限与 `sourceSummary` 证据隔离、[`evaluator.ts`](../server/automation/evaluator.ts) 非模板 prompt 修复，以及 `imagePlaceholder` 指引文案解绑（适用于三大活跃场景，不再限制“仅 AI Site 模板可用”）；`gpt-6.1-sol` 尚缺官方公开单价，暂保留人工/运维后续按真实单价配置，不在代码中臆造定价。
   - **已安全下线 `site-template`（AI Site 模板）与 `app-template`（AI App 模板）**：从新建资源、批量资料导入、Dashboard 默认筛选、规则默认勾选与提示词配置入口下线，**完整保留历史数据库记录、旧任务详情、历史模板检查集与报告解析只读兼容**。
4. **Phase 2：多页/全站范围（`materials/site`、`upgrade/site`、`migration/site`）有界化推广（2026-11-22 已实施并完成 3 页真实站点验收）**
   - 新增 [`server/automation/bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts) 并接入 [`server/automation/evaluator.ts`](../server/automation/evaluator.ts)（`boundedSite`，Phase 2.1 终版预算策略 `maxRequests: 20, maxTokens: 8_000_000, maxOutputTokens: 32768, maxConcurrent: 2`；支持单批异常开新会话重试 1 次及 `bounded-batch-cache.json` 断点续跑缓存）：
     - **精准准入守卫（`canUseBoundedSiteEvaluation`）**：聚焦活跃场景（`materials` / `upgrade` / `migration`）`scope === 'site'` 且未绑定旧 `templateWorkflow` / `collection` (`program`) / `migration.baseline`；若有冻结清单则要求 `sourceComplete === true`、无 `workflow`、仅含声明了 `records` 契约的 `page` 域 `data`，且路径数 ≤ 12；无清单站点按「首页 DOM 内链 + Kooboo `Page/All` 静态路由」自动发现最多 6 页（`MAX_BOUNDED_SITE_DISCOVERED_PAGES = 6`），超出页码诚实写入 `coverage.unverified`，绝不静默截断。
     - **三段式全站执行**：Stage 1 宿主完成首页（≤12 屏）与内页（≤8 屏）逐屏取证 + 预检（内页关闭重复移动菜单开关探针，`skipMobileMenuProbe: path !== '/'`）+ 只读后台索引 + `templateRecordFacts` 数据全量对账；Stage 2 通过 `runWithConcurrency(..., 2)` 并行评审切块视觉批（每批 ≤ 10 图，`planSiteVisualBatches`）及可选 `business/completeness` 结构批；Stage 3 `aggregateMultiBatchAssessments`（任一批次失败则取最小值防止均分稀释内页硬伤）、`applyBoundedVerdictCaps`、严格 `validateCompleteness` 与 `R-COVER-04` 门禁。
5. **Phase 3：`CHECKS.md` 一错一规产品闭环**
   - 支持从人工复核界面将“错判/漏判”案例一键沉淀为版本化规则条目，并自动回归测试。

---

## 六、已确认决策与下一步行动

### 已全部确认决策（2026-11-21）
- **Q1（`R-VISUAL-01` 边界）**：已确认。非豁免场景下使用大块 `<svg>` 一律按 Major 拦截（推荐 Kooboo 无图时使用 `imagePlaceholder` 真实配图）；豁免仅限“工具型 SaaS 界面示意、技术架构页、数据图表、品牌 Logo 与小尺寸 UI 图标”。
- **Q2（样本基线现状）**：已确认。本地站点与任务列表已清空，Phase 0A 先以磁盘留存的 4 组历史 PNG 做离线 A/B 实测（`edc98e9c` 与 `55f1d6eb` 已实测通过），后续补新站做 Phase 0B。
- **Q3（切入范围与场景收敛）**：已确认。从单页 + `delivery.ts` 切入；**保留 `materials`（资料建站）、`upgrade`（旧站升级）、`migration`（站点迁移）三大场景**，仅下线 `site-template`（AI Site 模板）和 `app-template`（AI App 模板）的自动化入口（保留历史只读）。
- **Q4（核心验收指标权重）**：已确认。**效率与效果是 P0 核心指标**，费用作为跟随指标不强求硬性占比限制。

### 下一步可执行工作（Phase 1 & Phase 2 主链路均已真机验证通过）
- **可选增量打磨**：
  1. 若后续希望全合格的多页静态站直接输出 `passed`，可让 `visual_precheck` 为首页额外留存 1 张移动端菜单展开态探针图（消除视觉批对“展开关闭按钮无截图”的 `unverified` 提示）；并在后续按需补 1 组带参考源站的 `upgrade/site` 与跨环境 `delivery` 真机 A/B 对比，验证 `anchorCheck` 与 `delivery` 实际降本表现。
- **运维待补（按需）**：取得 `gpt-6.1-sol` 官方公开单价后补充至计费单价配置。
- **Phase 3**：建设人工复核界面一键沉淀 `CHECKS.md` 一错一规闭环与自动回归测试集。

---

## 七、探索与决策记录（Changelog）

- **2026-11-22（Stage 2 优化规划有界化 & `upgrade`「模板+原站+资料」全流程真机一次达标）**：
  - **Stage 2 工程重构（解决 OVO 复盘暴露的 3 项瓶颈）**：
    - **单轮只读多模态优化规划（替换 20+ req 自由读库循环）**：新增 [`server/automation/bounded-optimization-planner.ts`](../server/automation/bounded-optimization-planner.ts) 并接入 [`server/automation/followup.ts`](../server/automation/followup.ts)，同时重构 [`server/automation/bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 的 `runBoundedBatchWithRecovery` 支持复用恢复与可选 `onThreadStarted`。针对无阻塞工具诊断需求的 `materials / upgrade / migration` 自动优化（`planning` 阶段），宿主预先汇总任务/报告上下文、注入已校验实图（上限 `12` 张 / `16 MiB`）与 `get_task / get_report` 观测证据 ID，直接以 `sandboxMode: 'read-only'` + `networkAccessEnabled: false` + `maxOutputTokens: 32768` 运行单步结构化决策（含 `1/1` 本地格式修补）并由宿主硬强制 Round 0 基线 `improved: false` 及 `validateAction`。
    - **清零静态截图细粒度交互 `unverified` 噪声**：扩展 [`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts) 的 `homepage` `defaultOutOfScope` 及 `matchesPresetScopeBoilerplate`（在 `REAL_CAPTURE_GAP_GUARD` 保护下，不吞噬真实菜单/截图缺口），将单纯基于静态逐屏截图不可见的 hover、折叠手风琴/标签页点击动效及路由跳转目标统一归入 `outOfScope`。
    - **防止无 Major 轻微精修退化及内部制作口径泄漏**：更新 [`shared/automation.ts`](../shared/automation.ts) 与 [`harness/optimization/SKILL.md`](../harness/optimization/SKILL.md)（在 [`server/automation/harness.ts`](../server/automation/harness.ts) 保留 `LEGACY_OPT_SOP_V3` / `LEGACY_OPT_POLICY_SOP_V3` 自动升级映射），严禁在公开页面/页脚写入内部制作口径文字，并在 `0 Major` 且小差值精修时强制锁定已达标高分区段（防类似 OVO 第 2 轮改版导致的轻微退化）。
  - **Stage 2 验证与构建**：在 [`tests-node/bounded-checker-rules.test.ts`](../tests-node/bounded-checker-rules.test.ts) 与 [`tests-node/automation-optimization.test.ts`](../tests-node/automation-optimization.test.ts) 补全单测；`npm run check` 退出码 `0`；7 份核心回归集（`harness-and-diagnostics`、`automation-optimization`、`followup`、`bounded-checker-rules`、`bounded-evaluator`、`bounded-site-evaluator`、`automation`）**`97 passed, 0 failed, 1 # SKIP`**（门控实 Codex 沙盒用例）；`npm run build` 退出码 `0`。
  - **Stage 3 真机实测：`upgrade`「Kooboo 模板参考站 + 旧原站 + 补充资料」（一次闭环达标）**：
    - 创建资源 `134875a2-e548-4864-8c1d-d24aebf58307`（`实测 · 模板+原站+资料升级 · 云隅咖啡焕新`）：绑定 Kooboo 模板市场 `Shiome`（`direct-template`，`17b746fb-89e6-4836-acc0-27bb4d09befd`）+ 旧原站 `https://auto_f9579f55_e3b.localkooboo.com/`（只读源站 Sandbox `src-38e4286b9063b5da9d7703894861c5a5`）+ 补充资料 `yunyu-coffee-update.md`，在`本机 Kooboo · 仅首页 · targetScore=85 · maxRounds=1` 下发起 `8900fb2c-b80d-46e9-83eb-6843d69fc95e`（生成站 `https://auto_8900fb2c_b80.localkooboo.com/`）。
    - **首次生成**（`8900fb2c`）：`68 req` / `in 4,844,681 (cached 4,765,568) / out 45,909` / `¥0.3581`。
    - **Round 0 基线有界评测**（`f77959db-b30b-4847-bc8c-7f0e6b1560e7`）：`3 req` / `in 72,263 (cached 43,776) / out 30,958` / `¥0.1532`；**PC `78`**（Hero 86 / 结构 83 / 区段 70）· **Mobile `84.2`**（Hero 84 / 结构 85.5 / 区段 82），`quality: failed`（精准揪出到访区主图带第三方 `VERMILION` 招牌与 `28/A` 门牌 **1 Major** + 8 项 Minor；`captureGaps: []`、`unverified: []`、`outOfScope: 6 项`）。
    - **有界单步优化规划**（`followup` on `8900fb2c`）：首次真机跑通 [`bounded-optimization-planner.ts`](../server/automation/bounded-optimization-planner.ts)，对比 OVO 两轮工具循环共 `46 req / ¥0.4560`（均轮 `23 req / ¥0.2280`），直接降至 **`1 req` / `in 27,332 (cached 7,680) / out 4,407 (reasoning 3,169)` / `¥0.0374`**（**请求数降至 `1 req`、费用降约 `83.6%`**），附带 8 张核验证据精确指派修复与防退化/防内部文案约束。
    - **Round 1 定向修复**（`6fe4f41a-a69d-4dc0-99d2-4a83c2487811`，修订 `b316f976-cb54-4c41-a416-fac4ca25c8a6`）：`106 req` / `in 11,629,586 (cached 11,509,376) / out 54,447` / `¥0.5682`。
    - **Round 1 独立复评**（`081bede6-3264-4695-8311-d5d8e3ddfbcd`）：`3 req` / `in 72,244 (cached 43,776) / out 24,304` / `¥0.1266`；**PC `91.4`（Hero 93 / 结构 91 / 区段 89）· Mobile `90.4`（Hero 93 / 结构 89 / 区段 88）**，**`quality: passed`**（`0 Critical / 0 Major` / 5 Minor，`captureGaps: []`、`unverified: []`、`outOfScope: 6 项`）；`optimization.state = "completed"`（第 1 轮即双端达标）。全流程累计 **`181 req` / `in 16,646,106 (cached 16,370,176) / out 160,025` / `¥1.2434`**，实图核验确认第三方招牌已替换、新老内容融合完整且无内部制作口径文案残留。

- **2026-11-22（解锁 `materials` 自动优化并完成 OVO「规划 → 原站修补 → 有界复评」两轮闭环实测）**：
  - **机制修补**：
    - [`shared/automation.ts`](../shared/automation.ts) & [`server/automation/api.ts`](../server/automation/api.ts)：`supportsAutomaticOptimization` 放开 `'materials'`，允许已完成且可继续原会话的资料建站任务直接开启自动优化，并在 `POST /api/automation/tasks/:id/optimize` 时同步 `task.evaluationTaskId`。
    - [`server/automation/store.ts`](../server/automation/store.ts) & [`server/automation/api.ts`](../server/automation/api.ts)：`currentReportHeader` / `currentReport` / `GET /tasks/:id/summary` 在生成任务尚未开启优化且旧 `evaluationTaskId` 中断、同修订手动重评已发布有效报告到 `auto_site_state` 时自动切换识别最新同修订报告（`!task.optimization` 限定，不破坏修复期间指针清理契约）。
    - [`server/automation/optimization-evidence.ts`](../server/automation/optimization-evidence.ts)：无参考 URL 的 `materials` 优化仅校验双端 `target` PNG，有参考站时保留严格 `target + reference` 校验。
    - [`tests-node/automation-optimization.test.ts`](../tests-node/automation-optimization.test.ts)：新增完整回归用例；`npm run check`（0）、5 文件优化与有界评测核心回归（**`65 passed, 0 failed, 0 skipped`**）、`npm run build`（0）。
  - **OVO 站点 `auto_cc5228d1_a78` 真实两轮自动优化闭环实测**（目标 `targetScore = 85`、最多 `2` 轮，复用原站原会话）：
    - **Round 0 基线**（`6f0ac020`）：**PC `84.4` · Mobile `69.8`**，`failed`（3 项 Major + 6 项 Minor），移动端 22,968px 产品卡片正文单字竖排塌缩。
    - **Round 1 修补 `e361fea2`（`399.4s` / `73 req` / `¥0.3001`）→ 复评 `94209d22`（`294.2s` / `5 req` / `in 125,156 (cached 72,192) / out 40,718` / `¥0.2173`）**：
      - 全量采集 74 PNG，**`captureGaps: []`、`signals: []`**（移动端大标题孤字与 `R-LAYOUT-03` 均已清零，移动端文档高度由 `22,968px` 收敛至 `17,797px`）。
      - **PC 升至 `86.5`（+2.1 达标）· Mobile 跃升至 `84.8`（+15.0，仅差 0.2 分）**，全部 **3 项 Major 清零**（剩余 15 项 Minor；FAQ 展开态 1 项未验证导致 `unverified`）。
    - **Round 2 修补 `a59b8766`（`895.3s` / `105 req` / `¥0.6588`）→ 复评 `0c845714`（`388.9s` / `5 req` / `in 125,197 (cached 72,192) / out 55,975` / `¥0.2783`）**：
      - 全量采集 74 PNG，**`captureGaps: []`、`signals: []`**（移动高 17,640px）。
      - **PC `82.2` · Mobile `83.6`**（达到 `maxRounds = 2` 按规则停止）；继续保持 **`0 Critical / 0 Major`**，但第 2 轮改版在页脚暴露“《公司介绍与公司理念》资料整理”等制作口径文字、首屏指标“占地 80000 ㎡ / 厂房约 8 万 ㎡”重复且行业卡 3+2 宽度不一，被 Checker 如实扣回 14 项 Minor，证明独立验收严格不放水。
    - 两轮独立规划 `followup` 共 `46 req` / `in 3,659,817 (cached 3,509,504) / out 58,877` / `¥0.4560`；全站历次累计估算成本 `¥2.8121`。

- **2026-11-22（参考站模板 + 超长页面资料建站实测闭环：OVO 阀门 + `Vantage Precision`）**：
  - **真实资料 + 模板建站（`cc5228d1-a786-436a-83bd-47cbfb3d57de`）**：创建资源 `57cf1c54-7551-4a1c-9e4a-9d457861ac15`（`materials`，绑定 Kooboo 模板市场 `Vantage Precision` `34c7c4bf-77e1-4758-9a25-38aa50ca363d` `direct-template`，上传 `公司介绍与公司理念.md` 与 57 张企业实景/设备/产品照片共 58 份资料）；成功构建站点 `https://auto_cc5228d1_a78.localkooboo.com/`，耗时 **`290.6s`** / **`79 req`** / `in 6,754,384 (cached 6,649,856) / out 47,729 (reasoning 21,910)` / **`¥0.4284`**，首页渲染 22 张实图零破图、零 `templateResiduals`、零几何 SVG 占位。
  - **参考站模式与超长页实测修复（经首次自动评测 `1caa5778` 与早先 `.docx` 同步失败 `912111a5` 定位并修复）**：
    1. Kooboo 路由 `+` 字符转空格导致文件校验误报：[`materials.ts`](../server/automation/materials.ts) 与 [`kooboo-materials.ts`](../server/automation/kooboo-materials.ts) 新增 `koobooSafeFilename`（将 `+` 与 `\` 一并规范化，保留逻辑文件名映射）；[`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 保留 `.docx` 纯文本兜底解析与有限动画参考图保留逻辑（`isReferenceCaptureUnusable`、`sampleReferenceImages`、`settleTimeoutMs: 10000`）。
    2. 参考站模式证据契约与全量聚合校验：[`bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts) 在真正附带 `role=reference` 时分组展示 `target / reference` 截图并明示“每条已评分 `assessments[].evidence` 必须同时引用同视口 `target` 与 `reference`”（纯文本业务批不误触发）；[`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 与 [`bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts) 改为全量聚合报错 + `formatRepairEvidenceGuide` 分组修复指引。
    3. 超长页面续采与多段切片：[`bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 新增 `captureFullPageScreenshots`（基于 `startY/nextStartY` 续采至 40 屏并校验总纵向区间）与 `planHomepageBatches`（超长视口拆为每批 `<= 12` 张实图的多片、按纵向窗口配对参考图、非首片免评 `hero`、使用共享 `aggregateMultiBatchAssessments(..., 'viewport')` 严格保留最差片段不通过结果，并启用 `bounded-batch-cache.json` 与全覆无缺口时的 `filterCrossSliceCoverageLeaks` 过滤）；[`bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts) 同步接入 `captureFullPageScreenshots`（`/` `40/16`，内页 `16/8`）及修复单页溢出切分保证每批均成对附带 `target + reference`。
    4. 预算与按次重试 `runKey`：[`evaluator.ts`](../server/automation/evaluator.ts) 采用 `${task.id}:${task.followup?.attempts || 0}` 作为 `runKey`（账户总额度仍封顶），`boundedHomepage` 放宽至 `maxRequests: 16 / maxTokens: 6_000_000`，`boundedSite` 放宽至 `maxRequests: 24 / maxTokens: 10_000_000`。
  - **本地验证与构建**：`npm run check` 退出码 `0`；10 文件核心回归套件（含 [`bounded-checker-rules.test.ts`](../tests-node/bounded-checker-rules.test.ts)、[`bounded-evaluator.test.ts`](../tests-node/bounded-evaluator.test.ts) 新增聚合修复与 22,000px 续采分段测试）**`79 passed, 0 failed, 0 skipped`**；`npm run build` 退出码 `0`。
  - **参考站模式真机复评一次通过（`6f0ac020-cd70-4f68-ba9c-76440b3e90a3`）**：重启服务后在 `auto_cc5228d1_a78` 发起全新仅首页评测，**零报错、零修正、零 AI 跟进一次跑通**：
    - Stage 1 续采耗时 `77.1s`，共采集 **`81` 张 PNG**（`target:desktop 14` [11,791px]、`reference:desktop 13` [10,759px]、`target:mobile 32` [22,968px]、`reference:mobile 22` [15,483px]），**`captureGaps: []`、`captureNotes: []`**。
    - Stage 2 并行 6 批（2 desktop + 4 mobile，56 张实图，每批 `<= 12` 图），总耗时 **`228.9s`**（并行评分阶段 `151.6s`）、**`6 req`**、`in 147,585 (cached 87,552) / out 41,173 (reasoning 33,696)`、**`¥0.2265`**。
    - 评分与真实缺陷检出：**PC `84.4`**（Hero 90 / 结构 80 / 区段 82）、**Mobile `69.8`**（Hero 82 / 结构 62 / 区段 61）、`quality: failed` · `needs-fixes`；精准捕获真实移动端产品卡片正文塌缩成单字竖排且“工程询盘”链接叠压正文（`[R-LAYOUT-03]` Major，实图 `ef7f6a1f-02d0-4d67-aa5d-2be26e486c0e.png` 复核确认）、产品卡首层缺型号口径突出（Major）、桌面端 H2 “五大行业，同一套制造与检验标准”末行孤字断行（Minor，与 DOM 预检一致）、制造基地“蝶阀车间”图片夹带英文 `"Butterfly Valve Workshop"`（`[R-VISUAL-02]` Minor）及五卡三列末行空白格等 9 项真实问题；`coverage.unverified`（6 项）均为诚实的静态截图交互/隐含链路边界，无跨段泄漏或采集截断污染。

- **2026-11-22（Phase 2.1 修复与 3 页真实站点 `auto_7afb0300_537` 全站真机验收通过）**：
  - **问题定位（首次全站实测 `d63d583f`）**：在真实生成的 3 页静态站 `auto_7afb0300_537`（`materials/site`，36 张 PNG + 8 份 `implementation-*.json`）首次试跑 Phase 2 时，Stage 1 零缺口完成取证并准确进入并行 Stage 2，但 6–10 图视觉批上 `deepseek-flash-1017` 内部思考耗尽原 `16,384` `max_output_tokens` 上限（0 JSON 输出），触发 Codex CLI `code 1: Reading prompt from stdin...`；单批抛错在 `runWithConcurrency` 中连带中止并行兄弟批，且未保存已完成批次结果。
  - **Phase 2.1 弹性修复落地**：
    - [`server/automation/evaluator.ts`](../server/automation/evaluator.ts)：将 `boundedHomepage` / `boundedSite` 的 `maxOutputTokens` 提升至 **`32768`**，`boundedSite.maxRequests` 放宽至 `20`。
    - [`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts)：在 `buildBoundedCheckerPrompt` 中新增紧凑思考约束，抑制逐张像素铺陈导致的推理 token 膨胀。
    - [`server/automation/bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) & [`server/automation/bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts)：抽取共享 `runBoundedBatchWithRecovery`（单批非预算类运行时崩溃或空输出时开全新 `codex.startThread` + 追加 `COMPACT_RETRY_REMINDER` 重试 1 次，不影响并发兄弟批，并保护 `task.threadId` 首次写入不被并发覆盖）；在 `bounded-site-evaluator.ts` 落地 `bounded-batch-cache.json` 断点续跑缓存（经 `parseAndValidate`/`parseAndValidateBusiness` 严格复验）及同任务同修订已验证 `implementation-*.json` 复用。
  - **本地测试与构建**：扩展 [`tests-node/bounded-checker-rules.test.ts`](../tests-node/bounded-checker-rules.test.ts)、[`tests-node/bounded-evaluator.test.ts`](../tests-node/bounded-evaluator.test.ts) 与 [`tests-node/bounded-site-evaluator.test.ts`](../tests-node/bounded-site-evaluator.test.ts)（覆盖 `code 1` 新会话重试不拖垮兄弟批、回环代理实传 `max_output_tokens === 32768`、以及 `bounded-batch-cache.json` 0 模型调用复用与篡改条目自动剔除重跑）。`npm run check` 退出码 `0`；10 文件核心回归集 **`72 passed, 0 failed, 0 skipped`**；`npm run build` 退出码 `0`。
  - **真实多页全站验收 `dc70a363`（已重启构建后 `npm start` 实测）**：复用已有 3 页站 `auto_7afb0300_537` 发起全新独立评测 `dc70a363-e4a2-40d0-bcf6-ba1b5107c54d`，一次无中断、零跟进跑通（**`389.3s` / `9 req` / `in 217,259 (cached 166,528) / out 75,003` / `¥0.3541` / `PC 90 · Mobile 78` / `failed` · `needs-fixes`**，完整度 `6/8 verified`，检出 1 Major + 13 Minor 含 `[R-VISUAL-02]`）。较历史 `site-template/site` 基线（`232–296 req / 22.6–40.9m / ¥1.01–¥1.72`），请求数降低 **96%+**、耗时缩短 **3.5x–6.3x**、费用降低 **65%–79%**。

- **2026-11-22（Phase 1.2 真机验证 & Phase 2 多页全站有界化完成构建与测试）**：
  - **Phase 1.2 实现与真机复测 `72689a9a`**：
    - 在 [`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts) 与 [`server/automation/bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts) 落地并行视口互相隔离约束（`siblingViewports`）、`filterCrossBatchOutOfScopeLeaks`、`filterContradictoryHighlights`、`areCrossViewportMinorDuplicates`（2-gram Dice + 共享 ASCII token + 同题共享词块）、`deduplicateBatchTexts` 与 `pickStrictestHeadline`。
    - 在 `auto_f9579f55_e3b` 上完成真机实测 `72689a9a`（**`101.8s` / `2 req` / `in 44,496 (cached 27,648) / out 19,595` / `¥0.0958` / `PC 92.6` · `Mobile 74.4` / `failed` · `needs-fixes`**）：单视口 `outOfScope` 泄漏彻底消除（6 条零多余），PC/移动固定导航半透明问题合并为 1 条 `issues[0]`，总 `issues` 收敛至 4 条；并在 `precheck-facts.json` 实际采集到 `internalLinks` 与 `seoMeta`。
    - 针对 `72689a9a` 新暴露的两个边界补入确定性修正：扩展 `filterContradictoryHighlights` 拦截 `"未发现严重或主要缺陷"`、在 `defaultOutOfScope`（`homepage && !hasBackendAccess`）与 `classifyUnverifiedLeaks` 纳管静态展示表单提交 disclaimers，并在 [`server/automation/visual-precheck.ts`](../server/automation/visual-precheck.ts) 新增无闭包 `__name` 的页内 `#anchor` 目标检测 `anchorCheck`。
  - **Phase 2 多页全站有界评测落地**：
    - 扩展 [`server/automation/visual-precheck.ts`](../server/automation/visual-precheck.ts)（`discoverBoundedSitePaths`、`seoMeta`、`internalLinks`）与 [`server/automation/browser.ts`](../server/automation/browser.ts)（`skipMobileMenuProbe`），新增 [`server/automation/bounded-site-evaluator.ts`](../server/automation/bounded-site-evaluator.ts) 并接入 [`server/automation/evaluator.ts`](../server/automation/evaluator.ts)（`boundedBudgetPolicy`: `maxRequests: 16, maxTokens: 8_000_000, maxOutputTokens: 16384, maxConcurrent: 2`）。
    - 新增 [`tests-node/bounded-site-evaluator.test.ts`](../tests-node/bounded-site-evaluator.test.ts)，全面覆盖 `canUseBoundedSiteEvaluation` 路由门禁、`planSiteVisualBatches` 视口分页、无清单自动发现 6 页限制与溢出页码保留 `unverified`、内页 Major 不被均分稀释（取 `Math.min`）、以及带清单 `upgrade/site` 对接 `templateRecordFacts`、`validateCompleteness` 与 `R-COVER-04`。
  - **最终本地验证与构建**：`npm run check` 退出码 `0`；10 份核心回归文件（含 `bounded-checker-rules`、`visual-precheck`、`bounded-evaluator`、`bounded-site-evaluator`、`request-budget-output`、`usage-proxy-terminal`、`budget-recovery`、`template-evaluation`、`task-supplement`、`automation`）**`69 passed, 0 failed, 0 skipped`**；`npm run build` 退出码 `0`；已启动新版 `npm start` 服务监听 `http://127.0.0.1:4180`。

- **2026-11-22（Phase 1.1 真机同站复测通过 & 并发预算修复）**：
  - 首次重启实测 `72736935`（日志：`有界多模态评测已启动（2 批并行 / 18 张实图；程序预检命中 1 项信号）`）验证了 `captureGaps: []` 与 `MOBILE_MENU_TRAPPED`（截图 `ee2014d3-2778-421f-a8e3-9cd6c7dac4d6.png`）已生效，但在批并行启动 1 秒内暴露 [`server/automation/request-budget.ts`](../server/automation/request-budget.ts) 单飞并发锁冲突（`同一预算仍有模型请求执行中`）。随即将该等待中任务取消（`status: "cancelled"`），并落地并发预算修复：
    - [`server/automation/request-budget.ts`](../server/automation/request-budget.ts)：为 `RequestBudgetPolicy` 新增可选 `maxConcurrent?: number`（默认仍为严格单飞 `1`，构造器校验正安全整数），并发预约在同一 SQLite 事务内共用剩余 token 与 `maxRequests` 额度及 `retainAccountReservations` 恢复机制。
    - [`server/automation/evaluator.ts`](../server/automation/evaluator.ts)：仅为 `boundedBudgetPolicy` 启用 `maxConcurrent: 2`。
    - [`tests-node/request-budget-output.test.ts`](../tests-node/request-budget-output.test.ts) & [`tests-node/usage-proxy-terminal.test.ts`](../tests-node/usage-proxy-terminal.test.ts)：新增默认单飞校验、`maxConcurrent: 2` 共享剩余上限、活跃预占恢复以及真实回环 HTTP 双路并发完成 + 第 3 路 `429` 拒绝端到端测试。
  - **修复后验证**：`npm run check`（0 错误）；8 份预算/代理/有界评测核心测试（放开回环 HTTP 监听）**82 通过、0 失败、0 跳过**；`npm run build`（退出码 `0`）。
  - **重启最新服务完成真机同站复测 `33a45716`**：在 `auto_f9579f55_e3b` 上一次性无报错、零补错、零跟进跑通（**`84.2s` / `2 req` / `in 44,125 (cached 28,672) / out 16,636` / `¥0.0826` / `PC 89.4` · `Mobile 72.6` / `failed` · `needs-fixes`**），确认 `precheck-facts.json` `captureGaps: []`、`report.coverage.unverified: []`、`MOBILE_MENU_TRAPPED` 实图取证 `f3033ba3-8824-4f8d-a4c1-d44c45e158c9.png` 准确判别 `R-LAYOUT-03` Major、预设 6 条 `outOfScope` 零重复。

- **2026-11-22（Phase 0B 同站 1:1 实测 & Phase 1.1 问题修复）**：
  - 完成 `Phase0B 实测-云隅精品咖啡馆`（`f9579f55`）真实浏览器全链路测试，取得同一站点旧版评测 `29d7a053`（50 req / 262.6s / ¥0.2740 / `93.6-84.2` `failed`）与 Phase 1 初版有界评测 `c9059ef6`（2 req / 227.7s / ¥0.1412 / `90.2-91.0` `unverified`）的 1:1 对照数据（请求数 **-96.0%**、输入 tokens **-98.8%**、费用 **-48.5%**）。
  - 针对实测暴露的 4 项问题落地 **Phase 1.1**：
    - [`server/automation/visual-precheck.ts`](../server/automation/visual-precheck.ts) & [`server/automation/browser.ts`](../server/automation/browser.ts)：新增移动端导航菜单展开/关闭确定性探针（无闭包 `__name` 污染的 `inspectMobileMenuStateInPage` + `probeMobileMenuInPage`），仅在缺少可见关闭入口或关闭失效时自动截留 `visual_precheck` PNG 并触发 `MOBILE_MENU_TRAPPED`（`R-LAYOUT-03`）。
    - [`server/automation/bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts)：新增 `extractBlockingCaptureGaps` 分流（全覆且 `0 pendingImages / 0 brokenImages / fontsReady=true` 下的有限动画未静止提示不再污染 `unverified`）；target `settleTimeoutMs` 调为 `2000`；`collectBatchImages` 始终保留 `visual_precheck` 探针截图；多批次改用 `Promise.all` 并行执行，并增强跨批 `issues`/`highlights`/`topFixes` 去重。
    - [`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts)：`R-LAYOUT-03` 纳入移动菜单关闭缺失描述，新增 `normalizeScopeKey` 与预设 `outOfScope` 语义去重，Prompt 指示无需复写宿主预设条目。
  - **Phase 1.1 本地验证**：`npm run check` 退出码 `0`；`npm run build` 退出码 `0`；11 份核心测试文件（[`bounded-checker-rules.test.ts`](../tests-node/bounded-checker-rules.test.ts)、[`visual-precheck.test.ts`](../tests-node/visual-precheck.test.ts)、[`bounded-evaluator.test.ts`](../tests-node/bounded-evaluator.test.ts)、`browser-settle.test.ts`、`evaluation-evidence-binding.test.ts`、`evaluation-result-file.test.ts`、`auto-delivery.test.ts`、`generation-delivery.test.ts`、`site-delivery.test.ts`、`automation.test.ts`、`template-evaluation.test.ts`）共 **136 通过、0 失败、1 `# SKIP`**（实 Chromium opt-in 用例）。尚未重启 `npm start` 做真机复测。

- **2026-11-21（Phase 1 主链路实施与模拟验证完成）**：
  - **主链路与跨环境交付落地**：
    - 新增 [`server/automation/bounded-evaluator.ts`](../server/automation/bounded-evaluator.ts)，接入 [`server/automation/evaluator.ts`](../server/automation/evaluator.ts) 处理活跃场景（`materials` / `upgrade` / `migration`）单页（`homepage`）评测：宿主先跑 `take_page_screenshots` + `visual_precheck`，`<= 10` 张实图走单轮 `read-only`（`networkAccessEnabled: false`）`local_image` 评审，`> 10` 张按 desktop / mobile 拆为 2 个顺序批次；绑定 `RequestBudgetPolicy`（`maxRequests: 6, maxTokens: 3_000_000, maxOutputTokens: 16384`）并执行 SHA-256 校验与 `applyBoundedVerdictCaps` 宿主硬封顶。
    - 同步在 [`server/automation/browser.ts`](../server/automation/browser.ts) 注册 `visual_precheck` 动作，优化 [`server/automation/bounded-checker-rules.ts`](../server/automation/bounded-checker-rules.ts)（增加严格简体中文输出约束、去重英文 `outOfScope` 模板套话、`R-VISUAL-01` 70/75 与通用 Major 72/78 封顶）。
    - 重构 [`server/automation/delivery.ts`](../server/automation/delivery.ts) 与 [`harness/delivery/SKILL.md`](../harness/delivery/SKILL.md)：由宿主预先采集目标站与源站双端截图并经 `local_image` 单轮只读核验（最多 1 次格式修正），接入 `RequestBudgetPolicy`（`maxRequests: 4, maxTokens: 1_500_000, maxOutputTokens: 16384`），并用精简 `sourceSummary` 替换 `task.json` 中的 `sourceReport` 隔离历史 evidence 文件名。
  - **场景入口收敛（历史只读兼容）**：
    - [`shared/automation.ts`](../shared/automation.ts) 新增 `activeScenarios`（`materials` / `upgrade` / `migration`），更新 [`harness/optimization/SKILL.md`](../harness/optimization/SKILL.md) 并于 [`server/automation/harness.ts`](../server/automation/harness.ts) 的 `LEGACY_DEFAULT_SOPS` 保留旧版 SOP 自动升级识别；更新 [`ResourcesView.vue`](../frontend/src/views/automation/ResourcesView.vue)、[`BatchMaterialImport.vue`](../frontend/src/views/automation/BatchMaterialImport.vue)、[`DashboardView.vue`](../frontend/src/views/automation/DashboardView.vue)、[`RulesView.vue`](../frontend/src/views/automation/RulesView.vue)、[`SettingsView.vue`](../frontend/src/views/automation/SettingsView.vue) 下线 `site-template` 与 `app-template` 新建与默认筛选入口（已有历史数据回显兼容）。
  - **验证实测结果（严格区分模拟单测与真机验收边界）**：
    - 类型检查 `npm run check`（`tsc --noEmit -p tsconfig.server.json && vue-tsc --noEmit -p tsconfig.web.json`）：退出码 `0`，前后端均 0 报错。
    - 生产构建 `npm run build`：退出码 `0`（Vite 前端构建 2,891 模块 + Node 服务端构建 + Build Info 写入）。
    - Phase 1 核心针对性测试集（10 个文件，含新增 [`tests-node/bounded-evaluator.test.ts`](../tests-node/bounded-evaluator.test.ts) 与扩展 [`tests-node/bounded-checker-rules.test.ts`](../tests-node/bounded-checker-rules.test.ts)）：**109 / 109 通过，0 失败，0 跳过**。
    - 全仓其余非挂起测试分段验证（全仓 100 个测试文件中 `tests-node/task-recovery-component.test.mjs` 存在与本次无关的上游 `<TaskExecution>` 渲染抛错导致定时器未释放、阻塞 `npm test` 退出的既有问题；其余 99 个非挂起文件共 **1044 项通过**［前 82 文件 `896` 过 + 后 17 文件 `148` 过］、**4 项预期 `# SKIP`**［需开启 `EVALUATOR_BROWSER_TEST` / `AUTOMATION_CODEX_TEST` 的真实浏览器/Codex 用例］、**3 项与 Phase 1 无关的上游既有失败**［`automation-todos.test.ts` 缺 `file.role`、`automation-ui.test.ts` 多出 `kind: 'evaluation'`、`live-comparison-component.test.mjs` `2 !== 1`］）。
    - *边界声明*：以上 `npm run check` / `npm run build` / Node 测试均使用 Mock 浏览器与 Mock Codex 响应；真实 Kooboo 站点、真实 Chromium 渲染采集与真实模型闭环仍待 Phase 0B 真机验收。

- **2026-11-21（Phase 0A `--live` 实测 & 场景最终定案）**：
  - 确认 **保留 `migration`（站点迁移）场景**，确立保留场景为 `materials` + `upgrade` + `migration`，仅下线 `site-template` 与 `app-template` 新建入口及默认筛选。
  - 完成 Phase 0A `--live` 真实多模态实测（`deepseek-flash`，单轮 8 张 `local_image`）：
    - `edc98e9c` 星禾空间：从 `37 req / 3.8m / ¥0.4290 / 92.6-94.4 (ready)` 变为 **`1 轮 / 60.6s / ¥0.0517 / 73.6-70.0 (failed / needs-fixes)`**，精准检出 2 个 `R-VISUAL-01` Major（Hero 抽象光锥与 3 张卡片渐变光斑）和 1 个 Minor（单字孤行），结果留档于 `.data/visual-experiments/phase0-edc98e9c-1795231449566.json`。
    - `55f1d6eb` 晨光烘焙：从 `65 req / 5.5m / ¥0.3168 / 94.8-94.4 (unverified)` 变为 **`1 轮 / 79.3s / ¥0.0547 / 92.2-90.8 (passed / ready)`**，成功打通合格站自动放行，结果留档于 `.data/visual-experiments/phase0-55f1d6eb-1795231559543.json`。
- **2026-11-21（边界确认 & Phase 0 模块落地）**：
  - 确认 4 项核心边界：SVG 一律拦截（含无图模式，推荐走 `imagePlaceholder`，明确 4 类豁免）、效率与效果优先于费用绝对占比、聚焦 `materials` + `upgrade` 并规划下线 `site-template` 与 `app-template` 入口、基于盘上留存的 4 组历史 PNG 划分 Phase 0A（离线实图验证）与 Phase 0B（新站全链路验收）。
  - 核实 Kooboo 侧 `AiSiteBuilder.cs:146-152` 的 `imagePlaceholder` 实现，确认其通过 `ImagePlaceholder.RedirectAsync` 输出真实图片 URL；确认 `.data/automation-runs/` 下 `edc98e9c`（23 PNG）、`729e055e`（46 PNG）、`1e3450f5`（59 PNG）、`55f1d6eb`（48 PNG）均完整保留在磁盘。
  - 新增 Phase 0 独立基础模块：`server/automation/bounded-checker-rules.ts`、`server/automation/visual-precheck.ts`、`scripts/phase0-bounded-checker-bench.ts` 及对应单元测试（本轮仅执行 `--dry-run` 与本地单测，未改动现有生产主链路）。
- **2026-11-20**：
  - 精读 `@distortgeekin` 文章 *Verification Engineering: How to Build AI Agents You Never Have to Check*，提炼 6 条方法论并映射到本项目（Maker = Kooboo AI Chat，Checker = Automation Lab）。
  - 只读统计 `.data/database.sqlite`（241 条任务、46,182 条账本记录）并审查相关源码，定位了三大核心根因：自由 Shell 探索导致的请求数与上下文成本居高不下、`delivery.ts` 证据混淆与缺预算护栏、算分缺硬性封顶与廉价 SVG 等视觉反模式导致分数虚高（以 `edc98e9c` 星禾空间 Hero 96 分为典型实锤），同时大量无关 `unverified` 导致近 7 天 0% `passed`。
  - 核实 `@openai/codex-sdk` 已原生支持 `local_image` 多模态数组输入与 `read-only` / 无网络沙盒模式（`probe.ts` 已在单图上使用），确立 **B 方向三段式有界验证管道**，并建立本文档作为跨会话长期演进基线。
