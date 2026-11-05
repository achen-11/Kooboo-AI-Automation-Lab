import { reactive } from 'vue';
import type { PublicSettings, Stage } from '../../backend/shared/types';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) { platform.authenticationRequired = true; platform.ready = false; } throw new Error(result.error || `请求失败：${response.status}`); }
  return result as T;
}
export const platform = reactive({ settings: null as PublicSettings | null, online: false, ready: false, authenticationRequired: false, browserReady: false, error: '', notice: '' });
export async function initialize(): Promise<void> {
  platform.error = '';
  try {
    await api('/session');
    platform.settings = await api<PublicSettings>('/settings');
    const health = await api<{ browserReady: boolean }>('/health');
    platform.browserReady = health.browserReady;
    platform.online = true;
    platform.ready = true; platform.authenticationRequired = false;
  } catch (error) { platform.online = false; platform.error = message(error); }
}
export async function saveSettings(input: unknown): Promise<void> {
  platform.settings = await api<PublicSettings>('/settings', { method: 'PUT', body: JSON.stringify(input) });
}
export function go(path: string): void { window.location.hash = path; }
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export const statusNames: Record<Stage, string> = { queued: '排队中', collecting: '采集中', scoring: '评分中', completed: '已完成', failed: '执行失败' };
export function formatDate(timestamp: number): string { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp); }
export function score(value: number | null | undefined): string { return value == null ? '—' : String(value); }
export function scoreClass(value: number | null | undefined): string { return value == null ? 'score-unknown' : value < (platform.settings?.threshold ?? 80) ? 'score-low' : 'score-good'; }
