<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, ChevronLeft, ChevronRight, Columns2, Layers2, Link2, Unlink2, Monitor, Smartphone, PanelsTopLeft, RotateCw } from '@lucide/vue';
import LiveSiteFrame from './LiveSiteFrame.vue';
import BaseSelect from './BaseSelect.vue';
import type { Issue, Screenshot } from '../../../shared/types.js';
import { continuousSlices, opposite, pairOptions, relatedIssues, roleShots, scopedShots, selectPair, selectShot } from '../../../shared/comparison';
import type { Pairing, Role, Selection, Viewport } from '../../../shared/comparison';

const props = withDefaults(defineProps<{
  evaluationId: string;
  runId: string;
  screenshots: Screenshot[];
  pairings?: Pairing[];
  issues?: Issue[];
  evidenceIds?: string[];
  initialEvidenceId?: string;
  targetUrl?: string;
  referenceUrl?: string;
  targetMissing?: string;
  referenceMissing?: string;
  compact?: boolean;
}>(), { pairings: () => [], issues: () => [], compact: false });

const roles = ['reference', 'target'] as const;
const names = { reference: '视觉参考', target: '生成站点' };
const shots = computed(() => scopedShots(props.screenshots, props.evidenceIds, props.pairings));
const viewport = ref<Viewport>(shots.value.some(s => s.viewport === 'desktop') ? 'desktop' : 'mobile');
const mode = ref<'split' | 'overlay' | 'iframe'>('split');
const layout = ref<'continuous' | 'segment'>(props.compact ? 'segment' : 'continuous');
const linked = ref(true), opacity = ref(50), frameRevision = ref(0);
const activeRole = ref<Role>('reference');
const empty = (): Selection => ({ reference: '', target: '', pairIndex: -1 });
const memory = ref<Record<Viewport, Selection>>({ desktop: empty(), mobile: empty() });
const list = (role: Role) => roleShots(shots.value, role, viewport.value);
const options = computed(() => pairOptions(shots.value, props.pairings, viewport.value));
const selection = computed<Selection>({
  get: () => {
    const saved = memory.value[viewport.value];
    const selected = { ...saved };
    for (const role of roles) selected[role] = list(role).find(s => s.id === saved[role])?.id || list(role)[0]?.id || '';
    const matches = (index: number) => options.value.find(o => o.index === index && o.pair.target.includes(selected.target) && o.pair.reference.includes(selected.reference));
    selected.pairIndex = (linked.value ? matches(saved.pairIndex) : options.value.find(o => o.index === saved.pairIndex && o.pair[activeRole.value].includes(selected[activeRole.value])))?.index
      ?? options.value.find(o => linked.value ? o.pair.target.includes(selected.target) && o.pair.reference.includes(selected.reference) : o.pair[activeRole.value].includes(selected[activeRole.value]))?.index ?? -1;
    return selected;
  },
  set: value => { memory.value[viewport.value] = value; },
});
const shot = (role: Role) => list(role).find(s => s.id === selection.value[role]);
const slices = (role: Role) => continuousSlices(list(role));
const artifact = (value: Screenshot) => `/api/evaluations/${props.evaluationId}/artifacts/${props.runId}/${value.file}`;
const siteUrl = (role: Role) => {
  try { const value = new URL(role === 'reference' ? props.referenceUrl || '' : props.targetUrl || ''); return ['http:', 'https:'].includes(value.protocol) ? value.href : ''; }
  catch { return ''; }
};
const position = (role: Role) => list(role).findIndex(s => s.id === selection.value[role]);
const frameWidth = computed(() => props.screenshots.find(s => s.viewport === viewport.value)?.width || (viewport.value === 'desktop' ? 1440 : 390));
const regionPosition = computed(() => options.value.findIndex(o => o.index === selection.value.pairIndex));
const visible = ref<Record<Role, string[]>>({ reference: [], target: [] });
const currentIssues = computed(() => relatedIssues(props.issues, layout.value === 'continuous' && mode.value === 'split'
  ? roles.flatMap(role => visible.value[role].length ? visible.value[role] : [selection.value[role]])
  : roles.map(role => selection.value[role])));
const linkNote = computed(() => !linked.value ? '' : !options.value.length && roles.every(role => list(role).length)
  ? '暂无区域配对，按分段顺序联动'
  : options.value.length && selection.value.pairIndex < 0 ? '此分段暂无对应区域，另一侧保持原位' : '');

const streams: Partial<Record<Role, HTMLElement | null>> = {};
const expectedScroll: Partial<Record<Role, number>> = {};
const frames: Partial<Record<Role, number>> = {};
let observer: ResizeObserver | undefined;
const root = ref<HTMLElement>();
const setStream = (role: Role, element: unknown) => { streams[role] = element as HTMLElement | null; };
function tiles(role: Role): HTMLElement[] { return Array.from(streams[role]?.querySelectorAll<HTMLElement>('[data-shot-id]') || []); }
function updateVisible(role: Role): void {
  const container = streams[role];
  if (!container?.clientHeight) return;
  visible.value[role] = tiles(role).filter(el => el.offsetTop + el.offsetHeight > container.scrollTop && el.offsetTop < container.scrollTop + container.clientHeight).map(el => el.dataset.shotId!);
}
function scrollToShot(role: Role, progress = 0): void {
  const container = streams[role], element = tiles(role).find(el => el.dataset.shotId === selection.value[role]);
  if (!container || !element) return;
  const top = Math.max(0, Math.min(element.offsetTop + progress * element.clientHeight, container.scrollHeight - container.clientHeight));
  if (Math.abs(container.scrollTop - top) > 1) { expectedScroll[role] = top; container.scrollTop = top; }
  updateVisible(role);
}
async function alignSelection(onlyRoles: readonly Role[] = roles): Promise<void> {
  await nextTick();
  if (layout.value === 'continuous' && mode.value === 'split') for (const role of onlyRoles) scrollToShot(role);
}
async function changeShot(role: Role, id: string): Promise<void> {
  activeRole.value = role;
  selection.value = selectShot(selection.value, role, id, shots.value, props.pairings, viewport.value, linked.value);
  await alignSelection(linked.value ? roles : [role]);
}
function stepShot(role: Role, delta: number): void {
  const next = list(role)[position(role) + delta];
  if (next) void changeShot(role, next.id);
}
function changeRegion(index: number): void {
  const option = options.value.find(o => o.index === index);
  if (!option) return;
  const next = selectPair(selection.value, option, shots.value, viewport.value);
  if (!linked.value) next[opposite(activeRole.value)] = selection.value[opposite(activeRole.value)];
  selection.value = next;
  void alignSelection(linked.value ? roles : [activeRole.value]);
}
function stepRegion(delta: number): void {
  if (!options.value.length) return stepShot(activeRole.value, delta);
  const index = regionPosition.value < 0 ? (delta > 0 ? 0 : options.value.length - 1) : regionPosition.value + delta;
  const option = options.value[index];
  if (option) changeRegion(option.index);
}
function toggleLinked(): void {
  linked.value = !linked.value;
  if (linked.value) {
    const role = activeRole.value;
    selection.value = selectShot(selection.value, role, selection.value[role], shots.value, props.pairings, viewport.value, true);
    scrollToShot(opposite(role));
  }
}
function onScroll(role: Role): void {
  updateVisible(role);
  const container = streams[role];
  if (!container) return;
  const expected = expectedScroll[role];
  delete expectedScroll[role];
  if (expected != null && Math.abs(container.scrollTop - expected) < 2) return;
  if (frames[role] != null) cancelAnimationFrame(frames[role]!);
  frames[role] = requestAnimationFrame(() => {
    delete frames[role];
    if (layout.value !== 'continuous' || mode.value !== 'split') return;
    const current = tiles(role).filter(el => el.offsetTop <= container.scrollTop + 2).at(-1) || tiles(role)[0];
    if (!current) return;
    activeRole.value = role;
    selection.value = selectShot(selection.value, role, current.dataset.shotId!, shots.value, props.pairings, viewport.value, linked.value);
    if (linked.value && (!options.value.length || selection.value.pairIndex >= 0)) {
      const progress = Math.max(0, Math.min(1, (container.scrollTop - current.offsetTop) / Math.max(1, current.clientHeight)));
      scrollToShot(opposite(role), progress);
    }
  });
}
async function focusEvidence(id: string): Promise<void> {
  const evidence = shots.value.find(s => s.id === id);
  if (!evidence) return;
  viewport.value = evidence.viewport;
  if (mode.value === 'iframe') mode.value = 'split';
  await changeShot(evidence.role, evidence.id);
}
defineExpose({ focusEvidence });
watch(() => props.initialEvidenceId, id => { if (id) void focusEvidence(id); }, { immediate: true });
watch([viewport, layout, mode], () => { visible.value = { reference: [], target: [] }; void alignSelection(); });
onMounted(() => {
  observer = new ResizeObserver(() => { for (const role of roles) updateVisible(role); });
  if (root.value) observer.observe(root.value);
  void alignSelection();
});
onUnmounted(() => { observer?.disconnect(); for (const role of roles) if (frames[role] != null) cancelAnimationFrame(frames[role]!); });
</script>

<template>
  <div ref="root" class="screenshot-comparison" :class="{ 'compact-comparison': compact }">
    <div class="comparison-toolbar">
      <div class="comparison-switches">
        <div class="segmented compact" aria-label="截图视口">
          <button :class="{ selected: viewport === 'desktop' }" :aria-pressed="viewport === 'desktop'" :disabled="mode !== 'iframe' && !shots.some(s => s.viewport === 'desktop')" @click="viewport = 'desktop'"><Monitor :size="15" />桌面</button>
          <button :class="{ selected: viewport === 'mobile' }" :aria-pressed="viewport === 'mobile'" :disabled="mode !== 'iframe' && !shots.some(s => s.viewport === 'mobile')" @click="viewport = 'mobile'"><Smartphone :size="15" />移动</button>
        </div>
        <div v-if="mode === 'split'" class="segmented compact" aria-label="截图浏览方式">
          <button :class="{ selected: layout === 'continuous' }" :aria-pressed="layout === 'continuous'" @click="layout = 'continuous'">连续</button>
          <button :class="{ selected: layout === 'segment' }" :aria-pressed="layout === 'segment'" @click="layout = 'segment'">分段</button>
        </div>
      </div>
      <div class="toolbar-actions comparison-tools">
        <button v-if="mode !== 'iframe'" class="text-button link-toggle" :class="{ linked }" :aria-pressed="linked" :title="linked ? '解除两侧切换与滚动联动' : '恢复两侧切换与滚动联动'" @click="toggleLinked"><Link2 v-if="linked" :size="16" /><Unlink2 v-else :size="16" />{{ linked ? '已联动' : '未联动' }}</button>
        <button v-if="mode === 'iframe'" class="text-button" @click="frameRevision++"><RotateCw :size="16" />刷新站点</button>
        <button class="icon-button" :class="{ 'is-active': mode === 'split' }" :aria-pressed="mode === 'split'" aria-label="并排对照" title="并排对照" @click="mode = 'split'"><Columns2 :size="18" /></button>
        <button class="icon-button" :class="{ 'is-active': mode === 'overlay' }" :aria-pressed="mode === 'overlay'" :disabled="!shot('target') || !shot('reference')" aria-label="叠图对照" title="叠图对照" @click="mode = 'overlay'"><Layers2 :size="18" /></button>
        <button v-if="!compact" class="icon-button" :class="{ 'is-active': mode === 'iframe' }" :aria-pressed="mode === 'iframe'" aria-label="实时站点对比" title="实时站点对比" @click="mode = 'iframe'"><PanelsTopLeft :size="18" /></button>
      </div>
    </div>

    <div v-if="mode !== 'iframe'" class="comparison-region-nav">
      <button class="text-button" :disabled="options.length ? regionPosition === 0 : position(activeRole) <= 0" @click="stepRegion(-1)"><ChevronLeft :size="16" />上一处</button>
      <BaseSelect v-if="options.length" :model-value="selection.pairIndex" size="small" aria-label="选择对应区域" @update:model-value="changeRegion(Number($event))" :options="[{ value: '-1', label: '选择对应区域', disabled: true }, ...options.map((entry) => ({ value: entry.index, label: (entry.pair.name) }))]" />
      <span v-else class="text-muted small-text">{{ activeRole === 'reference' ? '参考站' : '生成站' }}分段</span>
      <button class="text-button" :disabled="options.length ? regionPosition === options.length - 1 : position(activeRole) >= list(activeRole).length - 1" @click="stepRegion(1)">下一处<ChevronRight :size="16" /></button>
      <span v-if="linkNote" class="comparison-link-note" role="status">{{ linkNote }}</span>
    </div>

    <div v-if="mode === 'iframe'" class="comparison-grid" :class="{ 'mobile-comparison': viewport === 'mobile' }">
      <figure v-for="role in roles" :key="role"><figcaption><span>{{ names[role] }}</span><a v-if="siteUrl(role)" :href="siteUrl(role)" target="_blank" rel="noreferrer" :aria-label="`打开${names[role]}`"><ArrowUpRight :size="16" /></a></figcaption><LiveSiteFrame v-if="siteUrl(role)" :key="`${role}:${frameRevision}:${viewport}`" :url="siteUrl(role)" :title="`${names[role]}实时预览`" :width="frameWidth" /><div v-else class="image-placeholder">未提供站点地址</div></figure>
    </div>
    <template v-else-if="mode === 'split'">
      <div class="comparison-grid" :class="{ 'mobile-comparison': viewport === 'mobile' }">
        <figure v-for="role in roles" :key="role" :class="{ 'active-comparison-side': !linked && activeRole === role }">
          <figcaption>
            <button class="comparison-side-title" :aria-pressed="activeRole === role" :title="`切换到${names[role]}`" @click="activeRole = role">{{ names[role] }}</button>
            <div class="shot-navigation"><button class="icon-button" :disabled="position(role) <= 0" :aria-label="`${names[role]}上一段`" @click="stepShot(role, -1)"><ChevronLeft :size="15" /></button><BaseSelect v-if="list(role).length" :model-value="selection[role]" size="small" :aria-label="`${names[role]}分段`" @update:model-value="changeShot(role, String($event))" :options="list(role).map((entry, index) => ({ value: entry.id, label: '第 ' + (index + 1) + ' 段 / ' + (list(role).length) }))" /><button class="icon-button" :disabled="position(role) >= list(role).length - 1" :aria-label="`${names[role]}下一段`" @click="stepShot(role, 1)"><ChevronRight :size="15" /></button></div>
            <a v-if="siteUrl(role)" :href="siteUrl(role)" target="_blank" rel="noreferrer" :aria-label="`打开${names[role]}`"><ArrowUpRight :size="16" /></a>
          </figcaption>
          <div v-if="!list(role).length" class="image-placeholder">{{ role === 'reference' ? referenceMissing || (compact ? '该问题未关联参考站截图' : '暂无参考站截图') : targetMissing || (compact ? '该问题未关联生成站截图' : '暂无生成站截图') }}</div>
          <div v-else-if="layout === 'continuous'" :ref="el => setStream(role, el)" class="capture-stream" tabindex="0" :aria-label="`${names[role]}连续截图，滚动浏览`" @scroll.passive="onScroll(role)">
            <template v-for="slice in slices(role)" :key="slice.shot.id">
              <div v-if="slice.gap" class="capture-gap" role="separator" aria-label="此处存在未展示的页面区域" title="此处存在未展示的页面区域">···</div>
              <div class="capture-tile" :data-shot-id="slice.shot.id" :style="{ aspectRatio: `${slice.shot.width} / ${slice.height}` }"><a :href="artifact(slice.shot)" target="_blank" rel="noreferrer" :aria-label="`打开${names[role]}原始分段 ${slice.shot.region}`"><img :src="artifact(slice.shot)" :alt="`${names[role]} ${slice.shot.region}`" loading="lazy" :width="slice.shot.width" :height="slice.shot.height" :style="{ transform: `translateY(-${slice.cropTop / slice.shot.height * 100}%)` }" @load="updateVisible(role)" /></a></div>
            </template>
          </div>
          <div v-else class="capture-single"><a :href="artifact(shot(role)!)" target="_blank" rel="noreferrer"><img :src="artifact(shot(role)!)" :alt="`${names[role]}截图`" :width="shot(role)!.width" :height="shot(role)!.height" /></a></div>
        </figure>
      </div>
    </template>
    <template v-else-if="shot('target') && shot('reference')">
      <label class="overlay-control">生成站点透明度<input v-model.number="opacity" type="range" min="0" max="100" /><span>{{ opacity }}%</span></label>
      <div class="overlay-images" :class="{ 'mobile-overlay': viewport === 'mobile' }"><img :src="artifact(shot('reference')!)" alt="底层参考截图" /><img class="overlay-target" :src="artifact(shot('target')!)" :style="{ opacity: opacity / 100 }" alt="叠加生成站截图" /></div>
    </template>
    <p v-if="mode === 'iframe'" class="live-frame-note">实时页面可独立滚动与操作；若站点禁止嵌入，可从右上角打开。</p>

    <section v-if="!compact && mode !== 'iframe' && currentIssues.length" class="comparison-issues" aria-label="当前截图关联问题">
      <h3>关联问题 <span>{{ currentIssues.length }}</span></h3>
      <details v-for="issue in currentIssues" :key="`${issue.dimension}:${issue.title}`"><summary><span class="severity-dot" :class="issue.severity" />{{ issue.title }}</summary><p>{{ issue.detail }}</p><slot name="issue-actions" :issue="issue" /><div class="evidence-links"><button v-for="id in issue.evidence.filter(id => shots.some(s => s.id === id))" :key="id" class="evidence-link" @click="focusEvidence(id)">{{ shots.find(s => s.id === id)?.role === 'reference' ? '参考站' : '生成站' }} · {{ shots.find(s => s.id === id)?.region }}</button></div></details>
    </section>
  </div>
</template>

<style scoped>
.comparison-toolbar { flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
.comparison-switches, .comparison-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.link-toggle { color: var(--muted); white-space: nowrap; }
.link-toggle.linked { color: var(--blue); }
.comparison-region-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.comparison-region-nav select { max-width: min(330px, 100%); flex: 1; }
.comparison-region-nav > .text-button { white-space: nowrap; }
.comparison-region-nav .text-button:disabled { color: #a4afc2; }
.comparison-link-note { font-size: 11px; color: var(--muted); margin-left: auto; }
.comparison-grid { align-items: start; }
.comparison-grid figcaption { min-height: 56px; gap: 8px; padding: 8px 12px; flex-wrap: wrap; }
.comparison-grid figcaption > span { white-space: nowrap; color: #667287; }
.comparison-side-title { padding: 3px 0; font-size: 11px; white-space: nowrap; color: #667287; }
.active-comparison-side { border-color: #b9caf9; }
.active-comparison-side .comparison-side-title { color: var(--blue); }
.shot-navigation { display: flex; align-items: center; gap: 3px; margin-left: auto; }
.shot-navigation .input { min-height: 30px; max-width: 145px; padding: 5px 24px 5px 9px; font-size: 11px; }
.shot-navigation .icon-button { width: 25px; height: 28px; }
.capture-stream { position: relative; height: clamp(360px, 64vh, 780px); overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain; scrollbar-gutter: stable; background: #fff; }
.capture-tile { position: relative; overflow: hidden; width: 100%; }
.capture-tile img { position: absolute; top: 0; left: 0; width: 100%; height: auto; display: block; }
.capture-tile a { display: block; position: absolute; inset: 0; }
.capture-gap { height: 28px; display: grid; place-items: center; color: var(--muted); background: var(--field); border-block: 1px dashed #dce3ef; }
.capture-single { background: #fff; }
.capture-single img { width: 100%; height: auto; display: block; }
.comparison-issues { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 14px; }
.comparison-issues > h3 { font-size: 13px; margin-bottom: 7px; }
.comparison-issues > h3 span { font-size: 11px; color: var(--muted); font-weight: 500; margin-left: 5px; }
.comparison-issues details { padding: 10px 0; border-top: 1px solid var(--line); }
.comparison-issues summary { cursor: pointer; font-size: 12px; color: #536078; }
.comparison-issues summary .severity-dot { display: inline-block; margin-inline: 5px 7px; vertical-align: middle; }
.comparison-issues details p { font-size: 12px; color: var(--muted); line-height: 1.8; margin-top: 9px; }
.compact-comparison { margin-top: 12px; padding: 15px; border: 1px solid var(--line); border-radius: 12px; }
.compact-comparison .capture-stream { height: 430px; }
.compact-comparison .capture-single { max-height: 520px; overflow: auto; }
.compact-comparison .comparison-toolbar { gap: 8px; }
@media (max-width: 800px) {
  .comparison-grid figcaption { justify-content: flex-start; }
  .comparison-grid figcaption > a { margin-left: auto; }
  .shot-navigation { order: 1; width: 100%; margin-left: 0; justify-content: center; }
  .comparison-link-note { margin-left: 0; width: 100%; }
  .compact-comparison { padding: 10px; }
}
@media (max-width: 500px) {
  .capture-stream { height: 430px; }
  .comparison-tools { margin-left: auto; }
}
</style>
