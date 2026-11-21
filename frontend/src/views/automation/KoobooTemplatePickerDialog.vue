<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Search, X } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import { api, message, platform } from '../../api';
import type {
  KoobooSandboxCapabilities,
  KoobooTemplatePage,
  KoobooTemplateSummary,
} from '../../../../shared/automation';

const emit = defineEmits<{ select: [template: KoobooTemplateSummary] }>();

const dialog = ref<HTMLDialogElement>();
const environmentId = ref('');
const keyword = ref('');
const typeName = ref('Site');
const page = ref(1);
const loading = ref(false);
const error = ref('');
const data = ref<KoobooTemplatePage | null>(null);
const capabilities = ref<KoobooSandboxCapabilities | null>(null);
const capabilitiesLoading = ref(false);
let requestRevision = 0;
let capRevision = 0;

const envOptions = computed(() =>
  (platform.settings?.environments || []).map((env) => ({ value: env.id, label: env.name })),
);
const totalPages = computed(() => Math.max(1, data.value?.totalPages || 1));
const capabilityBanner = computed(() => {
  const cap = capabilities.value;
  if (!cap || (cap.environmentId && cap.environmentId !== environmentId.value)) return '';
  if (cap.transferByLevel === 'unsupported' && cap.importFromTemplate === 'unsupported') {
    return '当前环境暂未升级 Kooboo 模板 Sandbox 接口：不支持「旧站升级 + 直接模板建站」和「克隆到参考 Sandbox」模式（仅非升级场景的直接模板建站可用，且缺少新版原位适配规范）。建议改用外部参考站 URL 或切换已升级环境。';
  }
  if (cap.transferByLevel === 'unsupported') {
    return '当前环境暂未升级旧站 Sandbox 克隆接口：不支持「旧站升级 + 直接模板建站（角色对调）」，其余模板模式可用。';
  }
  if (cap.importFromTemplate === 'unsupported') {
    return '当前环境暂未升级模板参考 Sandbox 接口：不支持「克隆到参考 Sandbox」模式，可改用「直接模板建站」或外部参考站 URL。';
  }
  return '';
});

async function loadCapabilities(targetEnvId = environmentId.value, force = false) {
  if (!targetEnvId) {
    capabilities.value = null;
    capabilitiesLoading.value = false;
    return;
  }
  const current = ++capRevision;
  capabilitiesLoading.value = true;
  if (force) capabilities.value = null;
  try {
    const query = new URLSearchParams({ environmentId: targetEnvId });
    if (force) query.set('refresh', '1');
    const result = await api<KoobooSandboxCapabilities>(`/automation/kooboo/capabilities?${query}`);
    if (current === capRevision && environmentId.value === targetEnvId) {
      capabilities.value = result;
    }
  } catch {
    if (current === capRevision) capabilities.value = null;
  } finally {
    if (current === capRevision) capabilitiesLoading.value = false;
  }
}

async function load(targetPage = page.value) {
  if (!environmentId.value) {
    error.value = '请先在系统设置中配置 Kooboo 环境';
    return;
  }
  const current = ++requestRevision;
  page.value = Math.max(1, targetPage);
  loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams({
      environmentId: environmentId.value,
      keyword: keyword.value.trim(),
      typeName: typeName.value,
      page: String(page.value),
      pageSize: '12',
    });
    const result = await api<KoobooTemplatePage>(`/automation/kooboo/templates?${query}`);
    if (current !== requestRevision) return;
    data.value = result;
  } catch (reason) {
    if (current === requestRevision) error.value = message(reason);
  } finally {
    if (current === requestRevision) loading.value = false;
  }
}

function search() {
  void load(1);
}

function onEnvironmentChange() {
  capabilities.value = null;
  void loadCapabilities(environmentId.value);
  search();
}

function open(initialEnvironmentId?: string) {
  const envs = platform.settings?.environments || [];
  environmentId.value =
    envs.some((env) => env.id === initialEnvironmentId) && initialEnvironmentId
      ? initialEnvironmentId
      : envs[0]?.id || '';
  keyword.value = '';
  typeName.value = 'Site';
  page.value = 1;
  data.value = null;
  capabilities.value = null;
  error.value = '';
  dialog.value?.showModal();
  if (environmentId.value) {
    void loadCapabilities(environmentId.value);
    void load(1);
  } else error.value = '请先在系统设置中配置 Kooboo 环境';
}

function close() {
  requestRevision++;
  capRevision++;
  dialog.value?.close();
}

function choose(template: KoobooTemplateSummary) {
  emit('select', template);
  close();
}

onBeforeUnmount(() => {
  requestRevision++;
  capRevision++;
});

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal wide-modal template-picker-modal" aria-labelledby="template-picker-title" @cancel.prevent="close">
    <div class="template-picker-shell">
      <div class="modal-head">
        <h2 id="template-picker-title">选择 Kooboo 模板市场模板</h2>
        <button type="button" class="icon-button" aria-label="关闭" @click="close">
          <X :size="20" />
        </button>
      </div>

      <form class="template-picker-toolbar" @submit.prevent="search">
        <BaseSelect
          v-model="environmentId"
          size="small"
          aria-label="Kooboo 环境"
          :options="envOptions.length ? envOptions : [{ value: '', label: '未配置环境', disabled: true }]"
          @update:model-value="onEnvironmentChange"
        />
        <BaseSelect
          v-model="typeName"
          size="small"
          aria-label="模板类型"
          :options="[
            { value: 'Site', label: '网站模板 (Site)' },
            { value: '', label: '全部类型' },
          ]"
          @update:model-value="search"
        />
        <label class="search-field template-picker-search">
          <Search :size="16" />
          <input v-model="keyword" placeholder="搜索模板名称、分类或标签" aria-label="搜索模板" />
        </label>
        <button type="submit" class="button secondary small" :disabled="loading || !environmentId">搜索</button>
      </form>

      <p v-if="capabilityBanner" class="alert info template-cap-alert" role="status">
        <span>{{ capabilityBanner }}</span>
        <button type="button" class="text-action" :disabled="capabilitiesLoading" @click="loadCapabilities(environmentId, true)">
          {{ capabilitiesLoading ? '检测中…' : '重新检测' }}
        </button>
      </p>

      <p v-if="error" class="alert error" role="alert">
        {{ error }}
        <button v-if="environmentId" type="button" class="text-action" :disabled="loading" @click="load(page)">重试</button>
      </p>

      <p v-if="loading && !data" class="section-loading">
        <LoaderCircle class="spin" :size="18" />
        正在查询 Kooboo 模板市场…
      </p>

      <div v-else-if="data && !data.list.length" class="empty-state template-picker-empty">
        <h2>未找到匹配的模板</h2>
        <p>尝试更换关键词，或切换回全部分类/网站模板。</p>
      </div>

      <div v-else-if="data" class="template-picker-grid">
        <article v-for="item in data.list" :key="item.id" class="template-card">
          <div class="template-thumb">
            <img v-if="item.thumbnailUrl" :src="item.thumbnailUrl" :alt="item.name" loading="lazy" />
            <span v-else class="text-muted">暂无缩略图</span>
          </div>
          <div class="template-body">
            <div class="template-head">
              <strong :title="item.name">{{ item.name || item.id }}</strong>
              <span v-if="item.category || item.typeName" class="template-badge">{{ item.category || item.typeName }}</span>
            </div>
            <p class="template-meta">{{ item.pageCount }} 页 · {{ item.viewCount }} 视图 · 下载 {{ item.downloadCount }}</p>
            <p v-if="!item.previewUrl" class="template-warn">当前环境未返回 previewUrl</p>
            <div class="template-actions">
              <a v-if="item.previewUrl" class="site-link template-preview-link" :href="item.previewUrl" target="_blank" rel="noopener noreferrer">
                预览<ExternalLink :size="12" />
              </a>
              <button type="button" class="button primary small" @click="choose(item)">使用此模板</button>
            </div>
          </div>
        </article>
      </div>

      <footer class="table-footer template-picker-footer">
        <span>共 {{ data?.totalCount ?? 0 }} 个模板</span>
        <div class="pagination">
          <button type="button" class="icon-button" :disabled="loading || page <= 1" aria-label="上一页" @click="load(page - 1)">
            <ChevronLeft :size="17" />
          </button>
          <span>{{ page }} / {{ totalPages }}</span>
          <button type="button" class="icon-button" :disabled="loading || page >= totalPages" aria-label="下一页" @click="load(page + 1)">
            <ChevronRight :size="17" />
          </button>
        </div>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.template-picker-modal {
  width: min(920px, calc(100vw - 32px));
}
.template-picker-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 82dvh;
}
.template-picker-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.template-picker-toolbar > :deep(.ui-select) {
  min-width: 145px;
}
.template-picker-search {
  flex: 1 1 200px;
  min-width: 180px;
}
.template-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 14px;
  overflow: auto;
  padding: 2px;
}
.template-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
}
.template-thumb {
  aspect-ratio: 16 / 10;
  background: var(--field);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
}
.template-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.template-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  flex: 1;
}
.template-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.template-head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.template-badge {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--field);
  color: var(--muted);
  font-size: 11px;
}
.template-meta {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.template-warn {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}
.template-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}
.template-preview-link {
  font-size: 12px;
}
.template-picker-empty {
  padding: 36px 16px;
}
.template-cap-alert {
  margin: 0;
}
.template-picker-footer {
  padding: 10px 0 0;
  border-top: 1px solid var(--line);
}
</style>
