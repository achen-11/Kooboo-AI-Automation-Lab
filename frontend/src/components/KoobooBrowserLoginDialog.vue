<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Globe, LoaderCircle, RefreshCw, X } from '@lucide/vue';
import { api, message } from '../api';
import type { KoobooBrowserLoginStatus, KoobooConnectionInput } from '../../../shared/kooboo-auth';

const emit = defineEmits<{
  connected: [result: Extract<KoobooBrowserLoginStatus, { status: 'connected' }>];
  useOrigin: [payload: { id: string; origin: string }];
}>();

const dialog = ref<HTMLDialogElement>();
const connection = ref<KoobooConnectionInput>();
const status = ref<KoobooBrowserLoginStatus>();
const starting = ref(false);
const cancelling = ref(false);
const error = ref('');
let pollTimer: number | undefined;
let openRevision = 0;

const browserLabel = computed(() =>
  status.value && 'browserChannel' in status.value ? status.value.browserChannel : '浏览器',
);
const mismatchOrigin = computed(() =>
  status.value?.status === 'environment-mismatch' ? status.value.origin : '',
);
const terminalError = computed(() => {
  if (error.value) return error.value;
  if (status.value?.status === 'failed' || status.value?.status === 'cancelled') {
    return status.value.error || '浏览器登录已结束，请重试';
  }
  return '';
});

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function resetState(): void {
  stopPolling();
  openRevision++;
  connection.value = undefined;
  status.value = undefined;
  starting.value = false;
  cancelling.value = false;
  error.value = '';
}

async function pollOnce(sessionId: string, revision: number): Promise<void> {
  if (revision !== openRevision) return;
  try {
    const next = await api<KoobooBrowserLoginStatus>(`/environments/browser-login/${sessionId}`);
    if (revision !== openRevision) return;
    status.value = next;
    if (next.status === 'connected') {
      stopPolling();
      dialog.value?.close();
      resetState();
      emit('connected', next);
      return;
    }
    if (next.status === 'failed' || next.status === 'cancelled' || next.status === 'environment-mismatch') {
      stopPolling();
    }
  } catch (reason) {
    if (revision !== openRevision) return;
    stopPolling();
    error.value = message(reason);
  }
}

async function startSession(input: KoobooConnectionInput): Promise<void> {
  stopPolling();
  const revision = ++openRevision;
  connection.value = { id: input.id, name: input.name, origin: input.origin, apiOrigin: input.apiOrigin };
  status.value = undefined;
  error.value = '';
  starting.value = true;
  try {
    const initial = await api<KoobooBrowserLoginStatus>('/environments/browser-login/start', {
      method: 'POST',
      body: JSON.stringify(connection.value),
    });
    if (revision !== openRevision) {
      if ('sessionId' in initial) {
        void api(`/environments/browser-login/${initial.sessionId}/cancel`, { method: 'POST' }).catch(() => {});
      }
      return;
    }
    status.value = initial;
    if (initial.status === 'connected') {
      dialog.value?.close();
      resetState();
      emit('connected', initial);
      return;
    }
    if (initial.status === 'waiting' || initial.status === 'verifying') {
      pollTimer = window.setInterval(() => {
        void pollOnce(initial.sessionId, revision);
      }, 900);
    }
  } catch (reason) {
    if (revision === openRevision) error.value = message(reason);
  } finally {
    if (revision === openRevision) starting.value = false;
  }
}

async function open(input: KoobooConnectionInput): Promise<void> {
  if (!dialog.value?.open) dialog.value?.showModal();
  await startSession(input);
}

async function retry(): Promise<void> {
  if (!connection.value || starting.value) return;
  await startSession(connection.value);
}

function useSuggestedOrigin(): void {
  if (!connection.value || !mismatchOrigin.value) return;
  const payload = { id: connection.value.id, origin: mismatchOrigin.value };
  const nextInput: KoobooConnectionInput = {
    ...connection.value,
    origin: mismatchOrigin.value,
    apiOrigin: mismatchOrigin.value,
  };
  emit('useOrigin', payload);
  void startSession(nextInput);
}

async function cancelAndClose(): Promise<void> {
  if (cancelling.value) return;
  const sessionId = status.value && 'sessionId' in status.value ? status.value.sessionId : '';
  const active = status.value?.status === 'waiting' || status.value?.status === 'verifying';
  stopPolling();
  if (sessionId && active) {
    cancelling.value = true;
    try {
      await api(`/environments/browser-login/${sessionId}/cancel`, { method: 'POST' });
    } catch {
      // Closing locally even if the session already ended.
    } finally {
      cancelling.value = false;
    }
  }
  dialog.value?.close();
  resetState();
}

function onDialogCancel(event: Event): void {
  event.preventDefault();
  void cancelAndClose();
}

onBeforeUnmount(() => {
  const sessionId = status.value && 'sessionId' in status.value ? status.value.sessionId : '';
  const active = status.value?.status === 'waiting' || status.value?.status === 'verifying';
  stopPolling();
  if (sessionId && active) {
    void api(`/environments/browser-login/${sessionId}/cancel`, { method: 'POST' }).catch(() => {});
  }
});

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="modal kooboo-browser-modal"
    aria-labelledby="kooboo-browser-login-title"
    @cancel="onDialogCancel"
  >
    <div class="browser-login-box">
      <div class="modal-head">
        <h2 id="kooboo-browser-login-title">浏览器登录 {{ connection?.name || 'Kooboo' }}</h2>
        <button type="button" class="icon-button" aria-label="关闭" :disabled="cancelling" @click="cancelAndClose()">
          <X :size="20" />
        </button>
      </div>
      <p class="connection-origin">{{ connection?.origin }}</p>

      <div v-if="starting" class="browser-status-card">
        <LoaderCircle class="spin" :size="20" />
        <div>
          <strong>正在打开本机浏览器窗口…</strong>
          <p class="text-muted small-text">首次启动可能需要几秒钟，请稍候。</p>
        </div>
      </div>

      <div v-else-if="status?.status === 'verifying'" class="browser-status-card">
        <LoaderCircle class="spin" :size="20" />
        <div>
          <strong>已检测到登录凭据，正在验证站点访问权限…</strong>
          <p class="text-muted small-text">验证通过后会自动加密保存并关闭登录窗口。</p>
        </div>
      </div>

      <div v-else-if="status?.status === 'waiting'" class="browser-status-card">
        <Globe :size="20" class="browser-icon" />
        <div>
          <strong>已通过 {{ browserLabel }} 打开登录窗口</strong>
          <p class="text-muted small-text">
            请在弹出的窗口中完成登录（支持 Google / SSO / 邮箱验证码），登录成功后平台将自动获取凭据并保存，无需手动复制令牌。
          </p>
          <p v-if="status.message" class="text-muted small-text status-subnote">{{ status.message }}</p>
        </div>
      </div>

      <div v-else-if="mismatchOrigin" class="alert info" role="status">
        <div>
          <p>该账号在浏览器中登录到的实际环境为 <strong>{{ mismatchOrigin }}</strong>。</p>
          <button type="button" class="text-action" @click="useSuggestedOrigin()">改用此地址并重新打开登录</button>
        </div>
      </div>

      <p v-if="terminalError" class="alert error" role="alert">{{ terminalError }}</p>

      <p class="text-muted small-text">
        平台仅在本地加密保存访问凭据，并复用独立登录窗口配置以减少重复登录 Google 账号。
      </p>

      <div class="modal-actions">
        <button type="button" class="button secondary" :disabled="cancelling" @click="cancelAndClose()">
          {{ terminalError || mismatchOrigin ? '关闭' : '取消登录' }}
        </button>
        <button
          v-if="terminalError"
          type="button"
          class="button primary"
          :disabled="starting"
          @click="retry()"
        >
          <RefreshCw :size="16" />重新打开窗口
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.kooboo-browser-modal { max-width: 480px; }
.browser-login-box { display: flex; flex-direction: column; gap: 14px; }
.connection-origin { overflow-wrap: anywhere; color: var(--muted); margin: 0; font-size: 13px; }
.browser-status-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-radius: 12px;
  background: var(--field);
  line-height: 1.7;
}
.browser-status-card strong { display: block; margin-bottom: 4px; font-size: 14px; }
.browser-status-card p { margin: 0; }
.browser-icon { color: var(--blue); margin-top: 2px; }
.status-subnote { margin-top: 6px !important; color: var(--orange); }
.alert p { margin: 0 0 6px; }
</style>
