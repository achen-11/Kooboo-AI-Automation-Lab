<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ScanLine, ClipboardCheck, SlidersHorizontal, Cable, Settings2, ChevronLeft, CircleHelp, RotateCw, LogOut } from '@lucide/vue';
import { api, initialize, message, platform } from './api';
import LoginView from './views/LoginView.vue';
import TasksView from './views/TasksView.vue';
import EvaluationView from './views/EvaluationView.vue';
import SettingsView from './views/SettingsView.vue';
import RulesView from './views/RulesView.vue';

const route = ref(window.location.hash.slice(1) || '/evaluations');
const collapsed = ref(false);
const loggingOut = ref(false);
const ruleEditor = ref<{ dirty: boolean }>();
const nav = [
  { path: '/evaluations', label: '评测任务', icon: ClipboardCheck },
  { path: '/rules', label: '评分规则', icon: SlidersHorizontal },
  { path: '/environments', label: '环境连接', icon: Cable },
  { path: '/settings', label: '系统设置', icon: Settings2 },
];
const detailId = computed(() => /^\/evaluations\/([a-f0-9-]+)$/.exec(route.value)?.[1]);
function onHash(): void {
  if (route.value === '/rules' && ruleEditor.value?.dirty && !window.confirm('评分规则有未保存的修改，确定离开？')) {
    window.history.replaceState(null, '', `#${route.value}`); return;
  }
  route.value = window.location.hash.slice(1) || '/evaluations';
}
async function logout(): Promise<void> {
  if (ruleEditor.value?.dirty && !window.confirm('评分规则有未保存的修改，确定退出登录？')) return;
  loggingOut.value = true;
  try { await api('/logout', { method: 'POST' }); window.location.replace('/'); }
  catch (error) { platform.error = message(error); loggingOut.value = false; }
}
onMounted(() => { window.addEventListener('hashchange', onHash); void initialize(); });
onUnmounted(() => window.removeEventListener('hashchange', onHash));
</script>

<template>
  <div class="workspace" :class="{ 'sidebar-collapsed': collapsed }">
    <aside class="sidebar">
      <a href="#/evaluations" class="brand" aria-label="站点评测首页">
        <span class="brand-mark"><ScanLine :size="26" :stroke-width="1.6" /></span>
        <span class="brand-text"><strong>站点评测</strong><small>Site Evaluator</small></span>
      </a>
      <nav class="navigation" aria-label="主导航">
        <a v-for="item in nav" :key="item.path" :href="`#${item.path}`" :title="item.label" :aria-current="route.startsWith(item.path) ? 'page' : undefined" :class="{ active: route.startsWith(item.path) }">
          <component :is="item.icon" :size="21" :stroke-width="1.7" /><span>{{ item.label }}</span>
        </a>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-note"><CircleHelp :size="17" /><span>Kooboo 工作区 <span class="version">v0.2.0</span></span></div>
        <button v-if="platform.ready" type="button" class="sidebar-logout" title="退出登录" aria-label="退出登录" :disabled="loggingOut" @click="logout"><LogOut :size="19" :stroke-width="1.7" /><span>{{ loggingOut ? '正在退出…' : '退出登录' }}</span></button>
        <div class="sidebar-toolbar">
          <span class="online-state" :class="{ offline: !platform.online }"><i />{{ platform.online ? '在线' : '未连接' }}</span>
          <button class="icon-button" :aria-label="collapsed ? '展开导航' : '收起导航'" @click="collapsed = !collapsed"><ChevronLeft :size="18" :class="{ rotated: collapsed }" /></button>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <LoginView v-if="platform.authenticationRequired" />
      <div v-if="platform.error && !platform.authenticationRequired" class="alert error" role="alert"><span>{{ platform.error }}</span><button class="button small secondary" @click="initialize()"><RotateCw :size="15" />重试连接</button></div>
      <template v-if="platform.ready">
        <EvaluationView v-if="detailId" :key="detailId" :id="detailId" />
        <RulesView v-else-if="route === '/rules'" ref="ruleEditor" />
        <SettingsView v-else-if="route.startsWith('/settings') || route === '/environments'" :key="route" :environments-only="route === '/environments'" />
        <TasksView v-else />
      </template>
      <div v-else-if="!platform.error && !platform.authenticationRequired" class="boot-state"><span class="spinner" />正在连接Kooboo 工作区…</div>
    </main>
  </div>
</template>
