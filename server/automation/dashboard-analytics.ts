import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { scenarios } from '../../shared/automation.js';
import { dashboardStageNames, type AnalyticsBucket, type AnalyticsQuery, type AnalyticsRun, type DashboardAnalytics, type DashboardStage, type EfficiencySummary, type StageConsumption } from '../../shared/dashboard-analytics.js';
import type { AutomationStore } from './store.js';
import type { TaskHeader } from './task-index.js';
import { intervalUnion } from './timing.js';
import { generationStage } from '../../shared/generation-stage.js';

const hour = 3600000, day = hour * 24, offset = hour * 8;
type Span = { task_id: string; stage: string; layer: number; started_at: number; ended_at: number | null; heartbeat: number };
type Piece = { taskId: string; stage: DashboardStage | 'queue'; start: number; end: number };
type Charge = { task_id: string; stage: string; at: number | null; requests: number; missing: number; cost: number; modelMs: number };
const stages = () => Object.keys(dashboardStageNames).map(stage => ({ stage: stage as DashboardStage, knownCny: 0, recordedMs: 0, requests: 0, missingCosts: 0 }));
const summary = (): EfficiencySummary => ({ selected: 0, completed: 0, active: 0, queued: 0, failed: 0, interrupted: 0, cancelled: 0, pending: 0, missingStarts: 0, costSamples: 0, timingSamples: 0, averageCost: null, averageMs: null, averageElapsedMs: null, elapsedSamples: 0, knownCny: 0, missingCosts: 0, quality: { passed: 0, failed: 0, unverified: 0, missing: 0 }, stages: [] });
const inside = (at: number, start: number, end: number) => at >= start && at < end;
function stageName(stage: string, task: TaskHeader): DashboardStage | 'queue' {
  if (stage === 'queue') return 'queue';
  stage = generationStage(stage, task.optimizationRound);
  if (['planning', 'handoff'].includes(stage)) return 'prepare';
  return Object.hasOwn(dashboardStageNames, stage) ? stage as DashboardStage : 'other';
}
function executionPieces(task: TaskHeader, spans: Span[], now: number): Piece[] {
  const own = spans.map(span => ({ ...span, end: Math.min(now, span.ended_at ?? (span.stage === 'queue' ? now : span.heartbeat)) })).filter(span => span.end > span.started_at);
  const points = [...new Set(own.flatMap(span => [span.started_at, span.end]))].sort((a, b) => a - b);
  const result: Piece[] = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const owner = own.filter(span => span.started_at <= start && span.end >= end).sort((a, b) => b.layer - a.layer || b.started_at - a.started_at)[0];
    if (owner) result.push({ taskId: task.id, stage: stageName(owner.stage, task), start, end });
  }
  return result;
}
function rootGroups(tasks: TaskHeader[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  // Only automatic handoffs/repairs join a workflow. A manually requested review is independent.
  const automaticParent = new Map<string, string>();
  for (const task of tasks) {
    if (task.evaluationTaskId) automaticParent.set(task.evaluationTaskId, task.id);
    for (const id of task.workflowIds) if (id !== task.id && !automaticParent.has(id)) automaticParent.set(id, task.id);
  }
  const root = (task: TaskHeader) => {
    let id = task.id; const seen = new Set<string>();
    while (!seen.has(id)) { seen.add(id); const parent = byId.get(id)?.optimizationRootId || automaticParent.get(id); if (!parent || !byId.has(parent)) return id; id = parent; }
    return [...seen].sort()[0];
  };
  const groups = new Map<string, TaskHeader[]>();
  for (const task of tasks) { const id = root(task), group = groups.get(id) || []; group.push(task); groups.set(id, group); }
  return { groups, byId, root };
}
function summarize(runs: AnalyticsRun[]): EfficiencySummary {
  const value = summary(); value.selected = runs.length;
  const costs = runs.filter(run => run.status === 'completed' && run.startedAt !== null && run.requests > 0 && !run.missingCosts);
  const timed = runs.filter(run => run.status === 'completed' && run.durationMs !== null);
  const elapsed = runs.filter(run => run.status === 'completed' && run.elapsedMs !== null);
  for (const run of runs) { value[run.status]++; value.knownCny += run.knownCny; value.missingCosts += run.missingCosts; if (run.startedAt === null && run.status !== 'queued') value.missingStarts++; if (run.status === 'completed') value.quality[run.quality || 'missing']++; }
  value.costSamples = costs.length; value.timingSamples = timed.length; value.elapsedSamples = elapsed.length;
  value.averageCost = costs.length ? costs.reduce((sum, run) => sum + run.knownCny, 0) / costs.length : null;
  value.averageMs = timed.length ? timed.reduce((sum, run) => sum + run.durationMs!, 0) / timed.length : null;
  value.averageElapsedMs = elapsed.length ? elapsed.reduce((sum, run) => sum + run.elapsedMs!, 0) / elapsed.length : null;
  value.stages = stages().map(({ stage }) => ({ stage,
    averageCost: costs.length ? costs.reduce((sum, run) => sum + (run.stages.find(item => item.stage === stage)?.knownCny || 0), 0) / costs.length : null,
    averageMs: timed.length ? timed.reduce((sum, run) => sum + (run.stages.find(item => item.stage === stage)?.recordedMs || 0), 0) / timed.length : null,
  }));
  return value;
}

/** Compact projections only. No conversations, evidence, model endpoints or raw usage enter this response. */
export function dashboardAnalytics(store: AutomationStore, query: AnalyticsQuery, now = Date.now()): DashboardAnalytics {
  const all = store.headers(), { groups, byId, root } = rootGroups(all);
  const accepted = (task: TaskHeader) => (query.scenario === 'all' || task.scenario === query.scenario) && (query.scope === 'all' || task.scope === query.scope);
  const selectedTasks = all.filter(task => accepted(byId.get(root(task))!)), selectedIds = new Set(selectedTasks.map(task => task.id));
  const spans = new Map<string, Span[]>(), complete = new Set<string>();
  for (let i = 0; i < selectedTasks.length; i += 500) {
    const ids = selectedTasks.slice(i, i + 500).map(task => task.id), marks = ids.map(() => '?').join(',');
    for (const row of store.db.prepare(`SELECT task_id,stage,layer,started_at,ended_at,heartbeat FROM auto_timing_spans WHERE task_id IN (${marks})`).all(...ids) as Span[]) { const own = spans.get(row.task_id) || []; own.push(row); spans.set(row.task_id, own); }
    for (const row of store.db.prepare(`SELECT task_id FROM auto_timing_tasks WHERE tracked_from<=created_at AND task_id IN (${marks})`).all(...ids)) complete.add(row.task_id);
  }
  const pieces = new Map(selectedTasks.map(task => [task.id, executionPieces(task, spans.get(task.id) || [], now)]));
  const charges = store.db.prepare(`SELECT task_id,json_extract(json,'$.stage') stage,
    CASE WHEN json_type(json,'$.startedAt') IN ('integer','real') THEN CAST(json_extract(json,'$.startedAt')/${hour} AS INTEGER)*${hour} END at,
    COUNT(*) requests,SUM(CASE WHEN json_type(json,'$.cny') IN ('integer','real') THEN 0 ELSE 1 END) missing,
    COALESCE(SUM(json_extract(json,'$.cny')),0) cost,
    COALESCE(SUM(CASE WHEN json_extract(json,'$.status')<>'unknown' AND json_extract(json,'$.endedAt')>=json_extract(json,'$.startedAt') THEN json_extract(json,'$.endedAt')-json_extract(json,'$.startedAt') ELSE 0 END),0) modelMs
    FROM auto_usage GROUP BY task_id,stage,at`).all() as Charge[];
  // Exact request timestamps are used for custom boundaries, not rounded-hour membership.
  const rangeCharges = store.db.prepare(`SELECT task_id,json_extract(json,'$.stage') stage,json_extract(json,'$.startedAt') at,
    COUNT(*) requests,SUM(CASE WHEN json_type(json,'$.cny') IN ('integer','real') THEN 0 ELSE 1 END) missing,COALESCE(SUM(json_extract(json,'$.cny')),0) cost,0 modelMs
    FROM auto_usage WHERE json_type(json,'$.startedAt') IN ('integer','real') AND json_extract(json,'$.startedAt')>=? AND json_extract(json,'$.startedAt')<? GROUP BY task_id,stage,at`).all(query.start, Math.min(query.end, now + 1)) as Charge[];
  const byCharge = new Map<string, Charge[]>();
  for (const row of charges) if (selectedIds.has(row.task_id)) { const list = byCharge.get(row.task_id) || []; list.push(row); byCharge.set(row.task_id, list); }

  const consumptionStages = stages(), buckets: AnalyticsBucket[] = [], step = query.granularity === 'hour' ? hour : day;
  for (let start = query.start; start < query.end;) { const end = Math.min(query.end, (Math.floor((start + offset) / step) + 1) * step - offset); buckets.push({ start, end, stages: stages(), queueMs: 0, efficiency: summary() }); start = end; }
  const consumption: DashboardAnalytics['consumption'] = { knownCny: 0, recordedMs: 0, queueMs: 0, requests: 0, missingCosts: 0, unplacedRequests: 0, stages: consumptionStages, executionMs: null, timing: { tasks: 0, complete: 0, incomplete: 0 } };
  const periodTasks = new Set<string>(), recordedTasks = new Set<string>();
  for (const row of charges) if (selectedIds.has(row.task_id) && row.at === null) consumption.unplacedRequests += Number(row.requests);
  for (const row of rangeCharges) {
    const task = byId.get(row.task_id); if (!task || !selectedIds.has(row.task_id)) continue;
    const name = stageName(row.stage, task), stage = name === 'queue' ? 'other' : name;
    const bucket = buckets.find(item => inside(row.at!, item.start, item.end)); if (!bucket) continue;
    periodTasks.add(task.id);
    for (const list of [consumptionStages, bucket.stages]) { const item = list.find(item => item.stage === stage)!; item.knownCny += Number(row.cost); item.requests += Number(row.requests); item.missingCosts += Number(row.missing); }
    consumption.knownCny += Number(row.cost); consumption.requests += Number(row.requests); consumption.missingCosts += Number(row.missing);
  }
  for (const own of pieces.values()) for (const piece of own) for (const bucket of buckets) {
    const duration = Math.max(0, Math.min(piece.end, bucket.end) - Math.max(piece.start, bucket.start)); if (!duration) continue;
    if (piece.stage === 'queue') { bucket.queueMs += duration; consumption.queueMs += duration; }
    else { periodTasks.add(piece.taskId); recordedTasks.add(piece.taskId); bucket.stages.find(item => item.stage === piece.stage)!.recordedMs += duration; consumptionStages.find(item => item.stage === piece.stage)!.recordedMs += duration; consumption.recordedMs += duration; }
  }
  // Older requests may cross into the range even when their starts (and billing) belong to an earlier bucket.
  const crossing = query.start < Math.min(query.end,now) ? store.db.prepare(`SELECT DISTINCT task_id FROM auto_usage
    WHERE json_type(json,'$.startedAt') IN ('integer','real') AND json_type(json,'$.endedAt') IN ('integer','real')
    AND json_extract(json,'$.startedAt')<? AND json_extract(json,'$.endedAt')>?
    AND json_extract(json,'$.endedAt')>=json_extract(json,'$.startedAt') AND json_extract(json,'$.status')<>'unknown'`).all(Math.min(query.end,now),query.start) : [];
  for (const row of crossing) if (selectedIds.has(row.task_id)) periodTasks.add(row.task_id);
  for (const task of selectedTasks) if (inside(task.createdAt,query.start,Math.min(query.end,now)) && ['completed','failed','interrupted','running','cancelling','following-up'].includes(task.status)) periodTasks.add(task.id);
  consumption.timing.tasks = periodTasks.size;
  consumption.timing.complete = [...periodTasks].filter(id => complete.has(id) && recordedTasks.has(id)).length;
  consumption.timing.incomplete = consumption.timing.tasks - consumption.timing.complete;
  consumption.executionMs = consumption.timing.incomplete ? null : consumption.recordedMs;
  const candidates = query.unit === 'workflow' ? [...groups].map(([id, tasks]) => ({ id, tasks })) : selectedTasks.filter(task => task.kind === query.unit).map(task => ({ id: task.id, tasks: [task] }));
  const runs: AnalyticsRun[] = [];
  for (const { id, tasks } of candidates) {
    const task = byId.get(id)!; if (!accepted(task)) continue;
    const own = tasks.flatMap(task => pieces.get(task.id) || []), ownSpans = tasks.flatMap(task => spans.get(task.id) || []), ownCharges = tasks.flatMap(task => byCharge.get(task.id) || []);
    const timingComplete = tasks.every(task => complete.has(task.id));
    const execution = own.filter(piece => piece.stage !== 'queue');
    const mainSpans = ownSpans.filter(span => !['queue', 'experience'].includes(span.stage));
    const startedAt = query.unit === 'workflow' ? task.createdAt : timingComplete && mainSpans.length ? Math.min(...mainSpans.map(span => span.started_at)) : null;
    const stillRunning = tasks.some(task => !task.stopped && ['running', 'following-up', 'cancelling'].includes(task.status));
    const queued = !stillRunning && tasks.some(task => task.status === 'queued' || task.status === 'following-up' && ['queued', 'waiting'].includes(task.followup?.state || ''));
    const optimizationPending = tasks.some(task => task.optimization && !['completed', 'stopped'].includes(task.optimization.state));
    const status: AnalyticsRun['status'] = stillRunning ? 'active' : queued ? 'queued' : tasks.some(task => task.status === 'failed') ? 'failed' : tasks.some(task => task.status === 'interrupted') ? 'interrupted' : tasks.some(task => task.status === 'cancelled') ? 'cancelled' : !optimizationPending && tasks.every(task => task.status === 'completed') ? 'completed' : 'pending';
    const endedAt = tasks.every(task => task.stopped) && !stillRunning && !queued && ownSpans.length ? Math.max(...ownSpans.map(span => span.ended_at ?? span.heartbeat)) : null;
    const runStages = stages();
    for (const piece of execution) runStages.find(item => item.stage === piece.stage)!.recordedMs += piece.end - piece.start;
    for (const row of ownCharges) { const name = stageName(row.stage, byId.get(row.task_id)!); const item = runStages.find(item => item.stage === (name === 'queue' ? 'other' : name))!; item.knownCny += Number(row.cost); item.requests += Number(row.requests); item.missingCosts += Number(row.missing); }
    const recordedMs = execution.reduce((sum, piece) => sum + piece.end - piece.start, 0);
    const closed = tasks.every(task => task.stopped) && !stillRunning && !queued && ownSpans.every(span => span.ended_at !== null);
    const review = tasks.filter(task => task.kind === 'evaluation' && task.status === 'completed' && task.report && task.scope === byId.get(id)!.scope).sort((a,b) => b.createdAt-a.createdAt)[0];
    const reportMatches = review && (!task.siteRevision || review.siteRevision === task.siteRevision || query.unit === 'workflow' && task.optimization?.reportId === review.id);
    runs.push({ id, taskId: task.id, rootId: root(task), name: task.resourceName, kind: query.unit, scope: task.scope, startedAt, createdAt: task.createdAt, endedAt, status,
      knownCny: runStages.reduce((sum, item) => sum + item.knownCny, 0), missingCosts: runStages.reduce((sum, item) => sum + item.missingCosts, 0), requests: ownCharges.reduce((sum, row) => sum + Number(row.requests), 0),
      recordedMs, durationMs: timingComplete && closed && execution.length ? recordedMs : null,
      elapsedMs: timingComplete && closed && endedAt !== null && startedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      queueMs: own.filter(piece => piece.stage === 'queue').reduce((sum, piece) => sum + piece.end - piece.start, 0),
      modelMs: ownCharges.reduce((sum, row) => sum + Number(row.modelMs), 0), timingComplete,
      repairs: tasks.filter(task => task.kind === 'generation' && (task.optimizationRound || 0) > 0).length,
      quality: reportMatches ? review.report!.quality : null, stages: runStages,
    });
  }
  const select = (start: number, end: number) => runs.filter(run => inside(run.startedAt ?? run.createdAt, start, end));
  const selected = select(query.start, query.end).sort((a,b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt) || a.id.localeCompare(b.id));
  for (const bucket of buckets) bucket.efficiency = summarize(selected.filter(run => run.startedAt !== null && inside(run.startedAt, bucket.start, bucket.end)));
  const points = selected.filter(run => run.status === 'completed' && run.startedAt !== null && (run.durationMs !== null || run.requests > 0 && !run.missingCosts));
  const pages = Math.max(1, Math.ceil(selected.length / 20)), page = Math.min(query.page, pages);
  return {
    generatedAt: now, timezone: 'Asia/Shanghai', range: { start: query.start, end: query.end, granularity: query.granularity },
    overview: {
      resources: Number(store.db.prepare('SELECT COUNT(*) n FROM auto_resources').get().n), sites: Number(store.db.prepare('SELECT COUNT(*) n FROM auto_sites').get().n), workflows: groups.size,
      running: all.filter(task => !task.stopped && ['running', 'following-up', 'cancelling'].includes(task.status)).length, queued: all.filter(task => task.status === 'queued').length,
    }, consumption, efficiency: summarize(selected),
    comparison: query.compareStart !== undefined && query.compareEnd !== undefined ? { start: query.compareStart, end: query.compareEnd, efficiency: summarize(select(query.compareStart, query.compareEnd)) } : null,
    buckets, points: points.slice(0, 1000).map(run => ({ id: run.id, name: run.name, startedAt: run.startedAt!, durationMs: run.durationMs, knownCny: run.knownCny, costComplete: run.requests > 0 && !run.missingCosts })), pointTotal: points.length,
    runs: { items: selected.slice((page - 1) * 20, page * 20), total: selected.length, page, pages },
  };
}

export function registerDashboardAnalyticsApi(app: FastifyInstance, store: AutomationStore) {
  const query = z.object({ start: z.coerce.number().int().min(0), end: z.coerce.number().int().min(0), granularity: z.enum(['hour', 'day']).default('day'),
    scenario: z.enum(['all', ...Object.keys(scenarios)] as ['all', ...Array<keyof typeof scenarios>]).default('site-template'), scope: z.enum(['all', 'homepage', 'site']).default('all'), unit: z.enum(['workflow', 'generation', 'evaluation']).default('evaluation'),
    page: z.coerce.number().int().min(1).max(100000).default(1), compareStart: z.coerce.number().int().min(0).optional(), compareEnd: z.coerce.number().int().min(0).optional(),
  }).superRefine((value, context) => {
    const limit = value.granularity === 'hour' ? 31 * day : 93 * day;
    if (value.end <= value.start || value.end - value.start > limit) context.addIssue({ code: 'custom', message: value.granularity === 'hour' ? '按小时最多查询 31 天，结束时间须晚于开始时间' : '最多查询 93 天，结束时间须晚于开始时间' });
    if ((value.compareStart === undefined) !== (value.compareEnd === undefined) || value.compareStart !== undefined && (value.compareEnd! <= value.compareStart || value.compareEnd! - value.compareStart > 93 * day)) context.addIssue({ code: 'custom', message: '请填写完整且有效的对比时段（最多 93 天）' });
  });
  app.get('/api/automation/dashboard/analytics', request => dashboardAnalytics(store, query.parse(request.query)));
}
