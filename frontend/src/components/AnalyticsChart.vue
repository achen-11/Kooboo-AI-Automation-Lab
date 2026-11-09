<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { BarChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
use([BarChart, ScatterChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, AriaComponent, CanvasRenderer]);
const props = defineProps<{ option: EChartsCoreOption; label: string }>();
const emit = defineEmits<{ bucket: [index: number]; point: [id: string] }>();
const element = ref<HTMLDivElement>();
let chart: EChartsType | undefined, observer: ResizeObserver | undefined;
onMounted(() => {
  if (!element.value) return;
  chart = init(element.value);
  chart.on('click', (raw: unknown) => {
    const event = raw as { seriesType?: string; dataIndex?: number; data?: { runId?: string } };
    if (event.data?.runId) emit('point', event.data.runId);
    else if (event.seriesType === 'bar' && typeof event.dataIndex === 'number') emit('bucket', event.dataIndex);
  });
  observer = new ResizeObserver(() => chart?.resize()); observer.observe(element.value); chart.setOption(props.option);
});
watch(() => props.option, option => chart?.setOption(option, { notMerge: true }));
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose(); });
</script>
<template><div ref="element" class="analytics-chart" role="img" :aria-label="label" /></template>
<style scoped>.analytics-chart{width:100%;height:320px;min-width:0}@media(max-width:600px){.analytics-chart{height:290px}}</style>
