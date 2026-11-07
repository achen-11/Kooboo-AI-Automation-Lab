<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
defineProps<{ label: string }>();
</script>
<template><details class="disclosure"><summary class="disclosure-summary"><ChevronRight class="disclosure-chevron" :size="16" aria-hidden="true" /><span>{{ label }}</span></summary><div class="disclosure-content"><slot /></div></details></template>
<style scoped>
.disclosure>summary{min-height:36px;font-size:13px;color:var(--muted)}
.disclosure-content{padding-top:12px;min-width:0}
</style>
