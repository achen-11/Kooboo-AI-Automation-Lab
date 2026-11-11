<script setup lang="ts">
import { computed } from 'vue';
import { Check, Play } from '@lucide/vue';
import { taskRecoveryAction, type TaskRecoveryAction, type TaskRecoveryTarget } from '../../../../shared/task-presentation';

const props = defineProps<{ task?: TaskRecoveryTarget; busy?: boolean }>();
const emit = defineEmits<{ action: [action: TaskRecoveryAction, taskId: string] }>();
const recovery = computed(() => taskRecoveryAction(props.task));
function act() {
  if (!props.busy && recovery.value && props.task) emit('action', recovery.value, props.task.id);
}
</script>
<template>
  <button v-if="recovery" class="button" :class="recovery === 'resume' ? 'primary' : 'secondary'" :disabled="busy" @click="act">
    <Play v-if="recovery === 'resume'" :size="16" /><Check v-else :size="16" />
    {{ recovery === 'resume' ? (task?.status === 'cancelled' ? '重新启动' : '恢复任务') : '已检查并确认原执行停止' }}
  </button>
</template>
