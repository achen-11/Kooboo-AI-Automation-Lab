<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  Ban,
  Check,
  Download,
  Eye,
  Image,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from '@lucide/vue';
import type { AutomationTask, MaterialFile } from '../../../../shared/automation';
import type {
  SupplementMode,
  SupplementalFileRef,
  TaskSupplementBatch,
  TaskSupplementContext,
} from '../../../../shared/supplement';
import { api, formatDate, message, sessionFetch } from '../../api';
import { bytes } from './common';
import { loadMaterialPreview, materialFormat } from '../../lib/material-browser';
import { notify } from '../../lib/notifications';
import Disclosure from '../../components/Disclosure.vue';
import MaterialPreviewDialog from '../../components/MaterialPreviewDialog.vue';
import MaterialUploader from '../../components/MaterialUploader.vue';

const props = defineProps<{ taskId: string }>();
const emit = defineEmits<{ applied: []; changed: [] }>();

const dialog = ref<HTMLDialogElement>();
const previewDialog = ref<InstanceType<typeof MaterialPreviewDialog>>();
const dialogOpen = ref(false);
const thumbUrls = ref<Record<string, string>>({});
const context = ref<TaskSupplementContext | null>(null);
const loading = ref(false);
const busy = ref(false);
const loadError = ref('');
const actionError = ref('');

const mode = ref<SupplementMode>('manual');

const manualUploader = ref<InstanceType<typeof MaterialUploader>>();
const manualUploaderBusy = ref(false);
const manualFiles = ref<MaterialFile[]>([]);
const manualNote = ref('');
const replacementContentUrl = ref('');
const replacementReferenceUrl = ref('');
const skipSourceTransfer = ref(false);
const skipSourceTouched = ref(false);

const aiUploader = ref<InstanceType<typeof MaterialUploader>>();
const aiUploaderBusy = ref(false);
const aiSourceUrl = ref('');
const aiNote = ref('');
const aiInputFiles = ref<MaterialFile[]>([]);
const aiSkipSourceTransfer = ref(true);
const aiAutoApply = ref(false);

const selectedFileIds = ref<string[]>([]);
const draftNote = ref('');
const draftSkipSourceTransfer = ref(true);
const draftReplacementContentUrl = ref('');
const draftReplacementReferenceUrl = ref('');

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let requestToken = 0;
let disposed = false;

const activeBatch = computed<TaskSupplementBatch | undefined>(() =>
  context.value?.batches.find(b => b.status === 'collecting' || b.status === 'ready'),
);

const latestFailedBatch = computed<TaskSupplementBatch | undefined>(() => {
  const first = context.value?.batches[0];
  return first?.status === 'failed' ? first : undefined;
});

const historyBatches = computed<TaskSupplementBatch[]>(() =>
  (context.value?.batches || []).filter(b => b.id !== activeBatch.value?.id),
);

const isCollecting = computed(() => activeBatch.value?.status === 'collecting');
const isReadyDraft = computed(() => activeBatch.value?.status === 'ready');

const sourceLabels: Record<SupplementalFileRef['source'], string> = {
  manual: '人工',
  'ai-doc': '文档',
  'ai-screenshot': '截图',
  'ai-asset': '图片',
};

const batchStatusLabels: Record<TaskSupplementBatch['status'], string> = {
  collecting: 'AI 收集中',
  ready: '待确认导入',
  applied: '已导入并恢复',
  failed: '收集失败',
  cancelled: '已放弃',
};

function stopPoll() {
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function syncDraftControls(batch: TaskSupplementBatch | undefined) {
  if (!batch || batch.status !== 'ready') return;
  const preferred = new Set(batch.summary?.selectedFiles || []);
  const matching = batch.files.filter(f => preferred.has(f.name) || preferred.has(f.id)).map(f => f.id);
  selectedFileIds.value = matching.length ? matching : batch.files.map(f => f.id);
  draftNote.value = batch.note || '';
  draftSkipSourceTransfer.value = batch.skipSourceTransfer ?? true;
  draftReplacementContentUrl.value = batch.replacementContentUrl || '';
  draftReplacementReferenceUrl.value = batch.replacementReferenceUrl || '';
}

function applyInitialDefaults(data: TaskSupplementContext, resetInputs: boolean) {
  const collectingOrReady = data.batches.find(b => b.status === 'collecting' || b.status === 'ready');
  if (collectingOrReady?.status === 'ready') {
    syncDraftControls(collectingOrReady);
  }
  if (!resetInputs) return;
  const isSourceAccess = data.interruptionCategory === 'source-access';
  skipSourceTouched.value = false;
  skipSourceTransfer.value = isSourceAccess && !data.pendingUpload;
  replacementContentUrl.value = '';
  replacementReferenceUrl.value = '';
  manualNote.value = '';
  manualFiles.value = [];
  aiSourceUrl.value = isSourceAccess ? data.effectiveContentUrl || '' : '';
  aiNote.value = '';
  aiInputFiles.value = [];
  aiSkipSourceTransfer.value = true;
  aiAutoApply.value = false;
  if (isSourceAccess && !data.pendingUpload) {
    mode.value = 'ai-assisted';
  } else {
    mode.value = 'manual';
  }
}

function schedulePoll() {
  stopPoll();
  if (disposed || !dialog.value?.open) return;
  if (!context.value?.batches.some(b => b.status === 'collecting')) return;
  pollTimer = setTimeout(async () => {
    const prevStatus = activeBatch.value?.status;
    await refresh(false);
    const nextReady = context.value?.batches.find(b => b.status === 'ready');
    const nextApplied = context.value?.batches[0];
    if (prevStatus === 'collecting' && nextReady) {
      syncDraftControls(nextReady);
      emit('changed');
    } else if (prevStatus === 'collecting' && nextApplied?.status === 'applied') {
      notify.success('AI 已自动整理并导入补充资料，任务已重新排队');
      emit('applied');
      emit('changed');
      close();
      return;
    } else if (prevStatus === 'collecting' && nextApplied?.status === 'failed') {
      emit('changed');
    }
    schedulePoll();
  }, 2500);
}

async function refresh(resetInputs = false) {
  const token = ++requestToken;
  loadError.value = '';
  if (!context.value) loading.value = true;
  try {
    const prevHadCollecting = Boolean(context.value?.batches.some(b => b.status === 'collecting'));
    const result = await api<TaskSupplementContext>(`/automation/tasks/${props.taskId}/supplements`);
    if (disposed || token !== requestToken) return;
    context.value = result;
    const ready = result.batches.find(b => b.status === 'ready');
    if (ready && (resetInputs || prevHadCollecting)) {
      syncDraftControls(ready);
    }
    applyInitialDefaults(result, resetInputs);
    schedulePoll();
  } catch (reason) {
    if (!disposed && token === requestToken) loadError.value = message(reason);
  } finally {
    if (!disposed && token === requestToken) loading.value = false;
  }
}

async function open(preferredMode?: SupplementMode) {
  if (disposed || dialog.value?.open) return;
  actionError.value = '';
  loadError.value = '';
  context.value = null;
  dialog.value?.showModal();
  dialogOpen.value = true;
  await refresh(true);
  if (preferredMode && !activeBatch.value) {
    mode.value = preferredMode;
  }
}

function close() {
  if (busy.value) return;
  stopPoll();
  ++requestToken;
  dialogOpen.value = false;
  previewDialog.value?.close();
  dialog.value?.close();
}

function onDialogClose() {
  stopPoll();
  dialogOpen.value = false;
  previewDialog.value?.close();
}

watch(
  [
    dialogOpen,
    () => activeBatch.value?.id,
    () => activeBatch.value?.status,
    () => (activeBatch.value?.files || []).map(f => `${f.id}:${f.sha256}`).join('|'),
  ],
  async (_vals, _prev, onCleanup) => {
    const controller = new AbortController();
    const createdUrls: string[] = [];
    onCleanup(() => {
      controller.abort();
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
      thumbUrls.value = {};
    });

    thumbUrls.value = {};
    const batch = activeBatch.value;
    if (!dialogOpen.value || !batch || batch.status !== 'ready') return;
    const images = batch.files.filter(file => materialFormat(file).kind === 'image');
    if (!images.length) return;

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(3, images.length) }, async () => {
      while (!controller.signal.aborted) {
        const file = images[nextIndex++];
        if (!file) break;
        try {
          const result = await loadMaterialPreview(file, sessionFetch, controller.signal);
          if (controller.signal.aborted || result.kind !== 'image') continue;
          const url = URL.createObjectURL(result.blob);
          if (controller.signal.aborted) {
            URL.revokeObjectURL(url);
            continue;
          }
          createdUrls.push(url);
          thumbUrls.value = { ...thumbUrls.value, [file.id]: url };
        } catch {
          // Keep icon placeholder when thumbnail loading fails.
        }
      }
    });
    await Promise.all(workers);
  },
  { immediate: true },
);

function onSkipToggle() {
  skipSourceTouched.value = true;
}

function onReplacementUrlInput() {
  if (!skipSourceTouched.value && replacementContentUrl.value.trim()) {
    skipSourceTransfer.value = false;
  }
}

function toggleDraftFile(fileId: string) {
  if (selectedFileIds.value.includes(fileId)) {
    selectedFileIds.value = selectedFileIds.value.filter(id => id !== fileId);
  } else {
    selectedFileIds.value = [...selectedFileIds.value, fileId];
  }
}

function selectAllDraftFiles() {
  if (!activeBatch.value) return;
  selectedFileIds.value = activeBatch.value.files.map(f => f.id);
}

function clearDraftFiles() {
  selectedFileIds.value = [];
}

async function submitManual() {
  if (busy.value || !context.value?.canSupplement) return;
  actionError.value = '';
  busy.value = true;
  try {
    if (manualUploader.value?.upload) {
      const ok = await manualUploader.value.upload();
      if (!ok) {
        actionError.value = '存在未完成上传的文件，请检查 uploader 中的报错提示';
        return;
      }
    }
    const hasFiles = manualFiles.value.length > 0;
    const note = manualNote.value.trim();
    const contentUrl = replacementContentUrl.value.trim();
    const referenceUrl = replacementReferenceUrl.value.trim();
    if (!hasFiles && !note && !contentUrl && !referenceUrl && !skipSourceTransfer.value) {
      actionError.value = '请至少上传资料文件、填写补充说明或提供新的源站/参考站网址';
      return;
    }
    await api<{ task: AutomationTask; batch: TaskSupplementBatch }>(
      `/automation/tasks/${props.taskId}/supplements/manual`,
      {
        method: 'POST',
        body: JSON.stringify({
          files: manualFiles.value,
          note,
          replacementContentUrl: contentUrl,
          replacementReferenceUrl: referenceUrl,
          skipSourceTransfer: skipSourceTransfer.value,
        }),
      },
    );
    notify.success('补充资料已保存，任务已重新加入执行队列');
    emit('applied');
    emit('changed');
    busy.value = false;
    close();
  } catch (reason) {
    actionError.value = message(reason);
  } finally {
    busy.value = false;
  }
}

async function submitAiCollect() {
  if (busy.value || !context.value?.canSupplement) return;
  actionError.value = '';
  busy.value = true;
  try {
    if (aiUploader.value?.upload) {
      const ok = await aiUploader.value.upload();
      if (!ok) {
        actionError.value = '存在未完成上传的原始素材，请检查后重试';
        return;
      }
    }
    const sourceUrl = aiSourceUrl.value.trim();
    const note = aiNote.value.trim();
    if (!sourceUrl && !note && aiInputFiles.value.length === 0) {
      actionError.value = '请填写目标抓取网址、收集整理要求，或上传原始参考素材';
      return;
    }
    await api<{ batch: TaskSupplementBatch }>(
      `/automation/tasks/${props.taskId}/supplements/ai-collect`,
      {
        method: 'POST',
        body: JSON.stringify({
          sourceUrl,
          note,
          inputFiles: aiInputFiles.value,
          autoApply: aiAutoApply.value,
          skipSourceTransfer: aiSkipSourceTransfer.value,
        }),
      },
    );
    notify.success('已启动本地 AI 资料收集与整理');
    emit('changed');
    await refresh(false);
  } catch (reason) {
    actionError.value = message(reason);
  } finally {
    busy.value = false;
  }
}

async function applyDraft() {
  if (busy.value || !activeBatch.value || activeBatch.value.status !== 'ready') return;
  actionError.value = '';
  if (!selectedFileIds.value.length && !draftNote.value.trim() && !draftReplacementContentUrl.value.trim() && !draftReplacementReferenceUrl.value.trim()) {
    actionError.value = '请至少勾选 1 个整理出的文件，或填写补充说明';
    return;
  }
  busy.value = true;
  try {
    await api<{ task: AutomationTask; batch: TaskSupplementBatch }>(
      `/automation/tasks/${props.taskId}/supplements/${activeBatch.value.id}/apply`,
      {
        method: 'POST',
        body: JSON.stringify({
          selectedFileIds: selectedFileIds.value,
          note: draftNote.value.trim(),
          skipSourceTransfer: draftSkipSourceTransfer.value,
          replacementContentUrl: draftReplacementContentUrl.value.trim(),
          replacementReferenceUrl: draftReplacementReferenceUrl.value.trim(),
        }),
      },
    );
    notify.success('已确认并导入资料，任务已重新加入执行队列');
    emit('applied');
    emit('changed');
    busy.value = false;
    close();
  } catch (reason) {
    actionError.value = message(reason);
  } finally {
    busy.value = false;
  }
}

async function cancelBatch(batch: TaskSupplementBatch) {
  if (busy.value) return;
  actionError.value = '';
  busy.value = true;
  try {
    await api<{ batch: TaskSupplementBatch }>(
      `/automation/tasks/${props.taskId}/supplements/${batch.id}/cancel`,
      { method: 'POST' },
    );
    notify.success(batch.status === 'collecting' ? '已取消本地 AI 资料收集' : '已放弃本次资料草稿');
    emit('changed');
    await refresh(false);
  } catch (reason) {
    actionError.value = message(reason);
  } finally {
    busy.value = false;
  }
}

onUnmounted(() => {
  disposed = true;
  stopPoll();
  ++requestToken;
});

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="modal wide-modal supplement-modal"
    aria-labelledby="supplement-dialog-title"
    @close="onDialogClose"
    @cancel.prevent="close"
  >
    <div class="modal-head">
      <div class="supplement-head-title">
        <h2 id="supplement-dialog-title">补充资料 / AI 收集</h2>
        <span v-if="activeBatch" class="status-badge" :class="activeBatch.status === 'collecting' ? 'collecting' : 'pending'">
          {{ batchStatusLabels[activeBatch.status] }}
        </span>
      </div>
      <button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="close">
        <X :size="20" />
      </button>
    </div>

    <div class="supplement-body">
      <p v-if="loading" class="section-loading">
        <LoaderCircle class="spin" :size="18" />正在读取任务上下文与历史记录…
      </p>

      <p v-else-if="loadError" class="alert error" role="alert">
        {{ loadError }}
        <button type="button" class="text-action" @click="refresh(false)">重试</button>
      </p>

      <template v-else-if="context">
        <p v-if="!context.canSupplement" class="alert info" role="status">
          当前仅支持对已停止的生成任务（中断 / 待处理 / 失败 / 已取消）补充资料；若任务正在运行，请先取消并确认停止后再操作。
        </p>

        <!-- Contextual banner: Kooboo ask_user_input(upload) or source-access interruption -->
        <div v-if="context.pendingUpload" class="supplement-context-card">
          <div class="supplement-context-head">
            <strong>Kooboo 建站 AI 正在等待补充文件</strong>
            <span v-if="context.pendingUpload.target" class="task-meta-tag">
              目标：{{ context.pendingUpload.target === 'mediaLibrary' ? '媒体库' : context.pendingUpload.target }}
            </span>
          </div>
          <p class="task-prose">{{ context.pendingUpload.question }}</p>
          <p v-if="context.pendingUpload.description" class="text-muted small-text">
            {{ context.pendingUpload.description }}
          </p>
          <p v-if="context.pendingUpload.accept?.length || context.pendingUpload.folder || context.pendingUpload.maxFiles" class="text-muted small-text">
            <span v-if="context.pendingUpload.folder">建议目录：{{ context.pendingUpload.folder }} · </span>
            <span v-if="context.pendingUpload.accept?.length">支持类型：{{ context.pendingUpload.accept.join(', ') }} · </span>
            <span v-if="context.pendingUpload.maxFiles">最多 {{ context.pendingUpload.maxFiles }} 个</span>
          </p>
        </div>

        <div v-else-if="context.interruptionCategory === 'source-access'" class="supplement-context-card">
          <div class="supplement-context-head">
            <strong>原内容站未能直接抓取成功</strong>
            <span v-if="context.hasTargetSite" class="task-meta-tag">已保留目标站点</span>
          </div>
          <p class="task-prose">
            你可以直接手动上传站点文档、页面图片或替换可访问网址；也可以交给本地 AI 抓取新网址并整理为 Markdown 文案和图片素材，确认后直接写入当前目标站点继续生成。
          </p>
        </div>

        <p v-if="latestFailedBatch?.error" class="alert error" role="alert">
          上次 AI 资料收集未完成：{{ latestFailedBatch.error }}
        </p>

        <!-- Collecting state -->
        <section v-if="isCollecting && activeBatch" class="supplement-stage-card">
          <div class="supplement-stage-head">
            <div class="supplement-status-inline">
              <LoaderCircle class="spin" :size="18" />
              <strong>本地 AI 正在收集与整理资料…</strong>
            </div>
            <span class="text-muted small-text">{{ formatDate(activeBatch.createdAt) }}</span>
          </div>
          <p v-if="activeBatch.sourceUrl" class="text-muted small-text">
            目标来源：<code>{{ activeBatch.sourceUrl }}</code>
          </p>
          <p v-if="activeBatch.note" class="task-prose">{{ activeBatch.note }}</p>
          <p class="text-muted small-text">
            收集与整理在后台执行，你可以先关闭窗口；完成后会保存在待确认草稿中
            <template v-if="activeBatch.autoApply">（当前已勾选自动导入并继续）</template>。
          </p>
          <div class="inline-actions">
            <button type="button" class="button secondary small" :disabled="busy" @click="cancelBatch(activeBatch)">
              <Ban :size="15" />取消收集
            </button>
            <button type="button" class="button secondary small" :disabled="busy" @click="refresh(false)">
              <RefreshCw :size="15" />刷新进度
            </button>
          </div>
        </section>

        <!-- Ready draft awaiting human confirmation -->
        <section v-else-if="isReadyDraft && activeBatch" class="supplement-stage-card">
          <div class="supplement-stage-head">
            <div>
              <strong>{{ activeBatch.summary?.headline || 'AI 已整理好资料草稿，待确认导入' }}</strong>
              <p v-if="activeBatch.sourceUrl" class="text-muted small-text">
                整理来源：<code>{{ activeBatch.sourceUrl }}</code>
              </p>
            </div>
            <span class="status-badge pending">待你确认</span>
          </div>

          <div v-if="activeBatch.summary?.collectedFrom.length" class="supplement-summary-block">
            <span class="small-text text-muted">已采集页面 / 来源</span>
            <ul class="task-text-list">
              <li v-for="src in activeBatch.summary.collectedFrom" :key="src">{{ src }}</li>
            </ul>
          </div>

          <div v-if="activeBatch.summary?.highlights.length" class="supplement-summary-block">
            <span class="small-text text-muted">整理要点</span>
            <ul class="task-text-list">
              <li v-for="item in activeBatch.summary.highlights" :key="item">{{ item }}</li>
            </ul>
          </div>

          <div v-if="activeBatch.summary?.gaps.length" class="supplement-summary-block">
            <span class="small-text text-muted">仍存在的缺口或注意事项</span>
            <ul class="task-text-list">
              <li v-for="gap in activeBatch.summary.gaps" :key="gap">{{ gap }}</li>
            </ul>
          </div>

          <div class="supplement-files-box">
            <div class="supplement-files-head">
              <strong>选择要导入到站点的资料（已选 {{ selectedFileIds.length }} / {{ activeBatch.files.length }}）</strong>
              <div class="inline-actions">
                <button type="button" class="text-action" @click="selectAllDraftFiles">全选</button>
                <button type="button" class="text-action" @click="clearDraftFiles">清空</button>
              </div>
            </div>
            <div v-if="activeBatch.files.length" class="supplement-file-list">
              <div v-for="file in activeBatch.files" :key="file.id" class="supplement-file-row">
                <input
                  type="checkbox"
                  :checked="selectedFileIds.includes(file.id)"
                  :disabled="busy"
                  :aria-label="`选择导入 ${file.name}`"
                  @change="toggleDraftFile(file.id)"
                />
                <button
                  v-if="materialFormat(file).kind === 'image'"
                  type="button"
                  class="supplement-file-thumb"
                  :aria-label="`预览图片 ${file.name}`"
                  title="点击放大预览"
                  @click="previewDialog?.open(file.id)"
                >
                  <img v-if="thumbUrls[file.id]" :src="thumbUrls[file.id]" :alt="file.name" />
                  <Image v-else :size="15" aria-hidden="true" />
                </button>
                <button
                  v-if="materialFormat(file).kind !== 'unsupported'"
                  type="button"
                  class="supplement-file-name supplement-file-name-btn"
                  :title="`预览 ${file.name}`"
                  @click="previewDialog?.open(file.id)"
                >
                  {{ file.name }}
                </button>
                <span v-else class="supplement-file-name">{{ file.name }}</span>
                <span class="task-meta-tag">{{ sourceLabels[file.source] }}</span>
                <span class="text-muted small-text">{{ bytes(file.size) }}</span>
                <template v-if="materialFormat(file).kind !== 'unsupported'">
                  <button
                    type="button"
                    class="text-action supplement-file-action"
                    :title="`在线预览 ${file.name}`"
                    @click="previewDialog?.open(file.id)"
                  >
                    <Eye :size="14" />预览
                  </button>
                  <a
                    class="icon-button supplement-file-download"
                    :href="`/api/automation/files/${file.id}`"
                    download
                    :title="`下载 ${file.name}`"
                    :aria-label="`下载 ${file.name}`"
                  >
                    <Download :size="14" />
                  </a>
                </template>
                <a
                  v-else
                  class="text-action supplement-file-action"
                  :href="`/api/automation/files/${file.id}`"
                  download
                  :title="`下载 ${file.name}`"
                >
                  <Download :size="14" />下载
                </a>
              </div>
            </div>
            <p v-else class="text-muted small-text">本次未生成附件文件，你仍可直接通过补充说明继续。</p>
          </div>

          <label class="field">
            <span>导入给建站 AI 的补充说明 <small>可按需修改后随资料一起发给原会话</small></span>
            <textarea
              v-model="draftNote"
              class="input textarea"
              rows="3"
              :disabled="busy"
              placeholder="例如：优先参考上述整理文案与截图结构补全站点页面…"
            />
          </label>

          <label class="check-label">
            <input v-model="draftSkipSourceTransfer" type="checkbox" :disabled="busy" />
            跳过原站克隆，直接使用上述整理好的资料继续生成
          </label>

          <Disclosure label="同时调整源站或参考站网址（可选）">
            <div class="supplement-url-grid">
              <label class="field">
                <span>替换内容源网址</span>
                <input
                  v-model="draftReplacementContentUrl"
                  type="url"
                  class="input"
                  :disabled="busy"
                  :placeholder="context.effectiveContentUrl || 'https://...'"
                />
              </label>
              <label class="field">
                <span>替换参考站网址</span>
                <input
                  v-model="draftReplacementReferenceUrl"
                  type="url"
                  class="input"
                  :disabled="busy"
                  :placeholder="context.effectiveReferenceUrl || 'https://...'"
                />
              </label>
            </div>
          </Disclosure>

          <p v-if="actionError" class="alert error" role="alert">{{ actionError }}</p>

          <div class="modal-actions">
            <button type="button" class="button secondary" :disabled="busy" @click="cancelBatch(activeBatch)">
              <Ban :size="16" />放弃草稿
            </button>
            <button
              type="button"
              class="button primary"
              :disabled="busy || !context.canSupplement"
              @click="applyDraft"
            >
              <LoaderCircle v-if="busy" class="spin" :size="16" />
              <Check v-else :size="16" />
              {{ busy ? '正在导入并同步站点…' : '确认导入并继续' }}
            </button>
          </div>
        </section>

        <!-- New manual upload or AI-assisted collection form -->
        <template v-else>
          <div class="supplement-mode-bar">
            <div class="segmented" role="tablist" aria-label="选择补充方式">
              <button
                type="button"
                role="tab"
                :aria-selected="mode === 'manual'"
                :class="{ selected: mode === 'manual' }"
                :disabled="busy"
                @click="mode = 'manual'; actionError = ''"
              >
                <Upload :size="15" />手动上传 / 补充
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="mode === 'ai-assisted'"
                :class="{ selected: mode === 'ai-assisted' }"
                :disabled="busy"
                @click="mode = 'ai-assisted'; actionError = ''"
              >
                <Sparkles :size="15" />AI 辅助收集与整理
              </button>
            </div>
          </div>

          <form v-if="mode === 'manual'" class="supplement-form" @submit.prevent="submitManual">
            <div class="field">
              <span>上传资料文件 <small>支持多文件、文件夹拖拽，如图片、文案 Markdown、HTML、JSON 等</small></span>
              <MaterialUploader
                ref="manualUploader"
                v-model="manualFiles"
                :disabled="busy || !context.canSupplement"
                @busy="manualUploaderBusy = $event"
              />
            </div>

            <label class="field">
              <span>补充说明 / 给建站 AI 的指令 <small>可选，将自动构造回答或注入后续上下文</small></span>
              <textarea
                v-model="manualNote"
                class="input textarea"
                rows="3"
                :disabled="busy || !context.canSupplement"
                :placeholder="context.pendingUpload ? '例如：已上传茶叶门店主视觉与商品配图到媒体库，请继续生成页面' : '说明本次补充资料的用途、页面结构要求或需特别注意的内容'"
              />
            </label>

            <Disclosure
              label="替换原内容站 / 参考站网址或跳过克隆（可选）"
              :open="context.interruptionCategory === 'source-access' && !context.pendingUpload"
            >
              <div class="supplement-disclosure-stack">
                <div class="supplement-url-grid">
                  <label class="field">
                    <span>替换原内容站网址 <small>保留原始冻结输入版本不变</small></span>
                    <input
                      v-model="replacementContentUrl"
                      type="url"
                      class="input"
                      :disabled="busy || !context.canSupplement"
                      :placeholder="context.effectiveContentUrl || 'https://...'"
                      @input="onReplacementUrlInput"
                    />
                  </label>
                  <label class="field">
                    <span>替换参考站网址</span>
                    <input
                      v-model="replacementReferenceUrl"
                      type="url"
                      class="input"
                      :disabled="busy || !context.canSupplement"
                      :placeholder="context.effectiveReferenceUrl || 'https://...'"
                    />
                  </label>
                </div>
                <label class="check-label">
                  <input
                    v-model="skipSourceTransfer"
                    type="checkbox"
                    :disabled="busy || !context.canSupplement"
                    @change="onSkipToggle"
                  />
                  跳过原站克隆，直接使用我上传的资料继续生成（推荐在原站无法访问或已手动提供素材时勾选）
                </label>
              </div>
            </Disclosure>

            <p v-if="actionError" class="alert error" role="alert">{{ actionError }}</p>

            <div class="modal-actions">
              <button type="button" class="button secondary" :disabled="busy" @click="close">取消</button>
              <button
                type="submit"
                class="button primary"
                :disabled="busy || manualUploaderBusy || !context.canSupplement"
              >
                <LoaderCircle v-if="busy" class="spin" :size="16" />
                <Upload v-else :size="16" />
                {{ busy ? '正在导入并恢复…' : context.pendingUpload ? '上传并回答 Kooboo 请求' : '导入资料并恢复执行' }}
              </button>
            </div>
          </form>

          <form v-else class="supplement-form" @submit.prevent="submitAiCollect">
            <p class="text-muted small-text">
              本地 AI 将按 <code>harness/intake/SKILL.md</code> 规范使用浏览器抓取公开页面文案、导航、截图与主要图片，整理为结构化 Markdown 资料包。
            </p>

            <label class="field">
              <span>要抓取整理的目标网址 <small>例如备用官网、同客户可访问站点或参考落地页</small></span>
              <input
                v-model="aiSourceUrl"
                type="url"
                class="input"
                :disabled="busy || !context.canSupplement"
                placeholder="https://example.com"
              />
            </label>

            <label class="field">
              <span>收集与整理要求 <small>说明重点收集哪些栏目、文案语种或注意事项</small></span>
              <textarea
                v-model="aiNote"
                class="input textarea"
                rows="3"
                :disabled="busy || !context.canSupplement"
                placeholder="例如：抓取首页、关于我们和产品列表文案与配图，提取品牌主色调和栏目结构"
              />
            </label>

            <div class="field">
              <span>附带原始参考素材 <small>可选，本地 AI 可一并读取整理</small></span>
              <MaterialUploader
                ref="aiUploader"
                v-model="aiInputFiles"
                :disabled="busy || !context.canSupplement"
                @busy="aiUploaderBusy = $event"
              />
            </div>

            <div class="supplement-checks">
              <label class="check-label">
                <input
                  v-model="aiSkipSourceTransfer"
                  type="checkbox"
                  :disabled="busy || !context.canSupplement"
                />
                整理完成后跳过原站克隆，直接以整理结果继续生成
              </label>
              <label class="check-label">
                <input
                  v-model="aiAutoApply"
                  type="checkbox"
                  :disabled="busy || !context.canSupplement"
                />
                整理完成后自动导入目标站并恢复执行（不勾选则先由我确认）
              </label>
            </div>

            <p v-if="actionError" class="alert error" role="alert">{{ actionError }}</p>

            <div class="modal-actions">
              <button type="button" class="button secondary" :disabled="busy" @click="close">取消</button>
              <button
                type="submit"
                class="button primary"
                :disabled="busy || aiUploaderBusy || !context.canSupplement"
              >
                <LoaderCircle v-if="busy" class="spin" :size="16" />
                <Sparkles v-else :size="16" />
                {{ busy ? '正在启动…' : '开始 AI 收集整理' }}
              </button>
            </div>
          </form>
        </template>

        <Disclosure v-if="historyBatches.length" :label="`最近补充记录（${historyBatches.length}）`">
          <ul class="supplement-history-list">
            <li v-for="item in historyBatches" :key="item.id" class="supplement-history-item">
              <div class="supplement-history-top">
                <span class="status-badge" :class="item.status === 'applied' ? 'completed' : item.status === 'failed' ? 'failed' : 'cancelled'">
                  {{ batchStatusLabels[item.status] }}
                </span>
                <span class="task-meta-tag">{{ item.mode === 'ai-assisted' ? 'AI 整理' : '手动补充' }}</span>
                <span class="text-muted small-text">{{ item.files.length }} 个文件 · {{ formatDate(item.updatedAt) }}</span>
              </div>
              <p v-if="item.summary?.headline || item.note" class="task-prose">
                {{ item.summary?.headline || item.note }}
              </p>
              <p v-if="item.error" class="error-text small-text">{{ item.error }}</p>
            </li>
          </ul>
        </Disclosure>
      </template>
    </div>
    <MaterialPreviewDialog
      ref="previewDialog"
      :files="activeBatch?.files || []"
      :selected-ids="selectedFileIds"
      selectable
      :busy="busy"
      @toggle="toggleDraftFile"
    />
  </dialog>
</template>

<style scoped>
.supplement-modal {
  width: min(820px, calc(100vw - 32px));
}
.supplement-head-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.supplement-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 14px;
  max-height: 75vh;
  overflow: auto;
  padding-right: 2px;
}
.supplement-context-card,
.supplement-stage-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.supplement-context-head,
.supplement-stage-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.supplement-status-inline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.supplement-mode-bar {
  display: flex;
  align-items: center;
}
.supplement-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.supplement-form p {
  margin: 0;
}
.supplement-url-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.supplement-disclosure-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}
.supplement-checks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.supplement-summary-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.supplement-files-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.supplement-files-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.supplement-file-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 280px;
  overflow: auto;
}
.supplement-file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--paper);
  font-size: 13px;
}
.supplement-file-thumb {
  width: 40px;
  height: 30px;
  flex: none;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--field);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--muted);
}
.supplement-file-thumb:hover {
  border-color: #9ab0f3;
}
.supplement-file-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.supplement-file-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.supplement-file-name-btn {
  text-align: left;
  padding: 2px 0;
  color: var(--ink);
}
.supplement-file-name-btn:hover {
  color: var(--blue);
  text-decoration: underline;
}
.supplement-file-action {
  flex: none;
}
.supplement-file-download {
  width: 26px;
  height: 26px;
  flex: none;
}
.supplement-history-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.supplement-history-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.supplement-history-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.supplement-modal .modal-actions {
  margin-top: 8px;
}
@media (max-width: 640px) {
  .supplement-url-grid {
    grid-template-columns: 1fr;
  }
}
</style>
