<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
defineOptions({ inheritAttrs: false });
const model=defineModel<string|number>();
function change(event:Event){const value=(event.target as HTMLSelectElement).value;model.value=typeof model.value==='number'?Number(value):value;}
</script>
<template><span class="ui-select"><select v-bind="$attrs" :value="model" class="input" @change="change"><slot /></select><ChevronDown class="ui-select-chevron" :size="16" aria-hidden="true" /></span></template>
<style scoped>
.ui-select{position:relative;display:inline-flex;width:100%;min-width:0;vertical-align:middle;}
.ui-select:has(.compact-select),.ui-select:has(.history-select){width:auto;max-width:100%;}
.ui-select select{appearance:none;background-image:none!important;padding:10px 40px 10px 13px!important;text-overflow:ellipsis;min-width:0;}
.ui-select-chevron{position:absolute;right:13px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--muted);}
.ui-select:has(select:disabled){opacity:.6;}
</style>
