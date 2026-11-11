import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { brief } from '../../shared/task-presentation.js';
import type { TaskHeader } from './task-index.js';
import { mergeUsage } from './billing.js';
import { siteDeliveryStates, usageStageNames, type SiteDeliverySummary } from '../../shared/site-delivery.js';
import { matchesDispositionFilter } from '../../shared/dispositions.js';
import type { UsageBreakdownStage } from '../../shared/billing.js';
import { generationStage } from '../../shared/generation-stage.js';
import type { AutomationStore } from './store.js';
import { targetReached } from './optimization.js';
import { registerSiteReportApi, selectSiteReport } from './site-reports.js';

const active = (task: TaskHeader) => !task.stopped || ['queued', 'following-up', 'running', 'cancelling'].includes(task.status);
const optimizing = (task: TaskHeader) => task.optimization && !['completed', 'stopped'].includes(task.optimization.state);

/** Aggregate ledger rows once per actual site, including independent reviews and later continuations. */
export function siteDeliveries(store: AutomationStore, threshold: number, siteId?: string): SiteDeliverySummary[] {
  const tasks = store.headers(siteId), groups = new Map<string, TaskHeader[]>();
  if(siteId&&!tasks.length){const pending=store.header(siteId);if(pending&&!pending.generatedSiteId)tasks.push(pending);}
  const sites=store.sites().filter(site=>!siteId||site.id===siteId), resources=new Map(store.resources().map(resource=>[resource.id,resource]));
  const siteMap=new Map(sites.map(site=>[site.id,site])), dispositions=store.dispositions.map('delivery');
  const ledger=store.usage.grouped(siteId?tasks.map(task=>task.id):undefined);
  for (const task of tasks) {
    const key = task.generatedSiteId || task.id;
    const group = groups.get(key) || []; group.push(task); groups.set(key, group);
  }
  for (const site of sites) if (!groups.has(site.id)) groups.set(site.id, []);
  return [...groups].map(([id, members]) => {
    // Headers retain newest-created ordering; updatedAt may belong to an older recovery heartbeat.
    const latest = members[0], site = siteMap.get(id), resource = resources.get(site?.resourceId || latest!.resourceId);
    const latestGeneration = members.find(task => task.kind === 'generation' && !task.optimizationRootId);
    const latestRoot = latest?.optimizationRootId ? members.find(task => task.id === latest.optimizationRootId) : latest;
    const controller = members.find(task => optimizing(task)) || latestRoot || latestGeneration;
    const busy = members.find(active), interrupted = members.find(task => (active(task) || task === latest || task.id === controller?.optimization?.activeTaskId) && ['pending', 'interrupted', 'failed', 'cancelled'].includes(task.status));
    const siteState = site ? store.siteState(site.id) : undefined;
    const { scope, currentReportId, targetScore } = selectSiteReport(members, siteState, threshold);
    const report = currentReportId ? members.find(task => task.id === currentReportId) : undefined;
    let state: SiteDeliverySummary['state'] = 'awaiting-evaluation', reason = '当前版本尚无有效独立评测报告。';
    if (interrupted) {
      state = 'attention'; reason = interrupted.attention || interrupted.error || '当前阶段已停止，请查看原因和下一步。';
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
    const ids = members.map(task => task.id), entries=ids.flatMap(taskId=>[...(ledger.get(taskId)?.values()||[])]), usage = mergeUsage(entries,ids.slice(1));
    const stages = (Object.keys(usageStageNames) as UsageBreakdownStage[]).map(stage => ({ stage, usage: mergeUsage(members.flatMap(task=>[...(ledger.get(task.id)?.entries()||[])].filter(([raw])=>generationStage(raw,task.optimizationRound)===stage).map(([,value])=>value)),ids.slice(1)) }));
    const detail = controller?.optimization ? controller : latest?.kind === 'evaluation' && latestGeneration?.evaluationTaskId !== latest.id ? latest : latestGeneration || latest;
    const disposition = dispositions.get(id), resourceDisposition = resource?.disposition;
    return { id, generatedSiteId: site?.id || latest?.generatedSiteId || null, resourceId: resource?.id || latest!.resourceId,
      resourceName: resource?.name || latest?.resourceName || site?.name || '生成站', siteUrl: site?.url || latest?.siteUrl || '',
      environmentId: site?.environmentId || latest?.environmentId || '',
      scenario: latest?.scenario || resource!.scenario, scope, detailTaskId: busy?.id && !controller?.optimization ? (busy.optimizationRootId || busy.id) : detail?.id || null,
      state, reason: brief(reason, 220), targetScore, report: report ? { ...report.summary, usage:mergeUsage(report.workflowIds.flatMap(taskId=>[...(ledger.get(taskId)?.values()||[])]),report.workflowIds.filter(taskId=>taskId!==report.id)), reportCurrent: true } : null,
      usage, stages, ...(disposition ? { disposition } : {}), ...(resourceDisposition ? { resourceDisposition } : {}), taskCount: members.length, createdAt: site?.createdAt || latest!.createdAt,
      updatedAt: Math.max(site?.createdAt || 0, ...members.map(task => task.updatedAt)),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function registerSiteDeliveryApi(app: FastifyInstance, store: AutomationStore, threshold: () => number) {
  registerSiteReportApi(app, store, threshold);
  const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
  app.get('/api/automation/site-deliveries', async request => {
    const query = pagination.extend({ q: z.string().max(300).default(''), state: z.enum(Object.keys(siteDeliveryStates) as [keyof typeof siteDeliveryStates, ...Array<keyof typeof siteDeliveryStates>]).optional(), disposition: z.enum(['active', 'completed', 'discarded', 'all']).default('active'), site: z.string().uuid().optional() }).parse(request.query);
    const needle = query.q.toLowerCase();
    const allRows = siteDeliveries(store, threshold(), query.site);
    const activeTotal = allRows.filter(row => !row.disposition).length;
    const rows = allRows.filter(row => matchesDispositionFilter(row.disposition, query.disposition) && (!query.site || row.generatedSiteId === query.site) && (!query.state || row.state === query.state) && (!needle || [row.resourceName, row.siteUrl, row.id].join(' ').toLowerCase().includes(needle)));
    const pages = Math.max(1, Math.ceil(rows.length / query.pageSize)), page = Math.min(query.page, pages);
    return { items: rows.slice((page - 1) * query.pageSize, page * query.pageSize), page, pages, pageSize: query.pageSize, total: rows.length, activeTotal };
  });
  app.get('/api/automation/site-deliveries/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = siteDeliveries(store, threshold(),id).find(row => row.id === id);
    return item || reply.code(404).send({ error: '生成站不存在' });
  });
  app.get('/api/automation/site-deliveries/:id/tasks', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params), query = pagination.parse(request.query);
    if (!store.site(id)) return reply.code(404).send({ error: '生成站不存在' });
    const rows = store.headers(id), pages = Math.max(1, Math.ceil(rows.length / query.pageSize)), page = Math.min(query.page, pages);
    return { items: rows.slice((page - 1) * query.pageSize, page * query.pageSize).map(task => ({ ...task.summary, usage: store.usage.summary(task.id) })), page, pages, total: rows.length };
  });
  app.get('/api/automation/site-deliveries/:id/usage', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params), query = pagination.extend({ stage: z.enum(Object.keys(usageStageNames) as [UsageBreakdownStage, ...UsageBreakdownStage[]]).optional() }).parse(request.query);
    if (!store.site(id)) return reply.code(404).send({ error: '生成站不存在' });
    const ids = store.headers(id).map(task => task.id);
    return store.usage.page(ids[0] || id, ids.slice(1), query.page, query.pageSize, query.stage);
  });
}
