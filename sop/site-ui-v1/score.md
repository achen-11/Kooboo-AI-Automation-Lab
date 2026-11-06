# 模型评分规则

实际评分维度、权重、阈值、说明和提示词由平台的可编辑规则管理；执行时冻结版本。修改规则后新执行使用新版本，旧报告保留旧版本。

- 有完整视觉参考证据时，模型返回规则定义的全部维度，每项恰好一次，分数范围 0–100，并说明具体可见差异。
- 每个视觉分项必须同时引用真实生成站截图和参考站截图的证据 ID。不存在的 ID、缺失维度、重复维度和非法分数均拒绝保存。
- 程序按规则权重计算总分，模型不直接决定最终视觉总分。
- 没有视觉参考时，`dimensions` 必须为空，视觉分数为 `null`。
- 没有 README 或资料没有可验证要求时，资料符合度 `completionScore` 为 `null`；不能把正文辅助信息当作所有要求已完成的证明。
- 图片未加载、空白、错误页或验证页属于证据问题，应重试采集并保留诊断；不能凭 DOM 文本猜出 UI 分数。
- 只评价截图显示的静态视觉。仅首页采样不代表全站、交互、动画和业务流程已经验收。
- README 明确允许的品牌、文案与素材替换不直接算作视觉偏差。低证据覆盖或采集不稳定应降低置信度并写明局限。

模型结果必须是一个 JSON 对象：

```json
{
  "summary": "具体中文结论",
  "confidence": "high",
  "dimensions": [
    { "id": "structure", "score": 80, "reason": "具体可见依据", "evidence": ["target-desktop-top", "reference-desktop-top"] }
  ],
  "completionScore": null,
  "issues": [
    { "severity": "major", "dimension": "structure", "title": "具体问题", "detail": "位置与偏差", "evidence": ["target-desktop-top", "reference-desktop-top"] }
  ]
}
```

示例省略其他维度；实际有参考时必须返回规则定义的全部维度。JSON 验证失败保留原始模型输出，不能把无效输出转成有效分数。
