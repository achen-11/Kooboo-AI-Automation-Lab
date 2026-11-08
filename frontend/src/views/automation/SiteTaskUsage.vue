<script setup lang="ts">
import TaskUsage from '../../components/TaskUsage.vue';
import { LoaderCircle } from '@lucide/vue';
import type { SiteDeliverySummary } from '../../../../shared/site-delivery';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; siteId: string; revision: string }>();
const { data, error, load } = useTaskSection<SiteDeliverySummary>(() => `/automation/site-deliveries/${props.siteId}`, () => props.revision);
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <TaskUsage v-if="data" :task-id="taskId" :site-id="siteId" :summary="data.usage" :stage-costs="data.stages" />
  <p v-else-if="!error" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载站点费用…</p>
</template>
