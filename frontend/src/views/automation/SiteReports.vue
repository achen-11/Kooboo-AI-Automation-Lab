<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, ArrowUpRight, FileText, LoaderCircle } from '@lucide/vue';
import { formatDate, go } from '../../api';
import TablePagination from '../../components/TablePagination.vue';
import TaskReport from './TaskReport.vue';
import { useTaskSection } from './use-task-section';
import { scopeName } from './common';
import { scoreTone } from '../../lib/task-list';
import { reportLocation, siteReportLink } from '../../lib/site-reports';
import { taskStatusNames } from '../../../../shared/automation';
import type { SiteReportPage } from '../../../../shared/site-reports';

const props = defineProps<{ taskId: string; siteId: string; taskKind: 'generation' | 'evaluation'; revision: string; detailRevision: string }>();
const initial = reportLocation(window.location.hash.split('?')[1] || '', props.taskId, props.taskKind);
const selected = ref(initial.reportId), page = ref(initial.page);
const heading = ref<HTMLHeadingElement>(), back = ref<HTMLButtonElement>();
const { data, loading, error, load } = useTaskSection<SiteReportPage>(
  () => `/automation/site-deliveries/${props.siteId}/reports?page=${page.value}&pageSize=10`, () => props.revision);
const names: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const qualities = { passed: '达到标准', failed: '需要改进', unverified: '有待验证' };
// Poll compact metadata; an unchanged report should not reload all evidence every four seconds.
const selectedRevision = computed(() => JSON.stringify([props.detailRevision, data.value?.currentReportId, data.value?.items.find(item => item.id === selected.value)]));

function hashChanged() {
  const location = reportLocation(window.location.hash.split('?')[1] || '', props.taskId, props.taskKind);
  selected.value = location.reportId; page.value = location.page;
}
async function navigate(reportId: string | null, targetPage = data.value?.page || page.value) {
  selected.value = reportId; page.value = targetPage;
  go(siteReportLink(props.taskId, reportId, targetPage).slice(1));
  await nextTick();
  if (reportId) back.value?.focus();
  else heading.value?.focus();
}
onMounted(() => window.addEventListener('hashchange', hashChanged));
onUnmounted(() => window.removeEventListener('hashchange', hashChanged));
</script>

<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <template v-if="selected">
    <div class="report-detail-navigation"><button ref="back" class="text-action" @click="navigate(null)"><ArrowLeft :size="16" />返回评测记录</button><a class="text-action" :href="`#/tasks/${selected}?tab=execution`">本次执行记录<ArrowUpRight :size="14" /></a></div>
    <TaskReport v-if="data || error" :key="selected" :task-id="selected" :site-id="siteId" :revision="selectedRevision" />
    <p v-else class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载评测结果…</p>
  </template>
  <section v-else class="panel task-data-panel">
    <div class="section-heading panel-heading"><h2 ref="heading" tabindex="-1">评测记录</h2><button v-if="data?.currentReportId" class="text-action" @click="navigate(data.currentReportId)">当前报告<ArrowUpRight :size="14" /></button></div>
    <p v-if="data && !data.currentReportId" class="report-current-note">当前版本（{{ scopeName(data.scope) }}）暂无有效报告，已有分数仅供历史查阅。</p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载评测记录…</p>
    <div v-if="data?.items.length" class="table-scroll" :aria-busy="loading"><table class="task-table report-history"><thead><tr><th>评测时间</th><th>范围</th><th>评分</th><th>结果</th><th /></tr></thead><tbody>
      <tr v-for="item in data.items" :key="item.id">
        <td class="date-cell">{{ formatDate(item.createdAt) }}<span v-if="item.optimizationRound" class="table-subtitle">修复 {{ item.optimizationRound }} 后复评</span></td>
        <td>{{ scopeName(item.scope) }}</td>
        <td><div v-if="item.report" class="report-history-scores"><span v-for="score in item.report.scores" :key="score.viewport" class="report-history-score" :class="scoreTone(score.value, data.targetScore)"><span>{{ names[score.viewport] || score.viewport }}</span><strong>{{ score.value ?? '—' }}</strong></span></div><span v-else class="text-muted">—</span></td>
        <td><template v-if="item.report"><span :class="item.report.quality === 'passed' ? 'success-text' : item.report.quality === 'failed' ? 'warning-text' : 'text-muted'">{{ qualities[item.report.quality] }}</span><span class="table-subtitle" :class="{ 'success-text': item.reportCurrent }">{{ item.reportCurrent ? '当前结果' : '历史报告' }}</span></template><span v-else class="status-badge" :class="item.status">{{ item.status === 'completed' ? '尚无有效报告' : taskStatusNames[item.status] }}</span></td>
        <td><button v-if="item.report" class="text-action" @click="navigate(item.id)">查看报告<ArrowUpRight :size="14" /></button><a v-else class="text-action" :href="`#/tasks/${item.id}?tab=execution`">查看执行<ArrowUpRight :size="14" /></a></td>
      </tr>
    </tbody></table></div>
    <div v-else-if="data && !error" class="empty-state"><FileText :size="30" /><h2>暂无评测记录</h2><p>独立评测与后续复评会汇总在这里。</p></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="navigate(null, $event)" />
  </section>
</template>

<style scoped>
.report-detail-navigation{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.report-current-note{margin:0;padding:0 24px 20px;color:var(--muted);font-size:13px;line-height:1.6}
.report-history{min-width:690px}.report-history td{vertical-align:middle}.report-history th:first-child{width:25%}
.report-history-scores{display:flex;flex-wrap:wrap;gap:6px}.report-history-score{display:inline-flex;align-items:baseline;gap:6px;padding:4px 7px;border-radius:5px;background:var(--field);font-variant-numeric:tabular-nums}.report-history-score>span{font-size:10px}.report-history-score>strong{font-size:15px;font-weight:600}.report-history-score.good{color:#16765d;background:#eaf7f1}.report-history-score.warning{color:#a65e0a;background:#fff4e5}.report-history-score.low{color:#b53b4b;background:#fff0f2}.report-history-score.unknown{color:var(--muted)}
</style>
