<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Plus, Search, RotateCw, ChevronRight, ChevronLeft, ArrowUpRight, ScanLine, X, CircleAlert, LoaderCircle } from '@lucide/vue';
import { api, platform, statusNames, runStatusName, formatDate, score, scoreClass, go, message } from '../api';
import type { Evaluation } from '../../../shared/types';

interface Listing { items: Evaluation[]; total: number; summary: { total: number; active: number; needsReview: number; belowThreshold: number; completed: number } }
const listing = ref<Listing>({ items: [], total: 0, summary: { total: 0, active: 0, needsReview: 0, belowThreshold: 0, completed: 0 } });
const filter = ref('all'), query = ref(''), status = ref('all'), page = ref(1);
const loading = ref(true), saving = ref(false), error = ref('');
const manualDialog = ref<HTMLDialogElement>();
const form = ref({ jobId: '', targetUrl: '', referenceUrl: '', scope: 'homepage', ruleSetVersion: '' });
const rules = ref<{ version: string; name: string }[]>([]);
const formError = ref('');
const pages = computed(() => Math.max(1, Math.ceil(listing.value.total / 25)));
let disposed = false, sequence = 0;
let poll: ReturnType<typeof setInterval>;
let debounce: ReturnType<typeof setTimeout>;

async function load(): Promise<void> {
  const current = ++sequence;
  const params = new URLSearchParams({ page: String(page.value), q: query.value, status: status.value, latestPerSite: 'true' });
  if (filter.value === 'review') params.set('needsReview', 'true');
  if (filter.value === 'low') params.set('fidelityBelow', String(platform.settings?.threshold ?? 80));
  try {
    const result = await api<Listing>(`/evaluations?${params}`);
    if (!disposed && current === sequence) { listing.value = result; error.value = ''; if (page.value > pages.value) page.value = pages.value; }
  } catch (reason) { if (!disposed && current === sequence) error.value = message(reason); }
  finally { if (!disposed && current === sequence) loading.value = false; }
}
watch([filter, status], () => { page.value = 1; void load(); });
watch(query, () => { clearTimeout(debounce); debounce = setTimeout(() => { page.value = 1; void load(); }, 250); });
watch(page, () => { void load(); });
onMounted(() => { void load(); void api<{ items: { version: string; name: string }[] }>('/rules').then((result) => { rules.value = result.items; }).catch(() => {}); poll = setInterval(() => { void load(); }, 4000); });
onUnmounted(() => { disposed = true; clearInterval(poll); clearTimeout(debounce); });

function openCreate(): void {
  form.value = { jobId: `manual-${Date.now()}`, targetUrl: '', referenceUrl: '', scope: 'homepage', ruleSetVersion: '' };
  formError.value = '';
  manualDialog.value?.showModal();
}
async function submit(): Promise<void> {
  saving.value = true; formError.value = '';
  try {
    const result = await api<{ evaluationId: string }>('/manual-evaluations', { method: 'POST', body: JSON.stringify({ ...form.value, ruleSetVersion: form.value.ruleSetVersion || undefined }) });
    manualDialog.value?.close(); go(`/evaluations/${result.evaluationId}`);
  } catch (reason) { formError.value = message(reason); }
  finally { saving.value = false; }
}
function targetLabel(item: Evaluation): string {
  return item.siteDomain || '域名待解析';
}
</script>

<template>
  <header class="page-header">
    <div><h1>评测任务</h1><p>查看站点还原度，集中处理低分与需复核的结果</p></div>
    <button class="button primary" @click="openCreate()"><Plus :size="18" />新建评测</button>
  </header>
  <div v-if="!platform.settings?.model.endpoint || !platform.settings.model.name" class="alert info">
    <CircleAlert :size="18" /><span>先配置视觉模型接口，已接收的任务会保留在队列中。</span><a href="#/settings?tab=model">前往配置<ArrowUpRight :size="15" /></a>
  </div>
  <div v-else-if="platform.settings.paused" class="alert info"><span>任务执行已暂停，待处理记录会保留。</span><a href="#/settings">运行设置<ArrowUpRight :size="15" /></a></div>
  <div v-else-if="!platform.browserReady" class="alert info"><CircleAlert :size="18" /><span>本机 Chromium 尚未安装，请运行 npm run install:browser 后刷新页面。</span></div>
  <div class="toolbar overview-toolbar">
    <div class="segmented filters" aria-label="任务筛选">
      <button :class="{ selected: filter === 'all' }" @click="filter = 'all'">全部任务<span>{{ listing.summary.total }}</span></button>
      <button :class="{ selected: filter === 'review' }" @click="filter = 'review'">需复核<span>{{ listing.summary.needsReview }}</span></button>
      <button :class="{ selected: filter === 'low' }" @click="filter = 'low'">低于 {{ platform.settings?.threshold }} 分<span>{{ listing.summary.belowThreshold }}</span></button>
    </div>
    <span class="quiet-count"><i class="live-dot" />{{ listing.summary.active }} 项进行中</span>
  </div>
  <section class="panel task-panel">
    <div class="table-toolbar">
      <label class="search-field"><Search :size="18" /><input v-model="query" aria-label="搜索任务" placeholder="搜索任务标识、站点或环境…" /><button v-if="query" class="icon-button" aria-label="清除搜索" @click="query = ''"><X :size="15" /></button></label>
      <div class="toolbar-actions">
        <select v-model="status" class="input compact-select" aria-label="执行状态"><option value="all">全部状态</option><option v-for="(name, key) in statusNames" :key="key" :value="key">{{ name }}</option></select>
        <button class="icon-button refresh" aria-label="刷新列表" @click="load()"><RotateCw :size="17" /></button>
      </div>
    </div>
    <div v-if="error" class="alert error" role="alert">{{ error }}</div>
    <div v-if="loading" class="empty-state"><span class="spinner" /><p>正在读取任务…</p></div>
    <div v-else-if="!listing.items.length" class="empty-state">
      <span class="empty-icon"><ScanLine :size="32" :stroke-width="1.4" /></span>
      <h2>{{ listing.summary.total ? '没有符合条件的任务' : '第一份报告，从这里开始' }}</h2>
      <p>{{ listing.summary.total ? '调整筛选条件，或搜索其他站点' : '连接建站插件自动接收任务，也可以用站点地址发起评测' }}</p>
      <a v-if="!listing.summary.total" class="button secondary" href="#/settings?tab=integration">配置插件接入<ArrowUpRight :size="16" /></a>
    </div>
    <div v-else class="table-scroll">
      <table class="task-table"><thead><tr><th>生成站点 / 最近评测</th><th>UI 还原度</th><th>任务完成度</th><th>范围</th><th>状态</th><th>创建时间</th><th><span class="sr-only">查看报告</span></th></tr></thead>
        <tbody><tr v-for="item in listing.items" :key="item.id">
          <td><a class="task-title" :href="`#/evaluations/${item.id}`">{{ targetLabel(item) }}</a><span class="table-subtitle">{{ item.submission.jobId }}</span></td>
          <td><span class="table-score" :class="scoreClass(item.run.report?.fidelityScore)">{{ score(item.run.report?.fidelityScore) }}</span><span v-if="item.run.status === 'completed' && item.run.report?.fidelityScore == null" class="table-subtitle">不可评估</span></td>
          <td><span :class="{ 'text-muted': item.run.report?.completionScore == null }">{{ score(item.run.report?.completionScore) }}</span></td>
          <td><span class="scope-text">{{ item.submission.scope === 'homepage' ? '首页' : '全站' }}</span><span v-if="item.run.report && !item.run.report.coverage.complete" class="table-subtitle warning-text">覆盖不足</span></td>
          <td><span class="status-badge" :class="[item.run.status, { unscored: item.run.status === 'completed' && item.run.report?.fidelityScore == null }]"><i />{{ runStatusName(item.run) }}</span><span v-if="item.needsReview" class="table-subtitle warning-text">需人工复核</span><span v-else-if="item.review?.decision === 'accepted'" class="table-subtitle">人工已通过</span></td>
          <td class="date-cell">{{ formatDate(item.createdAt) }}</td><td><a class="icon-button" :href="`#/evaluations/${item.id}`" aria-label="查看评测报告"><ChevronRight :size="19" /></a></td>
        </tr></tbody>
      </table>
    </div>
    <footer class="table-footer"><span>共 {{ listing.total }} 项<span v-if="listing.summary.total"> · 已结束 {{ listing.summary.completed }} 项</span></span><div class="pagination"><button class="icon-button" :disabled="page <= 1" aria-label="上一页" @click="page--"><ChevronLeft :size="17" /></button><span>{{ page }} / {{ pages }}</span><button class="icon-button" :disabled="page >= pages" aria-label="下一页" @click="page++"><ChevronRight :size="17" /></button></div></footer>
  </section>
  <p class="page-footnote">每个生成站域名展示最近一次评测，历史记录在报告中查看；域名尚未解析的任务单独显示。未知分数可在“需复核”中查看。</p>

  <dialog ref="manualDialog" class="modal" @click="($event.target === manualDialog) && manualDialog?.close()">
    <form @submit.prevent="submit()">
      <div class="modal-head"><h2>新建评测</h2><button type="button" class="icon-button" aria-label="关闭" @click="manualDialog?.close()"><X :size="20" /></button></div>
      <p class="text-muted">使用可访问的站点地址，发起一次独立评测。</p>
      <label class="field"><span>任务标识</span><input v-model="form.jobId" class="input" required maxlength="200" /></label>
      <label class="field"><span>目标站点</span><input v-model="form.targetUrl" class="input" type="url" placeholder="https://生成的站点" required /></label>
      <label class="field"><span>视觉参考站 <small>可选</small></span><input v-model="form.referenceUrl" class="input" type="url" placeholder="https://参考站点" /></label>
      <label class="field"><span>评测范围</span><select v-model="form.scope" class="input"><option value="homepage">首页 · 桌面与移动</option><option value="site">全站 · 当前仅采集首页，结果需复核</option></select></label>
      <label class="field"><span>评分规则</span><select v-model="form.ruleSetVersion" class="input"><option value="">最近发布版本</option><option v-for="rule in rules" :key="rule.version" :value="rule.version">{{ rule.name }} · {{ rule.version }}</option></select></label>
      <p v-if="formError" class="alert error" role="alert">{{ formError }}</p>
      <div class="modal-actions"><button type="button" class="button secondary" @click="manualDialog?.close()">取消</button><button class="button primary" :disabled="saving"><LoaderCircle v-if="saving" class="spin" :size="17" />{{ saving ? '提交中…' : '开始评测' }}</button></div>
    </form>
  </dialog>
</template>
