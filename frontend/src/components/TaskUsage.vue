<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshCw, LoaderCircle } from '@lucide/vue';
import type { UsageSummary, UsageEntry, UsageStage } from '../../../shared/billing';
import { formatDate } from '../api';
import { useTaskSection } from '../views/automation/use-task-section';
import BaseSelect from './BaseSelect.vue';
import TaskBudget from './TaskBudget.vue';
import Disclosure from './Disclosure.vue';
import TablePagination from './TablePagination.vue';
import type { SiteDeliverySummary } from '../../../shared/site-delivery';
const props = defineProps<{ taskId: string; summary?: UsageSummary; siteId?: string; stageCosts?: SiteDeliverySummary['stages'] }>();
const costs = computed(() => props.stageCosts?.filter(item => item.usage.requests) || []);
const stageColors: Record<UsageStage, string> = {
  generation: '#6486e8', followup: '#9a7bd4', evaluation: '#4baba3',
  delivery: '#cb819d', experience: '#8092ad', planning: '#dfa85b',
};
const knownStageTotal = computed(() => costs.value.reduce((total, item) => total + Math.max(0, item.usage.knownCny), 0));
const segments = computed(() => costs.value.filter(item => item.usage.knownCny > 0));
function costShare(usage: UsageSummary) {
  if (!usage.priced || !knownStageTotal.value) return '—';
  const percent = usage.knownCny / knownStageTotal.value * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  if (percent < 100 && percent > 99.9) return '99.9%';
  return percent.toFixed(1) + '%';
}
const page = ref(1), stage = ref(''), round=ref('');
function filterRound(value:string|number|undefined){round.value=String(value??'');page.value=1;}
const stages: Record<string, string> = { generation: '生成', followup: 'AI 跟进', evaluation: '独立评测', delivery: '交付核验', experience:'经验学习',planning:'交付清单规划' };
const bands = { peak: '高峰', offpeak: '闲时', mixed: '跨时段', unknown: '未知' };
const revision = computed(() => page.value === 1 ? JSON.stringify(props.summary) : '');
const { data, loading, error, load } = useTaskSection<{ rounds?:number[]; items: UsageEntry[]; total: number; page: number; pages: number }>(
  () => (props.siteId ? '/automation/site-deliveries/' + props.siteId : '/automation/tasks/' + props.taskId) + '/usage?page=' + page.value + '&pageSize=20' + (stage.value ? '&stage=' + stage.value : '')+(!props.siteId&&round.value!==''?'&round='+round.value:''), () => revision.value);
function filter(value: string | number | undefined) { stage.value = String(value || ''); page.value = 1; }
</script>
<template>
  <TaskBudget :task-id="taskId" />
  <section class="panel settings-panel">
    <div class="section-heading"><h2>{{ siteId ? '生成站累计用量与费用' : '本次流程用量与费用' }}</h2><span class="text-muted small-text">按用量估算</span></div>
    <div v-if="summary?.requests" class="usage-totals">
      <div class="usage-amount"><span>估算金额</span><strong>{{ summary.priced ? '¥ ' + summary.knownCny.toFixed(4) : '—' }}</strong></div>
      <div><span>输入 tokens</span><strong>{{ summary.input.toLocaleString() }}</strong></div>
      <div><span>缓存命中 tokens</span><strong>{{ summary.cached.toLocaleString() }}</strong></div>
      <div><span>输出 tokens</span><strong>{{ summary.output.toLocaleString() }}</strong></div>
    </div>
    <p v-else class="text-muted">暂无用量记录。</p>
    <figure v-if="costs.length" class="cost-composition">
      <figcaption class="cost-caption">费用构成</figcaption>
      <div v-if="knownStageTotal > 0" class="cost-bar" aria-hidden="true">
        <span v-for="item in segments" :key="item.stage" class="cost-segment" :style="{ flexGrow: item.usage.knownCny / knownStageTotal, backgroundColor: stageColors[item.stage] }" :title="`${stages[item.stage]} · ¥ ${item.usage.knownCny.toFixed(4)} · ${costShare(item.usage)}`" />
      </div>
      <p v-else class="cost-empty text-muted small-text">暂无费用占比数据</p>
      <dl class="stage-costs">
        <div v-for="item in costs" :key="item.stage" class="stage-cost-row">
          <dt><span class="cost-dot" :style="{ backgroundColor: stageColors[item.stage] }" aria-hidden="true" />{{ stages[item.stage] }}</dt>
          <dd class="stage-cost-amount">{{ item.usage.priced ? '¥ ' + item.usage.knownCny.toFixed(4) : '—' }}</dd>
          <dd class="stage-cost-share"><span class="sr-only">估算费用占比 </span>{{ costShare(item.usage) }}</dd>
        </div>
      </dl>
    </figure>
    <Disclosure label="计费口径"><p class="text-muted small-text">{{ siteId ? '汇总这个生成站的全部生成、跟进、独立评测、续建与修复记录，每条请求只计一次。' : '本次流程的汇总包含其全部自动修复与评测子任务，请勿重复相加。' }}按每次请求的模型、北京时间时段和价格快照估算，最终以官方账单为准。缓存命中已包含在输入中；缺失用量、后台压缩及独立 Search / Fetch 等费用可能未包含。</p></Disclosure>
  </section>
  <section class="panel task-data-panel">
    <div class="table-toolbar"><h2>请求明细</h2><div class="toolbar-actions"><BaseSelect v-if="data?.rounds" :model-value="round" aria-label="按优化轮次筛选用量" :options="[{value:'',label:'全部轮次'},...data.rounds.map(n=>({value:String(n),label:n?'修复 '+n:'初始生成与评测'}))]" @update:model-value="filterRound" /><BaseSelect :model-value="stage" aria-label="按执行阶段筛选用量" @update:model-value="filter" :options="[{ value: '', label: '全部阶段' }, ...Object.entries(stages).map(([key, name]) => ({ value: key, label: (name) }))]" /><button class="icon-button" :disabled="loading" aria-label="刷新用量" @click="load"><RefreshCw :size="17" /></button></div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载明细…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table usage-table"><thead><tr><th>阶段 / 模型</th><th>请求时间</th><th>输入 / 缓存 / 输出</th><th>时段 / 金额</th><th>详情</th></tr></thead><tbody>
      <tr v-for="entry in data.items" :key="entry.taskId + entry.source + entry.id"><td>{{ stages[entry.stage] }}<span class="table-subtitle">{{ entry.model }}</span></td><td>{{ formatDate(entry.startedAt) }}<span class="table-subtitle">{{ ({completed:'完成',failed:'失败',unknown:'状态未知'})[entry.status] }}</span></td><td>{{ entry.tokens ? entry.tokens.input.toLocaleString() + ' / ' + (entry.tokens.cached?.toLocaleString() ?? '未知') + ' / ' + entry.tokens.output.toLocaleString() : '用量缺失' }}</td><td>{{ bands[entry.band] }}<span class="table-subtitle">{{ entry.cny === null ? '—' : '¥ ' + entry.cny.toFixed(6) }}</span></td><td><Disclosure label="查看记录"><p>{{ entry.note || '请求级 usage' }}</p><p class="text-muted small-text">价格版本：{{ entry.price?.id || '未匹配' }}</p><pre class="task-technical">{{ JSON.stringify(entry.raw, null, 2) }}</pre></Disclosure></td></tr>
      <tr v-if="!data.items.length"><td colspan="5" class="text-muted">暂无符合条件的用量记录</td></tr>
    </tbody></table></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page = $event" />
  </section>
</template>
<style scoped>
.cost-composition{margin:20px 0 12px}.cost-caption{font-size:12px;color:var(--muted);margin-bottom:10px}.cost-bar{display:flex;height:12px;overflow:hidden;border-radius:4px;margin-bottom:12px;gap:2px}.cost-segment{flex-basis:0;min-width:0;border-radius:1px}.cost-empty{margin-bottom:8px}
.stage-costs{margin:0}.stage-cost-row{display:grid;grid-template-columns:minmax(0,1fr) 112px 64px;align-items:center;column-gap:20px;min-height:32px;font-size:13px}.stage-cost-row dt{display:flex;align-items:center;gap:10px;min-width:0}.cost-dot{width:9px;height:9px;border-radius:2px;flex:none}.stage-cost-row dd{margin:0;font-variant-numeric:tabular-nums}.stage-cost-amount,.stage-cost-share{text-align:right;white-space:nowrap}.stage-cost-amount{font-weight:550}.stage-cost-share{color:var(--muted);font-size:12px}
.usage-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;align-items:end;margin-bottom:16px}.usage-totals>div{display:flex;flex-direction:column;gap:8px;min-width:0}.usage-totals span{font-size:12px;color:var(--muted)}.usage-totals strong{font-size:19px;font-weight:600;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;line-height:1.3}.usage-totals .usage-amount strong{font-size:28px;font-weight:650}.usage-table td:last-child{min-width:210px;max-width:300px;white-space:normal}.usage-table th:first-child{width:auto}
@media(max-width:1000px){.usage-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.stage-cost-row{grid-template-columns:minmax(0,1fr) auto 52px;column-gap:10px;padding:6px 0;min-height:34px}.stage-cost-row dt{gap:8px}}
@media(max-width:500px){.usage-totals strong{font-size:17px}.usage-totals .usage-amount strong{font-size:24px}}
</style>
