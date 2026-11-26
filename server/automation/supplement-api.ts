import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Conflict } from '../lib/store.js';
import type { Vault } from '../lib/vault.js';
import { materialPath, uniqueMaterialPaths } from '../../shared/materials.js';
import type { AutomationStore } from './store.js';
import {
  applySupplementBatch,
  buildSupplementContext,
  createSupplementBatch,
  SupplementStore,
} from './supplement.js';
import { cancelAiSupplementIntake, startAiSupplementIntake } from './supplement-ai.js';

const uuid = z.string().uuid();
const logicalPath = z
  .string()
  .min(1)
  .max(300)
  .refine(n => {
    try {
      return materialPath(n) === n;
    } catch {
      return false;
    }
  }, '附件路径不合法');
const fileSchema = z.object({
  id: uuid,
  name: logicalPath,
  type: z.string().max(200),
  size: z.number().int().min(0).max(16 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const optionalHttpUrl = z
  .string()
  .trim()
  .max(2000)
  .default('')
  .refine(v => !v || /^https?:\/\/.+/.test(v), '请填写有效的 http:// 或 https:// 地址');

export function registerTaskSupplementApi(
  app: FastifyInstance,
  store: AutomationStore,
  vault: Vault,
  directory: string,
) {
  const supplements = new SupplementStore(store);

  function checkUploadedFiles(items: z.infer<typeof fileSchema>[]) {
    uniqueMaterialPaths(items);
    const filesDir = resolve(directory, 'materials');
    for (const item of items) {
      const saved = store.db.prepare('SELECT json FROM auto_files WHERE id = ?').get(item.id) as
        | { json: string }
        | undefined;
      if (!saved || JSON.stringify(JSON.parse(saved.json)) !== JSON.stringify(item) || !existsSync(resolve(filesDir, item.id))) {
        throw new Conflict(`补充附件不存在或未通过校验：${item.name}`);
      }
    }
  }

  app.get('/api/automation/tasks/:id/supplements', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    return buildSupplementContext(task, store, supplements);
  });

  app.post('/api/automation/tasks/:id/supplements/manual', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });

    const body = z
      .object({
        files: z.array(fileSchema).max(500).default([]),
        note: z.string().trim().max(20000).default(''),
        replacementContentUrl: optionalHttpUrl,
        replacementReferenceUrl: optionalHttpUrl,
        skipSourceTransfer: z.boolean().optional(),
        skipReferencePreflight: z.boolean().optional(),
        allowFreeDesignWithoutReference: z.boolean().optional(),
        confirmDecision: z.boolean().optional(),
      })
      .parse(request.body || {});

    checkUploadedFiles(body.files);

    const batch = createSupplementBatch({
      taskId: task.id,
      mode: 'manual',
      status: 'ready',
      note: body.note,
      replacementContentUrl: body.replacementContentUrl,
      replacementReferenceUrl: body.replacementReferenceUrl,
      skipSourceTransfer: body.skipSourceTransfer,
      skipReferencePreflight: body.skipReferencePreflight,
      allowFreeDesignWithoutReference: body.allowFreeDesignWithoutReference,
      confirmDecision: body.confirmDecision,
      files: body.files.map(f => ({ ...f, source: 'manual' })),
    });
    supplements.put(batch);

    const applied = await applySupplementBatch({
      batch,
      task,
      store,
      supplements,
      vault,
      directory,
      signal: request.raw.destroyed ? AbortSignal.abort() : AbortSignal.timeout(120000),
      confirmDecisionOverride: body.confirmDecision,
    });

    return reply.send({ task: applied.task, batch: applied.batch });
  });

  app.post('/api/automation/tasks/:id/supplements/ai-collect', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    if (task.kind !== 'generation') throw new Conflict('仅支持为生成任务收集补充资料');
    if (!task.stopped || !['interrupted', 'pending', 'failed', 'cancelled'].includes(task.status)) {
      throw new Conflict('请先确认当前任务已停止再启动 AI 资料收集');
    }

    const body = z
      .object({
        sourceUrl: optionalHttpUrl,
        note: z.string().trim().max(20000).default(''),
        inputFiles: z.array(fileSchema).max(200).default([]),
        autoApply: z.boolean().default(false),
        skipSourceTransfer: z.boolean().default(true),
      })
      .parse(request.body || {});

    checkUploadedFiles(body.inputFiles);
    if (!body.sourceUrl && !body.note && !body.inputFiles.length) {
      throw new Conflict('请填写要抓取的目标网址、补充要求或上传原始参考素材');
    }

    const active = supplements.list(task.id).find(b => b.status === 'collecting');
    if (active) throw new Conflict('已有进行中的 AI 资料收集任务，请等待完成或先取消后再试');

    const batch = createSupplementBatch({
      taskId: task.id,
      mode: 'ai-assisted',
      status: 'collecting',
      note: body.note,
      sourceUrl: body.sourceUrl,
      skipSourceTransfer: body.skipSourceTransfer,
      autoApply: body.autoApply,
      inputFiles: body.inputFiles,
    });
    supplements.put(batch);
    store.event(task.id, `已启动本地 AI 辅助资料收集${body.sourceUrl ? `（${body.sourceUrl}）` : ''}`);

    void startAiSupplementIntake({
      task,
      batch,
      store,
      supplements,
      vault,
      directory,
    });

    return reply.code(202).send({ batch });
  });

  app.post('/api/automation/tasks/:id/supplements/:batchId/apply', async (request, reply) => {
    const { id, batchId } = z.object({ id: uuid, batchId: uuid }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    const batch = supplements.get(batchId);
    if (!batch || batch.taskId !== id) return reply.code(404).send({ error: '资料收集批次不存在' });

    const body = z
      .object({
        selectedFileIds: z.array(uuid).max(500).optional(),
        note: z.string().trim().max(20000).optional(),
        skipSourceTransfer: z.boolean().optional(),
        skipReferencePreflight: z.boolean().optional(),
        allowFreeDesignWithoutReference: z.boolean().optional(),
        replacementContentUrl: optionalHttpUrl.optional(),
        replacementReferenceUrl: optionalHttpUrl.optional(),
      })
      .parse(request.body || {});

    const applied = await applySupplementBatch({
      batch,
      task,
      store,
      supplements,
      vault,
      directory,
      signal: AbortSignal.timeout(120000),
      selectedFileIds: body.selectedFileIds,
      noteOverride: body.note,
      skipSourceTransferOverride: body.skipSourceTransfer,
      skipReferencePreflightOverride: body.skipReferencePreflight,
      allowFreeDesignWithoutReferenceOverride: body.allowFreeDesignWithoutReference,
      replacementContentUrlOverride: body.replacementContentUrl,
      replacementReferenceUrlOverride: body.replacementReferenceUrl,
    });

    return reply.send({ task: applied.task, batch: applied.batch });
  });

  app.post('/api/automation/tasks/:id/supplements/:batchId/cancel', async (request, reply) => {
    const { id, batchId } = z.object({ id: uuid, batchId: uuid }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    const batch = supplements.get(batchId);
    if (!batch || batch.taskId !== id) return reply.code(404).send({ error: '资料收集批次不存在' });

    const aborted = cancelAiSupplementIntake(batch.id);
    if (!aborted && ['collecting', 'ready'].includes(batch.status)) {
      batch.status = 'cancelled';
      batch.updatedAt = Date.now();
      supplements.put(batch);
      store.event(task.id, '已取消/放弃补充资料草稿');
    }

    return reply.send({ batch: supplements.get(batch.id) || batch });
  });
}
