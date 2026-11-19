# 双层故障与中断输出规范（Human Output Spec）

当 `followup` 决定调用 `act` 且 `decision.action === "interrupt"` 时，除了原有的技术字段（`reason`、`evidence`、`nextSteps`）之外，请同时输出 `decision.userSummary` 对象，供前端默认向运营、设计或业务同事展示。

## JSON 结构

```json
{
  "headline": "一句话结论（不超过 35 个字）",
  "category": "source-access | target-auth | template-source | ai-model | environment | site-collision | need-human-input | runtime",
  "explanation": "2～4 句白话解释：发生了什么、目前卡在哪个动作、对当前网站有没有造成损坏。",
  "userActions": [
    "第 1 步具体要做什么（先去哪里检查、点哪个按钮）",
    "第 2 步完成后的操作（例如点击当前页面上的“从此处恢复”）"
  ]
}
```

## 编写铁律（User Summary Red Lines）

1. **只说人话**：假定阅读者不懂代码、不认识自动化平台内部状态机，能直接看懂并动手处理。
2. **禁止泄露技术噪音**（这些信息只能留在外层的 `reason` / `evidence` / `nextSteps` 中，**绝不要写进 `userSummary`**）：
   - 任何 UUID / SiteId / TaskId / ConversationId / RunId / EvidenceId（如 `2745d879-...`、`ev_...`、`conv_...`）
   - Unix 毫秒时间戳（如 `1795066937650`）或原始 ISO 时间字符串
   - 内部代码字段名或状态枚举（如 `transferTaskId`、`sourceSandbox`、`ask_user_input`、`deliveryState`、`following-up`、`Transfer/GetStatus`、`AISandbox/TransferByLevel`）
   - 冗长英文报错堆栈或原始 JSON 片段
3. **写清楚状态边界**：如果站点其实已经建好/部分生成了，明确告诉用户“当前生成的站点内容会保留，不需要从头重跑”，消除焦虑。
4. **动作必须可执行**：每条 `userActions` 都应对应界面上真实能找到的动作（例如：“在浏览器打开原网址确认能否正常访问”、“前往系统设置检查 Kooboo 环境登录状态”、“完成处理后点击本页的「恢复执行」继续”）。
