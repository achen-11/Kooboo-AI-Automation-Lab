<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue';
import type { DeliveryTask } from '../../../../shared/task-presentation';
import TaskDelivery from '../../components/TaskDelivery.vue';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; revision: string }>();
const emit = defineEmits<{ changed: [] }>();
const { data, loading, error, load } = useTaskSection<{ task: DeliveryTask | null; canDeliver?: boolean; canForceDeliver?: boolean; forceDeliverReason?: string; canForceRetry?: boolean; autoDelivery?: boolean; autoEvaluate?: boolean }>(() => `/automation/tasks/${props.taskId}/sections/delivery`, () => props.revision);
function changed() { void load(); emit('changed'); }
</script>
<template><p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p><p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载交付记录…</p><TaskDelivery v-if="data?.task" :task="data.task" :can-deliver="data.canDeliver" :can-force-deliver="data.canForceDeliver" :force-deliver-reason="data.forceDeliverReason" :can-force-retry="data.canForceRetry" @changed="changed" /><section v-else-if="data && !loading" class="panel settings-panel"><div class="section-heading"><h2>跨环境交付</h2></div><p class="text-muted">{{ data.autoDelivery ? (data.autoEvaluate === false ? '已配置完成后自动跨环境交付；生成完成后将跳过源站评测并自动触发迁移。' : '已配置完成后自动跨环境交付；生成与独立评测完成后将自动触发迁移与核验。') : (data.autoEvaluate === false ? '生成完成后可直接在此发起跨环境交付（已关闭自动评测）。' : '完成源环境独立评测后可在此发起跨环境交付。') }}</p></section></template>
