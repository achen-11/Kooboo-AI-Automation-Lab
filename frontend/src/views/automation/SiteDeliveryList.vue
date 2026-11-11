<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, ExternalLink, Search, RefreshCw, Play, Clock3, LoaderCircle } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import TablePagination from '../../components/TablePagination.vue';
import { formatDate } from '../../api';
import { scoreTone, siteLink } from '../../lib/task-list';
import { siteReportLink } from '../../lib/site-reports';
import { siteDeliveryStates, type SiteDeliveryPage } from '../../../../shared/site-delivery';
import { scenarios } from '../../../../shared/automation';
import { refreshStatus, workspace, scopeName } from './common';
import { useTaskSection } from './use-task-section';
import SiteDomainDialog from './SiteDomainDialog.vue';

const query = ref(''), search = ref(''), state = ref(''), page = ref(1);
const domainDialog = ref<InstanceType<typeof SiteDomainDialog>>();
const site = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const { data, loading, error, load } = useTaskSection<SiteDeliveryPage>(() =>
  `/automation/site-deliveries?page=${page.value}&pageSize=20&q=${encodeURIComponent(search.value)}${state.value ? '&state=' + state.value : ''}${site ? '&site=' + encodeURIComponent(site) : ''}`);
let timer: ReturnType<typeof setInterval> | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
watch(query, value => { clearTimeout(debounce); debounce = setTimeout(() => { search.value = value; page.value = 1; }, 250); });
watch(state, () => page.value = 1);
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
    <div><span>生成站 / 待建任务</span><strong>{{ data?.total ?? '—' }}</strong></div>
  </div>
  <section class="panel">
    <div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" placeholder="搜索资源或生成站" aria-label="搜索生成站" /></label><div class="toolbar-actions">
      <BaseSelect v-model="state" size="small" aria-label="交付状态" :options="[{value:'',label:'全部交付状态'},...Object.entries(siteDeliveryStates).map(([value,label])=>({value,label}))]" />
      <button class="icon-button" :disabled="loading" aria-label="刷新生成站" @click="reload"><RefreshCw :size="17" /></button>
    </div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="reload">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载生成站…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table site-table"><thead><tr><th>生成站</th><th>场景 / 范围</th><th>当前结果</th><th>当前评分</th><th>站点总成本</th><th>最近更新</th><th /></tr></thead><tbody>
      <tr v-for="row in data.items" :key="row.id">
        <td><a class="task-title" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">{{ row.resourceName }}</a><a v-if="siteLink(row.siteUrl)" class="site-address" :href="siteLink(row.siteUrl)" target="_blank" rel="noopener noreferrer" :title="row.siteUrl"><span>{{ row.siteUrl }}</span><ExternalLink :size="12" /></a><span v-else class="table-subtitle">{{ row.generatedSiteId ? '尚无可访问地址' : '等待创建生成站' }}</span></td>
        <td>{{ scenarios[row.scenario] }}<span class="table-subtitle">{{ scopeName(row.scope) }}</span></td>
        <td><div class="delivery-result-content"><span class="delivery-result" :class="row.state" :title="row.reason">{{ siteDeliveryStates[row.state] }}</span><a v-if="row.state==='attention' && row.detailTaskId" class="text-action delivery-reason" :href="`#/tasks/${row.detailTaskId}?tab=execution`">查看原因<ArrowUpRight :size="12" /></a></div></td>
        <td><a v-if="row.report?.report" class="site-scores" :href="siteReportLink(row.detailTaskId || row.report.id, row.report.id)"><span v-for="score in row.report.report.scores" :key="score.viewport" class="site-score" :class="scoreTone(score.value,row.targetScore)" :title="`${viewportNames[score.viewport] || score.viewport}，目标 ${row.targetScore} 分`"><span>{{ viewportNames[score.viewport] || score.viewport }}</span><strong>{{ score.value ?? '—' }}</strong></span></a><span v-else class="text-muted">{{ row.state==='running' || row.state==='queued' ? '当前版本待评测' : '暂无有效报告' }}</span></td>
        <td class="site-cost"><a v-if="row.detailTaskId" :href="`#/tasks/${row.detailTaskId}?tab=usage`">{{ row.usage.priced ? '¥ ' + row.usage.knownCny.toFixed(4) : '—' }}</a><span v-else>—</span></td>
        <td class="date-cell">{{ formatDate(row.updatedAt) }}</td>
        <td><div class="toolbar-actions"><a class="text-action" :href="row.detailTaskId ? '#/tasks/' + row.detailTaskId : '#/resources/' + row.resourceId">详情<ArrowUpRight :size="14" /></a><button v-if="row.generatedSiteId" class="text-action" @click="domainDialog?.open(row.generatedSiteId)">换绑域名</button></div></td>
      </tr>
    </tbody></table></div>
    <div v-if="data && !data.items.length" class="empty-state"><Clock3 :size="30" /><h2>{{ query || state ? '没有匹配的生成站' : '暂无生成站' }}</h2><p>从资源库创建任务，生成、跟进、评测与后续修复会归入同一个生成站。</p></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page=$event" />
  </section>
  <SiteDomainDialog ref="domainDialog" @saved="reload" />
</template>

<style scoped>
.delivery-result-content{display:flex;align-items:center;gap:12px}.delivery-reason{font-size:12px;padding:0;white-space:nowrap}
.site-table{min-width:1050px}.site-table td{vertical-align:middle}.site-table th:first-child{width:29%}.site-address{display:flex;align-items:center;gap:5px;max-width:340px;margin-top:6px;color:var(--blue);font-size:11px}.site-address span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.site-address svg{flex:none}.site-address:hover span{text-decoration:underline}.delivery-result{font-weight:550;white-space:nowrap}.delivery-result.ready{color:#16765d}.delivery-result.attention,.delivery-result.needs-improvement{color:#a65e0a}.delivery-result.unverified,.delivery-result.awaiting-evaluation{color:var(--muted)}.delivery-result.running,.delivery-result.queued{color:var(--blue)}.site-scores{display:flex;flex-wrap:wrap;gap:6px;max-width:245px}.site-score{display:inline-flex;align-items:baseline;gap:6px;padding:4px 7px;border-radius:5px;background:var(--field);font-variant-numeric:tabular-nums}.site-score span{font-size:10px}.site-score strong{font-size:15px;font-weight:600}.site-score.good{color:#16765d;background:#eaf7f1}.site-score.warning{color:#a65e0a;background:#fff4e5}.site-score.low{color:#b53b4b;background:#fff0f2}.site-score.unknown{color:var(--muted)}.site-scores:hover .site-score{box-shadow:inset 0 0 0 1px currentColor}.site-cost{font-variant-numeric:tabular-nums;font-weight:550;white-space:nowrap}.site-cost a:hover{text-decoration:underline}
</style>
