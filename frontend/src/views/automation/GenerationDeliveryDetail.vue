<script setup lang="ts">
import { computed } from 'vue';
import { Copy, LoaderCircle } from '@lucide/vue';
import type { GenerationDelivery, GenerationDeliverySummary } from '../../../../shared/generation-delivery';
import { generationDeliveryStates } from '../../../../shared/generation-delivery';
import { formatDate } from '../../api';
import { notify } from '../../lib/notifications';
import Disclosure from '../../components/Disclosure.vue';
import GenerationContextDetail from './GenerationContextDetail.vue';
import { useTaskSection } from './use-task-section';

const props = defineProps<{ taskId: string; delivery: GenerationDeliverySummary }>();
const { data, loading, error, load } = useTaskSection<GenerationDelivery>(() => `/automation/tasks/${props.taskId}/generation-deliveries/${props.delivery.id}`, () => JSON.stringify(props.delivery));
const content = computed(() => data.value?.text ?? (data.value?.answer ? JSON.stringify(data.value.answer, null, 2) : ''));
async function copy() {
  try { await navigator.clipboard.writeText(content.value); notify.success('已复制发送原文'); }
  catch { notify.error('复制失败，请手动选择内容'); }
}
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载发送原文…</p>
  <template v-if="data">
    <div class="delivery-toolbar"><span class="text-muted">{{ formatDate(data.attemptedAt || data.createdAt) }} · {{ generationDeliveryStates[data.state] }}<template v-if="data.kind==='answer'"> · 工具输入</template></span><button class="text-action" @click="copy"><Copy :size="14" />复制全文</button></div>
    <pre class="task-technical outgoing-message" tabindex="0" aria-label="发送给 AI Chat 的完整原文">{{ content }}</pre>
    <div v-if="data.images.length" class="delivery-images"><a v-for="(image, index) in data.images" :key="index" :href="`/api/automation/tasks/${taskId}/generation-deliveries/${data.id}/images/${index}`" target="_blank" rel="noopener noreferrer"><img :src="`/api/automation/tasks/${taskId}/generation-deliveries/${data.id}/images/${index}`" :alt="`本次附图 ${index + 1}`" loading="lazy" /><span>图片 {{ index + 1 }}</span></a></div>
    <GenerationContextDetail v-if="data.packageId" :key="data.packageId" :task-id="taskId" :package-id="data.packageId" />
    <Disclosure label="发送标识"><dl class="task-facts"><div><dt>发送编号</dt><dd>{{ data.id }}</dd></div><div><dt>所属任务</dt><dd>{{ data.taskId }}</dd></div><div><dt>输入版本</dt><dd>{{ data.versionId }}</dd></div><div><dt>会话</dt><dd>{{ data.conversationId || '尚未确认' }}</dd></div><div v-if="data.runId"><dt>执行编号</dt><dd>{{ data.runId }}</dd></div><div v-if="data.callId"><dt>工具调用</dt><dd>{{ data.callId }}</dd></div></dl></Disclosure>
  </template>
</template>
<style scoped>
.delivery-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin:16px 0 12px;font-size:12px}
.outgoing-message{margin-bottom:18px;font-size:13px;line-height:1.9;max-height:600px}
.delivery-images{display:flex;gap:14px;overflow-x:auto;margin-bottom:18px}.delivery-images a{display:grid;gap:6px;flex:0 0 130px;font-size:12px;color:var(--muted)}.delivery-images img{width:130px;height:100px;object-fit:contain;background:var(--field);border-radius:6px}
</style>
