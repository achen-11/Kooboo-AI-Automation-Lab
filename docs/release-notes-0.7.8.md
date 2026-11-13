# Kooboo AI Automation Lab v0.7.8 发布说明

发布日期：2026-11-14。基于 `v0.7.7`（Windows Codex CLI 沙箱、首字节前断连重试、动效重采与运行时配额融合修复）继续提高 AI Site 模板参考分析与独立评测的累计 token 预算下限，并补强完整草稿恢复时的直接提交引导，解决高缓存提示词多轮会话或断点恢复后触发 `剩余预算不足以接收本次上下文` 的中断问题。

## 修复内容

1. **参考分析与独立评测累计 Token 预算下限调整**
   - `server/automation/template-workflow-evaluation.ts`：`scope === 'site'` 评测 `maxTokens` 下限从 `15,000,000` 提高至 `50,000,000`（`homepage` 从 `10,000,000` 提高至 `25,000,000`），与 `300`/`180` 次请求上限及多轮缓存输入计费规模匹配，同时保留 `vault.automation().completeness` 实时配置的 `Math.max` 取值逻辑。
   - `server/automation/template-analysis.ts`：`scope === 'site'` 参考分析 `maxTokens` 下限从 `15,000,000` 提高至 `50,000,000`（`homepage` 从 `10,000,000` 提高至 `25,000,000`）。

2. **草稿完成进度标记与恢复直达提交**
   - `server/automation/template-workflow-evaluation.ts`：向评测上下文注入 `draftProgress: { saved, expected, complete }`；当 `draftProgress.complete === true`（全部 `pagePath × view × viewport` 草稿均已落盘）时，SOP 明确禁止重复读取草稿或逐项重检视图，只需按需 `read(implementation)` 核对动态内容与实现约束后直接调用 `submit({ views: [], review })`。

## 兼容与升级说明

- 无数据库结构调整；已落盘的 `view-drafts:`、`target-state:` 与历史请求计量均完整保留。升级并重启后，已完成全部区块草稿的任务可直接基于剩余 `35M+` token 预算安全续跑提交。
