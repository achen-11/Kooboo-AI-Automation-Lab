# Kooboo AI Automation Lab — Harness 运行蓝图

这里是 Automation Lab 的内置 **Agent Harness（运行规则与参考包）**，集中存放系统在建站、跟进、评测、完整度清单、持续优化、经验沉淀与跨环境交付核验阶段使用的真实执行规范与参考手册。

## 核心设计原则

1. **单一真相源（Single Source of Truth）**：服务端运行时直接读取本目录文件作为内置默认 SOP 与 `references/`，不再把流程提示词散落硬编码在 TypeScript 代码里。
2. **宿主守门 + Agent 决策（Host-Owned State）**：所有状态机、预算、交付去重（`deliveryId` / `runId`）、文件与截图哈希校验都由 Node 宿主掌控；AI 只能通过受限工具（`tools.mjs`、`browser.mjs`、`inspect.mjs`）读取事实并提交结构化动作。
3. **双层结果输出（用户层 + 技术排障详情）**：
   - **用户层（Human Notice / Human Summary）**：面向运营、设计和非开发同事，用简洁中文直接说明“发生了什么、卡在哪里、人需要做什么、当前网站是否能交付”。禁止出现内部 UUID、Unix 时间戳、英文字段名或内部接口路径。
   - **技术排障详情**：保留完整 `stage`、原始错误、evidenceId、接口返回和事件轨迹，默认折叠收纳，方便研发排障。

## 六阶段自动化流水线

| 阶段 | 执行主体 | 职责说明 | 对应目录 |
| --- | --- | --- | --- |
| 1. `prepare` & `generation` | Node 宿主 + Kooboo AI | 冻结输入版本、采集参考/源站证据、按场景准备目标站与 Sandbox、投递指令给 Kooboo AI 并追踪 SSE 会话 | [generation/SKILL.md](generation/SKILL.md) |
| 2. 完整度清单 `planning` | 本地 AI (`localDecision`) | 根据冻结资料与源站建立应交付清单（`RequirementManifest`），避免只按已生成页面缩水验收 | [completeness/SKILL.md](completeness/SKILL.md) |
| 3. `followup` 自主跟进 | 本地 Codex SDK Agent | 当生成或评测卡住、中断或需要人工介入时，查证现场状态，决策 `wait / retry / continue / answer / evaluate / collect / interrupt` | [followup/SKILL.md](followup/SKILL.md) |
| 4. `evaluation` 独立评测 | 本地 Codex SDK + 真实浏览器 | 使用真实 Chromium 双端（PC / Mobile）截图与后台只读检查，输出结构化报告与“一眼看懂”总结 | [evaluation/SKILL.md](evaluation/SKILL.md) |
| 5. `optimization` 持续优化 | 本地 Codex SDK（多模态识图） | 对照目标站与参考站真实截图及上轮问题，评估是否真实改善并委托 Kooboo 执行下一轮模板级修复 | [optimization/SKILL.md](optimization/SKILL.md) |
| 6. `delivery` 交付核验 | Node 宿主 + 本地 Codex SDK | 可选将达标站点迁移到正式运行环境，并做双端真实截图与关键路径核验 | [delivery/SKILL.md](delivery/SKILL.md) |

> 贯穿 `followup` / `evaluation` / `optimization` 的经验筛选与复盘规范见 [experience/SKILL.md](experience/SKILL.md)。

## 内置 Harness 与设置页自定义的关系

- 当用户尚未在设置页手动修改某条 SOP（或仍停留在历史版本的内置默认值）时，系统启动会自动同步到当前 `harness/` 中的最新版本。
- 如果用户已经在设置页保存过自定义修改，系统会完整保留用户的自定义内容，并在设置页提供“当前使用自定义规则 / 恢复为新版内置”的控制开关。
- 运行时动态注入的任务上下文、场景约束、冻结清单与已采纳经验仍由宿主在每次执行时按需拼接到临时工作区，保证隔离与安全。
