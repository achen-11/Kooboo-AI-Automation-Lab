<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { AlertCircle, Check, Download, LoaderCircle, RefreshCw, X } from '@lucide/vue';
import { diagnosticActive, type DiagnosticExport } from '../../../../shared/diagnostics';
import { api, formatDate, message, sessionFetch } from '../../api';
import { notify } from '../../lib/notifications';
import Disclosure from '../../components/Disclosure.vue';
const props = defineProps<{ taskId: string }>();
const dialog = ref<HTMLDialogElement>(), job = ref<DiagnosticExport>(), busy = ref(false), error = ref('');
const active = computed(() => !!job.value && diagnosticActive(job.value.status));
const ready = computed(() => !!job.value && ['ready', 'partial'].includes(job.value.status));
let timer: ReturnType<typeof setTimeout> | undefined, request = 0, disposed = false;
function stop() { clearTimeout(timer); timer = undefined; }
function poll() {
  stop(); if (!active.value || !dialog.value?.open) return;
  timer = setTimeout(async () => {
    const current = job.value?.id, token = ++request;
    try {
      const result = await api<DiagnosticExport>(`/automation/diagnostic-exports/${current}`);
      if (disposed || token !== request || job.value?.id !== current) return;
      job.value = result; error.value = '';
    } catch (reason) { if (!disposed && token === request) error.value = message(reason); }
    if (!disposed) poll();
  }, 1200);
}
async function create() {
  if (busy.value) return; busy.value = true; error.value = ''; stop(); ++request;
  const token = request;
  try { const result = await api<DiagnosticExport>(`/automation/tasks/${props.taskId}/diagnostic-exports`, { method: 'POST' }); if (disposed || token !== request) return; job.value = result; poll(); }
  catch (reason) { if (!disposed && token === request) error.value = message(reason); }
  finally { if (!disposed && token === request) busy.value = false; }
}
async function open() {
  if (disposed || dialog.value?.open) return;
  dialog.value?.showModal(); error.value = ''; busy.value = true; const token = ++request;
  try {
    const response = await sessionFetch(`/api/automation/tasks/${props.taskId}/diagnostic-exports/latest`, { credentials: 'same-origin' });
    if (disposed || token !== request) return;
    if (response.status === 404) { busy.value = false; await create(); return; }
    const result = await response.json(); if (disposed || token !== request) return; if (!response.ok) throw new Error(result.error || '无法读取排障包');
    job.value = result; poll();
  } catch (reason) { if (!disposed && token === request) error.value = message(reason); }
  finally { if (!disposed && token === request) busy.value = false; }
}
async function cancel() {
  if (!job.value || busy.value) return; busy.value = true; error.value = ''; ++request; stop();
  const token = request;
  try { const result = await api<DiagnosticExport>(`/automation/diagnostic-exports/${job.value.id}/cancel`, { method: 'POST' }); if (disposed || token !== request) return; job.value = result; notify.success('已取消排障包导出'); }
  catch (reason) { if (!disposed && token === request) { error.value = message(reason); poll(); } }
  finally { if (!disposed && token === request) busy.value = false; }
}
function close() { stop(); ++request; busy.value = false; dialog.value?.close(); }
function download() {
  if (!job.value || !ready.value) return;
  // Native browser download streams to disk instead of buffering a multi-GB Blob.
  const anchor = document.createElement('a'); anchor.href = `/api/automation/diagnostic-exports/${job.value.id}/download`; anchor.download = job.value.filename; document.body.append(anchor); anchor.click(); anchor.remove();
}
onUnmounted(() => { disposed = true; stop(); ++request; });
defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal diagnostic-export-dialog" aria-labelledby="diagnostic-title" @close="stop" @cancel.prevent="close">
    <div class="modal-head"><h2 id="diagnostic-title">导出排障包</h2><button class="icon-button" aria-label="关闭" @click="close"><X :size="20" /></button></div>
    <div class="diagnostic-content" aria-live="polite">
      <p v-if="!job && busy" class="diagnostic-status"><LoaderCircle class="spin" :size="18" />正在准备导出…</p>
      <template v-if="job">
        <p class="diagnostic-status"><LoaderCircle v-if="active" class="spin" :size="19" /><Check v-else-if="job.status === 'ready'" :size="19" /><AlertCircle v-else :size="19" /><strong>{{ job.phase }}</strong></p>
        <dl class="diagnostic-facts"><div><dt>资料快照</dt><dd>{{ formatDate(job.snapshotAt) }}</dd></div><div><dt>关联任务</dt><dd>{{ job.taskCount }} 个</dd></div><div><dt>已收集</dt><dd>{{ job.files }} 个文件 · {{ (job.bytes / 1024 / 1024).toFixed(1) }} MiB</dd></div><div><dt>完整站点包</dt><dd>{{ job.site === 'included' ? '已包含' : job.site === 'unavailable' ? '未取得' : '准备中' }}</dd></div></dl>
        <p v-if="ready" class="text-muted small-text">下载有效期至 {{ formatDate(job.expiresAt) }}。包内包含客户资料，原生站点包保留原始内容。</p>
        <p v-if="active" class="text-muted small-text">关闭此窗口后仍会继续导出，原任务继续运行。</p>
        <p v-if="job.error" class="alert error" role="alert">{{ job.error }}</p>
        <Disclosure v-if="job.issues.length" class="diagnostic-issues" :label="`${job.issues.length} 项资料缺失或局限`"><ul><li v-for="(issue, index) in job.issues.slice(0, 5)" :key="index">{{ issue.message }}<span v-if="issue.path" class="text-muted">（{{ issue.path }}）</span></li></ul><p class="text-muted small-text">下载包内保留完整说明。</p></Disclosure>
      </template>
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    </div>
    <div class="modal-actions"><button v-if="active" class="button secondary" :disabled="busy" @click="cancel">取消导出</button><button v-else class="button secondary" :disabled="busy" @click="create"><RefreshCw :size="16" />{{ job ? '重新导出' : '重试' }}</button><button v-if="ready" class="button primary" :disabled="busy" @click="download"><Download :size="16" />下载排障包</button><button v-else class="button secondary" @click="close">关闭</button></div>
  </dialog>
</template>

<style scoped>
.diagnostic-export-dialog{width:min(580px,calc(100vw - 32px))}.diagnostic-content{display:flex;flex-direction:column;gap:18px;max-height:65vh;overflow:auto;padding:4px 0}.diagnostic-content p{margin:0}.diagnostic-status{display:flex;align-items:center;gap:10px}.diagnostic-facts{display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;margin:0}.diagnostic-facts div{display:flex;flex-direction:column;gap:5px}.diagnostic-facts dt{font-size:13px;color:var(--muted)}.diagnostic-facts dd{margin:0}.diagnostic-issues summary{cursor:pointer;line-height:1.6}.diagnostic-issues ul{padding-left:20px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}@media(max-width:480px){.diagnostic-facts{grid-template-columns:1fr}}
</style>
