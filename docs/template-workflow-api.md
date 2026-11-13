# AI Site 新流程前后端接口

日期：2026-11-12。协议以 `shared/template-workflow.ts` 为准。此文件由 sol 维护，Gemini 负责前端。接口已接入源码；2026-11-12手动闭环后的后端修正已重新构建并加载到本机4180服务，健康检查通过，完整Auto Lab真模型新任务尚未验收。所有路由沿用本地会话认证及现有 `/api/automation` 前缀，不返回磁盘路径或凭证。实施与实测边界见 `template-workflow-implementation-2026-11-12.md`。

## 通用检查集

- `GET /api/automation/template-checklists` → `{ items: TemplateChecklist[] }`，按 revision 降序。内置首版仅提供初始规则，不代表检查已执行。
- `POST /api/automation/template-checklists`，body 为 `TemplateChecklistInput` → HTTP 201 `TemplateChecklist`。发布不可变新版本，不覆盖旧版本。新任务冻结创建时的当前版本；不自动重评旧任务。
- `name` 和每项 `title/instruction` 必填；ID 在集内唯一；至少一个启用项；必过项也可配置；数值容差和权重非负。`kind/executor` 枚举和字段见共享类型。模板双端检查不使用 business 视口。

## 单任务新流程

- `GET /api/automation/tasks/:id/template-workflow` → `TemplateWorkflowResponse`。
- 不存在的 task 返回 404。旧任务返回 `supported:false`，其余业务字段为空，不从旧报告转换。
- 新任务在分析前即有 `supported:true` 和冻结 checklist；分析完成后 baseline 非空；独立评测完成后 evaluation 非空。空值不是通过。
- 来源仍有缺口时 baseline 保持 null，limitations 留缺口，分析草稿与采集进度在后端续跑。此时不创建目标站。完成后才冻结完整基线。
- 查询指定 task 的评测；generation task 查询当前对应的评测结果，结果修订与当前站点不一致时返回 evaluation:null 及缺口说明，不展示历史分数为当前。
- `phase` 从实际执行状态投影。baseline 的 `complete`、evaluation 的 `complete/quality` 和 task 执行状态含义不同，不能用执行结束推断质量通过。
- `baseline.pages[].views[].layouts` 是本站要求，不是通用规则。constraints 引用 checkId；anchors 是参考选择器，禁止假定它也存在于目标 DOM。
- `evaluation.checks` 逐页面/view/视口/检查项留结果，`provenance` 区分实测、继承、未验证；证据保留 sourceTaskId/sourceRevision，不伪造新修订。
- `evaluation.issues` 的 done 由后端复验产生。前端没有直接标记 done 的写接口。
- `evaluation.captures` 显示本轮 page/regions/inherited 范围和原因。继承不代表本轮重新截图。
- `evaluation.scores` 为新检查集按 weight 加权的双端分数，与原业务/实现规则评分共同参与质量门槛；不要用它替换旧报告的评分含义。`baseline.experienceGuidance` 为本次采用的已验证经验版本及依据。
- `limitations` 必须如实展示在合适上下文，不因有图片或分数而忽略。

## 证据

`GET /api/automation/tasks/:id/template-workflow/artifacts/:file` 提供登记并校验哈希的证据。优先直接使用 `TemplateEvidence.href`，支持现有图片预览或下载。只有当前工作流有权引用的登记文件可读取；目录穿越、跨工作流证据、未知文件一律拒绝。

本轮没有前端直接触发参考重采/基线覆盖的写接口，也没有旧任务升级入口。来源补采由后端当前任务的受控分析工具按缺口执行；更换参考或要求属于新输入/基线修订，不允许前端覆写原冻结证据。

## 兼容与验证

v0.7.0 已接入检查集管理、冻结基线、逐项评测与证据查看界面。后端接口不可用时显示明确的未就绪状态，不猜造旧数据或假保存。接口及组件模拟测试不代表真实模型、浏览器视觉或 Windows 实机验收；发布检查见 `release-validation-0.7.0.md`。
