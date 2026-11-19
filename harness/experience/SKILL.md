# 经验学习闭环规范（Experience Loop）

Automation Lab 通过本地经验库在多轮任务之间沉淀可复用的排障与评测经验，而不是无休止地堆砌提示词。

## 两阶段机制

1. **执行前筛选（[references/selection.md](references/selection.md)）**：根据当前任务场景、阶段和环境筛选最多 5 条真正适用的经验，注入本轮工作区；不盲目采用，也不覆盖任务预算或评分标准。
2. **完成后复盘（[references/reflection.md](references/reflection.md)）**：在任务评测完成或中断后，依据真实证据决定是否新增或修订经验；严格区分已验证效果与未验证假设。如果是程序 Bug，明确指出需要修改代码而不是靠提示词掩盖。
