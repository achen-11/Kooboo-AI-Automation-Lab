<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { X, LogIn, LoaderCircle, Eye, EyeOff } from '@lucide/vue';
import { api, message } from '../api';
import type { KoobooConnectionInput, KoobooLoginResult } from '../../../shared/kooboo-auth';

const emit = defineEmits<{ connected: [result: Extract<KoobooLoginResult, { status: 'connected' }>] }>();
const dialog = ref<HTMLDialogElement>();
const usernameInput = ref<HTMLInputElement>(), codeInput = ref<HTMLInputElement>();
const connection = ref<KoobooConnectionInput>();
const username = ref(''), password = ref(''), code = ref(''), error = ref('');
const busy = ref(false), reveal = ref(false);
const verification = ref<'email' | 'tel' | 'otp'>();
const suggestedOrigin = ref('');
const verificationLabel = computed(() => verification.value === 'email' ? '邮箱验证码' : verification.value === 'tel' ? '手机验证码' : '验证器验证码');

function clear(): void {
  username.value = ''; password.value = ''; code.value = ''; error.value = '';
  verification.value = undefined; reveal.value = false; suggestedOrigin.value = ''; connection.value = undefined;
}
async function open(input: KoobooConnectionInput): Promise<void> {
  clear(); connection.value = { id: input.id, name: input.name, origin: input.origin, apiOrigin: input.apiOrigin };
  dialog.value?.showModal(); await nextTick(); usernameInput.value?.focus();
}
function close(): void { if (!busy.value) { dialog.value?.close(); clear(); } }
function credentialsChanged(): void { verification.value = undefined; code.value = ''; error.value = ''; suggestedOrigin.value = ''; }
function useSuggestedOrigin(): void {
  if (!connection.value || !suggestedOrigin.value) return;
  connection.value.origin = suggestedOrigin.value; connection.value.apiOrigin = suggestedOrigin.value;
  suggestedOrigin.value = ''; error.value = ''; verification.value = undefined; code.value = '';
}
async function submit(): Promise<void> {
  if (!connection.value || busy.value) return;
  busy.value = true; error.value = ''; suggestedOrigin.value = '';
  try {
    const result = await api<KoobooLoginResult>('/environments/login', { method: 'POST', body: JSON.stringify({ ...connection.value, username: username.value, password: password.value, code: code.value || undefined }) });
    if (result.status === 'verification-required') {
      verification.value = result.method; code.value = ''; await nextTick(); codeInput.value?.focus();
    } else if (result.status === 'environment-mismatch') {
      suggestedOrigin.value = result.origin;
    } else {
      dialog.value?.close(); clear(); emit('connected', result);
    }
  } catch (reason) { error.value = message(reason); code.value = ''; }
  finally { busy.value = false; }
}
defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal kooboo-login-modal" aria-labelledby="kooboo-login-title" @cancel="busy ? $event.preventDefault() : clear()" @close="clear()">
    <form @submit.prevent="submit()">
      <div class="modal-head"><h2 id="kooboo-login-title">登录 {{ connection?.name || 'Kooboo' }}</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="close()"><X :size="20" /></button></div>
      <p class="connection-origin">{{ connection?.apiOrigin }}</p>
      <label class="field"><span>账号</span><input ref="usernameInput" v-model="username" class="input" autocomplete="username" placeholder="用户名或邮箱" required maxlength="320" :disabled="busy" @input="credentialsChanged()" /></label>
      <label class="field"><span>密码</span><div class="input-with-action"><input v-model="password" :type="reveal ? 'text' : 'password'" autocomplete="current-password" required maxlength="1000" :disabled="busy" @input="credentialsChanged()" /><button type="button" class="icon-button" :aria-label="reveal ? '隐藏密码' : '显示密码'" @click="reveal = !reveal"><EyeOff v-if="reveal" :size="18" /><Eye v-else :size="18" /></button></div></label>
      <label v-if="verification" class="field"><span>{{ verificationLabel }}</span><input ref="codeInput" v-model="code" class="input" autocomplete="one-time-code" inputmode="numeric" required maxlength="100" :disabled="busy" /><small v-if="verification !== 'otp'" class="text-muted">验证码已发送，请查收{{ verification === 'email' ? '邮箱' : '手机' }}。</small></label>
      <div v-if="suggestedOrigin" class="alert info" role="status"><p>该账号所属的环境为 {{ suggestedOrigin }}。</p><button type="button" class="text-action" @click="useSuggestedOrigin()">使用此地址重新登录</button></div>
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <p class="text-muted small-text">登录后自动加密保存访问凭据，不保存密码。</p>
      <div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="close()">取消</button><button class="button primary" :disabled="busy || !!suggestedOrigin"><LoaderCircle v-if="busy" class="spin" :size="17" /><LogIn v-else :size="17" />{{ busy ? '连接中…' : verification ? '验证并连接' : '登录并连接' }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.kooboo-login-modal{max-width:460px;}
.connection-origin{overflow-wrap:anywhere;color:var(--muted);margin:0 0 20px;}
.alert p{margin:0 0 8px;}
</style>
