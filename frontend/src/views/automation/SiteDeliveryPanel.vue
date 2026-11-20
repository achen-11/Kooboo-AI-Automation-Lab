<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUpRight, Copy, ExternalLink, LoaderCircle, ChevronDown, ChevronRight } from '@lucide/vue';
import Disclosure from '../../components/Disclosure.vue';
import SiteTaskHistory from './SiteTaskHistory.vue';
import { accessibleSiteUrl, deliveredSiteUrl, deliveryStatusNames, siteDeliveryStates, usageStageNames, type SiteDeliverySummary } from '../../../../shared/site-delivery';
import { useTaskSection } from './use-task-section';
import { siteReportLink } from '../../lib/site-reports';
import { notify } from '../../lib/notifications';
const props = defineProps<{ siteId: string; revision: string }>();
const { data, error, load } = useTaskSection<SiteDeliverySummary>(() => `/automation/site-deliveries/${props.siteId}`, () => props.revision);
const historyOpen = ref(false);
const historyRevision = computed(() => historyOpen.value ? props.revision : '');
const costs = computed(() => data.value?.stages.filter(item => item.usage.requests) || []);
const deliveredUrl = computed(() => deliveredSiteUrl(data.value?.delivery));
const sourceUrl = computed(() => accessibleSiteUrl(data.value?.siteUrl || ''));
const targetPreviewUrl = computed(() => accessibleSiteUrl(data.value?.delivery?.targetUrl || ''));
async function copyUrl(url: string, label: string) {
  try {
    await navigator.clipboard.writeText(url);
    notify.success(`已复制${label}`);
  } catch {
    notify.error('无法访问剪贴板，请手动复制');
  }
}
</script>
<template>
  <section class="panel settings-panel">
    <div class="section-heading"><h2>生成站交付</h2><div class="toolbar-actions"><a v-if="data?.report" class="text-action" :href="siteReportLink(data.detailTaskId || data.report.id, data.report.id)">当前报告<ArrowUpRight :size="14" /></a><a v-if="data?.detailTaskId" class="text-action" :href="`#/tasks/${data.detailTaskId}?tab=usage`">站点用量费用<ArrowUpRight :size="14" /></a></div></div>
    <p v-if="error" class="alert error">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <template v-if="data">
      <div class="site-summary"><div><span>当前结果</span><strong class="site-readiness" :class="data.state">{{ siteDeliveryStates[data.state] }}</strong></div><div><span>站点累计估算成本</span><strong>{{ data.usage.priced ? '¥ ' + data.usage.knownCny.toFixed(4) : '—' }}</strong></div></div>
      <div v-if="deliveredUrl || data.delivery || sourceUrl" class="site-links-card">
        <template v-if="deliveredUrl">
          <div class="site-link-row site-link-row-primary">
            <span class="site-link-label">交付地址（主链接）</span>
            <span class="delivery-link-badge">已交付</span>
            <a class="site-link-url" :href="deliveredUrl" target="_blank" rel="noopener noreferrer" :title="deliveredUrl">{{ deliveredUrl }}<ExternalLink :size="13" /></a>
            <button type="button" class="icon-button" aria-label="复制交付地址" title="复制交付地址" @click="copyUrl(deliveredUrl, '交付地址')"><Copy :size="15" /></button>
            <a class="text-action site-link-detail" :href="`#/tasks/${data.delivery!.taskId}?tab=delivery`">查看交付核验<ArrowUpRight :size="13" /></a>
          </div>
          <div v-if="sourceUrl && sourceUrl !== deliveredUrl" class="site-link-row site-link-row-secondary">
            <span class="site-link-label">源站地址</span>
            <a class="site-link-url" :href="sourceUrl" target="_blank" rel="noopener noreferrer" :title="sourceUrl">{{ sourceUrl }}<ExternalLink :size="12" /></a>
          </div>
        </template>
        <template v-else-if="data.delivery">
          <div class="site-link-row">
            <span class="site-link-label">跨环境交付</span>
            <strong>{{ deliveryStatusNames[data.delivery.status] }}</strong>
            <a class="text-action site-link-detail" :href="`#/tasks/${data.delivery.taskId}?tab=delivery`">查看交付<ArrowUpRight :size="13" /></a>
          </div>
          <div v-if="sourceUrl" class="site-link-row">
            <span class="site-link-label">生成站地址</span>
            <a class="site-link-url" :href="sourceUrl" target="_blank" rel="noopener noreferrer" :title="sourceUrl">{{ sourceUrl }}<ExternalLink :size="13" /></a>
            <button type="button" class="icon-button" aria-label="复制生成站地址" title="复制生成站地址" @click="copyUrl(sourceUrl, '生成站地址')"><Copy :size="15" /></button>
          </div>
          <div v-if="targetPreviewUrl" class="site-link-row site-link-row-secondary">
            <span class="site-link-label">目标站（{{ deliveryStatusNames[data.delivery.status] }}）</span>
            <a class="site-link-url" :href="targetPreviewUrl" target="_blank" rel="noopener noreferrer" :title="targetPreviewUrl">{{ targetPreviewUrl }}<ExternalLink :size="12" /></a>
          </div>
        </template>
        <div v-else-if="sourceUrl" class="site-link-row">
          <span class="site-link-label">生成站地址</span>
          <a class="site-link-url" :href="sourceUrl" target="_blank" rel="noopener noreferrer" :title="sourceUrl">{{ sourceUrl }}<ExternalLink :size="13" /></a>
          <button type="button" class="icon-button" aria-label="复制生成站地址" title="复制生成站地址" @click="copyUrl(sourceUrl, '生成站地址')"><Copy :size="15" /></button>
        </div>
      </div>
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
.site-summary{display:flex;flex-wrap:wrap;gap:24px 64px;margin:4px 0 18px}.site-summary>div{display:flex;flex-direction:column;gap:9px}.site-summary span{font-size:12px;color:var(--muted)}.site-summary strong{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.site-links-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;margin-bottom:18px;background:var(--field);border:1px solid #e3e8f2;border-radius:10px}
.site-link-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;min-width:0;font-size:13px}
.site-link-label{color:var(--muted);font-size:12px;white-space:nowrap}
.delivery-link-badge{padding:2px 7px;border-radius:4px;background:#eaf7f1;color:#16765d;font-size:11px;font-weight:600;line-height:1.4;white-space:nowrap}
.site-link-url{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%;color:var(--blue);font-weight:500;overflow-wrap:anywhere}
.site-link-row-primary .site-link-url{color:#16765d;font-weight:600}
.site-link-row-secondary{font-size:12px;color:var(--muted)}
.site-link-row-secondary .site-link-url{color:var(--muted);font-weight:400}
.site-link-url:hover{text-decoration:underline}
.site-link-detail{margin-left:auto;padding:0;font-size:12px;white-space:nowrap}
.stage-costs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 28px;margin:16px 0}.stage-costs dt{font-size:12px;color:var(--muted);margin-bottom:6px}.stage-costs dd{margin:0;font-variant-numeric:tabular-nums}.history-toggle{margin-top:16px}@media(max-width:700px){.stage-costs{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
