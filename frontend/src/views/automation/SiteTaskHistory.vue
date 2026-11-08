<script setup lang="ts">
import { ref } from 'vue';
import { ArrowUpRight, LoaderCircle } from '@lucide/vue';
import TablePagination from '../../components/TablePagination.vue';
import { formatDate } from '../../api';
import { taskStatusNames } from '../../../../shared/automation';
import type { TaskSummary } from '../../../../shared/task-presentation';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ siteId: string; revision: string }>();
const page = ref(1);
const { data, error, loading, load } = useTaskSection<{ items: TaskSummary[]; page: number; pages: number; total: number }>(
  () => `/automation/site-deliveries/${props.siteId}/tasks?page=${page.value}&pageSize=10`, () => page.value === 1 ? props.revision : '');
</script>
<template>
  <div class="site-task-history">
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="16" />正在加载执行历史…</p>
    <div v-if="data" class="table-scroll"><table class="task-table"><thead><tr><th>阶段</th><th>状态</th><th>本条成本</th><th>创建时间</th><th /></tr></thead><tbody>
      <tr v-for="task in data.items" :key="task.id"><td>{{ task.kind==='generation' ? task.optimizationRound ? '修复 '+task.optimizationRound : '生成' : '独立评测' }}</td><td>{{ taskStatusNames[task.status] }}</td><td>{{ task.usage?.priced ? '¥ '+task.usage.knownCny.toFixed(4)+(task.usage.missing?'（部分）':'') : task.usage?.requests ? '待核算' : '—' }}</td><td>{{ formatDate(task.createdAt) }}</td><td><a class="text-action" :href="`#/tasks/${task.id}?tab=execution`">执行记录<ArrowUpRight :size="14" /></a></td></tr>
    </tbody></table></div>
    <TablePagination v-if="data" :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page=$event" />
  </div>
</template>
<style scoped>.site-task-history{display:block;width:100%;min-width:0;margin-top:16px}.site-task-history table{min-width:600px}</style>
