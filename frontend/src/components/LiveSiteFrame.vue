<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{ url: string; title: string; width: number }>();
const container = ref<HTMLElement>();
const size = ref({ width: 0, height: 0 });
const scale = computed(() => Math.min(1, size.value.width / props.width) || 1);
const frameStyle = computed(() => ({
  width: `${props.width}px`,
  height: `${size.value.height / scale.value}px`,
  transform: `scale(${scale.value})`,
  visibility: size.value.width ? 'visible' as const : 'hidden' as const,
}));
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) size.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  if (container.value) observer.observe(container.value);
});
onUnmounted(() => observer?.disconnect());
</script>

<template>
  <div ref="container" class="live-frame" :style="{ maxWidth: `${width}px` }">
    <iframe
      :src="url"
      :title="title"
      :style="frameStyle"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer"
    />
  </div>
</template>
