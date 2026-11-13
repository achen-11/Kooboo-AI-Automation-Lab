<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
} from '@lucide/vue';
import type { TaskStatus } from '../../../../shared/automation';
import type { TemplateWorkflowResponse } from '../../../../shared/template-workflow';
import { formatDate } from '../../api';
import {
  buildTemplateStageSteps,
  describeTemplateWorkflowGuidance,
  summarizeTemplateEvaluation,
  templatePhaseNames,
  templateQualityNames,
} from '../../lib/template-workflow';

const props = defineProps<{
  workflow: TemplateWorkflowResponse;
  activeStatus?: TaskStatus;
  repairRoundCount?: number;
  attention?: string;
  nextStep?: string;
  createdAt: number;
}>();

const emit = defineEmits<{
  openBaseline: [target: { pagePath: string; viewId?: string }];
  openReport: [];
}>();

const steps = computed(() =>
  buildTemplateStageSteps(props.workflow, props.activeStatus, props.repairRoundCount ?? 0),
);

const guidance = computed(() =>
  describeTemplateWorkflowGuidance(props.workflow, props.attention || '', props.nextStep || ''),
);

const baseline = computed(() => props.workflow.baseline);
const evaluation = computed(() => props.workflow.evaluation);
const checklist = computed(() => props.workflow.checklist);

const totalViews = computed(
  () => baseline.value?.pages.reduce((sum, page) => sum + page.views.length, 0) ?? 0,
);

const evalSummary = computed(() =>
  evaluation.value ? summarizeTemplateEvaluation(evaluation.value, checklist.value) : null,
);

function iconStateClass(state: 'completed' | 'running' | 'attention' | 'pending') {
  if (state === 'completed') return 'completed';
  if (state === 'running') return 'running';
  if (state === 'attention') return 'interrupted';
  return '';
}
</script>

<template>
  <section class="panel settings-panel template-overview-panel">
    <div class="section-heading">
      <div class="template-overview-head">
        <h2>模板复刻流程</h2>
        <span v-if="workflow.phase" class="badge" :class="workflow.phase === 'completed' ? 'good' : workflow.phase === 'interrupted' ? 'warning' : 'phase-pill'">
          {{ templatePhaseNames[workflow.phase] }}
        </span>
      </div>
      <span class="text-muted small-text">{{ formatDate(createdAt) }} 创建</span>
    </div>

    <div class="task-workflow template-stage-bar">
      <template v-for="(step, idx) in steps" :key="step.id">
        <div v-if="idx > 0" class="workflow-connector" />
        <div class="workflow-stage">
          <span class="workflow-stage-icon" :class="iconStateClass(step.state)">
            <Check v-if="step.state === 'completed'" :size="18" />
            <LoaderCircle v-else-if="step.state === 'running'" class="spin" :size="18" />
            <CircleAlert v-else-if="step.state === 'attention'" :size="18" />
            <Clock3 v-else :size="18" />
          </span>
          <div>
            <strong>{{ step.label }}</strong>
            <p>{{ step.detail }}</p>
          </div>
        </div>
      </template>
    </div>

    <div class="guidance-callout" :class="`tone-${guidance.tone}`">
      <strong>{{ guidance.headline }}</strong>
      <p v-if="guidance.blocker" class="guidance-blocker">{{ guidance.blocker }}</p>
      <p class="guidance-next"><strong>下一步：</strong>{{ guidance.nextAction }}</p>
    </div>

    <div class="overview-template-cards">
      <div class="overview-subcard">
        <div class="overview-subcard-head">
          <span>冻结参考基线</span>
          <button
            type="button"
            class="text-action"
            @click="emit('openBaseline', { pagePath: baseline?.pages[0]?.path || '/' })"
          >
            {{ baseline ? '查看参考基线' : '查看输入与检查集' }}<ArrowUpRight :size="14" />
          </button>
        </div>
        <template v-if="baseline">
          <strong class="subcard-main">
            v{{ baseline.revision }} · {{ baseline.pages.length }} 页 / {{ totalViews }} 个语义区块
          </strong>
          <p class="text-muted small-text">
            {{ baseline.complete ? '来源覆盖完整，生成与评测共用此版本' : `保留 ${baseline.limitations.length || 1} 项来源限制或缺口` }}
            <span v-if="checklist"> · 检查集 v{{ checklist.revision }}</span>
          </p>
        </template>
        <template v-else>
          <strong class="subcard-main text-muted">尚未生成冻结基线</strong>
          <p class="text-muted small-text">
            {{ checklist ? `已绑定通用检查集 v${checklist.revision}（${checklist.name}）` : '等待前置来源分析采集' }}
          </p>
        </template>
      </div>

      <div class="overview-subcard">
        <div class="overview-subcard-head">
          <span>当前修订区块核验</span>
          <button type="button" class="text-action" @click="emit('openReport')">
            {{ evaluation ? '查看检查与问题明细' : '查看核验状态' }}<ArrowUpRight :size="14" />
          </button>
        </div>
        <template v-if="evaluation && evalSummary">
          <strong
            class="subcard-main"
            :class="
              evaluation.complete && evaluation.quality === 'passed'
                ? 'success-text'
                : evaluation.quality === 'failed'
                  ? 'error-text'
                  : 'warning-text'
            "
          >
            {{
              !evaluation.complete && evaluation.quality === 'passed'
                ? '待补齐未完成覆盖'
                : templateQualityNames[evaluation.quality]
            }}
          </strong>
          <p class="text-muted small-text">
            待修复 {{ evalSummary.openIssues }} · 已关闭 {{ evalSummary.doneIssues }} · 实测 {{ evalSummary.measuredChecks }} / 继承 {{ evalSummary.inheritedChecks }} / 未验证 {{ evalSummary.unverifiedChecks }}
          </p>
        </template>
        <template v-else>
          <strong class="subcard-main text-muted">暂无当前修订有效核验</strong>
          <p class="text-muted small-text">
            {{ workflow.limitations[0] || '站点生成完成并统一取证后展示分区块核验结果' }}
          </p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.template-overview-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.template-overview-panel > .section-heading {
  margin-bottom: 0;
}
.template-overview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.phase-pill {
  color: #3559b5;
  background: #eaf0ff;
}
.template-stage-bar {
  flex-wrap: wrap;
  row-gap: 14px;
}
.guidance-callout {
  padding: 15px 18px;
  border-radius: 12px;
  background: #f6f8fd;
  border: 1px solid #e5ebf5;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.7;
}
.guidance-callout.tone-good {
  background: #effaf5;
  border-color: #cdeadd;
}
.guidance-callout.tone-warning {
  background: #fff9f0;
  border-color: #f3dec0;
}
.guidance-blocker {
  color: #8c5319;
}
.guidance-next {
  color: #3e4c63;
}
.overview-template-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.overview-subcard {
  padding: 16px 18px;
  border-radius: 12px;
  border: 1px solid #e7ecf4;
  background: #fcfdff;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.overview-subcard-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
}
.subcard-main {
  font-size: 16px;
  font-weight: 650;
  line-height: 1.4;
}
@media (max-width: 820px) {
  .overview-template-cards {
    grid-template-columns: 1fr;
  }
  .workflow-connector {
    display: none;
  }
}
</style>
