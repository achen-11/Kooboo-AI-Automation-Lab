<script setup lang="ts">
import { ref } from 'vue';
import { api, initialize, message } from '../api';
const error = ref(''), pending = ref(false);
async function login() {
  pending.value = true; error.value = '';
  try { await api('/login', { method: 'POST' }); await initialize(); }
  catch (reason) { error.value = message(reason); }
  finally { pending.value = false; }
}
</script>
<template>
  <form class="panel settings-panel login-panel" @submit.prevent="login">
    <header><h1>站点评测</h1><p class="section-note">连接本机服务，查看任务与评分结果</p></header>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <button type="submit" class="button primary" :disabled="pending">{{ pending ? '正在进入…' : '进入本机工作区' }}</button>
  </form>
</template>
