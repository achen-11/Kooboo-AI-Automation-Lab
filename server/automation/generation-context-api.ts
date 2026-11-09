import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { GenerationContextStore, cleanupGenerationContext } from './generation-context.js';
import { koobooClient } from './kooboo.js';

export function registerGenerationContextApi(app: FastifyInstance, store: AutomationStore, vault: Vault, owns: (id: string) => boolean) {
  const params = z.object({ id: z.string().uuid() });
  app.get('/api/automation/tasks/:id/generation-context', async request => {
    const { id } = params.parse(request.params);
    if (!store.task(id)) throw new Conflict('任务不存在');
    return { packages: new GenerationContextStore(store).packages(id).map(({ original, files, ...metadata }) => ({ ...metadata, originalBytes: Buffer.byteLength(original), files: files.map(({ text, ...file }) => file) })) };
  });
  app.post('/api/automation/tasks/:id/generation-context/cleanup', async request => {
    const { id } = params.parse(request.params), task = store.task(id);
    if (!task || !task.stopped || owns(id) || !['completed', 'cancelled'].includes(task.status) || store.tasks().some(t => t.generatedSiteId === task.generatedSiteId && (!t.stopped || owns(t.id)))) throw new Conflict('仅在执行已确认结束且同站无活动任务时清理；中断任务保留恢复资料');
    const site = task.generatedSiteId && store.site(task.generatedSiteId);
    if (!site) throw new Conflict('缺少已绑定的生成站');
    await cleanupGenerationContext(task, store, koobooClient(task, vault, AbortSignal.timeout(60000)).request, site.siteId, true);
    return { states: new GenerationContextStore(store).packages(id).map(p => ({ id: p.id, state: p.state, error: p.error })) };
  });
}
