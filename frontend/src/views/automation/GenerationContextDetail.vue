<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { Copy, LoaderCircle } from '@lucide/vue';
import { api, message } from '../../api';
import { notify } from '../../lib/notifications';
import Disclosure from '../../components/Disclosure.vue';

const props = defineProps<{ taskId: string; packageId: string }>();
const sections = shallowRef<Record<string, unknown> | null>(null), loading = ref(false), error = ref('');
const labels: Record<string, string> = { referenceStudy: '执行路线', instructions: '完整任务要求', guidance: '经验与执行约束', manifest: '交付清单', materials: '素材索引', sourceEvidence: '来源证据', collectionRecordBindings: '记录声明合同' };
const entries = computed(() => Object.entries(sections.value || {}));
const manifest = computed(() => sections.value?.manifest as { items?: unknown[]; evidence?: unknown[] } | undefined);
const source = computed(() => sections.value?.sourceEvidence as { entries?: unknown[]; unavailable?: unknown[] } | undefined);
const itemCount = computed(() => Array.isArray(manifest.value?.items) ? manifest.value.items.length : 0);
const missingSources = computed(() => Array.isArray(source.value?.unavailable) ? source.value.unavailable.length : 0);
const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
async function load(event?: Event) {
  if (event && !(event.target as HTMLDetailsElement).open || sections.value || loading.value) return;
  loading.value = true; error.value = '';
  try { sections.value = (await api<{ sections: Record<string, unknown> }>(`/automation/tasks/${props.taskId}/generation-context/${props.packageId}`)).sections; }
  catch (reason) { error.value = message(reason); }
  finally { loading.value = false; }
}
async function copy() {
  try { await navigator.clipboard.writeText(JSON.stringify(sections.value, null, 2)); notify.success('已复制任务资料'); }
  catch { notify.error('复制失败，请手动选择内容'); }
}
</script>
<template>
  <Disclosure label="本次任务资料" @toggle="load">
      <p v-if="loading" class="text-muted"><LoaderCircle class="spin" :size="15" />正在加载…</p>
      <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load()">重试</button></p>
      <template v-if="sections">
        <div class="context-toolbar"><span class="text-muted">{{ itemCount }} 项交付要求 · {{ Array.isArray(sections.materials) ? sections.materials.length : 0 }} 份素材 · {{ source?.entries?.length || 0 }} 份来源原件</span><button class="text-action" @click="copy"><Copy :size="14" />复制资料</button></div>
        <p v-if="missingSources" class="task-prose">{{ missingSources }} 份来源原件不可用，详情见来源证据。</p>
        <p v-else-if="!source && manifest?.evidence?.length" class="task-prose">清单引用了 {{ manifest.evidence.length }} 份证据，本任务包未附来源证据原件。</p>
        <Disclosure v-for="[key, value] in entries" :key="key" :label="labels[key] || key"><pre class="task-technical">{{ display(value) }}</pre></Disclosure>
      </template>
  </Disclosure>
</template>
<style scoped>
.context-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px;font-size:12px}
</style>
