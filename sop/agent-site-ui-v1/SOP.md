# Agent 首页 UI 还原度评测 · v1

状态：2026-11-05 已完成一个真实双站样例；尚未接入平台 Worker 或可配置流程构建器，评分尺度尚未校准。

本 SOP 交给可以查看图片并调用工具的 agent 执行。脚本负责固定操作，agent 负责证据审查、区域对应、异常决策和视觉评分。模型供应商可以更换；普通文本模型不能代替实际看图。

## 输入与输出

输入：生成站公开地址、参考站公开地址、首页范围、桌面 1440×900 与移动 390×844、允许的内容替换约定。v1 使用无登录态的独立 Chromium 上下文，DPR=1、en-US、Asia/Shanghai；不修改被评页面 DOM、CSS、内容或动画。

输出：截图原件、采集 manifest、agent 评测 JSON、经校验的 result.json、report.md、局限与失败原因。运行数据放在 `.data/agent-evaluations/<唯一轮次>/`，不加入 Git。每次新站点版本或要求重新采集时使用新的轮次目录；复用是对已有采集时点的复用，不证明当前线上未变化。

## 执行流程

| 步骤 | 指令 | 交付物/完成条件 |
|---|---|---|
| 1 准备 | 确认两站地址、首页范围、视口、内容替换政策、六项权重 | input.json；输入未明确时先确认，不凭空补站点 |
| 2 生成站采集 | 执行 capture；逐段滚动触发内容，动态更新页面高度，保存连续分段图 | target-desktop、target-mobile 检查点和带文件哈希、坐标、时间的 PNG |
| 3 参考站采集 | 使用相同视口与方法采集 | reference-desktop、reference-mobile 检查点和 PNG |
| 4 证据审查 | 执行 inspect、生成缩略图；agent 实际查看所有分段，关键差异查看原图；建立区域对应 | 每个 capture 的 usable、reason、evidence；缺口、限制、必要补采 |
| 5 比较评分 | 按对应模块比较两边截图，为六项打分、解释差异、引用证据 | assessment.json；每项至少引用两站真实的分段证据，移动项引用两站移动图 |
| 6 报告输出 | 执行 report；程序校验文件哈希、证据引用、覆盖与分项，计算固定权重总分 | result.json、report.md；失败保留原因和已有产物，不生成伪总分 |

不要把 capture 的 `status=captured` 或 `coverage.complete=true` 当成视觉审查通过。前者表示脚本完成，后者只表示当前像素高度和滚动范围到达页尾；`visualReview` 仍需要 agent 完成。

## 工具使用

项目根目录已安装 Playwright/Chromium 时：

```sh
node scripts/agent-eval.mjs capture --config sop/agent-site-ui-v1/example-input.json --out .data/agent-evaluations/唯一轮次
node scripts/agent-eval.mjs inspect --out .data/agent-evaluations/唯一轮次
python3 scripts/agent-eval-sheets.py .data/agent-evaluations/唯一轮次
node scripts/agent-eval.mjs report --out .data/agent-evaluations/唯一轮次 --assessment .data/agent-evaluations/唯一轮次/assessment.json
```

Python 缩略图/拼接辅助工具需要 Pillow；本次使用 Codex bundled Python。没有 Pillow 时可直接查看 PNG 原件，不能因此跳过看图。Node CLI 只依赖项目现有的 Playwright 和 Node 内置模块，不读取模型 API Key、平台 Vault、登录态或任务数据库。

`inspect --detail true` 可按需输出标题与少量页面坐标；默认只输出采集状态、覆盖、截图数量、警告与报告是否过期，避免把整页 DOM 和长日志送入上下文。完整辅助信息在 manifest 中。

局部恢复：

```sh
node scripts/agent-eval.mjs capture --config input.json --out 轮次目录 --only reference-mobile
node scripts/agent-eval.mjs capture --config input.json --out 轮次目录 --only reference-mobile --recapture reference-mobile
```

第一条复用通过文件校验的成功检查点，失败/未执行项才重新采集；全部可复用时不启动浏览器。第二条明确重采指定视口，保留旧 attempt；重采前把已有报告移入 history/reports，其他视口继续复用。新证据产生后重新审查并评分，不能沿用旧证据 ID。每视口总预算 240 秒、导航 60 秒、滚动至多 100 次、高度上限 30000px（可配置 900–40000px）；失败由 agent 决定有限补采或停止。

同一轮次不支持多个进程并发写入；批量任务每轮使用独立目录，站内采集顺序执行。当前工具是实验执行器，平台接入时再复用现有队列、租约和状态机制。

## 截图与动画

连续分段图是主要证据，约 10% 重叠；以记录的 pageY 和视口确认实际区域。整页 `full` 图仅作诊断，不能用于打分引用：滚回顶部后，Webflow 滚动揭示区域可能重新隐藏，真实内容会在整图中变成空白。

`agent-eval-sheets.py` 生成分段缩略表和 `*-stitched.png`，按原图的实际 pageY 进行像素拼接，验证来源哈希与连续覆盖，保留 `review/derived-manifest.json`。这是多个时点截图的派生组合图，不是一次浏览器整页截图；固定头部和动画状态可能重复。缩略图先用于定位，具体评分引用原分段图。不得通过强制 opacity、删除元素或关闭站点逻辑来制造“完整”的评测截图。

对应关系按模块语义和视觉位置建立，例如首屏、介绍、服务、数字、案例/品牌、FAQ、文章/项目、页脚。两页高度和模块不同，不能按相同 y 坐标自动认定为同一内容。

## 暂定评分规则

| 维度 | 权重 |
|---|---:|
| layout 页面结构与布局 | 30% |
| spacing 尺寸与间距 | 20% |
| typography 字体与文字层级 | 15% |
| decoration 颜色与装饰 | 10% |
| imagery 图片与图形 | 15% |
| mobile 移动端布局 | 10% |

每项 0–100；程序计算总分，不采用 agent 自报总分或改写权重。暂定锚点：90 附近为主要结构和细节均接近；80 附近为结构接近但有局部差异；60 附近为保留整体风格、多个重要模块明显重构；40 附近为只保留少量通用视觉特征。锚点需后续多样例校准，不能把精确分数视为客观测量。

不直接评价品牌、语言、文案或图片题材的语义差异；评价其造成的换行、比例、占位、构图等可见效果。没有原始任务资料时不判断任务完成度。不根据单纯页面长短或图像题材不同扣分。

无法读取正文不必阻止可靠截图比较；空白、错误页、验证页、明显未加载或严重遮挡需要补采/报告。缺少必需视口、覆盖未完成或图像不可用时不能输出完整总分，不记零分、不静默重新归一化权重。此时保存诊断和局部观察，等待恢复。

assessment.json 包含 summary、confidence(low/medium/high)、captureReviews、六项 dimensions、issues、limitations。每个 captureReview 提供 captureId、usable、reason、evidence。每个 dimension 提供 id、score、reason、evidence。每个 issue 提供 severity(critical/major/minor)、dimension、title、detail、evidence。截图 ID 从 manifest 原样读取，不能编造。可参考真实样例目录中的 assessment.json。

## 首次真实样例

2026-11-05，生成站 `https://manwei-sav-2.localkooboo.com/`，参考站 `https://beximco-consulting.webflow.io/`：

- 四个视口均采集成功，共 50 张连续分段图和 4 张整页诊断图，原图哈希校验通过。
- 生成站桌面高度 7250px、移动 11447px；参考站桌面从 8011px 增至 8288px、移动从 9937px 增至 10851px。动态高度检查在本例是必要的。
- 参考站整页诊断图存在大块动画隐藏区域，连续分段图可见；因此采用分段证据和可追溯拼接预览。
- 本会话 agent 实际看图评分：layout 58、spacing 62、typography 72、decoration 66、imagery 60、mobile 58，固定加权总分 62/100，置信度 medium。
- 已验证成功证据复用，无需再次启动浏览器。未调用平台配置模型、未提交到平台数据库、未验证自动调度或跨模型评分稳定性。

适合固定成程序：浏览器参数、动态滚动、连续截图、原件保存与校验、视口检查点、缩略图/拼接、输出 schema 检查、引用检查、权重计算和报告生成。继续交给 agent：内容是否加载完整、模块对应、补采决策、视觉差异与解释。
