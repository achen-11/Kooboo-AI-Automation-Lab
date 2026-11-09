<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ArrowUpCircle, Check, Download, ExternalLink, LoaderCircle, RefreshCw, X } from '@lucide/vue';
import { updateBusy, type UpdateStatus } from '../../../shared/update';
import { api, message, platform } from '../api';
import { notify } from '../lib/notifications';
import { loadUpdateStatus, updatePanelOpen, updateStatus } from '../lib/updates';
import Disclosure from './Disclosure.vue';

const props = defineProps<{ dirty?: boolean }>();
const dialog = ref<HTMLDialogElement>(), busy = ref(false), error = ref(''), confirm = ref(false);
const repository = ref(''), token = ref(''), clearToken = ref(false);
const status = updateStatus;
const running = computed(() => updateBusy(status.value?.state?.phase));
const cancellable = computed(() => ['downloading', 'preparing', 'ready', 'blocked'].includes(status.value?.state?.phase || ''));
const phase = computed(() => status.value?.state?.phase);
const installable = computed(() => !!status.value?.managed && !!status.value?.available && !running.value);
const progress = computed(() => { const state = status.value?.state; return state?.total && state.bytes !== undefined ? Math.min(100, state.bytes / state.total * 100) : undefined; });
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, generation = 0, disposed = false;
let reconnectAt = 0;
function stop() { clearTimeout(timer); timer = undefined; }
function close() { updatePanelOpen.value = false; }
function announce(value: UpdateStatus) {
  const state = value.state; if (!state || !['completed', 'failed'].includes(state.phase)) return;
  const key = `automation-update-announced-${state.id}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
  if (state.phase === 'completed' && value.currentVersion === state.version) {
    notify.success(`已更新至 v${state.version}`);
    if (platform.version && platform.version !== value.currentVersion) {
      if (props.dirty) error.value = '平台已更新，当前页面有未保存的修改；请先保存或复制内容，再刷新页面。';
      else window.location.reload();
    }
  }
}
function poll() {
  stop(); if (!updatePanelOpen.value || disposed || (!running.value && phase.value !== 'blocked')) return;
  const current = generation;
  timer = setTimeout(async () => {
    try {
      const value = await loadUpdateStatus(controller?.signal);
      if (disposed || current !== generation) return;
      error.value = ''; reconnectAt = 0; announce(value);
    } catch (reason) {
      if (disposed || current !== generation) return;
      reconnectAt ||= Date.now();
      error.value = Date.now() - reconnectAt < 90000 ? '正在等待平台重启并重新连接…' : '尚未确认平台启动结果，请检查启动窗口；不会重复安装。';
      if (Date.now() - reconnectAt >= 90000) return;
    }
    poll();
  }, 1200);
}
async function action(path: string, body?: unknown) {
  if (busy.value) return;
  const current = generation; busy.value = true; error.value = ''; stop();
  try {
    const value = await api<UpdateStatus>(path, { method: path.endsWith('/source') ? 'PUT' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller?.signal });
    if (disposed || current !== generation) return;
    status.value = value; announce(value);
  } catch (reason) {
    if (!disposed && current === generation) {
      error.value = message(reason);
      if (path === '/updates/install') await loadUpdateStatus(controller?.signal).catch(() => {});
    }
  }
  finally { if (!disposed && current === generation) { busy.value = false; poll(); } }
}
async function check() { confirm.value = false; await action('/updates/check'); }
async function install() {
  if (props.dirty) { error.value = '当前页面有未保存的修改，请先保存后再更新。'; return; }
  if (!confirm.value && phase.value !== 'blocked') { confirm.value = true; return; }
  confirm.value = false; await action('/updates/install');
}
async function saveSource() {
  await action('/updates/source', { repository: repository.value, token: token.value, clearToken: clearToken.value });
  if (!error.value) { token.value = ''; clearToken.value = false; confirm.value = false; notify.success('更新源已保存'); }
}
function reload() {
  if (props.dirty) { error.value = '当前页面有未保存的修改，请先保存或复制内容再刷新。'; return; }
  window.location.reload();
}
watch(updatePanelOpen, async open => {
  stop(); controller?.abort(); const current = ++generation;
  if (!open) { busy.value = false; dialog.value?.close(); return; }
  controller = new AbortController(); error.value = ''; confirm.value = false; reconnectAt = 0;
  dialog.value?.showModal(); busy.value = true;
  try {
    const value = await loadUpdateStatus(controller.signal);
    if (disposed || current !== generation) return;
    repository.value = value.source.repository; token.value = ''; clearToken.value = false; announce(value);
    busy.value = false;
    if (!updateBusy(value.state?.phase) && value.state?.phase !== 'blocked') await check();
    else poll();
  } catch (reason) { if (!disposed && current === generation) { error.value = message(reason); poll(); } }
  finally { if (!disposed && current === generation) busy.value = false; }
});
onUnmounted(() => { disposed = true; ++generation; stop(); controller?.abort(); });
</script>

<template>
  <dialog ref="dialog" class="modal system-update-dialog" aria-labelledby="system-update-title" @cancel.prevent="close" @close="updatePanelOpen = false">
    <div class="modal-head"><h2 id="system-update-title"><ArrowUpCircle :size="22" />系统更新</h2><button class="icon-button" aria-label="关闭更新窗口" @click="close"><X :size="20" /></button></div>
    <div class="update-content">
      <div class="update-versions"><div><span>当前版本</span><strong>{{ status ? `v${status.currentVersion}` : '正在读取…' }}</strong></div><div><span>最新版本</span><strong>{{ status?.release ? `v${status.release.version}` : '尚未检查' }}</strong></div><a v-if="status?.release" :href="status.release.pageUrl" target="_blank" rel="noopener noreferrer">查看发布页<ExternalLink :size="14" /></a></div>
      <p v-if="!error && status?.checkedAt && !status.available && !running && phase !== 'failed'" class="update-status"><Check :size="17" />已是最新版本</p>
      <section v-if="status?.release" class="release-notes"><div><h3>更新说明</h3><time>{{ new Date(status.release.publishedAt).toLocaleDateString('zh-CN') }}</time></div><p>{{ status.release.notes || '此版本尚未填写更新说明。' }}</p></section>
      <div v-if="status?.state && phase !== 'idle'" class="update-state" role="status" aria-live="polite"><p><LoaderCircle v-if="running" class="spin" :size="17" />{{ status.state.message }}</p><progress v-if="phase === 'downloading'" :value="progress" max="100" aria-label="更新包下载进度" /><small v-if="phase === 'downloading' && status.state.bytes !== undefined">{{ (status.state.bytes / 1024 / 1024).toFixed(1) }} MiB<span v-if="status.state.total"> / {{ (status.state.total / 1024 / 1024).toFixed(1) }} MiB</span></small><a v-if="phase === 'blocked'" href="#/tasks" @click="close">查看任务</a></div>
      <p v-if="status && !status.managed" class="text-muted small-text">当前使用开发目录或直接启动的服务。在线安装需使用带启动器的交付包，并通过 npm start 启动。</p>
      <p v-if="confirm" class="update-confirm" role="status">安装时将重启平台，配置和任务数据会保留。有活动任务时会暂缓安装。</p>
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <Disclosure label="更新源"><form class="update-source" @submit.prevent="saveSource"><label class="field"><span>GitHub 仓库</span><input v-model="repository" class="input" placeholder="owner/repo" :disabled="running || phase === 'blocked'" required /></label><label class="field"><span>访问令牌（私有仓库需要）</span><input v-model="token" class="input" type="password" autocomplete="off" :placeholder="status?.source.hasToken ? '已保存，留空保留' : '公开仓库可留空'" :disabled="running || phase === 'blocked'" /></label><label v-if="status?.source.hasToken" class="update-clear"><input v-model="clearToken" type="checkbox" :disabled="running || phase === 'blocked'" />清除已保存令牌</label><button class="button secondary small" :disabled="busy || running || phase === 'blocked'">保存更新源</button></form></Disclosure>
    </div>
    <div class="modal-actions"><button v-if="cancellable" class="button secondary" :disabled="busy" @click="action('/updates/cancel')">取消更新</button><button v-if="status && platform.version && status.currentVersion !== platform.version && !running" class="button secondary" @click="reload">刷新页面</button><button class="button secondary" :disabled="busy || running || phase === 'blocked'" @click="check"><LoaderCircle v-if="busy" class="spin" :size="16" /><RefreshCw v-else :size="16" />检查更新</button><button v-if="status?.available" class="button primary" :disabled="busy || !installable" @click="install"><Download :size="16" />{{ phase === 'blocked' ? '重新检查并安装' : confirm ? '确认更新' : '下载并更新' }}</button></div>
  </dialog>
</template>

<style scoped>
.update-content > .disclosure { padding-inline: 3px; }
.system-update-dialog{width:min(680px,calc(100vw - 32px));padding:26px}.modal-head h2{display:flex;align-items:center;gap:10px}.update-content{display:flex;flex-direction:column;gap:20px;max-height:65vh;overflow:auto;padding-top:18px}.update-content p{margin:0}.update-versions{display:flex;align-items:center;gap:36px;padding:20px;background:var(--surface-soft,#f5f7fb);border-radius:14px}.update-versions>div{display:flex;flex-direction:column;gap:7px}.update-versions span,.release-notes time{font-size:12px;color:var(--muted)}.update-versions strong{font-size:18px;font-variant-numeric:tabular-nums}.update-versions>a{display:flex;align-items:center;gap:5px;margin-left:auto;font-size:13px}.release-notes{padding:20px;background:var(--surface-soft,#f5f7fb);border-radius:14px}.release-notes>div{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.release-notes h3{margin:0;font-size:14px}.release-notes p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-size:13px;line-height:1.8}.update-status,.update-state>p{display:flex;align-items:center;gap:8px}.update-status{color:var(--success,#168461)}.update-state{display:flex;flex-direction:column;gap:8px;font-size:13px}.update-state progress{width:100%;height:7px;accent-color:var(--primary,#4f73d9)}.update-state small{color:var(--muted)}.update-confirm{padding:14px;background:var(--surface-soft,#f5f7fb);border-radius:10px;font-size:13px;line-height:1.7}.update-source{display:flex;flex-direction:column;gap:12px}.update-source .field{margin:0}.update-source>button{align-self:flex-start}.update-clear{display:flex;align-items:center;gap:7px;font-size:13px}.modal-actions{flex-wrap:wrap}@media(max-width:520px){.update-versions{flex-wrap:wrap;gap:20px}.update-versions>a{margin-left:0;width:100%}.system-update-dialog{padding:20px}}
</style>
