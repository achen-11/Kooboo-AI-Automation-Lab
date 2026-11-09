import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutomationTask } from '../../shared/automation.js';
import type { SiteEvaluationRecord, SiteReportPage } from '../../shared/site-reports.js';
import type { AutomationStore } from './store.js';

type ReportIdentity = Pick<AutomationTask, 'id' | 'kind' | 'scope' | 'status' | 'stopped' | 'siteRevision' | 'optimizationRootId'> & {
  report: unknown;
  optimization?: Pick<NonNullable<AutomationTask['optimization']>, 'state' | 'reportId'> & { policy: { targetScore: number } };
};
const active = (task: ReportIdentity) => !task.stopped || ['queued', 'following-up', 'running', 'cancelling'].includes(task.status);

/** Same applicability rules for the delivery overview and the report history. Input order is newest-created first. */
export function selectSiteReport(members: ReportIdentity[], state: { revision: string; reportId: string | null } | undefined, threshold: number) {
  const latest = members[0], generation = members.find(task => task.kind === 'generation' && !task.optimizationRootId);
  const root = latest?.optimizationRootId ? members.find(task => task.id === latest.optimizationRootId) : latest;
  const controller = members.find(task => task.optimization && !['completed', 'stopped'].includes(task.optimization.state)) || root || generation;
  const scope = generation?.scope || latest?.scope || 'site';
  const source = state ? members.find(task => task.id === state.reportId) : members.find(task => task.kind === 'evaluation' && task.report);
  const valid = source?.report && source.status === 'completed' && source.stopped && source.scope === scope
    && (!state || source.siteRevision === state.revision)
    && (!controller?.optimization || controller.optimization.reportId === source.id)
    && !members.some(task => task.kind === 'generation' && active(task));
  return { currentReportId: valid ? source!.id : null, scope, targetScore: controller?.optimization?.policy.targetScore ?? generation?.optimization?.policy.targetScore ?? threshold };
}

function reportContext(store: AutomationStore, siteId: string, threshold: number) {
  // Read identity/state only: reports, evidence, prompts and optimization SOPs stay out of list queries.
  const members = store.db.prepare(`SELECT id, kind, status,
    json_extract(json,'$.scope') AS scope, json_extract(json,'$.stopped') AS stopped,
    json_extract(json,'$.siteRevision') AS siteRevision, json_extract(json,'$.optimizationRootId') AS optimizationRootId,
    json_type(json,'$.report')='object' AS report,
    json_extract(json,'$.optimization.state') AS optimizationState,
    json_extract(json,'$.optimization.reportId') AS reportId,
    json_extract(json,'$.optimization.policy.targetScore') AS targetScore
    FROM auto_task_index WHERE site_key=? ORDER BY created_at DESC, rowid DESC`).all(siteId).map(row => ({
      ...row, stopped: Boolean(row.stopped),
      optimization: row.optimizationState ? { state: row.optimizationState, reportId: row.reportId, policy: { targetScore: row.targetScore } } : undefined,
    })) as ReportIdentity[];
  return selectSiteReport(members, store.siteState(siteId), threshold);
}

export function registerSiteReportApi(app: FastifyInstance, store: AutomationStore, threshold: () => number) {
  const params = z.object({ id: z.string().uuid() });
  app.get('/api/automation/site-deliveries/:id/reports', async (request, reply) => {
    const { id } = params.parse(request.params);
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) }).parse(request.query);
    if (!store.site(id)) return reply.code(404).send({ error: '生成站不存在' });
    const total = Number(store.db.prepare("SELECT COUNT(*) AS total FROM auto_task_index WHERE site_key=? AND kind='evaluation'").get(id).total);
    const pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
    const context = reportContext(store, id, threshold());
    const items: SiteEvaluationRecord[] = store.db.prepare(`SELECT id, status, created_at AS createdAt,
      json_extract(json,'$.scope') AS scope, json_extract(json,'$.stopped') AS stopped,
      json_extract(json,'$.optimizationRound') AS optimizationRound,
      CASE WHEN status='completed' AND json_extract(json,'$.stopped')=1 AND json_type(json,'$.report')='object'
        THEN json_object('quality',json_extract(json,'$.report.quality'),'scores',json_extract(json,'$.report.scores')) END AS report
      FROM auto_task_index WHERE site_key=? AND kind='evaluation'
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(id, query.pageSize, (page - 1) * query.pageSize).map(row => ({
        id: row.id, scope: row.scope, status: row.status, stopped: Boolean(row.stopped), createdAt: row.createdAt,
        optimizationRound: row.optimizationRound ?? undefined,
        report: row.report ? JSON.parse(row.report) : null, reportCurrent: context.currentReportId === row.id,
      }));
    return { ...context, items, total, pages, page, pageSize: query.pageSize } satisfies SiteReportPage;
  });
  app.get('/api/automation/site-deliveries/:id/reports/:reportId', async (request, reply) => {
    const { id, reportId } = params.extend({ reportId: z.string().uuid() }).parse(request.params);
    const task = store.task(reportId);
    if (!store.site(id) || !task || task.generatedSiteId !== id || task.kind !== 'evaluation') return reply.code(404).send({ error: '评测记录不属于该生成站' });
    const root = store.root(task), round = root?.optimization?.rounds.find(item => item.evaluationTaskId === task.id);
    const report = task.status === 'completed' && task.stopped ? task.report : null;
    return {
      taskId: task.id, rule: task.rule, report: report ? { ...report, ...(report.completeness ? { completeness: { ...report.completeness, checks: [] } } : {}) } : null,
      evaluation: { scope: task.scope, createdAt: task.createdAt, status: task.status },
      historical: Boolean(report) && reportContext(store, id, threshold()).currentReportId !== task.id,
      selectedRound: round ? { brief: round.brief, progress: round.progress } : undefined,
    };
  });
}
