<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId } from 'vue';
import { Bell, X, ArrowUpRight, Check, CheckCheck } from '@lucide/vue';
import { api, formatDate } from '../api';
import { notify } from '../lib/notifications';
import { createNoticeInbox, NOTICE_PAGE_SIZE, type NoticeResponse } from '../lib/notice-inbox';
import TablePagination from './TablePagination.vue';
import type { CompactNotice } from '../../../shared/task-presentation';
import { taskStatusNames } from '../../../shared/automation';

const open = ref(false), desktop = ref(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), list = ref<HTMLElement>();
const inboxId = useId();
const inbox = createNoticeInbox({
  fetchPage: page => api<NoticeResponse>(`/automation/notifications?view=compact&page=${page}&pageSize=${NOTICE_PAGE_SIZE}`),
  markRead: id => api<{ readAt?: number }>(`/automation/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => api<{ readAt?: number }>('/automation/notifications/read', { method: 'POST' }),
  announce(item) {
    notify.info(`${item.resourceName} · ${item.title}`);
    if (desktop.value === 'granted') try {
      const n = new Notification(item.title, { body: `${item.resourceName}：${item.summary}`, tag: item.id });
      n.onclick = () => { window.focus(); window.location.hash = `/tasks/${item.taskId}?tab=${item.tab}`; void inbox.read(item); n.close(); };
    } catch { /* The persistent inbox remains available. */ }
  },
  reportError: notify.error,
});
const { items, page, pages, total, unread, loading, marking, busy, error } = inbox;
let timer: ReturnType<typeof setInterval>;

function toggleInbox() { open.value = !open.value; if (open.value) void changePage(1); }
function closeInbox() { open.value = false; trigger.value?.focus(); }
function outside(event: PointerEvent) { if (event.target instanceof Node && !root.value?.contains(event.target)) open.value = false; }
async function changePage(value: number) { await inbox.load(value); await nextTick(); if (list.value) list.value.scrollTop = 0; }
function visit(item: CompactNotice) { void inbox.read(item); open.value = false; }
async function readAll() { if (await inbox.readAll()) notify.success('通知已全部标记为已读'); }
async function enableDesktop() {
  try { if (typeof Notification !== 'undefined') desktop.value = await Notification.requestPermission(); }
  catch { notify.error('浏览器暂不支持桌面通知'); }
}
onMounted(() => { void inbox.refresh(); timer = setInterval(() => void inbox.refresh(), 7000); document.addEventListener('pointerdown', outside); });
onUnmounted(() => { inbox.dispose(); clearInterval(timer); document.removeEventListener('pointerdown', outside); });
</script>

<template>
  <div ref="root" class="automation-notices" @keydown.esc.stop.prevent="closeInbox">
    <button ref="trigger" class="notice-trigger" :aria-expanded="open" :aria-controls="inboxId" :aria-label="unread ? `任务通知，${unread} 条未读` : '任务通知，无未读'" @click="toggleInbox"><Bell :size="21" :stroke-width="1.7" /><span>通知</span><b v-if="unread" aria-hidden="true">{{ unread > 99 ? '99+' : unread }}</b></button>
    <section v-if="open" :id="inboxId" class="notice-inbox panel" :aria-labelledby="`${inboxId}-title`">
      <header class="notice-header">
        <div class="notice-heading"><h2 :id="`${inboxId}-title`">通知</h2><span v-if="total" class="notice-count">{{ unread ? `${unread} 条未读` : '全部已读' }}</span></div>
        <div class="notice-actions"><button v-if="unread" class="notice-read-all" :disabled="busy" @click="readAll"><CheckCheck :size="15" />全部已读</button><button class="icon-button" aria-label="关闭通知" @click="closeInbox"><X :size="17" /></button></div>
      </header>
      <div v-if="desktop === 'default'" class="notice-desktop"><button class="text-action" @click="enableDesktop">启用桌面通知</button></div>
      <div v-if="error" class="notice-error" role="alert"><span>{{ error }}</span><button class="text-action" :disabled="busy" @click="inbox.load()">重试</button></div>
      <div ref="list" class="notice-list" :aria-busy="loading">
        <p v-if="!items.length" class="notice-empty">{{ loading ? '正在加载通知…' : error ? '暂时无法加载通知' : '暂无任务通知' }}</p>
        <ul v-else>
          <li v-for="item in items" :key="item.id" class="notice-item" :class="{ unread: item.readAt === null }">
            <a class="notice-content" :href="`#/tasks/${item.taskId}?tab=${item.tab}`" @click="visit(item)">
              <div class="notice-row"><strong><i v-if="item.readAt === null" class="notice-dot" aria-hidden="true" /><span class="sr-only">{{ item.readAt === null ? '未读：' : '已读：' }}</span>{{ item.title }}</strong><time :datetime="new Date(item.createdAt).toISOString()">{{ formatDate(item.createdAt) }}</time></div>
              <span class="notice-resource" :title="item.resourceName">{{ item.resourceName }}</span><p>{{ item.summary }}</p>
              <span v-if="item.superseded" class="notice-history">后续状态：{{ item.currentStatus ? taskStatusNames[item.currentStatus] : '已更新' }}</span>
            </a>
            <div class="notice-item-actions"><button v-if="item.readAt === null" class="notice-mark-read" :aria-label="`将${item.title}标为已读`" :disabled="marking" @click="inbox.read(item)"><Check :size="14" />标为已读</button><span v-else class="notice-read"><Check :size="14" />已读</span><a class="notice-detail" :href="`#/tasks/${item.taskId}?tab=${item.tab}`" @click="visit(item)">查看详情<ArrowUpRight :size="13" /></a></div>
          </li>
        </ul>
      </div>
      <TablePagination :page="page" :pages="pages" :total="total" :busy="busy" @change="changePage" />
    </section>
  </div>
</template>

<style scoped>
.notice-trigger{position:relative;display:flex;align-items:center;gap:13px;border:0;border-radius:12px;background:transparent;color:var(--muted);padding:14px 17px;cursor:pointer;width:100%;text-align:left;}
.notice-trigger:hover{background:#f6f8fc;color:var(--ink);}
.notice-trigger b{margin-left:auto;background:#eef3ff;color:#4b71d5;border-radius:12px;padding:2px 7px;font-size:11px;}
.notice-inbox{position:fixed;left:20px;bottom:105px;display:flex;flex-direction:column;width:min(440px,calc(100vw - 40px));max-height:min(640px,calc(100dvh - 140px));margin:0;padding:0;border:1px solid var(--line);overflow:hidden;z-index:80;box-shadow:0 12px 40px #23334b26;}
.notice-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;padding:16px 18px;border-bottom:1px solid var(--line);flex:none;}
.notice-heading,.notice-actions{display:flex;align-items:center;gap:10px;}.notice-heading h2{font-size:16px;}.notice-actions{margin-left:auto;gap:8px;}.notice-count{font-size:11px;color:var(--muted);}
.notice-read-all,.notice-mark-read,.notice-read{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);}.notice-read-all,.notice-mark-read{padding:5px 3px;border-radius:5px;}.notice-read-all:hover:not(:disabled),.notice-mark-read:hover:not(:disabled){color:var(--blue);background:#e9effc;}.notice-read-all:disabled,.notice-mark-read:disabled{opacity:.45;cursor:default;}
.notice-mark-read{min-height:28px;padding:4px 8px;border:1px solid #bdcdef;border-radius:6px;background:#fff;color:#3f64c4;font-weight:500;transition:border-color .15s,background .15s;}.notice-mark-read:hover:not(:disabled){border-color:#91abe4;background:#e9effc;}
.notice-desktop{padding:10px 18px;border-bottom:1px solid var(--line);}.notice-error{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;font-size:12px;color:var(--red);background:#fff7f7;flex:none;}
.notice-list{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px;background:#f8fafc;}.notice-list ul{display:flex;flex-direction:column;gap:8px;padding:0;margin:0;list-style:none;}.notice-empty{padding:28px 0;text-align:center;font-size:13px;color:var(--muted);}
.notice-item{border:1px solid #e5eaf2;border-radius:10px;background:var(--paper);}.notice-item.unread{background:#f1f5ff;border-color:#dbe5fc;}.notice-item:hover{border-color:#c5d3ed;}.notice-content{display:block;padding:10px 12px 0;border-radius:9px 9px 0 0;}.notice-content:focus-visible{outline-offset:-2px;}
.notice-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}.notice-row strong{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px;font-weight:600;}.notice-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--blue);}.notice-row time{padding-top:1px;white-space:nowrap;flex:none;font-size:11px;color:var(--muted);}
.notice-resource{display:block;margin-top:4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.notice-content p{line-height:1.6;font-size:12px;margin:4px 0 0;color:var(--muted);}.notice-history{display:block;margin-top:5px;font-size:11px;color:var(--muted);}.notice-item-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 12px 6px;}.notice-read{font-size:11px;}.notice-detail{margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:5px 0;color:var(--blue);font-size:12px;}
.notice-inbox :deep(.table-footer){flex:none;padding:10px 14px;}.notice-inbox :deep(.pagination){gap:7px;}
:global(.sidebar-collapsed .notice-trigger){justify-content:center;gap:0;padding:15px;}
:global(.sidebar-collapsed .notice-trigger > span){display:none;}
:global(.sidebar-collapsed .notice-trigger > b){position:absolute;top:2px;right:2px;margin:0;min-width:16px;padding:1px 4px;font-size:10px;line-height:14px;}
</style>
