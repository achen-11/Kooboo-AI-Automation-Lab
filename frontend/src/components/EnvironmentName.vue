<script setup lang="ts">
import { computed } from 'vue';
import { platform } from '../api';

const props = defineProps<{ environmentId?: string }>();
const environment = computed(() => platform.settings?.environments.find(item => item.id === props.environmentId));
const name = computed(() => environment.value?.name || (props.environmentId ? `未知环境（${props.environmentId}）` : '未指定环境'));
const title = computed(() => environment.value ? `${name.value} · ${environment.value.origin}` : name.value);
</script>

<template><span :title="title" :aria-label="'环境：' + name">{{ name }}</span></template>
