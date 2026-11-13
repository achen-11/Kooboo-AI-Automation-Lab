<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { FollowupRun, TaskInterruption } from '../../../../shared/automation';
import type { TaskRecoveryAction, TaskRecoveryTarget } from '../../../../shared/task-presentation';
import Disclosure from '../../components/Disclosure.vue';
import TaskLearning from '../../components/TaskLearning.vue';
import ExecutionLog from '../../components/ExecutionLog.vue';
import TaskRecoveryActions from './TaskRecoveryActions.vue';
import { api, message } from '../../api';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; updatedAt: number; task?: TaskRecoveryTarget; busy?: boolean; workflowActive?: boolean }>();
const emit = defineEmits<{ action: [action: TaskRecoveryAction, taskId: string]; changed: [] }>();
const selected = ref('');
const learning = ref<{ refresh?: () => Promise<void> }>();
const { data, error, load } = useTaskSection<{ task?: TaskRecoveryTarget; context: string; error: string; followup?: FollowupRun; interruption?: TaskInterruption }>(
  () => `/automation/tasks/${props.taskId}/sections/execution?pageSize=1${selected.value?'&taskId='+selected.value:''}`, () => props.updatedAt);
watch(() => props.taskId, () => { selected.value = ''; }, { flush: 'sync' });
watch([() => props.taskId, selected], () => { data.value = null; }, { flush: 'sync' });
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
defineExpose({ refresh: async () => { await Promise.all([load(), learning.value?.refresh?.()]); } });
const actionNames: Record<string, string> = { repair: '委托站点修复',retry: '重试当前阶段', continue: '继续原会话', answer: '补充待输入内容', evaluate: '交接独立评测', wait: '等待执行', interrupt: '中断并说明原因' };
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <template v-if="data">
    <section v-if="data.interruption || data.error || recoveryTask?.status === 'cancelled'" class="panel settings-panel task-section-stack">
      <h2>{{ data.interruption ? '中断详情' : recoveryTask?.status === 'cancelled' ? '任务已取消' : '阶段异常' }}</h2>
      <p class="task-prose">{{ data.interruption?.reason || data.error || '当前任务已取消并确认停止，可按原固定输入与规则重新启动。' }}</p>
      <template v-if="data.interruption">
        <div><h3>下一步</h3><ul class="task-text-list"><li v-for="step in data.interruption.nextSteps" :key="step">{{ step }}</li></ul></div>
        <p class="text-muted task-prose">{{ data.interruption.resumeFrom }}</p>
      </template>
      <div class="task-actions"><TaskRecoveryActions :task="recoveryTask" :busy="busy" :workflow-active="workflowActive" @action="(action, id) => emit('action', action, id)" /></div>
      <p v-if="recoveryTask?.stopped === false && ['pending', 'interrupted'].includes(recoveryTask.status)" class="text-muted small-text">请先检查原会话或执行进程，确认停止后再恢复。</p>
      <Disclosure v-if="data.interruption?.attempted.length" label="已尝试的处理"><ol class="task-text-list"><li v-for="(attempt, index) in data.interruption.attempted" :key="index">{{ attempt }}</li></ol></Disclosure>
    </section>
    <section v-if="data.followup" class="panel settings-panel task-section-stack"><div class="section-heading"><h2>AI 跟进</h2><span class="text-muted small-text">{{ followupWindow?.windowed ? `本轮 ${followupWindow.currentAttempts} / ${followupWindow.maxAttempts} 次（累计 ${followupWindow.totalAttempts} 次）` : `${data.followup.attempts} / ${data.followup.policy.maxAttempts} 次` }}</span></div><p class="text-muted">{{ followupWindow?.windowed ? `本轮执行 ${followupWindow.windowSeconds} 秒 / ${data.followup.policy.maxMinutes} 分钟预算（累计 ${followupWindow.totalSeconds} 秒）` : `累计执行 ${followupWindow?.totalSeconds ?? 0} 秒 / ${data.followup.policy.maxMinutes} 分钟预算` }}</p><template v-if="data.followup.lastAction"><h3>{{ actionNames[data.followup.lastAction.action] }}</h3><p class="task-prose">{{ data.followup.lastAction.reason }}</p></template><Disclosure label="跟进策略与诊断标识"><p class="text-muted small-text">跟进预算仅计 AI 跟进实际执行时间，生成与独立评测另行计时。</p><pre class="task-technical">{{ data.followup.policy.sop }}</pre><p class="text-muted small-text">会话：{{ data.followup.threadId || '尚未建立' }}</p></Disclosure></section>
  </template>
  <TaskLearning ref="learning" :task-id="taskId" mode="execution" :revision="updatedAt" @changed="emit('changed')" />
  <ExecutionLog :task-id="taskId" :revision="updatedAt" @stage-change="selected = $event" />
  <section v-if="data?.context" class="panel settings-panel"><Disclosure label="最近会话上下文"><pre class="task-technical">{{ data.context }}</pre></Disclosure></section>
</template>
