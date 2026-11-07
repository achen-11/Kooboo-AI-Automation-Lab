<script setup lang="ts">
import { notify } from '../lib/notifications';
import BaseSelect from '../components/BaseSelect.vue';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowLeft, ArrowUpRight, RotateCw, Check, Flag, LoaderCircle, X, Clock3, CircleAlert } from '@lucide/vue';
import EvaluationStages from '../components/EvaluationStages.vue';
import ScreenshotComparison from '../components/ScreenshotComparison.vue';
import { api, platform, runStatusName, formatDate, score, scoreClass, message, go } from '../api';
import type { Evaluation, Run, RetryMode } from '../../../shared/types';

import type { Issue } from '../../../shared/types';
import type { IssueActions, RepairPayload, RepairTarget } from '../../../shared/issue-actions';
import { connectRepairWindow } from '../lib/repair-handoff';
import { presentedIssues, presentedHealth } from '../../../shared/issue-presentation';

const props = defineProps<{ id: string }>();
interface Detail extends Evaluation { siteEvaluations: Evaluation[]; runs: Run[]; issueActions: Record<string, IssueActions>; runEvents: Record<string, { seq: number; occurredAt: number; message: string }[]> }
const item = ref<Detail | null>(null), error = ref(''), busy = ref(false);
const selectedRunId = ref(''), tab = ref('compare');
const comparison = ref<InstanceType<typeof ScreenshotComparison>>();
const issuePreviews = ref<Record<number, { open: boolean; id?: string }>>({});
const reviewDialog = ref<HTMLDialogElement>(), preview = ref<HTMLElement>();
const decision = ref<'accepted' | 'rework'>('accepted'), reviewNote = ref(''), reviewError = ref('');
const run = computed(() => item.value?.runs.find((entry) => entry.id === selectedRunId.value) || item.value?.run);
const report = computed(() => run.value?.report);
const current = computed(() => run.value?.id === item.value?.run.id);
const terminal = computed(() => !!item.value && ['completed','failed'].includes(item.value.run.status));
const screenshots = computed(() => run.value?.evidence?.screenshots || []);
watch(() => run.value?.id, () => { issuePreviews.value = {}; selectedIssues.value = []; showIgnored.value = false; repairDialog.value?.close(); });
const events = computed(() => [...(run.value ? item.value?.runEvents[run.value.id] || [] : [])].sort((a, b) => b.seq - a.seq));
const issues = computed(() => report.value?.issues || run.value?.evidence?.issues || []);
const issueEntries = computed(() => presentedIssues(issues.value));
const selectedIssues = ref<number[]>([]), showIgnored = ref(false), actionBusy = ref(false);
const actions = computed(() => item.value?.issueActions?.[run.value?.id || ''] || { ignored: [], handoffs: [] });
const ignored = computed(() => new Set(actions.value.ignored));
const ignoredCount = computed(() => issueEntries.value.filter(({ index }) => ignored.value.has(index)).length);
const activeIssues = computed(() => issueEntries.value.filter(({ index }) => !ignored.value.has(index)).map(({ issue }) => issue));
const canAct = computed(() => !!report.value && ['completed', 'failed'].includes(run.value?.status || ''));
const selection = computed(() => selectedIssues.value.filter(index => issueEntries.value.some(entry => entry.index === index) && !ignored.value.has(index)));
const latestHandoff = computed(() => actions.value.handoffs[0]);
const repairDialog = ref<HTMLDialogElement>(), repairTargets = ref<RepairTarget[]>([]), targetIndex = ref(0), repairError = ref(''), targetLoading = ref(false);
let disconnectRepair: (() => void) | undefined;
function selectIssue(index: number, checked: boolean): void { selectedIssues.value = checked ? [...new Set([...selectedIssues.value, index])] : selectedIssues.value.filter(i => i !== index); }
function issueIndex(issue: Issue): number { return issues.value.indexOf(issue); }
async function decideIssues(indices: number[], value: boolean): Promise<void> {
  if (!run.value) return;
  const runId = run.value.id;
  actionBusy.value = true;
  try {
    const result = await api<IssueActions>(`/evaluations/${props.id}/issue-decisions`, { method: 'POST', body: JSON.stringify({ runId, indices, ignored: value }) });
    if (item.value) item.value.issueActions[runId] = result;
    if (value) selectedIssues.value = selectedIssues.value.filter(i => !indices.includes(i));
    notify.success(value ? '已忽略选中问题，原始评分保留' : '已恢复问题');
  } catch (reason) { error.value = message(reason); }
  finally { actionBusy.value = false; }
}
async function openRepair(): Promise<void> {
  repairError.value = ''; repairTargets.value = []; targetIndex.value = 0; targetLoading.value = true;
  repairDialog.value?.showModal();
  try {
    const result = await api<{ items: RepairTarget[]; warnings: string[] }>(`/evaluations/${props.id}/repair-targets`);
    repairTargets.value = result.items;
    repairError.value = result.warnings.join('；');
  } catch (reason) { repairError.value = message(reason); }
  finally { targetLoading.value = false; }
}
async function sendRepair(): Promise<void> {
  const target = repairTargets.value[targetIndex.value];
  if (!target || !selection.value.length || !run.value || !current.value || actionBusy.value) return;
  const popup = window.open('about:blank', '_blank');
  if (!popup) { repairError.value = '浏览器拦截了新窗口，请允许此页面打开窗口后重试'; return; }
  popup.document.title = '正在准备站点修复会话';
  popup.document.body.textContent = '正在准备评测问题与截图，请稍候…';
  const evaluationId = props.id, runId = run.value.id, indices = [...selection.value], id = crypto.randomUUID();
  actionBusy.value = true; repairError.value = '';
  try {
    const result = await api<{ target: RepairTarget; payload: RepairPayload; url: string }>(`/evaluations/${evaluationId}/issue-handoffs`, { method: 'POST', body: JSON.stringify({ id, runId, indices, environmentId: target.environmentId, siteId: target.siteId }) });
    disconnectRepair?.();
    disconnectRepair = connectRepairWindow(popup, result.target, result.payload, async receipt => {
      const status = receipt.accepted ? 'accepted' : receipt.error === 'unknown' ? 'unknown' : 'failed';
      try {
        await api(`/evaluations/${evaluationId}/issue-handoffs/${id}/receipt`, { method: 'POST', body: JSON.stringify({ runId, siteId: target.siteId, status, sessionId: receipt.sessionId }) });
        notify[receipt.accepted ? 'success' : 'warning'](receipt.accepted ? '站点 AI Chat 已接收，正在新会话中处理；修复结果请查看该会话' : status === 'unknown' ? '未收到接收回执，请先检查站点 AI Chat，避免重复发送' : receipt.error || 'AI Chat 未接收，请检查站点会话');
        await load();
      } catch (reason) { error.value = `接收状态保存失败：${message(reason)}。请检查站点会话，避免重复发送`; }
    });
    popup.location.href = result.url;
    repairDialog.value?.close(); notify.info('已打开站点 AI Chat，等待接收回执');
    await load();
  } catch (reason) { popup.close(); repairError.value = message(reason); }
  finally { actionBusy.value = false; }
}
const unscored = computed(() => ['completed','failed'].includes(run.value?.status || '') && report.value?.fidelityScore == null && report.value?.completionScore == null);
const fidelityReason = computed(() => !report.value ? run.value?.status === 'failed' ? '本轮执行失败，未完成评分' : '等待评测结果' : report.value.fidelityScore != null ? `按 ${run.value?.snapshot?.rule.version} 加权汇总` : report.value.referenceStatus === 'unavailable' ? '参考站采集失败，无法进行 UI 对比' : report.value.referenceStatus === 'not_provided' ? '未提供视觉参考站，无法对比 UI' : '截图证据不足，无法进行 UI 对比');
const completionReason = computed(() => !report.value ? run.value?.status === 'failed' ? '本轮执行失败，未完成评分' : '等待评测结果' : report.value.completionScore != null ? '按提供资料中的可验证要求评估' : !run.value?.evidence?.readme ? item.value?.submission.inputs.materialsPath ? '资料包读取失败，无法评任务完成度' : '未提供资料包，本轮不评任务完成度' : '资料未提供可验证的完成要求');
const scoreBlockers = computed(() => {
  if (!report.value) return [];
  const blockers = report.value.fidelityScore == null ? issues.value.filter(issue => ['reference','target','materials'].includes(issue.dimension)).map(issue => issue.detail) : [];
  if (report.value.fidelityScore == null && !blockers.length) blockers.push(fidelityReason.value);
  if (report.value.completionScore == null) blockers.push(completionReason.value);
  return blockers;
});
const health = computed(() => report.value ? presentedHealth(report.value) : 'unknown');
const healthLabel = computed(() => !report.value ? run.value?.status === 'failed' ? '未完成检查' : '待检查' : { ok: '可访问', warning: '有异常', critical: '严重异常', unknown: '未完整检查' }[health.value]);
const healthClass = computed(() => !report.value || health.value === 'unknown' ? 'score-unknown' : health.value === 'critical' ? 'score-low' : health.value === 'warning' ? 'warning-text' : 'score-good');
let disposed = false;
let timer: ReturnType<typeof setInterval>;
async function load(): Promise<void> {
  try { const result = await api<Detail>(`/evaluations/${props.id}`); if (!disposed) { item.value = result; error.value = ''; } }
  catch (reason) { if (!disposed) error.value = message(reason); }
}
onMounted(() => { void load(); timer = setInterval(() => { void load(); }, 4000); });
onUnmounted(() => { disposed = true; clearInterval(timer); disconnectRepair?.(); });
function dimensionName(id: string): string { return run.value?.snapshot?.rule.dimensions.find((entry) => entry.id === id)?.label || id; }
async function rerun(mode: RetryMode = 'failed'): Promise<void> {
  busy.value = true; error.value = '';
  try { await api(`/evaluations/${props.id}/runs`, { method: 'POST', body: JSON.stringify({ mode, sourceRunId: item.value?.run.id }) }); selectedRunId.value = ''; await load(); notify.success(mode === 'all' ? '已加入完整重评队列，将重新采集全部证据' : '已加入阶段重试队列，成功证据将复用，历史记录保留'); }
  catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
function openReview(value: 'accepted' | 'rework'): void { decision.value = value; reviewNote.value = ''; reviewError.value = ''; reviewDialog.value?.showModal(); }
async function review(): Promise<void> {
  if (!item.value) return;
  busy.value = true;
  try { await api(`/evaluations/${props.id}/reviews`, { method: 'POST', body: JSON.stringify({ decision: decision.value, note: reviewNote.value, runId: item.value.run.id }) }); reviewDialog.value?.close(); await load(); notify.success(decision.value === 'accepted' ? '已记录人工复核通过' : '已标记需返工'); }
  catch (reason) { reviewError.value = message(reason); }
  finally { busy.value = false; }
}
async function showEvidence(id: string): Promise<void> {
  if (!screenshots.value.some(shot => shot.id === id)) return;
  tab.value = 'compare';
  await nextTick();
  await comparison.value?.focusEvidence(id);
  preview.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openIssueEvidence(index: number, id: string): void {
  issuePreviews.value[index] = { open: true, id };
}
function toggleIssue(index: number, event: Event): void {
  const open = (event.target as HTMLDetailsElement).open;
  issuePreviews.value[index] = { ...issuePreviews.value[index], open };
}
</script>

<template>
  <a class="back-link" href="#/evaluations"><ArrowLeft :size="17" />评测任务</a>
  <header class="page-header detail-header"><div><h1>{{ item?.siteDomain || item?.submission.jobId || '评测报告' }}</h1><p v-if="item">{{ item.targetUrl || item.submission.target.koobooOrigin }}<span class="dot-separator">·</span>{{ formatDate(item.createdAt) }}</p></div><div class="toolbar-actions"><button class="button secondary" :disabled="!terminal || busy || !current" @click="rerun('all')"><RotateCw :size="17" />完整重评</button><button class="button primary" :disabled="!terminal || busy || !current" @click="openReview('accepted')"><Check :size="17" />人工通过</button></div></header>
  <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  <template v-if="item && run">
    <label v-if="item.siteEvaluations.length > 1" class="site-history"><span>站点评测记录</span><BaseSelect :value="item.id" class="input compact-select" @change="go(`/evaluations/${($event.target as HTMLSelectElement).value}`)"><option v-for="entry in item.siteEvaluations" :key="entry.id" :value="entry.id">{{ formatDate(entry.submission.occurredAt) }} · {{ entry.submission.jobId }} · {{ runStatusName(entry.run) }}</option></BaseSelect></label>
    <div class="report-meta"><span class="status-badge" :class="[run.status, { unscored: run.status === 'completed' && report?.fidelityScore == null }]"><i />{{ runStatusName(run) }}</span><span v-if="current && item.needsReview" class="badge warning">需复核</span><span v-if="current && item.review" class="badge" :class="item.review.decision === 'accepted' ? 'good' : 'warning'">{{ item.review.decision === 'accepted' ? '人工已通过' : '需返工' }}</span><BaseSelect v-model="selectedRunId" class="history-select" aria-label="选择评测记录"><option value="">当前评测</option><option v-for="(entry, index) in item.runs" :key="entry.id" :value="entry.id">{{ index === 0 ? '当前' : '历史' }} · {{ formatDate(entry.createdAt) }} · {{ runStatusName(entry) }}</option></BaseSelect></div>
    <p v-if="run.error" class="alert error" role="alert"><CircleAlert :size="18" /><span>{{ run.error }}</span></p>
    <div v-if="['queued','collecting','scoring'].includes(run.status)" class="alert info"><LoaderCircle class="spin" :size="18" /><div class="execution-progress"><p>{{ run.status === 'queued' && platform.settings?.paused ? '队列已暂停，恢复后会继续处理' : events[0]?.message || '等待后台执行' }}</p><p>任务在服务器后台执行，刷新或关闭页面不会中断。</p></div><a v-if="run.status === 'queued'" href="#/settings">设置<ArrowUpRight :size="15" /></a></div>

    <EvaluationStages :run="run" :can-retry="terminal && current" :busy="busy" @retry="rerun" />

    <div class="report-scores">
      <section class="panel score-panel"><span>UI 还原度</span><strong :class="scoreClass(report?.fidelityScore)">{{ score(report?.fidelityScore) }}<small v-if="report?.fidelityScore != null">/ 100</small></strong><p>{{ fidelityReason }}</p></section>
      <section class="panel score-panel"><span>任务完成度</span><strong :class="scoreClass(report?.completionScore)">{{ score(report?.completionScore) }}<small v-if="report?.completionScore != null">/ 100</small></strong><p>{{ completionReason }}</p></section>
      <section class="panel score-panel health-panel"><span>页面可用性</span><strong :class="healthClass">{{ healthLabel }}</strong><p>{{ report ? '首页可见内容与页面异常检查' : '等待采集页面证据' }}</p></section>
    </div>
    <section v-if="report" class="panel report-summary"><div class="section-heading"><a class="text-button" :href="`/api/evaluations/${item.id}/reports/${run.id}`" download>下载报告 JSON</a><h2>{{ unscored ? '本轮未生成评分' : '评测结论' }}</h2><span class="badge muted">{{ { high: '较高可信度', medium: '中等可信度', low: '低可信度' }[report.confidence] }}</span></div><p>{{ report.summary }}</p><ul v-if="report.limitations?.length" class="score-blockers"><li v-for="limitation in report.limitations" :key="limitation">{{ limitation }}</li></ul><ul v-if="scoreBlockers.length" class="score-blockers"><li v-for="(blocker, index) in scoreBlockers" :key="index">{{ blocker }}</li></ul><p v-if="report.model.name === '未调用'" class="section-note">本轮未调用评分模型。修复采集问题或补齐资料后，可点击对应阶段的重试入口。</p><p v-if="!report.coverage.complete || !report.stable" class="coverage-note"><CircleAlert :size="17" /><span>{{ !report.coverage.complete ? report.coverage.note : '采集期间页面内容变化，请人工复核' }}</span></p></section>

    <div class="toolbar report-tabs"><div class="segmented"><button :class="{ selected: tab === 'compare' }" @click="tab = 'compare'">截图对照</button><button :class="{ selected: tab === 'issues' }" @click="tab = 'issues'">分项与问题<span>{{ issueEntries.length }}</span></button><button :class="{ selected: tab === 'events' }" @click="tab = 'events'">执行记录</button></div><button class="text-button warning-text" :disabled="!terminal || !current || busy" @click="openReview('rework')"><Flag :size="16" />标记返工</button></div>

    <div v-if="canAct && issueEntries.length && tab !== 'events'" class="issue-batch panel">
      <label><input type="checkbox" :checked="!!activeIssues.length && selection.length === activeIssues.length" :disabled="actionBusy" @change="selectedIssues = ($event.target as HTMLInputElement).checked ? issueEntries.map(({ index }) => index).filter(i => !ignored.has(i)) : []" />全选未忽略问题</label>
      <span>已选 {{ selection.length }} 项</span>
      <button class="text-button" :disabled="!selection.length || actionBusy" @click="decideIssues(selection, true)">忽略选中</button>
      <button class="button primary" :disabled="!selection.length || !current || actionBusy" @click="openRepair">发送到站点 AI Chat</button>
      <p v-if="latestHandoff" class="handoff-status" role="status">{{ { prepared: '等待 AI Chat 接收；如已关闭页面或超过两分钟，请先检查站点会话再发送', accepted: 'AI Chat 已接收，修复结果请查看站点会话', failed: '上批问题未接收', unknown: '接收状态未确认，请先检查站点会话，避免重复发送' }[latestHandoff.status] }}</p>
    </div>
    <section v-show="tab === 'compare'" ref="preview" class="panel comparison-panel">
      <ScreenshotComparison
        :key="run.id" ref="comparison" :evaluation-id="item.id" :run-id="run.id"
        :screenshots="screenshots" :pairings="report?.pairings" :issues="activeIssues"
        :target-url="run.evidence?.targetUrl || item.targetUrl || undefined"
        :reference-url="item.submission.inputs.referenceUrl"
        :reference-missing="!item.submission.inputs.referenceUrl ? '未提供视觉参考站' : undefined"
        :target-missing="terminal ? undefined : '后台正在采集，截图保存后会自动显示'"
      >
        <template #issue-actions="{ issue }"><div v-if="canAct" class="issue-actions"><label><input type="checkbox" :checked="selection.includes(issueIndex(issue))" :disabled="actionBusy" @change="selectIssue(issueIndex(issue), ($event.target as HTMLInputElement).checked)" />选择</label><button class="text-button" :disabled="actionBusy" @click="decideIssues([issueIndex(issue)], true)">忽略</button></div></template>
      </ScreenshotComparison>
    </section>

    <template v-if="tab === 'issues'">
      <section v-if="report?.dimensions.length" class="panel dimension-results"><h2>视觉分项</h2><div v-for="dimension in report.dimensions" :key="dimension.id" class="dimension-result"><div class="dimension-result-head"><h3>{{ dimensionName(dimension.id) }}</h3><strong :class="scoreClass(dimension.score)">{{ dimension.score }}</strong></div><p>{{ dimension.reason }}</p><div class="evidence-links"><button v-for="id in dimension.evidence" :key="id" class="evidence-link" @click="showEvidence(id)">{{ id }}</button></div></div></section>
      <section class="panel issue-list"><div class="section-heading"><h2>问题清单</h2><button v-if="ignoredCount" class="text-button" @click="showIgnored = !showIgnored">{{ showIgnored ? '隐藏' : '显示' }}已忽略（{{ ignoredCount }}）</button></div><p v-if="!issueEntries.length" class="section-note">{{ report ? '本轮没有记录具体问题，请结合证据和覆盖范围判断' : '执行完成后显示问题与证据' }}</p><p v-if="issueEntries.length && !activeIssues.length && !showIgnored" class="section-note">本轮问题已全部忽略，可点击“显示已忽略”恢复。</p><article v-for="{ issue, index } in issueEntries" :key="index" v-show="showIgnored || !ignored.has(index)" class="issue" :class="{ 'ignored-issue': ignored.has(index) }"><div class="issue-title"><input v-if="canAct && !ignored.has(index)" type="checkbox" :aria-label="`选择问题 ${index + 1}`" :checked="selection.includes(index)" :disabled="actionBusy" @change="selectIssue(index, ($event.target as HTMLInputElement).checked)" /><span class="severity-dot" :class="issue.severity" /><h3>{{ issue.title }}</h3><span class="badge" :class="issue.severity === 'critical' ? 'bad' : 'warning'">{{ { critical: '严重', major: '主要', minor: '轻微' }[issue.severity] }}</span><button v-if="canAct" class="text-button issue-ignore" :disabled="actionBusy" @click="decideIssues([index], !ignored.has(index))">{{ ignored.has(index) ? '恢复' : '忽略' }}</button></div><p>{{ issue.detail }}</p><div class="evidence-links"><template v-for="id in issue.evidence" :key="id"><button v-if="screenshots.some((shot) => shot.id === id)" class="evidence-link" @click="openIssueEvidence(index, id)">{{ id }}</button><span v-else class="text-muted small-text">{{ id }}</span></template></div>
        <details v-if="issue.evidence.some(id => screenshots.some(shot => shot.id === id))" class="issue-preview" :open="issuePreviews[index]?.open || false" @toggle="toggleIssue(index, $event)">
          <summary>截图对照</summary>
          <ScreenshotComparison v-if="issuePreviews[index]?.open" :key="`${run.id}:${index}`" compact
            :evaluation-id="item.id" :run-id="run.id" :screenshots="screenshots" :pairings="report?.pairings"
            :evidence-ids="issue.evidence" :initial-evidence-id="issuePreviews[index]?.id"
            :target-url="run.evidence?.targetUrl || item.targetUrl || undefined" :reference-url="item.submission.inputs.referenceUrl" />
        </details>
      </article></section>
    </template>
    <section v-else-if="tab === 'events'" class="panel event-panel"><h2>本轮执行记录</h2><ol class="event-timeline"><li v-for="event in events" :key="event.seq"><Clock3 :size="16" /><div><p>{{ event.message }}</p><time>{{ formatDate(event.occurredAt) }}</time></div></li></ol><div v-if="run.snapshot" class="run-facts"><span>规则 {{ run.snapshot.rule.version }}</span><span v-if="run.pipeline?.agent">Agent {{ run.pipeline.agent.iterations }} 轮 · {{ run.pipeline.agent.calls.length }} 次工具调用</span><span>模型 {{ run.snapshot.model.name }}</span><span>规则指纹 {{ run.snapshot.ruleHash.slice(0, 16) }}</span><span v-if="run.snapshot.execution">读取超时 {{ run.snapshot.execution.pageInfoTimeoutSeconds }} 秒 · 总预算 {{ Math.ceil(run.snapshot.execution.runBudgetMs / 60000) }} 分钟</span></div></section>
    <p class="page-footnote">{{ report?.coverage.note || '评分依据本轮采集证据，静态截图不代表交互或动效已验收。' }} · 规则待校准</p>
  </template>
  <div v-else-if="!error" class="empty-state"><span class="spinner" />正在读取报告…</div>

  <dialog ref="repairDialog" class="modal"><form @submit.prevent="sendRepair"><div class="modal-head"><h2>发送到站点 AI Chat</h2><button type="button" class="icon-button" aria-label="关闭" @click="repairDialog?.close()"><X :size="20" /></button></div>
    <p class="text-muted">新建该站点的修复会话，携带以下问题和关联截图。</p>
    <ul class="repair-selection"><li v-for="index in selection" :key="index">{{ issues[index]?.title }}</li></ul>
    <p v-if="targetLoading">正在匹配站点…</p>
    <label v-else-if="repairTargets.length" class="field"><span>修复站点</span><BaseSelect v-model.number="targetIndex" class="input"><option v-for="(target, index) in repairTargets" :key="`${target.environmentId}:${target.siteId}`" :value="index">{{ target.environmentName }} · {{ target.siteName }}（{{ target.origin }}）</option></BaseSelect></label>
    <p v-else class="alert info">未找到域名匹配的站点，请在设置中配置该站点所属的 Kooboo 环境。</p>
    <p v-if="repairError" class="alert error" role="alert">{{ repairError }}</p><div class="modal-actions"><button type="button" class="button secondary" @click="repairDialog?.close()">取消</button><button class="button primary" :disabled="targetLoading || !repairTargets.length || !selection.length || !current || actionBusy">{{ actionBusy ? '准备中…' : '新建会话并发送' }}</button></div>
  </form></dialog>
  <dialog ref="reviewDialog" class="modal"><form @submit.prevent="review()"><div class="modal-head"><h2>{{ decision === 'accepted' ? '人工复核通过' : '标记需返工' }}</h2><button class="icon-button" type="button" aria-label="关闭" @click="reviewDialog?.close()"><X :size="20" /></button></div><p class="text-muted">复核结论单独保存，保留原始分数和报告。</p><label class="field"><span>复核备注 <small>可选</small></span><textarea v-model="reviewNote" class="input textarea" maxlength="1000" placeholder="记录判断依据或下一步处理要求" /></label><p v-if="reviewError" class="alert error" role="alert">{{ reviewError }}</p><div class="modal-actions"><button type="button" class="button secondary" @click="reviewDialog?.close()">取消</button><button class="button primary" :disabled="busy">{{ busy ? '保存中…' : '确认记录' }}</button></div></form></dialog>
</template>

<style scoped>
.issue-batch, .issue-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.issue-batch { padding: 14px 18px; margin-bottom: 16px; }
.issue-batch label, .issue-actions label { display: flex; align-items: center; gap: 7px; }
.issue-batch > .button { margin-left: auto; }
.handoff-status { flex-basis: 100%; color: var(--muted); font-size: 12px; }
.issue-ignore { margin-left: auto; white-space: nowrap; }
.ignored-issue { color: var(--muted); }
.repair-selection { max-height: 220px; overflow: auto; padding-left: 22px; margin: 18px 0; }
.repair-selection li { margin: 8px 0; }

.issue-preview { margin-top: 12px; }
.issue-preview > summary { width: fit-content; color: var(--blue); font-size: 12px; cursor: pointer; padding: 5px 0; }
</style>
