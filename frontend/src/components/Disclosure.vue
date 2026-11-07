<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
defineProps<{ label: string }>();
</script>
<template><details class="disclosure"><summary><ChevronRight :size="16" /><span>{{ label }}</span></summary><div class="disclosure-content"><slot /></div></details></template>
<style scoped>
.disclosure>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;min-height:36px;font-size:13px;color:var(--muted)}
.disclosure>summary::-webkit-details-marker{display:none}.disclosure[open]>summary svg{transform:rotate(90deg)}.disclosure-content{padding-top:12px;min-width:0}
</style>
