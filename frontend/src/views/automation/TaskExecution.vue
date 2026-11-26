<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { Upload } from '@lucide/vue';
import type { FollowupRun, TaskInterruption } from '../../../../shared/automation';
import type { TaskSupplementContext } from '../../../../shared/supplement';
import { deriveHumanNotice, diagnosticCategoryLabels, type HumanNotice } from '../../../../shared/human-diagnostics';
import type { TaskRecoveryAction, TaskRecoveryTarget } from '../../../../shared/task-presentation';
import Disclosure from '../../components/Disclosure.vue';
import ExecutionLog from '../../components/ExecutionLog.vue';
import TaskRecoveryActions from './TaskRecoveryActions.vue';
import TaskSupplementDialog from './TaskSupplementDialog.vue';
import { api, message } from '../../api';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; updatedAt: number; task?: TaskRecoveryTarget; busy?: boolean; workflowActive?: boolean }>();
const emit = defineEmits<{ action: [action: TaskRecoveryAction, taskId: string]; changed: [] }>();
const selected = ref('');
const supplementDialog = ref<InstanceType<typeof TaskSupplementDialog>>();
const supplementContext = shallowRef<TaskSupplementContext | null>(null);
const { data, error, load } = useTaskSection<{ task?: TaskRecoveryTarget; context: string; error: string; followup?: FollowupRun; interruption?: TaskInterruption; humanNotice?: HumanNotice }>(
  () => `/automation/tasks/${props.taskId}/sections/execution?pageSize=1${selected.value?'&taskId='+selected.value:''}`, () => props.updatedAt);
watch(() => props.taskId, () => { selected.value = ''; }, { flush: 'sync' });
watch([() => props.taskId, selected], () => { data.value = null; supplementContext.value = null; }, { flush: 'sync' });
const legacyTask = shallowRef<TaskRecoveryTarget>();
// Running installations may still return the old section shape until their next safe restart.
watch(data, async (section, _previous, onCleanup) => {
  legacyTask.value = undefined;
  const id = selected.value || props.taskId;
  if (!section || section.task || props.task?.id === id) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  try {
    const result = await api<{ task: TaskRecoveryTarget }>(`/automation/tasks/${id}/summary`, { signal: controller.signal });
    if (!controller.signal.aborted && result.task.id === id) legacyTask.value = result.task;
  } catch (reason) { if (!controller.signal.aborted) error.value = message(reason); }
});
const recoveryTask = computed(() => data.value?.task || legacyTask.value || (props.task?.id === (selected.value || props.taskId) ? props.task : undefined));
const canSupplement = computed(() => Boolean(recoveryTask.value && recoveryTask.value.kind === 'generation' && recoveryTask.value.stopped && ['interrupted', 'pending', 'failed', 'cancelled'].includes(recoveryTask.value.status)));
const activeSupplementBatch = computed(() => supplementContext.value?.batches.find(b => b.status === 'collecting' || b.status === 'ready'));
let supplementAbort: AbortController | undefined;
async function loadSupplementSummary() {
  supplementAbort?.abort();
  const target = recoveryTask.value;
  if (!target || target.kind !== 'generation') { supplementContext.value = null; return; }
  const controller = new AbortController();
  supplementAbort = controller;
  const targetId = target.id;
  try {
    const result = await api<TaskSupplementContext>(`/automation/tasks/${targetId}/supplements`, { signal: controller.signal });
    if (!controller.signal.aborted && recoveryTask.value?.id === targetId) supplementContext.value = result;
  } catch { /* supplemental summary badge is optional */ }
}
watch([() => recoveryTask.value?.id, () => recoveryTask.value?.kind, () => props.updatedAt], () => { void loadSupplementSummary(); }, { immediate: true });
onUnmounted(() => { supplementAbort?.abort(); });
async function onSupplementApplied() { emit('changed'); await Promise.all([load(), loadSupplementSummary()]); }
const humanNotice = computed<HumanNotice | null>(() => {
  if (!data.value) return null;
  if (recoveryTask.value?.status === 'cancelled' && !data.value.interruption) return null;
  if (!data.value.interruption && !data.value.error) return null;
  return data.value.humanNotice || deriveHumanNotice({
    reason: data.value.interruption?.reason,
    error: data.value.error,
    stage: data.value.interruption?.stage,
    evidence: data.value.interruption?.evidence,
    nextSteps: data.value.interruption?.nextSteps,
    userSummary: data.value.interruption?.userSummary,
    lastAction: data.value.followup?.lastAction,
  });
});
const followupWindow = computed(() => {
  const f = data.value?.followup;
  if (!f) return null;
  const attemptsBase = f.window?.attemptsBase || 0;
  const elapsedMsBase = f.window?.elapsedMsBase || 0;
  const totalMs = (f.elapsedMs || 0) + (f.activeElapsedMs || 0);
  const windowed = Boolean(f.window && (f.window.index > 0 || attemptsBase > 0 || elapsedMsBase > 0));
  return {
    windowed,
    currentAttempts: Math.max(0, f.attempts - attemptsBase),
    totalAttempts: f.attempts,
    maxAttempts: f.policy.maxAttempts,
    windowSeconds: Math.round(Math.max(0, totalMs - elapsedMsBase) / 1000),
    totalSeconds: Math.round(totalMs / 1000),
  };
});
defineExpose({ refresh: async () => { await Promise.all([load(), loadSupplementSummary()]); } });
const actionNames: Record<string, string> = { repair: '委托站点修复',retry: '重试当前阶段', continue: '继续原会话', answer: '补充待输入内容', evaluate: '交接独立评测', wait: '等待执行', interrupt: '中断并说明原因' };
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <template v-if="data">
    <section v-if="data.interruption || data.error || recoveryTask?.status === 'cancelled'" class="panel settings-panel task-section-stack">
      <div class="section-heading">
        <h2>{{ data.interruption ? '中断说明' : recoveryTask?.status === 'cancelled' ? '任务已取消' : '阶段异常' }}</h2>
        <div v-if="humanNotice || activeSupplementBatch" class="attention-badges">
          <span v-if="activeSupplementBatch" class="status-badge" :class="activeSupplementBatch.status === 'collecting' ? 'collecting' : 'pending'">{{ activeSupplementBatch.status === 'collecting' ? 'AI 正在收集资料' : 'AI 已整理好资料，待确认' }}</span>
          <span v-if="humanNotice" class="status-badge failed">{{ diagnosticCategoryLabels[humanNotice.category] }}</span>
        </div>
      </div>
      <template v-if="humanNotice">
        <p class="human-headline">{{ humanNotice.headline }}</p>
        <p class="task-prose">{{ humanNotice.explanation }}</p>
        <div v-if="humanNotice.userActions.length">
          <h3>接下来可以这样做</h3>
          <ol class="task-text-list"><li v-for="step in humanNotice.userActions" :key="step">{{ step }}</li></ol>
        </div>
      </template>
      <p v-else class="task-prose">当前任务已取消并确认停止，可按原固定输入与规则重新启动。</p>
      <div class="task-actions">
        <TaskRecoveryActions :task="recoveryTask" :busy="busy" :workflow-active="workflowActive" @action="(action, id) => emit('action', action, id)" />
        <button v-if="canSupplement" type="button" class="button secondary" :disabled="busy" @click="supplementDialog?.open()">
          <Upload :size="16" />{{ activeSupplementBatch?.status === 'ready' ? '查看待确认资料' : activeSupplementBatch?.status === 'collecting' ? '查看 AI 收集进度' : '补充资料 / AI 收集' }}
        </button>
      </div>
      <p v-if="recoveryTask?.stopped === false && ['pending', 'interrupted'].includes(recoveryTask.status)" class="text-muted small-text">请先检查原会话或执行进程，确认停止后再恢复。</p>
      <Disclosure v-if="data.interruption || data.error" label="技术排障详情（供研发查看）">
        <div class="tech-detail-stack">
          <p v-if="data.interruption" class="text-muted small-text">阶段：<code>{{ data.interruption.stage }}</code> · 恢复策略：{{ data.interruption.resumeFrom }}</p>
          <p class="task-prose"><strong>原始原因：</strong>{{ data.interruption?.reason || data.error }}</p>
          <div v-if="data.interruption?.nextSteps?.length">
            <strong>原始下一步</strong>
            <ul class="task-text-list"><li v-for="step in data.interruption.nextSteps" :key="step">{{ step }}</li></ul>
          </div>
          <div v-if="data.interruption?.evidence?.length">
            <strong>关联证据</strong>
            <ul class="task-text-list"><li v-for="ev in data.interruption.evidence" :key="ev">{{ ev }}</li></ul>
          </div>
          <div v-if="data.interruption?.attempted?.length">
            <strong>已尝试的处理（{{ data.interruption.attempted.length }}）</strong>
            <ol class="task-text-list"><li v-for="(attempt, index) in data.interruption.attempted" :key="index">{{ attempt }}</li></ol>
          </div>
        </div>
      </Disclosure>
    </section>
    <section v-if="data.followup" class="panel settings-panel task-section-stack"><div class="section-heading"><h2>AI 跟进</h2><span class="text-muted small-text">{{ followupWindow?.windowed ? `本轮 ${followupWindow.currentAttempts} / ${followupWindow.maxAttempts} 次（累计 ${followupWindow.totalAttempts} 次）` : `${data.followup.attempts} / ${data.followup.policy.maxAttempts} 次` }}</span></div><p class="text-muted">{{ followupWindow?.windowed ? `本轮执行 ${followupWindow.windowSeconds} 秒 / ${data.followup.policy.maxMinutes} 分钟预算（累计 ${followupWindow.totalSeconds} 秒）` : `累计执行 ${followupWindow?.totalSeconds ?? 0} 秒 / ${data.followup.policy.maxMinutes} 分钟预算` }}</p><template v-if="data.followup.lastAction"><h3>{{ actionNames[data.followup.lastAction.action] }}</h3><p v-if="data.followup.lastAction.userSummary" class="task-prose"><strong>{{ data.followup.lastAction.userSummary.headline }}：</strong>{{ data.followup.lastAction.userSummary.explanation }}</p><p v-else class="task-prose">{{ data.followup.lastAction.reason }}</p></template><Disclosure label="跟进策略与诊断标识"><p class="text-muted small-text">跟进预算仅计 AI 跟进实际执行时间，生成与独立评测另行计时。</p><p v-if="data.followup.lastAction?.userSummary" class="task-prose"><strong>原始决策说明：</strong>{{ data.followup.lastAction.reason }}</p><pre class="task-technical">{{ data.followup.policy.sop }}</pre><p class="text-muted small-text">会话：{{ data.followup.threadId || '尚未建立' }}</p></Disclosure></section>
  </template>
  <ExecutionLog :task-id="taskId" :revision="updatedAt" @stage-change="selected = $event" />
  <section v-if="data?.context" class="panel settings-panel"><Disclosure label="最近会话上下文"><pre class="task-technical">{{ data.context }}</pre></Disclosure></section>
  <TaskSupplementDialog
    v-if="recoveryTask"
    :key="'exec-supp-' + recoveryTask.id"
    ref="supplementDialog"
    :task-id="recoveryTask.id"
    @applied="onSupplementApplied"
    @changed="loadSupplementSummary"
  />
</template>
<style scoped>
.human-headline{font-size:17px;font-weight:650;color:var(--ink);margin:0}
.tech-detail-stack{display:flex;flex-direction:column;gap:8px}
.attention-badges{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
</style>
