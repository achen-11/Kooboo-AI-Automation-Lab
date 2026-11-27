<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, Check, Columns2, Copy, ExternalLink, Search, RefreshCw, Play, Clock3, LoaderCircle, RotateCcw, Send, Trash2, X } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import TablePagination from '../../components/TablePagination.vue';
import LiveSiteComparisonDialog from '../../components/LiveSiteComparisonDialog.vue';
import DispositionDialog from './DispositionDialog.vue';
import QueueDiagnostics from './QueueDiagnostics.vue';
import { api, formatDate, message } from '../../api';
import { notify } from '../../lib/notifications';
import { scoreTone } from '../../lib/task-list';
import { siteReportLink } from '../../lib/site-reports';
import { deliveryStatusNames, listSiteLinks, siteDeliveryAddressFilters, siteDeliveryStates, type SiteDeliveryAddressFilter, type SiteDeliveryDeliveryFilter, type SiteDeliveryPage, type SiteDeliverySummary } from '../../../../shared/site-delivery';
import { dispositionFilterOptions, dispositionStateNames, type DispositionFilter, type DispositionState } from '../../../../shared/dispositions';
import { scenarios } from '../../../../shared/automation';
import { refresh, refreshStatus, workspace, scopeName } from './common';
import { useTaskSection } from './use-task-section';

const query = ref(''), search = ref(''), state = ref(''), address = ref<SiteDeliveryAddressFilter | ''>(''), deliveryFilter = ref<SiteDeliveryDeliveryFilter | ''>(''), disposition = ref<DispositionFilter>('active'), page = ref(1);
const batchDeliveryMode = ref(false);
const selected = ref<string[]>([]);
const dispositionDialog = ref<InstanceType<typeof DispositionDialog>>();
const liveComparisonDialog = ref<InstanceType<typeof LiveSiteComparisonDialog>>();
const compareTarget = ref<{ taskId: string; defaultReportId: string | null } | null>(null);
const resumingRowId = ref<string | null>(null);
const site = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const attentionAddressOptions = [
  { value: '', label: '全部需要处理' },
  { value: 'missing', label: siteDeliveryAddressFilters.missing },
  { value: 'accessible', label: siteDeliveryAddressFilters.accessible },
] as const;
type QuickViewKey = 'all' | 'running' | 'attention' | 'ready' | 'completed';
const quickViews: Array<{ key: QuickViewKey; label: string; disposition: DispositionFilter; state: string }> = [
  { key: 'all', label: '全部在列', disposition: 'active', state: '' },
  { key: 'running', label: '进行中', disposition: 'active', state: 'running' },
  { key: 'attention', label: '需要处理', disposition: 'active', state: 'attention' },
  { key: 'ready', label: '可交付', disposition: 'active', state: 'ready' },
  { key: 'completed', label: '已归档', disposition: 'completed', state: '' },
];
const activeQuickView = computed<QuickViewKey | null>(() => {
  if (batchDeliveryMode.value || deliveryFilter.value) return null;
  if (disposition.value === 'active' && !state.value && !address.value) return 'all';
  if (disposition.value === 'active' && state.value === 'running') return 'running';
  if (disposition.value === 'active' && state.value === 'attention' && !address.value) return 'attention';
  if (disposition.value === 'active' && state.value === 'ready') return 'ready';
  if (disposition.value === 'completed' && !state.value) return 'completed';
  return null;
});
function applyQuickView(view: (typeof quickViews)[number]) {
  batchDeliveryMode.value = false;
  deliveryFilter.value = '';
  disposition.value = view.disposition;
  state.value = view.state;
  address.value = '';
  page.value = 1;
  selected.value = [];
  batchIssues.value = [];
}
function exitBatchDeliveryMode() {
  if (!batchDeliveryMode.value && !deliveryFilter.value) return;
  batchDeliveryMode.value = false;
  deliveryFilter.value = '';
}
function toggleBatchDeliveryMode() {
  if (batchDeliveryMode.value) {
    batchDeliveryMode.value = false;
    deliveryFilter.value = '';
  } else {
    batchDeliveryMode.value = true;
    disposition.value = 'active';
    state.value = '';
    address.value = '';
    deliveryFilter.value = 'deliverable';
  }
  page.value = 1;
  selected.value = [];
  batchIssues.value = [];
}
const { data, loading, error, load } = useTaskSection<SiteDeliveryPage>(() =>
  `/automation/site-deliveries?page=${page.value}&pageSize=20&disposition=${disposition.value}&q=${encodeURIComponent(search.value)}${state.value ? '&state=' + state.value : ''}${address.value ? '&address=' + address.value : ''}${deliveryFilter.value ? '&delivery=' + deliveryFilter.value : ''}${site ? '&site=' + encodeURIComponent(site) : ''}`);
const rows = computed(() => data.value?.items || []);
function isRowDeliverable(row: SiteDeliverySummary) {
  return row.deliveryAction?.eligible === true;
}
function rowCheckboxDisabled(row: SiteDeliverySummary) {
  return batchBusy.value || (batchDeliveryMode.value && !isRowDeliverable(row));
}
function rowCheckboxTitle(row: SiteDeliverySummary) {
  return batchDeliveryMode.value && !isRowDeliverable(row)
    ? (row.deliveryAction?.reason || '当前任务暂不支持跨环境交付')
    : undefined;
}
const selectableRows = computed(() => batchDeliveryMode.value ? rows.value.filter(isRowDeliverable) : rows.value);
watch([batchDeliveryMode, selectableRows], ([inBatchMode, allowed]) => {
  if (!inBatchMode || !selected.value.length) return;
  const allowedIds = new Set(allowed.map(row => row.id));
  const next = selected.value.filter(id => allowedIds.has(id));
  if (next.length !== selected.value.length) selected.value = next;
});
const selectedRows = computed(() => rows.value.filter(row => selected.value.includes(row.id)));
const checked = computed(() => selectableRows.value.length > 0 && selectableRows.value.every(row => selected.value.includes(row.id)));
const partial = computed(() => !checked.value && selectableRows.value.some(row => selected.value.includes(row.id)));
const canBatchComplete = computed(() => selectedRows.value.some(row => row.disposition?.state !== 'completed' && !['running', 'queued'].includes(row.state)));
const canBatchDiscard = computed(() => selectedRows.value.some(row => row.disposition?.state !== 'discarded' && row.state !== 'running'));
const canBatchRestore = computed(() => selectedRows.value.some(row => Boolean(row.disposition)));
interface BatchResumeIssue {
  id: string;
  detailTaskId: string | null;
  resourceName: string;
  reason: string;
}
const batchResuming = ref(false);
const batchDelivering = ref(false);
const batchBusy = computed(() => batchResuming.value || batchDelivering.value);
const batchResumeProgress = ref({ done: 0, total: 0 });
const batchDeliverProgress = ref({ done: 0, total: 0 });
const batchIssues = ref<BatchResumeIssue[]>([]);
const batchIssueKind = ref<'resume' | 'delivery'>('resume');
const resumableSelectedRows = computed(() => selectedRows.value.filter(row => !row.disposition && (row.recovery?.action === 'resume' || row.recovery?.action === 'adjust-site-names')));
const unconfirmedSelectedRows = computed(() => selectedRows.value.filter(row => !row.disposition && row.recovery?.action === 'confirm-stopped'));
const canBatchResume = computed(() => resumableSelectedRows.value.length > 0);
const batchResumeLabel = computed(() => {
  if (batchResuming.value) return `正在恢复 (${batchResumeProgress.value.done}/${batchResumeProgress.value.total})…`;
  return resumableSelectedRows.value.length < selectedRows.value.length
    ? `一键恢复 (${resumableSelectedRows.value.length})`
    : '一键恢复';
});
const deliverableSelectedRows = computed(() => selectedRows.value.filter(isRowDeliverable));
const forceDeliverableSelectedRows = computed(() => selectedRows.value.filter(row => !isRowDeliverable(row) && row.deliveryAction?.forceEligible === true && Boolean(row.deliveryAction.forceTaskId)));
const nonDeliverableSelectedRows = computed(() => selectedRows.value.filter(row => !isRowDeliverable(row)));
const canBatchDeliver = computed(() => deliverableSelectedRows.value.length > 0);
const canBatchForceDeliver = computed(() => !batchDeliveryMode.value && forceDeliverableSelectedRows.value.length > 0);
const forceDeliverConfirmOpen = ref(false);
watch([selected, batchDeliveryMode], ([sel, inBatch]) => {
  if (!sel.length || inBatch) forceDeliverConfirmOpen.value = false;
});
const showDisabledBatchDeliver = computed(() => !batchDeliveryMode.value && selectedRows.value.length > 0 && !canBatchDeliver.value && !canBatchForceDeliver.value && selectedRows.value.some(row => row.deliveryAction && ['unsupported-env', 'missing-token', 'require-passed'].includes(row.deliveryAction.code)));
const disabledBatchDeliverTitle = computed(() => selectedRows.value.find(row => row.deliveryAction?.reason)?.deliveryAction?.reason || '当前所选站点暂不支持跨环境交付');
const batchDeliverLabel = computed(() => {
  if (batchDelivering.value) return `正在排队交付 (${batchDeliverProgress.value.done}/${batchDeliverProgress.value.total})…`;
  return deliverableSelectedRows.value.length < selectedRows.value.length
    ? `一键交付 (${deliverableSelectedRows.value.length})`
    : '一键交付';
});
const batchForceDeliverLabel = computed(() => {
  if (batchDelivering.value) return `正在排队强制交付 (${batchDeliverProgress.value.done}/${batchDeliverProgress.value.total})…`;
  return forceDeliverableSelectedRows.value.length < selectedRows.value.length
    ? `强制交付 (${forceDeliverableSelectedRows.value.length})`
    : '强制交付';
});
function canDirectResumeRow(row: SiteDeliverySummary) {
  return !row.disposition && (row.recovery?.action === 'resume' || row.recovery?.action === 'adjust-site-names' || row.recovery?.action === 'handoff-conversation');
}
async function runSingleResume(row: SiteDeliverySummary) {
  if (batchBusy.value || resumingRowId.value || !canDirectResumeRow(row) || !row.recovery) return;
  resumingRowId.value = row.id;
  const endpoint = row.recovery.action === 'adjust-site-names'
    ? `/automation/tasks/${row.recovery.taskId}/adjust-site-names`
    : row.recovery.action === 'handoff-conversation'
      ? `/automation/tasks/${row.recovery.taskId}/generation-context/handoff`
      : `/automation/tasks/${row.recovery.taskId}/resume`;
  try {
    await api(endpoint, { method: 'POST' });
    notify.success(
      row.recovery.action === 'adjust-site-names'
        ? `已调整名称并恢复 ${row.resourceName}`
        : row.recovery.action === 'handoff-conversation'
          ? `已为 ${row.resourceName} 切换新会话并恢复`
          : `已提交恢复 ${row.resourceName}`,
    );
    await load();
    void refreshStatus();
  } catch (reason) {
    notify.error(message(reason));
  } finally {
    resumingRowId.value = null;
  }
}
async function copySiteUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    notify.success('已复制站点地址');
  } catch {
    notify.error('无法访问剪贴板，请手动复制');
  }
}
async function openCompare(row: SiteDeliverySummary) {
  if (!row.detailTaskId) return;
  const reportId = row.report?.id || null;
  compareTarget.value = { taskId: row.detailTaskId, defaultReportId: reportId };
  await nextTick();
  await liveComparisonDialog.value?.open(reportId);
}
async function runBatchResume() {
  if (batchBusy.value) return;
  const targets = [...selectedRows.value];
  const eligible: Array<{ row: SiteDeliverySummary; action: 'resume' | 'adjust-site-names' | 'handoff-conversation'; taskId: string }> = [];
  const issues: BatchResumeIssue[] = [];
  const seenTaskIds = new Set<string>();
  for (const row of targets) {
    if (row.disposition) {
      issues.push({ id: row.id, detailTaskId: row.detailTaskId, resourceName: row.resourceName, reason: '已归档，请先移回在列后再恢复' });
      continue;
    }
    if (row.recovery?.action === 'confirm-stopped') {
      issues.push({ id: row.id, detailTaskId: row.detailTaskId, resourceName: row.resourceName, reason: '原执行尚未确认停止，请进入详情核查确认后再恢复' });
      continue;
    }
    if (row.recovery && (row.recovery.action === 'resume' || row.recovery.action === 'adjust-site-names' || row.recovery.action === 'handoff-conversation')) {
      if (!seenTaskIds.has(row.recovery.taskId)) {
        seenTaskIds.add(row.recovery.taskId);
        eligible.push({ row, action: row.recovery.action, taskId: row.recovery.taskId });
      }
      continue;
    }
    issues.push({
      id: row.id,
      detailTaskId: row.detailTaskId,
      resourceName: row.resourceName,
      reason: ['running', 'queued'].includes(row.state) ? '当前任务正在执行或排队中，无需恢复' : '当前状态暂不支持直接批量恢复，请进入详情查看原因',
    });
  }
  if (!eligible.length) {
    batchIssueKind.value = 'resume';
    batchIssues.value = issues;
    notify.warning('所选任务暂不支持直接批量恢复，请查看原因');
    return;
  }
  batchResuming.value = true;
  batchIssueKind.value = 'resume';
  batchIssues.value = [];
  batchResumeProgress.value = { done: 0, total: eligible.length };
  let succeeded = 0;
  const succeededIds = new Set<string>();
  try {
    for (const item of eligible) {
      const endpoint = item.action === 'adjust-site-names'
        ? `/automation/tasks/${item.taskId}/adjust-site-names`
        : item.action === 'handoff-conversation'
          ? `/automation/tasks/${item.taskId}/generation-context/handoff`
          : `/automation/tasks/${item.taskId}/resume`;
      try {
        await api(endpoint, { method: 'POST' });
        succeeded++;
        succeededIds.add(item.row.id);
      } catch (reason) {
        issues.push({
          id: item.row.id,
          detailTaskId: item.row.detailTaskId,
          resourceName: item.row.resourceName,
          reason: message(reason),
        });
      } finally {
        batchResumeProgress.value.done++;
      }
    }
  } finally {
    batchResuming.value = false;
  }
  selected.value = selected.value.filter(id => !succeededIds.has(id));
  batchIssues.value = issues;
  if (succeeded > 0 && issues.length === 0) {
    notify.success(`已提交恢复 ${succeeded} 项任务`);
  } else if (succeeded > 0) {
    notify.warning(`已提交恢复 ${succeeded} 项任务，另有 ${issues.length} 项未恢复`);
  } else if (issues.length > 0) {
    notify.error(`${issues.length} 项任务未能恢复，请查看原因`);
  }
  await load();
  void refreshStatus();
}
async function runBatchDeliver() {
  if (batchBusy.value) return;
  const targets = [...selectedRows.value];
  const eligible: Array<{ row: SiteDeliverySummary; taskId: string }> = [];
  const issues: BatchResumeIssue[] = [];
  const seenTaskIds = new Set<string>();
  for (const row of targets) {
    const action = row.deliveryAction;
    if (action?.eligible && action.taskId) {
      if (!seenTaskIds.has(action.taskId)) {
        seenTaskIds.add(action.taskId);
        eligible.push({ row, taskId: action.taskId });
      }
      continue;
    }
    issues.push({
      id: row.id,
      detailTaskId: row.detailTaskId,
      resourceName: row.resourceName,
      reason: action?.reason || '当前任务暂不支持跨环境交付',
    });
  }
  if (!eligible.length) {
    batchIssueKind.value = 'delivery';
    batchIssues.value = issues;
    notify.warning('所选站点暂不支持跨环境交付，请查看原因');
    return;
  }
  batchDelivering.value = true;
  batchIssueKind.value = 'delivery';
  batchIssues.value = [];
  batchDeliverProgress.value = { done: 0, total: eligible.length };
  let succeeded = 0;
  const succeededIds = new Set<string>();
  try {
    for (const item of eligible) {
      try {
        await api(`/automation/tasks/${item.taskId}/delivery`, { method: 'POST' });
        succeeded++;
        succeededIds.add(item.row.id);
      } catch (reason) {
        issues.push({
          id: item.row.id,
          detailTaskId: item.row.detailTaskId,
          resourceName: item.row.resourceName,
          reason: message(reason),
        });
      } finally {
        batchDeliverProgress.value.done++;
      }
    }
  } finally {
    batchDelivering.value = false;
  }
  selected.value = selected.value.filter(id => !succeededIds.has(id));
  batchIssues.value = issues;
  if (succeeded > 0 && issues.length === 0) {
    notify.success(`已排队交付 ${succeeded} 个站点`);
  } else if (succeeded > 0) {
    notify.warning(`已排队交付 ${succeeded} 个站点，另有 ${issues.length} 项未发起交付`);
  } else if (issues.length > 0) {
    notify.error(`${issues.length} 个站点未能发起交付，请查看原因`);
  }
  await load();
  void refreshStatus();
}
async function runBatchForceDeliver() {
  if (batchBusy.value) return;
  const targets = [...forceDeliverableSelectedRows.value];
  const eligible: Array<{ row: SiteDeliverySummary; taskId: string }> = [];
  const issues: BatchResumeIssue[] = [];
  const seenTaskIds = new Set<string>();
  for (const row of targets) {
    const taskId = row.deliveryAction?.forceTaskId;
    if (taskId && !seenTaskIds.has(taskId)) {
      seenTaskIds.add(taskId);
      eligible.push({ row, taskId });
    }
  }
  if (!eligible.length) {
    forceDeliverConfirmOpen.value = false;
    return;
  }
  batchDelivering.value = true;
  batchIssueKind.value = 'delivery';
  batchIssues.value = [];
  batchDeliverProgress.value = { done: 0, total: eligible.length };
  let succeeded = 0;
  const succeededIds = new Set<string>();
  try {
    for (const item of eligible) {
      try {
        await api(`/automation/tasks/${item.taskId}/delivery`, {
          method: 'POST',
          body: JSON.stringify({ force: true }),
        });
        succeeded++;
        succeededIds.add(item.row.id);
      } catch (reason) {
        issues.push({
          id: item.row.id,
          detailTaskId: item.row.detailTaskId,
          resourceName: item.row.resourceName,
          reason: message(reason),
        });
      } finally {
        batchDeliverProgress.value.done++;
      }
    }
  } finally {
    batchDelivering.value = false;
    forceDeliverConfirmOpen.value = false;
  }
  selected.value = selected.value.filter(id => !succeededIds.has(id));
  batchIssues.value = issues;
  if (succeeded > 0 && issues.length === 0) {
    notify.success(`已排队强制交付 ${succeeded} 个站点`);
  } else if (succeeded > 0) {
    notify.warning(`已排队强制交付 ${succeeded} 个站点，另有 ${issues.length} 项未能发起交付`);
  } else if (issues.length > 0) {
    notify.error(`${issues.length} 个站点未能强制发起交付，请查看原因`);
  }
  await load();
  void refreshStatus();
}
function toggleAttentionMissingAddress() {
  batchDeliveryMode.value = false;
  deliveryFilter.value = '';
  if (state.value === 'attention' && address.value === 'missing') {
    state.value = '';
    address.value = '';
  } else {
    state.value = 'attention';
    address.value = 'missing';
  }
  page.value = 1;
  selected.value = [];
  batchIssues.value = [];
}
function siteLinks(row: SiteDeliverySummary) {
  return listSiteLinks(row.siteUrl, row.delivery);
}
function toggleAll(event: Event) {
  const isChecked = (event.target as HTMLInputElement).checked;
  const visible = new Set(selectableRows.value.map(row => row.id));
  selected.value = isChecked ? [...new Set([...selected.value, ...visible])] : selected.value.filter(id => !visible.has(id));
}
function dispositionTitle(row: SiteDeliverySummary) {
  if (!row.disposition) return '';
  const head = `${dispositionStateNames[row.disposition.state]} · ${formatDate(row.disposition.updatedAt)}`;
  return row.disposition.note ? `${head}：${row.disposition.note}` : head;
}
function openDisposition(targets: SiteDeliverySummary[], nextState: DispositionState) {
  const candidates = targets.filter(row => (row.disposition?.state || 'active') !== nextState);
  if (!candidates.length) return;
  const label = candidates.length === 1 ? candidates[0].resourceName : `已选 ${candidates.length} 项生成站任务`;
  dispositionDialog.value?.open({
    kind: 'delivery',
    ids: candidates.map(row => row.id),
    state: nextState,
    label,
    canCascadeResources: nextState === 'completed'
      ? candidates.some(row => row.resourceDisposition?.state !== 'completed')
      : nextState === 'active'
        ? candidates.some(row => Boolean(row.resourceDisposition))
        : false,
    defaultCascadeResources: nextState === 'completed' || candidates.some(row => row.disposition?.state === 'completed' && row.resourceDisposition?.state === 'completed'),
  });
}
function onDispositionSaved() {
  selected.value = [];
  reload();
  void refresh();
}
let timer: ReturnType<typeof setInterval> | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
watch(state, value => { if (value !== 'attention') address.value = ''; });
watch(query, value => { clearTimeout(debounce); debounce = setTimeout(() => { search.value = value; page.value = 1; selected.value = []; batchIssues.value = []; }, 250); });
watch([state, address, disposition], () => { page.value = 1; selected.value = []; batchIssues.value = []; });
watch(page, () => { selected.value = []; });
function reload() { if(!loading.value)void load(); void refreshStatus(); }
onMounted(() => { void refreshStatus(); timer = setInterval(() => { if (!document.hidden && !batchBusy.value) reload(); }, 4000); });
onUnmounted(() => { clearInterval(timer); clearTimeout(debounce); });
</script>

<template>
  <header class="page-header"><h1>任务中心</h1><div class="toolbar-actions"><QueueDiagnostics @changed="reload" /><a class="button primary" href="#/resources"><Play :size="16" />从资源创建任务</a></div></header>
  <p v-if="!workspace.settings.enabled" class="alert info"><Clock3 :size="17" /><span>自动执行已暂停，队列中的任务会保留。</span><a href="#/settings">前往设置<ArrowUpRight :size="15" /></a></p>
  <div class="queue-summary">
    <div><span>生成执行</span><strong>{{ workspace.queue?.generation ?? 0 }}<small>/ {{ workspace.settings.generationConcurrency }}</small></strong></div>
    <div><span>评测执行</span><strong>{{ workspace.queue?.evaluation ?? 0 }}<small>/ {{ workspace.settings.evaluationConcurrency }}</small></strong></div>
    <div><span>排队中</span><strong>{{ workspace.queue?.queued ?? 0 }}</strong></div>
    <div><span>生成站 / 待建任务</span><strong>{{ data?.activeTotal ?? data?.total ?? '—' }}</strong></div>
  </div>
  <section class="panel">
    <div class="quick-view-bar">
      <div class="segmented compact quick-view-pills" role="group" aria-label="快捷视图">
        <button
          v-for="view in quickViews"
          :key="view.key"
          type="button"
          class="quick-view-btn"
          :class="{ selected: activeQuickView === view.key }"
          :aria-pressed="activeQuickView === view.key"
          @click="applyQuickView(view)"
        >
          {{ view.label }}
        </button>
      </div>
      <div class="quick-bar-right">
        <button
          type="button"
          class="quick-delivery-btn"
          :class="{ selected: batchDeliveryMode }"
          :aria-pressed="batchDeliveryMode"
          title="仅筛选当前可跨环境交付的站点，批量选择后一键交付"
          @click="toggleBatchDeliveryMode"
        >
          <Send :size="13" />批量交付<span :class="{ 'count-ready': (data?.deliverableCount ?? 0) > 0 }">{{ data?.deliverableCount ?? 0 }}</span>
        </button>
        <button
          type="button"
          class="quick-attention-filter"
          :class="{ selected: state === 'attention' && address === 'missing' }"
          :aria-pressed="state === 'attention' && address === 'missing'"
          title="一键筛选「需要处理」且尚无可访问地址的任务"
          @click="toggleAttentionMissingAddress"
        >
          需处理 · 尚无可访问地址<span :class="{ 'count-attention': (data?.attentionMissingAddress ?? 0) > 0 }">{{ data?.attentionMissingAddress ?? 0 }}</span>
        </button>
      </div>
    </div>
    <div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" placeholder="搜索资源或生成站" aria-label="搜索生成站" /></label><div class="toolbar-actions">
      <BaseSelect v-model="disposition" size="small" aria-label="归档状态" :options="dispositionFilterOptions" @update:model-value="exitBatchDeliveryMode" />
      <BaseSelect v-model="state" size="small" aria-label="交付状态" :options="[{value:'',label:'全部交付状态'},...Object.entries(siteDeliveryStates).map(([value,label])=>({value,label}))]" @update:model-value="exitBatchDeliveryMode" />
      <BaseSelect v-if="state === 'attention'" v-model="address" size="small" aria-label="可访问地址" :options="attentionAddressOptions" />
      <button class="icon-button" :disabled="loading" aria-label="刷新生成站" @click="reload"><RefreshCw :size="17" /></button>
    </div></div>
    <div v-if="batchDeliveryMode && !selectedRows.length" class="batch-delivery-banner">
      <span>批量交付模式：仅展示当前满足跨环境交付条件的站点（已自动过滤未配置交付环境、已交付或暂不满足条件的站点）。</span>
      <button type="button" class="text-action" :disabled="batchBusy" @click="toggleBatchDeliveryMode">退出批量交付</button>
    </div>
    <div v-if="selectedRows.length" class="selection-bar">
      <span>已选 {{ selectedRows.length }} 项</span>
      <button type="button" class="text-action" :disabled="batchBusy" @click="selected = []">清空选择</button>
      <button v-if="batchDeliveryMode" type="button" class="text-action" :disabled="batchBusy" @click="toggleBatchDeliveryMode">退出批量交付</button>
      <span v-if="!batchDeliveryMode && canBatchDeliver && nonDeliverableSelectedRows.length" class="selection-hint">另有 {{ nonDeliverableSelectedRows.length }} 项暂不支持交付，将自动跳过</span>
      <span v-else-if="!batchDeliveryMode && unconfirmedSelectedRows.length && !canBatchResume" class="selection-hint">所选任务尚未确认原执行停止，请进入详情核查确认后再恢复</span>
      <div class="selection-actions">
        <button v-if="canBatchDeliver" type="button" class="button primary small" :disabled="batchBusy" @click="runBatchDeliver">
          <LoaderCircle v-if="batchDelivering" class="spin" :size="15" />
          <Send v-else :size="15" />
          {{ batchDeliverLabel }}
        </button>
        <button v-else-if="showDisabledBatchDeliver" type="button" class="button primary small" :disabled="true" :title="disabledBatchDeliverTitle">
          <Send :size="15" />
          一键交付
        </button>
        <template v-if="!batchDeliveryMode">
          <button v-if="canBatchForceDeliver" type="button" class="button secondary small" :disabled="batchBusy" @click="forceDeliverConfirmOpen = true">
            <LoaderCircle v-if="batchDelivering" class="spin" :size="15" />
            <Send v-else :size="15" />
            {{ batchForceDeliverLabel }}
          </button>
          <button v-if="canBatchResume" type="button" class="button small" :class="canBatchDeliver ? 'secondary' : 'primary'" :disabled="batchBusy" @click="runBatchResume">
            <LoaderCircle v-if="batchResuming" class="spin" :size="15" />
            <Play v-else :size="15" />
            {{ batchResumeLabel }}
          </button>
          <button v-if="canBatchRestore" type="button" class="button secondary small" :disabled="batchBusy" @click="openDisposition(selectedRows, 'active')"><RotateCcw :size="15" />移回在列</button>
          <button v-if="canBatchDiscard" type="button" class="button secondary small" :disabled="batchBusy" @click="openDisposition(selectedRows, 'discarded')"><Trash2 :size="15" />舍弃</button>
          <button v-if="canBatchComplete" type="button" class="button small" :class="(canBatchResume || canBatchDeliver) ? 'secondary' : 'primary'" :disabled="batchBusy" @click="openDisposition(selectedRows, 'completed')"><Check :size="15" />标为已完成</button>
        </template>
      </div>
    </div>
    <div v-if="forceDeliverConfirmOpen && canBatchForceDeliver" class="batch-force-confirm" role="region" aria-label="确认强制交付">
      <span>确认对已选 {{ forceDeliverableSelectedRows.length }} 个中断或未达标站点强制发起跨环境交付？请确认均已完成初步验收（跳过未完成/评测门禁，保留源站）。</span>
      <div class="batch-force-actions">
        <button type="button" class="button secondary small" :disabled="batchBusy" @click="forceDeliverConfirmOpen = false">取消</button>
        <button type="button" class="button primary small" :disabled="batchBusy" @click="runBatchForceDeliver">
          <LoaderCircle v-if="batchDelivering" class="spin" :size="15" />
          <Send v-else :size="15" />
          确认强制交付
        </button>
      </div>
    </div>
    <div v-if="batchIssues.length" class="batch-issues" role="alert">
      <div class="batch-issues-head">
        <strong>{{ batchIssueKind === 'delivery' ? `以下 ${batchIssues.length} 项未能发起交付` : `以下 ${batchIssues.length} 项未自动恢复` }}</strong>
        <button type="button" class="icon-button" aria-label="关闭提示" @click="batchIssues = []"><X :size="16" /></button>
      </div>
      <ul class="batch-issues-list">
        <li v-for="item in batchIssues" :key="item.id">
          <a v-if="item.detailTaskId" class="task-title" :href="`#/tasks/${item.detailTaskId}?tab=${batchIssueKind === 'delivery' ? 'delivery' : 'execution'}`">{{ item.resourceName }}</a>
          <span v-else class="batch-issue-name">{{ item.resourceName }}</span>
          <span>{{ item.reason }}</span>
        </li>
      </ul>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="reload">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载生成站…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table site-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择本页全部生成站" :checked="checked" :indeterminate.prop="partial" :disabled="!selectableRows.length || batchBusy" @change="toggleAll" /></th><th>任务与站点</th><th>任务状态</th><th>评分</th><th>总成本</th><th>最近更新</th><th>快捷操作</th></tr></thead><tbody>
      <tr v-for="row in data.items" :key="row.id" :class="{ 'row-selected': selected.includes(row.id), 'row-delivery-disabled': batchDeliveryMode && !isRowDeliverable(row) }">
        <td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="row.id" :disabled="rowCheckboxDisabled(row)" :title="rowCheckboxTitle(row)" :aria-label="`选择 ${row.resourceName}`" /></td>
        <td>
          <div class="site-title-row">
            <a class="task-title" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">{{ row.resourceName }}</a>
            <span class="site-meta-inline">{{ scenarios[row.scenario] }} · {{ scopeName(row.scope) }}{{ row.environmentName ? ' · ' + row.environmentName : '' }}</span>
            <span v-if="batchDeliveryMode && !isRowDeliverable(row)" class="delivery-ineligible-tag" :title="row.deliveryAction?.reason">{{ row.deliveryAction?.reason || '不支持交付' }}</span>
            <span v-if="row.disposition" class="disposition-badge" :class="row.disposition.state" :title="dispositionTitle(row)">{{ dispositionStateNames[row.disposition.state] }}</span>
          </div>
          <div v-if="siteLinks(row).primary" class="site-address-row">
            <a class="site-address" :class="{ 'site-address-delivered': siteLinks(row).primary!.delivered, 'site-address-delivery-pending': siteLinks(row).primary!.deliveryPending }" :href="siteLinks(row).primary!.url" target="_blank" rel="noopener noreferrer" :title="siteLinks(row).primary!.title"><span v-if="siteLinks(row).primary!.badge" class="delivery-link-badge" :class="{ pending: siteLinks(row).primary!.deliveryPending }">{{ siteLinks(row).primary!.badge }}</span><span class="site-address-url">{{ siteLinks(row).primary!.url }}</span><ExternalLink :size="12" /></a>
            <button type="button" class="copy-site-btn" aria-label="复制站点地址" :title="`复制地址：${siteLinks(row).primary!.url}`" @click="copySiteUrl(siteLinks(row).primary!.url)"><Copy :size="12" /></button>
          </div>
          <span v-else class="table-subtitle">{{ row.generatedSiteId ? '尚无可访问地址' : '等待创建生成站' }}</span>
          <a v-if="siteLinks(row).source" class="site-address-secondary" :href="siteLinks(row).source" target="_blank" rel="noopener noreferrer" :title="'源站：' + siteLinks(row).source"><span>源站：{{ siteLinks(row).source }}</span><ExternalLink :size="11" /></a>
          <span v-if="row.disposition?.note" class="table-subtitle disposition-note" :title="row.disposition.note">{{ row.disposition.note }}</span>
        </td>
        <td>
          <div class="delivery-result-content">
            <span class="delivery-result" :class="row.state">{{ siteDeliveryStates[row.state] }}</span>
            <a v-if="row.state==='attention' && row.delivery && ['failed','uncertain'].includes(row.delivery.status)" class="text-action delivery-reason" :href="`#/tasks/${row.delivery.taskId}?tab=delivery`">查看交付<ArrowUpRight :size="12" /></a>
            <a v-else-if="row.delivery && ['queued','running','verifying'].includes(row.delivery.status)" class="text-action delivery-status-link" :href="`#/tasks/${row.delivery.taskId}?tab=delivery`">{{ deliveryStatusNames[row.delivery.status] }}<ArrowUpRight :size="12" /></a>
          </div>
          <span v-if="row.reason" class="delivery-reason-text" :title="row.reason">{{ row.reason }}</span>
        </td>
        <td><a v-if="row.report?.report" class="site-scores" :href="siteReportLink(row.detailTaskId || row.report.id, row.report.id)"><span v-for="score in row.report.report.scores" :key="score.viewport" class="site-score" :class="scoreTone(score.value,row.targetScore)" :title="`${viewportNames[score.viewport] || score.viewport}，目标 ${row.targetScore} 分`"><span>{{viewportNames[score.viewport] || score.viewport}}</span><strong>{{score.value ?? '—'}}</strong></span></a><span v-else class="text-muted">{{ row.state==='running' || row.state==='queued' ? '待评测' : '暂无' }}</span></td>
        <td class="site-cost"><a v-if="row.detailTaskId" :href="`#/tasks/${row.detailTaskId}?tab=usage`">{{ row.usage.priced ? '¥ ' + row.usage.knownCny.toFixed(4) : '—' }}</a><span v-else>—</span></td>
        <td class="date-cell">{{ formatDate(row.updatedAt) }}</td>
        <td>
          <div class="row-quick-actions">
            <button
              v-if="canDirectResumeRow(row)"
              type="button"
              class="button primary small row-action-btn"
              :disabled="batchBusy || resumingRowId === row.id"
              @click="runSingleResume(row)"
            >
              <LoaderCircle v-if="resumingRowId === row.id" class="spin" :size="13" />
              <Play v-else :size="13" />
              恢复
            </button>
            <button
              v-else-if="row.detailTaskId && siteLinks(row).primary"
              type="button"
              class="button secondary small row-action-btn"
              @click="openCompare(row)"
            >
              <Columns2 :size="13" />对比
            </button>
            <a
              v-else-if="row.state==='attention' && row.detailTaskId"
              class="text-action row-action-link"
              :href="row.delivery && ['failed','uncertain'].includes(row.delivery.status) ? `#/tasks/${row.delivery.taskId}?tab=delivery` : `#/tasks/${row.detailTaskId}`"
            >
              去处理<ArrowUpRight :size="13" />
            </a>
            <a v-else class="text-action row-action-link" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">详情<ArrowUpRight :size="13" /></a>
          </div>
        </td>
      </tr>
    </tbody></table></div>
    <div v-if="data && !data.items.length" class="empty-state"><Clock3 :size="30" /><h2>{{ batchDeliveryMode ? '暂无可批量交付的站点' : query || state || address ? '没有匹配的生成站' : disposition === 'completed' ? '暂无已完成的生成站' : disposition === 'discarded' ? '暂无已舍弃的生成站' : '暂无在列生成站' }}</h2><p>{{ batchDeliveryMode ? '当前在列站点均已完成跨环境交付、所在环境未启用交付，或尚在执行中。' : disposition === 'active' ? '从资源库创建任务，生成、跟进、评测与后续修复会归入同一个生成站。' : '可切换归档状态返回“在列”查看当前任务。' }}</p></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page=$event" />
  </section>
  <DispositionDialog ref="dispositionDialog" @saved="onDispositionSaved" />
  <LiveSiteComparisonDialog v-if="compareTarget" :key="compareTarget.taskId" ref="liveComparisonDialog" :task-id="compareTarget.taskId" :default-report-id="compareTarget.defaultReportId" />
</template>

<style scoped>
.quick-view-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:16px 24px 0}
.quick-view-pills{flex-wrap:wrap}
.quick-bar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.quick-attention-filter,.quick-delivery-btn{min-height:34px;padding:5px 12px;display:inline-flex;align-items:center;gap:7px;border-radius:9px;border:1px solid #e2e8f2;background:#fff;color:#526079;font-size:12px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s,color .15s,box-shadow .15s}
.quick-attention-filter:hover:not(.selected){border-color:#d6b68a;background:#fffaf2;color:#995608}
.quick-attention-filter.selected{border-color:#e7be80;background:#fff4e5;color:#995608;box-shadow:0 1px 3px #9956081a}
.quick-delivery-btn:hover:not(.selected){border-color:#93c5fd;background:#f4f8ff;color:#1d4ed8}
.quick-delivery-btn.selected{border-color:#3b82f6;background:#eff6ff;color:#1d4ed8;box-shadow:0 1px 3px #1d4ed81a}
.quick-attention-filter>span,.quick-delivery-btn>span{font-size:11px;padding:1px 6px;min-width:20px;text-align:center;border-radius:5px;background:#e8eef7;color:#71809b;font-weight:600;font-variant-numeric:tabular-nums}
.quick-attention-filter>span.count-attention{background:#fce8c8;color:#995608}
.quick-attention-filter.selected>span.count-attention{background:#fff;color:#995608}
.quick-delivery-btn>span.count-ready{background:#dbeafe;color:#1d4ed8}
.quick-delivery-btn.selected>span.count-ready{background:#fff;color:#1d4ed8}
.batch-delivery-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 24px;background:#f4f8ff;border-top:1px solid #dce8fd;color:#274472;font-size:12.5px}
.batch-force-confirm{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 24px;background:#fffaf2;border-top:1px solid #f4dfb8;color:#6e4714;font-size:12.5px}
.batch-force-actions{display:flex;align-items:center;gap:8px;flex:none}
.row-delivery-disabled{background:#fafbfd}
.row-delivery-disabled td:not(:first-child){opacity:.62}
.row-delivery-disabled input[type="checkbox"]:disabled{cursor:not-allowed}
.delivery-ineligible-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;background:#eef2f7;color:#64748b;font-size:11px;font-weight:500;line-height:1.4;white-space:nowrap}
.selection-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.selection-hint{font-size:12px;color:#995608}
.batch-issues{padding:12px 24px;background:#fffaf2;border-top:1px solid #f4dfb8;color:#6e4714;font-size:12px}
.batch-issues-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.batch-issues-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.batch-issues-list li{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}
.batch-issues-list a{color:var(--blue);font-weight:600}
.batch-issues-list a:hover{text-decoration:underline}
.batch-issue-name{font-weight:600}
.site-table{width:100%;min-width:780px;table-layout:fixed}
.site-table th,.site-table td{padding:14px 12px;vertical-align:middle}
.site-table th.checkbox-cell,.site-table td.checkbox-cell{width:44px;padding:14px 4px 14px 18px}
.site-table th:nth-child(2){width:33%}
.site-table th:nth-child(3){width:22%}
.site-table th:nth-child(4){width:14%}
.site-table th:nth-child(5){width:10%}
.site-table th:nth-child(6){width:10%}
.site-table th:nth-child(7),.site-table td:last-child{width:9%;padding-right:18px}
.site-title-row{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;white-space:normal}
.site-title-row .task-title{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site-meta-inline{font-size:11px;color:var(--muted);white-space:nowrap}
.disposition-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:550;line-height:1.4;white-space:nowrap}
.disposition-badge.completed{color:#16765d;background:#eaf7f1}
.disposition-badge.discarded{color:#64748b;background:#eef2f7}
.disposition-note{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site-address-row{display:flex;align-items:center;gap:4px;margin-top:5px;max-width:100%}
.site-address{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;color:var(--blue);font-size:11.5px}
.site-address-delivered{color:#16765d;font-weight:550}
.site-address-delivery-pending{color:#995608;font-weight:550}
.delivery-link-badge{flex:none;padding:1px 6px;border-radius:4px;background:#eaf7f1;color:#16765d;font-size:10px;font-weight:600;line-height:1.4;white-space:nowrap}
.delivery-link-badge.pending{background:#fff4e5;color:#995608}
.site-address-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site-address svg,.site-address-secondary svg{flex:none}
.site-address:hover .site-address-url,.site-address-secondary:hover span{text-decoration:underline}
.copy-site-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;color:var(--muted);background:transparent;transition:background .15s,color .15s}
.copy-site-btn:hover{background:#eef3ff;color:var(--blue)}
.site-address-secondary{display:flex;align-items:center;gap:4px;max-width:100%;margin-top:3px;color:var(--muted);font-size:11px}
.site-address-secondary>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.delivery-result-content{display:flex;align-items:center;gap:8px;flex-wrap:wrap;white-space:normal}
.delivery-reason,.delivery-status-link{font-size:12px;padding:0;white-space:nowrap}
.delivery-reason-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word;margin-top:4px;font-size:11.5px;line-height:1.45;color:var(--muted);max-width:100%}
.delivery-result{font-weight:600;white-space:nowrap}
.delivery-result.ready,.delivery-result.generated{color:#16765d}.delivery-result.attention,.delivery-result.needs-improvement{color:#a65e0a}.delivery-result.unverified,.delivery-result.awaiting-evaluation{color:var(--muted)}.delivery-result.running,.delivery-result.queued{color:var(--blue)}
.site-scores{display:flex;flex-wrap:wrap;gap:5px;max-width:100%}
.site-score{display:inline-flex;align-items:baseline;gap:4px;padding:3px 6px;border-radius:5px;background:var(--field);font-variant-numeric:tabular-nums}
.site-score span{font-size:10px}.site-score strong{font-size:13.5px;font-weight:600}
.site-score.good{color:#16765d;background:#eaf7f1}.site-score.warning{color:#a65e0a;background:#fff4e5}.site-score.low{color:#b53b4b;background:#fff0f2}.site-score.unknown{color:var(--muted)}
.site-scores:hover .site-score{box-shadow:inset 0 0 0 1px currentColor}
.site-cost{font-variant-numeric:tabular-nums;font-weight:550;white-space:nowrap}
.site-cost a:hover{text-decoration:underline}
.site-table .date-cell{white-space:nowrap;font-size:12px;color:var(--muted)}
.row-quick-actions{display:flex;align-items:center;gap:6px;white-space:nowrap}
.row-action-btn{min-height:28px;padding:4px 10px;font-size:12px;border-radius:7px}
.row-action-link{font-size:12.5px;white-space:nowrap}
@media(max-width:700px){.quick-view-bar{padding:14px 18px 0}}
</style>
