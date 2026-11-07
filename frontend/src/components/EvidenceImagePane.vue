<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { Download, LoaderCircle, RotateCw } from '@lucide/vue';
const props = defineProps<{ src: string; label: string; zoom: number | null }>();
const container = ref<HTMLElement>();
const image = ref<HTMLImageElement>();
const loading = ref(true), failed = ref(false), naturalWidth = ref(0), retry = ref(0);
function reset() {
  loading.value = true; failed.value = false; naturalWidth.value = 0;
  if (container.value) { container.value.scrollTop = 0; container.value.scrollLeft = 0; }
}
watch(() => props.src, reset);
watch(() => props.zoom, async () => {
  await nextTick();
  if (container.value) { container.value.scrollTop = 0; container.value.scrollLeft = 0; }
});
function loaded(event: Event) {
  naturalWidth.value = (event.target as HTMLImageElement).naturalWidth;
  loading.value = false;
}
function reload() { reset(); retry.value++; }
function displayScale() { return naturalWidth.value && image.value ? image.value.clientWidth / naturalWidth.value : 1; }
defineExpose({ displayScale });
</script>

<template>
  <section class="evidence-pane">
    <header class="evidence-pane-heading"><strong :title="label">{{ label }}</strong><slot /><a class="text-action" :href="src + '?download=1'" download :aria-label="'下载' + label" title="下载原图"><Download :size="16" /></a></header>
    <div ref="container" class="evidence-image-scroll" :class="{ 'fit-image': zoom === null }" tabindex="0" :aria-label="label + '预览，可滚动查看'" :aria-busy="loading">
      <div v-if="loading" class="evidence-image-state" role="status"><LoaderCircle class="spin" :size="22" />正在加载截图…</div>
      <div v-if="failed" class="evidence-image-state" role="alert"><p>截图加载失败</p><button class="button secondary small" @click="reload"><RotateCw :size="15" />重新加载</button></div>
      <img v-show="!failed && !loading" ref="image" :key="src + retry" :src="src + (retry ? '?retry=' + retry : '')" :alt="label" :class="{ 'evidence-image-zoomed': zoom !== null }" :style="zoom !== null && naturalWidth ? { width: naturalWidth * zoom + 'px' } : undefined" draggable="false" @load="loaded" @error="loading = false; failed = true" />
    </div>
  </section>
</template>

<style scoped>
.evidence-pane{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--field);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.evidence-pane-heading{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;min-height:50px;padding:7px 14px;background:var(--paper);border-bottom:1px solid var(--line)}
.evidence-pane-heading strong{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.evidence-pane-heading>.text-action{margin-left:auto;min-width:36px;min-height:36px;justify-content:center}
.evidence-image-scroll{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;background:#e9edf4}
.evidence-image-scroll img{display:block;margin:0 auto;max-width:none;flex:none}
.evidence-image-scroll.fit-image{display:flex;align-items:center;justify-content:center;padding:16px}
.evidence-image-scroll.fit-image img{max-width:100%;max-height:100%;object-fit:contain}
.evidence-image-zoomed{height:auto}
.evidence-image-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--muted);font-size:13px}
</style>
