<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUpRight, LoaderCircle, ChevronDown, ChevronRight } from '@lucide/vue';
import Disclosure from '../../components/Disclosure.vue';
import SiteTaskHistory from './SiteTaskHistory.vue';
import { siteDeliveryStates, usageStageNames, type SiteDeliverySummary } from '../../../../shared/site-delivery';
import { useTaskSection } from './use-task-section';
import { siteReportLink } from '../../lib/site-reports';
const props = defineProps<{ siteId: string; revision: string }>();
const { data, error, load } = useTaskSection<SiteDeliverySummary>(() => `/automation/site-deliveries/${props.siteId}`, () => props.revision);
const historyOpen = ref(false);
const historyRevision = computed(() => historyOpen.value ? props.revision : '');
const costs = computed(() => data.value?.stages.filter(item => item.usage.requests) || []);
</script>
<template>
  <section class="panel settings-panel">
    <div class="section-heading"><h2>生成站交付</h2><div class="toolbar-actions"><a v-if="data?.report" class="text-action" :href="siteReportLink(data.detailTaskId || data.report.id, data.report.id)">当前报告<ArrowUpRight :size="14" /></a><a v-if="data?.detailTaskId" class="text-action" :href="`#/tasks/${data.detailTaskId}?tab=usage`">站点用量费用<ArrowUpRight :size="14" /></a></div></div>
    <p v-if="error" class="alert error">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <template v-if="data">
      <div class="site-summary"><div><span>当前结果</span><strong class="site-readiness" :class="data.state">{{ siteDeliveryStates[data.state] }}</strong></div><div><span>站点累计估算成本</span><strong>{{ data.usage.priced ? '¥ ' + data.usage.knownCny.toFixed(4) : '—' }}</strong></div></div>
      <p class="task-prose">{{ data.reason }}</p>
      <Disclosure v-if="costs.length" label="分阶段成本"><dl class="stage-costs"><div v-for="item in costs" :key="item.stage"><dt>{{ usageStageNames[item.stage] }}</dt><dd>{{ item.usage.priced ? '¥ '+item.usage.knownCny.toFixed(4) : '—' }}</dd></div></dl></Disclosure>
      <button class="text-action history-toggle" :aria-expanded="historyOpen" @click="historyOpen=!historyOpen"><ChevronDown v-if="historyOpen" :size="16" /><ChevronRight v-else :size="16" />{{ historyOpen ? '收起' : '查看' }}站点执行历史（{{ data.taskCount }}）</button>
      <SiteTaskHistory v-if="historyOpen" :site-id="siteId" :revision="historyRevision" />
    </template>
    <p v-else-if="!error" class="section-loading"><LoaderCircle :size="16" class="spin" />正在加载站点结果…</p>
  </section>
</template>
<style scoped>
.site-readiness.ready{color:#16765d}.site-readiness.attention,.site-readiness.needs-improvement{color:#a65e0a}.site-readiness.running,.site-readiness.queued{color:var(--blue)}.site-readiness.unverified,.site-readiness.awaiting-evaluation{color:var(--muted)}
.site-summary{display:flex;flex-wrap:wrap;gap:24px 64px;margin:4px 0 20px}.site-summary>div{display:flex;flex-direction:column;gap:9px}.site-summary span{font-size:12px;color:var(--muted)}.site-summary strong{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.stage-costs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 28px;margin:16px 0}.stage-costs dt{font-size:12px;color:var(--muted);margin-bottom:6px}.stage-costs dd{margin:0;font-variant-numeric:tabular-nums}.history-toggle{margin-top:16px}@media(max-width:700px){.stage-costs{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
