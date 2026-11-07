<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, Search, RefreshCw, Clock3, Play, FileText, ChevronLeft, ChevronRight } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import TaskDetail from './TaskDetail.vue';
import { formatDate } from '../../api';
import { refresh, workspace, scopeName } from './common';
import { taskStatusNames, scenarios } from '../../../../shared/automation';
const props = defineProps<{ id?: string; reports?: boolean }>();
const query = ref(''), filter = ref(''), kind = ref(''), page = ref(1);
const siteFilter = new URLSearchParams(window.location.hash.split('?')[1] || '').get('site');
const list = computed(() => workspace.tasks.filter(t =>
  (!props.reports || t.kind === 'evaluation') && (!siteFilter || t.generatedSiteId === siteFilter) &&
  (!kind.value || t.kind === kind.value) && (!filter.value || (filter.value === 'attention' ? (['pending', 'interrupted'].includes(t.status) || t.delivery && ['uncertain', 'failed'].includes(t.delivery.status)) : t.status === filter.value)) &&
  (!query.value || [t.resourceName, t.siteUrl, t.id].join(' ').toLowerCase().includes(query.value.toLowerCase()))));
const pages = computed(() => Math.max(1, Math.ceil(list.value.length / 20)));
const rows = computed(() => list.value.slice((page.value - 1) * 20, page.value * 20));
const active = computed(() => workspace.tasks.filter(t => !t.stopped && t.status !== 'following-up'));
const queued = computed(() => workspace.tasks.filter(t => t.status === 'queued').length);
const pending = computed(() => workspace.tasks.filter(t => ['pending', 'interrupted'].includes(t.status) || t.delivery && ['uncertain', 'failed'].includes(t.delivery.status)).length);
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
const qualityNames = { passed: '达到标准', failed: '需要改进', unverified: '有待验证' };
let timer: ReturnType<typeof setInterval> | undefined;
function load() { return refresh(); }
onMounted(() => { if (!props.id) { void load(); timer = setInterval(() => void load(), 4000); } });
onUnmounted(() => { if (timer) clearInterval(timer); });
watch([query, filter, kind], () => page.value = 1);
watch(pages, value => page.value = Math.min(page.value, value));
</script>
<template><TaskDetail v-if="id" :key="id" :id="id" /><template v-else><header class="page-header"><div><h1>{{reports?'评测报告':'任务中心'}}</h1></div><div class="toolbar-actions"><a v-if="reports" class="button secondary" href="#/legacy-evaluations"><FileText :size="16" />历史评测记录</a><a class="button primary" href="#/resources"><Play :size="16" />{{reports?'选择站点评测':'从资源创建任务'}}</a></div></header>
<p v-if="!workspace.settings.enabled" class="alert info"><Clock3 :size="17" /><span>自动执行已暂停，队列中的任务会保留。</span><a href="#/settings">前往设置<ArrowUpRight :size="15" /></a></p>
<div v-if="!reports" class="queue-summary"><div><span>生成执行</span><strong>{{active.filter(t=>t.kind==='generation').length}}<small>/ {{workspace.settings.generationConcurrency}}</small></strong></div><div><span>评测执行</span><strong>{{active.filter(t=>t.kind==='evaluation').length}}<small>/ {{workspace.settings.evaluationConcurrency}}</small></strong></div><div><span>排队中</span><strong>{{queued}}</strong></div><button :class="{highlight:pending}" @click="filter=filter==='attention'?'':'attention'"><span>需要处理</span><strong>{{pending}}</strong></button></div>
<section class="panel"><div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" :placeholder="reports?'搜索资源、站点或报告':'搜索资源、站点或任务'" aria-label="搜索任务" /></label><div class="toolbar-actions"><BaseSelect v-if="!reports" v-model="kind" size="small" aria-label="任务类型" :options="[{ value: '', label: '全部类型' }, { value: 'generation', label: '生成' }, { value: 'evaluation', label: '评测' }]" /><BaseSelect v-model="filter" size="small" aria-label="任务状态" :options="[{ value: '', label: '全部状态' }, { value: 'attention', label: '需要处理' }, ...Object.entries(taskStatusNames).map(([key, name]) => ({ value: key, label: (name) }))]" /><button class="icon-button" aria-label="刷新任务" @click="load"><RefreshCw :size="17" /></button></div></div><p v-if="workspace.error" class="alert error">{{workspace.error}}</p>
<div class="table-scroll"><table class="task-table"><thead><tr><th>资源 / 生成站</th><th v-if="!reports">类型</th><th>范围</th><th>执行状态</th><th v-if="reports">质量 / 评分</th><th>用量费用</th><th>创建时间</th><th /></tr></thead><tbody><tr v-for="task in rows" :key="task.id"><td><a class="task-title" :href="`#/tasks/${task.id}${reports?'?tab=report':''}`">{{task.resourceName}}</a><span class="table-subtitle">{{task.siteUrl||scenarios[task.scenario]}}</span></td><td v-if="!reports">{{task.kind==='generation'?'生成':'评测'}}</td><td>{{scopeName(task.scope)}}</td><td><span class="status-badge" :class="task.status"><i />{{taskStatusNames[task.status]}}</span><span v-if="task.delivery" class="table-subtitle">交付：{{({queued:'排队中',running:'迁移中',uncertain:'待核查',verifying:'核验中',completed:'核验完成',failed:'未完成'})[task.delivery.status]}}</span></td><td v-if="reports"><span v-if="task.report" :class="task.report.quality==='passed'?'success-text':'warning-text'">{{qualityNames[task.report.quality]}}</span><span v-else class="text-muted">报告尚未生成</span><span v-if="task.report" class="table-subtitle">{{task.report.scores.map(s=>`${viewportNames[s.viewport]} ${s.value??'未验证'}`).join(' · ')}}</span></td><td>{{task.usage?.requests?(task.usage.priced?`¥ ${task.usage.knownCny.toFixed(4)}`:'待核算'):'待采集'}}<span v-if="task.usage?.missing" class="table-subtitle">{{task.usage.missing}} 条待核算</span></td><td class="date-cell">{{formatDate(task.createdAt)}}</td><td><a class="text-action" :href="`#/tasks/${task.id}${reports?'?tab=report':''}`">{{reports?'查看报告':'详情'}}<ArrowUpRight :size="14" /></a></td></tr></tbody></table></div><div v-if="!rows.length" class="empty-state"><FileText v-if="reports" :size="30" /><Clock3 v-else :size="30" /><h2>{{reports?'暂无评测报告':'暂无任务'}}</h2><p>{{reports?'从资源的生成站发起独立评测':'先在资源库中选择一个或多个资源'}}</p></div><footer class="table-footer"><span>共 {{list.length}} 项</span><div class="pagination"><button class="icon-button" :disabled="page<=1" aria-label="上一页" @click="page--"><ChevronLeft :size="17" /></button><span>{{page}} / {{pages}}</span><button class="icon-button" :disabled="page>=pages" aria-label="下一页" @click="page++"><ChevronRight :size="17" /></button></div></footer></section></template></template>
