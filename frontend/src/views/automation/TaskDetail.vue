<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowLeft, ArrowUpRight, ExternalLink, Ban, Play, FileText, Send, X, LoaderCircle, MoreHorizontal, Check, Columns2, Download, Link, RotateCcw, Trash2, Upload, Wrench, ChevronDown, ChevronRight } from '@lucide/vue';
import { scenarios, taskStatusNames, optimizationStateNames, supportsAutomaticOptimization, type AutomationTask, type AutomationSettings, type Resource, type GeneratedSite } from '../../../../shared/automation';
import { dispositionStateNames, type DispositionState } from '../../../../shared/dispositions';
import { initialTaskTab, taskRecoveryAction, type TaskSnapshot, type TaskTab } from '../../../../shared/task-presentation';
import { deliveredSiteUrl } from '../../../../shared/site-delivery';
import type { TemplateWorkflowResponse } from '../../../../shared/template-workflow';
import { api, formatDate, go, message } from '../../api';
import { notify } from '../../lib/notifications';
import { siteLink } from '../../lib/task-list';
import { siteReportLink } from '../../lib/site-reports';
import { fetchTaskTemplateWorkflow } from '../../lib/template-workflow-client';
import TaskUsage from '../../components/TaskUsage.vue';
import EnvironmentName from '../../components/EnvironmentName.vue';
import LiveSiteComparisonDialog from '../../components/LiveSiteComparisonDialog.vue';
import SiteTaskUsage from './SiteTaskUsage.vue';
import SiteTaskHistory from './SiteTaskHistory.vue';
import TaskExecution from './TaskExecution.vue';
import TaskRecoveryActions from './TaskRecoveryActions.vue';
import TaskInput from './TaskInput.vue';
import TaskReport from './TaskReport.vue';
import SiteReports from './SiteReports.vue';
import TaskDeliverySection from './TaskDeliverySection.vue';
import TaskCollection from './TaskCollection.vue';
import TaskOverviewHero from './TaskOverviewHero.vue';
import TaskWorkflowGraph from './TaskWorkflowGraph.vue';
import TemplateWorkflowOverview from './TemplateWorkflowOverview.vue';
import TemplateEvaluationView from './TemplateEvaluationView.vue';
import CreateTaskDialog from './CreateTaskDialog.vue';
import DiagnosticExportDialog from './DiagnosticExportDialog.vue';
import SiteDomainDialog from './SiteDomainDialog.vue';
import DispositionDialog from './DispositionDialog.vue';
import TaskSupplementDialog from './TaskSupplementDialog.vue';
import { useTaskSection } from './use-task-section';
import { scopeName, workspace } from './common';

const props = defineProps<{ id: string }>();
const initialQuery = window.location.hash.split('?')[1] || '';
const tab = ref<TaskTab>(initialTaskTab(initialQuery));
const devSubTab = ref<'execution' | 'input' | 'governance'>(tab.value === 'input' ? 'input' : 'execution');
const historyOpen = ref(false);
const reportSubView = ref<'template' | 'history'>(
  new URLSearchParams(initialQuery).get('view') === 'history' ? 'history' : 'template',
);

const { data, loading, error, load } = useTaskSection<TaskSnapshot>(() => `/automation/tasks/${props.id}/summary`);
const task = computed(() => data.value?.task);
const evaluation = computed(() => data.value?.evaluation);
const optimizationActive = computed(() => task.value?.optimization && !['completed', 'stopped'].includes(task.value.optimization.state));
const current = computed(() => task.value?.optimization?.state === 'planning' ? task.value : data.value?.active || (task.value?.kind === 'generation' && task.value.status === 'completed' && evaluation.value ? evaluation.value : task.value));
const report = computed(() => task.value?.optimization && !data.value?.currentReportId ? null : task.value?.report || evaluation.value?.report);
const siteRefresh = ref(0);
const workflowFallback = ref(false);
watch(() => props.id, () => { workflowFallback.value = false; historyOpen.value = false; });

// New AI Site template workflow state (loaded only for site-template tasks)
const templateWorkflow = shallowRef<TemplateWorkflowResponse | null>(null);
const templateLoading = ref(false);
const templateError = ref('');
const templateUnavailable = ref('');
const baselineFocus = ref<{ pagePath: string; viewId?: string; nonce: number } | null>(null);
let templateAbort: AbortController | undefined;
let templateSeq = 0;
let focusNonce = 0;

const isNewTemplateWorkflow = computed(
  () => Boolean(task.value?.scenario === 'site-template' && templateWorkflow.value?.supported),
);

async function loadTemplateWorkflow() {
  if (!task.value || task.value.scenario !== 'site-template') {
    templateAbort?.abort();
    templateWorkflow.value = null;
    templateLoading.value = false;
    templateError.value = '';
    templateUnavailable.value = '';
    return;
  }
  const seq = ++templateSeq;
  templateAbort?.abort();
  templateAbort = new AbortController();
  templateLoading.value = true;
  templateError.value = '';
  try {
    const result = await fetchTaskTemplateWorkflow(task.value.id, templateAbort.signal);
    if (seq !== templateSeq) return;
    if (result.status === 'unavailable') {
      templateUnavailable.value = result.reason;
      templateWorkflow.value = null;
    } else {
      templateUnavailable.value = '';
      templateWorkflow.value = result.data;
    }
  } catch (reason) {
    if (seq === templateSeq && !templateAbort.signal.aborted) {
      templateError.value = message(reason);
    }
  } finally {
    if (seq === templateSeq) templateLoading.value = false;
  }
}

const busy = ref(false), actionError = ref(''), followKind = ref<'generation' | 'evaluation'>('generation'), requirements = ref('');
const optimizeDialog = ref<HTMLDialogElement>(), optimizeScore = ref(85), optimizeRounds = ref(3), optimizeCost = ref<number | string>('');
const canEnableOptimization = computed(() => task.value?.kind === 'generation' && supportsAutomaticOptimization(task.value.scenario) && !task.value.optimization && task.value.status === 'completed' && evaluation.value?.status === 'completed' && canCreateRound.value);
async function openOptimization() { more.value?.removeAttribute('open'); if (busy.value) return; busy.value = true; actionError.value = ''; try { const settings = await api<AutomationSettings>('/automation/settings'); optimizeScore.value = settings.optimization?.targetScore ?? 85; optimizeRounds.value = settings.optimization?.maxRounds ?? 3; optimizeCost.value = settings.optimization?.maxCostCny ?? ''; optimizeDialog.value?.showModal(); } catch (reason) { actionError.value = message(reason); } finally { busy.value = false; } }
async function enableOptimization() { if (!task.value || busy.value) return; busy.value = true; actionError.value = ''; try { await api(`/automation/tasks/${task.value.id}/optimize`, { method: 'POST', body: JSON.stringify({ targetScore: optimizeScore.value, maxRounds: optimizeRounds.value, maxCostCny: optimizeCost.value === '' ? null : Number(optimizeCost.value) }) }); optimizeDialog.value?.close(); notify.success('已开启自动优化'); await load(); } catch (reason) { actionError.value = message(reason); } finally { busy.value = false; } }
const followDialog = ref<HTMLDialogElement>(), more = ref<HTMLDetailsElement>();
const diagnosticDialog = ref<InstanceType<typeof DiagnosticExportDialog>>();
const execution = ref<InstanceType<typeof TaskExecution>>();
const domainDialog = ref<InstanceType<typeof SiteDomainDialog>>();
const dispositionDialog = ref<InstanceType<typeof DispositionDialog>>();
const liveComparisonDialog = ref<InstanceType<typeof LiveSiteComparisonDialog>>();
const supplementDialog = ref<InstanceType<typeof TaskSupplementDialog>>();
const canCompareLive = computed(() => data.value?.canCompareLive ?? Boolean(task.value && (task.value.siteUrl || ['site-template', 'migration', 'upgrade'].includes(task.value.scenario))));
const defaultComparisonReportId = computed(() => data.value?.currentReportId || (task.value?.kind === 'evaluation' ? task.value.id : evaluation.value?.id) || null);
const disposition = computed(() => data.value?.disposition);
const resourceDisposition = computed(() => data.value?.resourceDisposition);
const deliveryUnitId = computed(() => task.value ? (task.value.generatedSiteId || task.value.id) : '');
function openDomain() { more.value?.removeAttribute('open'); if (task.value?.generatedSiteId) void domainDialog.value?.open(task.value.generatedSiteId); }
function openDiagnostic() { more.value?.removeAttribute('open'); void diagnosticDialog.value?.open(); }
function openDisposition(nextState: DispositionState) {
  more.value?.removeAttribute('open');
  if (!task.value || !deliveryUnitId.value) return;
  dispositionDialog.value?.open({
    kind: 'delivery',
    ids: [deliveryUnitId.value],
    state: nextState,
    label: task.value.resourceName,
    canCascadeResources: nextState === 'completed'
      ? resourceDisposition.value?.state !== 'completed'
      : nextState === 'active'
        ? Boolean(resourceDisposition.value)
        : false,
    defaultCascadeResources: nextState === 'completed' || (disposition.value?.state === 'completed' && resourceDisposition.value?.state === 'completed'),
  });
}
async function onDispositionSaved() { await load(); siteRefresh.value++; }
const canSupplementCurrent = computed(() => !disposition.value && Boolean(current.value && current.value.kind === 'generation' && current.value.stopped && ['interrupted', 'pending', 'failed', 'cancelled'].includes(current.value.status)));
async function onSupplementApplied() { await load(); await execution.value?.refresh(); }
const canRecover = computed(() => !disposition.value && ['resume','adjust-site-names'].includes(taskRecoveryAction(current.value) || ''));
const workflowActive = computed(() => data.value?.workflowActive);
const workflowRecoveryBlocked = computed(() => Boolean(taskRecoveryAction(current.value)) && Boolean(workflowActive.value));
const canForceResume = computed(() => !disposition.value && Boolean(taskRecoveryAction(current.value)) && (Boolean(workflowActive.value) || /同工作流仍有活动执行|仍有未停止的执行|已确认停止/.test(actionError.value)));
const canCancel = computed(() => current.value && (!current.value.stopped || ['queued', 'following-up'].includes(current.value.status)) && !['completed', 'failed', 'cancelled', 'interrupted'].includes(current.value.status));
const canCreateRound = computed(() => !disposition.value && !optimizationActive.value && (!data.value?.active || data.value.active.stopped && !['queued', 'running', 'following-up', 'cancelling'].includes(data.value.active.status)) && task.value?.stopped && task.value.generatedSiteId && !['queued', 'running', 'following-up', 'cancelling'].includes(task.value.status) && (!evaluation.value || evaluation.value.stopped && !['queued', 'running', 'following-up', 'cancelling'].includes(evaluation.value.status)));
const canArchiveComplete = computed(() => disposition.value?.state !== 'completed' && !optimizationActive.value && !canCancel.value && Boolean(task.value?.stopped && (!evaluation.value || evaluation.value.stopped) && (!data.value?.active || data.value.active.stopped)));
const canArchiveDiscard = computed(() => disposition.value?.state !== 'discarded' && Boolean(task.value && (task.value.stopped || task.value.status === 'queued') && current.value?.stopped !== false && !['running', 'cancelling', 'following-up'].includes(current.value?.status || '')));
const canContinue = computed(() => canCreateRound.value && !canRecover.value && task.value?.kind === 'generation' && task.value.status === 'completed');
const continueDialog = ref<InstanceType<typeof CreateTaskDialog>>();
const continueResources = ref<Resource[]>([]), continueSite = ref<GeneratedSite>();
async function openContinuation() {
  if (!task.value || !canContinue.value || busy.value) return;
  const source = task.value;
  busy.value = true; actionError.value = '';
  try {
    const [input, settings] = await Promise.all([
      api<{ resource: Resource; sites: GeneratedSite[] }>(`/automation/resources/${source.resourceId}`),
      api<AutomationSettings>('/automation/settings'),
    ]);
    if (task.value?.id !== source.id) return;
    const site = input.sites.find(item => item.id === source.generatedSiteId);
    if (!site) throw new Error('原生成站不存在，请到资源中检查站点关联');
    continueResources.value = [input.resource]; continueSite.value = site; workspace.settings = settings;
    await nextTick(); await continueDialog.value?.open({ scope: 'site' });
  } catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
type TopNavId = 'overview' | 'report' | 'usage' | 'delivery' | 'dev';
const businessTabs = computed<{ id: 'overview' | 'report' | 'usage' | 'delivery'; label: string }[]>(() => [
  { id: 'overview', label: '概览' },
  { id: 'report', label: '评测详情' },
  { id: 'usage', label: '费用与耗时' },
  ...(data.value?.deliveryEnabled ? [{ id: 'delivery' as const, label: '交付' }] : []),
]);
const topNavOrder = computed<TopNavId[]>(() => [
  ...businessTabs.value.map(item => item.id),
  'dev',
]);
const isDevTabActive = computed(() => tab.value === 'execution' || tab.value === 'input');
const deliveredUrl = computed(() => deliveredSiteUrl(data.value?.delivery));
const sourceUrl = computed(() => siteLink(task.value?.siteUrl || ''));
const primaryUrl = computed(() => deliveredUrl.value || sourceUrl.value);
const revision = computed(() => `${task.value?.updatedAt}:${evaluation.value?.updatedAt}:${data.value?.active?.updatedAt}:${data.value?.delivery?.status || ''}:${data.value?.delivery?.targetUrl || ''}`);
const reportRevision = computed(() => JSON.stringify([task.value?.optimization, task.value?.status, evaluation.value?.status, report.value]));

watch(
  [() => task.value?.id, () => task.value?.scenario, revision],
  () => void loadTemplateWorkflow(),
  { immediate: true },
);

function selectTab(value: TaskTab) {
  tab.value = value; more.value?.removeAttribute('open');
  if (value === 'execution') devSubTab.value = 'execution';
  else if (value === 'input' && devSubTab.value === 'execution') devSubTab.value = 'input';
  const nextUrl = value === 'report'
    ? (defaultComparisonReportId.value ? siteReportLink(props.id, defaultComparisonReportId.value) : `#/tasks/${props.id}?tab=report`)
    : `#/tasks/${props.id}${value === 'overview' ? '' : `?tab=${value}`}`;
  window.history.replaceState(null, '', nextUrl);
}
function selectDevTab() {
  if (isDevTabActive.value) return;
  selectTab(devSubTab.value === 'execution' ? 'execution' : 'input');
}
function selectDevSubTab(sub: 'execution' | 'input' | 'governance') {
  devSubTab.value = sub;
  const target: TaskTab = sub === 'execution' ? 'execution' : 'input';
  tab.value = target;
  more.value?.removeAttribute('open');
  window.history.replaceState(null, '', `#/tasks/${props.id}?tab=${target}`);
}
function openBaseline(target: { pagePath: string; viewId?: string }) {
  baselineFocus.value = { ...target, nonce: ++focusNonce };
  devSubTab.value = 'input';
  selectTab('input');
}
function openTemplateReport() {
  more.value?.removeAttribute('open');
  reportSubView.value = 'template';
  selectTab('report');
}
function openOverviewReport() {
  if (isNewTemplateWorkflow.value) {
    openTemplateReport();
  } else {
    selectTab('report');
  }
}
function hashChanged() {
  const q = window.location.hash.split('?')[1] || '';
  const nextTab = initialTaskTab(q);
  tab.value = nextTab;
  if (nextTab === 'execution') devSubTab.value = 'execution';
  else if (nextTab === 'input' && devSubTab.value === 'execution') devSubTab.value = 'input';
  const params = new URLSearchParams(q);
  if (params.get('report')) reportSubView.value = 'history';
}
async function tabKey(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = topNavOrder.value;
  const position = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
  const target = items[position];
  if (target === 'dev') selectDevTab();
  else selectTab(target);
  await nextTick();
  document.getElementById(`task-tab-${target}`)?.focus();
}
async function action(suffix: string, id = current.value?.id) {
  if (suffix === 'force-resume') { await forceResume(id); return; }
  if (!id || busy.value) return;
  const restarting = suffix === 'resume' && current.value?.id === id && current.value?.status === 'cancelled';
  busy.value = true; actionError.value = '';
  try { await api(`/automation/tasks/${id}/${suffix}`, { method: 'POST' }); notify.success(suffix === 'adjust-site-names' ? '已调整名称，原任务已重新加入队列' : suffix === 'resume' ? (restarting ? '已重新启动任务' : '已提交恢复请求') : ['cancel','optimization/stop'].includes(suffix) ? '已提交停止请求' : '已确认原执行停止'); await load(); if (['resume','confirm-stopped','adjust-site-names'].includes(suffix)) await execution.value?.refresh(); }
  catch (reason) { actionError.value = message(reason); void load(); }
  finally { busy.value = false; }
}
async function forceResume(id = current.value?.id) {
  if (!id || busy.value) return;
  busy.value = true; actionError.value = '';
  try { await api(`/automation/tasks/${id}/resume`, { method: 'POST', body: JSON.stringify({ force: true }) }); notify.success('已强制中断活动执行并恢复任务'); await load(); await execution.value?.refresh(); }
  catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
function followup(kind: 'generation' | 'evaluation') {
  more.value?.removeAttribute('open'); followKind.value = kind; requirements.value = kind === 'evaluation' ? '按本轮规则重新评测，独立保存证据与报告。' : ''; actionError.value = ''; followDialog.value?.showModal();
}
async function submit() {
  if (!task.value || busy.value) return;
  busy.value = true; actionError.value = '';
  try { const result = await api<{ items: AutomationTask[] }>(`/automation/tasks/${task.value.id}/followup`, { method: 'POST', body: JSON.stringify({ kind: followKind.value, requirements: requirements.value }) }); followDialog.value?.close(); go(`/tasks/${result.items[0].id}`); }
  catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
let timer: ReturnType<typeof setInterval>;
function dismissMore(event: MouseEvent) { if (more.value && !more.value.contains(event.target as Node)) more.value.removeAttribute('open'); }
function escape(event: KeyboardEvent) { if (event.key === 'Escape') more.value?.removeAttribute('open'); }
onMounted(() => {
  timer = setInterval(() => {
    if (!document.hidden && !loading.value && !busy.value) {
      void load().then(() => {
        siteRefresh.value++;
        if (
          task.value?.scenario === 'site-template' &&
          templateWorkflow.value?.supported &&
          ['analysis', 'generation', 'evaluation', 'repair'].includes(templateWorkflow.value.phase || '')
        ) {
          void loadTemplateWorkflow();
        }
      });
    }
  }, 4000);
  window.addEventListener('hashchange', hashChanged);
  document.addEventListener('click', dismissMore);
  document.addEventListener('keydown', escape);
});
onUnmounted(() => {
  templateSeq++;
  templateAbort?.abort();
  clearInterval(timer);
  window.removeEventListener('hashchange', hashChanged);
  document.removeEventListener('click', dismissMore);
  document.removeEventListener('keydown', escape);
});
</script>
<template>
  <a class="back-link" href="#/tasks"><ArrowLeft :size="16" />任务中心</a>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !task" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载任务…</p>
  <template v-if="task">
    <header class="page-header task-detail-header">
      <div class="task-heading">
        <div class="task-title-line">
          <h1>{{ task.resourceName }}</h1>
          <span class="status-badge task-header-status" :class="current?.status">{{ task.optimization && !(task.optimization.state==='waiting-evaluation'&&task.optimization.activeTaskId===task.id) ? optimizationStateNames[task.optimization.state] : current ? taskStatusNames[current.status] : taskStatusNames[task.status] }}</span>
          <span v-if="disposition" class="task-meta-tag disposition-tag" :class="disposition.state" :title="disposition.note ? `${dispositionStateNames[disposition.state]}：${disposition.note}` : dispositionStateNames[disposition.state]">已归档 · {{ dispositionStateNames[disposition.state] }}</span>
        </div>
        <div class="task-meta-line">
          <span>{{ scenarios[task.scenario] }}</span>
          <span>{{ scopeName(task.scope) }}</span>
          <EnvironmentName :environment-id="task.environmentId" />
          <span v-if="deliveredUrl" class="delivered-inline">已跨环境交付</span>
          <span v-else-if="task.autoDelivery">完成后自动交付</span>
          <a :href="`#/resources/${task.resourceId}`">关联资源<ArrowUpRight :size="12" /></a>
          <a v-if="task.parentId" :href="`#/tasks/${task.parentId}`">上一轮任务<ArrowUpRight :size="12" /></a>
        </div>
        <p v-if="disposition?.note" class="task-disposition-note">归档说明：{{ disposition.note }}</p>
      </div>
      <div class="toolbar-actions task-header-actions">
        <a v-if="primaryUrl" class="button secondary" :class="{ 'delivered-site-button': Boolean(deliveredUrl) }" :href="primaryUrl" target="_blank" rel="noopener noreferrer" :title="primaryUrl"><ExternalLink :size="16" />{{ deliveredUrl ? '打开交付站' : '打开站点' }}</a>
        <button v-if="canCompareLive" type="button" class="button secondary" @click="liveComparisonDialog?.open()"><Columns2 :size="16" />实时对比</button>
        <button v-if="disposition" class="button secondary" :disabled="busy" @click="openDisposition('active')"><RotateCcw :size="16" />移回在列</button>
        <TaskRecoveryActions v-if="!disposition || current?.stopped === false" :task="current" :busy="busy" :workflow-active="Boolean(workflowActive)" @action="action" />
        <button v-if="canSupplementCurrent && Boolean(current?.attention)" type="button" class="button secondary" :disabled="busy" @click="supplementDialog?.open()"><Upload :size="16" />补充资料 / AI 收集</button>
        <button v-if="canContinue" class="button primary" :disabled="busy" @click="openContinuation"><LoaderCircle v-if="busy" class="spin" :size="16" /><Send v-else :size="16" />{{ task.scope === 'homepage' ? '补全全站' : '继续生成' }}</button>
        <button v-if="optimizationActive" class="button secondary" :disabled="busy||current?.status==='cancelling'" @click="action('optimization/stop',task.id)"><Ban :size="16" />停止优化</button>
        <button v-else-if="canCancel" class="button secondary" :disabled="busy || current?.status === 'cancelling'" @click="action('cancel')"><Ban :size="16" />{{ current?.status === 'cancelling' ? '正在停止' : '取消任务' }}</button>
        <details ref="more" class="task-more"><summary class="button secondary"><MoreHorizontal :size="17" /><span>更多</span></summary><div class="task-action-menu"><a v-if="deliveredUrl && sourceUrl && sourceUrl !== deliveredUrl" :href="sourceUrl" target="_blank" rel="noopener noreferrer" @click="more?.removeAttribute('open')"><ExternalLink :size="15" />打开源站</a><button v-if="(report || templateWorkflow?.evaluation) && tab !== 'report'" @click="openTemplateReport"><FileText :size="15" />查看评测详情</button><template v-if="canCreateRound"><button v-if="canEnableOptimization" @click="openOptimization"><Play :size="15" />自动优化到目标</button><button v-if="!canContinue" @click="followup('generation')"><Send :size="15" />提交生成跟进</button><button :disabled="!task.siteUrl" @click="followup('evaluation')"><FileText :size="15" />{{ report || templateWorkflow?.evaluation ? '重新评测' : '发起评测' }}</button></template><button v-if="canArchiveComplete" @click="openDisposition('completed')"><Check :size="15" />标记为已完成</button><button v-if="canArchiveDiscard" @click="openDisposition('discarded')"><Trash2 :size="15" />舍弃此任务</button><button v-if="disposition" @click="openDisposition('active')"><RotateCcw :size="15" />移回在列</button><button v-if="task.generatedSiteId && !disposition" @click="openDomain"><Link :size="15" />换绑域名</button><button @click="openDiagnostic"><Download :size="15" />导出排障包</button></div></details>
      </div>
    </header>
    <DispositionDialog ref="dispositionDialog" @saved="onDispositionSaved" />
    <SiteDomainDialog ref="domainDialog" @saved="load" />
    <CreateTaskDialog ref="continueDialog" :resources="continueResources" :site="continueSite" />
    <DiagnosticExportDialog :key="task.id" ref="diagnosticDialog" :task-id="task.id" />
    <LiveSiteComparisonDialog :key="'live-' + task.id" ref="liveComparisonDialog" :task-id="task.id" :default-report-id="defaultComparisonReportId" />
    <TaskSupplementDialog v-if="current" :key="'detail-supp-' + current.id" ref="supplementDialog" :task-id="current.id" @applied="onSupplementApplied" @changed="load" />
    <p v-if="actionError && !followDialog?.open" class="alert error" role="alert">{{ actionError }}<button v-if="canForceResume" class="text-action" :disabled="busy" @click="forceResume()">强制中断并恢复</button></p>
    <p v-else-if="workflowRecoveryBlocked && workflowActive && !followDialog?.open" class="alert error" role="status">{{ workflowActive.reason }}<button v-if="canForceResume" class="text-action" :disabled="busy" @click="forceResume()">强制中断并恢复</button></p>
    <nav class="task-tabs" role="tablist" aria-label="任务详情分区">
      <button
        v-for="(item, index) in businessTabs"
        :id="`task-tab-${item.id}`"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :aria-controls="`task-panel-${item.id}`"
        :tabindex="tab === item.id ? 0 : -1"
        :class="{ selected: tab === item.id }"
        @click="selectTab(item.id)"
        @keydown="tabKey($event, index)"
      >{{ item.label }}</button>
      <span class="task-tabs-divider" aria-hidden="true" />
      <button
        id="task-tab-dev"
        role="tab"
        class="task-tab-dev"
        :aria-selected="isDevTabActive"
        :aria-controls="`task-panel-${tab}`"
        :tabindex="isDevTabActive ? 0 : -1"
        :class="{ selected: isDevTabActive }"
        @click="selectDevTab"
        @keydown="tabKey($event, businessTabs.length)"
      ><Wrench :size="14" aria-hidden="true" />研发排障</button>
    </nav>
    <div :id="`task-panel-${tab}`" role="tabpanel" :aria-labelledby="`task-tab-${isDevTabActive ? 'dev' : tab}`" class="task-tab-content">
      <template v-if="tab === 'overview'">
        <p v-if="task.scenario === 'site-template' && templateUnavailable" class="alert info" role="status">
          <span>{{ templateUnavailable }}</span>
          <button type="button" class="text-action" :disabled="templateLoading" @click="loadTemplateWorkflow">重新检查</button>
        </p>
        <p v-if="task.scenario === 'site-template' && templateError" class="alert error" role="alert">
          <span>{{ templateError }}</span>
          <button type="button" class="text-action" @click="loadTemplateWorkflow">重试</button>
        </p>
        <TaskOverviewHero
          :task="task"
          :current="current"
          :evaluation="evaluation"
          :site-id="task.generatedSiteId"
          :delivery="data?.delivery"
          :report="report"
          :revision="revision + ':' + siteRefresh"
          :template-workflow="templateWorkflow"
          @select-tab="selectTab"
          @open-report="openOverviewReport"
          @open-baseline="openBaseline"
        />
        <TaskWorkflowGraph
          v-if="!workflowFallback"
          :task-id="task.id"
          :revision="revision"
          :created-at="task.createdAt"
          :busy="busy"
          :can-supplement="canSupplementCurrent"
          :workflow-active="Boolean(workflowActive)"
          :recovery-task="current"
          @select-tab="selectTab"
          @open-baseline="openBaseline"
          @open-supplement="supplementDialog?.open()"
          @action="action"
          @unavailable="workflowFallback = true"
        />
        <template v-else>
          <TemplateWorkflowOverview
            v-if="isNewTemplateWorkflow && templateWorkflow"
            :workflow="templateWorkflow"
            :active-status="current?.status"
            :repair-round-count="task.optimization?.round ?? 0"
            :attention="current?.attention"
            :next-step="current?.nextStep"
            :created-at="task.createdAt"
            @open-baseline="openBaseline"
            @open-report="openTemplateReport"
          />
          <section v-else class="panel settings-panel"><div class="section-heading"><h2>流程进展</h2><span class="text-muted small-text">{{ formatDate(task.createdAt) }} 创建</span></div><div class="task-workflow"><div class="workflow-stage"><span class="workflow-stage-icon" :class="task.status" /><div><strong>{{ task.kind === 'generation' ? '站点生成' : '独立评测' }}</strong><p>{{ taskStatusNames[task.status] }}</p></div></div><template v-if="task.kind === 'generation'"><div class="workflow-connector" /><div class="workflow-stage"><span class="workflow-stage-icon" :class="evaluation?.status" /><div><strong>独立评测</strong><p>{{ evaluation ? taskStatusNames[evaluation.status] : task.status === 'completed' ? '尚未发起' : '等待生成完成' }}</p></div></div></template></div></section>
        </template>
      </template>
      <template v-else-if="tab === 'report'">
        <p v-if="task.scenario === 'site-template' && templateUnavailable" class="alert info" role="status">
          <span>{{ templateUnavailable }}</span>
          <button type="button" class="text-action" :disabled="templateLoading" @click="loadTemplateWorkflow">重新检查</button>
        </p>
        <template v-if="isNewTemplateWorkflow && templateWorkflow">
          <div v-if="task.generatedSiteId" class="report-mode-bar">
            <div class="segmented compact" role="tablist" aria-label="切换评测结果视图">
              <button
                type="button"
                role="tab"
                :aria-selected="reportSubView === 'template'"
                :class="{ selected: reportSubView === 'template' }"
                @click="reportSubView = 'template'"
              >
                当前区块核验与问题闭环
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="reportSubView === 'history'"
                :class="{ selected: reportSubView === 'history' }"
                @click="reportSubView = 'history'"
              >
                站点轮次报告记录
              </button>
            </div>
          </div>
          <TemplateEvaluationView
            v-if="!task.generatedSiteId || reportSubView === 'template'"
            :workflow="templateWorkflow"
            :loading="templateLoading"
            :error="templateError"
            @retry="loadTemplateWorkflow"
            @open-baseline="openBaseline"
          />
          <SiteReports
            v-else
            :key="task.generatedSiteId"
            :task-id="task.id"
            :site-id="task.generatedSiteId"
            :task-kind="task.kind"
            :revision="revision + ':' + siteRefresh"
            :detail-revision="reportRevision"
          />
        </template>
        <SiteReports v-else-if="task.generatedSiteId" :key="task.generatedSiteId" :task-id="task.id" :site-id="task.generatedSiteId" :task-kind="task.kind" :revision="revision + ':' + siteRefresh" :detail-revision="reportRevision" />
        <TaskReport v-else :task-id="task.id" :revision="reportRevision" />
      </template>
      <template v-else-if="isDevTabActive">
        <div class="dev-subnav">
          <div class="segmented compact" role="tablist" aria-label="研发排障分区">
            <button
              type="button"
              role="tab"
              :aria-selected="devSubTab === 'execution'"
              :class="{ selected: devSubTab === 'execution' }"
              @click="selectDevSubTab('execution')"
            >执行日志与轮次</button>
            <button
              type="button"
              role="tab"
              :aria-selected="devSubTab === 'input'"
              :class="{ selected: devSubTab === 'input' }"
              @click="selectDevSubTab('input')"
            >输入与发送快照</button>
            <button
              type="button"
              role="tab"
              :aria-selected="devSubTab === 'governance'"
              :class="{ selected: devSubTab === 'governance' }"
              @click="selectDevSubTab('governance')"
            >规则与经验</button>
          </div>
          <span class="text-muted small-text">研发排查与配置追溯区，不影响当前任务执行</span>
        </div>
        <template v-if="devSubTab === 'execution'">
          <TaskExecution ref="execution" :task-id="task.id" :task="task" :busy="busy" :workflow-active="Boolean(workflowActive)" :updated-at="data?.active?.updatedAt||task.updatedAt" @action="action" @changed="load" />
          <TaskCollection v-if="task.scope==='site' && ['migration','upgrade'].includes(task.scenario)" :task-id="task.id" :revision="revision" />
          <section v-if="task.generatedSiteId" class="panel settings-panel">
            <div class="section-heading">
              <h2>站点全部执行轮次历史</h2>
              <button type="button" class="text-action" :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">
                <ChevronDown v-if="historyOpen" :size="16" />
                <ChevronRight v-else :size="16" />
                {{ historyOpen ? '收起历史轮次' : '展开历史轮次' }}
              </button>
            </div>
            <SiteTaskHistory v-if="historyOpen" :site-id="task.generatedSiteId" :revision="revision + ':' + siteRefresh" />
          </section>
        </template>
        <TaskInput
          v-else
          :task-id="task.id"
          :resource-id="task.resourceId"
          :scope="task.scope"
          :kind="task.kind"
          :revision="revision"
          :mode="devSubTab === 'governance' ? 'governance' : 'input'"
          :template-workflow="templateWorkflow"
          :template-unavailable="task.scenario === 'site-template' ? templateUnavailable : ''"
          :baseline-focus="baselineFocus"
        />
      </template>
      <SiteTaskUsage v-else-if="tab === 'usage' && task.generatedSiteId" :task-id="task.id" :site-id="task.generatedSiteId" :revision="revision + ':' + siteRefresh" />
      <TaskUsage v-else-if="tab === 'usage'" :task-id="task.id" :summary="task.usage" />
      <TaskDeliverySection v-else-if="tab === 'delivery' && data?.deliveryEnabled" :task-id="task.id" :revision="revision" @changed="load" />
      <section v-else class="panel empty-state"><h2>此任务未启用交付</h2><button class="text-action" @click="selectTab('overview')">返回概览</button></section>
    </div>
    <dialog ref="optimizeDialog" class="modal"><form @submit.prevent="enableOptimization"><div class="modal-head"><h2>开启自动优化</h2><button type="button" class="icon-button" :disabled="busy" aria-label="关闭" @click="optimizeDialog?.close()"><X :size="20" /></button></div><p class="text-muted">沿用当前站点、输入和规则；依据独立报告继续修复并复评。</p><div class="form-grid"><label class="field"><span>双端目标分数</span><input v-model.number="optimizeScore" class="input" type="number" min="1" max="100" required /></label><label class="field"><span>最多修复轮数</span><input v-model.number="optimizeRounds" class="input" type="number" min="1" max="10" required /></label><label class="field"><span>费用上限（元，可选）</span><input v-model.number="optimizeCost" class="input" type="number" min="0.0001" step="any" placeholder="不设置" /></label></div><p v-if="actionError" class="alert error">{{actionError}}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="optimizeDialog?.close()">取消</button><button class="button primary" :disabled="busy"><LoaderCircle v-if="busy" class="spin" :size="16" /><Play v-else :size="16" />开启优化</button></div></form></dialog>
    <dialog ref="followDialog" class="modal"><form @submit.prevent="submit"><div class="modal-head"><h2>{{ followKind === 'evaluation' ? '发起新一轮评测' : '提交生成跟进' }}</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="followDialog?.close()"><X :size="20" /></button></div><p class="text-muted">在当前生成站创建新一轮任务，保留原任务及报告。</p><label class="field"><span>{{ followKind === 'evaluation' ? '评测要求' : '跟进消息' }}</span><textarea v-model="requirements" class="input" rows="6" required /></label><p v-if="actionError" class="alert error">{{ actionError }}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="followDialog?.close()">取消</button><button class="button primary" :disabled="busy"><LoaderCircle v-if="busy" class="spin" :size="16" /><Send v-else :size="16" />加入队列</button></div></form></dialog>
  </template>
</template>

<style scoped>
.task-title-line{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px}
.task-title-line h1{margin:0;font-size:22px;line-height:1.35}
.task-title-line .task-header-status{margin-left:0;flex:none}
.task-meta-line{display:flex;align-items:center;flex-wrap:wrap;gap:4px 14px;margin-top:8px;color:var(--muted);font-size:12.5px;line-height:1.5}
.task-meta-line>span,.task-meta-line>a{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.task-meta-line>a{color:var(--blue)}
.task-meta-line>a:hover{text-decoration:underline}
.delivered-inline{color:#16765d;font-weight:550}
.task-meta-tag{display:inline-flex;align-items:center;max-width:100%;padding:3px 9px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--muted);font-size:12px;font-weight:500;line-height:1.5;overflow-wrap:anywhere}
.disposition-tag.completed{border-color:#bde6d5;background:#eaf7f1;color:#16765d}
.disposition-tag.discarded{border-color:#dce2ec;background:#eef2f7;color:#526079}
.delivered-site-button{border-color:#bde6d5;background:#eaf7f1;color:#16765d}
.delivered-site-button:hover:not(:disabled){border-color:#93d6b9;background:#dff2e9}
.task-disposition-note{margin:8px 0 0;font-size:12px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}
.task-tabs-divider{width:1px;height:18px;background:#dce2ec;flex:none}
.task-tab-dev{display:inline-flex;align-items:center;gap:6px}
.task-tab-dev:not(.selected){color:#7a869b}
.dev-subnav{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.report-mode-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
</style>
