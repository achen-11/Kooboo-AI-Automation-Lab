<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import { timingStageNames, formatDuration, type TimingSummary } from '../../../shared/timing';
import { useTaskSection } from '../views/automation/use-task-section';
import Disclosure from './Disclosure.vue';
import UsageComposition from './UsageComposition.vue';
import { stageColors } from '../lib/usage-composition';
const props = defineProps<{ taskId: string; siteId?: string; revision?: string }>();
const { data, loading, error, load } = useTaskSection<TimingSummary>(() => (props.siteId ? `/automation/site-deliveries/${props.siteId}` : `/automation/tasks/${props.taskId}`) + '/timing', () => props.revision);
const composition = computed(() => (data.value?.stages || []).map(item => ({
  key: item.stage, label: timingStageNames[item.stage], value: item.recordedMs,
  amount: item.recordedMs || data.value?.complete ? formatDuration(item.recordedMs) : '未记录', color: stageColors[item.stage],
})));
defineExpose({ loading, load });
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { if (data.value?.active && !loading.value && document.visibilityState !== 'hidden') void load(); }, 5000); });
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="task-timing">
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="!data && loading" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载耗时…</p>
    <template v-if="data">
      <div class="timing-totals"><div><span>流程跨度</span><strong>{{ formatDuration(data.elapsedMs) }}</strong></div><div><span>已记录阶段耗时</span><strong>{{ data.recordedMs || data.complete ? formatDuration(data.recordedMs) : '未记录' }}</strong></div><div><span>模型请求耗时</span><strong>{{ formatDuration(data.modelMs) }}</strong></div></div>
      <UsageComposition :items="composition" label="阶段耗时构成" empty="暂无阶段耗时占比数据" />
      <p v-if="!data.complete" class="timing-note text-muted small-text">历史任务或执行中断缺少完整阶段计时，已有请求耗时仍可查看。</p>
      <Disclosure class="timing-note" label="计时口径"><p class="text-muted small-text">{{ siteId ? '包含此站全部生成、修复、评测与经验学习。' : '包含本流程关联的修复与评测。' }}流程跨度从最早任务创建到最后已记录阶段，包含等待；阶段耗时单独记录排队、准备、生成、评测和跟进，内嵌清单规划与经验学习不会重复计入外层阶段。占比按各阶段已记录耗时之和计算；已记录阶段总耗时按并发区间取并集，各阶段可能重叠，因此占比基数可能大于总耗时。模型请求耗时仅覆盖有起止记录的请求，不包含工具执行与排队。服务中断只计至最后心跳，缺失时间不推断。</p></Disclosure>
    </template>
  </div>
</template>
<style scoped>
.timing-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;align-items:end;margin-bottom:16px}.timing-totals>div{display:flex;flex-direction:column;gap:8px;min-width:0}.timing-totals span{font-size:12px;color:var(--muted)}.timing-totals strong{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3;overflow-wrap:anywhere}.timing-totals>div:first-child strong{font-size:28px;font-weight:650}.timing-note{margin:12px 0}
@media(max-width:1000px){.timing-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:500px){.timing-totals strong{font-size:17px}.timing-totals>div:first-child strong{font-size:24px}}
</style>
