<script setup lang="ts">
import { computed } from 'vue';
import type { CompositionItem } from '../lib/usage-composition';

const props = defineProps<{ items: CompositionItem[]; label: string; empty: string }>();
const total = computed(() => props.items.reduce((sum, item) => sum + Math.max(0, item.value), 0));
const segments = computed(() => props.items.filter(item => item.value > 0));
function share(value: number) {
  if (!total.value || value <= 0) return '—';
  const percent = value / total.value * 100;
  if (percent < 0.1) return '<0.1%';
  if (percent < 100 && percent > 99.9) return '99.9%';
  return percent.toFixed(1) + '%';
}
</script>
<template>
  <figure class="usage-composition" :aria-label="label">
    <div v-if="total > 0" class="composition-bar" aria-hidden="true">
      <span v-for="item in segments" :key="item.key" class="composition-segment" :style="{ flexGrow: item.value / total, backgroundColor: item.color }" :title="`${item.label} · ${item.amount} · ${share(item.value)}`" />
    </div>
    <p v-else class="text-muted small-text">{{ empty }}</p>
    <dl v-if="items.length" class="composition-stages">
      <div v-for="item in items" :key="item.key" class="composition-row">
        <dt><span class="composition-dot" :style="{ backgroundColor: item.color }" aria-hidden="true" />{{ item.label }}</dt>
        <dd class="composition-amount">{{ item.amount }}</dd>
        <dd class="composition-share"><span class="sr-only">{{ label }}占比 </span>{{ share(item.value) }}</dd>
      </div>
    </dl>
  </figure>
</template>
<style scoped>
.usage-composition{margin:20px 0 12px}.composition-bar{display:flex;height:12px;overflow:hidden;border-radius:4px;margin-bottom:12px;gap:2px}.composition-segment{flex-basis:0;min-width:0;border-radius:1px}.composition-stages{margin:0}.composition-row{display:grid;grid-template-columns:minmax(0,1fr) 144px 64px;align-items:center;column-gap:20px;min-height:32px;font-size:13px}.composition-row dt{display:flex;align-items:center;gap:10px;min-width:0}.composition-dot{width:9px;height:9px;border-radius:2px;flex:none}.composition-row dd{margin:0;font-variant-numeric:tabular-nums}.composition-amount,.composition-share{text-align:right;white-space:nowrap}.composition-amount{font-weight:550}.composition-share{color:var(--muted);font-size:12px}
@media(max-width:600px){.composition-row{grid-template-columns:minmax(0,1fr) auto 52px;column-gap:10px;padding:6px 0;min-height:34px}.composition-row dt{gap:8px}}
</style>
