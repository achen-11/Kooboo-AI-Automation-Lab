import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { brief, taskRecoveryAction } from '../../shared/task-presentation.js';
import type { TaskHeader } from './task-index.js';
import { mergeUsage } from './billing.js';
import { hasAccessibleSiteUrl, siteDeliveryAddressFilters, siteDeliveryDeliveryFilters, siteDeliveryStates, usageStageNames, type SiteDeliveryAction, type SiteDeliveryAddressFilter, type SiteDeliveryDeliveryFilter, type SiteDeliveryRecovery, type SiteDeliverySummary } from '../../shared/site-delivery.js';
import { matchesDispositionFilter, type ItemDisposition } from '../../shared/dispositions.js';
import type { UsageBreakdownStage } from '../../shared/billing.js';
import type { GeneratedSite } from '../../shared/automation.js';
import type { RuntimeSettings } from '../../shared/types.js';
import { generationStage } from '../../shared/generation-stage.js';
import type { AutomationStore } from './store.js';
import { targetReached } from './optimization.js';
import { registerSiteReportApi, selectSiteReport } from './site-reports.js';
import { resolveEnvironmentDelivery } from '../lib/delivery-config.js';
import { reportPassedDeliveryGate } from './delivery.js';

const active = (task: TaskHeader) => !task.stopped || ['queued', 'following-up', 'running', 'cancelling'].includes(task.status);
const optimizing = (task: TaskHeader) => task.optimization && !['completed', 'stopped'].includes(task.optimization.state);

function matchesDeliveryAddress(siteUrl: string, address?: SiteDeliveryAddressFilter): boolean {
  if (!address) return true;
  const accessible = hasAccessibleSiteUrl(siteUrl);
  return address === 'accessible' ? accessible : !accessible;
}

function isUndeliveredFinished(row: SiteDeliverySummary): boolean {
  return row.deliveryAction?.eligible === true || (!row.delivery && Boolean(row.generatedSiteId) && !['running', 'queued', 'attention'].includes(row.state));
}

function computeSiteDeliveryAction(params: {
  store: AutomationStore;
  members: TaskHeader[];
  site: GeneratedSite | undefined;
  environmentId: string;
  disposition: ItemDisposition | undefined;
  report: TaskHeader | undefined;
  threshold: number;
  settings: Pick<RuntimeSettings, 'deliveryDefaults' | 'environments'>;
}): SiteDeliveryAction {
  const { store, members, site, environmentId, disposition, report, threshold, settings } = params;
  if (members.some(task => Boolean(task.delivery))) {
    return { eligible: false, code: 'already-delivered', reason: '该生成站已有跨环境交付记录' };
  }
  if (disposition) {
    return { eligible: false, code: 'archived', reason: '已归档，请先移回在列后再发起交付' };
  }
  const config = resolveEnvironmentDelivery(settings, environmentId);
  if (!config?.enabled) {
    return { eligible: false, code: 'unsupported-env', reason: '当前环境未启用跨环境交付' };
  }
  if (!config.token) {
    return { eligible: false, code: 'missing-token', reason: '当前环境缺少迁移服务令牌' };
  }
  if (site && store.domainReserved(site.id)) {
    return { eligible: false, code: 'domain-reserved', reason: '站点正在换绑域名，请稍后安排交付' };
  }
  if (members.some(task => !task.stopped || ['queued', 'following-up'].includes(task.status))) {
    return { eligible: false, code: 'in-progress', reason: '同一个源站还有执行任务，请等待结束' };
  }
  const evalCandidate = report?.kind === 'evaluation' && report.status === 'completed' && report.stopped && Boolean(report.report)
    ? report
    : undefined;
  const evalStaleDomain = Boolean(evalCandidate && site?.preferredDomain && store.currentReportHeader(evalCandidate)?.id !== evalCandidate.id);
  const genCandidate = members.find(task => task.kind === 'generation' && task.status === 'completed' && task.stopped && Boolean(task.generatedSiteId));
  const candidate = (!evalStaleDomain ? evalCandidate : undefined) || genCandidate;
  if (!candidate) {
    const forceCandidate = site && hasAccessibleSiteUrl(site.url)
      ? members.find(task => task.kind === 'generation' && task.stopped && Boolean(task.generatedSiteId))
        || members.find(task => task.kind === 'evaluation' && task.stopped && Boolean(task.generatedSiteId))
      : undefined;
    return {
      eligible: false,
      code: 'not-ready',
      reason: evalStaleDomain ? '站点域名已变更，请先完成当前地址的独立评测再交付' : '请先完成站点生成后再发起交付',
      ...(forceCandidate ? { forceEligible: true, forceTaskId: forceCandidate.id } : {}),
    };
  }
  if (!site || !hasAccessibleSiteUrl(site.url)) {
    return { eligible: false, code: 'missing-site-url', reason: '缺少生成站身份或地址' };
  }
  if (config.requirePassed) {
    const reportOwnerHeader = candidate.kind === 'evaluation'
      ? candidate
      : (report?.kind === 'evaluation' ? report : store.currentReportHeader(candidate));
    if (reportOwnerHeader) {
      const fullReportOwner = store.task(reportOwnerHeader.id, false);
      const gateThreshold = (fullReportOwner ? store.root(fullReportOwner)?.optimization?.threshold : undefined) ?? threshold;
      if (fullReportOwner && !reportPassedDeliveryGate(fullReportOwner, gateThreshold)) {
        return { eligible: false, code: 'require-passed', reason: '当前交付策略要求源站评测通过', forceEligible: true, forceTaskId: candidate.id };
      }
    }
  }
  return { eligible: true, taskId: candidate.id, code: 'ready' };
}

/** Aggregate ledger rows once per actual site, including independent reviews and later continuations. */
export function siteDeliveries(store: AutomationStore, threshold: number, siteId?: string, settings?: Pick<RuntimeSettings, 'deliveryDefaults' | 'environments'>): SiteDeliverySummary[] {
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
  const envNameMap = settings ? new Map(settings.environments.map(env => [env.id, env.name])) : undefined;
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
    let recovery: SiteDeliveryRecovery | undefined;
    if (interrupted) {
      state = 'attention'; reason = interrupted.attention || interrupted.error || '当前阶段已停止，请查看原因和下一步。';
      const action = taskRecoveryAction(interrupted.summary);
      if (action === 'confirm-stopped') {
        recovery = { action: 'confirm-stopped', taskId: interrupted.id };
      } else if (action === 'resume' || action === 'adjust-site-names' || action === 'handoff-conversation') {
        const hasOtherBusy = members.some(task => task.id !== interrupted.id && (active(task) || task.delivery?.stopped === false));
        const staleEval = interrupted.kind === 'evaluation' && interrupted.generatedSiteId && interrupted.siteRevision && siteState && siteState.revision !== interrupted.siteRevision;
        if (!hasOtherBusy && controller?.optimization?.state !== 'completed' && !staleEval) {
          recovery = { action, taskId: interrupted.id };
        }
      }
    } else if (busy || members.some(optimizing)) {
      state = busy?.status === 'queued' ? 'queued' : 'running';
      reason = busy
        ? busy.kind === 'generation'
          ? (busy.summary.autoEvaluate === false ? '正在生成站点（已关闭自动评测）。' : '正在生成或修复，完成后继续独立评测。')
          : '正在独立评测当前版本。'
        : '正在分析报告并安排下一轮修复。';
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
    } else if (latestGeneration?.status === 'completed' && latestGeneration.summary.autoEvaluate === false) {
      state = 'generated';
      reason = '生成已完成（已关闭自动评测，可直接使用站点或按需手动发起评测 / 交付）。';
    }
    const deliveryTask = members.find(task => task.delivery && (!siteState || task.siteRevision === siteState.revision));
    const delivery = deliveryTask?.delivery;
    if (delivery && ['failed', 'uncertain'].includes(delivery.status)) { state = 'attention'; reason = delivery.error || '交付核验尚未完成。'; recovery = undefined; }
    else if (delivery && ['queued', 'running', 'verifying'].includes(delivery.status)) { state = 'running'; reason = '正在迁移交付或核验目标环境。'; recovery = undefined; }
    else if (delivery?.status === 'completed') {
      if (delivery.forced) {
        if (['attention', 'awaiting-evaluation', 'needs-improvement', 'unverified'].includes(state)) {
          state = 'generated';
        }
        recovery = undefined;
        reason = state === 'ready'
          ? '已完成跨环境交付并通过核验。'
          : '已通过人工初步验收并强制完成跨环境交付。';
      } else if (state === 'ready' || state === 'unverified' || state === 'generated') {
        reason = state === 'generated'
          ? '已完成站点生成与跨环境交付（已跳过源站评测）。'
          : state === 'ready'
            ? '已完成跨环境交付并通过核验。'
            : '已完成跨环境交付并通过核验；源站报告含未验证说明。';
      }
    }
    const ids = members.map(task => task.id), entries=ids.flatMap(taskId=>[...(ledger.get(taskId)?.values()||[])]), usage = mergeUsage(entries,ids.slice(1));
    const stages = (Object.keys(usageStageNames) as UsageBreakdownStage[]).map(stage => ({ stage, usage: mergeUsage(members.flatMap(task=>[...(ledger.get(task.id)?.entries()||[])].filter(([raw])=>generationStage(raw,task.optimizationRound)===stage).map(([,value])=>value)),ids.slice(1)) }));
    const detail = controller?.optimization ? controller : latest?.kind === 'evaluation' && latestGeneration?.evaluationTaskId !== latest.id ? latest : latestGeneration || latest;
    const disposition = dispositions.get(id), resourceDisposition = resource?.disposition;
    if (disposition) recovery = undefined;
    const environmentId = site?.environmentId || latest?.environmentId || '';
    const environmentName = envNameMap?.get(environmentId);
    const deliveryAction = settings
      ? computeSiteDeliveryAction({ store, members, site, environmentId, disposition, report, threshold, settings })
      : undefined;
    return { id, generatedSiteId: site?.id || latest?.generatedSiteId || null, resourceId: resource?.id || latest!.resourceId,
      resourceName: resource?.name || latest?.resourceName || site?.name || '生成站', siteUrl: site?.url || latest?.siteUrl || '',
      environmentId,
      ...(environmentName ? { environmentName } : {}),
      scenario: latest?.scenario || resource!.scenario, scope, detailTaskId: busy?.id && !controller?.optimization ? (busy.optimizationRootId || busy.id) : detail?.id || null,
      state, reason: brief(reason, 220), targetScore, ...(recovery ? { recovery } : {}),
      ...(deliveryAction ? { deliveryAction } : {}),
      ...(deliveryTask && delivery ? { delivery: { taskId: deliveryTask.id, status: delivery.status, ...(delivery.targetUrl ? { targetUrl: delivery.targetUrl } : {}) } } : {}),
      report: report ? { ...report.summary, usage:mergeUsage(report.workflowIds.flatMap(taskId=>[...(ledger.get(taskId)?.values()||[])]),report.workflowIds.filter(taskId=>taskId!==report.id)), reportCurrent: true } : null,
      usage, stages, ...(disposition ? { disposition } : {}), ...(resourceDisposition ? { resourceDisposition } : {}), taskCount: members.length, createdAt: site?.createdAt || latest!.createdAt,
      updatedAt: Math.max(site?.createdAt || 0, ...members.map(task => task.updatedAt)),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function registerSiteDeliveryApi(app: FastifyInstance, store: AutomationStore, threshold: () => number, getSettings?: () => Pick<RuntimeSettings, 'deliveryDefaults' | 'environments'>) {
  registerSiteReportApi(app, store, threshold);
  const pagination = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
  app.get('/api/automation/site-deliveries', async request => {
    const addressKeys = Object.keys(siteDeliveryAddressFilters) as [SiteDeliveryAddressFilter, ...SiteDeliveryAddressFilter[]];
    const deliveryKeys = Object.keys(siteDeliveryDeliveryFilters) as [SiteDeliveryDeliveryFilter, ...SiteDeliveryDeliveryFilter[]];
    const query = pagination.extend({ q: z.string().max(300).default(''), state: z.enum(Object.keys(siteDeliveryStates) as [keyof typeof siteDeliveryStates, ...Array<keyof typeof siteDeliveryStates>]).optional(), address: z.enum(addressKeys).optional(), delivery: z.enum(deliveryKeys).optional(), disposition: z.enum(['active', 'completed', 'discarded', 'all']).default('active'), site: z.string().uuid().optional() }).parse(request.query);
    const needle = query.q.toLowerCase();
    const allRows = siteDeliveries(store, threshold(), query.site, getSettings?.());
    const activeTotal = allRows.filter(row => !row.disposition).length;
    const matchesQuery = (row: SiteDeliverySummary) => (!query.site || row.generatedSiteId === query.site) && (!needle || [row.resourceName, row.siteUrl, row.delivery?.targetUrl || '', row.id].join(' ').toLowerCase().includes(needle));
    const activeMatchingRows = allRows.filter(row => !row.disposition && matchesQuery(row));
    const deliverableCount = activeMatchingRows.filter(row => row.deliveryAction?.eligible === true).length;
    const undeliveredCount = activeMatchingRows.filter(isUndeliveredFinished).length;
    const scopedRows = allRows.filter(row => matchesDispositionFilter(row.disposition, query.disposition) && matchesQuery(row));
    const attentionMissingAddress = scopedRows.filter(row => row.state === 'attention' && !hasAccessibleSiteUrl(row.siteUrl)).length;
    const rows = scopedRows.filter(row =>
      (!query.state || row.state === query.state)
      && matchesDeliveryAddress(row.siteUrl, query.address)
      && (!query.delivery || (query.delivery === 'deliverable' ? row.deliveryAction?.eligible === true : isUndeliveredFinished(row))),
    );
    const pages = Math.max(1, Math.ceil(rows.length / query.pageSize)), page = Math.min(query.page, pages);
    return { items: rows.slice((page - 1) * query.pageSize, page * query.pageSize), page, pages, pageSize: query.pageSize, total: rows.length, activeTotal, attentionMissingAddress, deliverableCount, undeliveredCount };
  });
  app.get('/api/automation/site-deliveries/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const item = siteDeliveries(store, threshold(), id, getSettings?.()).find(row => row.id === id);
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
