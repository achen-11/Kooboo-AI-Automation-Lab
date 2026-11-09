<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshCw, LoaderCircle } from '@lucide/vue';
import type { UsageSummary, UsagePageEntry } from '../../../shared/billing';
import { usageStageNames } from '../../../shared/site-delivery';
import { formatDate } from '../api';
import { useTaskSection } from '../views/automation/use-task-section';
import BaseSelect from './BaseSelect.vue';
import TaskTiming from './TaskTiming.vue';
import UsageComposition from './UsageComposition.vue';
import { stageColors } from '../lib/usage-composition';
import { formatDuration } from '../../../shared/timing';
import Disclosure from './Disclosure.vue';
import TablePagination from './TablePagination.vue';
import type { SiteDeliverySummary } from '../../../shared/site-delivery';
const props = defineProps<{ taskId: string; summary?: UsageSummary; siteId?: string; stageCosts?: SiteDeliverySummary['stages'] }>();
const costs = computed(() => props.stageCosts?.filter(item => item.usage.requests) || []);
const metric = ref<'cost' | 'time'>('cost');
const timing = ref<InstanceType<typeof TaskTiming> | null>(null);
const page = ref(1), stage = ref(''), round=ref('');
function filterRound(value:string|number|undefined){round.value=String(value??'');page.value=1;}
const stages = usageStageNames;
const composition = computed(() => costs.value.map(item => ({
  key: item.stage, label: stages[item.stage], value: item.usage.knownCny,
  amount: item.usage.priced ? '¥ ' + item.usage.knownCny.toFixed(4) : '—', color: stageColors[item.stage],
})));
const bands = { peak: '高峰', offpeak: '闲时', mixed: '跨时段', unknown: '未知' };
const revision = computed(() => page.value === 1 ? JSON.stringify(props.summary) : '');
const { data, loading, error, load } = useTaskSection<{ rounds?:number[]; items: UsagePageEntry[]; total: number; page: number; pages: number }>(
  () => (props.siteId ? '/automation/site-deliveries/' + props.siteId : '/automation/tasks/' + props.taskId) + '/usage?page=' + page.value + '&pageSize=20' + (stage.value ? '&stage=' + stage.value : '')+(!props.siteId&&round.value!==''?'&round='+round.value:''), () => revision.value);
function filter(value: string | number | undefined) { stage.value = String(value || ''); page.value = 1; }
</script>
<template>
  <section class="panel settings-panel" :aria-label="siteId ? '生成站累计费用与耗时' : '本次流程费用与耗时'">
    <div class="section-heading">
      <div class="segmented compact" role="group" aria-label="费用与耗时切换">
        <button type="button" :class="{ selected: metric === 'cost' }" :aria-pressed="metric === 'cost'" @click="metric = 'cost'">费用</button>
        <button type="button" :class="{ selected: metric === 'time' }" :aria-pressed="metric === 'time'" @click="metric = 'time'">耗时</button>
      </div>
      <span v-if="metric === 'cost'" class="text-muted small-text">按用量估算</span>
      <button v-else class="icon-button" :disabled="timing?.loading" aria-label="刷新耗时" @click="timing?.load()"><RefreshCw :size="17" /></button>
    </div>
    <template v-if="metric === 'cost'">
    <div v-if="summary?.requests" class="usage-totals">
      <div class="usage-amount"><span>估算金额</span><strong>{{ summary.priced ? '¥ ' + summary.knownCny.toFixed(4) : '—' }}</strong></div>
      <div><span>输入 tokens</span><strong>{{ summary.input.toLocaleString() }}</strong></div>
      <div><span>缓存命中 tokens</span><strong>{{ summary.cached.toLocaleString() }}</strong></div>
      <div><span>输出 tokens</span><strong>{{ summary.output.toLocaleString() }}</strong></div>
    </div>
    <p v-else class="text-muted">暂无用量记录。</p>
    <UsageComposition v-if="costs.length" :items="composition" label="费用构成" empty="暂无费用占比数据" />
    <Disclosure label="计费口径"><p class="text-muted small-text">{{ siteId ? '汇总这个生成站的全部生成、跟进、独立评测、续建与修复记录，每条请求只计一次。' : '本次流程的汇总包含其全部自动修复与评测子任务，请勿重复相加。' }}按每次请求的模型、北京时间时段和价格快照估算，最终以官方账单为准。缓存命中已包含在输入中；缺失用量、后台压缩及独立 Search / Fetch 等费用可能未包含。</p></Disclosure>
    </template>
    <TaskTiming v-else ref="timing" :task-id="taskId" :site-id="siteId" :revision="JSON.stringify(summary)" />
  </section>
  <section class="panel task-data-panel">
    <div class="table-toolbar"><h2>请求明细</h2><div class="toolbar-actions"><BaseSelect v-if="data?.rounds" :model-value="round" aria-label="按优化轮次筛选用量" :options="[{value:'',label:'全部轮次'},...data.rounds.map(n=>({value:String(n),label:n?'修复 '+n:'初始生成与评测'}))]" @update:model-value="filterRound" /><BaseSelect :model-value="stage" aria-label="按执行阶段筛选用量" @update:model-value="filter" :options="[{ value: '', label: '全部阶段' }, ...Object.entries(stages).map(([key, name]) => ({ value: key, label: (name) }))]" /><button class="icon-button" :disabled="loading" aria-label="刷新用量" @click="load"><RefreshCw :size="17" /></button></div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载明细…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table usage-table"><thead><tr><th>阶段 / 模型</th><th>请求时间</th><th>输入 / 缓存 / 输出</th><th>时段 / 金额</th><th>详情</th></tr></thead><tbody>
      <tr v-for="entry in data.items" :key="entry.taskId + entry.source + entry.id"><td>{{ stages[entry.stage] }}<span class="table-subtitle">{{ entry.model }}</span></td><td>{{ formatDate(entry.startedAt) }}<span class="table-subtitle">{{ ({completed:'完成',failed:'失败',unknown:'状态未知'})[entry.status] }} · {{ entry.status === 'unknown' ? '耗时未确认' : formatDuration(entry.endedAt - entry.startedAt) }}</span></td><td>{{ entry.tokens ? entry.tokens.input.toLocaleString() + ' / ' + (entry.tokens.cached?.toLocaleString() ?? '未知') + ' / ' + entry.tokens.output.toLocaleString() : '用量缺失' }}</td><td>{{ bands[entry.band] }}<span class="table-subtitle">{{ entry.cny === null ? '—' : '¥ ' + entry.cny.toFixed(6) }}</span></td><td><Disclosure label="查看记录"><p>请求级用量记录</p><p class="text-muted small-text">价格版本：{{ entry.price?.id || '未匹配' }}</p><pre class="task-technical">{{ JSON.stringify(entry.raw, null, 2) }}</pre></Disclosure></td></tr>
      <tr v-if="!data.items.length"><td colspan="5" class="text-muted">暂无符合条件的用量记录</td></tr>
    </tbody></table></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page = $event" />
  </section>
</template>
<style scoped>
.usage-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;align-items:end;margin-bottom:16px}.usage-totals>div{display:flex;flex-direction:column;gap:8px;min-width:0}.usage-totals span{font-size:12px;color:var(--muted)}.usage-totals strong{font-size:19px;font-weight:600;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;line-height:1.3}.usage-totals .usage-amount strong{font-size:28px;font-weight:650}.usage-table td:last-child{min-width:210px;max-width:300px;white-space:normal}.usage-table th:first-child{width:auto}
@media(max-width:1000px){.usage-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:500px){.usage-totals strong{font-size:17px}.usage-totals .usage-amount strong{font-size:24px}}
</style>
