<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { ArrowUpRight, ListChecks, RefreshCw, X } from '@lucide/vue';
import type { QueueDiagnostics, QueueTaskReference } from '../../../../shared/queue-diagnostics';
import { taskStatusNames } from '../../../../shared/automation';
import TablePagination from '../../components/TablePagination.vue';
import { api, formatDate, message } from '../../api';
import { notify } from '../../lib/notifications';

const emit = defineEmits<{ changed: [] }>();
const dialog = ref<HTMLDialogElement>(), opened = ref(false), busy = ref(false), loading = ref(false), error = ref('');
const data = shallowRef<QueueDiagnostics | null>(null), selected = shallowRef<QueueTaskReference | null>(null), verified = ref(false);
const page = ref(1), reservationPage = ref(1);
let timer: ReturnType<typeof setInterval> | undefined, controller: AbortController | undefined, sequence = 0, disposed = false;
async function load() {
  const current = ++sequence;
  controller?.abort(); controller = new AbortController(); loading.value = true;
  try {
    const result = await api<QueueDiagnostics>(`/automation/queue-diagnostics?page=${page.value}&reservationPage=${reservationPage.value}&summaryOnly=${opened.value ? 0 : 1}`, { signal: controller.signal });
    if (disposed || current !== sequence) return;
    data.value = result; page.value = result.waiting.page; reservationPage.value = result.reservations.page;
  } catch (reason) { if (!disposed && current === sequence) error.value = message(reason); }
  finally { if (!disposed && current === sequence) loading.value = false; }
}
function refresh() { if (busy.value) return; selected.value = null; verified.value = false; error.value = ''; void load(); }
function open() { opened.value = true; page.value = 1; reservationPage.value = 1; dialog.value?.showModal(); refresh(); }
function close() {
  if (busy.value) return;
  opened.value = false; selected.value = null; verified.value = false; error.value = ''; dialog.value?.close();
  controller?.abort(); ++sequence; loading.value = false;
}
function select(task: QueueTaskReference) { selected.value = task; verified.value = false; error.value = ''; }
async function confirmStopped() {
  const task = selected.value;
  if (!task || !verified.value || busy.value) return;
  busy.value = true; error.value = ''; controller?.abort(); ++sequence; loading.value = false;
  try {
    await api(`/automation/tasks/${task.id}/${task.target === 'delivery' ? 'delivery/' : ''}confirm-stopped`, { method: 'POST', body: JSON.stringify({ expectedUpdatedAt: task.updatedAt }) });
    if (disposed) return;
    selected.value = null; verified.value = false;
    notify.success('已确认原执行停止；未自动恢复或重发任务'); emit('changed');
    await load();
  } catch (reason) { if (!disposed) { selected.value = null; verified.value = false; error.value = message(reason); } }
  finally { if (!disposed) busy.value = false; }
}
function changePage(value: number, reservations = false) {
  if (reservations) reservationPage.value = value; else page.value = value;
  refresh();
}
onMounted(() => {
  void load();
  timer = setInterval(() => { if (!document.hidden && !busy.value && !selected.value && !error.value) void load(); }, 4000);
});
onUnmounted(() => { disposed = true; ++sequence; clearInterval(timer); controller?.abort(); });
</script>

<template>
  <button class="button secondary" @click="open"><ListChecks :size="16" />队列诊断<span v-if="data?.reservations.total" class="queue-attention">{{ data.reservations.total }} 项待核查</span><span v-else-if="data && !data.workerReady" class="queue-attention">后台未就绪</span></button>
  <dialog ref="dialog" class="modal queue-dialog" aria-labelledby="queue-diagnostics-title" @cancel.prevent="close">
    <div class="modal-head"><h2 id="queue-diagnostics-title">队列诊断</h2><div class="toolbar-actions"><button class="icon-button" :disabled="busy || loading" aria-label="刷新队列诊断" @click="refresh"><RefreshCw :size="18" /></button><button class="icon-button" :disabled="busy" aria-label="关闭队列诊断" @click="close"><X :size="20" /></button></div></div>
    <div class="queue-content" :aria-busy="loading || busy">
      <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" :disabled="busy" @click="refresh">重新检查</button></p>
      <p v-if="loading && !data" role="status">正在检查队列…</p>
      <template v-if="data">
        <p v-if="!data.workerReady" class="alert error">后台执行服务未就绪。请查看启动窗口，正常重启平台后重新检查；页面在线不代表后台正在执行。</p>
        <p v-if="data.maintenance" class="alert info">平台正在更新维护，暂不领取任务。</p>
        <p v-if="!data.enabled" class="alert info">自动执行已暂停，队列中的任务会保留。<a href="#/settings" @click="close">前往设置<ArrowUpRight :size="14" /></a></p>
        <div class="queue-capacity"><div v-for="kind in (['generation', 'evaluation'] as const)" :key="kind"><strong>{{ kind === 'generation' ? '生成' : '评测' }}</strong><span>已占用 {{ data.capacity[kind].occupied }} / {{ data.capacity[kind].limit }}</span><span>执行 {{ data.capacity[kind].executing }} · 待核查 {{ data.capacity[kind].unconfirmed }}</span></div></div>
        <section>
          <h3>待核查占位（{{ data.reservations.total }}）</h3>
          <p v-if="!data.reservations.total" class="text-muted">没有发现停止状态不明的占位。</p>
          <div v-for="task in data.reservations.items" :key="task.id + task.target" class="queue-row">
            <div class="queue-row-head"><a :href="`#/tasks/${task.id}?tab=execution`" :title="`${task.id} · ${formatDate(task.updatedAt)}`" @click="close">{{ task.resourceName }}<ArrowUpRight :size="13" /></a><span>{{ task.target === 'delivery' ? '交付停止待核查' : `${task.kind === 'generation' ? '生成' : '评测'} · ${taskStatusNames[task.status]}` }}</span><button v-if="task.canConfirmStopped" class="button secondary small" :disabled="busy" @click="select(task)">确认已停止</button></div>
            <div v-if="selected?.id === task.id && selected.target === task.target" class="queue-confirm">
              <p>请先查看原任务，核实 Kooboo 会话及相关执行均已停止。此操作保留原站点、输入、证据和用量。{{ task.target === 'delivery' ? '交付结果未知时仍保留同站执行权，请进入原任务核查回执。' : '确认后释放未知执行占位，不自动恢复原任务。' }}</p>
              <label><input v-model="verified" type="checkbox" :disabled="busy" />我已核实原执行已经停止</label>
              <div class="toolbar-actions"><button class="button secondary small" :disabled="busy" @click="selected = null; verified = false">返回</button><button class="button primary small" :disabled="!verified || busy" @click="confirmStopped">{{ busy ? '正在确认…' : task.target === 'delivery' ? '确认交付已停止' : '确认并释放占位' }}</button></div>
            </div>
          </div>
          <TablePagination v-if="data.reservations.pages > 1" :page="data.reservations.page" :pages="data.reservations.pages" :total="data.reservations.total" :busy="loading || busy" @change="changePage($event, true)" />
        </section>
        <section>
          <h3>等待任务（{{ data.waiting.total }}）</h3>
          <p v-if="!data.waiting.total" class="text-muted">当前没有等待领取的生成或评测任务。</p>
          <div v-for="task in data.waiting.items" :key="task.id" class="queue-row"><div class="queue-row-head"><a :href="`#/tasks/${task.id}?tab=execution`" @click="close">{{ task.resourceName }}<ArrowUpRight :size="13" /></a><span>{{ task.kind === 'generation' ? '生成' : '评测' }} · {{ task.scope === 'homepage' ? '仅首页' : '全站' }}</span></div><p>{{ task.reason.message }}<time v-if="task.reason.nextAt"> {{ formatDate(task.reason.nextAt) }}</time></p><div v-if="task.reason.blockers.length" class="queue-blockers"><a v-for="blocker in task.reason.blockers" :key="blocker.id" :href="`#/tasks/${blocker.id}?tab=execution`" @click="close">{{ blocker.resourceName }}<ArrowUpRight :size="12" /></a><span v-if="task.reason.blockingCount > task.reason.blockers.length">共 {{ task.reason.blockingCount }} 项占用</span></div></div>
          <TablePagination v-if="data.waiting.pages > 1" :page="data.waiting.page" :pages="data.waiting.pages" :total="data.waiting.total" :busy="loading || busy" @change="changePage($event)" />
        </section>
        <p class="text-muted queue-time">检查时间：{{ formatDate(data.checkedAt) }}。确认停止不会自动恢复原任务；需要接续时请进入原任务恢复。</p>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.queue-dialog>.modal-head{padding:20px 24px 0}
.queue-dialog{width:min(820px,calc(100vw - 32px));max-height:90vh;padding:0}.queue-content{padding:20px 24px;overflow:auto;max-height:calc(90vh - 80px);display:grid;gap:20px}.queue-content p{line-height:1.65;margin:0}.queue-content h3{font-size:15px;margin:0 0 12px}.queue-capacity{display:grid;grid-template-columns:1fr 1fr;gap:16px}.queue-capacity>div{display:grid;gap:6px;padding:14px;background:var(--field);border-radius:8px}.queue-capacity span{font-size:13px}.queue-row{padding:12px 0;border-bottom:1px solid var(--border)}.queue-row-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.queue-row-head>a{min-width:0;overflow-wrap:anywhere;font-weight:550}.queue-row-head>span{color:var(--muted);font-size:12px}.queue-row-head>button{margin-left:auto}.queue-row p{margin-top:8px;font-size:13px}.queue-blockers{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px;font-size:12px}.queue-row a,.queue-content .alert a{display:inline-flex;align-items:center;gap:4px;color:var(--blue)}.queue-confirm{display:grid;gap:12px;margin-top:12px;padding:14px;background:var(--field);border-radius:8px}.queue-confirm label{display:flex;gap:8px;align-items:center;font-size:13px}.queue-confirm .toolbar-actions{justify-content:flex-end}.queue-attention{font-size:12px;color:#a65e0a}.queue-time{font-size:12px}@media(max-width:560px){.queue-content{padding:16px}.queue-capacity{grid-template-columns:1fr}.queue-row-head>button{margin-left:0}}
</style>
