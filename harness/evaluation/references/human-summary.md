# 评测结果白话总结规范（Human Summary Spec）

评测报告除了严谨的技术明细（`summary`、`assessments`、`issues`、`coverage`、`completeness`）外，请同时填写可选字段 `humanSummary`，帮助非开发同事在 10 秒内看懂本次评测结果。

## 输出结构

```json
{
  "verdict": "ready | needs-fixes | blocked | incomplete-check",
  "headline": "一句话总结站点现状（例如：整体版式和核心内容已到位，但移动端导航折叠与产品列表图片仍需调整）",
  "highlights": [
    "做得好的地方 1（用页面/栏目语言描述，不贴文件名）",
    "做得好的地方 2"
  ],
  "topFixes": [
    "优先建议修改 1（具体到哪个页面/哪个区域、视觉或功能哪里不对）",
    "优先建议修改 2"
  ],
  "unverifiedNote": "如果存在本次未核验到的范围（如部分内页未覆盖、缺少后台登录态等），用 1～2 句白话说明；全部核验充分时可省略或留空。"
}
```

## verdict 判定参考

- `ready`：无 `critical` 缺陷、`major` 缺陷极少、核心视觉与业务均已过关，且未验证项不影响基本交付。
- `needs-fixes`：站点主体可用，但存在明显影响体验或美观的缺陷（`critical` / `major`），建议按 `topFixes` 修改后再验。
- `blocked`：首页空白、严重错版、关键流程完全无法走通或内容严重缺失，当前版本不可交付。
- `incomplete-check`：由于外部资源受限、源站对比证据缺失或技术阻断导致关键区域未能核验，需补齐条件后复评。

## 编写禁区

- 不要在 `headline`、`highlights`、`topFixes`、`unverifiedNote` 里出现 `evidence` 截图文件名（如 `target-desktop-xxx.png`）、任务 ID、规则指标英文 ID（如 `desktop-visual-layout`）或 JSON 字段名。
- `topFixes` 最多提炼最重要的 1～4 条，按“先严重缺陷、再高优先级体验问题”排序。
