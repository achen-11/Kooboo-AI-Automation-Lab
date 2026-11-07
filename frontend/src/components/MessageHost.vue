<script setup lang="ts">
import { CheckCircle2, Info, TriangleAlert, CircleAlert, X } from '@lucide/vue';
import { notifications, dismissMessage, holdMessage, expireMessage } from '../lib/notifications';
const icons = { success: CheckCircle2, info: Info, warning: TriangleAlert, error: CircleAlert };
</script>

<template>
  <Teleport to="body">
    <TransitionGroup tag="div" name="floating-message" class="message-host" aria-label="操作提示">
      <div v-for="item in notifications" :key="item.id" class="floating-message" :class="`message-${item.type}`"
        :role="item.type === 'error' ? 'alert' : 'status'" aria-atomic="true"
        @mouseenter="holdMessage(item.id)" @mouseleave="expireMessage(item.id)"
        @focusin="holdMessage(item.id)" @focusout="expireMessage(item.id)">
        <component :is="icons[item.type]" :size="18" aria-hidden="true" />
        <span>{{ item.text }}</span>
        <button type="button" class="message-close" aria-label="关闭提示" @click="dismissMessage(item.id)"><X :size="16" /></button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.message-host{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;align-items:center;gap:12px;width:min(560px,calc(100vw - 32px));pointer-events:none;}
.floating-message{display:flex;align-items:center;gap:10px;max-width:100%;box-sizing:border-box;padding:13px 16px;border:1px solid #dce7df;border-radius:10px;background:#f1faf5;color:#398671;box-shadow:0 6px 24px #17223814;font-size:14px;line-height:1.6;pointer-events:auto;}
.floating-message>svg{flex-shrink:0;}
.floating-message>span{min-width:0;overflow-wrap:anywhere;}
.message-info{background:#f3f6ff;border-color:#dfe6f8;color:#5573ab;}
.message-warning{background:#fff8ec;border-color:#f1e3c9;color:#9b6b24;}
.message-error{background:#fff2f3;border-color:#f1dce0;color:#b65c67;}
.message-close{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:24px;height:24px;margin-left:6px;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;opacity:.7;}
.message-close:hover,.message-close:focus-visible{opacity:1;background:#1722380a;}
.floating-message-enter-active,.floating-message-leave-active,.floating-message-move{transition:opacity .18s ease,transform .18s ease;}
.floating-message-enter-from,.floating-message-leave-to{opacity:0;transform:translateY(-10px);}
@media(prefers-reduced-motion:reduce){.floating-message-enter-active,.floating-message-leave-active,.floating-message-move{transition:none;}}
</style>
