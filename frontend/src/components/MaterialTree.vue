<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown, ChevronRight, Folder, FolderOpen, File, FileText, Image, X } from '@lucide/vue';
import { materialFormat, materialNodes, visibleMaterialNodes, type MaterialTreeFile } from '../lib/material-browser';

const props = defineProps<{ files: MaterialTreeFile[]; removable?: boolean; disabled?: boolean; selectable?: boolean; selected?: string; query?: string }>();
const emit = defineEmits<{ remove: [name: string]; select: [name: string] }>();
const nodes = computed(() => materialNodes(props.files));
const expanded = ref(new Set<string>());
const rows = computed(() => visibleMaterialNodes(nodes.value, expanded.value, props.query));
watch(() => nodes.value.filter(node => node.folder && node.depth === 0).map(node => node.key), (keys, previous = []) => {
  for (const key of keys) if (!previous.includes(key)) expanded.value.add(key);
}, { immediate: true });
watch(() => props.selected, name => {
  const parts = name?.split('/') || [];
  for (let i = 1; i < parts.length; i++) expanded.value.add(parts.slice(0, i).join('/'));
}, { immediate: true });
function toggle(key: string) { if (expanded.value.has(key)) expanded.value.delete(key); else expanded.value.add(key); }
function fileIcon(file: MaterialTreeFile) { const kind = materialFormat(file).kind; return kind === 'image' ? Image : kind === 'text' ? FileText : File; }
function expandAll() { expanded.value = new Set(nodes.value.filter(node => node.folder).map(node => node.key)); }
function collapseAll() { expanded.value = new Set(); }
defineExpose({ expandAll, collapseAll });
</script>

<template>
  <div class="material-tree" role="list" :aria-label="selectable ? '资料目录' : '附件列表'">
    <div v-for="row in rows" :key="row.key" class="material-tree-row" :class="{ 'is-selected': !row.folder && selected === row.key }" role="listitem">
      <button v-if="row.folder" type="button" class="material-tree-entry material-folder" :style="{ paddingLeft: `${10 + row.depth * 16}px` }" :title="row.key" :aria-label="`${row.key}，${row.count} 个文件`" :aria-expanded="!!query?.trim() || expanded.has(row.key)" :disabled="!!query?.trim()" @click="toggle(row.key)">
        <ChevronDown v-if="query?.trim() || expanded.has(row.key)" :size="13" aria-hidden="true" /><ChevronRight v-else :size="13" aria-hidden="true" />
        <FolderOpen v-if="query?.trim() || expanded.has(row.key)" :size="16" aria-hidden="true" /><Folder v-else :size="16" aria-hidden="true" />
        <span>{{ row.name }}</span><small>{{ row.count }}</small>
      </button>
      <component :is="selectable ? 'button' : 'div'" v-else class="material-tree-entry material-file" :type="selectable ? 'button' : undefined" :aria-pressed="selectable ? selected === row.key : undefined" :style="{ paddingLeft: `${30 + row.depth * 16}px` }" :title="row.key" @click="selectable && emit('select', row.key)">
        <component :is="fileIcon(row.file!)" :size="15" aria-hidden="true" /><span>{{ row.name }}</span>
      </component>
      <button v-if="removable && !row.folder" type="button" class="icon-button material-remove" :aria-label="`移除 ${row.key}`" :disabled="disabled" @click="emit('remove', row.key)"><X :size="14" /></button>
    </div>
    <p v-if="!rows.length" class="material-tree-empty">{{ query?.trim() ? '没有匹配的文件' : '暂无文件' }}</p>
  </div>
</template>

<style scoped>
.material-tree{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:5px;overscroll-behavior:contain}
.material-tree-row{display:flex;align-items:center;border-radius:6px;min-width:0}
.material-tree-entry{display:flex;align-items:center;gap:7px;min-width:0;min-height:34px;flex:1;padding:5px 9px;font-size:12px;line-height:1.5;text-align:left;border-radius:6px}
button.material-tree-entry:hover:not(:disabled){background:#edf1f8}.material-folder:disabled{cursor:default}
.material-tree-entry>svg{flex:none;color:#7c899c}
.material-folder{font-weight:500}.material-folder>svg:nth-child(2){color:#9a8353}
.material-tree-entry>span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.material-tree-entry>small{flex:none;color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums;padding-left:4px}
.material-tree-row.is-selected{background:#eaf0ff;color:#365fbf}.is-selected .material-file>svg{color:#5079ed}.is-selected button.material-tree-entry:hover{background:#e2eaff}
.material-remove{width:26px;height:26px;margin-right:3px;flex:none}
.material-tree-empty{padding:22px 10px;text-align:center;color:var(--muted);font-size:12px}
</style>
