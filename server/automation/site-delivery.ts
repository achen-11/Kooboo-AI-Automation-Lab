import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AutomationTask } from '../../shared/automation.js';
import { taskSummary, brief } from '../../shared/task-presentation.js';
import { siteDeliveryStates, usageStageNames, type SiteDeliverySummary } from '../../shared/site-delivery.js';
import type { UsageStage } from '../../shared/billing.js';
import type { AutomationStore } from './store.js';
import { targetReached } from './optimization.js';
import { registerSiteReportApi, selectSiteReport } from './site-reports.js';

const active = (task: AutomationTask) => !task.stopped || ['queued', 'following-up', 'running', 'cancelling'].includes(task.status);
const optimizing = (task: AutomationTask) => task.optimization && !['completed', 'stopped'].includes(task.optimization.state);

/** Aggregate ledger rows once per actual site, including independent reviews and later continuations. */
export function siteDeliveries(store: AutomationStore, threshold: number): SiteDeliverySummary[] {
  const tasks = store.tasks(), groups = new Map<string, AutomationTask[]>();
  for (const task of tasks) {
    const key = task.generatedSiteId || task.id;
    const group = groups.get(key) || []; group.push(task); groups.set(key, group);
  }
  for (const site of store.sites()) if (!groups.has(site.id)) groups.set(site.id, []);
  return [...groups].map(([id, members]) => {
    // tasks() has a stable newest-created ordering; updatedAt may belong to an older recovery heartbeat.
    const latest = members[0], site = store.site(id), resource = store.resource(site?.resourceId || latest!.resourceId);
    const latestGeneration = members.find(task => task.kind === 'generation' && !task.optimizationRootId);
    const latestRoot = latest?.optimizationRootId ? members.find(task => task.id === latest.optimizationRootId) : latest;
    const controller = members.find(task => optimizing(task)) || latestRoot || latestGeneration;
    const busy = members.find(active), interrupted = members.find(task => (active(task) || task === latest || task.id === controller?.optimization?.activeTaskId) && ['pending', 'interrupted', 'failed', 'cancelled'].includes(task.status));
    const siteState = site ? store.siteState(site.id) : undefined;
    const { scope, currentReportId, targetScore } = selectSiteReport(members, siteState, threshold);
    const report = currentReportId ? members.find(task => task.id === currentReportId) : undefined;
    let state: SiteDeliverySummary['state'] = 'awaiting-evaluation', reason = '当前版本尚无有效独立评测报告。';
    if (interrupted) {
      state = 'attention'; reason = interrupted.interruption?.reason || interrupted.error || '当前阶段已停止，请查看原因和下一步。';
    } else if (busy || members.some(optimizing)) {
      state = busy?.status === 'queued' ? 'queued' : 'running';
      reason = busy ? busy.kind === 'generation' ? '正在生成或修复，完成后继续独立评测。' : '正在独立评测当前版本。' : '正在分析报告并安排下一轮修复。';
    } else if (controller?.optimization?.state === 'stopped') {
      state = 'attention'; reason = controller.optimization.reason || '流程已停止，请查看原因和下一步。';
    } else if (report?.report) {
      const scoresPassed = ['desktop', 'mobile'].every(viewport => {
        const score = report.report!.scores.find(item => item.viewport === viewport)?.value;
        return typeof score === 'number' && score >= targetScore;
      });
      const scopePassed = scope !== 'site' || !(report.requirementsEnabled || report.report.completeness) || report.report.completeness?.state === 'complete' && report.report.completeness.sourceComplete !== false;
      const passed = report.report.quality === 'passed' && scopePassed && scoresPassed
        && !report.report.issues.some(issue => issue.severity === 'critical' || issue.severity === 'major')
        && (report.rule?.criteria.filter(criterion => criterion.required && criterion.scopes.includes(scope)).every(criterion => criterion.viewports.every(viewport => report.report!.assessments.some(assessment => assessment.criterionId === criterion.id && assessment.viewport === viewport && assessment.passed === true && assessment.score !== null))) ?? true)
        && (!controller?.optimization || targetReached(controller, report.report));
      state = passed ? 'ready' : report.report.quality === 'unverified' ? 'unverified' : 'needs-improvement';
      reason = passed ? `${scope === 'homepage' ? '仅首页' : '全站'}已通过当前评测口径；正式上线与适用交付核验仍按环境处理。` : report.report.summary;
    }
    const delivery = members.find(task => task.delivery && (!siteState || task.siteRevision === siteState.revision))?.delivery;
    if (delivery && ['failed', 'uncertain'].includes(delivery.status)) { state = 'attention'; reason = delivery.error || '交付核验尚未完成。'; }
    else if (delivery && ['queued', 'running', 'verifying'].includes(delivery.status)) { state = 'running'; reason = '正在迁移交付或核验目标环境。'; }
    const ids = members.map(task => task.id), usage = store.usage.summary(ids[0] || id, ids.slice(1));
    const stages = (Object.keys(usageStageNames) as UsageStage[]).map(stage => ({ stage, usage: store.usage.summary(ids[0] || id, ids.slice(1), stage) }));
    const detail = controller?.optimization ? controller : latest?.kind === 'evaluation' && latestGeneration?.evaluationTaskId !== latest.id ? latest : latestGeneration || latest;
    return { id, generatedSiteId: site?.id || latest?.generatedSiteId || null, resourceId: resource?.id || latest!.resourceId,
      resourceName: resource?.name || latest?.resourceName || site?.name || '生成站', siteUrl: site?.url || latest?.siteUrl || '',
      scenario: latest?.scenario || resource!.scenario, scope, detailTaskId: busy?.id && !controller?.optimization ? (busy.optimizationRootId || busy.id) : detail?.id || null,
      state, reason: brief(reason, 220), targetScore, report: report ? { ...taskSummary(report), reportCurrent: true } : null,
      usage, stages, taskCount: members.length, createdAt: site?.createdAt || latest!.createdAt,
      updatedAt: Math.max(site?.createdAt || 0, ...members.map(task => task.updatedAt)),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function registerSiteDeliveryApi(app: FastifyInstance, store: AutomationStore, threshold: () => number) {
  registerSiteReportApi(app, store, threshold);
  const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
  app.get('/api/automation/site-deliveries', async request => {
    const query = pagination.extend({ q: z.string().max(300).default(''), state: z.enum(Object.keys(siteDeliveryStates) as [keyof typeof siteDeliveryStates, ...Array<keyof typeof siteDeliveryStates>]).optional(), site: z.string().uuid().optional() }).parse(request.query);
    const needle = query.q.toLowerCase();
    const rows = siteDeliveries(store, threshold()).filter(row => (!query.site || row.generatedSiteId === query.site) && (!query.state || row.state === query.state) && (!needle || [row.resourceName, row.siteUrl, row.id].join(' ').toLowerCase().includes(needle)));
    const pages = Math.max(1, Math.ceil(rows.length / query.pageSize)), page = Math.min(query.page, pages);
    return { items: rows.slice((page - 1) * query.pageSize, page * query.pageSize), page, pages, pageSize: query.pageSize, total: rows.length };
  });
  app.get('/api/automation/site-deliveries/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = siteDeliveries(store, threshold()).find(row => row.id === id);
    return item || reply.code(404).send({ error: '生成站不存在' });
  });
  app.get('/api/automation/site-deliveries/:id/tasks', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params), query = pagination.parse(request.query);
    if (!store.site(id)) return reply.code(404).send({ error: '生成站不存在' });
    const rows = store.tasks().filter(task => task.generatedSiteId === id), pages = Math.max(1, Math.ceil(rows.length / query.pageSize)), page = Math.min(query.page, pages);
    return { items: rows.slice((page - 1) * query.pageSize, page * query.pageSize).map(task => ({ ...taskSummary(task), usage: store.usage.summary(task.id) })), page, pages, total: rows.length };
  });
  app.get('/api/automation/site-deliveries/:id/usage', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params), query = pagination.extend({ stage: z.enum(Object.keys(usageStageNames) as [UsageStage, ...UsageStage[]]).optional() }).parse(request.query);
    if (!store.site(id)) return reply.code(404).send({ error: '生成站不存在' });
    const ids = store.tasks().filter(task => task.generatedSiteId === id).map(task => task.id);
    return store.usage.page(ids[0] || id, ids.slice(1), query.page, query.pageSize, query.stage);
  });
}
