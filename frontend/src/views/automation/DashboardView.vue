<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { RefreshCw, ArrowUpRight, ChevronDown, ChevronUp, Layers, Globe, FolderOpen, Activity } from '@lucide/vue';
import type { EChartsCoreOption } from 'echarts/core';
import { api, message } from '../../api';
import BaseSelect from '../../components/BaseSelect.vue';
import Disclosure from '../../components/Disclosure.vue';
import TablePagination from '../../components/TablePagination.vue';
import { scenarios, type Scenario, type Scope } from '../../../../shared/automation';
import { dashboardStageNames, type AnalyticsUnit, type DashboardAnalytics, type DashboardStage, type EfficiencySummary } from '../../../../shared/dashboard-analytics';
import { formatDuration } from '../../../../shared/timing';
import { stageColors } from '../../lib/usage-composition';
const AnalyticsChart = defineAsyncComponent(() => import('../../components/AnalyticsChart.vue'));
const hour = 3600000, day = hour * 24, offset = hour * 8;
const bjInput = (at: number) => new Date(at + offset).toISOString().slice(0, 16);
const parseInput = (value: string) => Date.parse(value + ':00+08:00');
const today = () => Math.floor((Date.now() + offset) / day) * day - offset;
const range = ref({ start: today() - 6 * day, end: today() + day });
const preset = ref('7d'), customStart = ref(bjInput(range.value.start)), customEnd = ref(bjInput(range.value.end));
const scenario = ref<Scenario | 'all'>('site-template'), scope = ref<Scope | 'all'>('all'), unit = ref<AnalyticsUnit>('evaluation');
const granularity = ref<'hour' | 'day'>('day'), page = ref(1);
const compare = ref(false), compareStart = ref(''), compareEnd = ref(''), comparison = ref<{ start: number; end: number }>();
const consumptionMetric = ref<'cost' | 'time'>('cost'), efficiencyMetric = ref<'cost' | 'time'>('time');
const data = shallowRef<DashboardAnalytics>(), loading = ref(false), error = ref(''), inputError = ref(''), expanded = ref<string>();
const overviewData = shallowRef<DashboardAnalytics['overview']>();
const consumptionData = shallowRef<DashboardAnalytics>(), efficiencyData = shallowRef<DashboardAnalytics>();
let consumptionKey = '', efficiencyKey = '';
type UpdateRegion = 'all' | 'efficiency' | 'comparison' | 'page';
let version = 0, controller: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined;
const scenarioOptions = [{ value: 'all', label: '全部场景' }, ...Object.entries(scenarios).map(([value, label]) => ({ value, label }))];
const scopeOptions = [{ value: 'all', label: '全部范围' }, { value: 'homepage', label: '首页' }, { value: 'site', label: '全站' }];
const unitOptions = [{ value: 'evaluation', label: '一次评测' }, { value: 'generation', label: '一次生成' }, { value: 'workflow', label: '完整流程' }];
const presets = [{ value: 'today', label: '今日' }, { value: 'yesterday', label: '昨日' }, { value: '7d', label: '近 7 天' }, { value: '30d', label: '近 30 天' }, { value: 'custom', label: '自定义' }];
const unitName = computed(() => unitOptions.find(item => item.value === unit.value)!.label);
const money = (value: number | null) => value === null ? '—' : '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const count = (value: number) => value.toLocaleString('zh-CN');
const date = (at: number | null) => at === null ? '未记录' : bjInput(at).replace('T', ' ').slice(5);
const duration = (at: number | null) => at === null ? '—' : formatDuration(at);
const statusNames = { completed: '已完成', active: '进行中', queued: '排队中', failed: '失败', interrupted: '已中断', cancelled: '已停止', pending: '待处理' };
function setPreset(value: string) {
  preset.value = value;
  if (value === 'custom') { customStart.value = bjInput(range.value.start); customEnd.value = bjInput(range.value.end); return; }
  const end = value === 'yesterday' ? today() : today() + day;
  range.value = { start: end - (value === '7d' ? 7 : value === '30d' ? 30 : 1) * day, end };
  granularity.value = value === 'today' || value === 'yesterday' ? 'hour' : 'day';
  customStart.value = bjInput(range.value.start); customEnd.value = bjInput(range.value.end); inputError.value = '';
}
function validRange(start: number, end: number, hourly = false) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= (hourly ? 31 : 93) * day;
}
function applyRange() {
  const start = parseInput(customStart.value), end = parseInput(customEnd.value);
  if (!validRange(start, end)) { inputError.value = '请选择有效的起止时间，最多 93 天。'; return; }
  inputError.value = ''; granularity.value = end - start <= 2 * day ? 'hour' : 'day'; range.value = { start, end };
}
function applyComparison() {
  const start = parseInput(compareStart.value), end = parseInput(compareEnd.value);
  if (!validRange(start, end)) { inputError.value = '请选择有效的对比时段，最多 93 天。'; return; }
  inputError.value = ''; comparison.value = { start, end };
}
watch(compare, enabled => {
  if (enabled) { const length = range.value.end - range.value.start; comparison.value = { start: range.value.start - length, end: range.value.start }; compareStart.value = bjInput(comparison.value.start); compareEnd.value = bjInput(comparison.value.end); }
  else comparison.value = undefined;
});
function drillBucket(index: number) {
  const bucket = data.value?.buckets[index]; if (!bucket) return;
  preset.value = 'custom'; range.value = { start: bucket.start, end: bucket.end }; granularity.value = 'hour'; customStart.value = bjInput(bucket.start); customEnd.value = bjInput(bucket.end);
}
function openTask(id: string) { window.location.hash = '/tasks/' + id; }
async function load(region: UpdateRegion = 'all') {
  const own = ++version; controller?.abort();
  if (!validRange(range.value.start, range.value.end, granularity.value === 'hour')) { loading.value = false; inputError.value = '按小时最多查询 31 天，请缩小时段或改为按天。'; return; }
  controller = new AbortController(); loading.value = true; error.value = '';
  const query = new URLSearchParams({ start: String(range.value.start), end: String(range.value.end), granularity: granularity.value, scenario: scenario.value, scope: scope.value, unit: unit.value, page: String(page.value) });
  const requestedConsumptionKey = JSON.stringify([range.value.start, range.value.end, granularity.value, scenario.value, scope.value]);
  const requestedEfficiencyKey = requestedConsumptionKey + ':' + unit.value;
  if (compare.value && comparison.value) { query.set('compareStart', String(comparison.value.start)); query.set('compareEnd', String(comparison.value.end)); }
  try {
    const result = await api<DashboardAnalytics>('/automation/dashboard/analytics?' + query, { signal: controller.signal });
    if (own === version) {
      // Keep unrelated charts and their interaction state intact during local updates.
      const updateConsumption = region === 'all' || consumptionKey !== requestedConsumptionKey;
      const updateEfficiency = region === 'all' || region === 'efficiency' || efficiencyKey !== requestedEfficiencyKey;
      const previous = data.value;
      if (updateConsumption) { consumptionData.value = result; consumptionKey = requestedConsumptionKey; overviewData.value = result.overview; }
      if (updateEfficiency) { efficiencyData.value = result; efficiencyKey = requestedEfficiencyKey; }
      if (!previous || updateConsumption) data.value = result;
      else if (updateEfficiency) data.value = { ...result, consumption: previous.consumption, buckets: result.buckets.map((bucket, index) => ({ ...bucket, stages: previous.buckets[index]!.stages, queueMs: previous.buckets[index]!.queueMs })) };
      else data.value = { ...previous, comparison: result.comparison, ...(region === 'page' ? { runs: result.runs } : {}) };
      if (!previous || updateConsumption || updateEfficiency || region === 'page') page.value = result.runs.page;
    }
  }
  catch (cause) { if (own === version) error.value = message(cause); }
  finally { if (own === version) loading.value = false; }
}
watch([range, scenario, scope, unit, granularity, comparison], (current, previous) => {
  const region: UpdateRegion = [0, 1, 2, 4].some(index => current[index] !== previous[index]) ? 'all' : current[3] !== previous[3] ? 'efficiency' : 'comparison';
  if (region !== 'comparison') { page.value = 1; expanded.value = undefined; }
  inputError.value = ''; void load(region);
});
function changePage(value: number) { page.value = value; expanded.value = undefined; void load('page'); }
onMounted(() => { void load(); timer = setInterval(() => { if (!loading.value && document.visibilityState === 'visible') void load(); }, 30000); });
onUnmounted(() => { version++; controller?.abort(); clearInterval(timer); });
const overview = computed(() => overviewData.value ? [
  { label: '资源', value: overviewData.value.resources, icon: FolderOpen, href: '#/resources' },
  { label: '生成站', value: overviewData.value.sites, icon: Globe, href: '#/tasks' },
  { label: '累计流程', value: overviewData.value.workflows, icon: Layers, href: '#/tasks' },
  { label: '运行中 / 排队', value: overviewData.value.running + ' / ' + overviewData.value.queued, icon: Activity, href: '#/tasks' },
] : []);
function delta(current: number | null, previous: number | null) { if (current === null || previous === null || previous === 0) return '无可比样本'; const value = (current - previous) / previous * 100; return (value > 0 ? '+' : '') + value.toFixed(1) + '%'; }
const bucketLabel = (at: number) => granularity.value === 'hour' ? (range.value.end - range.value.start <= day ? bjInput(at).slice(11) : bjInput(at).slice(5).replace('T', ' ')) : bjInput(at).slice(5, 10);
function chartOption(efficiency: boolean): EChartsCoreOption {
  const value = efficiency ? efficiencyData.value : consumptionData.value, metric = efficiency ? efficiencyMetric.value : consumptionMetric.value, isTime = metric === 'time';
  const buckets = value?.buckets || [], names = Object.keys(dashboardStageNames).filter(key => {
    const stage = key as DashboardStage;
    return efficiency ? value?.efficiency.stages.some(item => item.stage === stage && (item.averageCost || item.averageMs)) : value?.consumption.stages.some(item => item.stage === stage && (item.knownCny || item.recordedMs || item.missingCosts));
  }) as DashboardStage[];
  const series: Record<string, unknown>[] = names.map(stage => ({ name: dashboardStageNames[stage], type: 'bar', stack: 'total', barMaxWidth: 42, itemStyle: { color: stageColors[stage] },
    data: buckets.map(bucket => {
      if (efficiency) { const item = bucket.efficiency.stages.find(item => item.stage === stage); const amount = isTime ? item?.averageMs : item?.averageCost; return amount === null || amount === undefined ? null : isTime ? amount / 60000 : amount; }
      const item = bucket.stages.find(item => item.stage === stage); return isTime ? (item?.recordedMs || 0) / 60000 : item?.knownCny || 0;
    }),
  }));
  if (efficiency) series.push({ name: '单次任务', type: 'scatter', symbolSize: 8, itemStyle: { color: '#273852', borderColor: '#fff', borderWidth: 1, opacity: .7 }, z: 5,
    tooltip: { trigger: 'item', formatter: (raw: unknown) => { const item = raw as { name: string; value: number[] }; return item.name + '\n' + (isTime ? formatDuration(item.value[1] * 60000) : money(item.value[1])); } },
    data: (value?.points || []).filter(point => isTime ? point.durationMs !== null : point.costComplete).map(point => {
      const index = buckets.findIndex(bucket => point.startedAt >= bucket.start && point.startedAt < bucket.end);
      return { value: [index, isTime ? point.durationMs! / 60000 : point.knownCny], runId: point.id, name: point.name };
    }).filter(point => point.value[0] >= 0),
  });
  return {
    animation: false, textStyle: { fontFamily: 'Avenir Next, PingFang SC, Microsoft YaHei, sans-serif', color: '#7b8699' }, aria: { enabled: true },
    grid: { left: 64, right: 24, top: 32, bottom: buckets.length > 31 ? 94 : 70 },
    tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, valueFormatter: (raw: unknown) => typeof raw === 'number' ? isTime ? formatDuration(raw * 60000) : money(raw) : '无完整样本' },
    legend: { bottom: 4, type: 'scroll', icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11, color: '#637086' } },
    xAxis: { type: 'category', data: buckets.map(bucket => bucketLabel(bucket.start)), axisLine: { lineStyle: { color: '#edf0f5' } }, axisTick: { show: false }, axisLabel: { hideOverlap: true, rotate: 0, margin: 14, fontSize: 11 } },
    yAxis: { type: 'value', name: isTime ? '分钟' : '元', nameTextStyle: { padding: [0, 18, 0, 0] }, splitLine: { lineStyle: { color: '#edf0f5', type: 'dashed' } }, axisLabel: { fontSize: 11, formatter: (amount: number) => amount >= 10000 ? (amount / 10000).toFixed(1) + '万' : String(Number(amount.toFixed(2))) } },
    dataZoom: buckets.length > 31 ? [{ type: 'slider', bottom: 34, height: 14, borderColor: 'transparent', showDetail: false, start: Math.max(0, (1 - 31 / buckets.length) * 100), end: 100 }] : [], series,
  };
}
const consumptionChart = computed(() => chartOption(false)), efficiencyChart = computed(() => chartOption(true));
const finished = (value: EfficiencySummary) => value.completed + value.failed + value.interrupted + value.cancelled;
const coverage = computed(() => data.value ? data.value.efficiency.completed + ' / ' + data.value.efficiency.selected : '—');
</script>

<template>
  <div class="dashboard">
    <header class="page-header"><h1>耗时与成本</h1><button class="icon-button" :disabled="loading" aria-label="刷新统计" @click="load()"><RefreshCw :size="18" :class="{spin:loading}" /></button></header>
    <p v-if="error" class="alert error" role="alert">{{error}}<button class="text-action" @click="load()">重试</button></p>
    <div v-if="overview.length" class="platform-overview"><a v-for="item in overview" :key="item.label" :href="item.href"><component :is="item.icon" :size="18" /><div><span>{{item.label}}</span><strong>{{typeof item.value==='number'?count(item.value):item.value}}</strong></div><ArrowUpRight :size="14" class="overview-arrow" /></a></div>
    <section class="period-panel" aria-label="时段统计">
      <div class="dashboard-controls" role="group" aria-label="统计筛选">
        <div class="date-presets"><button v-for="item in presets" :key="item.value" :class="{selected:preset===item.value}" :aria-pressed="preset===item.value" @click="setPreset(item.value)">{{item.label}}</button></div>
        <div class="filter-selects"><BaseSelect v-model="scenario" :options="scenarioOptions" size="small" aria-label="统计场景" /><BaseSelect v-model="scope" :options="scopeOptions" size="small" aria-label="生成范围" /><BaseSelect v-model="granularity" :options="[{value:'hour',label:'按小时'},{value:'day',label:'按天'}]" size="small" aria-label="时间粒度" /></div>
        <form v-if="preset==='custom'" class="date-form" @submit.prevent="applyRange"><label>开始<input v-model="customStart" type="datetime-local" required aria-label="统计开始时间（北京时间）" /></label><span>—</span><label>结束<input v-model="customEnd" type="datetime-local" required aria-label="统计结束时间（北京时间）" /></label><button class="button secondary" type="submit">应用时段</button></form>
        <p v-if="inputError" class="field-error" role="alert">{{inputError}}</p>
      </div>
      <div class="range-heading"><span>{{date(range.start)}} — {{date(range.end)}} <small>北京时间 · 结束时刻不含在内</small></span><small v-if="data">{{date(data.generatedAt)}} 更新</small></div>
      <p v-if="loading&&!data" class="section-loading" role="status">正在汇总统计…</p>
      <div v-if="data" class="period-metrics" role="group" aria-label="时段概览">
        <div><span>时段费用</span><strong>{{money(data.consumption.knownCny)}}</strong><small>{{count(data.consumption.requests)}} 次请求</small></div>
        <div><span>累计执行时间</span><strong>{{data.consumption.executionMs===null?'未完整记录':duration(data.consumption.executionMs)}}</strong><small v-if="data.consumption.timing.incomplete">已记录 {{duration(data.consumption.recordedMs)}} · 完整计时 {{data.consumption.timing.complete}} / {{data.consumption.timing.tasks}} 个任务</small><small>另有排队 {{duration(data.consumption.queueMs)}}</small></div>
        <div><span>{{unitName}} · 完成 / 选中</span><strong>{{coverage}}</strong><small>{{data.efficiency.active}} 进行中 · {{data.efficiency.queued}} 排队中</small></div>
        <div><span>失败 / 中断 / 停止</span><strong>{{data.efficiency.failed}} / {{data.efficiency.interrupted}} / {{data.efficiency.cancelled}}</strong><small>{{data.efficiency.pending}} 待处理 · 消耗计入总量</small></div>
      </div>
    </section>
    <template v-if="data">
      <section class="panel chart-panel">
        <div class="chart-heading"><div><h2>时段消耗</h2><p>{{consumptionMetric==='cost'?'按请求发生时间统计费用':(data.consumption.timing.incomplete?'仅含已记录区间 · '+data.consumption.timing.incomplete+' 个任务计时不全':'按实际执行区间拆分，跨任务累计')}}<span v-if="range.end>Date.now()"> · 当前时段持续累计</span></p></div><div class="metric-switch" aria-label="消耗指标"><button :class="{selected:consumptionMetric==='cost'}" :aria-pressed="consumptionMetric==='cost'" @click="consumptionMetric='cost'">费用</button><button :class="{selected:consumptionMetric==='time'}" :aria-pressed="consumptionMetric==='time'" @click="consumptionMetric='time'">耗时</button></div></div>
        <div v-if="!data.consumption.requests&&!data.consumption.recordedMs" class="chart-empty">该时段暂无已记录的消耗</div><AnalyticsChart v-else :option="consumptionChart" :label="'按阶段堆叠的时段消耗；明细可在下方数据表查看'" @bucket="drillBucket" />
      </section>
      <section class="panel chart-panel efficiency-panel" :aria-busy="loading">
        <div class="chart-heading"><div class="efficiency-title"><h2>任务效率</h2><BaseSelect v-model="unit" :options="unitOptions" size="small" aria-label="效率统计单位" /><RefreshCw v-if="loading" class="spin" :size="14" role="status" aria-label="正在更新任务效率" /></div><div class="metric-switch" aria-label="效率指标"><button :class="{selected:efficiencyMetric==='cost'}" :aria-pressed="efficiencyMetric==='cost'" @click="efficiencyMetric='cost'">平均费用</button><button :class="{selected:efficiencyMetric==='time'}" :aria-pressed="efficiencyMetric==='time'" @click="efficiencyMetric='time'">平均耗时</button></div></div>
        <div class="efficiency-stats"><div><span>{{efficiencyMetric==='time'?'平均执行耗时':'平均完整费用'}}</span><strong>{{efficiencyMetric==='time'?duration(data.efficiency.averageMs):money(data.efficiency.averageCost)}}</strong><small>{{efficiencyMetric==='time'?data.efficiency.timingSamples:data.efficiency.costSamples}} 个完整样本 / {{data.efficiency.completed}} 个已完成任务</small></div><p>按开始时间归组，完整耗时归回开始的时段。<br />柱形为阶段均值，圆点为单次任务，点击可查看。</p><label class="compare-toggle"><input v-model="compare" type="checkbox" />对比时段</label></div>
        <form v-if="compare" class="comparison-form date-form" @submit.prevent="applyComparison"><label>对比开始<input v-model="compareStart" type="datetime-local" required aria-label="对比开始时间" /></label><span>—</span><label>对比结束<input v-model="compareEnd" type="datetime-local" required aria-label="对比结束时间" /></label><button class="button secondary" type="submit">更新对比</button></form>
        <div v-if="compare&&data.comparison" class="comparison-results"><div><span>对比时段</span><strong>{{efficiencyMetric==='time'?duration(data.comparison.efficiency.averageMs):money(data.comparison.efficiency.averageCost)}}</strong><small>{{date(data.comparison.start)}} — {{date(data.comparison.end)}}</small></div><div><span>变化</span><strong>{{efficiencyMetric==='time'?delta(data.efficiency.averageMs,data.comparison.efficiency.averageMs):delta(data.efficiency.averageCost,data.comparison.efficiency.averageCost)}}</strong><small>当前 / 对比完整样本：{{efficiencyMetric==='time'?data.efficiency.timingSamples:data.efficiency.costSamples}} / {{efficiencyMetric==='time'?data.comparison.efficiency.timingSamples:data.comparison.efficiency.costSamples}}</small></div><p>对比时段已结束 {{finished(data.comparison.efficiency)}} / {{data.comparison.efficiency.selected}}，进行中 {{data.comparison.efficiency.active}}。<br />完成数、范围与结果需一起判断。</p></div>
        <p v-if="data.efficiency.active||data.efficiency.queued" class="sample-note">仍有 {{data.efficiency.active}} 次进行中、{{data.efficiency.queued}} 次排队，当前均值会随任务完成更新。</p>
        <p v-if="data.efficiency.missingStarts" class="sample-note">{{data.efficiency.missingStarts}} 次历史任务缺少执行起点，仅按创建时间列入明细，不参与效率均值与小时趋势。</p>
        <p class="efficiency-context">平均开始到结束 {{duration(data.efficiency.averageElapsedMs)}}（{{data.efficiency.elapsedSamples}} 个样本）<span v-if="unit!=='generation'"> · 已完成任务的评测结果：{{data.efficiency.quality.passed}} 通过 / {{data.efficiency.quality.failed}} 未通过 / {{data.efficiency.quality.unverified+data.efficiency.quality.missing}} 待验证</span></p>
        <div v-if="!(efficiencyMetric==='time'?data.efficiency.timingSamples:data.efficiency.costSamples)" class="chart-empty">暂无可用于计算均值的完整样本</div><AnalyticsChart v-else :option="efficiencyChart" :label="unitName+'按开始时间归组的平均消耗和单次任务分布'" @bucket="drillBucket" @point="openTask" />
        <p v-if="data.pointTotal>1000" class="sample-note">趋势均值覆盖全部样本；散点展示最近 1,000 次完整计时任务。</p>
      </section>
      <section class="panel run-panel"><div class="chart-heading"><h2>任务明细</h2><span class="muted">{{unitName}} · 按开始时间从近到远</span></div><div class="table-scroll"><table class="task-table"><thead><tr><th>资源 / 范围</th><th>开始 → 结束</th><th>状态</th><th>费用</th><th>执行耗时</th><th>结果</th><th><span class="sr-only">阶段明细</span></th></tr></thead><tbody>
        <template v-for="run in data.runs.items" :key="run.id"><tr><td><a class="run-link" :href="'#/tasks/'+run.taskId">{{run.name}}<ArrowUpRight :size="13" /></a><small>{{run.scope==='homepage'?'首页':'全站'}}<span v-if="unit==='workflow'"> · {{run.repairs}} 轮修复</span></small></td><td class="date-cell">{{date(run.startedAt)}}<small>{{run.startedAt===null?'创建 '+date(run.createdAt):'→ '+(run.endedAt===null?'尚未结束':date(run.endedAt))}}</small></td><td><span class="run-status" :class="run.status">{{statusNames[run.status]}}</span></td><td>{{run.requests?money(run.knownCny):'—'}}</td><td>{{run.status==='active'?duration(run.recordedMs)+'（已记录）':duration(run.durationMs)}}<small v-if="run.queueMs">排队 {{duration(run.queueMs)}}</small></td><td>{{run.quality==='passed'?'评测通过':run.quality==='failed'?'评测未通过':run.quality==='unverified'?'未验证':'—'}}</td><td><button class="icon-button" :aria-expanded="expanded===run.id" :aria-label="'查看'+run.name+'的阶段消耗'" @click="expanded=expanded===run.id?undefined:run.id"><ChevronUp v-if="expanded===run.id" :size="16"/><ChevronDown v-else :size="16"/></button></td></tr>
          <tr v-if="expanded===run.id" class="run-expanded"><td colspan="7"><div class="stage-breakdown"><div v-for="stage in run.stages.filter(item=>item.requests||item.recordedMs)" :key="stage.stage"><span><i :style="{background:stageColors[stage.stage]}"/>{{dashboardStageNames[stage.stage]}}</span><strong>{{money(stage.knownCny)}} </strong><span>{{stage.recordedMs?duration(stage.recordedMs):'计时未记录'}}</span></div></div><p v-if="!run.timingComplete">历史阶段计时不完整。已记录阶段 {{duration(run.recordedMs)}}；模型请求累计 {{duration(run.modelMs)}}，不能代替完整执行耗时。</p><p v-else>从开始到结束 {{duration(run.elapsedMs)}}；排队 {{duration(run.queueMs)}}；费用包含该任务的后续后台整理。</p></td></tr>
        </template><tr v-if="!data.runs.items.length"><td colspan="7" class="empty-state">此时段没有符合条件的任务</td></tr>
      </tbody></table></div><TablePagination :page="data.runs.page" :pages="data.runs.pages" :total="data.runs.total" :busy="loading" @change="changePage" /></section>
      <Disclosure label="查看时段数据与统计口径"><div class="analytics-notes"><p>费用按请求开始时间归属，为用量估算，最终以官方账单为准。<span v-if="data.consumption.unplacedRequests">另有 {{data.consumption.unplacedRequests}} 次请求缺少时间，未放入时段消耗。</span></p><p>累计执行时间跨任务相加，同一任务内嵌阶段不重复计算；排队单列。执行时间不等于用户等待时间。历史缺失不补猜，维护中断不推算停机期间的执行时间。</p><p>完整流程包含自动交接的评测与修复；独立继续生成和手动评测另算。效率按实际开始时间归组，完整流程按发起时间归组。仅已完成且对应数据完整的任务参与均值；失败、中断和停止的消耗保留在总量及明细中。阶段平均值使用同一组样本。</p><p>执行结束不等于质量达标，明细展示该流程适用评测的原有结论；范围与后续站点变化请进入任务核对。对比只反映所选时段的样本差异，不自动归因于某次优化。</p><div class="table-scroll"><table class="task-table"><thead><tr><th>时段开始</th><th>费用</th><th>累计执行</th><th>完成 / 选中</th><th>平均费用</th><th>平均耗时</th><th>查看</th></tr></thead><tbody><tr v-for="(bucket,index) in data.buckets" :key="bucket.start"><td>{{date(bucket.start)}}</td><td>{{money(bucket.stages.reduce((sum,item)=>sum+item.knownCny,0))}}</td><td>{{duration(bucket.stages.reduce((sum,item)=>sum+item.recordedMs,0))}}</td><td>{{bucket.efficiency.completed}} / {{bucket.efficiency.selected}}</td><td>{{money(bucket.efficiency.averageCost)}} <small>n={{bucket.efficiency.costSamples}}</small></td><td>{{duration(bucket.efficiency.averageMs)}} <small>n={{bucket.efficiency.timingSamples}}</small></td><td><button class="text-action" @click="drillBucket(index)">此时段</button></td></tr></tbody></table></div></div></Disclosure>
    </template>
  </div>
</template>

<style scoped>
.dashboard{max-width:1600px;margin:0 auto}.dashboard .page-header{margin-bottom:20px}.dashboard .page-header h1{font-size:28px}.platform-overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:28px}.platform-overview>a{display:flex;align-items:center;gap:14px;background:var(--paper);padding:20px 22px;min-width:0}.platform-overview>a>svg{color:var(--muted)}.platform-overview span{display:block;color:var(--muted);font-size:12px}.platform-overview strong{font-size:25px;font-weight:650;line-height:1.4;font-variant-numeric:tabular-nums}.overview-arrow{margin-left:auto;opacity:.5}.platform-overview>a:hover{background:#fafbfe}.period-panel{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px 22px 0;margin-bottom:20px;overflow:hidden}.dashboard-controls{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.date-presets,.metric-switch{display:inline-flex;align-items:center;gap:3px;flex:none}.date-presets button,.metric-switch button{white-space:nowrap;border-radius:7px;padding:8px 12px;color:#6b778b;font-size:13px}.date-presets button:hover,.metric-switch button:hover{background:#eaf0f8}.date-presets .selected{color:var(--paper);background:var(--ink);font-weight:600}.filter-selects{display:flex;gap:8px;align-items:center}.filter-selects>.ui-select{width:auto;min-width:108px;max-width:180px}.range-heading{display:flex;justify-content:space-between;gap:10px;margin:14px 0 18px;font-size:12px;color:#66758a}.range-heading small{font-size:11px;color:var(--muted);margin-left:8px}.date-form{display:flex;align-items:end;flex-wrap:wrap;gap:10px;width:100%;padding:12px 0 0}.date-form>label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:11px}.date-form input{border:1px solid #dfe5ef;background:var(--paper);border-radius:7px;padding:8px 10px;min-height:36px;font-size:12px;max-width:100%}.date-form>span{padding-bottom:8px;color:var(--muted)}.date-form .button{min-height:36px;padding:7px 12px;font-size:12px}.field-error{width:100%;color:var(--red);font-size:12px}.period-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);padding:20px 0}.period-metrics>div{min-width:0;padding:0 22px}.period-metrics>div:first-child{padding-left:0}.period-metrics>div:last-child{padding-right:0}.period-metrics>div+div{border-left:1px solid var(--line)}.period-metrics>div>span,.efficiency-stats>div>span{font-size:12px;color:#68768a;display:block}.period-metrics strong{font-size:26px;letter-spacing:-.6px;line-height:1.5;display:block;margin:8px 0;font-variant-numeric:tabular-nums;font-weight:650}.period-metrics small{display:block;font-size:11px;line-height:1.8;color:var(--muted)}.chart-panel{border:1px solid var(--line);border-radius:12px;padding:22px 22px 15px;margin-bottom:20px;box-shadow:none}.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}.dashboard h2{font-size:16px;white-space:nowrap;font-weight:650}.chart-heading p{font-size:12px;color:var(--muted);margin-top:4px}.metric-switch{background:#f4f6fa;border-radius:8px;padding:3px}.metric-switch button{font-size:12px;padding:6px 12px}.metric-switch .selected{background:var(--paper);color:var(--ink);box-shadow:0 1px 4px #23345110;font-weight:600}.chart-empty{height:260px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}.efficiency-title{display:flex;align-items:center;gap:14px}.efficiency-title>.ui-select{width:135px;min-width:0}.efficiency-stats{display:flex;align-items:center;gap:30px;padding:22px 0 8px}.efficiency-stats strong{display:block;font-size:30px;font-weight:650;letter-spacing:-.6px;line-height:1.5;font-variant-numeric:tabular-nums}.efficiency-stats small{display:block;font-size:11px;color:var(--muted);margin-top:3px}.efficiency-stats p{font-size:12px;color:var(--muted);line-height:1.9}.compare-toggle{display:flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap;margin-left:auto;cursor:pointer;color:#637086}.comparison-form{padding-bottom:14px}.comparison-results{display:flex;align-items:center;gap:26px;padding:14px 18px;border-radius:8px;background:#f6f8fc;margin:12px 0}.comparison-results span,.comparison-results small{display:block;font-size:11px;color:var(--muted)}.comparison-results strong{display:block;font-size:20px;font-weight:600;margin:4px 0}.comparison-results p{font-size:11px;color:var(--muted);margin-left:auto;line-height:1.9}.sample-note{font-size:12px;color:#8c753e;padding-top:12px}.efficiency-context{font-size:11px;color:var(--muted);padding:12px 0 4px;line-height:1.9}.run-panel{border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:none}.run-panel>.chart-heading{padding:20px 22px}.muted{font-size:12px;color:var(--muted)}.table-scroll{overflow-x:auto}.task-table{width:100%;border-collapse:collapse}.task-table td{font-size:12px;vertical-align:middle;font-variant-numeric:tabular-nums}.task-table th{font-size:11px;font-weight:500;white-space:nowrap}.task-table td:not(:first-child){white-space:nowrap}.task-table td>small{display:block;color:var(--muted);font-size:10px;margin-top:4px}.run-link{display:flex;align-items:center;gap:5px;max-width:260px;overflow:hidden;text-overflow:ellipsis}.run-link:hover{color:var(--blue)}.date-cell{font-size:11px!important}.run-status{display:inline-flex;align-items:center;gap:6px;color:#718096;font-size:11px}.run-status:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}.run-status.completed{color:var(--green)}.run-status.active{color:var(--blue)}.run-status.failed,.run-status.interrupted{color:var(--red)}.run-expanded>td{background:#fafbfd;padding:18px 22px}.run-expanded p{font-size:11px;color:var(--muted);margin-top:12px;white-space:normal}.stage-breakdown{display:flex;flex-wrap:wrap;gap:22px}.stage-breakdown>div{display:flex;flex-direction:column;gap:6px;min-width:100px}.stage-breakdown span{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px}.stage-breakdown i{width:8px;height:8px;border-radius:2px}.stage-breakdown strong{font-size:13px;font-weight:500}.stage-breakdown small{font-size:10px;font-weight:400;color:var(--muted)}.analytics-notes{font-size:12px;color:var(--muted);line-height:1.9}.analytics-notes p+p{margin-top:8px}.analytics-notes .table-scroll{margin-top:16px}.analytics-notes small{font-size:10px}.dashboard>.disclosure{margin-top:8px}
@media(max-width:1100px){.period-metrics{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:20px}.period-metrics>div:nth-child(3){border-left:0;padding-left:0}.period-metrics>div:nth-child(2){padding-right:0}.platform-overview>a{padding:16px 14px;gap:9px}.platform-overview strong{font-size:22px}.overview-arrow{display:none}.efficiency-stats{gap:20px}.range-heading{flex-wrap:wrap}.filter-selects{margin-left:auto}}
@media(max-width:650px){.dashboard .page-header h1{font-size:24px}.platform-overview{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:20px}.period-panel{padding:16px 14px 0}.dashboard-controls{gap:10px}.filter-selects{margin-left:0;flex-wrap:wrap;width:100%}.filter-selects>.ui-select{flex:1;min-width:90px}.date-presets{gap:1px;flex-wrap:wrap}.date-presets button{padding:7px 10px;font-size:12px}.period-metrics{row-gap:18px;padding:18px 0}.period-metrics>div{padding:0 12px}.period-metrics strong{font-size:22px}.chart-panel{padding:16px 10px 12px}.chart-heading{gap:10px;flex-wrap:wrap}.efficiency-stats{gap:12px;flex-wrap:wrap;padding:18px 6px 8px}.efficiency-stats strong{font-size:26px}.efficiency-stats p{display:none}.comparison-results{flex-wrap:wrap;gap:14px}.comparison-results p{width:100%;margin-left:0}.range-heading small{margin-left:0}.range-heading>span>small{display:block;margin-top:4px}.date-form{gap:8px}.date-form>label{min-width:0;flex:1}.date-form input{width:100%}.date-form>span{display:none}.efficiency-title{gap:8px}.metric-switch button{padding:6px 9px}.run-panel>.chart-heading{padding:16px}.stage-breakdown{gap:18px}}
</style>
