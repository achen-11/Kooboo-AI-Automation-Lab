<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import type { DeliveryTask } from '../../../../shared/task-presentation';
import TaskDelivery from '../../components/TaskDelivery.vue';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; revision: string }>();
const emit = defineEmits<{ changed: [] }>();
const { data, loading, error, load } = useTaskSection<{ task: DeliveryTask | null }>(() => `/automation/tasks/${props.taskId}/sections/delivery`, () => props.revision);
function changed() { void load(); emit('changed'); }
</script>
<template><p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p><p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载交付记录…</p><TaskDelivery v-if="data?.task" :task="data.task" @changed="changed" /></template>
