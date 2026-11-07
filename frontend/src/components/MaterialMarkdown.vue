<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { MaterialFile } from '../../../shared/automation';
import { sessionFetch } from '../api';
import { loadMaterialPreview } from '../lib/material-browser';
import { renderMaterialMarkdown } from '../lib/material-markdown';

const props = defineProps<{ source: string; path: string; files: MaterialFile[] }>();
const emit = defineEmits<{ select: [name: string] }>();
const root = ref<HTMLElement>();
const html = computed(() => renderMaterialMarkdown(props.source, props.path, props.files));
watch([() => props.source, () => props.path, () => props.files.map(file => `${file.id}:${file.name}:${file.sha256}`).join('|')], async (_, __, onCleanup) => {
  const controller = new AbortController(), urls: string[] = [], requests = new Map<string, Promise<string>>(), files = props.files;
  let observer: IntersectionObserver | undefined;
  onCleanup(() => { controller.abort(); observer?.disconnect(); for (const url of urls) URL.revokeObjectURL(url); });
  await nextTick();
  if (controller.signal.aborted || !root.value) return;
  async function load(image: HTMLImageElement) {
    observer?.unobserve(image);
    const id = image.dataset.materialImage, file = files.find(item => item.id === id);
    if (!file) return;
    try {
      let request = requests.get(file.id);
      if (!request) {
        request = loadMaterialPreview(file, sessionFetch, controller.signal).then(result => {
          controller.signal.throwIfAborted();
          if (result.kind !== 'image') throw new Error('图片格式不支持');
          const url = URL.createObjectURL(result.blob); urls.push(url); return url;
        });
        requests.set(file.id, request);
      }
      const url = await request;
      if (controller.signal.aborted) return;
      image.onerror = () => { image.alt = `${image.alt}（加载失败，点击单独查看）`; };
      image.src = url;
    } catch { if (!controller.signal.aborted) image.alt = `${image.alt}（加载失败，点击单独查看）`; }
  }
  const images = root.value.querySelectorAll<HTMLImageElement>('img[data-material-image]');
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) void load(entry.target as HTMLImageElement); }, { root: root.value.parentElement, rootMargin: '180px' });
    images.forEach(image => observer!.observe(image));
  } else images.forEach(image => void load(image));
}, { immediate: true, flush: 'post' });
function clicked(event: MouseEvent) {
  const anchor = (event.target as Element).closest('a');
  if (!anchor || !root.value?.contains(anchor)) return;
  if (anchor.hasAttribute('data-material-file')) {
    event.preventDefault();
    const file = props.files.find(item => item.id === anchor.dataset.materialFile);
    if (file) emit('select', file.name);
  } else if (anchor.hasAttribute('data-markdown-anchor')) {
    event.preventDefault();
    let id = anchor.dataset.markdownAnchor || '';
    try { id = decodeURIComponent(id); } catch { return; }
    Array.from(root.value.querySelectorAll<HTMLElement>('[id]')).find(element => element.id === id)?.scrollIntoView({ block: 'start' });
  }
}
</script>

<template><article ref="root" class="material-markdown" @click="clicked" v-html="html" /></template>

<style scoped>
.material-markdown{font-size:14px;line-height:1.8;color:#37445b;overflow-wrap:anywhere}
.material-markdown :deep(> :first-child){margin-top:0}.material-markdown :deep(> :last-child){margin-bottom:0}
.material-markdown :deep(h1),.material-markdown :deep(h2),.material-markdown :deep(h3),.material-markdown :deep(h4),.material-markdown :deep(h5),.material-markdown :deep(h6){color:var(--ink);line-height:1.45;font-weight:650;margin:1.4em 0 .65em;scroll-margin-top:16px}
.material-markdown :deep(h1){font-size:25px;padding-bottom:12px;border-bottom:1px solid var(--line)}.material-markdown :deep(h2){font-size:20px;padding-bottom:8px;border-bottom:1px solid var(--line)}.material-markdown :deep(h3){font-size:17px}.material-markdown :deep(h4),.material-markdown :deep(h5),.material-markdown :deep(h6){font-size:14px}
.material-markdown :deep(p){margin:0 0 14px}.material-markdown :deep(ul),.material-markdown :deep(ol){padding-left:1.6em;margin:0 0 14px}.material-markdown :deep(li){margin:4px 0}.material-markdown :deep(li>p){margin:4px 0}
.material-markdown :deep(blockquote){margin:16px 0;padding:3px 0 3px 15px;border-left:3px solid #d8e1f0;color:var(--muted)}.material-markdown :deep(blockquote>p:last-child){margin-bottom:0}
.material-markdown :deep(a){color:var(--blue);text-decoration:underline;text-underline-offset:3px}.material-markdown :deep(a:hover){color:#365fbf}
.material-markdown :deep(code){padding:2px 5px;border-radius:4px;background:#f0f3f8;font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}.material-markdown :deep(pre){max-width:100%;overflow:auto;margin:16px 0;padding:14px 16px;background:#f4f6fa;border:1px solid var(--line);border-radius:8px;white-space:pre;overflow-wrap:normal;tab-size:2}.material-markdown :deep(pre code){padding:0;background:transparent}
.material-markdown :deep(table){display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:16px 0;font-size:13px}.material-markdown :deep(th),.material-markdown :deep(td){padding:8px 12px;border:1px solid var(--line);text-align:left}.material-markdown :deep(th){background:#f4f6fa;font-weight:600}
.material-markdown :deep(hr){height:1px;margin:24px 0;background:var(--line);border:0}.material-markdown :deep(.markdown-image-link){display:block;margin:16px 0;max-width:100%;width:fit-content}.material-markdown :deep(img){display:block;max-width:100%;height:auto;min-height:28px;border-radius:6px}.material-markdown :deep(.markdown-missing-link){color:var(--muted)}
</style>
