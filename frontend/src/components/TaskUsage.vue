<script setup lang="ts">
import { computed, ref } from 'vue';
import { RefreshCw, LoaderCircle } from '@lucide/vue';
import type { UsageSummary, UsageEntry } from '../../../shared/billing';
import { formatDate } from '../api';
import { useTaskSection } from '../views/automation/use-task-section';
import BaseSelect from './BaseSelect.vue';
import TaskBudget from './TaskBudget.vue';
import Disclosure from './Disclosure.vue';
import TablePagination from './TablePagination.vue';
const props = defineProps<{ taskId: string; summary?: UsageSummary }>();
const page = ref(1), stage = ref(''), round=ref('');
function filterRound(value:string|number|undefined){round.value=String(value??'');page.value=1;}
const stages: Record<string, string> = { generation: '生成', followup: 'AI 跟进', evaluation: '独立评测', delivery: '交付核验', experience:'经验学习',planning:'交付清单规划' };
const bands = { peak: '高峰', offpeak: '闲时', mixed: '跨时段', unknown: '未知' };
const revision = computed(() => page.value === 1 ? JSON.stringify(props.summary) : '');
const { data, loading, error, load } = useTaskSection<{ rounds?:number[]; items: UsageEntry[]; total: number; page: number; pages: number }>(
  () => '/automation/tasks/' + props.taskId + '/usage?page=' + page.value + '&pageSize=20' + (stage.value ? '&stage=' + stage.value : '')+(round.value!==''?'&round='+round.value:''), () => revision.value);
function filter(value: string | number | undefined) { stage.value = String(value || ''); page.value = 1; }
</script>
<template>
  <TaskBudget :task-id="taskId" />
  <section class="panel settings-panel">
    <div class="section-heading"><h2>模型用量与费用</h2><span class="text-muted small-text">已知用量估算</span></div>
    <div v-if="summary?.requests" class="usage-totals">
      <div><span>{{ summary.missing ? '已知金额小计' : '估算金额' }}</span><strong>{{ summary.priced ? '¥ ' + summary.knownCny.toFixed(4) : '待核算' }}</strong></div>
      <div><span>输入 tokens</span><strong>{{ summary.input.toLocaleString() }}</strong></div>
      <div><span>缓存命中 tokens</span><strong>{{ summary.cached.toLocaleString() }}</strong></div>
      <div><span>输出 tokens</span><strong>{{ summary.output.toLocaleString() }}</strong></div>
    </div>
    <p v-else class="text-muted">尚未收到实际 usage，费用待核算。</p>
    <p v-if="summary?.missing" class="warning-text usage-note">{{ summary.missing }} 条记录待核算，当前金额不代表全部费用。</p>
    <Disclosure label="计费口径"><p class="text-muted small-text">按每次请求的模型、北京时间时段和价格快照估算，最终以官方账单为准。缓存命中已包含在输入中；缺失用量、后台压缩及独立 Search / Fetch 等费用可能未包含。生成任务的汇总包含其全部自动修复与评测子任务，请勿重复相加。</p></Disclosure>
  </section>
  <section class="panel task-data-panel">
    <div class="table-toolbar"><h2>请求明细</h2><div class="toolbar-actions"><BaseSelect v-if="data?.rounds" :model-value="round" aria-label="按优化轮次筛选用量" :options="[{value:'',label:'全部轮次'},...data.rounds.map(n=>({value:String(n),label:n?'修复 '+n:'初始生成与评测'}))]" @update:model-value="filterRound" /><BaseSelect :model-value="stage" aria-label="按执行阶段筛选用量" @update:model-value="filter" :options="[{ value: '', label: '全部阶段' }, ...Object.entries(stages).map(([key, name]) => ({ value: key, label: (name) }))]" /><button class="icon-button" :disabled="loading" aria-label="刷新用量" @click="load"><RefreshCw :size="17" /></button></div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载明细…</p>
    <div v-if="data" class="table-scroll" :aria-busy="loading"><table class="task-table usage-table"><thead><tr><th>阶段 / 模型</th><th>请求时间</th><th>输入 / 缓存 / 输出</th><th>时段 / 金额</th><th>详情</th></tr></thead><tbody>
      <tr v-for="entry in data.items" :key="entry.taskId + entry.source + entry.id"><td>{{ stages[entry.stage] }}<span class="table-subtitle">{{ entry.model }}</span></td><td>{{ formatDate(entry.startedAt) }}<span class="table-subtitle">{{ ({completed:'完成',failed:'失败',unknown:'状态未知'})[entry.status] }}</span></td><td>{{ entry.tokens ? entry.tokens.input.toLocaleString() + ' / ' + (entry.tokens.cached?.toLocaleString() ?? '未知') + ' / ' + entry.tokens.output.toLocaleString() : '用量缺失' }}</td><td>{{ bands[entry.band] }}<span class="table-subtitle">{{ entry.cny === null ? '待核算' : '¥ ' + entry.cny.toFixed(6) }}</span></td><td><Disclosure label="查看记录"><p>{{ entry.note || '请求级 usage' }}</p><p class="text-muted small-text">价格版本：{{ entry.price?.id || '未匹配' }}</p><pre class="task-technical">{{ JSON.stringify(entry.raw, null, 2) }}</pre></Disclosure></td></tr>
      <tr v-if="!data.items.length"><td colspan="5" class="text-muted">暂无符合条件的用量记录</td></tr>
    </tbody></table></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page = $event" />
  </section>
</template>
<style scoped>
.usage-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin-bottom:20px}.usage-totals>div{display:flex;flex-direction:column;gap:10px;min-width:0}.usage-totals span{font-size:12px;color:var(--muted)}.usage-totals strong{font-size:23px;font-weight:650;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.usage-note{margin:0 0 12px}.usage-table td:last-child{min-width:210px;max-width:300px;white-space:normal}.usage-table th:first-child{width:auto}
@media(max-width:1000px){.usage-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:500px){.usage-totals strong{font-size:19px}}
</style>
