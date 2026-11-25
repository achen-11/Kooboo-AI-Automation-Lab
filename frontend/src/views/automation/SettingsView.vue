<script setup lang="ts">
import { notify } from '../../lib/notifications';
import { openUpdatePanel } from '../../lib/updates';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Save, Copy, LoaderCircle, Eye, EyeOff } from '@lucide/vue';
import Disclosure from '../../components/Disclosure.vue';
import CompletenessSettings from '../../components/CompletenessSettings.vue';
import LearningSettings from '../../components/LearningSettings.vue';
import BillingSettings from '../../components/BillingSettings.vue';
import BaseSelect from '../../components/BaseSelect.vue';
import EnvironmentSettings from '../SettingsView.vue';
import { api, message, platform } from '../../api';
import { workspace, refresh } from './common';
import { activeScenarios, defaultAutomationSettings, defaultOptimizationPolicy, scenarios, type AutomationSettings } from '../../../../shared/automation';
import { defaultLearningSettings } from '../../../../shared/experience';
import type { HarnessCatalog, HarnessSettingBinding, HarnessSopKey } from '../../../../shared/harness';
import type { PublicSettings } from '../../../../shared/types';

const form = ref<AutomationSettings>(structuredClone(defaultAutomationSettings));
const error = ref(''), busy = ref(false), resetBusy = ref(false), saved = ref('');
const harnessBindings = ref<HarnessSettingBinding[]>([]);
const bindingByKey = computed(() => {
  const map = new Map<HarnessSopKey, HarnessSettingBinding>();
  for (const item of harnessBindings.value) map.set(item.key, item);
  return map;
});
const settingsTabs = [
  { id: 'runtime', label: '任务执行' },
  { id: 'environment', label: 'Kooboo 连接' },
  { id: 'model', label: '评测模型' },
  { id: 'followup', label: 'AI 跟进' },
  { id: 'learning', label: '经验学习' },
  { id: 'completeness', label: '全站交付' },
  { id: 'billing', label: '费用' },
  { id: 'prompts', label: '场景提示词' },
  { id: 'api', label: '外部 API' },
] as const;
const SETTINGS_TAB_STORAGE_KEY = 'automation-settings-tab';
const storedTab = typeof window !== 'undefined' ? window.sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY) : '';
const initialTab = settingsTabs.some(item => item.id === storedTab) ? storedTab! : 'runtime';
const tab = ref(initialTab), scenario = ref<keyof typeof scenarios>('materials');
const environmentEditor = ref<{ dirty: boolean }>();
const reveal = ref<Record<string, boolean>>({});
const evaluationModel = ref({ name: '', endpoint: '', apiKey: '' });
const savedModel = ref('');
const modelFields = () => ({ name: evaluationModel.value.name, endpoint: evaluationModel.value.endpoint });
const modelDirty = computed(() => Boolean(evaluationModel.value.apiKey) || savedModel.value !== JSON.stringify(modelFields()));
const settingsDirty = computed(() => saved.value !== JSON.stringify(form.value));
const isAutomationFormTab = computed(() => ['runtime', 'prompts', 'followup', 'learning', 'completeness'].includes(tab.value));
const dirty = computed(() => settingsDirty.value || modelDirty.value || Boolean(environmentEditor.value?.dirty));
defineExpose({ dirty });
const modelTesting = ref(false);

function selectTab(nextTab: string): void {
  if (nextTab === tab.value) return;
  if (tab.value === 'environment' && environmentEditor.value?.dirty && !window.confirm('Kooboo 连接页有未保存的修改，切换标签页后将丢失，确定继续？')) return;
  if (tab.value === 'model' && modelDirty.value && !window.confirm('评测模型有未保存的修改，切换标签页后将丢失，确定继续？')) return;
  tab.value = nextTab;
  try { window.sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, nextTab); } catch { /* ignore storage quota */ }
}

const apiExample = `GET ${window.location.origin}/api/v1/automation/reports?externalSource=your-admin&externalId=your-record\nAuthorization: Bearer <报告读取令牌>`;
const importRequestExample = `POST ${window.location.origin}/api/v1/resources/import\nAuthorization: Bearer <资源导入令牌>\nContent-Type: application/json`;
const importExample = JSON.stringify([{ name: '资源名称', scenario: 'upgrade', description: '资料说明', contentUrl: 'https://example.com', referenceUrl: 'https://ref.example.com', externalSource: 'your-admin', externalId: 'record-001', siteName: 'salon', subDomain: 'salon_public', rootDomain: '-shawnchen-hk.kooboo.io', skipSourceTransfer: false, files: [] }], null, 2);

async function loadHarnessBindings() {
  try {
    const catalog = await api<HarnessCatalog>('/automation/harness');
    harnessBindings.value = catalog.bindings || [];
  } catch { /* non-blocking if backend has not reloaded */ }
}

function normalizeResponsesEndpoint(raw: string) {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.deepseek.com/responses';
  return trimmed.replace(/\/chat\/completions$/, '/responses');
}

async function load() {
  await refresh();
  if (workspace.error) throw new Error(workspace.error);
  form.value = JSON.parse(JSON.stringify(workspace.settings));form.value.showExecutionBrowser??=false;form.value.optimization={...defaultOptimizationPolicy,...form.value.optimization};form.value.learning={...defaultLearningSettings,...form.value.learning};
  saved.value = JSON.stringify(form.value);
  const endpoint = form.value.evaluationEndpoint || platform.settings?.model.endpoint || 'https://api.deepseek.com/responses';
  evaluationModel.value = {
    name: form.value.evaluationModel || 'deepseek-flash',
    endpoint: normalizeResponsesEndpoint(endpoint),
    apiKey: '',
  };
  savedModel.value = JSON.stringify(modelFields());
  void loadHarnessBindings();
}
function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
  if (document.querySelector('dialog[open]')) return;
  if (isAutomationFormTab.value && settingsDirty.value && !busy.value) {
    event.preventDefault();
    void save();
  } else if (tab.value === 'model' && modelDirty.value && !busy.value && !modelTesting.value && saved.value) {
    event.preventDefault();
    void saveModel();
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void load().catch(reason => { error.value = message(reason); });
});
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); });

function discardFormChanges(): void {
  if (!saved.value) return;
  form.value = JSON.parse(saved.value) as AutomationSettings;
  error.value = '';
  notify.info('已放弃未保存的修改');
}

async function save() {
  busy.value = true; error.value = '';
  try {
    form.value = await api<AutomationSettings>('/automation/settings', { method: 'PUT', body: JSON.stringify(form.value) });
    saved.value = JSON.stringify(form.value);
    await refresh();
    await loadHarnessBindings();
    notify.success('设置已保存');
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}

async function resetSop(key: Exclude<HarnessSopKey, 'delivery.sop'>) {
  resetBusy.value = true; error.value = '';
  try {
    const result = await api<{ settings: AutomationSettings; bindings: HarnessSettingBinding[] }>('/automation/harness/reset', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    harnessBindings.value = result.bindings;
    if (key === 'followup.sop') form.value.followup.sop = result.settings.followup.sop;
    else if (key === 'optimization.sop' && form.value.optimization && result.settings.optimization) form.value.optimization.sop = result.settings.optimization.sop;
    else if (key === 'completeness.sop' && form.value.completeness && result.settings.completeness) form.value.completeness.sop = result.settings.completeness.sop;
    else if (key === 'learning.selectionSop' && form.value.learning && result.settings.learning) form.value.learning.selectionSop = result.settings.learning.selectionSop;
    else if (key === 'learning.reflectionSop' && form.value.learning && result.settings.learning) form.value.learning.reflectionSop = result.settings.learning.reflectionSop;
    await refresh();
    saved.value = JSON.stringify(form.value);
    notify.success('已恢复为新版内置规则');
  } catch (reason) { error.value = message(reason); }
  finally { resetBusy.value = false; }
}

async function saveModel() {
  busy.value = true; error.value = '';
  const input = {
    name: evaluationModel.value.name.trim() || 'deepseek-flash',
    endpoint: normalizeResponsesEndpoint(evaluationModel.value.endpoint),
    apiKey: evaluationModel.value.apiKey,
  };
  let keySaved = false;
  try {
    const legacyModelEndpoint = !platform.settings?.model.endpoint || /\/chat\/completions\/?$/.test(platform.settings.model.endpoint);
    if (input.apiKey || legacyModelEndpoint) {
      const current = await api<PublicSettings>('/settings');
      platform.settings = await api<PublicSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          threshold: current.threshold, paused: current.paused, execution: current.execution,
          model: { endpoint: input.endpoint, name: input.name, apiKey: input.apiKey || '' },
          environments: current.environments.map(env => ({ ...env, token: '' })),
        }),
      });
      evaluationModel.value.apiKey = '';
      if (input.apiKey) keySaved = true;
    }
    const current = await api<AutomationSettings>('/automation/settings');
    const result = await api<AutomationSettings>('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...current, evaluationModel: input.name, evaluationEndpoint: input.endpoint }),
    });
    workspace.settings = result;
    form.value.evaluationModel = result.evaluationModel;
    form.value.evaluationEndpoint = result.evaluationEndpoint;
    evaluationModel.value.name = result.evaluationModel;
    evaluationModel.value.endpoint = normalizeResponsesEndpoint(result.evaluationEndpoint);
    const baseline = JSON.parse(saved.value) as AutomationSettings;
    baseline.evaluationModel = result.evaluationModel;
    baseline.evaluationEndpoint = result.evaluationEndpoint;
    saved.value = JSON.stringify(baseline);
    savedModel.value = JSON.stringify(modelFields());
    notify.success('评测模型已保存');
  } catch (reason) {
    error.value = (keySaved ? 'API Key 已保存，模型配置保存失败：' : '') + message(reason);
  } finally { busy.value = false; }
}

async function testModel() {
  modelTesting.value = true; error.value = '';
  try {
    const result = await api<{ model: string; latencyMs: number }>('/automation/model/test', { method: 'POST' });
    notify.success(`图片识别与工具读取通过 · ${result.model} · ${(result.latencyMs / 1000).toFixed(1)} 秒`);
  } catch (reason) { error.value = message(reason); }
  finally { modelTesting.value = false; }
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); notify.success('已复制'); }
  catch { error.value = '无法访问剪贴板，请手动选择复制'; }
}
</script>

<template><header class="page-header"><div><h1>系统设置</h1></div><div class="settings-header-actions"><button class="button secondary" @click="openUpdatePanel">检查更新</button><button v-if="isAutomationFormTab" class="button primary" :disabled="busy||!settingsDirty" @click="save"><LoaderCircle v-if="busy" class="spin" :size="16" /><Save v-else :size="16" />保存设置</button></div></header><div class="segmented view-tabs"><button v-for="item in settingsTabs" :key="item.id" :class="{selected:tab===item.id}" @click="selectTab(item.id)">{{item.label}}</button></div><p v-if="error" class="alert error" role="alert">{{error}}</p>
<form v-if="tab==='runtime'" @submit.prevent="save"><section class="panel settings-panel"><h2>自动执行队列</h2><div class="choice-grid"><label class="choice-card" :class="{chosen:form.enabled}"><input v-model="form.enabled" type="radio" :value="true" /><span><strong>持续执行</strong><small>服务自动补入排队任务</small></span></label><label class="choice-card" :class="{chosen:!form.enabled}"><input v-model="form.enabled" type="radio" :value="false" /><span><strong>暂停队列</strong><small>已开始的任务继续，保留排队任务</small></span></label></div><div class="form-grid three-columns"><label class="field"><span>生成并发数</span><input v-model.number="form.generationConcurrency" class="input" type="number" min="1" max="10" required /></label><label class="field"><span>评测并发数</span><input v-model.number="form.evaluationConcurrency" class="input" type="number" min="1" max="5" required /></label><label class="field"><span>单任务时限（分钟）</span><input v-model.number="form.timeoutMinutes" class="input" type="number" min="1" max="240" required /></label></div></section><section class="panel settings-panel"><h2>后置流程开关</h2><div class="settings-stack"><label class="check-label"><input v-model="form.autoEvaluate" type="checkbox" />生成完成后自动创建独立评测任务</label><p class="text-muted small-text">关闭后新建任务默认“仅生成（不评测）”，不再默认开启自动优化；可直接查看生成站或直接跨环境交付，仍可随时在单任务手动发起评测。</p><template v-if="form.learning"><label class="check-label"><input v-model="form.learning.collect" type="checkbox" />沉淀经验（任务结束后自动及手动复盘）</label><p class="text-muted small-text">关闭后停止任务结束后的经验复盘与沉淀调度，避免额外复盘 token 消耗；详细预算与 SOP 可在「经验学习」标签页配置。</p><label class="check-label"><input v-model="form.learning.use" type="checkbox" />在生成 / 跟进 / 评测阶段使用经验库</label><p class="text-muted small-text">关闭后不调用模型筛选或注入历史经验。</p></template></div></section><section class="panel settings-panel"><h2>本机运行</h2><div class="resource-meta"><div><span>API 与队列服务</span><p>{{platform.online?'已连接':'未连接'}}</p></div><div><span>浏览器运行环境</span><p>{{platform.browserReady?'已安装':'待安装'}}</p></div><div><span>任务数据</span><p>SQLite 持久化</p></div></div><p class="text-muted">生成执行由服务保持 Kooboo AI Chat 页面运行；关闭管理页面不影响队列。执行异常会交给内置 AI 查证和跟进；确实无法继续时提供中断原因和下一步。</p><Disclosure label="高级设置"><label class="check-label"><input v-model="form.showExecutionBrowser" type="checkbox" />显示执行浏览器窗口</label><p class="text-muted">用于生成和 AI 跟进排障，仅影响新启动的执行会话。</p></Disclosure></section></form>
<section v-if="tab==='runtime'&&form.optimization" class="panel settings-panel"><h2>站点自动优化默认值</h2><div class="form-grid three-columns"><label class="field"><span>双端目标分数</span><input v-model.number="form.optimization.targetScore" class="input" type="number" min="1" max="100" required /></label><label class="field"><span>最多修复轮数</span><input v-model.number="form.optimization.maxRounds" class="input" type="number" min="1" max="10" required /></label><label class="field"><span>费用上限（元，可选）</span><input :value="form.optimization.maxCostCny??''" class="input" type="number" min="0.0001" step="any" placeholder="不设置" @input="form.optimization.maxCostCny=($event.target as HTMLInputElement).value===''?null:Number(($event.target as HTMLInputElement).value)" /></label></div><Disclosure label="优化 Skill / SOP"><div v-if="bindingByKey.get('optimization.sop')" class="harness-sop-bar"><span class="status-badge" :class="bindingByKey.get('optimization.sop')?.customized ? 'pending' : 'completed'">{{ bindingByKey.get('optimization.sop')?.customized ? '当前使用自定义规则' : bindingByKey.get('optimization.sop')?.migratedLegacy ? '已自动同步至新版内置' : '使用新版内置 Harness' }}</span><div class="harness-sop-actions"><a class="text-action" href="#/harness">查看 AI 蓝图</a><button v-if="bindingByKey.get('optimization.sop')?.customized" type="button" class="text-action" :disabled="resetBusy" @click="resetSop('optimization.sop')">恢复为新版内置</button></div></div><textarea v-model="form.optimization.sop" class="input code-editor" rows="12" /></Disclosure><p class="text-muted">仅用于明确开启自动优化的新任务。费用上限在模型阶段之间检查；已开始的调用可能继续产生费用。</p></section>
<section v-if="tab==='followup'" class="panel settings-panel"><h2>流程跟进 Agent</h2><label class="check-label"><input v-model="form.followup.enabled" type="checkbox" />自动处理准备、生成、交接和评测中的异常</label><div class="form-grid"><label class="field"><span>跟进并发数</span><input v-model.number="form.followup.concurrency" class="input" type="number" min="1" max="3" /></label><label class="field"><span>最多跟进次数</span><input v-model.number="form.followup.maxAttempts" class="input" type="number" min="1" max="20" /></label><label class="field"><span>跟进累计执行时限（分钟）</span><input v-model.number="form.followup.maxMinutes" class="input" type="number" min="1" max="120" /></label><label class="field"><span>跟进累计 token 预算</span><input v-model.number="form.followup.maxTokens" class="input" type="number" min="1000" max="1000000000" /></label><label class="field"><span>最多模型请求次数</span><input v-model.number="form.followup.maxRequests" class="input" type="number" min="1" max="1000" /></label></div><div class="field"><span>跟进 Skill / SOP</span><div v-if="bindingByKey.get('followup.sop')" class="harness-sop-bar"><span class="status-badge" :class="bindingByKey.get('followup.sop')?.customized ? 'pending' : 'completed'">{{ bindingByKey.get('followup.sop')?.customized ? '当前使用自定义规则' : bindingByKey.get('followup.sop')?.migratedLegacy ? '已自动同步至新版内置' : '使用新版内置 Harness' }}</span><div class="harness-sop-actions"><a class="text-action" href="#/harness">查看 AI 蓝图</a><button v-if="bindingByKey.get('followup.sop')?.customized" type="button" class="text-action" :disabled="resetBusy" @click="resetSop('followup.sop')">恢复为新版内置</button></div></div><textarea v-model="form.followup.sop" class="input code-editor" rows="18" /></div><p class="text-muted">使用已配置的评测模型，以独立 Codex 会话跟进。仅累计跟进 Agent 实际执行的时间，排队、定时等待、Kooboo 生成和独立评测均不计入。首次介入时固定本任务的 SOP 与预算；修改用于后续任务，点击恢复会采用新设置，但不清零累计用量、次数或活动时间。每次上游调用前检查额度并限制输出；未知用量保留预占。预占是接入估算，不能保证第三方计费 token 绝对不超额。系统保留每次决策和工具结果。</p></section>
<CompletenessSettings v-if="tab==='completeness'&&form.completeness" v-model="form.completeness" :binding="bindingByKey.get('completeness.sop')" :reset-busy="resetBusy" @reset="resetSop('completeness.sop')" />
<LearningSettings v-if="tab==='learning'&&form.learning" v-model="form.learning" :selection-binding="bindingByKey.get('learning.selectionSop')" :reflection-binding="bindingByKey.get('learning.reflectionSop')" :reset-busy="resetBusy" @reset="resetSop($event)" />
<BillingSettings v-if="tab==='billing'"/>
<div v-if="tab==='environment'" class="embedded-settings"><EnvironmentSettings ref="environmentEditor" :environments-only="true" /></div>
<form v-if="tab==='model'" class="panel settings-panel settings-stack" @submit.prevent="saveModel">
  <h2>评测模型</h2>
  <div class="form-grid">
    <label class="field"><span>模型名称</span><input v-model="evaluationModel.name" class="input" required :disabled="busy||modelTesting||!saved" /></label>
    <label class="field"><span>API 地址</span><input v-model="evaluationModel.endpoint" class="input" type="url" placeholder="https://api.deepseek.com/responses" required :disabled="busy||modelTesting||!saved" /></label>
  </div>
  <div class="field">
    <span>API Key <small>{{platform.settings?.model.hasApiKey?'已保存，留空保留':'尚未配置'}}</small></span>
    <div class="input-with-action">
      <input v-model="evaluationModel.apiKey" aria-label="评测模型 API Key" :type="reveal.evalModel ? 'text' : 'password'" autocomplete="new-password" :placeholder="platform.settings?.model.hasApiKey ? '输入新密钥可替换当前密钥' : '填写模型服务 API Key'" :disabled="busy||modelTesting||!saved" />
      <button type="button" class="icon-button" :aria-label="reveal.evalModel ? '隐藏密钥' : '显示密钥'" @click="reveal.evalModel = !reveal.evalModel"><EyeOff v-if="reveal.evalModel" :size="18" /><Eye v-else :size="18" /></button>
    </div>
  </div>
  <div class="model-actions">
    <button class="button primary" :disabled="busy||modelTesting||!saved||!modelDirty"><LoaderCircle v-if="busy" class="spin" :size="16" /><Save v-else :size="16" />保存</button>
    <button type="button" class="button secondary" :disabled="busy||modelTesting||!saved||modelDirty" :title="modelDirty?'请先保存修改':'验证图片识别与工具调用'" @click="testModel"><LoaderCircle v-if="modelTesting" class="spin" :size="16" />{{modelTesting?'测试中…':'测试图片与工具'}}</button>
  </div>
</form>
<section v-if="tab==='prompts'" class="panel settings-panel"><label class="field"><span>场景</span><BaseSelect v-model="scenario" :options="Object.entries(activeScenarios).map(([key, label]) => ({ value: key, label: (label) }))" /></label><label class="field"><span>委托提示词</span><textarea v-model="form.prompts[scenario]" class="input code-editor" rows="18" /></label><p class="text-muted">与资料、范围及补充要求组合为一段完整消息，复用 Kooboo 已有的 skill、reference 和 tools。</p></section>
<template v-if="tab==='api'">
  <section class="panel settings-panel"><div class="section-heading"><h2>报告读取</h2><button class="icon-button" aria-label="复制读取示例" @click="copy(apiExample)"><Copy :size="17" /></button></div><pre class="resource-description">{{apiExample}}</pre><label class="field"><span>报告读取令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.readToken" :type="reveal.readToken ? 'text' : 'password'" readonly /><button type="button" class="icon-button" :aria-label="reveal.readToken ? '隐藏报告令牌' : '显示报告令牌'" @click="reveal.readToken = !reveal.readToken"><EyeOff v-if="reveal.readToken" :size="17" /><Eye v-else :size="17" /></button><button type="button" class="icon-button" aria-label="复制报告令牌" @click="copy(platform.settings?.credentials.readToken||'')"><Copy :size="17" /></button></div></label><p>待跟进任务：<code>GET /api/v1/automation/tasks?status=pending</code></p><p>报告详情：<code>GET /api/v1/automation/reports/:id</code></p><p>证据文件：<code>GET /api/v1/automation/reports/:id/artifacts/:file</code></p><p class="text-muted">按 externalSource + externalId 关联多个生成站和多轮评测。报告尚未生成时保留状态，report 为 null。读取令牌没有创建或跟进权限。</p></section>
  <section class="panel settings-panel">
    <div class="section-heading"><h2>外部 Admin 资源导入</h2><button class="icon-button" aria-label="复制导入示例" @click="copy(importExample)"><Copy :size="17" /></button></div>
    <pre class="resource-description">{{importRequestExample}}</pre>
    <label class="field"><span>资源导入令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.ingestToken" :type="reveal.ingestToken ? 'text' : 'password'" readonly /><button type="button" class="icon-button" :aria-label="reveal.ingestToken ? '隐藏导入令牌' : '显示导入令牌'" @click="reveal.ingestToken = !reveal.ingestToken"><EyeOff v-if="reveal.ingestToken" :size="17" /><Eye v-else :size="17" /></button><button type="button" class="icon-button" aria-label="复制导入令牌" @click="copy(platform.settings?.credentials.ingestToken||'')"><Copy :size="17" /></button></div></label>
    <pre class="resource-description">{{importExample}}</pre>
    <div class="table-scroll"><table class="task-table"><thead><tr><th>可选字段</th><th>说明</th></tr></thead><tbody>
      <tr><td><code>siteName</code></td><td>站点名称。字母、数字或下划线，最多 63 个字符，保存为小写。</td></tr>
      <tr><td><code>subDomain</code></td><td>站点子域名。格式同站点名称，不能包含连字符（-）；仅指定名称或子域名时，另一项沿用它。</td></tr>
      <tr><td><code>rootDomain</code></td><td>建站根域名，不含协议、端口或路径。香港示例为 <code>-shawnchen-hk.kooboo.io</code>，也兼容省略前导 <code>-</code> 的写法。</td></tr>
      <tr><td><code>skipSourceTransfer</code></td><td>是否直接跳过原站克隆（布尔值，仅 <code>upgrade</code> 升级场景生效）。设为 <code>true</code> 时不抓取原站也不触发跨环境回退，直接用资料包建站；<strong>不传或设为 <code>false</code> 时</strong>，优先在当前环境及回退环境链（如 <code>DE → HK → XM</code>）尝试克隆，当链上所有环境均克隆失败（0 页）且附带资料包（<code>files</code> 非空）时，<strong>默认自动触发兜底</strong>（跳过原站克隆并改用资料包继续生成）。</td></tr>
      <tr><td><code>fallbackToMaterialsOnCloneFailure</code></td><td>所有环境克隆均返回 0 页时是否自动改用资料包继续生成（布尔值，仅 <code>upgrade</code> 场景且有附件时生效）。<strong>不传时只要 <code>files</code> 非空即默认开启（<code>true</code>）</strong>；仅在显式传 <code>false</code> 时关闭自动兜底并在全链克隆失败后停机止损。</td></tr>
    </tbody></table></div>
    <p class="text-muted">未指定时请省略字段，不传空字符串。根域名依次取创建任务时的选择、资源导入值、环境默认值；实际建站时检查所选环境是否支持。</p>
    <p class="text-muted">导入仅保存资源。资源详情和版本历史显示保存的输入值，可核对根域名是否带前导 <code>-</code>；任务“输入与配置 → 建站配置”显示实际采用的值。</p>
    <p class="text-muted">相同外部来源与记录标识更新输入版本，已入队任务保留原版本。首版 API 位于本机；其他机器访问需后续配置网络部署。</p>
  </section>
</template>
<div v-if="isAutomationFormTab && (settingsDirty || busy)" class="settings-sticky-bar" role="region" aria-label="未保存设置操作栏">
  <span class="sticky-dirty-state"><i />有未保存的设置修改（快捷键 ⌘S / Ctrl+S）</span>
  <div class="toolbar-actions">
    <button type="button" class="button secondary" :disabled="busy" @click="discardFormChanges()">放弃修改</button>
    <button type="button" class="button primary" :disabled="busy||!settingsDirty" @click="save"><LoaderCircle v-if="busy" class="spin" :size="16" /><Save v-else :size="16" />保存设置</button>
  </div>
</div>
</template>

<style scoped>
.settings-header-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.settings-stack{display:flex;flex-direction:column;gap:20px;}
.settings-stack>h2,.settings-stack>.text-muted{margin:0;}
.model-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}
.harness-sop-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.harness-sop-actions{display:flex;align-items:center;gap:12px}
.settings-sticky-bar{position:sticky;bottom:16px;z-index:15;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-top:18px;background:#fff;border:1px solid #dbe3f0;border-radius:14px;padding:13px 18px;box-shadow:0 10px 28px #18213114}
.sticky-dirty-state{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#36455e;font-weight:500}
.sticky-dirty-state i{width:7px;height:7px;border-radius:50%;background:var(--orange)}
</style>
