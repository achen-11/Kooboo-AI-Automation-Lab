import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { AutomationStore } from '../automation/store.js';
import type { Vault } from '../lib/vault.js';
import { DiagnosticExports, type DiagnosticDependencies } from './service.js';

export function registerDiagnosticApi(app: FastifyInstance, store: AutomationStore, vault: Vault, directory: string, dependencies?: DiagnosticDependencies) {
  const exports = new DiagnosticExports(store, vault, directory, dependencies), params = z.object({ id: z.string().uuid() });
  app.post('/api/automation/tasks/:id/diagnostic-exports', async (request, reply) => {
    const { id } = params.parse(request.params); return reply.code(202).send(await exports.create(id));
  });
  app.get('/api/automation/tasks/:id/diagnostic-exports/latest', async (request, reply) => {
    const { id } = params.parse(request.params); const job = exports.latest(id);
    return job ? job : reply.code(404).send({ error: '暂无排障包' });
  });
  app.get('/api/automation/diagnostic-exports/:id', async (request, reply) => {
    const { id } = params.parse(request.params); const job = exports.get(id);
    return job ? job : reply.code(404).send({ error: '排障包不存在或已过期，请重新导出' });
  });
  app.post('/api/automation/diagnostic-exports/:id/cancel', async request => exports.cancel(params.parse(request.params).id));
  app.get('/api/automation/diagnostic-exports/:id/download', async (request, reply) => {
    const { job, path } = exports.download(params.parse(request.params).id), info = await stat(path);
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${job.filename}"`).header('Content-Length', info.size).header('X-Content-Type-Options', 'nosniff').send(createReadStream(path));
  });
  app.addHook('onClose', () => exports.close()); return exports;
}
