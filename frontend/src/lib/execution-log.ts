import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { api, message } from '../api';
import type { ExecutionFilter, ExecutionHead, ExecutionPage, ExecutionRecord } from '../../../shared/execution-log';

/** Owns the viewed history separately from the live head; inspecting an event pauses following. */
export function useExecutionLog(taskId: () => string, revision: () => number) {
  const stage = ref(''), filter = ref<ExecutionFilter>('all'), query = ref('');
  const data = shallowRef<ExecutionPage | null>(null), selected = shallowRef<ExecutionRecord | null>(null);
  const related = shallowRef<ExecutionPage['related']>([]);
  const loading = ref(false), olderLoading = ref(false), checking = ref(false), error = ref(''), following = ref(true);
  const liveTotal = ref(0);
  const records = computed(() => [...(data.value?.items || [])].reverse());
  const pending = computed(() => Math.max(0, liveTotal.value - (data.value?.total || 0)));
  const path = computed(() => {
    const params = new URLSearchParams({ pageSize: '20', filter: filter.value, q: query.value });
    if (stage.value) params.set('taskId', stage.value);
    return `/automation/tasks/${taskId()}/execution-log?${params}`;
  });
  let request = 0, controller: AbortController | undefined, headController: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function loadLatest() {
    const current = ++request, url = path.value;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    loading.value = true; olderLoading.value = false; error.value = '';
    try {
      const result = await api<ExecutionPage>(url, { signal });
      if (current !== request || url !== path.value) return;
      if (!following.value && data.value) { liveTotal.value = result.total; return; }
      data.value = result; related.value = result.related; liveTotal.value = result.total;
      if (selected.value) selected.value = result.items.find(item => item.seq === selected.value?.seq) || selected.value;
    } catch (reason) { if (!signal.aborted && current === request) error.value = message(reason); }
    finally { if (current === request) loading.value = false; }
  }
  async function latest() { following.value = true; selected.value = null; await loadLatest(); }
  function pause() { following.value = false; }
  function inspect(record: ExecutionRecord) { pause(); selected.value = record; }

  async function loadOlder() {
    if (!data.value?.hasOlder || loading.value || olderLoading.value) return;
    pause();
    const previous = data.value, current = ++request, url = path.value;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    olderLoading.value = true; error.value = '';
    try {
      const result = await api<ExecutionPage>(url + `&until=${previous.snapshotSeq}&before=${previous.items[0].seq}`, { signal });
      if (current !== request || url !== path.value) return;
      const seen = new Set(previous.items.map(item => item.seq));
      data.value = { ...previous, hasOlder: result.hasOlder, items: [...result.items.filter(item => !seen.has(item.seq)), ...previous.items] };
    } catch (reason) { if (!signal.aborted && current === request) error.value = message(reason); }
    finally { if (current === request) olderLoading.value = false; }
  }

  async function checkUpdates() {
    if (!data.value) { if (!loading.value) await loadLatest(); return; }
    if (checking.value || loading.value || olderLoading.value) return;
    const url = path.value, current = request;
    headController?.abort(); headController = new AbortController();
    const signal = headController.signal;
    checking.value = true;
    try {
      const head = await api<ExecutionHead>(url + '&head=1', { signal });
      if (signal.aborted || current !== request || url !== path.value) return;
      liveTotal.value = head.total; error.value = '';
      if (following.value && head.latestSeq !== data.value?.snapshotSeq) await loadLatest();
    } catch (reason) { if (!signal.aborted && current === request) error.value = message(reason); }
    finally { if (headController?.signal === signal) checking.value = false; }
  }

  watch(taskId, () => { stage.value = ''; related.value = []; }, { flush: 'sync' });
  watch(path, () => {
    headController?.abort(); checking.value = false; data.value = null; selected.value = null; liveTotal.value = 0; following.value = true;
    void loadLatest();
  }, { immediate: true });
  watch(revision, () => void checkUpdates());
  onMounted(() => { timer = setInterval(() => { if (!document.hidden) void checkUpdates(); }, 4000); });
  onUnmounted(() => { request++; controller?.abort(); headController?.abort(); clearInterval(timer); });
  return { stage, filter, query, data, records, related, selected, loading, olderLoading, checking, error, following, pending, latest, pause, inspect, loadOlder, checkUpdates };
}
