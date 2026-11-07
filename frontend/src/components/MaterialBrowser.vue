<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { Search, X, ChevronsDown, ChevronsUp, Download, FolderOpen, File, FileText, Image, LoaderCircle, RotateCw, Maximize2, Minimize2, Code2, BookOpen } from '@lucide/vue';
import type { MaterialFile } from '../../../shared/automation';
import { message, sessionFetch } from '../api';
import { loadMaterialPreview, materialFormat, type MaterialPreview } from '../lib/material-browser';
import { isMaterialMarkdown } from '../lib/material-markdown';
import { bytes } from '../views/automation/common';
import MaterialTree from './MaterialTree.vue';
import MaterialMarkdown from './MaterialMarkdown.vue';

const props = defineProps<{ files: MaterialFile[] }>();
const tree = ref<InstanceType<typeof MaterialTree>>();
const query = ref(''), selectedName = ref(''), error = ref(''), loading = ref(false), retry = ref(0), originalSize = ref(false), markdownSource = ref(false);
const preview = shallowRef<MaterialPreview | null>(null), imageUrl = ref('');
const selected = computed(() => props.files.find(file => file.name === selectedName.value));
const format = computed(() => selected.value ? materialFormat(selected.value) : undefined);
const markdown = computed(() => !!selected.value && isMaterialMarkdown(selected.value));
watch(() => props.files.map(file => `${file.id}:${file.name}`), () => {
  if (!selected.value) selectedName.value = (props.files.find(file => /(^|\/)readme(?:\.(?:md|txt|markdown))?$/i.test(file.name)) || props.files[0])?.name || '';
}, { immediate: true });
watch([() => selected.value?.id, () => selected.value?.sha256, retry], async (_, __, onCleanup) => {
  const file = selected.value, controller = new AbortController();
  let url = '';
  onCleanup(() => { controller.abort(); if (url) URL.revokeObjectURL(url); });
  preview.value = null; imageUrl.value = ''; error.value = ''; originalSize.value = false; markdownSource.value = false; loading.value = false;
  if (!file || materialFormat(file).kind === 'unsupported') return;
  loading.value = true;
  try {
    const result = await loadMaterialPreview(file, sessionFetch, controller.signal);
    if (controller.signal.aborted) return;
    preview.value = result;
    if (result.kind === 'image') { url = URL.createObjectURL(result.blob); imageUrl.value = url; }
  } catch (reason) { if (!controller.signal.aborted) error.value = message(reason); }
  finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });
</script>

<template>
  <section class="material-browser" aria-label="资料文件浏览与预览">
    <header class="material-browser-toolbar">
      <div class="material-browser-title"><h3>资料文件</h3><span>{{ files.length }} 个文件</span></div>
      <div v-if="$slots.context" class="material-browser-context"><slot name="context" /></div>
      <label v-if="files.length" class="material-search"><Search :size="15" aria-hidden="true" /><input v-model="query" type="search" placeholder="搜索文件或目录" aria-label="搜索资料文件或目录" /><button v-if="query" type="button" class="icon-button" aria-label="清空文件搜索" @click="query = ''"><X :size="14" /></button></label>
    </header>
    <slot name="details" />
    <div v-if="files.length" class="material-browser-layout">
      <aside class="material-browser-sidebar" aria-label="文件与文件夹">
        <div class="material-directory-toolbar"><span>文件目录</span><div><button type="button" class="icon-button" title="展开全部文件夹" aria-label="展开全部文件夹" :disabled="!!query.trim()" @click="tree?.expandAll()"><ChevronsDown :size="15" /></button><button type="button" class="icon-button" title="收起全部文件夹" aria-label="收起全部文件夹" :disabled="!!query.trim()" @click="tree?.collapseAll()"><ChevronsUp :size="15" /></button></div></div>
        <MaterialTree ref="tree" :files="files" :query="query" :selected="selectedName" selectable @select="selectedName = $event" />
      </aside>
      <section class="material-preview" aria-label="文件预览" :aria-busy="loading">
        <header v-if="selected" class="material-preview-heading">
          <div class="material-preview-name"><component :is="format?.kind === 'image' ? Image : format?.kind === 'text' ? FileText : File" :size="18" aria-hidden="true" /><div><strong>{{ selected.name.split('/').at(-1) }}</strong><span :title="selected.name">{{ selected.name }} · {{ bytes(selected.size) }}</span></div></div>
          <div class="material-preview-actions"><button v-if="markdown && preview?.kind === 'text'" type="button" class="text-action material-markdown-toggle" :aria-label="markdownSource ? '预览 Markdown 文档' : '查看 Markdown 源码'" :aria-pressed="markdownSource" @click="markdownSource = !markdownSource"><BookOpen v-if="markdownSource" :size="15" /><Code2 v-else :size="15" />{{ markdownSource ? '预览' : '源码' }}</button><button v-if="preview?.kind === 'image' && !error" type="button" class="icon-button" :aria-label="originalSize ? '适应预览区域' : '以原始尺寸查看'" :title="originalSize ? '适应区域' : '原始尺寸'" :aria-pressed="originalSize" @click="originalSize = !originalSize"><Minimize2 v-if="originalSize" :size="16" /><Maximize2 v-else :size="16" /></button><a class="text-action" :href="`/api/automation/files/${selected.id}`" download :aria-label="`下载 ${selected.name}`"><Download :size="15" />下载</a></div>
        </header>
        <div v-if="loading" class="material-preview-state" role="status"><LoaderCircle class="spin" :size="23" /><p>正在加载预览…</p></div>
        <div v-else-if="error" class="material-preview-state" role="alert"><File :size="28" /><p>{{ error }}</p><button type="button" class="button secondary small" @click="retry++"><RotateCw :size="14" />重新加载</button></div>
        <div v-else-if="preview?.kind === 'image'" class="material-image-preview" :class="{ 'original-size': originalSize }" tabindex="0" :aria-label="`${selected?.name} 图片预览，可滚动查看`"><img :src="imageUrl" :alt="selected?.name" @error="error = '图片无法显示，请重试或下载查看'" /></div>
        <div v-else-if="preview?.kind === 'text'" class="material-text-preview" tabindex="0" :aria-label="`${selected?.name} ${markdown && !markdownSource ? '文档预览' : '文本预览'}`"><MaterialMarkdown v-if="markdown && !markdownSource && preview.text" :source="preview.text" :path="selected!.name" :files="files" @select="selectedName = $event" /><pre v-else>{{ preview.text || '（空文件）' }}</pre><p v-if="preview.truncated" class="material-preview-limit">仅预览前 256 KB，完整内容可下载查看。</p></div>
        <div v-else class="material-preview-state"><File :size="30" /><p>{{ selected ? '暂不支持此格式预览，可下载查看' : '选择文件查看预览' }}</p></div>
      </section>
    </div>
    <div v-else class="material-preview-state material-browser-empty"><FolderOpen :size="30" /><p>暂无资料文件</p></div>
  </section>
</template>

<style scoped>
.material-browser{margin-top:22px;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.material-browser-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.material-browser-title{display:flex;align-items:center;gap:10px}.material-browser-title h3{font-size:14px;font-weight:600}.material-browser-title>span{font-size:11px;color:var(--muted)}
.material-browser-context{display:flex;align-items:center;flex:1;min-width:0;gap:14px;flex-wrap:wrap}.material-browser-title{flex:none}.material-search{margin-left:auto;flex-shrink:0}
.material-search{display:flex;align-items:center;gap:8px;min-width:0;width:240px;max-width:100%;padding:0 9px;border:1px solid transparent;border-radius:7px;background:var(--field);color:var(--muted)}
.material-search:focus-within{border-color:var(--focus-border);box-shadow:var(--focus-shadow)}.material-search input{min-width:0;width:100%;padding:8px 0;background:transparent;border:0;font-size:12px;outline:0;box-shadow:none}.material-search input::-webkit-search-cancel-button{-webkit-appearance:none}.material-search>.icon-button{width:24px;height:24px;flex:none}
.material-browser-layout{display:grid;grid-template-columns:minmax(230px,32%) minmax(0,1fr);height:560px;max-height:72vh;min-height:360px}
.material-browser-sidebar{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line);background:#fafbfd}
.material-directory-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:44px;padding:5px 10px 5px 15px;color:var(--muted);font-size:11px}.material-directory-toolbar>div{display:flex;gap:2px}.material-directory-toolbar .icon-button{width:28px;height:28px}
.material-browser-sidebar :deep(.material-tree){flex:1;min-height:0;max-height:none;border:0;border-radius:0;padding:0 7px 10px}
.material-preview{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--paper)}
.material-preview-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex:none;padding:12px 16px;border-bottom:1px solid var(--line)}
.material-preview-name{display:flex;align-items:center;gap:9px;min-width:0}.material-preview-name>svg{flex:none;color:var(--muted)}.material-preview-name>div{min-width:0}.material-preview-name strong{display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere}.material-preview-name span{display:block;margin-top:3px;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.material-preview-actions{display:flex;align-items:center;gap:9px;flex:none}.material-preview-actions>.text-action{font-size:12px;min-height:32px}
.material-preview-actions>.material-markdown-toggle{color:var(--muted);padding:0 6px;border-radius:5px}.material-markdown-toggle:hover{background:var(--field);color:var(--blue)}
.material-preview-state{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px 18px;text-align:center;color:var(--muted);font-size:13px}.material-preview-state>svg{color:#9ba7b9}.material-browser-empty{min-height:180px}
.material-image-preview{min-height:0;flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:20px;background-color:#f6f8fc;background-image:linear-gradient(45deg,#e9edf4 25%,transparent 25%),linear-gradient(-45deg,#e9edf4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e9edf4 75%),linear-gradient(-45deg,transparent 75%,#e9edf4 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;overscroll-behavior:contain}
.material-image-preview img{display:block;max-width:100%;max-height:100%;object-fit:contain;flex:none}.material-image-preview.original-size{display:block}.original-size img{max-width:none;max-height:none;margin:auto}
.material-text-preview{min-height:0;flex:1;overflow:auto;padding:20px;overscroll-behavior:contain}.material-text-preview pre{margin:0;font:12px/1.85 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;color:#37445b}.material-preview-limit{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media(max-width:850px){.material-browser-layout{grid-template-columns:minmax(200px,35%) minmax(0,1fr)}.material-preview-heading{padding:10px;flex-wrap:wrap}.material-preview-name{flex:1}.material-preview-actions{margin-left:auto}}
@media(max-width:620px){.material-browser-toolbar{padding:12px}.material-search{width:100%}.material-browser-layout{display:flex;flex-direction:column;height:auto;max-height:none;min-height:0}.material-browser-sidebar{max-height:250px;border-right:0;border-bottom:1px solid var(--line)}.material-browser-sidebar :deep(.material-tree){flex:auto}.material-preview{height:420px}.material-text-preview{padding:15px}}
</style>
