<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowUpRight, ExternalLink, Search, RefreshCw, Clock3, Play, FileText, ChevronLeft, ChevronRight, Sparkles, ClipboardCheck, PanelTop, Layers } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import EnvironmentName from '../../components/EnvironmentName.vue';
import TaskDetail from './TaskDetail.vue';
import SiteDeliveryList from './SiteDeliveryList.vue';
import { api, formatDate, platform } from '../../api';
import { createTaskEvaluationLoader, scoreTone, siteLink, taskEvaluation } from '../../lib/task-list';
import { refresh, workspace, scopeName } from './common';
import { taskStatusNames, scenarios, optimizationStateNames } from '../../../../shared/automation';
import { dispositionFilterOptions, dispositionStateNames, matchesDispositionFilter, type DispositionFilter } from '../../../../shared/dispositions';
import type { TaskSnapshot, TaskSummary } from '../../../../shared/task-presentation';
import { taskExecuting } from '../../../../shared/task-presentation';
const props = defineProps<{ id?: string; reports?: boolean }>();
const query = ref(''), filter = ref(''), kind = ref(''), disposition = ref<DispositionFilter>('active'), page = ref(1);
const siteFilter = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
function needsAttention(t:TaskSummary) { return ['pending','interrupted','failed'].includes(t.status)||t.optimization?.state==='stopped'||Boolean(t.delivery&&['uncertain','failed'].includes(t.delivery.status)); }
function initialGeneration(t:TaskSummary) { return t.optimization?.state==='waiting-evaluation'&&t.optimization.activeTaskId===t.id; }
function displayStatus(t:TaskSummary) { return t.optimization&&!initialGeneration(t)?(t.optimization.state==='stopped'?'interrupted':t.optimization.state==='completed'?'completed':'running'):t.status; }
function displayStatusName(t:TaskSummary) { return t.optimization&&!initialGeneration(t)?optimizationStateNames[t.optimization.state]:taskStatusNames[t.status]; }
const list = computed(() => workspace.tasks.filter(t =>
  matchesDispositionFilter(t.disposition, disposition.value) &&
  (props.reports || !t.optimizationRootId) &&
  (!props.reports || t.kind === 'evaluation') && (!siteFilter || t.generatedSiteId === siteFilter) &&
  (!kind.value || t.kind === kind.value) && (!filter.value || (filter.value === 'attention' ? needsAttention(t) : displayStatus(t) === filter.value)) &&
  (!query.value || [t.resourceName, t.siteUrl, t.id].join(' ').toLowerCase().includes(query.value.toLowerCase()))));
const pages = computed(() => Math.max(1, Math.ceil(list.value.length / 20)));
const visibleTasks = computed(() => list.value.slice((page.value - 1) * 20, page.value * 20));
const sourceTasks = computed(() => new Map(workspace.tasks.map(task => [task.id, task])));
const summaryResults = shallowRef(new Map<string, TaskSummary>());
const taskById = computed(() => {
  const tasks = new Map(sourceTasks.value);
  for (const [id, result] of summaryResults.value) {
    const source = tasks.get(id);
    if (source && !source.report && source.updatedAt === result.updatedAt) tasks.set(id, result);
  }
  return tasks;
});
const rows = computed(() => visibleTasks.value.map(task => ({ ...task, evaluation: taskEvaluation(task.kind === 'evaluation' ? taskById.value.get(task.id)! : task, taskById.value) })));
const loadEvaluation = createTaskEvaluationLoader(id => api<TaskSnapshot>(`/automation/tasks/${id}/summary`));
let disposed = false;
watch(() => (props.reports ? visibleTasks.value : []).map(task => task.kind === 'evaluation' ? task : sourceTasks.value.get(task.evaluationTaskId || '')).filter((task): task is TaskSummary => !!task && task.status === 'completed' && !task.report), async candidates => {
  const unique = [...new Map(candidates.map(task => [task.id, task])).values()];
  const results = await Promise.all(unique.map(loadEvaluation));
  if (disposed) return;
  const next = new Map(summaryResults.value);
  let changed = false;
  for (const result of results) {
    if (result && sourceTasks.value.get(result.id)?.updatedAt === result.updatedAt && next.get(result.id) !== result) { next.set(result.id, result); changed = true; }
  }
  if (changed) summaryResults.value = next;
}, { immediate: true });
const active = computed(() => workspace.tasks.filter(taskExecuting));
const queued = computed(() => workspace.queue?.queued ?? workspace.tasks.filter(t => t.status === 'queued').length);
const pending = computed(() => workspace.tasks.filter(t => !t.disposition&&!t.optimizationRootId&&needsAttention(t)).length);
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const qualityNames = { passed: '达到标准', failed: '需要改进', unverified: '有待验证' };
const toneNames = { good: '达到分数标准', warning: '未达到分数标准', low: '分数较低', unknown: '未验证' };
function threshold(task: TaskSummary) { return (task.optimization || taskById.value.get(task.optimizationRootId || '')?.optimization)?.policy.targetScore ?? platform.settings?.threshold ?? 80; }
function scoreLabel(task: TaskSummary, score: { viewport: string; value: number | null }) {
  return `${viewportNames[score.viewport] || score.viewport} ${score.value ?? '未验证'}${score.value === null ? '' : ` 分，${toneNames[scoreTone(score.value, threshold(task))]}（标准 ${threshold(task)} 分）`}`;
}
let timer: ReturnType<typeof setInterval> | undefined;
function load() { return refresh(); }
onMounted(() => { if (!props.id && props.reports) { void load(); timer = setInterval(() => void load(), 4000); } });
onUnmounted(() => { disposed = true; if (timer) clearInterval(timer); });
watch([query, filter, kind, disposition], () => page.value = 1);
watch(pages, value => page.value = Math.min(page.value, value));
</script>
<template><TaskDetail v-if="id" :key="id" :id="id" /><SiteDeliveryList v-else-if="!reports" /><template v-else><header class="page-header"><div><h1>{{reports?'评测报告':'任务中心'}}</h1></div><div class="toolbar-actions"><a v-if="reports" class="button secondary" href="#/legacy-evaluations"><FileText :size="16" />历史评测记录</a><a class="button primary" href="#/resources"><Play :size="16" />{{reports?'选择站点评测':'从资源创建任务'}}</a></div></header>
<p v-if="!workspace.settings.enabled" class="alert info"><Clock3 :size="17" /><span>自动执行已暂停，队列中的任务会保留。</span><a href="#/settings">前往设置<ArrowUpRight :size="15" /></a></p>
<div v-if="!reports" class="queue-summary"><div><span>生成执行</span><strong>{{workspace.queue?.generation ?? active.filter(t=>t.kind==='generation').length}}<small>/ {{workspace.settings.generationConcurrency}}</small></strong></div><div><span>评测执行</span><strong>{{workspace.queue?.evaluation ?? active.filter(t=>t.kind==='evaluation').length}}<small>/ {{workspace.settings.evaluationConcurrency}}</small></strong></div><div><span>排队中</span><strong>{{queued}}</strong></div><button :class="{highlight:pending}" @click="filter=filter==='attention'?'':'attention'"><span>需要处理</span><strong>{{pending}}</strong></button></div>
<section class="panel"><div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" :placeholder="reports?'搜索资源、站点或报告':'搜索资源、站点或任务'" aria-label="搜索任务" /></label><div class="toolbar-actions"><BaseSelect v-model="disposition" size="small" aria-label="归档状态" :options="dispositionFilterOptions" /><BaseSelect v-if="!reports" v-model="kind" size="small" aria-label="任务类型" :options="[{ value: '', label: '全部类型' }, { value: 'generation', label: '生成' }, { value: 'evaluation', label: '评测' }]" /><BaseSelect v-model="filter" size="small" aria-label="任务状态" :options="[{ value: '', label: '全部状态' }, { value: 'attention', label: '需要处理' }, ...Object.entries(taskStatusNames).map(([key, name]) => ({ value: key, label: (name) }))]" /><button class="icon-button" aria-label="刷新任务" @click="load"><RefreshCw :size="17" /></button></div></div><p v-if="workspace.error" class="alert error">{{workspace.error}}</p>
<div class="table-scroll"><table class="task-table"><thead><tr><th>资源 / 生成站</th><th>环境</th><th v-if="!reports">类型</th><th>范围</th><th>执行状态</th><th>{{ reports ? '质量 / 评分' : '评测分数' }}</th><th>用量费用</th><th>创建时间</th><th /></tr></thead><tbody><tr v-for="task in rows" :key="task.id"><td><a class="task-title" :href="`#/tasks/${task.id}${reports?'?tab=report':''}`">{{task.resourceName}}</a><span v-if="task.disposition" class="table-subtitle">{{dispositionStateNames[task.disposition.state]}}{{task.disposition.note?` · ${task.disposition.note}`:''}}</span><a v-if="siteLink(task.siteUrl)" class="table-site-link" :href="siteLink(task.siteUrl)" target="_blank" rel="noopener noreferrer" :aria-label="'在新标签页打开生成站：' + task.siteUrl" :title="task.siteUrl"><span>{{task.siteUrl}}</span><ExternalLink :size="12" aria-hidden="true" /></a><span v-else class="table-subtitle">{{task.siteUrl||scenarios[task.scenario]}}</span></td><td class="environment-cell"><EnvironmentName :environment-id="task.environmentId" /></td><td v-if="!reports"><span class="task-enum" :class="'kind-' + task.kind"><Sparkles v-if="task.kind === 'generation'" :size="13" aria-hidden="true" /><ClipboardCheck v-else :size="13" aria-hidden="true" />{{task.kind==='generation'?'生成':'评测'}}</span></td><td><span class="task-enum" :class="'scope-' + task.scope"><PanelTop v-if="task.scope === 'homepage'" :size="13" aria-hidden="true" /><Layers v-else :size="13" aria-hidden="true" />{{scopeName(task.scope)}}</span></td><td><span class="status-badge" :class="displayStatus(task)"><i />{{displayStatusName(task)}}</span><span v-if="task.optimization" class="table-subtitle">修复 {{task.optimization.round}} / {{task.optimization.policy.maxRounds}}</span><span v-if="task.delivery" class="table-subtitle">交付：{{({queued:'排队中',running:'迁移中',uncertain:'待核查',verifying:'核验中',completed:'核验完成',failed:'未完成'})[task.delivery.status]}}</span></td><td class="task-scores-cell"><template v-if="task.evaluation?.report"><span v-if="reports" class="task-quality" :class="task.evaluation.report.quality==='passed'?'success-text':task.evaluation.report.quality==='failed'?'warning-text':'text-muted'">{{qualityNames[task.evaluation.report.quality]}}</span><a v-if="task.evaluation.report.scores.length" class="task-score-link" :href="`#/tasks/${task.evaluation.id}?tab=report`" :aria-label="'查看' + task.resourceName + '的评测报告'"><span v-for="score in task.evaluation.report.scores" :key="score.viewport" class="task-score" :class="scoreTone(score.value, threshold(task))" :title="scoreLabel(task, score)" :aria-label="scoreLabel(task, score)"><span>{{viewportNames[score.viewport] || score.viewport}}</span><strong>{{score.value ?? '—'}}</strong></span></a><a v-else class="text-muted" :href="`#/tasks/${task.evaluation.id}?tab=report`">未验证</a><span v-if="task.evaluation.reportCurrent === false" class="table-subtitle" title="该任务的评测结果；同一站点后来已有更新">历史结果</span></template><span v-else class="text-muted">{{reports ? '报告尚未生成' : '待评测'}}</span></td><td>{{task.usage?.priced?`¥ ${task.usage.knownCny.toFixed(4)}`:'—'}}</td><td class="date-cell">{{formatDate(task.createdAt)}}</td><td><a class="text-action" :href="`#/tasks/${task.id}${reports?'?tab=report':''}`">{{reports?'查看报告':'详情'}}<ArrowUpRight :size="14" /></a></td></tr></tbody></table></div><div v-if="!rows.length" class="empty-state"><FileText v-if="reports" :size="30" /><Clock3 v-else :size="30" /><h2>{{reports?'暂无评测报告':'暂无任务'}}</h2><p>{{reports?'从资源的生成站发起独立评测':'先在资源库中选择一个或多个资源'}}</p></div><footer class="table-footer"><span>共 {{list.length}} 项</span><div class="pagination"><button class="icon-button" :disabled="page<=1" aria-label="上一页" @click="page--"><ChevronLeft :size="17" /></button><span>{{page}} / {{pages}}</span><button class="icon-button" :disabled="page>=pages" aria-label="下一页" @click="page++"><ChevronRight :size="17" /></button></div></footer></section></template></template>


<style scoped>
.environment-cell{min-width:100px;max-width:180px;overflow-wrap:anywhere}
.task-enum{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:5px;font-size:12px;font-weight:500;line-height:1.4;white-space:nowrap}
.task-enum>svg{flex:none}
.kind-generation{color:#3b61bc;background:#edf2ff}
.kind-evaluation{color:#7551ac;background:#f4effb}
.scope-homepage{color:#596579;background:#f0f2f6}
.scope-site{color:#247681;background:#eaf6f7}
.table-site-link{display:flex;align-items:center;gap:5px;width:fit-content;max-width:360px;margin-top:5px;color:var(--blue);font-size:11px;line-height:1.6}
.table-site-link>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.table-site-link>svg{flex:none;opacity:.75}
.table-site-link:hover>span{text-decoration:underline;text-underline-offset:3px}
.task-scores-cell{min-width:155px}
.task-quality{display:block;margin-bottom:7px;font-size:12px}
.task-score-link{display:inline-flex;gap:6px;align-items:center;border-radius:6px}
.task-score{display:inline-flex;align-items:baseline;gap:6px;padding:4px 7px;border-radius:5px;line-height:1.3;font-variant-numeric:tabular-nums;background:var(--field);color:var(--muted)}
.task-score>span{font-size:10px}
.task-score>strong{font-size:15px;font-weight:600}
.task-score.good{color:#16765d;background:#eaf7f1}
.task-score.warning{color:#a65e0a;background:#fff4e5}
.task-score.low{color:#b53b4b;background:#fff0f2}
.task-score.unknown{color:var(--muted);background:var(--field)}
.task-score-link:hover .task-score{box-shadow:inset 0 0 0 1px currentColor}
@media(max-width:1100px){.table-site-link{max-width:270px}}
</style>
