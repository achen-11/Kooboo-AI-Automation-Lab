import { createHash } from '../runtime.js';
import { z } from 'zod';
import { dimensionIds } from './validation.js';
import type { RuleSet } from '../shared/types.js';
import builtin from '../builtin-rule.json';
const versionPattern = /^[a-z][a-z0-9-]{0,79}$/;
const configSchema = z.object({
  version: z.string().regex(versionPattern), name: z.string().min(1).max(200), threshold: z.number().min(0).max(100),
  dimensions: z.array(z.object({ id: z.enum(dimensionIds), label: z.string().min(1).max(200), weight: z.number().min(0).max(100), instruction: z.string().min(1).max(8000) })).length(5),
  viewports: z.array(z.object({ id: z.enum(['desktop','mobile']), width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2500) })).length(2),
  capture: z.object({ version: z.string().min(1).max(80), maxHeight: z.number().int().min(900).max(20000), timeoutMs: z.number().int().min(1000).max(60000), regions: z.number().int().min(1).max(3) }),
});
export function parseRule(value: unknown, publish = true): RuleSet {
  return configSchema.extend({ prompt: z.string().min(1).max(60000) }).superRefine((rule, context) => {
    if (publish && Math.abs(rule.dimensions.reduce((sum, item) => sum + item.weight, 0) - 100) > 1e-8) context.addIssue({ code: 'custom', path: ['dimensions'], message: '权重之和必须为 100%' });
    if (new Set(rule.dimensions.map((item) => item.id)).size !== 5) context.addIssue({ code: 'custom', path: ['dimensions'], message: '五个评分维度必须各出现一次' });
    if (new Set(rule.viewports.map((item) => item.id)).size !== 2) context.addIssue({ code: 'custom', path: ['viewports'], message: '必须分别配置桌面和移动视口' });
  }).parse(value);
}
export function hashRule(rule: RuleSet): string { return createHash('sha256').update(JSON.stringify(rule)).digest('hex'); }
export function listRules() { const rule = parseRule(builtin); return [{ rule, hash: hashRule(rule) }]; }
