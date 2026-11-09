<script setup lang="ts">
import { computed, ref } from 'vue';
import { LoaderCircle, FileText, ExternalLink, ChevronDown, ChevronRight, Image, Download } from '@lucide/vue';
import { taskStatusNames, type AutomationReport, type AutomationRule, type OptimizationProgress } from '../../../../shared/automation';
import Disclosure from '../../components/Disclosure.vue';
import TablePagination from '../../components/TablePagination.vue';
import CompletenessReport from '../../components/CompletenessReport.vue';
import EvidenceViewer from '../../components/EvidenceViewer.vue';
import { evidenceLabel, type EvidenceContext } from '../../lib/evidence-preview';
import { useTaskSection } from './use-task-section';
import { formatDate } from '../../api';
import { scopeName } from './common';
const props = defineProps<{ taskId: string; revision: string; siteId?: string }>();
const selectedRound=ref<number|null>(null);
const { data, loading, error, load } = useTaskSection<{ taskId: string | null; report: AutomationReport | null; rule: AutomationRule | null; evaluation?: {scope: 'homepage' | 'site'; createdAt: number}; historical?:boolean; selectedRound?:{brief?:string;progress?:OptimizationProgress}; optimization?:{rounds:{number:number;evaluationTaskId?:string;generationTaskId:string;status:keyof typeof taskStatusNames;scores:AutomationReport['scores']|null;summary:string}[]} }>(() => props.siteId ? `/automation/site-deliveries/${props.siteId}/reports/${encodeURIComponent(props.taskId)}` : `/automation/tasks/${props.taskId}/sections/report${selectedRound.value===null?'':'?round='+selectedRound.value}`, () => props.revision);
const names: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const qualities = { passed: '达到标准', failed: '需要改进', unverified: '有待验证' };
const severity = { critical: '严重', major: '主要', minor: '次要' };
const issueOpen = ref<number | null>(null), allEvidence = ref(false), page = ref(1);
const viewer = ref<InstanceType<typeof EvidenceViewer>>();
const images = computed(() => data.value?.report?.artifacts.filter(file => file.type === 'image/png') || []);
const issueContexts = computed<EvidenceContext[]>(() => data.value?.report?.issues || []);
const assessmentContexts = computed<EvidenceContext[]>(() => data.value?.report?.assessments.map(item => ({
  title: (data.value?.rule?.criteria.find(criterion => criterion.id === item.criterionId)?.label || item.criterionId) + ' · ' + names[item.viewport],
  detail: item.reason, evidence: item.evidence,
})) || []);
const pages = computed(() => Math.max(1, Math.ceil(images.value.length / 12)));
const visibleImages = computed(() => images.value.slice((page.value - 1) * 12, page.value * 12));
function artifact(name: string) { return `/api/v1/automation/reports/${data.value?.taskId}/artifacts/${encodeURIComponent(name)}`; }
function isImage(name: string) { return images.value.some(file => file.name === name); }
function label(name: string, index: number) { const file = images.value.find(file => file.name === name); return file ? evidenceLabel(file, index) : '证据文件 ' + (index + 1); }
function openGallery(name: string) {
  void viewer.value?.open([{ title: '全部截图', detail: '', evidence: images.value.map(file => file.name) }], 0, name, false);
}
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载评测结果…</p>
  <div v-if="data?.evaluation" class="section-heading"><h2>{{ scopeName(data.evaluation.scope) }}评测</h2><span class="text-muted small-text">{{ formatDate(data.evaluation.createdAt) }}</span></div>
  <section v-if="data?.optimization" class="panel settings-panel"><div class="section-heading"><h2>优化轮次</h2><button class="text-action" :disabled="selectedRound===null" @click="selectedRound=null">当前版本</button></div><div class="table-scroll"><table class="task-table"><thead><tr><th>轮次</th><th>状态</th><th>PC / 移动端</th><th>主要变化</th><th /></tr></thead><tbody><tr v-for="round in data.optimization.rounds" :key="round.number"><td>{{round.number?'修复 '+round.number:'初评'}}</td><td>{{taskStatusNames[round.status]}}</td><td>{{round.scores?round.scores.map(s=>(names[s.viewport]||s.viewport)+' '+(s.value??'未验证')).join(' / '):'待复评'}}</td><td class="wrapping-cell">{{round.summary}}</td><td><button class="text-action" :disabled="loading" @click="selectedRound=round.number">查看本轮</button></td></tr></tbody></table></div></section>
  <p v-if="data?.historical" class="alert info">正在查看历史报告，不代表当前站点状态。</p>
  <section v-if="data?.selectedRound?.brief||data?.selectedRound?.progress" class="panel settings-panel"><Disclosure v-if="data.selectedRound.brief" label="本轮修复委托"><pre class="task-technical">{{data.selectedRound.brief}}</pre></Disclosure><template v-if="data.selectedRound.progress"><p class="task-prose">{{data.selectedRound.progress.reason}}</p><Disclosure v-for="group in ([['resolved','已解决'],['remaining','仍存在'],['unverified','未验证'],['introduced','新增问题']] as const)" :key="group[0]" :label="group[1]"><ul class="task-text-list"><li v-for="text in data.selectedRound.progress[group[0]]" :key="text">{{text}}</li></ul></Disclosure></template></section>
  <section v-if="data && !data.report" class="panel empty-state"><FileText :size="30" /><h2>尚未生成有效报告</h2><p>任务仍在执行或尚未发起评测时，不显示零分。</p></section>
  <template v-if="data?.report">
    <CompletenessReport v-if="data.report.completeness && data.taskId" :key="data.taskId" :task-id="data.taskId" />
    <section v-if="data.report.collectionTarget" class="panel settings-panel">
      <div class="section-heading"><h2>资料 → 站点核验</h2><span>{{ {complete:'通过',incomplete:'有缺失',unverified:'未验证',pending:'取证中'}[data.report.collectionTarget.state] }}</span></div>
      <p>已核对 {{ data.report.collectionTarget.checkedPages }} / {{ data.report.collectionTarget.expectedPages }} 个来源路径。</p>
      <Disclosure label="程序检查明细"><ul class="task-text-list"><li v-for="check in data.report.collectionTarget.checks" :key="check.id">{{ check.sourcePath || check.requirementId || check.id }}：{{ {verified:'通过',missing:'有缺失',unverified:'未验证'}[check.status] }} · {{ check.reason }}</li></ul></Disclosure>
    </section>
    <div class="report-score-grid"><section class="panel report-verdict"><span>质量结论</span><h2 :class="data.report.quality === 'passed' ? 'success-text' : 'warning-text'">{{ qualities[data.report.quality] }}</h2></section><section v-for="item in data.report.scores" :key="item.viewport" class="panel report-score"><span>{{ names[item.viewport] || item.viewport }}</span><strong>{{ item.value ?? '—' }}</strong><small>{{ item.value === null ? '未验证' : '按本轮规则计算' }}</small></section></div>
    <section class="panel settings-panel">
      <h2>评测结论</h2><p class="report-summary">{{ data.report.summary }}</p>
      <Disclosure label="分项评分与依据"><div class="table-scroll"><table class="task-table">
        <thead><tr><th>指标 / 视口</th><th>评分</th><th>依据</th></tr></thead>
        <tbody><tr v-for="(item, assessmentIndex) in data.report.assessments" :key="item.criterionId + item.viewport">
          <td>{{ data.rule?.criteria.find(c => c.id === item.criterionId)?.label || item.criterionId }}<span class="table-subtitle">{{ names[item.viewport] }}</span></td><td>{{ item.score ?? '未验证' }}</td>
          <td class="wrapping-cell">{{ item.reason }}<div class="evidence-links"><template v-for="(file, index) in item.evidence" :key="file">
            <button v-if="isImage(file)" class="text-action" @click="viewer?.open(assessmentContexts, assessmentIndex, file)"><Image :size="13" />{{ label(file, index) }}</button>
            <a v-else :href="artifact(file)" download>{{ label(file, index) }}<Download :size="12" /></a>
          </template></div></td>
        </tr></tbody>
      </table></div></Disclosure>
    </section>
    <section class="panel settings-panel">
      <div class="section-heading"><h2>问题清单</h2><span class="text-muted small-text">{{ data.report.issues.length }} 项</span></div>
      <p v-if="!data.report.issues.length" class="text-muted">没有已取证的问题，请同时查看覆盖范围。</p>
      <article v-for="(issue, index) in data.report.issues" :key="index" class="report-issue">
        <div class="issue-heading"><span class="status-badge" :class="issue.severity === 'minor' ? 'pending' : 'failed'">{{ severity[issue.severity] }}</span><h3>{{ issue.title }}</h3></div><p class="task-prose">{{ issue.detail }}</p>
        <button v-if="issue.evidence.length" class="text-action issue-evidence-toggle" :aria-expanded="issueOpen === index" @click="issueOpen = issueOpen === index ? null : index"><ChevronDown v-if="issueOpen === index" :size="16" /><ChevronRight v-else :size="16" />{{ issueOpen === index ? '收起证据' : '查看相关证据' }}</button>
        <div v-if="issueOpen === index" class="evidence-grid"><template v-for="(file, fileIndex) in issue.evidence" :key="file">
          <button v-if="isImage(file)" class="evidence-preview-card" :aria-label="'预览' + label(file, fileIndex)" @click="viewer?.open(issueContexts, index, file)"><img :src="artifact(file)" loading="lazy" :alt="issue.title + '，' + label(file, fileIndex)" /><span>{{ label(file, fileIndex) }}<Image :size="13" /></span></button>
          <a v-else :href="artifact(file)" download><span>{{ label(file, fileIndex) }}<Download :size="13" /></span></a>
        </template></div>
      </article>
    </section>
    <section class="panel settings-panel task-section-stack"><h2>覆盖范围</h2><div><h3>未验证（{{ data.report.coverage.unverified.length }}）</h3><ul v-if="data.report.coverage.unverified.length" class="task-text-list"><li v-for="text in data.report.coverage.unverified" :key="text">{{ text }}</li></ul><p v-else class="text-muted">报告未列出未验证项。</p></div><Disclosure :label="'已验证（' + data.report.coverage.verified.length + '）'"><ul class="task-text-list"><li v-for="text in data.report.coverage.verified" :key="text">{{ text }}</li></ul></Disclosure><Disclosure :label="'范围之外（' + data.report.coverage.outOfScope.length + '）'"><ul class="task-text-list"><li v-for="text in data.report.coverage.outOfScope" :key="text">{{ text }}</li></ul></Disclosure></section>
    <section class="panel settings-panel"><div class="section-heading"><button class="text-action" :aria-expanded="allEvidence" @click="allEvidence = !allEvidence"><ChevronDown v-if="allEvidence" :size="16" /><ChevronRight v-else :size="16" />全部截图（{{ images.length }}）</button><a class="text-action" :href="`/api/v1/automation/reports/${data.taskId}`" target="_blank" rel="noopener noreferrer">报告 JSON<ExternalLink :size="14" /></a></div><template v-if="allEvidence"><div class="evidence-grid"><button v-for="(file, index) in visibleImages" :key="file.id" class="evidence-preview-card" :aria-label="'预览' + label(file.name, (page - 1) * 12 + index)" @click="openGallery(file.name)"><img :src="artifact(file.name)" loading="lazy" :alt="label(file.name, (page - 1) * 12 + index)" /><span>{{ label(file.name, (page - 1) * 12 + index) }}<Image :size="13" /></span></button></div><TablePagination :page="page" :pages="pages" :total="images.length" @change="page = $event" /></template></section>
    <EvidenceViewer v-if="data.taskId" ref="viewer" :task-id="data.taskId" :artifacts="data.report.artifacts" />
  </template>
</template>
