import { onUnmounted, ref, shallowRef, watch } from 'vue';
import { api, message } from '../../api';

/** Mounted sections own their requests; switching tabs cancels stale responses. */
export function useTaskSection<T>(path: () => string, revision: () => unknown = () => '') {
  const data = shallowRef<T | null>(null), loading = ref(false), error = ref('');
  let controller: AbortController | undefined, sequence = 0;
  async function load() {
    const current = ++sequence;
    controller?.abort(); controller = new AbortController(); loading.value = true; error.value = '';
    try { const result = await api<T>(path(), { signal: controller.signal }); if (current === sequence) data.value = result; }
    catch (reason) { if (current === sequence && !controller.signal.aborted) error.value = message(reason); }
    finally { if (current === sequence) loading.value = false; }
  }
  watch([path, revision], () => void load(), { immediate: true });
  onUnmounted(() => { sequence++; controller?.abort(); });
  return { data, loading, error, load };
}
