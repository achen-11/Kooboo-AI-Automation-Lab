import type { RuleSet } from '../../shared/types.js';

export const defaultRuleVersion = 'agent-ui-v1';
const rule: RuleSet = {
  version: defaultRuleVersion,
  executor: 'agent',
  name: 'Agent 首页 UI 还原度 · 第一版',
  threshold: 80,
  dimensions: [
    {
      id: 'layout',
      label: '页面结构与布局',
      weight: 30,
      instruction: '模块顺序、分栏、组合关系和对齐',
    },
    {
      id: 'spacing',
      label: '尺寸与间距',
      weight: 20,
      instruction: '留白、宽高、视觉占比和内容密度',
    },
    {
      id: 'typography',
      label: '字体与文字层级',
      weight: 15,
      instruction: '字号、字重、行高、色阶和换行',
    },
    {
      id: 'decoration',
      label: '颜色与装饰',
      weight: 10,
      instruction: '背景、边框、圆角、阴影、按钮与图形装饰',
    },
    {
      id: 'imagery',
      label: '图片与图形',
      weight: 15,
      instruction: '图片位置、比例、裁切和组合；不单独因题材替换扣分',
    },
    {
      id: 'mobile',
      label: '移动端布局',
      weight: 10,
      instruction: '必须查看两站移动截图，比较堆叠、密度、导航与遮挡',
    },
  ],
  viewports: [
    { id: 'desktop', width: 1440, height: 900 },
    { id: 'mobile', width: 390, height: 844 },
  ],
  capture: { version: 'continuous-agent-v1', maxHeight: 30000, timeoutMs: 60000, regions: 3 },
  prompt:
    '按实际截图比较首页静态 UI。品牌、语言、图片题材和语义不同不直接扣分，但其造成的布局、换行、比例和构图变化计入差异。90 附近表示结构和细节接近，80 附近表示结构接近但局部有差异，60 附近表示保留风格而多个重要模块重构，40 附近表示只保留少量通用特征。评分尚未校准。每项引用两站实际看过的分段图，移动项必须引用两站移动图。缺失证据不能记零分或重新归一化。程序负责权重和总分。',
};
export default rule;
