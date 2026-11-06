import { createHash } from '../runtime.js';
import { z } from 'zod';
import { dimensionIdSchema } from './validation.js';
import { maxRuleDimensions } from '../../shared/rules.js';
import type { RuleSet } from '../../shared/types.js';
import builtin from './builtin-rule.js';
import agentRule from './agent-rule.js';
const versionPattern = /^[a-z][a-z0-9-]{0,79}$/;
const configSchema = z.object({
  version: z.string().regex(versionPattern),
  executor: z.literal('agent').optional(),
  name: z.string().min(1).max(200),
  threshold: z.number().min(0).max(100),
  dimensions: z
    .array(
      z.object({
        id: dimensionIdSchema,
        label: z.string().trim().min(1).max(200),
        weight: z.number().min(0).max(100),
        instruction: z.string().trim().min(1).max(8000),
      })
    )
    .min(1).max(maxRuleDimensions),
  viewports: z
    .array(
      z.object({
        id: z.enum(['desktop', 'mobile']),
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(320).max(2500),
      })
    )
    .length(2),
  capture: z.object({
    version: z.string().min(1).max(80),
    maxHeight: z.number().int().min(900).max(40000),
    timeoutMs: z.number().int().min(1000).max(120000),
    regions: z.number().int().min(1).max(3),
  }),
});
export function parseRule(value: unknown, publish = true): RuleSet {
  return configSchema
    .extend({ prompt: z.string().min(1).max(60000) })
    .superRefine((rule, context) => {
      if (
        publish &&
        Math.abs(rule.dimensions.reduce((sum, item) => sum + item.weight, 0) - 100) > 1e-8
      )
        context.addIssue({ code: 'custom', path: ['dimensions'], message: '权重之和必须为 100%' });
      if (new Set(rule.dimensions.map((item) => item.id)).size !== rule.dimensions.length)
        context.addIssue({
          code: 'custom',
          path: ['dimensions'],
          message: '评分维度不能重复',
        });
      if (new Set(rule.viewports.map((item) => item.id)).size !== 2)
        context.addIssue({
          code: 'custom',
          path: ['viewports'],
          message: '必须分别配置桌面和移动视口',
        });
    })
    .parse(value);
}
export function hashRule(rule: RuleSet): string {
  return createHash('sha256').update(JSON.stringify(rule)).digest('hex');
}
export function scoringInstructions(rule: RuleSet): string {
  return rule.prompt + '\n\n本轮评分配置（优先于上文中的固定维度示例、数量、标准和权重）：\n' +
    JSON.stringify({ version: rule.version, dimensions: rule.dimensions }) +
    '\n严格按本轮 dimensions 中每项 instruction 评分，label 为维度名称，weight 为程序计算总分的百分比权重。' +
    '有可用参考时，必须且只能返回以上全部维度，id 原样返回，每项一次，不得沿用旧维度或自行增删、改权重、重新归一化。' +
    '没有参考时 dimensions 为空。证据引用、实际看图及输出结构约定继续适用。';
}
export function listRules() {
  return [builtin, agentRule].map(value => { const rule = parseRule(value); return { rule, hash: hashRule(rule) }; });
}
