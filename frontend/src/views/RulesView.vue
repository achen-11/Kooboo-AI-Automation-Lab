<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { FileText, Pencil, Save, Check, Upload, ArrowLeft, LoaderCircle } from '@lucide/vue';
import { api, message } from '../api';
import type { RuleDraft, RuleSet } from '../../../backend/shared/types';

type PublishedRule = RuleSet & { hash: string };
const rules = ref<PublishedRule[]>([]), drafts = ref<RuleDraft[]>([]);
const selectedVersion = ref('visual-v1');
const rule = computed(() => rules.value.find((item) => item.version === selectedVersion.value) || rules.value[0] || null);
const editor = ref<RuleDraft | null>(null), saved = ref<RuleDraft | null>(null);
const busy = ref(false), error = ref(''), notice = ref('');
const dirty = computed(() => editor.value !== null && JSON.stringify(editor.value.rule) !== JSON.stringify(saved.value?.rule));
const totalWeight = computed(() => Math.round((editor.value?.rule.dimensions.reduce((sum, item) => sum + (Number(item.weight) || 0), 0) ?? 0) * 10000) / 10000);
const validWeights = computed(() => totalWeight.value === 100);
defineExpose({ dirty });

function edit(draft: RuleDraft): void {
  saved.value = JSON.parse(JSON.stringify(draft));
  editor.value = JSON.parse(JSON.stringify(draft));
  error.value = ''; notice.value = '';
}
function beforeUnload(event: BeforeUnloadEvent): void { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  try {
    const [published, pending] = await Promise.all([api<{ items: PublishedRule[] }>('/rules'), api<{ items: RuleDraft[] }>('/rule-drafts')]);
    rules.value = published.items; drafts.value = pending.items;
  } catch (reason) { error.value = message(reason); }
});
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload));
async function createDraft(): Promise<void> {
  if (!rule.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const draft = await api<RuleDraft>('/rule-drafts', { method: 'POST', body: JSON.stringify({ sourceVersion: rule.value.version }) });
    drafts.value.unshift(draft); edit(draft);
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
async function persist(): Promise<void> {
  if (!editor.value) return;
  const draft = await api<RuleDraft>(`/rule-drafts/${editor.value.id}`, { method: 'PUT', body: JSON.stringify({ revision: editor.value.revision, rule: editor.value.rule }) });
  drafts.value = drafts.value.map((item) => item.id === draft.id ? draft : item);
  edit(draft);
}
async function save(): Promise<void> {
  busy.value = true; error.value = ''; notice.value = '';
  try { await persist(); notice.value = '草稿已保存'; }
  catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
async function publish(): Promise<void> {
  if (!editor.value || !validWeights.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    if (dirty.value) await persist();
    const result = await api<{ rule: RuleSet; hash: string }>(`/rule-drafts/${editor.value!.id}/publish`, { method: 'POST', body: JSON.stringify({ revision: editor.value!.revision }) });
    drafts.value = drafts.value.filter((item) => item.id !== editor.value!.id);
    rules.value.push({ ...result.rule, hash: result.hash }); selectedVersion.value = result.rule.version;
    editor.value = null; saved.value = null;
    notice.value = `已发布 ${result.rule.version}，新任务可以选择此版本`;
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
async function reloadDraft(): Promise<void> {
  busy.value = true;
  try {
    const result = await api<{ items: RuleDraft[] }>('/rule-drafts'); drafts.value = result.items;
    const draft = result.items.find((item) => item.id === editor.value?.id);
    if (draft) edit(draft);
    else { editor.value = null; saved.value = null; const published = await api<{ items: PublishedRule[] }>('/rules'); rules.value = published.items; error.value = ''; }
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
</script>

<template>
  <header class="page-header">
    <div><h1>{{ editor ? '编辑评分规则' : '评分规则' }}</h1><p>{{ editor ? '保存草稿，发布后供新任务选择' : '维护评分维度、评分指引和采集范围' }}</p></div>
    <div v-if="!editor" class="toolbar-actions">
      <select v-model="selectedVersion" class="input compact-select" :disabled="busy" aria-label="查看规则版本"><option v-for="item in rules" :key="item.version" :value="item.version">{{ item.version }}</option></select>
      <button class="button primary" :disabled="busy || !rule" @click="createDraft()"><LoaderCircle v-if="busy" class="spin" :size="17" /><Pencil v-else :size="17" />编辑新版本</button>
    </div>
    <button v-else class="button secondary" :disabled="busy || dirty" @click="editor = null; saved = null; error = ''; notice = ''"><ArrowLeft :size="17" />返回已发布</button>
  </header>
  <div v-if="error" class="alert error" role="alert"><span>{{ error }}</span><button v-if="editor" class="button small secondary" :disabled="busy" @click="reloadDraft()">重新载入草稿</button></div>
  <p v-if="notice" class="alert success" role="status"><Check :size="17" />{{ notice }}</p>

  <form v-if="editor" @submit.prevent="save()">
    <fieldset class="rule-editor" :disabled="busy">
      <section class="panel settings-panel">
        <div class="section-heading"><h2>版本信息</h2><span class="badge muted">{{ dirty ? '有未保存修改' : '草稿' }}</span></div>
        <div class="form-grid">
          <label class="field"><span>版本号</span><input v-model="editor.rule.version" class="input" pattern="[a-z][a-z0-9-]{0,79}" maxlength="80" required /><p>使用小写字母、数字和连字符；已发布版本不可覆盖</p></label>
          <label class="field"><span>规则名称</span><input v-model="editor.rule.name" class="input" maxlength="200" required /></label>
        </div>
      </section>
      <section class="panel settings-panel">
        <div class="section-heading"><h2>评分维度</h2><strong :class="{ 'warning-text': !validWeights }">权重合计 {{ totalWeight }}%</strong></div>
        <div v-for="dimension in editor.rule.dimensions" :key="dimension.id" class="dimension-editor">
          <div class="form-grid">
            <label class="field"><span>维度名称 <small>{{ dimension.id }}</small></span><input v-model="dimension.label" class="input" maxlength="200" required /></label>
            <label class="field"><span>权重 %</span><input v-model.number="dimension.weight" class="input" type="number" min="0" max="100" step="any" required /></label>
            <label class="field full-width"><span>评分标准</span><textarea v-model="dimension.instruction" class="input textarea" maxlength="8000" required /></label>
          </div>
        </div>
        <p class="section-note">五个维度的标识固定。权重合计 100% 后可发布；未配平时可先保存草稿。</p>
      </section>
      <section class="panel settings-panel">
        <h2>评分指引</h2>
        <label class="field"><span class="sr-only">模型评分指引</span><textarea v-model="editor.rule.prompt" class="input textarea prompt-editor" maxlength="60000" required /></label>
        <p class="section-note">可修改评分判断与扣分要求。请保留 JSON 输出格式、维度标识与证据引用约定。</p>
      </section>
      <section class="panel settings-panel">
        <details class="capture-editor"><summary>采集设置</summary>
          <div v-for="viewport in editor.rule.viewports" :key="viewport.id" class="capture-fields">
            <h3>{{ viewport.id === 'desktop' ? '桌面视口' : '移动视口' }}</h3>
            <div class="form-grid">
              <label class="field"><span>宽度 px</span><input v-model.number="viewport.width" class="input" type="number" min="320" max="3840" step="1" required /></label>
              <label class="field"><span>高度 px</span><input v-model.number="viewport.height" class="input" type="number" min="320" max="2500" step="1" required /></label>
            </div>
          </div>
          <div class="form-grid capture-fields">
            <label class="field"><span>采集策略版本</span><input v-model="editor.rule.capture.version" class="input" maxlength="80" required /></label>
            <label class="field"><span>最大采集高度 px</span><input v-model.number="editor.rule.capture.maxHeight" class="input" type="number" min="900" max="20000" step="1" required /></label>
            <label class="field"><span>页面超时 ms</span><input v-model.number="editor.rule.capture.timeoutMs" class="input" type="number" min="1000" max="60000" step="1" required /></label>
            <label class="field"><span>采样区域数量</span><select v-model.number="editor.rule.capture.regions" class="input"><option :value="1">顶部</option><option :value="2">顶部、中部</option><option :value="3">顶部、中部、底部</option></select></label>
          </div>
        </details>
      </section>
      <div class="rule-actions">
        <button v-if="dirty" type="button" class="text-button" @click="saved && edit(saved)">还原未保存修改</button>
        <span v-else class="section-note">历史报告保留原规则</span>
        <div class="toolbar-actions"><button class="button secondary" :disabled="!dirty"><Save :size="17" />保存草稿</button><button type="button" class="button primary" :disabled="!validWeights" @click="publish()"><LoaderCircle v-if="busy" class="spin" :size="17" /><Upload v-else :size="17" />发布新版本</button></div>
      </div>
    </fieldset>
  </form>

  <template v-else>
    <section v-if="drafts.length" class="panel settings-panel">
      <h2>草稿</h2>
      <div v-for="draft in drafts" :key="draft.id" class="draft-row"><div><strong>{{ draft.rule.name }}</strong><span>{{ draft.rule.version }}</span></div><button class="button small secondary" :disabled="busy" @click="edit(draft)">继续编辑</button></div>
    </section>
    <template v-if="rule">
      <section class="panel rules-panel"><div class="section-heading"><h2>{{ rule.name }}</h2><span class="badge muted">待校准</span></div><div class="dimension-list"><div v-for="dimension in rule.dimensions" :key="dimension.id" class="dimension-row"><div><h3>{{ dimension.label }}</h3><p>{{ dimension.instruction }}</p></div><div class="weight-track"><i :style="{ width: `${dimension.weight}%` }" /></div><strong>{{ dimension.weight }}<small>%</small></strong></div></div><p class="section-note">各分项按 0–100 分评估，再按权重汇总。没有可用视觉参考时，还原度为“不可评估”。</p></section>
      <section class="panel settings-panel"><h2>证据与版本</h2><div class="form-grid"><div class="field"><span>评测视口</span><div class="readonly-value">{{ rule.viewports.map((item) => `${item.width} × ${item.height}`).join(' / ') }}</div></div><div class="field"><span>采集策略</span><div class="readonly-value">首页 · {{ rule.capture.regions }} 个区域 · {{ rule.capture.version }}</div></div></div><p class="section-note">修改后发布新版本，历史结果与人工复核记录保留。低分筛选阈值在“系统设置 → 运行设置”维护。</p><details class="rule-prompt"><summary><FileText :size="17" />查看评分指引</summary><pre>{{ rule.prompt }}</pre></details><p class="hash-label">版本指纹 {{ rule.hash.slice(0, 24) }}</p></section>
    </template>
  </template>
</template>
