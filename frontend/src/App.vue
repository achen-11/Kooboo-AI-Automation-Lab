<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ClipboardCheck, SlidersHorizontal, FolderOpen, Settings2, ChevronLeft, RotateCw, BookOpen, ArrowUpCircle, ChartNoAxesCombined } from '@lucide/vue';
import { initialize, platform } from './api';
import MessageHost from './components/MessageHost.vue';
import SystemUpdateDialog from './components/SystemUpdateDialog.vue';
import { openUpdatePanel, loadUpdateStatus, updateStatus } from './lib/updates';
import AutomationNotifications from './components/AutomationNotifications.vue';
import TasksView from './views/TasksView.vue';
import EvaluationView from './views/EvaluationView.vue';
import ResourcesView from './views/automation/ResourcesView.vue';
import AutomationTasks from './views/automation/TasksView.vue';
import SettingsView from './views/automation/SettingsView.vue';
import RulesView from './views/automation/RulesView.vue';
import ExperiencesView from './views/automation/ExperiencesView.vue';
import DashboardView from './views/automation/DashboardView.vue';
const experienceEditor=ref<{dirty:boolean}>();
const experienceId=computed(()=>/^\/experiences\/([a-f0-9-]+|new)$/.exec(route.value)?.[1]);

const route = ref(window.location.hash.slice(1) || '/tasks');
const collapsed = ref(localStorage.getItem('automation-sidebar-collapsed')===null?window.matchMedia('(max-width: 800px)').matches:localStorage.getItem('automation-sidebar-collapsed')==='true');
watch(collapsed,value=>localStorage.setItem('automation-sidebar-collapsed',String(value)));
const ruleEditor = ref<{ dirty: boolean }>();
const nav = [
  { path: '/resources', label: '资源库', icon: FolderOpen },
  { path: '/tasks', label: '任务中心', icon: ClipboardCheck },
  { path: '/dashboard', label: '耗时与成本', icon: ChartNoAxesCombined },
  {path:'/experiences',label:'经验库',icon:BookOpen},
  { path: '/rules', label: '评测规则', icon: SlidersHorizontal },
  { path: '/settings', label: '系统设置', icon: Settings2 },
];
const detailId = computed(() => /^\/evaluations\/([a-f0-9-]+)$/.exec(route.value)?.[1]);
const resourceId = computed(() => /^\/resources\/([a-f0-9-]+)$/.exec(route.value)?.[1]);
const taskId = computed(() => /^\/tasks\/([a-f0-9-]+)(?:\?.*)?$/.exec(route.value)?.[1]);
const settingsEditor = ref<{dirty:boolean}>();
const editorDirty = computed(() => Boolean(experienceEditor.value?.dirty || ruleEditor.value?.dirty || settingsEditor.value?.dirty));
watch(() => platform.ready, ready => { if (ready) void loadUpdateStatus().catch(() => {}); });
function onHash(): void {
  if (((route.value.startsWith('/experiences') && experienceEditor.value?.dirty) || (route.value === '/rules' && ruleEditor.value?.dirty) || (route.value.startsWith('/settings') && settingsEditor.value?.dirty)) && !window.confirm('有未保存的修改，确定离开？')) {
    window.history.replaceState(null, '', `#${route.value}`); return;
  }
  route.value = window.location.hash.slice(1) || '/tasks';
}
function onSidebarShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
  if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
  event.preventDefault();
  collapsed.value = !collapsed.value;
}
onMounted(() => { window.addEventListener('hashchange', onHash); window.addEventListener('keydown', onSidebarShortcut); void initialize(); });
onUnmounted(() => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onSidebarShortcut); });
</script>

<template>
  <div class="workspace" :class="{ 'sidebar-collapsed': collapsed }">
    <aside class="sidebar">
      <div class="brand">
        <a href="#/tasks" aria-label="Kooboo 自动化首页"><img class="brand-mark" src="/logo.png?v=kooboo-03" alt="" width="45" height="45" /></a>
        <div class="brand-text"><a href="#/tasks"><strong>Kooboo 自动化</strong></a><button class="brand-version" :title="updateStatus?.available ? '有新版本，打开系统更新' : '打开系统更新'" @click="openUpdatePanel"><span>{{ platform.version ? `v${platform.version}` : '版本信息' }}</span><ArrowUpCircle :size="12" /><i v-if="updateStatus?.available" /></button></div>
      </div>
      <nav class="navigation" aria-label="主导航">
        <a v-for="item in nav" :key="item.path" :href="`#${item.path}`" :title="item.label" :aria-current="route.startsWith(item.path) ? 'page' : undefined" :class="{ active: route.startsWith(item.path) }">
          <component :is="item.icon" :size="21" :stroke-width="1.7" /><span>{{ item.label }}</span>
        </a>
      </nav>
      <div class="sidebar-bottom">
        <button class="icon-button compact-update" :title="updateStatus?.available ? '系统更新：有新版本' : '系统更新'" aria-label="系统更新" @click="openUpdatePanel"><ArrowUpCircle :size="19" /><i v-if="updateStatus?.available" /></button>
        <AutomationNotifications v-if="platform.ready" />
        <div class="sidebar-toolbar">
          <span class="online-state" :class="{ offline: !platform.online }"><i />{{ platform.online ? '在线' : '未连接' }}</span>
          <button class="icon-button" :title="`${collapsed ? '展开导航' : '收起导航'}（⌘B / Ctrl+B）`" :aria-label="collapsed ? '展开导航' : '收起导航'" aria-keyshortcuts="Meta+B Control+B" :aria-expanded="!collapsed" @click="collapsed = !collapsed"><ChevronLeft :size="18" :class="{ rotated: collapsed }" /></button>
        </div>
      </div>
    </aside>
    <main class="main-content">
      <div v-if="platform.error" class="alert error" role="alert"><span>{{ platform.error }}</span><button class="button small secondary" @click="initialize()"><RotateCw :size="15" />重试连接</button></div>
      <template v-if="platform.ready">
        <EvaluationView v-if="detailId" :key="detailId" :id="detailId" />
        <ResourcesView v-else-if="route.startsWith('/resources')" :id="resourceId" />
        <DashboardView v-else-if="route === '/dashboard'" />
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
  <SystemUpdateDialog :dirty="editorDirty" />
</template>

<style scoped>
.brand-version{display:flex;align-items:center;gap:5px;align-self:flex-start;padding:3px 0;border:0;background:none;color:var(--muted);font:inherit;font-size:11px;cursor:pointer}.brand-version:hover{color:var(--primary,#4f73d9)}.brand-version i,.compact-update i{width:6px;height:6px;border-radius:50%;background:#159d73}.compact-update{display:none;position:relative;margin-inline:auto}.compact-update i{position:absolute;top:4px;right:4px}.sidebar-collapsed .compact-update{display:flex}
</style>
