import { ref, shallowRef } from 'vue';
import type { UpdateStatus } from '../../../shared/update';
import { api } from '../api';

export const updatePanelOpen = ref(false);
export const updateStatus = shallowRef<UpdateStatus | null>(null);
export const openUpdatePanel = () => { updatePanelOpen.value = true; };
export async function loadUpdateStatus(signal?: AbortSignal) {
  const value = await api<UpdateStatus>('/updates', { signal });
  if (!signal?.aborted) updateStatus.value = value;
  return value;
}
