<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { ChevronLeft, ChevronRight, Columns2, Image, X, ZoomIn, ZoomOut } from '@lucide/vue';
import type { MaterialFile } from '../../../shared/automation';
import { comparisonFor, evidenceImages, evidenceLabel, type EvidenceContext } from '../lib/evidence-preview';
import BaseSelect from './BaseSelect.vue';
import EvidenceImagePane from './EvidenceImagePane.vue';

const props = defineProps<{ taskId: string; artifacts: MaterialFile[] }>();
const dialog = ref<HTMLDialogElement>();
const filmstrip = ref<HTMLElement>();
const headingId = useId(), detailId = useId();
const contexts = ref<EvidenceContext[]>([]), contextIndex = ref(0), selectedName = ref('');
const mode = ref<'single' | 'compare'>('single'), zoom = ref<number | null>(null);
const referenceName = ref(''), targetName = ref('');
const severityNames = { critical: '严重', major: '主要', minor: '次要' };
const context = computed(() => contexts.value[contextIndex.value]);
const images = computed(() => evidenceImages(props.artifacts, context.value?.evidence || []));
const selected = computed(() => images.value.find(file => file.name === selectedName.value));
const pair = computed(() => selected.value ? comparisonFor(images.value, selected.value) : null);
const comparing = computed(() => mode.value === 'compare' && !!pair.value);
const choices = (role: 'reference' | 'target') => images.value.filter(file => file.role === role && file.viewport === selected.value?.viewport);
const label = (file: MaterialFile) => evidenceLabel(file, images.value.findIndex(item => item.name === file.name));
const artifact = (file: MaterialFile) => `/api/v1/automation/reports/${props.taskId}/artifacts/${encodeURIComponent(file.name)}`;
const panes = computed(() => comparing.value
  ? [images.value.find(file => file.name === referenceName.value), images.value.find(file => file.name === targetName.value)].filter((file): file is MaterialFile => !!file)
  : selected.value ? [selected.value] : []);
const paneRefs = new Map<string, InstanceType<typeof EvidenceImagePane>>();
const setPane = (name: string, value: unknown) => { if (value) paneRefs.set(name, value as InstanceType<typeof EvidenceImagePane>); else paneRefs.delete(name); };
function choose(file: MaterialFile, autoMode = false) {
  const previousViewport = selected.value?.viewport;
  selectedName.value = file.name;
  const match = comparisonFor(images.value, file);
  const preserveOther = !autoMode && previousViewport === file.viewport;
  if (!preserveOther || file.role === 'reference') referenceName.value = match?.reference.name || '';
  if (!preserveOther || file.role === 'target') targetName.value = match?.target.name || '';
  if (autoMode || !match) mode.value = match ? 'compare' : 'single';
}
function selectSide(role: 'reference' | 'target', name: string) {
  const file = choices(role).find(file => file.name === name);
  if (!file) return;
  selectedName.value = name;
  if (role === 'reference') referenceName.value = name; else targetName.value = name;
}
function stepContext(delta: number) {
  const next = contextIndex.value + delta;
  if (!contexts.value[next]) return;
  contextIndex.value = next; zoom.value = null;
  const file = images.value[0];
  if (file) choose(file, true); else selectedName.value = '';
}
function stepImage(delta: number) {
  const index = images.value.findIndex(file => file.name === selectedName.value);
  const file = images.value[index + delta];
  if (file) choose(file);
}
function onKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('select,input,textarea,a,[contenteditable],[role="combobox"]')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepImage(event.key === 'ArrowLeft' ? -1 : 1); }
}
function changeZoom(delta: number) {
  const current = zoom.value ?? paneRefs.get(selectedName.value)?.displayScale() ?? 1;
  zoom.value = Math.max(.1, Math.min(3, Math.round((current + delta) * 100) / 100));
}
watch(selectedName, async () => {
  await nextTick();
  filmstrip.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
let previousOverflow: string | undefined;
function unlockScroll() {
  if (previousOverflow !== undefined) { document.body.style.overflow = previousOverflow; previousOverflow = undefined; }
}
function closed() { unlockScroll(); contexts.value = []; selectedName.value = ''; }
async function open(items: EvidenceContext[], index: number, fileName: string, autoCompare = true) {
  contexts.value = items; contextIndex.value = index; zoom.value = null;
  await nextTick();
  const file = images.value.find(file => file.name === fileName);
  if (!file) return;
  choose(file, true);
  if (!autoCompare) mode.value = 'single';
  if (!dialog.value?.open) {
    dialog.value?.showModal();
    previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  }
}
watch(() => props.taskId, () => dialog.value?.close());
onBeforeUnmount(unlockScroll);
defineExpose({ open });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="evidence-viewer" :aria-labelledby="headingId" :aria-describedby="context?.detail ? detailId : undefined" @close="closed" @keydown="onKeydown" @click="event => { if (event.target === dialog) dialog?.close(); }">
      <div class="evidence-viewer-content">
        <header class="evidence-viewer-heading">
          <div class="evidence-viewer-title"><span v-if="context?.severity" class="status-badge" :class="context.severity === 'minor' ? 'pending' : 'failed'">{{ severityNames[context.severity] }}</span><h2 :id="headingId">{{ context?.title || '证据预览' }}</h2></div>
          <nav v-if="contexts.length > 1" class="evidence-context-nav" aria-label="切换证据组"><button class="icon-button" aria-label="上一项" :disabled="contextIndex === 0" @click="stepContext(-1)"><ChevronLeft :size="18" /></button><span>{{ contextIndex + 1 }} / {{ contexts.length }}</span><button class="icon-button" aria-label="下一项" :disabled="contextIndex === contexts.length - 1" @click="stepContext(1)"><ChevronRight :size="18" /></button></nav>
          <button class="icon-button evidence-viewer-close" autofocus aria-label="关闭证据预览" title="关闭（Esc）" @click="dialog?.close()"><X :size="22" /></button>
        </header>
        <p v-if="context?.detail" :id="detailId" class="evidence-context-detail">{{ context.detail }}</p>
        <div class="evidence-viewer-toolbar">
          <div class="segmented compact" aria-label="证据查看方式"><button :class="{ selected: !comparing }" :aria-pressed="!comparing" @click="mode = 'single'"><Image :size="16" />单图查看</button><button :class="{ selected: comparing }" :aria-pressed="comparing" :disabled="!pair" :title="!pair ? '当前证据组缺少同视口的参考站或生成站截图' : undefined" @click="mode = 'compare'"><Columns2 :size="16" />左右对比</button></div>
          <div class="evidence-zoom-controls"><button class="text-action" :aria-pressed="zoom === null" @click="zoom = null">适应窗口</button><button class="icon-button" aria-label="缩小截图" :disabled="zoom !== null && zoom <= .1" @click="changeZoom(-.25)"><ZoomOut :size="17" /></button><button class="text-action evidence-zoom-value" title="以原始尺寸查看" @click="zoom = 1">{{ zoom === null ? '原始尺寸' : Math.round(zoom * 100) + '%' }}</button><button class="icon-button" aria-label="放大截图" :disabled="zoom !== null && zoom >= 3" @click="changeZoom(.25)"><ZoomIn :size="17" /></button></div>
        </div>
        <div class="evidence-viewer-panes" :class="{ comparing }">
          <EvidenceImagePane v-for="file in panes" :key="comparing ? file.role : 'single'" :ref="value => setPane(file.name, value)" :src="artifact(file)" :label="label(file)" :zoom="zoom">
            <template v-if="comparing && (file.role === 'reference' || file.role === 'target') && choices(file.role).length > 1" #heading>
              <BaseSelect variant="title" :model-value="file.name" :aria-label="'切换' + (file.role === 'reference' ? '参考站' : '生成站') + '截图'" @update:model-value="selectSide(file.role as 'reference' | 'target', String($event))" :options="choices(file.role).map(option => ({ value: option.name, label: label(option) }))" />
            </template>
          </EvidenceImagePane>
          <p v-if="!panes.length" class="empty-state">此项没有可预览的图片证据。</p>
        </div>
        <nav ref="filmstrip" class="evidence-filmstrip" aria-label="关联图片证据">
          <button v-for="file in images" :key="file.name" :class="{ selected: selectedName === file.name, paired: comparing && panes.some(pane => pane.name === file.name) }" :aria-label="'查看' + label(file)" :aria-pressed="selectedName === file.name" @click="choose(file)"><img :src="artifact(file)" :alt="label(file)" loading="lazy" /><span>{{ label(file) }}</span></button>
        </nav>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.evidence-viewer{width:calc(100vw - 48px);max-width:1800px;height:calc(100dvh - 48px);max-height:none;padding:0;border:0;border-radius:16px;color:var(--ink);background:var(--paper);box-shadow:0 24px 80px #18213140;overflow:hidden}
.evidence-viewer::backdrop{background:#17213199;backdrop-filter:blur(4px)}
.evidence-viewer-content{height:100%;display:flex;flex-direction:column;padding:20px 24px 14px;gap:14px;min-height:0}
.evidence-viewer-heading{display:flex;align-items:center;gap:18px;flex:none}.evidence-viewer-title{display:flex;align-items:center;gap:12px;min-width:0;flex:1}.evidence-viewer-title h2{font-size:18px;line-height:1.5;overflow-wrap:anywhere}.evidence-viewer-title .status-badge{flex:none}
.evidence-context-nav{display:flex;align-items:center;gap:4px;white-space:nowrap;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}.evidence-viewer-close{flex:none}.evidence-context-detail{max-height:18vh;overflow:auto;line-height:1.8;font-size:13px;white-space:pre-wrap;flex:none}
.evidence-viewer-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:12px 24px;flex:none}.evidence-viewer-toolbar .segmented button{display:inline-flex;align-items:center;gap:7px}.evidence-viewer-toolbar button:disabled{opacity:.4}.evidence-zoom-controls{display:flex;align-items:center;gap:8px}.evidence-zoom-value{min-width:65px;justify-content:center;font-variant-numeric:tabular-nums}.evidence-viewer .icon-button{width:38px;height:38px}.evidence-viewer .text-action{min-height:36px}
.evidence-viewer-panes{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}.evidence-viewer-panes.comparing{grid-template-columns:repeat(2,minmax(0,1fr))}
.evidence-filmstrip{display:flex;gap:10px;overflow:auto;flex:none;padding:3px 2px 5px;max-height:108px}.evidence-filmstrip>button{flex:none;width:148px;border:2px solid transparent;border-radius:7px;padding:4px;text-align:left;transition:border-color .15s,background .15s}.evidence-filmstrip>button:hover,.evidence-filmstrip>button.paired{background:var(--field)}.evidence-filmstrip>button.selected{border-color:var(--blue)}.evidence-filmstrip img{display:block;width:100%;height:54px;object-fit:contain;background:#e9edf4;border-radius:3px}.evidence-filmstrip span{display:block;font-size:11px;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:760px){.evidence-viewer{width:100vw;max-width:none;height:100dvh;border-radius:0}.evidence-viewer-content{padding:14px 12px 8px;gap:10px}.evidence-viewer-heading{flex-wrap:wrap;gap:8px}.evidence-viewer-title{flex-basis:calc(100% - 48px)}.evidence-viewer-title h2{font-size:15px}.evidence-viewer-close{position:absolute;right:12px;top:12px}.evidence-context-detail{max-height:13vh}.evidence-viewer-panes{gap:8px}.evidence-context-nav{order:1}.evidence-filmstrip{max-height:91px}.evidence-filmstrip>button{width:125px}.evidence-filmstrip img{height:42px}.evidence-viewer-toolbar{gap:6px 12px}}
</style>
