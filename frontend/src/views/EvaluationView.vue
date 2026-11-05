<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, ArrowUpRight, RotateCw, Check, Flag, Monitor, Smartphone, Columns2, Layers2, LoaderCircle, X, Clock3, CircleAlert } from '@lucide/vue';
import { api, platform, statusNames, formatDate, score, scoreClass, message, go } from '../api';
import type { Evaluation, Run, Screenshot } from '../../../backend/shared/types';

const props = defineProps<{ id: string }>();
interface Detail extends Evaluation { siteEvaluations: Evaluation[]; runs: Run[]; runEvents: Record<string, { seq: number; occurredAt: number; message: string }[]> }
const item = ref<Detail | null>(null), error = ref(''), notice = ref(''), busy = ref(false);
const selectedRunId = ref(''), tab = ref('compare'), viewport = ref('desktop'), region = ref('top'), mode = ref('split'), opacity = ref(50);
const reviewDialog = ref<HTMLDialogElement>(), preview = ref<HTMLElement>();
const decision = ref<'accepted' | 'rework'>('accepted'), reviewNote = ref(''), reviewError = ref('');
const run = computed(() => item.value?.runs.find((entry) => entry.id === selectedRunId.value) || item.value?.run);
const report = computed(() => run.value?.report);
const current = computed(() => run.value?.id === item.value?.run.id);
const terminal = computed(() => !!item.value && ['completed','failed'].includes(item.value.run.status));
const screenshots = computed(() => run.value?.evidence?.screenshots || []);
const targetShot = computed(() => screenshots.value.find((shot) => shot.role === 'target' && shot.viewport === viewport.value && shot.region === region.value));
const referenceShot = computed(() => screenshots.value.find((shot) => shot.role === 'reference' && shot.viewport === viewport.value && shot.region === region.value));
const events = computed(() => run.value ? item.value?.runEvents[run.value.id] || [] : []);
const issues = computed(() => report.value?.issues || run.value?.evidence?.issues || []);
let disposed = false;
let timer: ReturnType<typeof setInterval>;
async function load(): Promise<void> {
  try { const result = await api<Detail>(`/evaluations/${props.id}`); if (!disposed) { item.value = result; error.value = ''; } }
  catch (reason) { if (!disposed) error.value = message(reason); }
}
onMounted(() => { void load(); timer = setInterval(() => { void load(); }, 4000); });
onUnmounted(() => { disposed = true; clearInterval(timer); });
function artifact(shot: Screenshot): string { return `/api/evaluations/${props.id}/artifacts/${run.value!.id}/${shot.file}`; }
function dimensionName(id: string): string { return run.value?.snapshot?.rule.dimensions.find((entry) => entry.id === id)?.label || id; }
async function rerun(): Promise<void> {
  busy.value = true; error.value = ''; notice.value = '';
  try { await api(`/evaluations/${props.id}/runs`, { method: 'POST' }); selectedRunId.value = ''; await load(); notice.value = '已加入重评队列，历史报告保留'; }
  catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
function openReview(value: 'accepted' | 'rework'): void { decision.value = value; reviewNote.value = ''; reviewError.value = ''; reviewDialog.value?.showModal(); }
async function review(): Promise<void> {
  if (!item.value) return;
  busy.value = true;
  try { await api(`/evaluations/${props.id}/reviews`, { method: 'POST', body: JSON.stringify({ decision: decision.value, note: reviewNote.value, runId: item.value.run.id }) }); reviewDialog.value?.close(); await load(); notice.value = decision.value === 'accepted' ? '已记录人工复核通过' : '已标记需返工'; }
  catch (reason) { reviewError.value = message(reason); }
  finally { busy.value = false; }
}
async function showEvidence(id: string): Promise<void> {
  const shot = screenshots.value.find((entry) => entry.id === id);
  if (!shot) return;
  viewport.value = shot.viewport; region.value = shot.region; tab.value = 'compare';
  await nextTick(); preview.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <a class="back-link" href="#/evaluations"><ArrowLeft :size="17" />评测任务</a>
  <header class="page-header detail-header"><div><h1>{{ item?.siteDomain || item?.submission.jobId || '评测报告' }}</h1><p v-if="item">{{ item.targetUrl || item.submission.target.koobooOrigin }}<span class="dot-separator">·</span>{{ formatDate(item.createdAt) }}</p></div><div class="toolbar-actions"><button class="button secondary" :disabled="!terminal || busy" @click="rerun()"><RotateCw :size="17" />重新评测</button><button class="button primary" :disabled="!terminal || busy || !current" @click="openReview('accepted')"><Check :size="17" />人工通过</button></div></header>
  <p v-if="error" class="alert error" role="alert">{{ error }}</p><p v-if="notice" class="alert success" role="status">{{ notice }}</p>
  <template v-if="item && run">
    <label v-if="item.siteEvaluations.length > 1" class="site-history"><span>站点评测记录</span><select :value="item.id" class="input compact-select" @change="go(`/evaluations/${($event.target as HTMLSelectElement).value}`)"><option v-for="entry in item.siteEvaluations" :key="entry.id" :value="entry.id">{{ formatDate(entry.submission.occurredAt) }} · {{ entry.submission.jobId }} · {{ statusNames[entry.run.status] }}</option></select></label>
    <div class="report-meta"><span class="status-badge" :class="run.status"><i />{{ statusNames[run.status] }}</span><span v-if="current && item.needsReview" class="badge warning">需复核</span><span v-if="current && item.review" class="badge" :class="item.review.decision === 'accepted' ? 'good' : 'warning'">{{ item.review.decision === 'accepted' ? '人工已通过' : '需返工' }}</span><select v-model="selectedRunId" class="history-select" aria-label="选择评测记录"><option value="">当前评测</option><option v-for="(entry, index) in item.runs" :key="entry.id" :value="entry.id">{{ index === 0 ? '当前' : '历史' }} · {{ formatDate(entry.createdAt) }} · {{ statusNames[entry.status] }}</option></select></div>
    <p v-if="run.error" class="alert error" role="alert"><CircleAlert :size="18" /><span>{{ run.error }}</span></p>
    <p v-if="['queued','collecting','scoring'].includes(run.status)" class="alert info"><LoaderCircle class="spin" :size="18" /><span>{{ run.status === 'queued' && (!platform.settings?.model.endpoint || !platform.settings.model.name) ? '任务已保存，等待配置视觉模型接口' : run.status === 'queued' && platform.settings?.paused ? '队列已暂停，恢复后会继续处理' : '任务正在处理，报告会自动更新' }}</span><a v-if="run.status === 'queued'" href="#/settings">设置<ArrowUpRight :size="15" /></a></p>

    <div class="report-scores">
      <section class="panel score-panel"><span>UI 还原度</span><strong :class="scoreClass(report?.fidelityScore)">{{ score(report?.fidelityScore) }}<small v-if="report?.fidelityScore != null">/ 100</small></strong><p>{{ report?.fidelityScore == null ? report ? '缺少可用视觉参考或证据' : '等待评测结果' : `按 ${run.snapshot?.rule.version} 加权汇总` }}</p></section>
      <section class="panel score-panel"><span>任务完成度</span><strong :class="scoreClass(report?.completionScore)">{{ score(report?.completionScore) }}<small v-if="report?.completionScore != null">/ 100</small></strong><p>{{ report?.completionScore == null ? '需要可读取且有明确要求的资料' : '按提供资料中的可验证要求评估' }}</p></section>
      <section class="panel score-panel health-panel"><span>页面可用性</span><strong :class="report?.health === 'critical' ? 'score-low' : report?.health === 'warning' ? 'warning-text' : report ? 'score-good' : 'score-unknown'">{{ report ? report.health === 'ok' ? '可访问' : report.health === 'warning' ? '有异常' : '严重异常' : '待检查' }}</strong><p>{{ report ? '静态加载与资源检查' : '等待采集页面证据' }}</p></section>
    </div>
    <section v-if="report" class="panel report-summary"><div class="section-heading"><h2>评测结论</h2><span class="badge muted">{{ { high: '较高可信度', medium: '中等可信度', low: '低可信度' }[report.confidence] }}</span></div><p>{{ report.summary }}</p><p v-if="!report.coverage.complete || !report.stable" class="coverage-note"><CircleAlert :size="17" /><span>{{ !report.coverage.complete ? report.coverage.note : '采集期间页面内容变化，请人工复核' }}</span></p></section>

    <div class="toolbar report-tabs"><div class="segmented"><button :class="{ selected: tab === 'compare' }" @click="tab = 'compare'">截图对照</button><button :class="{ selected: tab === 'issues' }" @click="tab = 'issues'">分项与问题<span>{{ issues.length }}</span></button><button :class="{ selected: tab === 'events' }" @click="tab = 'events'">执行记录</button></div><button class="text-button warning-text" :disabled="!terminal || !current || busy" @click="openReview('rework')"><Flag :size="16" />标记返工</button></div>

    <section v-if="tab === 'compare'" ref="preview" class="panel comparison-panel">
      <div class="comparison-toolbar"><div class="segmented compact"><button :class="{ selected: viewport === 'desktop' }" @click="viewport = 'desktop'"><Monitor :size="16" />桌面</button><button :class="{ selected: viewport === 'mobile' }" @click="viewport = 'mobile'"><Smartphone :size="16" />移动</button></div><div class="toolbar-actions"><select v-model="region" class="input compact-select" aria-label="页面截图位置"><option value="top">页面顶部</option><option value="middle">页面中部</option><option value="bottom">页面底部</option></select><button class="icon-button" :class="{ 'is-active': mode === 'split' }" aria-label="并排对照" @click="mode = 'split'"><Columns2 :size="19" /></button><button class="icon-button" :class="{ 'is-active': mode === 'overlay' }" :disabled="!targetShot || !referenceShot" aria-label="叠图对照" @click="mode = 'overlay'"><Layers2 :size="19" /></button></div></div>
      <template v-if="mode === 'split' || !targetShot || !referenceShot"><div class="comparison-grid" :class="{ 'mobile-comparison': viewport === 'mobile' }"><figure><figcaption><span>视觉参考</span><a v-if="item.submission.inputs.referenceUrl" :href="item.submission.inputs.referenceUrl" target="_blank" rel="noreferrer" aria-label="打开参考站"><ArrowUpRight :size="16" /></a></figcaption><a v-if="referenceShot" :href="artifact(referenceShot)" target="_blank" rel="noreferrer"><img :src="artifact(referenceShot)" alt="参考站截图" /></a><div v-else class="image-placeholder">{{ item.submission.inputs.referenceUrl ? '此位置暂无参考截图' : '未提供视觉参考站' }}</div></figure><figure><figcaption><span>生成站点</span><a v-if="run.evidence?.targetUrl || item.targetUrl" :href="run.evidence?.targetUrl || item.targetUrl!" target="_blank" rel="noreferrer" aria-label="打开生成站点"><ArrowUpRight :size="16" /></a></figcaption><a v-if="targetShot" :href="artifact(targetShot)" target="_blank" rel="noreferrer"><img :src="artifact(targetShot)" alt="生成站点截图" /></a><div v-else class="image-placeholder">等待此位置的采集证据</div></figure></div></template>
      <template v-else><label class="overlay-control">生成站点透明度<input v-model.number="opacity" type="range" min="0" max="100" /><span>{{ opacity }}%</span></label><div class="overlay-images" :class="{ 'mobile-overlay': viewport === 'mobile' }"><img :src="artifact(referenceShot)" alt="底层参考截图" /><img class="overlay-target" :src="artifact(targetShot)" :style="{ opacity: opacity / 100 }" alt="叠加目标截图" /></div></template>
      <footer v-if="targetShot" class="evidence-footer">{{ targetShot.width }} × {{ targetShot.height }}<span>采集于 {{ formatDate(targetShot.capturedAt) }}</span></footer>
    </section>

    <template v-else-if="tab === 'issues'">
      <section v-if="report?.dimensions.length" class="panel dimension-results"><h2>视觉分项</h2><div v-for="dimension in report.dimensions" :key="dimension.id" class="dimension-result"><div class="dimension-result-head"><h3>{{ dimensionName(dimension.id) }}</h3><strong :class="scoreClass(dimension.score)">{{ dimension.score }}</strong></div><p>{{ dimension.reason }}</p><div class="evidence-links"><button v-for="id in dimension.evidence" :key="id" class="evidence-link" @click="showEvidence(id)">{{ id }}</button></div></div></section>
      <section class="panel issue-list"><h2>问题清单</h2><p v-if="!issues.length" class="section-note">{{ report ? '本轮没有记录具体问题，请结合证据和覆盖范围判断' : '执行完成后显示问题与证据' }}</p><article v-for="(issue, index) in issues" :key="index" class="issue"><div class="issue-title"><span class="severity-dot" :class="issue.severity" /><h3>{{ issue.title }}</h3><span class="badge" :class="issue.severity === 'critical' ? 'bad' : 'warning'">{{ { critical: '严重', major: '主要', minor: '轻微' }[issue.severity] }}</span></div><p>{{ issue.detail }}</p><div class="evidence-links"><template v-for="id in issue.evidence" :key="id"><button v-if="screenshots.some((shot) => shot.id === id)" class="evidence-link" @click="showEvidence(id)">{{ id }}</button><span v-else class="text-muted small-text">{{ id }}</span></template></div></article></section>
    </template>
    <section v-else class="panel event-panel"><h2>本轮执行记录</h2><ol class="event-timeline"><li v-for="event in events" :key="event.seq"><Clock3 :size="16" /><div><p>{{ event.message }}</p><time>{{ formatDate(event.occurredAt) }}</time></div></li></ol><div v-if="run.snapshot" class="run-facts"><span>规则 {{ run.snapshot.rule.version }}</span><span>模型 {{ run.snapshot.model.name }}</span><span>规则指纹 {{ run.snapshot.ruleHash.slice(0, 16) }}</span></div></section>
    <p class="page-footnote">{{ report?.coverage.note || '评分依据本轮采集证据，静态截图不代表交互或动效已验收。' }} · 规则待校准</p>
  </template>
  <div v-else-if="!error" class="empty-state"><span class="spinner" />正在读取报告…</div>

  <dialog ref="reviewDialog" class="modal"><form @submit.prevent="review()"><div class="modal-head"><h2>{{ decision === 'accepted' ? '人工复核通过' : '标记需返工' }}</h2><button class="icon-button" type="button" aria-label="关闭" @click="reviewDialog?.close()"><X :size="20" /></button></div><p class="text-muted">复核结论单独保存，保留原始分数和报告。</p><label class="field"><span>复核备注 <small>可选</small></span><textarea v-model="reviewNote" class="input textarea" maxlength="1000" placeholder="记录判断依据或下一步处理要求" /></label><p v-if="reviewError" class="alert error" role="alert">{{ reviewError }}</p><div class="modal-actions"><button type="button" class="button secondary" @click="reviewDialog?.close()">取消</button><button class="button primary" :disabled="busy">{{ busy ? '保存中…' : '确认记录' }}</button></div></form></dialog>
</template>
