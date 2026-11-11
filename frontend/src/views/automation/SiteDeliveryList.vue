<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, Check, ExternalLink, Search, RefreshCw, Play, Clock3, LoaderCircle, RotateCcw, Trash2 } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import TablePagination from '../../components/TablePagination.vue';
import EnvironmentName from '../../components/EnvironmentName.vue';
import DispositionDialog from './DispositionDialog.vue';
import { formatDate } from '../../api';
import { scoreTone, siteLink } from '../../lib/task-list';
import { siteReportLink } from '../../lib/site-reports';
import { siteDeliveryStates, type SiteDeliveryPage, type SiteDeliverySummary } from '../../../../shared/site-delivery';
import { dispositionFilterOptions, dispositionStateNames, type DispositionFilter, type DispositionState } from '../../../../shared/dispositions';
import { scenarios } from '../../../../shared/automation';
import { refresh, refreshStatus, workspace, scopeName } from './common';
import { useTaskSection } from './use-task-section';

const query = ref(''), search = ref(''), state = ref(''), disposition = ref<DispositionFilter>('active'), page = ref(1);
const selected = ref<string[]>([]);
const dispositionDialog = ref<InstanceType<typeof DispositionDialog>>();
const site = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const { data, loading, error, load } = useTaskSection<SiteDeliveryPage>(() =>
  `/automation/site-deliveries?page=${page.value}&pageSize=20&disposition=${disposition.value}&q=${encodeURIComponent(search.value)}${state.value ? '&state=' + state.value : ''}${site ? '&site=' + encodeURIComponent(site) : ''}`);
const rows = computed(() => data.value?.items || []);
const selectedRows = computed(() => rows.value.filter(row => selected.value.includes(row.id)));
const checked = computed(() => rows.value.length > 0 && rows.value.every(row => selected.value.includes(row.id)));
const partial = computed(() => !checked.value && rows.value.some(row => selected.value.includes(row.id)));
const canBatchComplete = computed(() => selectedRows.value.some(row => row.disposition?.state !== 'completed' && !['running', 'queued'].includes(row.state)));
const canBatchDiscard = computed(() => selectedRows.value.some(row => row.disposition?.state !== 'discarded' && row.state !== 'running'));
const canBatchRestore = computed(() => selectedRows.value.some(row => Boolean(row.disposition)));
function toggleAll(event: Event) {
  const isChecked = (event.target as HTMLInputElement).checked;
  const visible = new Set(rows.value.map(row => row.id));
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
watch(query, value => { clearTimeout(debounce); debounce = setTimeout(() => { search.value = value; page.value = 1; selected.value = []; }, 250); });
watch([state, disposition], () => { page.value = 1; selected.value = []; });
watch(page, () => { selected.value = []; });
function reload() { if(!loading.value)void load(); void refreshStatus(); }
onMounted(() => { void refreshStatus(); timer = setInterval(() => {if(!document.hidden)reload();}, 4000); });
onUnmounted(() => { clearInterval(timer); clearTimeout(debounce); });
</script>

<template>
  <header class="page-header"><h1>任务中心</h1><a class="button primary" href="#/resources"><Play :size="16" />从资源创建任务</a></header>
  <p v-if="!workspace.settings.enabled" class="alert info"><Clock3 :size="17" /><span>自动执行已暂停，队列中的任务会保留。</span><a href="#/settings">前往设置<ArrowUpRight :size="15" /></a></p>
  <div class="queue-summary">
    <div><span>生成执行</span><strong>{{ workspace.queue?.generation ?? 0 }}<small>/ {{ workspace.settings.generationConcurrency }}</small></strong></div>
    <div><span>评测执行</span><strong>{{ workspace.queue?.evaluation ?? 0 }}<small>/ {{ workspace.settings.evaluationConcurrency }}</small></strong></div>
    <div><span>排队中</span><strong>{{ workspace.queue?.queued ?? 0 }}</strong></div>
    <div><span>生成站 / 待建任务</span><strong>{{ data?.activeTotal ?? data?.total ?? '—' }}</strong></div>
  </div>
  <section class="panel">
    <div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" placeholder="搜索资源或生成站" aria-label="搜索生成站" /></label><div class="toolbar-actions">
      <BaseSelect v-model="disposition" size="small" aria-label="归档状态" :options="dispositionFilterOptions" />
      <BaseSelect v-model="state" size="small" aria-label="交付状态" :options="[{value:'',label:'全部交付状态'},...Object.entries(siteDeliveryStates).map(([value,label])=>({value,label}))]" />
      <button class="icon-button" :disabled="loading" aria-label="刷新生成站" @click="reload"><RefreshCw :size="17" /></button>
    </div></div>
    <div v-if="selectedRows.length" class="selection-bar">
      <span>已选 {{ selectedRows.length }} 项</span>
      <button class="text-action" @click="selected = []">清空选择</button>
      <div class="selection-actions">
        <button v-if="canBatchRestore" class="button secondary small" @click="openDisposition(selectedRows, 'active')"><RotateCcw :size="15" />移回在列</button>
        <button v-if="canBatchDiscard" class="button secondary small" @click="openDisposition(selectedRows, 'discarded')"><Trash2 :size="15" />舍弃</button>
        <button v-if="canBatchComplete" class="button primary small" @click="openDisposition(selectedRows, 'completed')"><Check :size="15" />标为已完成</button>
      </div>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="reload">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载生成站…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table site-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择本页全部生成站" :checked="checked" :indeterminate.prop="partial" :disabled="!rows.length" @change="toggleAll" /></th><th>生成站</th><th>环境</th><th>场景 / 范围</th><th>当前结果</th><th>当前评分</th><th>站点总成本</th><th>最近更新</th><th /></tr></thead><tbody>
      <tr v-for="row in data.items" :key="row.id" :class="{ 'row-selected': selected.includes(row.id) }">
        <td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="row.id" :aria-label="`选择 ${row.resourceName}`" /></td>
        <td><div class="site-title-row"><a class="task-title" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">{{ row.resourceName }}</a><span v-if="row.disposition" class="disposition-badge" :class="row.disposition.state" :title="dispositionTitle(row)">{{ dispositionStateNames[row.disposition.state] }}</span></div><a v-if="siteLink(row.siteUrl)" class="site-address" :href="siteLink(row.siteUrl)" target="_blank" rel="noopener noreferrer" :title="row.siteUrl"><span>{{ row.siteUrl }}</span><ExternalLink :size="12" /></a><span v-else class="table-subtitle">{{ row.generatedSiteId ? '尚无可访问地址' : '等待创建生成站' }}</span><span v-if="row.disposition?.note" class="table-subtitle disposition-note" :title="row.disposition.note">{{ row.disposition.note }}</span></td>
        <td class="environment-cell"><EnvironmentName :environment-id="row.environmentId" /></td>
        <td>{{ scenarios[row.scenario] }}<span class="table-subtitle">{{ scopeName(row.scope) }}</span></td>
        <td><div class="delivery-result-content"><span class="delivery-result" :class="row.state" :title="row.reason">{{ siteDeliveryStates[row.state] }}</span><a v-if="row.state==='attention' && row.detailTaskId" class="text-action delivery-reason" :href="`#/tasks/${row.detailTaskId}?tab=execution`">查看原因<ArrowUpRight :size="12" /></a></div></td>
        <td><a v-if="row.report?.report" class="site-scores" :href="siteReportLink(row.detailTaskId || row.report.id, row.report.id)"><span v-for="score in row.report.report.scores" :key="score.viewport" class="site-score" :class="scoreTone(score.value,row.targetScore)" :title="`${viewportNames[score.viewport] || score.viewport}，目标 ${row.targetScore} 分`"><span>{{ viewportNames[score.viewport] || score.viewport }}</span><strong>{{ score.value ?? '—' }}</strong></span></a><span v-else class="text-muted">{{ row.state==='running' || row.state==='queued' ? '当前版本待评测' : '暂无有效报告' }}</span></td>
        <td class="site-cost"><a v-if="row.detailTaskId" :href="`#/tasks/${row.detailTaskId}?tab=usage`">{{ row.usage.priced ? '¥ ' + row.usage.knownCny.toFixed(4) : '—' }}</a><span v-else>—</span></td>
        <td class="date-cell">{{ formatDate(row.updatedAt) }}</td>
        <td><div class="toolbar-actions"><a class="text-action" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">详情<ArrowUpRight :size="14" /></a></div></td>
      </tr>
    </tbody></table></div>
    <div v-if="data && !data.items.length" class="empty-state"><Clock3 :size="30" /><h2>{{ query || state ? '没有匹配的生成站' : disposition === 'completed' ? '暂无已完成的生成站' : disposition === 'discarded' ? '暂无已舍弃的生成站' : '暂无在列生成站' }}</h2><p>{{ disposition === 'active' ? '从资源库创建任务，生成、跟进、评测与后续修复会归入同一个生成站。' : '可切换归档状态返回“在列”查看当前任务。' }}</p></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page=$event" />
  </section>
  <DispositionDialog ref="dispositionDialog" @saved="onDispositionSaved" />
</template>

<style scoped>
.selection-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.site-table th.checkbox-cell,.site-table td.checkbox-cell{width:50px;padding-left:22px;padding-right:8px}
.site-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.disposition-badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:550;line-height:1.4;white-space:nowrap}
.disposition-badge.completed{color:#16765d;background:#eaf7f1}
.disposition-badge.discarded{color:#64748b;background:#eef2f7}
.disposition-note{display:block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.delivery-result-content{display:flex;align-items:center;gap:12px}.delivery-reason{font-size:12px;padding:0;white-space:nowrap}
.environment-cell{min-width:100px;max-width:180px;overflow-wrap:anywhere}.site-table{min-width:1150px}.site-table td{vertical-align:middle}.site-table th:nth-child(2){width:28%}.site-address{display:flex;align-items:center;gap:5px;max-width:340px;margin-top:6px;color:var(--blue);font-size:11px}.site-address span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.site-address svg{flex:none}.site-address:hover span{text-decoration:underline}.delivery-result{font-weight:550;white-space:nowrap}.delivery-result.ready{color:#16765d}.delivery-result.attention,.delivery-result.needs-improvement{color:#a65e0a}.delivery-result.unverified,.delivery-result.awaiting-evaluation{color:var(--muted)}.delivery-result.running,.delivery-result.queued{color:var(--blue)}.site-scores{display:flex;flex-wrap:wrap;gap:6px;max-width:245px}.site-score{display:inline-flex;align-items:baseline;gap:6px;padding:4px 7px;border-radius:5px;background:var(--field);font-variant-numeric:tabular-nums}.site-score span{font-size:10px}.site-score strong{font-size:15px;font-weight:600}.site-score.good{color:#16765d;background:#eaf7f1}.site-score.warning{color:#a65e0a;background:#fff4e5}.site-score.low{color:#b53b4b;background:#fff0f2}.site-score.unknown{color:var(--muted)}.site-scores:hover .site-score{box-shadow:inset 0 0 0 1px currentColor}.site-cost{font-variant-numeric:tabular-nums;font-weight:550;white-space:nowrap}.site-cost a:hover{text-decoration:underline}
</style>
