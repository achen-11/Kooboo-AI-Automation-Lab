<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { ArrowUpToLine, Check, CircleAlert, Clock3, Copy, LoaderCircle, RefreshCw, Search, Settings2, Sparkles, Terminal, WrapText, X } from '@lucide/vue';
import type { ExecutionFilter, ExecutionRecord } from '../../../shared/execution-log';
import { executionKindNames, executionStatusNames } from '../../../shared/execution-log';
import { useExecutionLog } from '../lib/execution-log';
import { notify } from '../lib/notifications';
import BaseSelect from './BaseSelect.vue';

const props = defineProps<{ taskId: string; revision: number }>();
const emit = defineEmits<{ stageChange: [id: string] }>();
const detailsId = useId();
const { stage, filter, query, data, records, related, selected, loading, olderLoading, checking, error, following, pending, latest, pause, inspect, loadOlder, checkUpdates } = useExecutionLog(() => props.taskId, () => props.revision);
const list = ref<HTMLElement>(), panel = ref<HTMLElement>(), inspector = ref<HTMLElement>(), search = ref(''), wrap = ref(false), width = ref(420), activeTab = ref<'content' | 'raw'>('content');
const filters: { value: ExecutionFilter; label: string }[] = [{ value: 'all', label: '全部记录' }, { value: 'error', label: '异常' }, { value: 'assistant', label: 'AI 消息' }, { value: 'tool', label: '工具调用' }, { value: 'system', label: '流程记录' }];
const icons = { system: Settings2, assistant: Sparkles, tool: Terminal };
const displayed = computed(() => selected.value ? activeTab.value === 'raw' ? selected.value.message : selected.value.content : '');
let searchTimer: ReturnType<typeof setTimeout> | undefined, positioning = false;
watch(search, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query.value = value.trim().slice(0, 200); }, 250); });
watch(stage, value => emit('stageChange', value));
watch(selected, (value, previous) => { if (value && previous?.kind !== value.kind) activeTab.value = 'content'; });
async function open(record: ExecutionRecord) {
  inspect(record); await nextTick();
  if (window.matchMedia('(max-width:760px)').matches) inspector.value?.scrollIntoView({ block: 'nearest' });
}
watch(data, async (value, previous) => {
  if (!value || !following.value || value.items === previous?.items) return;
  positioning = true;
  await nextTick();
  if (list.value && following.value) list.value.scrollTop = 0;
  await nextTick(); positioning = false;
});
function scrolled() {
  const element = list.value;
  if (!positioning && following.value && element && element.scrollTop > 40) pause();
}
async function earlier() {
  const element = list.value, previous = data.value, top = element?.scrollTop || 0;
  await loadOlder(); await nextTick();
  if (element && data.value?.taskId === previous?.taskId && data.value?.snapshotSeq === previous?.snapshotSeq) element.scrollTop = top;
}
function time(value: number) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function day(value: number) { return new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }); }
function newDay(record: ExecutionRecord, index: number) { return !index || new Date(record.time).toDateString() !== new Date(records.value[index - 1].time).toDateString(); }
async function copy() { try { await navigator.clipboard.writeText(displayed.value); notify.success('已复制'); } catch { notify.error('复制失败，请手动选择内容'); } }
function rowKey(event: KeyboardEvent, index: number) {
  const items = list.value?.querySelectorAll<HTMLButtonElement>('.execution-record');
  if (!items?.length) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault(); pause(); items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))].focus();
  }
}
function close() {
  const seq = selected.value?.seq; selected.value = null;
  void nextTick(() => list.value?.querySelector<HTMLButtonElement>(`[data-seq="${seq}"]`)?.focus({ preventScroll: true }));
}
function detailKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  activeTab.value = event.key === 'Home' ? 'content' : event.key === 'End' ? 'raw' : activeTab.value === 'content' ? 'raw' : 'content';
  const parent = (event.currentTarget as HTMLElement).parentElement;
  void nextTick(() => parent?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
}
let stopResize: (() => void) | undefined;
function maximumWidth() { return Math.max(300, (panel.value?.clientWidth || 740) - 320); }
function resizeKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const max = maximumWidth();
  width.value = event.key === 'Home' ? 300 : event.key === 'End' ? max : Math.max(300, Math.min(max, width.value + (event.key === 'ArrowLeft' ? 30 : -30)));
}
function resize(event: PointerEvent) {
  if (event.button !== 0 || !panel.value) return;
  event.preventDefault(); stopResize?.();
  const start = event.clientX, original = width.value, max = maximumWidth();
  const move = (value: PointerEvent) => { width.value = Math.max(300, Math.min(max, original + start - value.clientX)); };
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); stopResize = undefined; };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop); stopResize = stop;
}
onUnmounted(() => { clearTimeout(searchTimer); stopResize?.(); });
</script>

<template>
  <section class="panel execution-panel">
    <div class="execution-toolbar">
      <h2>执行日志</h2>
      <div class="execution-controls">
        <BaseSelect v-if="related.length > 1" v-model="stage" size="small" aria-label="选择执行阶段与轮次" :options="related.map(item => ({ value: item.id === taskId ? '' : item.id, label: item.label }))" />
        <BaseSelect v-model="filter" size="small" aria-label="筛选执行记录类型" :options="filters" />
        <label class="search-field execution-search"><Search :size="15" aria-hidden="true" /><input v-model="search" type="search" maxlength="200" aria-label="搜索全部执行记录" placeholder="搜索执行记录" /></label>
        <button class="icon-button" :disabled="loading || checking" aria-label="刷新执行记录" title="刷新执行记录" @click="checkUpdates"><RefreshCw :size="17" :class="{ spin: checking || loading }" /></button>
      </div>
    </div>
    <p v-if="error" class="alert error execution-error" role="alert">{{ error }}<button class="text-action" @click="checkUpdates">重试</button></p>
    <div ref="panel" class="execution-workspace" :class="{ 'has-selection': selected }" :style="{ '--execution-detail-width': width + 'px' }" @keydown.esc="close">
      <div class="execution-ledger">
        <div ref="list" class="execution-records" tabindex="0" aria-label="按时间倒序排列的执行记录" :aria-busy="loading || olderLoading" @scroll="scrolled" @wheel="($event.deltaY > 0) && pause()" @keydown.page-down="pause" @keydown.end="pause">
          <p v-if="loading && !data" class="execution-empty"><LoaderCircle class="spin" :size="18" />正在加载执行记录…</p>
          <ol v-if="data?.items.length" class="execution-rows">
            <li v-for="(record, index) in records" :key="data.taskId + ':' + record.seq">
              <div v-if="newDay(record, index)" class="execution-day">{{ day(record.time) }}</div>
              <button type="button" class="execution-record" :class="{ selected: selected?.seq === record.seq, failed: record.status === 'failed' }" :data-seq="record.seq" :aria-pressed="selected?.seq === record.seq" :aria-label="`${time(record.time)} ${record.title} ${record.preview}`" @click="open(record)" @keydown="rowKey($event, index)">
                <time :datetime="new Date(record.time).toISOString()">{{ time(record.time) }}</time>
                <component :is="record.status === 'failed' ? CircleAlert : icons[record.kind]" class="execution-kind" :size="16" :aria-label="executionKindNames[record.kind]" />
                <span class="execution-summary"><span class="execution-title">{{ record.kind === 'system' && record.status === 'unknown' ? record.preview || '空记录' : record.title }}</span><span v-if="record.kind !== 'system' || record.status !== 'unknown'" class="execution-preview">{{ record.preview }}</span></span>
                <span v-if="record.status !== 'unknown'" class="execution-state" :class="record.status"><CircleAlert v-if="record.status === 'failed'" :size="13" /><LoaderCircle v-else-if="record.status === 'running'" class="spin" :size="13" /><Check v-else :size="13" />{{ executionStatusNames[record.status] }}</span>
              </button>
            </li>
          </ol>
          <div v-else-if="data" class="execution-empty"><Search v-if="query || filter !== 'all'" :size="22" /><Clock3 v-else :size="22" /><p>{{ query || filter !== 'all' ? '没有符合条件的记录' : '暂无执行记录' }}</p><button v-if="query || filter !== 'all'" class="text-action" @click="search = ''; query = ''; filter = 'all'">清除筛选</button></div>
          <button v-if="data?.hasOlder" class="execution-earlier" :disabled="olderLoading || loading" @click="earlier"><LoaderCircle v-if="olderLoading" class="spin" :size="15" />{{ olderLoading ? '正在加载…' : '加载更早记录' }}</button>
        </div>
        <footer class="execution-footer"><span>{{ data ? `已显示 ${data.items.length} / ${data.total} 条` : '执行记录' }}</span><button v-if="!following" class="text-action" @click="latest"><ArrowUpToLine :size="15" />{{ pending ? `${pending} 条新记录 · 回到最新` : '回到最新' }}</button><span v-else class="execution-following"><span class="execution-follow-dot" />跟随最新</span></footer>
      </div>
      <aside v-if="selected" ref="inspector" class="execution-inspector" aria-label="执行记录详情">
        <div class="execution-resizer" role="separator" tabindex="0" aria-label="调整详情宽度" aria-orientation="vertical" :aria-valuenow="width" aria-valuemin="300" :aria-valuemax="maximumWidth()" @pointerdown="resize" @keydown="resizeKey" />
        <header class="execution-inspector-header"><component :is="icons[selected.kind]" :size="17" /><strong>{{ selected.title }}</strong><button class="icon-button" aria-label="关闭记录详情" @click="close"><X :size="17" /></button></header>
        <div class="execution-inspector-meta"><time :datetime="new Date(selected.time).toISOString()">{{ day(selected.time) }} {{ time(selected.time) }}</time><span :class="{ 'error-text': selected.status === 'failed' }">{{ executionStatusNames[selected.status] }}</span></div>
        <div class="execution-detail-toolbar"><div class="execution-detail-tabs" role="tablist" aria-label="记录内容"><button :id="detailsId + '-content'" role="tab" :aria-controls="detailsId + '-panel'" :aria-selected="activeTab === 'content'" :tabindex="activeTab === 'content' ? 0 : -1" :class="{ active: activeTab === 'content' }" @click="activeTab = 'content'" @keydown="detailKey">{{ selected.command ? '命令' : '内容' }}</button><button :id="detailsId + '-raw'" role="tab" :aria-controls="detailsId + '-panel'" :aria-selected="activeTab === 'raw'" :tabindex="activeTab === 'raw' ? 0 : -1" :class="{ active: activeTab === 'raw' }" @click="activeTab = 'raw'" @keydown="detailKey">原始记录</button></div><button class="icon-button" :class="{ 'is-active': wrap }" :aria-pressed="wrap" aria-label="切换自动换行" title="自动换行" @click="wrap = !wrap"><WrapText :size="16" /></button><button class="icon-button" aria-label="复制当前内容" title="复制当前内容" @click="copy"><Copy :size="16" /></button></div>
        <div :id="detailsId + '-panel'" class="execution-detail-body" role="tabpanel" :aria-labelledby="detailsId + '-' + activeTab" tabindex="0"><pre :class="{ 'is-code': selected.command || activeTab === 'raw', 'is-wrapped': wrap || !selected.command && activeTab === 'content' }">{{ displayed }}</pre></div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.execution-records{overflow-anchor:none}
.execution-panel{overflow:hidden}.execution-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 26px;border-bottom:1px solid var(--line)}.execution-toolbar h2{flex:none}.execution-controls{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-width:0;flex-wrap:wrap}.execution-controls>.ui-select{max-width:240px}.execution-search{width:230px;min-height:36px;max-width:100%}.execution-error{margin:12px 22px}.execution-workspace{display:flex;min-height:420px;height:clamp(420px,68dvh,820px)}.execution-ledger{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}.execution-records{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.execution-rows{list-style:none;margin:0;padding:0}.execution-day{padding:13px 22px 8px;font-size:11px;font-weight:600;color:var(--muted)}.execution-record{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:11px 22px;text-align:left;border-bottom:1px solid var(--line);box-shadow:inset 3px 0 transparent}.execution-record:hover{background:#f8faff}.execution-record.selected{background:#eef3fc;box-shadow:inset 3px 0 var(--blue)}.execution-record:focus-visible{outline-offset:-2px}.execution-record time{flex:none;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.execution-kind{color:var(--muted)}.execution-record.failed .execution-kind{color:var(--red)}.execution-summary{min-width:0;display:flex;align-items:baseline;gap:12px;flex:1}.execution-title{flex:none;font-size:12px;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.execution-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)}.execution-state{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;color:var(--muted)}.execution-state.failed{color:var(--red)}.execution-state.running{color:var(--blue)}.execution-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:49px;border-top:1px solid var(--line);padding:10px 22px;font-size:11px;color:var(--muted)}.execution-following{display:inline-flex;align-items:center;gap:7px}.execution-follow-dot{width:5px;height:5px;background:var(--blue);border-radius:50%}.execution-earlier{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px;font-size:12px;color:var(--blue);border-bottom:1px solid var(--line)}.execution-earlier:hover:not(:disabled){background:#f8faff}.execution-earlier:disabled{color:var(--muted)}.execution-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;min-height:250px;padding:28px;color:var(--muted);font-size:13px}.execution-inspector{position:relative;display:flex;flex-direction:column;flex:none;width:var(--execution-detail-width);max-width:calc(100% - 300px);min-width:280px;min-height:0;border-left:1px solid var(--line);background:var(--paper)}.execution-resizer{position:absolute;z-index:2;inset:0 auto 0 -4px;width:8px;cursor:col-resize;touch-action:none}.execution-inspector-header{display:flex;align-items:center;gap:9px;padding:15px 18px 8px;min-height:47px}.execution-inspector-header>svg{color:var(--muted)}.execution-inspector-header strong{font-size:13px;font-weight:600}.execution-inspector-header .icon-button{margin-left:auto}.execution-inspector-meta{display:flex;justify-content:space-between;gap:16px;padding:0 18px 15px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.execution-detail-toolbar{display:flex;align-items:center;gap:6px;padding:0 12px;border-block:1px solid var(--line)}.execution-detail-tabs{display:flex;gap:18px;margin-right:auto}.execution-detail-tabs button{padding:12px 0;font-size:12px;color:var(--muted);border-bottom:2px solid transparent}.execution-detail-tabs button.active{color:var(--ink);border-bottom-color:var(--ink)}.execution-detail-toolbar .icon-button.is-active{background:var(--field);color:var(--blue)}.execution-detail-body{min-height:0;flex:1;overflow:auto;padding:18px;overscroll-behavior:contain}.execution-detail-body pre{font:inherit;font-size:13px;line-height:1.85;margin:0;white-space:pre;tab-size:2}.execution-detail-body pre.is-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.execution-detail-body pre.is-wrapped{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:1100px){.execution-toolbar{align-items:flex-start;flex-direction:column}.execution-controls{justify-content:flex-start;width:100%}.execution-summary{align-items:stretch;flex-direction:column;gap:3px}.execution-inspector{min-width:280px;max-width:50%}.execution-record{gap:9px;padding-inline:16px}.execution-state{font-size:0}.execution-state>svg{width:14px;height:14px}}
@media(max-width:760px){.execution-toolbar{padding:19px}.execution-controls{gap:10px}.execution-controls>.ui-select{max-width:none;flex:1}.execution-search{width:auto;flex:1;min-width:150px}.execution-workspace{height:auto;max-height:none;min-height:380px;flex-direction:column}.execution-records{max-height:55dvh;min-height:280px}.execution-inspector{width:100%;max-width:none;min-width:0;max-height:58dvh;min-height:280px;border-left:0;border-top:1px solid var(--line)}.execution-resizer{display:none}.execution-footer{padding-inline:16px}.execution-day{padding-inline:16px}}
</style>
