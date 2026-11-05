<script setup lang="ts">
import { ref } from 'vue';
import { api, initialize, message } from '../api';
const username = ref(''), password = ref(''), error = ref(''), pending = ref(false);
async function login() {
  pending.value = true; error.value = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) }); password.value = ''; await initialize(); }
  catch (reason) { error.value = message(reason); }
  finally { pending.value = false; }
}
</script>
<template>
  <form class="panel settings-panel login-panel" @submit.prevent="login">
    <header><h1>登录站点评测</h1><p class="section-note">使用此站点所属组织的 Kooboo 管理员账号</p></header>
    <label class="field"><span>账号</span><input v-model="username" class="input" autocomplete="username" required /></label>
    <label class="field"><span>密码</span><input v-model="password" class="input" type="password" autocomplete="current-password" required /></label>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <button type="submit" class="button primary" :disabled="pending">{{ pending ? '登录中…' : '登录' }}</button>
  </form>
</template>
