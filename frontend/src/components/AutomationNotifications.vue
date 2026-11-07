<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Bell, X } from '@lucide/vue';
import { api, formatDate } from '../api';
import { notify } from '../lib/notifications';
import type { AutomationNotice } from '../../../shared/automation';

const items=ref<AutomationNotice[]>([]),open=ref(false),desktop=ref(typeof Notification!=='undefined'?Notification.permission:'denied');
const unread=computed(()=>items.value.filter(n=>!n.readAt).length);
const seen=new Set<string>();let initialized=false,loading=false,disposed=false;
let timer:ReturnType<typeof setInterval>;
async function load(){
  if(loading)return;loading=true;
  try{
    const result=await api<{items:AutomationNotice[]}>('/automation/notifications');if(disposed)return;
    for(const item of result.items){
      if(initialized&&!seen.has(item.id)&&!item.readAt){
        notify.info(`${item.title}：${item.message}`);
        if(desktop.value==='granted')try{const n=new Notification(item.title,{body:item.message,tag:item.id});n.onclick=()=>{window.focus();window.location.hash=`/tasks/${item.taskId}`;n.close();};}catch{/* Persistent notification remains available. */}
      }
      seen.add(item.id);
    }
    items.value=result.items;initialized=true;
  }catch{/* The persistent inbox is fetched again after reconnect. */}
  finally{loading=false;}
}
async function read(item:AutomationNotice){try{await api(`/automation/notifications/${item.id}/read`,{method:'POST'});item.readAt=Date.now();}catch{notify.error('通知暂未标记已读，可稍后重试');}open.value=false;}
async function enableDesktop(){try{if(typeof Notification!=='undefined')desktop.value=await Notification.requestPermission();}catch{notify.error('浏览器暂不支持桌面通知');}}
onMounted(()=>{void load();timer=setInterval(()=>void load(),7000);});
onUnmounted(()=>{disposed=true;clearInterval(timer);});
</script>

<template>
  <div class="automation-notices">
    <button class="notice-trigger" :aria-expanded="open" aria-label="任务通知" @click="open=!open"><Bell :size="21" :stroke-width="1.7" /><span>通知</span><b v-if="unread">{{unread}}</b></button>
    <section v-if="open" class="notice-inbox panel" aria-label="任务通知">
      <div class="section-heading"><h2>通知</h2><button class="icon-button" aria-label="关闭通知" @click="open=false"><X :size="17" /></button></div>
      <button v-if="desktop==='default'" class="text-action" @click="enableDesktop">启用桌面通知</button>
      <p v-if="!items.length" class="text-muted">暂无任务通知</p>
      <a v-for="item in items.slice(0,40)" :key="item.id" :href="`#/tasks/${item.taskId}`" :class="{unread:!item.readAt}" @click="read(item)"><strong>{{item.title}}</strong><p>{{item.message}}</p><time>{{formatDate(item.createdAt)}}</time></a>
    </section>
  </div>
</template>

<style scoped>
.notice-trigger{position:relative;display:flex;align-items:center;gap:13px;border:0;border-radius:12px;background:transparent;color:var(--muted);padding:14px 17px;cursor:pointer;width:100%;text-align:left;}
.notice-trigger:hover{background:#f6f8fc;color:var(--ink);}
.notice-trigger b{margin-left:auto;background:#eef3ff;color:#4b71d5;border-radius:12px;padding:2px 7px;font-size:11px;}
.notice-inbox{position:fixed;left:20px;bottom:105px;width:min(380px,calc(100vw - 40px));max-height:65vh;overflow:auto;padding:20px;z-index:80;box-shadow:0 12px 40px #23334b26;}
.notice-inbox>a{display:block;padding:14px 0;border-bottom:1px solid var(--border);color:inherit;text-decoration:none;}
.notice-inbox>a.unread strong{color:var(--blue);}
.notice-inbox p{white-space:pre-wrap;line-height:1.6;font-size:13px;margin:7px 0;}
.notice-inbox time{font-size:11px;color:var(--muted);}
:global(.sidebar-collapsed .notice-trigger){justify-content:center;gap:0;padding:15px;}
:global(.sidebar-collapsed .notice-trigger > span){display:none;}
:global(.sidebar-collapsed .notice-trigger > b){position:absolute;top:2px;right:2px;margin:0;min-width:16px;padding:1px 4px;font-size:10px;line-height:14px;}
</style>
