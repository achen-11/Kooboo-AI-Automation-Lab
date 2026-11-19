<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { BookOpen, Compass, ExternalLink, FileCode2, FileText, Layers, LoaderCircle, RefreshCw } from '@lucide/vue';
import type { HarnessCatalog, HarnessDocumentDetail, HarnessSettingBinding } from '../../../../shared/harness';
import type { MaterialTreeFile } from '../../lib/material-browser';
import { renderMaterialMarkdown } from '../../lib/material-markdown';
import { api, message } from '../../api';

const catalog = ref<HarnessCatalog | null>(null);
const loading = ref(true);
const error = ref('');
const activePath = ref('README.md');
const docFilter = ref<'all' | 'skill' | 'reference' | 'overview'>('all');

const roleNames: Record<HarnessDocumentDetail['role'], string> = {
  overview: '全局总览',
  skill: 'SKILL',
  reference: '参考手册',
};

const materialFiles = computed<MaterialTreeFile[]>(() =>
  (catalog.value?.documents || []).map(doc => ({
    id: doc.path,
    name: doc.path,
    type: 'text/markdown',
    size: doc.content.length,
    sha256: doc.sha256,
  })),
);

const bindingMap = computed(() => {
  const map = new Map<string, HarnessSettingBinding>();
  for (const item of catalog.value?.bindings || []) map.set(item.key, item);
  return map;
});

const groupedCategories = computed(() => {
  const docs = catalog.value?.documents || [];
  const filtered = docFilter.value === 'all' ? docs : docs.filter(d => d.role === docFilter.value);
  const groups: Array<{ category: string; label: string; items: HarnessDocumentDetail[] }> = [];
  for (const doc of filtered) {
    let group = groups.find(g => g.category === doc.category);
    if (!group) {
      group = { category: doc.category, label: doc.categoryLabel, items: [] };
      groups.push(group);
    }
    group.items.push(doc);
  }
  return groups;
});

const activeDoc = computed(() =>
  catalog.value?.documents.find(d => d.path === activePath.value) || catalog.value?.documents[0] || null,
);

const activeBinding = computed(() =>
  activeDoc.value?.editableSettingKey ? bindingMap.value.get(activeDoc.value.editableSettingKey) : undefined,
);

const activeStage = computed(() =>
  catalog.value?.stages.find(
    stage => stage.primaryDoc === activePath.value || stage.referenceDocs.includes(activePath.value),
  ),
);

const renderedHtml = computed(() =>
  activeDoc.value ? renderMaterialMarkdown(activeDoc.value.content, activeDoc.value.path, materialFiles.value) : '',
);

function docBinding(doc: HarnessDocumentDetail): HarnessSettingBinding | undefined {
  return doc.editableSettingKey ? bindingMap.value.get(doc.editableSettingKey) : undefined;
}

function selectDoc(path: string) {
  if (catalog.value?.documents.some(d => d.path === path)) {
    activePath.value = path;
  }
}

function onMarkdownClick(event: MouseEvent) {
  const target = (event.target as HTMLElement | null)?.closest('[data-material-file]') as HTMLElement | null;
  if (!target) return;
  event.preventDefault();
  const nextPath = target.getAttribute('data-material-file');
  if (nextPath) selectDoc(nextPath);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api<HarnessCatalog>('/automation/harness');
    catalog.value = result;
    if (!result.documents.some(d => d.path === activePath.value)) {
      activePath.value = result.overviewPath || result.documents[0]?.path || 'README.md';
    }
  } catch (reason) {
    error.value = message(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => { void load(); });
</script>

<template>
  <header class="page-header">
    <div>
      <h1>AI 蓝图（Harness）</h1>
      <p class="text-muted">透明查看系统在六大阶段的内置 Agent 规范、参考手册、双层输出规则与设置覆盖状态</p>
    </div>
    <div class="harness-header-actions">
      <span v-if="catalog" class="status-badge">v{{ catalog.version }} · {{ catalog.rootDir }}</span>
      <button class="button secondary" :disabled="loading" @click="load">
        <LoaderCircle v-if="loading" class="spin" :size="15" />
        <RefreshCw v-else :size="15" />
        刷新
      </button>
      <a class="button primary" href="#/settings">规则覆盖设置<ExternalLink :size="14" /></a>
    </div>
  </header>

  <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  <p v-if="loading && !catalog" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载 Harness 蓝图…</p>

  <template v-if="catalog">
    <section class="panel settings-panel harness-stages-panel">
      <div class="section-heading">
        <h2><Compass :size="17" /> 自动化运行全链路</h2>
        <span class="text-muted small-text">点击任意阶段卡片可直接查看对应的核心规范与参考手册</span>
      </div>
      <div class="harness-stage-grid">
        <article
          v-for="stage in catalog.stages"
          :key="stage.id"
          class="harness-stage-card"
          :class="{ active: activeStage?.id === stage.id }"
          @click="selectDoc(stage.primaryDoc)"
        >
          <div class="harness-stage-top">
            <strong>{{ stage.title }}</strong>
            <span class="harness-actor-chip">{{ stage.actor }}</span>
          </div>
          <p class="harness-stage-summary">{{ stage.summary }}</p>
          <div class="harness-stage-links" @click.stop>
            <button type="button" class="text-action harness-doc-btn" :class="{ selected: activePath === stage.primaryDoc }" @click="selectDoc(stage.primaryDoc)">
              <FileCode2 :size="13" />核心 SKILL
            </button>
            <button
              v-for="refDoc in stage.referenceDocs"
              :key="refDoc"
              type="button"
              class="text-action harness-doc-btn"
              :class="{ selected: activePath === refDoc }"
              @click="selectDoc(refDoc)"
            >
              <FileText :size="13" />{{ refDoc.split('/').pop() }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <div class="harness-browser">
      <aside class="panel harness-sidebar">
        <div class="harness-sidebar-head">
          <h2><Layers :size="16" /> 文档目录（{{ catalog.documents.length }}）</h2>
          <div class="harness-role-tabs">
            <button v-for="opt in ([['all', '全部'], ['overview', '总览'], ['skill', 'SKILL'], ['reference', '参考']] as const)" :key="opt[0]" type="button" class="harness-role-tab" :class="{ selected: docFilter === opt[0] }" @click="docFilter = opt[0]">
              {{ opt[1] }}
            </button>
          </div>
        </div>
        <div v-for="group in groupedCategories" :key="group.category" class="harness-nav-group">
          <div class="harness-group-label">{{ group.label }}</div>
          <button
            v-for="doc in group.items"
            :key="doc.path"
            type="button"
            class="harness-doc-item"
            :class="{ selected: activeDoc?.path === doc.path }"
            @click="selectDoc(doc.path)"
          >
            <div class="harness-doc-title-row">
              <span class="harness-doc-title">{{ doc.title }}</span>
              <span v-if="docBinding(doc)?.customized" class="harness-flag customized">已自定义</span>
              <span v-else class="harness-flag">{{ roleNames[doc.role] }}</span>
            </div>
            <span class="harness-doc-path">{{ doc.path }}</span>
          </button>
        </div>
      </aside>

      <section v-if="activeDoc" class="panel settings-panel harness-detail">
        <div class="harness-detail-header">
          <div>
            <div class="harness-detail-badges">
              <span class="status-badge">{{ activeDoc.categoryLabel }}</span>
              <span class="status-badge">{{ roleNames[activeDoc.role] }}</span>
              <span v-if="activeBinding?.customized" class="status-badge pending">当前设置使用自定义规则</span>
              <span v-else-if="activeDoc.editableSettingKey" class="status-badge completed">使用内置 Harness 规则</span>
            </div>
            <h2>{{ activeDoc.title }}</h2>
            <p class="harness-path-meta"><code>{{ catalog.rootDir }}{{ activeDoc.path }}</code> · 指纹 <code>{{ activeDoc.sha256.slice(0, 12) }}</code></p>
          </div>
          <a v-if="activeDoc.editableSettingKey" class="button secondary" href="#/settings">
            编辑 / 恢复默认<ExternalLink :size="14" />
          </a>
        </div>

        <div class="harness-runtime-box">
          <strong><BookOpen :size="14" /> 运行时生效方式</strong>
          <p>{{ activeDoc.runtimeUsage }}</p>
        </div>

        <article class="harness-markdown material-markdown" @click="onMarkdownClick" v-html="renderedHtml" />
      </section>
    </div>
  </template>
</template>

<style scoped>
.harness-header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.harness-stages-panel { margin-bottom: 18px; }
.harness-stages-panel h2, .harness-sidebar-head h2, .harness-runtime-box strong { display: inline-flex; align-items: center; gap: 7px; }
.harness-stage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.harness-stage-card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--paper); cursor: pointer; display: flex; flex-direction: column; gap: 8px; transition: border-color .15s, background .15s; }
.harness-stage-card:hover, .harness-stage-card.active { border-color: var(--blue); background: color-mix(in srgb, var(--blue) 5%, var(--paper)); }
.harness-stage-top { display: flex; flex-direction: column; gap: 4px; }
.harness-stage-top strong { font-size: 13.5px; }
.harness-actor-chip { font-size: 11.5px; color: var(--muted); }
.harness-stage-summary { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--muted); flex: 1; }
.harness-stage-links { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; border-top: 1px dashed var(--line); }
.harness-doc-btn { font-size: 12px; padding: 2px 0; }
.harness-doc-btn.selected { color: var(--blue); font-weight: 600; }

.harness-browser { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 960px) { .harness-browser { grid-template-columns: 1fr; } }
.harness-sidebar { padding: 14px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 16px; max-height: calc(100vh - 90px); overflow-y: auto; }
.harness-sidebar-head { display: flex; flex-direction: column; gap: 8px; }
.harness-sidebar-head h2 { margin: 0; font-size: 15px; }
.harness-role-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.harness-role-tab { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
.harness-role-tab.selected { background: var(--blue); border-color: var(--blue); color: #fff; }
.harness-nav-group { display: flex; flex-direction: column; gap: 4px; }
.harness-group-label { font-size: 11.5px; font-weight: 600; color: var(--muted); padding: 4px 6px 2px; }
.harness-doc-item { text-align: left; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; background: transparent; cursor: pointer; display: flex; flex-direction: column; gap: 3px; color: inherit; }
.harness-doc-item:hover { background: var(--field); }
.harness-doc-item.selected { background: color-mix(in srgb, var(--blue) 9%, transparent); border-color: color-mix(in srgb, var(--blue) 45%, transparent); }
.harness-doc-title-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.harness-doc-title { font-size: 13px; font-weight: 600; line-height: 1.35; }
.harness-doc-path { font-size: 11.5px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.harness-flag { font-size: 11px; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.harness-flag.customized { border-color: var(--orange); color: var(--orange); background: rgba(184, 119, 35, 0.12); }

.harness-detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.harness-detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
.harness-detail-header h2 { margin: 8px 0 4px; font-size: 20px; }
.harness-detail-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.harness-path-meta { margin: 0; font-size: 12.5px; color: var(--muted); }
.harness-runtime-box { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: var(--field); }
.harness-runtime-box p { margin: 6px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }

.harness-markdown :deep(h1), .harness-markdown :deep(h2), .harness-markdown :deep(h3) { margin: 1.1em 0 0.5em; line-height: 1.35; color: var(--ink); }
.harness-markdown :deep(h1) { font-size: 19px; margin-top: 0; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.harness-markdown :deep(h2) { font-size: 16px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.harness-markdown :deep(h3) { font-size: 14.5px; }
.harness-markdown :deep(p), .harness-markdown :deep(ul), .harness-markdown :deep(ol) { margin: 0.6em 0; line-height: 1.65; font-size: 14px; color: #37445b; }
.harness-markdown :deep(ul), .harness-markdown :deep(ol) { padding-left: 20px; }
.harness-markdown :deep(code) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; background: #f0f3f8; padding: 1px 5px; border-radius: 4px; }
.harness-markdown :deep(pre) { background: #f4f6fa; border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; }
.harness-markdown :deep(pre code) { background: transparent; padding: 0; }
.harness-markdown :deep(table) { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.harness-markdown :deep(th), .harness-markdown :deep(td) { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
.harness-markdown :deep(th) { background: #f4f6fa; font-weight: 600; }
.harness-markdown :deep(blockquote) { margin: 10px 0; padding: 6px 12px; border-left: 3px solid #d8e1f0; color: var(--muted); }
.harness-markdown :deep(a) { color: var(--blue); text-decoration: underline; }
</style>
