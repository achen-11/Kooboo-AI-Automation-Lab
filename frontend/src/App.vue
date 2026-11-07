<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ClipboardCheck, SlidersHorizontal, FolderOpen, FileChartColumn, Settings2, ChevronLeft, RotateCw, BookOpen } from '@lucide/vue';
import { initialize, platform } from './api';
import MessageHost from './components/MessageHost.vue';
import AutomationNotifications from './components/AutomationNotifications.vue';
import TasksView from './views/TasksView.vue';
import EvaluationView from './views/EvaluationView.vue';
import ResourcesView from './views/automation/ResourcesView.vue';
import AutomationTasks from './views/automation/TasksView.vue';
import SettingsView from './views/automation/SettingsView.vue';
import RulesView from './views/automation/RulesView.vue';
import ExperiencesView from './views/automation/ExperiencesView.vue';
const experienceEditor=ref<{dirty:boolean}>();
const experienceId=computed(()=>/^\/experiences\/([a-f0-9-]+|new)$/.exec(route.value)?.[1]);

const route = ref(window.location.hash.slice(1) || '/tasks');
const collapsed = ref(localStorage.getItem('automation-sidebar-collapsed')===null?window.matchMedia('(max-width: 800px)').matches:localStorage.getItem('automation-sidebar-collapsed')==='true');
watch(collapsed,value=>localStorage.setItem('automation-sidebar-collapsed',String(value)));
const ruleEditor = ref<{ dirty: boolean }>();
const nav = [
  { path: '/resources', label: '资源库', icon: FolderOpen },
  { path: '/tasks', label: '任务中心', icon: ClipboardCheck },
  { path: '/reports', label: '评测报告', icon: FileChartColumn },
  {path:'/experiences',label:'经验库',icon:BookOpen},
  { path: '/rules', label: '评测规则', icon: SlidersHorizontal },
  { path: '/settings', label: '系统设置', icon: Settings2 },
];
const detailId = computed(() => /^\/evaluations\/([a-f0-9-]+)$/.exec(route.value)?.[1]);
const resourceId = computed(() => /^\/resources\/([a-f0-9-]+)$/.exec(route.value)?.[1]);
const taskId = computed(() => /^\/tasks\/([a-f0-9-]+)(?:\?.*)?$/.exec(route.value)?.[1]);
const settingsEditor = ref<{dirty:boolean}>();
function onHash(): void {
  if (((route.value.startsWith('/experiences') && experienceEditor.value?.dirty) || (route.value === '/rules' && ruleEditor.value?.dirty) || (route.value.startsWith('/settings') && settingsEditor.value?.dirty)) && !window.confirm('有未保存的修改，确定离开？')) {
    window.history.replaceState(null, '', `#${route.value}`); return;
  }
  route.value = window.location.hash.slice(1) || '/tasks';
}
onMounted(() => { window.addEventListener('hashchange', onHash); void initialize(); });
onUnmounted(() => window.removeEventListener('hashchange', onHash));
</script>

<template>
  <div class="workspace" :class="{ 'sidebar-collapsed': collapsed }">
    <aside class="sidebar">
      <a href="#/tasks" class="brand" aria-label="Kooboo 自动化首页">
        <img class="brand-mark" src="/logo.png?v=kooboo-03" alt="" width="45" height="45" />
        <span class="brand-text"><strong>Kooboo 自动化</strong></span>
      </a>
      <nav class="navigation" aria-label="主导航">
        <a v-for="item in nav" :key="item.path" :href="`#${item.path}`" :title="item.label" :aria-current="route.startsWith(item.path) ? 'page' : undefined" :class="{ active: route.startsWith(item.path) }">
          <component :is="item.icon" :size="21" :stroke-width="1.7" /><span>{{ item.label }}</span>
        </a>
      </nav>
      <div class="sidebar-bottom">
        <AutomationNotifications v-if="platform.ready" />
        <div class="sidebar-toolbar">
          <span class="online-state" :class="{ offline: !platform.online }"><i />{{ platform.online ? '在线' : '未连接' }}</span>
          <button class="icon-button" :title="collapsed ? '展开导航' : '收起导航'" :aria-label="collapsed ? '展开导航' : '收起导航'" :aria-expanded="!collapsed" @click="collapsed = !collapsed"><ChevronLeft :size="18" :class="{ rotated: collapsed }" /></button>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <div v-if="platform.error" class="alert error" role="alert"><span>{{ platform.error }}</span><button class="button small secondary" @click="initialize()"><RotateCw :size="15" />重试连接</button></div>
      <template v-if="platform.ready">
        <EvaluationView v-if="detailId" :key="detailId" :id="detailId" />
        <ResourcesView v-else-if="route.startsWith('/resources')" :id="resourceId" />
        <AutomationTasks v-else-if="taskId" :key="taskId" :id="taskId" />
        <AutomationTasks v-else-if="route.startsWith('/reports')" :key="route" reports />
        <ExperiencesView v-else-if="route.startsWith('/experiences')" ref="experienceEditor" :id="experienceId" />
        <RulesView v-else-if="route === '/rules'" ref="ruleEditor" />
        <SettingsView v-else-if="route.startsWith('/settings') || route === '/environments'" :key="route" ref="settingsEditor" />
        <TasksView v-else-if="route === '/legacy-evaluations' || route === '/evaluations'" />
        <AutomationTasks v-else />
      </template>
      <div v-else-if="!platform.error" class="boot-state"><span class="spinner" />正在连接本机工作区…</div>
    </main>
  </div>
  <MessageHost />
</template>
