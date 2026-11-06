import { z } from 'zod';
import { URL } from '../runtime.js';
import { dimensionIdPattern, maxRuleDimensions } from '../../shared/rules.js';
z.config({ jitless: true });

export const webUrl = z
  .string()
  .max(2000)
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      return url.toString();
    } catch {
      context.addIssue({ code: 'custom', message: '请填写不含账号密码的 HTTP 或 HTTPS 地址' });
      return z.NEVER;
    }
  });
const label = z.string().trim().min(1).max(200);
export const submissionSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: label,
  requestId: label,
  jobId: label,
  trigger: z.enum(['chat_stopped', 'manual']),
  occurredAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  target: z.object({ koobooOrigin: webUrl.transform((url) => new URL(url).origin), siteId: label }),
  inputs: z.object({
    sourceUrl: webUrl.optional(),
    referenceUrl: webUrl.optional(),
    materialsPath: z
      .string()
      .regex(/^_materials\/[a-zA-Z0-9_-]+\/README\.md$/)
      .optional(),
  }),
  scope: z.enum(['homepage', 'site']),
  ruleSetVersion: label.optional(),
});
export const dimensionIdSchema = z.string().regex(dimensionIdPattern);
const evidenceIds = z.array(z.string().min(1).max(150)).min(1).max(20);
export const modelResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  confidence: z.enum(['high', 'medium', 'low']),
  dimensions: z
    .array(
      z.object({
        id: dimensionIdSchema,
        score: z.number().min(0).max(100),
        reason: z.string().min(1).max(2000),
        evidence: evidenceIds,
      })
    )
    .max(maxRuleDimensions),
  completionScore: z.number().min(0).max(100).nullable(),
  issues: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        dimension: z.string().max(100),
        title: z.string().min(1).max(200),
        detail: z.string().min(1).max(2000),
        evidence: evidenceIds,
      })
    )
    .max(40),
});

export const settingsSchema = z
  .object({
    threshold: z.number().min(0).max(100),
    paused: z.boolean(),
    model: z.object({
      endpoint: z.union([z.literal(''), webUrl]),
      name: z.string().max(200),
      apiKey: z.string().max(10000).optional(),
      clearKey: z.boolean().optional(),
    }),
    execution: z.object({ timeoutSeconds: z.number().int().min(30).max(1800).default(300), captureAttempts: z.number().int().min(1).max(3).default(2) }).default({ timeoutSeconds: 300, captureAttempts: 2 }),
    environments: z
      .array(
        z.object({
          id: z.string().uuid(),
          name: z.string().trim().min(1).max(100),
          origin: webUrl.transform((url) => new URL(url).origin),
          apiOrigin: webUrl.transform((url) => new URL(url).origin),
          token: z.string().max(10000).optional(),
          clearToken: z.boolean().optional(),
        })
      )
      .max(50),
  })
  .superRefine((settings, context) => {
    if (
      new Set(settings.environments.map((env) => env.origin)).size !==
        settings.environments.length ||
      new Set(settings.environments.map((env) => env.id)).size !== settings.environments.length
    ) {
      context.addIssue({ code: 'custom', message: '环境地址和标识不能重复' });
    }
    if (
      settings.model.endpoint &&
      (new URL(settings.model.endpoint).search || new URL(settings.model.endpoint).hash)
    )
      context.addIssue({
        code: 'custom',
        message: '模型接口地址不能包含查询参数或片段，请通过 API Key 字段配置凭据',
      });
  });
