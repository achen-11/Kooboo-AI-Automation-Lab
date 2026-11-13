<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import {
  ArrowUpRight,
  CircleAlert,
  ExternalLink,
  Image,
  LoaderCircle,
  Monitor,
  PanelsTopLeft,
  RotateCw,
  Smartphone,
  X,
} from '@lucide/vue';
import { scenarios, type MaterialFile } from '../../../shared/automation';
import {
  detectKoobooAdminRedirect,
  type LiveComparisonPayload,
  type LiveComparisonSourceKey,
} from '../../../shared/live-comparison';
import { api, message } from '../api';
import BaseSelect from './BaseSelect.vue';
import LiveSiteFrame from './LiveSiteFrame.vue';

const props = defineProps<{
  taskId: string;
  defaultReportId?: string | null;
}>();

const dialog = ref<HTMLDialogElement>();
const leftStream = ref<HTMLElement>();
const headingId = useId();

const isOpen = ref(false);
const loading = ref(false);
const error = ref('');
const data = ref<LiveComparisonPayload | null>(null);
const activeReportId = ref<string | null>(null);

const viewport = ref<'desktop' | 'mobile'>('desktop');
const selectedSourceKey = ref<LiveComparisonSourceKey>('reference');
const userLeftMode = ref<'auto' | 'iframe' | 'screenshots'>('auto');
const selectedShotName = ref('');
const frameRevision = ref(0);

const frameWidth = computed(() => (viewport.value === 'desktop' ? 1440 : 390));

const leftSource = computed(() => {
  const sources = data.value?.sources || [];
  return sources.find(item => item.key === selectedSourceKey.value) || sources[0] || null;
});

const leftUrl = computed(() => leftSource.value?.url || '');
const leftEmbedCheck = computed(() => (leftUrl.value ? data.value?.embedChecks[leftUrl.value] : undefined));
const leftBlocked = computed(() => leftEmbedCheck.value?.embeddable === false);

const reportTaskId = computed(() => data.value?.fallbackScreenshots.reportTaskId || null);

const leftRoleScreenshots = computed<MaterialFile[]>(() => {
  if (!data.value || !leftSource.value) return [];
  const allowedRoles = leftSource.value.screenshotRoles;
  return data.value.fallbackScreenshots.items.filter(file =>
    allowedRoles.includes((file.role || 'reference') as 'reference' | 'content'),
  );
});

const leftViewportScreenshots = computed<MaterialFile[]>(() =>
  leftRoleScreenshots.value.filter(file => !file.viewport || file.viewport === viewport.value),
);

const otherViewport = computed<'desktop' | 'mobile'>(() => (viewport.value === 'desktop' ? 'mobile' : 'desktop'));
const leftOtherViewportScreenshots = computed<MaterialFile[]>(() =>
  leftRoleScreenshots.value.filter(file => file.viewport === otherViewport.value),
);

const leftEffectiveMode = computed<'empty' | 'iframe' | 'screenshots' | 'blocked'>(() => {
  if (!leftSource.value || !leftUrl.value) return 'empty';
  if (leftBlocked.value) {
    return leftViewportScreenshots.value.length > 0 ? 'screenshots' : 'blocked';
  }
  if (userLeftMode.value === 'screenshots' && leftRoleScreenshots.value.length > 0) {
    return 'screenshots';
  }
  return 'iframe';
});

const targetUrl = computed(() => data.value?.targetUrl || '');
const targetEmbedCheck = computed(() => (targetUrl.value ? data.value?.embedChecks[targetUrl.value] : undefined));
const targetBlocked = computed(() => targetEmbedCheck.value?.embeddable === false);
const targetAdminRedirect = computed(() =>
  detectKoobooAdminRedirect(targetUrl.value, targetEmbedCheck.value?.finalUrl),
);
const targetViewportScreenshots = computed<MaterialFile[]>(() =>
  (data.value?.fallbackScreenshots.items || []).filter(
    file => file.role === 'target' && (!file.viewport || file.viewport === viewport.value),
  ),
);

function artifactUrl(file: MaterialFile): string {
  return `/api/v1/automation/reports/${reportTaskId.value}/artifacts/${encodeURIComponent(file.name)}`;
}

function compactUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

let requestSeq = 0;

async function load(refresh = false) {
  if (!props.taskId) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams();
    if (activeReportId.value) query.set('reportId', activeReportId.value);
    if (refresh) query.set('refresh', '1');
    const qs = query.toString();
    const result = await api<LiveComparisonPayload>(
      `/automation/tasks/${encodeURIComponent(props.taskId)}/live-comparison${qs ? `?${qs}` : ''}`,
    );
    if (seq !== requestSeq) return;
    data.value = result;
    if (!result.sources.some(source => source.key === selectedSourceKey.value)) {
      selectedSourceKey.value = result.sources[0]?.key || 'reference';
    }
    syncSelectedShot();
  } catch (reason) {
    if (seq !== requestSeq) return;
    error.value = message(reason);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function syncSelectedShot() {
  const list = leftViewportScreenshots.value;
  if (!list.length) {
    selectedShotName.value = '';
    return;
  }
  if (!list.some(item => item.name === selectedShotName.value)) {
    selectedShotName.value = list[0].name;
  }
}

watch([viewport, selectedSourceKey], () => {
  syncSelectedShot();
  if (leftStream.value) leftStream.value.scrollTop = 0;
});

function switchSource(key: LiveComparisonSourceKey) {
  if (selectedSourceKey.value === key) return;
  selectedSourceKey.value = key;
  userLeftMode.value = 'auto';
}

async function jumpToShot(name: string) {
  selectedShotName.value = name;
  await nextTick();
  const container = leftStream.value;
  const target = Array.from(container?.querySelectorAll<HTMLElement>('[data-shot-name]') || []).find(
    el => el.dataset.shotName === name,
  );
  if (container && target) {
    container.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
  }
}

function onLeftStreamScroll() {
  const container = leftStream.value;
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-shot-name]'));
  const current = items.filter(el => el.offsetTop <= container.scrollTop + 24).at(-1) || items[0];
  if (current?.dataset.shotName) {
    selectedShotName.value = current.dataset.shotName;
  }
}

async function refreshComparison() {
  frameRevision.value++;
  await load(true);
}

let previousOverflow: string | undefined;
function unlockScroll() {
  if (previousOverflow !== undefined) {
    document.body.style.overflow = previousOverflow;
    previousOverflow = undefined;
  }
}

function closed() {
  requestSeq++;
  isOpen.value = false;
  loading.value = false;
  unlockScroll();
}

async function open(reportIdOverride?: string | null) {
  activeReportId.value = reportIdOverride === undefined ? (props.defaultReportId ?? null) : reportIdOverride;
  userLeftMode.value = 'auto';
  isOpen.value = true;
  await nextTick();
  if (!dialog.value?.open) {
    dialog.value?.showModal();
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  await load(false);
}

watch(() => props.taskId, () => {
  if (dialog.value?.open) dialog.value.close();
});

onBeforeUnmount(unlockScroll);
defineExpose({ open });
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="live-comparison-dialog"
      :aria-labelledby="headingId"
      @close="closed"
      @click="event => { if (event.target === dialog) dialog?.close(); }"
    >
      <div v-if="isOpen" class="live-comparison-shell">
        <header class="live-comparison-header">
          <div class="live-comparison-title">
            <h2 :id="headingId">实时站点对比</h2>
            <span v-if="data" class="live-comparison-meta">
              {{ data.resourceName }} · {{ scenarios[data.scenario] }}
            </span>
          </div>
          <button
            type="button"
            class="icon-button live-comparison-close"
            autofocus
            aria-label="关闭实时站点对比"
            title="关闭（Esc）"
            @click="dialog?.close()"
          >
            <X :size="22" />
          </button>
        </header>

        <div class="live-comparison-toolbar">
          <div class="live-toolbar-switches">
            <div class="segmented compact" role="group" aria-label="对比视口">
              <button
                type="button"
                :class="{ selected: viewport === 'desktop' }"
                :aria-pressed="viewport === 'desktop'"
                @click="viewport = 'desktop'"
              >
                <Monitor :size="15" />PC 1440px
              </button>
              <button
                type="button"
                :class="{ selected: viewport === 'mobile' }"
                :aria-pressed="viewport === 'mobile'"
                @click="viewport = 'mobile'"
              >
                <Smartphone :size="15" />移动 390px
              </button>
            </div>

            <div
              v-if="data && data.sources.length > 1"
              class="segmented compact"
              role="group"
              aria-label="左侧来源站点切换"
            >
              <button
                v-for="source in data.sources"
                :key="source.key"
                type="button"
                :class="{ selected: leftSource?.key === source.key }"
                :aria-pressed="leftSource?.key === source.key"
                @click="switchSource(source.key)"
              >
                {{ source.label }}
              </button>
            </div>

            <div
              v-if="leftSource && leftRoleScreenshots.length > 0"
              class="segmented compact"
              role="group"
              aria-label="左侧展示方式"
            >
              <button
                type="button"
                :class="{ selected: leftEffectiveMode === 'iframe' }"
                :aria-pressed="leftEffectiveMode === 'iframe'"
                :disabled="leftBlocked"
                :title="leftBlocked ? leftEmbedCheck?.reason : '实时加载来源站页面'"
                @click="userLeftMode = 'iframe'"
              >
                <PanelsTopLeft :size="15" />实时页面
              </button>
              <button
                type="button"
                :class="{ selected: leftEffectiveMode === 'screenshots' }"
                :aria-pressed="leftEffectiveMode === 'screenshots'"
                @click="userLeftMode = 'screenshots'"
              >
                <Image :size="15" />采集截图（{{ leftViewportScreenshots.length }}）
              </button>
            </div>
          </div>

          <div class="live-toolbar-actions">
            <button
              type="button"
              class="button secondary compact-action"
              :disabled="loading"
              @click="refreshComparison"
            >
              <LoaderCircle v-if="loading" class="spin" :size="15" />
              <RotateCw v-else :size="15" />
              刷新预览
            </button>
          </div>
        </div>

        <p v-if="error" class="alert error" role="alert">
          {{ error }}
          <button type="button" class="text-action" @click="load(true)">重试</button>
        </p>

        <div v-else-if="loading && !data" class="live-comparison-loading">
          <LoaderCircle class="spin" :size="20" />
          <span>正在检测站点嵌入策略与对比地址…</span>
        </div>

        <div v-else-if="data" class="live-comparison-panes">
          <!-- Left Pane: Reference / Content Site -->
          <figure class="live-comparison-pane">
            <figcaption class="live-pane-head">
              <div class="live-pane-identity">
                <strong>{{ leftSource?.label || '参考站' }}</strong>
                <span v-if="leftUrl" class="live-pane-url" :title="leftUrl">{{ compactUrl(leftUrl) }}</span>
              </div>
              <div class="live-pane-controls">
                <BaseSelect
                  v-if="leftEffectiveMode === 'screenshots' && leftViewportScreenshots.length > 1"
                  :model-value="selectedShotName"
                  size="small"
                  variant="quiet"
                  :searchable="false"
                  :aria-label="`${leftSource?.label || '参考站'}截图分段`"
                  :options="leftViewportScreenshots.map((item, idx) => ({
                    value: item.name,
                    label: `第 ${idx + 1} 段 / 共 ${leftViewportScreenshots.length} 段`,
                  }))"
                  @update:model-value="jumpToShot(String($event))"
                />
                <a
                  v-if="leftUrl"
                  class="text-action live-open-link"
                  :href="leftUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  新窗口打开<ArrowUpRight :size="14" />
                </a>
              </div>
            </figcaption>

            <div v-if="leftBlocked && leftEffectiveMode === 'screenshots'" class="live-pane-notice">
              <CircleAlert :size="15" />
              <span>
                该站点禁止第三方 iframe 嵌入，已自动回退展示{{
                  data.fallbackScreenshots.historical ? '最近一轮评测' : '本轮评测'
                }}采集的同视口截图。
              </span>
            </div>
            <div v-else-if="!leftBlocked && leftEmbedCheck?.status === 'unreachable'" class="live-pane-notice muted">
              <CircleAlert :size="15" />
              <span>{{ leftEmbedCheck.reason }}</span>
            </div>

            <div class="live-pane-stage">
              <div v-if="leftEffectiveMode === 'empty'" class="live-pane-placeholder">
                <p>当前任务未配置参考站或内容站地址。</p>
              </div>

              <LiveSiteFrame
                v-else-if="leftEffectiveMode === 'iframe'"
                :key="`left:${leftUrl}:${viewport}:${frameRevision}`"
                :url="leftUrl"
                :title="`${leftSource?.label || '参考站'}实时预览`"
                :width="frameWidth"
              />

              <div
                v-else-if="leftEffectiveMode === 'screenshots' && leftViewportScreenshots.length > 0"
                ref="leftStream"
                class="live-screenshot-stream"
                :class="{ 'is-mobile': viewport === 'mobile' }"
                tabindex="0"
                :aria-label="`${leftSource?.label || '参考站'}采集截图浏览`"
                @scroll.passive="onLeftStreamScroll"
              >
                <div
                  v-for="(shot, idx) in leftViewportScreenshots"
                  :key="shot.name"
                  class="live-screenshot-item"
                  :data-shot-name="shot.name"
                >
                  <img
                    :src="artifactUrl(shot)"
                    :alt="`${leftSource?.label || '参考站'} ${viewport === 'desktop' ? 'PC' : '移动端'}截图 ${idx + 1}`"
                    loading="lazy"
                  />
                </div>
              </div>

              <div
                v-else-if="leftEffectiveMode === 'screenshots' && leftViewportScreenshots.length === 0"
                class="live-blocked-state"
              >
                <CircleAlert :size="26" />
                <h3>当前报告暂无{{ viewport === 'desktop' ? 'PC' : '移动端' }}截图</h3>
                <p>
                  可切换至{{ otherViewport === 'desktop' ? 'PC 1440px' : '移动 390px' }}查看已采集截图（{{
                    leftOtherViewportScreenshots.length
                  }}
                  张），或切回实时页面。
                </p>
                <div class="live-blocked-actions">
                  <button
                    v-if="leftOtherViewportScreenshots.length > 0"
                    type="button"
                    class="button secondary"
                    @click="viewport = otherViewport"
                  >
                    切换到{{ otherViewport === 'desktop' ? 'PC' : '移动' }}视口
                  </button>
                  <button
                    v-if="!leftBlocked"
                    type="button"
                    class="button secondary"
                    @click="userLeftMode = 'iframe'"
                  >
                    切换实时页面
                  </button>
                </div>
              </div>

              <div v-else class="live-blocked-state">
                <CircleAlert :size="28" />
                <h3>该{{ leftSource?.label || '参考站' }}禁止 iframe 嵌入</h3>
                <p>{{ leftEmbedCheck?.reason }}</p>
                <p v-if="leftOtherViewportScreenshots.length > 0" class="text-muted">
                  检测到{{ otherViewport === 'desktop' ? 'PC' : '移动端' }}已有
                  {{ leftOtherViewportScreenshots.length }} 张评测采集截图，可切换视口对照查看。
                </p>
                <p v-else class="text-muted">当前尚无已完成的同视口评测参考截图可供回退展示。</p>
                <div class="live-blocked-actions">
                  <button
                    v-if="leftOtherViewportScreenshots.length > 0"
                    type="button"
                    class="button secondary"
                    @click="viewport = otherViewport"
                  >
                    查看{{ otherViewport === 'desktop' ? 'PC' : '移动' }}端采集截图
                  </button>
                  <a
                    v-if="leftUrl"
                    class="button secondary"
                    :href="leftUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink :size="16" />新窗口打开{{ leftSource?.label || '参考站' }}
                  </a>
                </div>
              </div>
            </div>
          </figure>

          <!-- Right Pane: Generated Target Site -->
          <figure class="live-comparison-pane">
            <figcaption class="live-pane-head">
              <div class="live-pane-identity">
                <strong>生成站点</strong>
                <span v-if="targetUrl" class="live-pane-url" :title="targetUrl">{{ compactUrl(targetUrl) }}</span>
              </div>
              <div class="live-pane-controls">
                <a
                  v-if="targetUrl"
                  class="text-action live-open-link"
                  :href="targetUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  新窗口打开<ArrowUpRight :size="14" />
                </a>
              </div>
            </figcaption>

            <div v-if="targetAdminRedirect" class="live-pane-notice">
              <CircleAlert :size="15" />
              <span>检测到生成站重定向至 Kooboo 后台引导页，站点可能尚未发布首页或已在本地环境移除。</span>
            </div>
            <div v-else-if="targetBlocked && targetViewportScreenshots.length > 0" class="live-pane-notice">
              <CircleAlert :size="15" />
              <span>该生成站禁止 iframe 嵌入，已自动回退展示评测采集截图。</span>
            </div>

            <div class="live-pane-stage">
              <div v-if="!targetUrl" class="live-pane-placeholder">
                <p>生成站尚未创建公开地址，待生成阶段创建站点后可在此实时预览。</p>
              </div>

              <div
                v-else-if="targetBlocked && targetViewportScreenshots.length > 0"
                class="live-screenshot-stream"
                :class="{ 'is-mobile': viewport === 'mobile' }"
                tabindex="0"
                aria-label="生成站点采集截图浏览"
              >
                <div
                  v-for="(shot, idx) in targetViewportScreenshots"
                  :key="shot.name"
                  class="live-screenshot-item"
                >
                  <img :src="artifactUrl(shot)" :alt="`生成站点截图 ${idx + 1}`" loading="lazy" />
                </div>
              </div>

              <div v-else-if="targetBlocked" class="live-blocked-state">
                <CircleAlert :size="28" />
                <h3>该生成站禁止 iframe 嵌入</h3>
                <p>{{ targetEmbedCheck?.reason }}</p>
                <div class="live-blocked-actions">
                  <a class="button secondary" :href="targetUrl" target="_blank" rel="noopener noreferrer">
                    <ExternalLink :size="16" />新窗口打开生成站
                  </a>
                </div>
              </div>

              <LiveSiteFrame
                v-else
                :key="`right:${targetUrl}:${viewport}:${frameRevision}`"
                :url="targetUrl"
                title="生成站点实时预览"
                :width="frameWidth"
              />
            </div>
          </figure>
        </div>

        <footer class="live-comparison-footer">
          实时预览展示站点当前线上状态，两侧支持独立滚动与交互；评测得分与问题闭环仍以对应轮次的冻结取证为准。
        </footer>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.live-comparison-dialog {
  width: calc(100vw - 48px);
  max-width: 1860px;
  height: calc(100dvh - 48px);
  max-height: none;
  padding: 0;
  border: 0;
  border-radius: 16px;
  color: var(--ink);
  background: var(--paper);
  box-shadow: 0 24px 80px #18213140;
  overflow: hidden;
}
.live-comparison-dialog::backdrop {
  background: #17213199;
  backdrop-filter: blur(4px);
}
.live-comparison-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px 24px 14px;
  gap: 12px;
  min-height: 0;
}
.live-comparison-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex: none;
}
.live-comparison-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 14px;
  min-width: 0;
}
.live-comparison-title h2 {
  font-size: 18px;
  line-height: 1.4;
  margin: 0;
}
.live-comparison-meta {
  font-size: 13px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.live-comparison-close {
  flex: none;
  width: 38px;
  height: 38px;
}
.live-comparison-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  flex: none;
}
.live-toolbar-switches {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.live-toolbar-switches .segmented button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.live-toolbar-switches button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.live-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.compact-action {
  min-height: 35px;
  padding: 6px 13px;
  font-size: 12px;
}
.live-comparison-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}
.live-comparison-panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.live-comparison-pane {
  margin: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #eef2f8;
  overflow: hidden;
}
.live-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  min-height: 46px;
  background: #fafbfd;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.live-pane-identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.live-pane-identity strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
}
.live-pane-url {
  font-size: 12px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-pane-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.live-open-link {
  font-size: 12px;
  white-space: nowrap;
}
.live-pane-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  background: #fff6e8;
  border-bottom: 1px solid #f3dfbe;
  color: #8f5308;
  font-size: 12px;
  line-height: 1.5;
  flex: none;
}
.live-pane-notice.muted {
  background: var(--field);
  border-bottom-color: var(--line);
  color: var(--muted);
}
.live-pane-notice :deep(svg) {
  flex: none;
}
.live-pane-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: stretch;
  overflow: hidden;
  padding: 0;
}
.live-pane-stage :deep(.live-frame) {
  flex: 1;
  height: 100%;
  min-height: 0;
  box-shadow: 0 0 0 1px #dce3ef;
}
.live-screenshot-stream {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
  background: #fff;
  box-shadow: 0 0 0 1px #dce3ef;
}
.live-screenshot-stream.is-mobile {
  max-width: 390px;
}
.live-screenshot-item {
  border-bottom: 1px dashed #e5eaf3;
}
.live-screenshot-item:last-child {
  border-bottom: 0;
}
.live-screenshot-item img {
  display: block;
  width: 100%;
  height: auto;
}
.live-pane-placeholder,
.live-blocked-state {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px 24px;
  text-align: center;
  color: var(--muted);
  background: var(--paper);
}
.live-blocked-state h3 {
  margin: 2px 0 0;
  font-size: 15px;
  color: var(--ink);
}
.live-blocked-state p {
  margin: 0;
  max-width: 440px;
  font-size: 13px;
  line-height: 1.7;
}
.live-blocked-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 6px;
}
.live-comparison-footer {
  flex: none;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
@media (max-width: 960px) {
  .live-comparison-dialog {
    width: 100vw;
    max-width: none;
    height: 100dvh;
    border-radius: 0;
  }
  .live-comparison-shell {
    padding: 14px 12px 10px;
    gap: 10px;
  }
  .live-comparison-panes {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }
  .live-comparison-pane {
    min-height: 420px;
  }
}
</style>
