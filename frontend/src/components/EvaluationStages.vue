<script setup lang="ts">
import type {
  CaptureCheckpoint,
  EvaluationStep,
  RetryMode,
  Run,
  StepId,
  StepStatus,
} from '../../../shared/types';
import { stageDuration } from '../lib/stage-duration';
const props = defineProps<{ run: Run; canRetry: boolean; busy: boolean }>();
const emit = defineEmits<{ retry: [mode: RetryMode] }>();
const names: Record<StepId, string> = {
  prepare: '资料准备',
  target: '生成站采集',
  reference: '参考站采集',
  check: '证据检查',
  score: '模型评分',
  report: '报告输出',
};
const states: Record<StepStatus, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  blocked: '等待前置步骤',
  skipped: '已跳过',
  reused: '已复用',
};
const actions: Record<StepId, string> = {
  prepare: '重新准备',
  target: '重新采集',
  reference: '重新采集',
  check: '重新检查',
  score: '重新评分',
  report: '重新输出',
};
function captures(id: StepId): CaptureCheckpoint[] {
  return props.run.pipeline?.captures.filter((capture) => capture.role === id) || [];
}
function available(step: EvaluationStep): boolean {
  if (step.status === 'skipped' || step.status === 'pending') return false;
  if (step.id === 'report') return !!props.run.pipeline?.scoredReport;
  if (step.id === 'check' || step.id === 'score')
    return !!props.run.pipeline?.captures.some(
      (capture) => capture.role === 'target' && ['completed', 'reused'].includes(capture.status)
    );
  return true;
}
</script>

<template>
  <section class="panel evaluation-stages" aria-label="评测阶段">
    <div class="section-heading">
      <h2>评测阶段</h2>
      <button v-if="run.status === 'failed'" class="text-button" :disabled="!canRetry || busy" @click="emit('retry', 'failed')">
        重试失败步骤
      </button>
    </div>
    <ol v-if="run.pipeline" class="stage-list">
      <li
        v-for="(step, index) in run.pipeline.steps"
        :key="step.id"
        class="stage-row"
        :class="step.status"
        :aria-current="step.status === 'running' ? 'step' : undefined"
      >
        <span class="stage-number">{{ index + 1 }}</span>
        <div class="stage-content">
          <div class="stage-title">
            <h3>{{ names[step.id] }}</h3>
            <span class="stage-state">{{ states[step.status] }}</span
            ><time v-if="stageDuration(run, step)">{{ stageDuration(run, step) }}</time>
          </div>
          <p v-if="step.message || step.error">{{ step.error || step.message }}</p>
          <details v-if="captures(step.id).length" class="stage-output">
            <summary>查看视口与证据</summary>
            <div
              v-for="capture in captures(step.id)"
              :key="capture.viewport"
              class="capture-output"
            >
              <span
                >{{ capture.viewport === 'desktop' ? '桌面' : '移动' }} ·
                {{ states[capture.status] }} ·
                {{ capture.evidence?.screenshots.length || 0 }} 张截图<span
                  v-if="stageDuration(run, capture, true)"
                >
                  · {{ stageDuration(run, capture, true) }}</span
                ></span
              >
              <p v-if="capture.error">{{ capture.error }}</p>
              <small v-if="capture.sourceRunId && capture.sourceRunId !== run.id"
                >证据来自 {{ capture.sourceRunId.slice(0, 8) }} 轮次，保留原采集时间</small
              >
            </div>
          </details>
          <details v-if="step.id === 'prepare' && run.pipeline.prepared" class="stage-output">
            <summary>查看资料</summary>
            <p>{{ run.pipeline.prepared.targetUrl }}</p>
            <pre v-if="run.pipeline.prepared.readme">{{ run.pipeline.prepared.readme }}</pre>
            <p v-else>未取得资料包文本</p>
          </details>
        </div>
        <button
          v-if="available(step)"
          class="text-button stage-action"
          :disabled="!canRetry || busy"
          @click="emit('retry', step.id)"
        >
          {{ actions[step.id] }}
        </button>
      </li>
    </ol>
    <p v-else class="section-note">
      此记录来自阶段化之前。可从页面顶部发起完整重评，历史记录会保留。
    </p>
  </section>
</template>
