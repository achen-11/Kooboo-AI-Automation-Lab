<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowUpRight, Copy, ExternalLink } from '@lucide/vue';
import { optimizationStateNames, taskStatusNames } from '../../../../shared/automation';
import {
  deliveryStatusNames,
  listSiteLinks,
  siteDeliveryStates,
  type SiteDeliverySummary,
  type SiteDeliveryTarget,
} from '../../../../shared/site-delivery';
import type { TaskSummary, TaskTab } from '../../../../shared/task-presentation';
import type { TemplateWorkflowResponse } from '../../../../shared/template-workflow';
import { api, platform } from '../../api';
import { notify } from '../../lib/notifications';
import { scoreTone } from '../../lib/task-list';
import { templateQualityNames } from '../../lib/template-workflow';

const props = defineProps<{
  task: TaskSummary;
  current?: TaskSummary;
  evaluation?: TaskSummary | null;
  siteId?: string | null;
  delivery?: SiteDeliveryTarget | null;
  report?: TaskSummary['report'] | null;
  revision: string;
  templateWorkflow?: TemplateWorkflowResponse | null;
}>();

const emit = defineEmits<{
  selectTab: [tab: TaskTab];
  openReport: [];
  openBaseline: [target: { pagePath: string; viewId?: string }];
}>();

const siteData = shallowRef<SiteDeliverySummary | null>(null);
const loadingSite = ref(false);
let controller: AbortController | undefined;
let seq = 0;

async function loadSiteSummary() {
  const id = props.siteId;
  controller?.abort();
  if (!id) {
    siteData.value = null;
    loadingSite.value = false;
    return;
  }
  const currentSeq = ++seq;
  controller = new AbortController();
  loadingSite.value = true;
  try {
    const result = await api<SiteDeliverySummary>(`/automation/site-deliveries/${id}`, {
      signal: controller.signal,
    });
    if (currentSeq === seq) siteData.value = result;
  } catch {
    if (currentSeq === seq && !controller.signal.aborted && siteData.value?.generatedSiteId !== id) {
      siteData.value = null;
    }
  } finally {
    if (currentSeq === seq) loadingSite.value = false;
  }
}

watch([() => props.siteId, () => props.revision], () => {
  void loadSiteSummary();
}, { immediate: true });

onUnmounted(() => {
  seq++;
  controller?.abort();
});

const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };

const activeTask = computed(() => props.current || props.task);
const effectiveDelivery = computed(() => siteData.value?.delivery || props.delivery || props.task.delivery || null);
const effectiveSiteUrl = computed(() => siteData.value?.siteUrl || props.task.siteUrl || '');
const links = computed(() => listSiteLinks(effectiveSiteUrl.value, effectiveDelivery.value));
const primaryBadge = computed(() => {
  if (!links.value.primary) return '';
  return links.value.primary.badge || '生成站';
});

const effectiveReport = computed(() => siteData.value?.report?.report || props.report || null);
const targetScore = computed(
  () => siteData.value?.targetScore ?? props.task.optimization?.policy.targetScore ?? platform.settings?.threshold ?? 80,
);
const effectiveUsage = computed(() => siteData.value?.usage || props.task.usage);

const resultLabel = computed(() => {
  if (siteData.value) return siteDeliveryStates[siteData.value.state];
  if (props.task.optimization && !(props.task.optimization.state === 'waiting-evaluation' && props.task.optimization.activeTaskId === props.task.id)) {
    return optimizationStateNames[props.task.optimization.state];
  }
  return taskStatusNames[activeTask.value.status];
});

const resultTone = computed(() => {
  if (siteData.value) return siteData.value.state;
  const status = activeTask.value.status;
  if (status === 'completed') return 'ready';
  if (['interrupted', 'failed', 'pending'].includes(status)) return 'attention';
  if (['running', 'following-up', 'cancelling'].includes(status)) return 'running';
  if (status === 'queued') return 'queued';
  return 'unverified';
});

const resultDetail = computed(() => {
  if (activeTask.value.attention) return activeTask.value.attention;
  if (siteData.value?.reason) return siteData.value.reason;
  if (props.task.optimization?.reason) return props.task.optimization.reason;
  if (props.evaluation?.status === 'completed' && effectiveReport.value) {
    return '生成与独立评测均已完成，可查看站点与报告。';
  }
  if (effectiveDelivery.value) {
    return `跨环境交付：${deliveryStatusNames[effectiveDelivery.value.status]}`;
  }
  return '查看下方流程节点了解各阶段进展。';
});

const optimizationProgressText = computed(() => {
  const opt = props.task.optimization;
  if (!opt) return '';
  if (!props.task.completionFirst || props.task.hardMaxRounds) {
    return `修复 ${opt.round} / ${props.task.hardMaxRounds ?? opt.policy.maxRounds}`;
  }
  return `修复第 ${opt.round} 轮`;
});

const templateBaseline = computed(() => (props.templateWorkflow?.supported ? props.templateWorkflow.baseline : null));
const templateTotalViews = computed(
  () => templateBaseline.value?.pages.reduce((sum, page) => sum + page.views.length, 0) ?? 0,
);
const templateEval = computed(() => (props.templateWorkflow?.supported ? props.templateWorkflow.evaluation : null));

async function copyUrl(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    notify.success('已复制站点地址');
  } catch {
    notify.error('无法访问剪贴板，请手动复制');
  }
}
</script>

<template>
  <section class="panel settings-panel overview-hero" aria-label="核心交付摘要">
    <div class="hero-grid">
      <div class="hero-block hero-site-block">
        <div class="hero-label-row">
          <span class="hero-label">访问站点</span>
          <span
            v-if="links.primary"
            class="hero-link-badge"
            :class="{ delivered: links.primary.delivered, pending: links.primary.deliveryPending }"
          >
            {{ primaryBadge }}
          </span>
        </div>
        <template v-if="links.primary">
          <div class="hero-url-row">
            <a
              class="hero-url"
              :class="{ delivered: links.primary.delivered, pending: links.primary.deliveryPending }"
              :href="links.primary.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="links.primary.title"
            >
              {{ links.primary.url }}
            </a>
            <button
              type="button"
              class="icon-button hero-icon-btn"
              aria-label="复制站点地址"
              :title="`复制地址：${links.primary.url}`"
              @click="copyUrl(links.primary.url)"
            >
              <Copy :size="14" />
            </button>
            <a
              class="icon-button hero-icon-btn"
              :href="links.primary.url"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在新标签页打开站点"
              :title="links.primary.delivered ? '打开交付站' : '打开站点'"
            >
              <ExternalLink :size="14" />
            </a>
          </div>
          <a
            v-if="links.source"
            class="hero-source-link"
            :href="links.source"
            target="_blank"
            rel="noopener noreferrer"
            :title="'源环境站点：' + links.source"
          >
            <span>源环境：{{ links.source }}</span>
            <ExternalLink :size="11" />
          </a>
        </template>
        <span v-else class="hero-empty-site">
          {{ loadingSite ? '正在同步站点地址…' : siteId ? '尚无可访问地址' : '等待生成站点' }}
        </span>
      </div>

      <div class="hero-block hero-status-block">
        <div class="hero-label-row">
          <span class="hero-label">当前结果</span>
          <span v-if="optimizationProgressText" class="hero-sub-pill">{{ optimizationProgressText }}</span>
          <button
            v-if="effectiveDelivery && ['failed', 'uncertain'].includes(effectiveDelivery.status)"
            type="button"
            class="text-action hero-jump"
            @click="emit('selectTab', 'delivery')"
          >
            处理交付<ArrowUpRight :size="12" />
          </button>
        </div>
        <strong class="hero-result-value" :class="resultTone">{{ resultLabel }}</strong>
        <p class="hero-result-detail" :title="resultDetail">{{ resultDetail }}</p>
      </div>

      <div class="hero-block hero-score-block">
        <div class="hero-label-row">
          <span class="hero-label">当前评分</span>
          <button type="button" class="text-action hero-jump" @click="emit('openReport')">
            详情<ArrowUpRight :size="12" />
          </button>
        </div>
        <div v-if="effectiveReport?.scores?.length" class="hero-scores">
          <span
            v-for="score in effectiveReport.scores"
            :key="score.viewport"
            class="hero-score-pill"
            :class="scoreTone(score.value, targetScore)"
          >
            <span>{{ viewportNames[score.viewport] || score.viewport }}</span>
            <strong>{{ score.value ?? '—' }}</strong>
          </span>
        </div>
        <div v-else-if="templateEval" class="hero-template-eval">
          <strong :class="templateEval.quality === 'passed' ? 'success-text' : 'warning-text'">
            {{ templateQualityNames[templateEval.quality] }}
          </strong>
          <span class="text-muted small-text">待修复 {{ templateEval.issues.filter(i => i.status === 'open').length }} 项</span>
        </div>
        <strong v-else class="hero-muted-value">
          {{ resultTone === 'running' || resultTone === 'queued' ? '待评测' : '暂无报告' }}
        </strong>
      </div>

      <div class="hero-block hero-cost-block">
        <div class="hero-label-row">
          <span class="hero-label">{{ siteId ? '站点总成本' : '本次成本' }}</span>
          <button type="button" class="text-action hero-jump" @click="emit('selectTab', 'usage')">
            明细<ArrowUpRight :size="12" />
          </button>
        </div>
        <strong class="hero-cost-value">
          {{ effectiveUsage?.priced ? `¥ ${effectiveUsage.knownCny.toFixed(4)}` : '—' }}
        </strong>
        <span class="text-muted small-text hero-cost-note">
          {{ task.optimization?.policy.maxCostCny !== null && task.optimization?.policy.maxCostCny !== undefined ? `上限 ¥ ${task.optimization.policy.maxCostCny}` : '按模型用量估算' }}
        </span>
      </div>
    </div>

    <div v-if="templateBaseline" class="hero-baseline-strip">
      <span class="text-muted small-text">
        冻结参考基线 v{{ templateBaseline.revision }} · {{ templateBaseline.pages.length }} 页 / {{ templateTotalViews }} 个区块
      </span>
      <button
        type="button"
        class="text-action"
        @click="emit('openBaseline', { pagePath: templateBaseline.pages[0]?.path || '/' })"
      >
        查看参考基线<ArrowUpRight :size="13" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.overview-hero {
  padding: 16px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hero-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1.75fr) minmax(190px, 1.15fr) minmax(185px, 1.05fr) minmax(145px, 0.8fr);
  gap: 14px 18px;
  align-items: start;
}
.hero-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero-block + .hero-block {
  padding-left: 18px;
  border-left: 1px solid #eef1f6;
}
.hero-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.hero-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.hero-sub-pill {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--field);
  color: var(--muted);
  font-weight: 550;
}
.hero-url-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 6px 8px 6px 10px;
  border-radius: 8px;
  background: var(--field);
  border: 1px solid #e3e8f2;
}
.hero-link-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: #eaf1ff;
  color: #365ec8;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.45;
  white-space: nowrap;
}
.hero-link-badge.delivered {
  background: #eaf7f1;
  color: #16765d;
}
.hero-link-badge.pending {
  background: #fff4e5;
  color: #995608;
}
.hero-url {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--blue);
}
.hero-url.delivered {
  color: #16765d;
}
.hero-url.pending {
  color: #995608;
}
.hero-url:hover {
  text-decoration: underline;
}
.hero-icon-btn {
  flex: none;
  width: 26px;
  height: 26px;
  color: var(--muted);
}
.hero-icon-btn:hover {
  color: var(--blue);
}
.hero-source-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  font-size: 11px;
  color: var(--muted);
}
.hero-source-link > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-source-link:hover {
  color: var(--blue);
  text-decoration: underline;
}
.hero-empty-site {
  font-size: 15px;
  font-weight: 600;
  color: var(--muted);
  line-height: 1.4;
}
.hero-result-value {
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
}
.hero-result-value.ready,
.hero-result-value.generated {
  color: #16765d;
}
.hero-result-value.attention,
.hero-result-value.needs-improvement {
  color: #a65e0a;
}
.hero-result-value.running,
.hero-result-value.queued {
  color: var(--blue);
}
.hero-result-value.unverified,
.hero-result-value.awaiting-evaluation {
  color: var(--muted);
}
.hero-result-detail {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hero-scores {
  display: flex;
  flex-wrap: nowrap;
  gap: 7px;
  align-items: center;
}
.hero-score-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 4px 9px;
  border-radius: 6px;
  background: var(--field);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.hero-score-pill span {
  font-size: 10.5px;
}
.hero-score-pill strong {
  font-size: 16px;
  font-weight: 700;
}
.hero-score-pill.good {
  color: #16765d;
  background: #eaf7f1;
}
.hero-score-pill.warning {
  color: #a65e0a;
  background: #fff4e5;
}
.hero-score-pill.low {
  color: #b53b4b;
  background: #fff0f2;
}
.hero-score-pill.unknown {
  color: var(--muted);
}
.hero-template-eval {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hero-template-eval strong {
  font-size: 16px;
}
.hero-muted-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--muted);
  line-height: 1.4;
}
.hero-cost-value {
  font-size: 20px;
  font-weight: 650;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}
.hero-cost-note {
  font-size: 11.5px;
}
.hero-jump {
  width: fit-content;
  padding: 0;
  font-size: 11.5px;
}
.hero-baseline-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
@media (max-width: 1080px) {
  .hero-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .hero-block + .hero-block {
    padding-left: 0;
    border-left: 0;
  }
}
@media (max-width: 640px) {
  .hero-grid {
    grid-template-columns: 1fr;
  }
}
</style>
