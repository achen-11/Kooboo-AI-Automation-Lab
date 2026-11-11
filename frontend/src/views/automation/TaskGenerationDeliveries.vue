<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import type { GenerationDeliverySummary } from '../../../../shared/generation-delivery';
import { generationDeliveryKinds } from '../../../../shared/generation-delivery';
import { formatDate } from '../../api';
import BaseSelect from '../../components/BaseSelect.vue';
import Disclosure from '../../components/Disclosure.vue';
import GenerationContextDetail from './GenerationContextDetail.vue';
import GenerationDeliveryDetail from './GenerationDeliveryDetail.vue';
import { useTaskSection } from './use-task-section';

const props = defineProps<{ taskId: string; revision?: string; preview: string }>();
type Package = { id: string; taskId: string; createdAt: number; transport: string };
const { data, loading, error, load } = useTaskSection<{ items: GenerationDeliverySummary[]; packages: Package[] }>(() => `/automation/tasks/${props.taskId}/generation-deliveries`, () => props.revision);
const selectedId = ref('');
watch(data, (value, old) => {
  if (!value?.items.some(item => item.id === selectedId.value) || selectedId.value === old?.items[0]?.id) selectedId.value = value?.items[0]?.id || '';
});
const selected = computed(() => data.value?.items.find(item => item.id === selectedId.value));
const unlinkedPackages = computed(() => data.value?.packages.filter(pkg => !data.value!.items.some(item => item.packageId === pkg.id)) || []);
const options = computed(() => (data.value?.items || []).map(item => ({ value: item.id, label: `${generationDeliveryKinds[item.kind]}${item.batch ? ` ${item.batch.number}/${item.batch.total}` : ''} · ${formatDate(item.createdAt)}` })));
</script>
<template>
  <section class="panel settings-panel">
    <div class="section-heading"><h2>发送给 AI Chat</h2><button class="text-action" :disabled="loading" @click="load">刷新</button></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
    <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载发送记录…</p>
    <template v-if="data">
      <BaseSelect v-if="options.length>1" v-model="selectedId" :options="options" aria-label="发送轮次" />
      <p v-else-if="selected" class="task-prose">{{ options[0]?.label }}</p>
      <GenerationDeliveryDetail v-if="selected" :key="selected.id" :task-id="taskId" :delivery="selected" />
      <Disclosure v-if="selected && unlinkedPackages.length" label="其他归档资料"><p class="task-prose text-muted">这些资料未保存对应的发送原文，不能据此确认已经发送。</p><div v-for="pkg in unlinkedPackages" :key="pkg.id" class="legacy-package"><p class="text-muted">{{ formatDate(pkg.createdAt) }}</p><GenerationContextDetail :task-id="taskId" :package-id="pkg.id" /></div></Disclosure>
      <template v-if="!selected && data.packages.length">
        <p class="task-prose text-muted">此历史任务未保存发送原文，可查看当时归档的任务资料。</p>
        <div v-for="pkg in data.packages" :key="pkg.id" class="legacy-package"><p class="text-muted">{{ formatDate(pkg.createdAt) }}</p><GenerationContextDetail :task-id="taskId" :package-id="pkg.id" /></div>
      </template>
      <template v-if="!selected && !data.packages.length"><p class="task-prose text-muted">尚无发送快照。以下为原始任务要求，最终消息将在执行准备完成后保存。</p><pre class="task-technical">{{ preview }}</pre></template>
    </template>
  </section>
</template>
<style scoped>
.legacy-package{padding-top:12px}.legacy-package+.legacy-package{border-top:1px solid var(--line);margin-top:12px}.legacy-package>p{font-size:12px;margin:0 0 4px}
</style>
