<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue';
defineProps<{ page: number; pages: number; total: number; busy?: boolean }>();
defineEmits<{ change: [page: number] }>();
</script>
<template><footer class="table-footer"><span>共 {{ total }} 条</span><div class="pagination"><button class="icon-button" :disabled="busy || page <= 1" aria-label="上一页" @click="$emit('change', page - 1)"><ChevronLeft :size="17" /></button><span>{{ page }} / {{ pages }}</span><button class="icon-button" :disabled="busy || page >= pages" aria-label="下一页" @click="$emit('change', page + 1)"><ChevronRight :size="17" /></button></div></footer></template>
