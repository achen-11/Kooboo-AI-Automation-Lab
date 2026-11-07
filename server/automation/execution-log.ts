import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { executionRecord, executionRules, executionTaskIds, executionTaskLabel, type ExecutionEvent } from '../../shared/execution-log.js';
import { Conflict } from '../lib/store.js';
import type { AutomationStore } from './store.js';

const integer = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const query = z.object({
  taskId: z.string().uuid().optional(),
  pageSize: integer.pipe(z.number().min(1).max(100)).default(20),
  filter: z.enum(['all', 'error', 'system', 'assistant', 'tool']).default('all'),
  q: z.string().trim().max(200).default(''),
  until: integer.optional(),
  before: integer.optional(),
  head: z.enum(['1']).optional(),
});
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
// This CASE uses the same ordered producer prefixes as the client projection, before LIMIT/OFFSET.
function classified(field: 'kind' | 'status') {
  return `CASE ${executionRules.map(rule => `WHEN substr(message,1,${rule.prefix.length})=${literal(rule.prefix)}${rule.suffix ? ` AND substr(message,-${rule.suffix.length})=${literal(rule.suffix)}` : ''} THEN ${literal(rule[field])}`).join(' ')} ELSE ${literal(field === 'kind' ? 'system' : 'unknown')} END`;
}

/** Cursor history keeps existing rows stable while newer events arrive. Legacy APIs remain unchanged. */
export function registerExecutionLogApi(app: FastifyInstance, store: AutomationStore) {
  app.get('/api/automation/tasks/:id/execution-log', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const task = store.task(id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    const q = query.parse(request.query), ids = executionTaskIds(task);
    if (q.taskId && !ids.includes(q.taskId)) throw new Conflict('执行记录不属于本工作流');
    const selectedId = q.taskId || id;
    const conditions = ['task_id=?'], args: unknown[] = [selectedId];
    if (q.filter !== 'all') conditions.push(`${classified(q.filter === 'error' ? 'status' : 'kind')}=?`), args.push(q.filter === 'error' ? 'failed' : q.filter);
    if (q.q) { conditions.push("instr(lower(message),lower(?))>0"); args.push(q.q); }
    const where = conditions.join(' AND ');
    return store.db.transaction(() => {
      const head = store.db.prepare(`SELECT COUNT(*) AS total,COALESCE(MAX(seq),0) AS latestSeq FROM auto_events WHERE ${where}`).get(...args);
      const latestSeq = Number(head.latestSeq);
      if (q.head) return { taskId: selectedId, total: Number(head.total), latestSeq };
      const snapshotSeq = Math.min(q.until ?? latestSeq, latestSeq), bounded = `${where} AND seq<=?`, boundedArgs = [...args, snapshotSeq];
      const total = q.until === undefined ? Number(head.total) : Number(store.db.prepare(`SELECT COUNT(*) AS total FROM auto_events WHERE ${bounded}`).get(...boundedArgs).total);
      const cursor = q.before === undefined ? '' : ' AND seq<?';
      const rows = store.db.prepare(`SELECT seq,time,message FROM auto_events WHERE ${bounded}${cursor} ORDER BY seq DESC LIMIT ?`).all(...boundedArgs, ...(q.before === undefined ? [] : [q.before]), q.pageSize + 1) as ExecutionEvent[];
      const items = rows.slice(0, q.pageSize).reverse().map(executionRecord);
      const related = ids.flatMap(taskId => {
        const item = taskId === id ? task : store.task(taskId);
        return item ? [{ id: taskId, label: executionTaskLabel(item, task) }] : [];
      });
      return { taskId: selectedId, items, total, latestSeq, snapshotSeq, hasOlder: rows.length > q.pageSize, pageSize: q.pageSize, related };
    });
  });
}
