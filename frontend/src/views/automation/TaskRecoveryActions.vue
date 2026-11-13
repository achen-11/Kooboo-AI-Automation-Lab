<script setup lang="ts">
import { computed } from 'vue';
import { Check, Play } from '@lucide/vue';
import { taskRecoveryAction, type TaskRecoveryAction, type TaskRecoveryTarget } from '../../../../shared/task-presentation';

const props = defineProps<{ task?: TaskRecoveryTarget; busy?: boolean; workflowActive?: boolean }>();
const emit = defineEmits<{ action: [action: TaskRecoveryAction, taskId: string] }>();
const baseRecovery = computed(() => taskRecoveryAction(props.task));
const recovery = computed<TaskRecoveryAction | null>(() => {
  if (!baseRecovery.value) return null;
  if (props.workflowActive && baseRecovery.value === 'resume') return 'force-resume';
  return baseRecovery.value;
});
function act() {
  if (!props.busy && recovery.value && props.task) emit('action', recovery.value, props.task.id);
}
</script>
<template>
  <button v-if="recovery" class="button" :class="recovery === 'confirm-stopped' ? 'secondary' : 'primary'" :disabled="busy" @click="act">
    <Check v-if="recovery === 'confirm-stopped'" :size="16" /><Play v-else :size="16" />
    {{ recovery === 'adjust-site-names' ? '自动调整名称并继续' : recovery === 'force-resume' ? '强制中断并恢复' : recovery === 'resume' ? (task?.status === 'cancelled' ? '重新启动' : '恢复任务') : '已检查并确认原执行停止' }}
  </button>
</template>
