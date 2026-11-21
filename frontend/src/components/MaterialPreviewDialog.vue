<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  File,
  FileText,
  Image,
  LoaderCircle,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
import type { MaterialFile } from '../../../shared/automation';
import { message, sessionFetch } from '../api';
import { loadMaterialPreview, materialFormat, type MaterialPreview } from '../lib/material-browser';
import { isMaterialMarkdown } from '../lib/material-markdown';
import { bytes } from '../views/automation/common';
import MaterialMarkdown from './MaterialMarkdown.vue';

const props = defineProps<{
  files?: readonly MaterialFile[];
  selectedIds?: readonly string[];
  selectable?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{ toggle: [fileId: string] }>();

const dialog = ref<HTMLDialogElement>();
const strip = ref<HTMLElement>();
const headingId = useId();

const isOpen = ref(false);
const overrideList = ref<readonly MaterialFile[] | null>(null);
const currentId = ref('');
const loading = ref(false);
const error = ref('');
const retry = ref(0);
const zoom = ref<number | null>(null);
const markdownSource = ref(false);
const preview = shallowRef<MaterialPreview | null>(null);
const imageUrl = ref('');
const imageNatural = ref<{ width: number; height: number } | null>(null);

const imageUrlCache = new Map<string, string>();

const activeFiles = computed<readonly MaterialFile[]>(() => overrideList.value ?? props.files ?? []);
const currentIndex = computed(() => activeFiles.value.findIndex(file => file.id === currentId.value));
const current = computed(() => (currentIndex.value >= 0 ? activeFiles.value[currentIndex.value] : undefined));
const format = computed(() => (current.value ? materialFormat(current.value) : undefined));
const isMarkdown = computed(() => Boolean(current.value && isMaterialMarkdown(current.value)));
const currentSelected = computed(() => Boolean(current.value && props.selectedIds?.includes(current.value.id)));

function cacheKeyOf(file: Pick<MaterialFile, 'id' | 'sha256'>): string {
  return `${file.id}:${file.sha256}`;
}

function clearCache() {
  for (const url of imageUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  imageUrlCache.clear();
}

function open(fileId: string, overrideFiles?: readonly MaterialFile[]) {
  overrideList.value = overrideFiles ?? null;
  currentId.value = fileId;
  zoom.value = null;
  markdownSource.value = false;
  error.value = '';
  if (!dialog.value?.open) {
    dialog.value?.showModal();
  }
  isOpen.value = true;
}

function close() {
  if (dialog.value?.open) {
    dialog.value.close();
  } else {
    onClosed();
  }
}

function onClosed() {
  isOpen.value = false;
  loading.value = false;
  error.value = '';
  preview.value = null;
  imageUrl.value = '';
  imageNatural.value = null;
  currentId.value = '';
  overrideList.value = null;
  clearCache();
}

function stepFile(delta: number) {
  if (activeFiles.value.length <= 1) return;
  const target = activeFiles.value[currentIndex.value + delta];
  if (target) currentId.value = target.id;
}

function selectByName(name: string) {
  const target = activeFiles.value.find(file => file.name === name);
  if (target) currentId.value = target.id;
}

function changeZoom(delta: number) {
  const base = zoom.value ?? 1;
  zoom.value = Math.max(0.1, Math.min(3, Math.round((base + delta) * 100) / 100));
}

function toggleDoubleClickZoom() {
  if (error.value || preview.value?.kind !== 'image') return;
  zoom.value = zoom.value === null ? 1 : null;
}

function reload() {
  if (current.value) {
    const key = cacheKeyOf(current.value);
    const oldUrl = imageUrlCache.get(key);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      imageUrlCache.delete(key);
    }
  }
  retry.value++;
}

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth && img.naturalHeight) {
    imageNatural.value = { width: img.naturalWidth, height: img.naturalHeight };
  }
}

function onImageError() {
  if (current.value) {
    const key = cacheKeyOf(current.value);
    const oldUrl = imageUrlCache.get(key);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      imageUrlCache.delete(key);
    }
  }
  error.value = '图片无法显示，请重新加载或下载原文件查看';
}

function onBackdropClick(event: MouseEvent) {
  if (event.target === dialog.value) {
    close();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.target as HTMLElement | null)?.closest('select,input,textarea,[contenteditable],[role="combobox"]')
  ) {
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepFile(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepFile(1);
  }
}

watch(
  [isOpen, () => current.value?.id, () => current.value?.sha256, retry],
  async (_vals, _prev, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());

    preview.value = null;
    imageUrl.value = '';
    imageNatural.value = null;
    error.value = '';
    zoom.value = null;
    markdownSource.value = false;
    loading.value = false;

    const file = current.value;
    if (!isOpen.value || !file) return;
    const fmt = materialFormat(file);
    if (fmt.kind === 'unsupported') return;

    const key = cacheKeyOf(file);
    if (fmt.kind === 'image') {
      const cached = imageUrlCache.get(key);
      if (cached) {
        preview.value = { kind: 'image', blob: new Blob() };
        imageUrl.value = cached;
        return;
      }
    }

    loading.value = true;
    try {
      const result = await loadMaterialPreview(file, sessionFetch, controller.signal);
      if (controller.signal.aborted) return;
      preview.value = result;
      if (result.kind === 'image') {
        const url = URL.createObjectURL(result.blob);
        imageUrlCache.set(key, url);
        imageUrl.value = url;
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        error.value = message(reason);
      }
    } finally {
      if (!controller.signal.aborted) {
        loading.value = false;
      }
    }
  },
  { immediate: true },
);

watch(currentId, async () => {
  if (!isOpen.value) return;
  await nextTick();
  strip.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  });
});

onBeforeUnmount(() => {
  clearCache();
});

defineExpose({ open, close });
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="material-preview-dialog"
      :aria-labelledby="headingId"
      @close="onClosed"
      @keydown="onKeydown"
      @click="onBackdropClick"
    >
      <div class="material-preview-dialog-content">
        <header class="material-preview-heading">
          <div class="material-preview-identity">
            <component
              :is="format?.kind === 'image' ? Image : format?.kind === 'text' ? FileText : File"
              :size="20"
              aria-hidden="true"
            />
            <div class="material-preview-titles">
              <strong :id="headingId">{{ current ? current.name.split('/').at(-1) : '文件预览' }}</strong>
              <span v-if="current" class="material-preview-meta" :title="current.name">
                {{ current.name }} · {{ bytes(current.size) }}
                <template v-if="imageNatural"> · {{ imageNatural.width }} × {{ imageNatural.height }}</template>
              </span>
            </div>
          </div>

          <div class="material-preview-header-right">
            <label v-if="selectable && current" class="check-label material-preview-select">
              <input
                type="checkbox"
                :checked="currentSelected"
                :disabled="busy"
                @change="emit('toggle', current.id)"
              />
              已勾选导入
            </label>

            <nav v-if="activeFiles.length > 1" class="material-preview-nav" aria-label="切换资料文件">
              <button
                type="button"
                class="icon-button"
                aria-label="上一个文件"
                :disabled="currentIndex <= 0"
                @click="stepFile(-1)"
              >
                <ChevronLeft :size="18" />
              </button>
              <span>{{ currentIndex + 1 }} / {{ activeFiles.length }}</span>
              <button
                type="button"
                class="icon-button"
                aria-label="下一个文件"
                :disabled="currentIndex < 0 || currentIndex >= activeFiles.length - 1"
                @click="stepFile(1)"
              >
                <ChevronRight :size="18" />
              </button>
            </nav>

            <button
              type="button"
              class="icon-button"
              autofocus
              aria-label="关闭预览"
              title="关闭（Esc）"
              @click="close"
            >
              <X :size="20" />
            </button>
          </div>
        </header>

        <div v-if="current" class="material-preview-toolbar">
          <div class="material-preview-tools">
            <div v-if="format?.kind === 'image' && preview?.kind === 'image' && !error" class="material-zoom-controls">
              <button
                type="button"
                class="text-action"
                :aria-pressed="zoom === null"
                @click="zoom = null"
              >
                适应窗口
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="缩小图片"
                :disabled="zoom !== null && zoom <= 0.1"
                @click="changeZoom(-0.25)"
              >
                <ZoomOut :size="17" />
              </button>
              <button
                type="button"
                class="text-action material-zoom-value"
                title="点击按 100% 原始尺寸查看"
                :aria-pressed="zoom === 1"
                @click="zoom = 1"
              >
                {{ zoom === null ? '原始尺寸' : `${Math.round(zoom * 100)}%` }}
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label="放大图片"
                :disabled="zoom !== null && zoom >= 3"
                @click="changeZoom(0.25)"
              >
                <ZoomIn :size="17" />
              </button>
            </div>

            <button
              v-else-if="isMarkdown && preview?.kind === 'text'"
              type="button"
              class="text-action material-markdown-toggle"
              :aria-label="markdownSource ? '预览 Markdown 文档' : '查看 Markdown 源码'"
              :aria-pressed="markdownSource"
              @click="markdownSource = !markdownSource"
            >
              <BookOpen v-if="markdownSource" :size="15" />
              <Code2 v-else :size="15" />
              {{ markdownSource ? '预览' : '源码' }}
            </button>
          </div>

          <a
            class="text-action material-download-link"
            :href="`/api/automation/files/${current.id}`"
            download
            :aria-label="`下载原文件 ${current.name}`"
          >
            <Download :size="15" />下载原文件
          </a>
        </div>

        <div class="material-preview-stage" :aria-busy="loading">
          <div v-if="loading" class="material-preview-state" role="status">
            <LoaderCircle class="spin" :size="24" />
            <p>正在加载预览…</p>
          </div>

          <div v-else-if="error" class="material-preview-state" role="alert">
            <File :size="30" />
            <p>{{ error }}</p>
            <div class="inline-actions">
              <button type="button" class="button secondary small" @click="reload">
                <RotateCw :size="14" />重新加载
              </button>
              <a
                v-if="current"
                class="button secondary small"
                :href="`/api/automation/files/${current.id}`"
                download
              >
                <Download :size="14" />下载原文件
              </a>
            </div>
          </div>

          <div
            v-else-if="preview?.kind === 'image'"
            class="material-image-canvas"
            :class="{ 'fit-image': zoom === null }"
            tabindex="0"
            :aria-label="`${current?.name} 图片预览，双击切换原始尺寸`"
            @dblclick="toggleDoubleClickZoom"
          >
            <img
              :src="imageUrl"
              :alt="current?.name"
              :style="zoom !== null && imageNatural ? { width: `${imageNatural.width * zoom}px` } : undefined"
              draggable="false"
              @load="onImageLoad"
              @error="onImageError"
            />
          </div>

          <div
            v-else-if="preview?.kind === 'text' && current"
            class="material-text-canvas"
            tabindex="0"
            :aria-label="`${current.name} ${isMarkdown && !markdownSource ? '文档预览' : '文本预览'}`"
          >
            <MaterialMarkdown
              v-if="isMarkdown && !markdownSource && preview.text"
              :source="preview.text"
              :path="current.name"
              :files="[...activeFiles]"
              @select="selectByName"
            />
            <pre v-else>{{ preview.text || '（空文件）' }}</pre>
            <p v-if="preview.truncated" class="material-preview-limit">仅预览前 256 KB，完整内容请点击右上角下载原文件查看。</p>
          </div>

          <div v-else class="material-preview-state">
            <File :size="32" />
            <p>{{ current ? '暂不支持直接预览此文件格式，可下载到本地查看。' : '未选择文件' }}</p>
            <a
              v-if="current"
              class="button secondary small"
              :href="`/api/automation/files/${current.id}`"
              download
            >
              <Download :size="14" />下载原文件
            </a>
          </div>
        </div>

        <nav v-if="activeFiles.length > 1" ref="strip" class="material-preview-strip" aria-label="资料文件列表">
          <button
            v-for="file in activeFiles"
            :key="file.id"
            type="button"
            class="material-strip-item"
            :class="{ selected: file.id === currentId }"
            :aria-pressed="file.id === currentId"
            :title="file.name"
            @click="currentId = file.id"
          >
            <span
              v-if="selectable"
              class="material-strip-check"
              :class="{ checked: selectedIds?.includes(file.id) }"
              aria-hidden="true"
            />
            <component
              :is="materialFormat(file).kind === 'image' ? Image : materialFormat(file).kind === 'text' ? FileText : File"
              :size="14"
              aria-hidden="true"
            />
            <span>{{ file.name.split('/').at(-1) }}</span>
          </button>
        </nav>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.material-preview-dialog {
  width: calc(100vw - 48px);
  max-width: 1440px;
  height: calc(100dvh - 48px);
  max-height: none;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 16px;
  color: var(--ink);
  background: var(--paper);
  box-shadow: 0 24px 80px #18213140;
  overflow: hidden;
}
.material-preview-dialog::backdrop {
  background: #17213199;
  backdrop-filter: blur(4px);
}
.material-preview-dialog-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px 22px 14px;
  gap: 12px;
  min-height: 0;
}
.material-preview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex: none;
}
.material-preview-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.material-preview-identity > svg {
  color: var(--muted);
}
.material-preview-titles {
  min-width: 0;
}
.material-preview-titles strong {
  display: block;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.material-preview-meta {
  display: block;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.material-preview-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}
.material-preview-select {
  padding: 5px 10px;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.material-preview-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.material-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  flex: none;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.material-preview-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}
.material-zoom-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.material-zoom-value {
  min-width: 64px;
  justify-content: center;
  font-variant-numeric: tabular-nums;
}
.material-markdown-toggle {
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--field);
  color: var(--ink);
}
.material-markdown-toggle:hover {
  border-color: #cbd7ee;
  color: var(--blue);
  text-decoration: none;
}
.material-download-link {
  margin-left: auto;
}
.material-preview-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--paper);
}
.material-preview-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 28px 18px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.material-image-canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 20px;
  background-color: #f6f8fc;
  background-image:
    linear-gradient(45deg, #e9edf4 25%, transparent 25%),
    linear-gradient(-45deg, #e9edf4 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e9edf4 75%),
    linear-gradient(-45deg, transparent 75%, #e9edf4 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}
.material-image-canvas.fit-image {
  display: flex;
  align-items: center;
  justify-content: center;
}
.material-image-canvas img {
  display: block;
  margin: 0 auto;
  max-width: none;
  flex: none;
}
.material-image-canvas.fit-image img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.material-text-canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 22px 24px;
  overscroll-behavior: contain;
  background: var(--paper);
}
.material-text-canvas pre {
  margin: 0;
  font: 12px/1.85 ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  color: #37445b;
}
.material-preview-limit {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
.material-preview-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  overflow-x: auto;
  padding: 4px 2px 2px;
}
.material-strip-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  max-width: 240px;
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--field);
  color: var(--muted);
  font-size: 12px;
}
.material-strip-item > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.material-strip-item:hover {
  border-color: #cbd7ee;
  color: var(--ink);
}
.material-strip-item.selected {
  background: #edf2ff;
  border-color: #9ab0f3;
  color: var(--ink);
  font-weight: 600;
}
.material-strip-check {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid #b4c0d4;
  background: transparent;
  flex: none;
}
.material-strip-check.checked {
  border-color: var(--blue);
  background: var(--blue);
}
@media (max-width: 760px) {
  .material-preview-dialog {
    width: 100vw;
    max-width: none;
    height: 100dvh;
    border-radius: 0;
    border: 0;
  }
  .material-preview-dialog-content {
    padding: 14px 12px 10px;
    gap: 10px;
  }
  .material-preview-heading {
    flex-wrap: wrap;
  }
  .material-preview-header-right {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
