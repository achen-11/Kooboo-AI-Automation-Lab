<script setup lang="ts">
import { notify } from '../../lib/notifications';
import { computed, onMounted, ref } from 'vue';
import { Save, Copy, LoaderCircle, ExternalLink } from '@lucide/vue';
import BillingSettings from '../../components/BillingSettings.vue';
import BaseSelect from '../../components/BaseSelect.vue';
import EnvironmentSettings from '../SettingsView.vue';
import { api, message, platform } from '../../api';
import { workspace, refresh } from './common';
import { defaultAutomationSettings, scenarios, type AutomationSettings } from '../../../../shared/automation';
import type { PublicSettings } from '../../../../shared/types';

const form = ref<AutomationSettings>(structuredClone(defaultAutomationSettings));
const error = ref(''), busy = ref(false), saved = ref('');
const tab = ref('runtime'), scenario = ref<keyof typeof scenarios>('materials');
const evaluationModel = ref({ name: '', endpoint: '', apiKey: '' });
const savedModel = ref('');
const modelFields = () => ({ name: evaluationModel.value.name, endpoint: evaluationModel.value.endpoint });
const modelDirty = computed(() => Boolean(evaluationModel.value.apiKey) || savedModel.value !== JSON.stringify(modelFields()));
const settingsDirty = computed(() => saved.value !== JSON.stringify(form.value));
const dirty = computed(() => settingsDirty.value || modelDirty.value);
defineExpose({ dirty });
const modelTesting = ref(false);

const apiExample = `GET ${window.location.origin}/api/v1/automation/reports?externalSource=your-admin&externalId=your-record\nAuthorization: Bearer <报告读取令牌>`;
const importExample = JSON.stringify([{ name: '资源名称', scenario: 'migration', description: '资料说明', contentUrl: 'https://example.com', referenceUrl: '', externalSource: 'your-admin', externalId: 'record-001', files: [] }], null, 2);

async function load() {
  await refresh();
  if (workspace.error) throw new Error(workspace.error);
  form.value = JSON.parse(JSON.stringify(workspace.settings));
  saved.value = JSON.stringify(form.value);
  const endpoint = form.value.evaluationEndpoint || platform.settings?.model.endpoint || '';
  evaluationModel.value = {
    name: form.value.evaluationModel,
    endpoint: endpoint.replace(/\/(?:chat\/completions|responses)\/?$/, '').replace(/\/$/, ''),
    apiKey: '',
  };
  savedModel.value = JSON.stringify(modelFields());
}
onMounted(() => { void load().catch(reason => { error.value = message(reason); }); });

async function save() {
  busy.value = true; error.value = '';
  try {
    form.value = await api<AutomationSettings>('/automation/settings', { method: 'PUT', body: JSON.stringify(form.value) });
    saved.value = JSON.stringify(form.value);
    await refresh();
    notify.success('设置已保存');
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}

async function saveModel() {
  busy.value = true; error.value = '';
  const input = { ...evaluationModel.value };
  let keySaved = false;
  try {
    if (input.apiKey) {
      const current = await api<PublicSettings>('/settings');
      platform.settings = await api<PublicSettings>('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          threshold: current.threshold, paused: current.paused, execution: current.execution,
          model: { endpoint: current.model.endpoint, name: current.model.name, apiKey: input.apiKey },
          environments: current.environments.map(env => ({ ...env, token: '' })),
        }),
      });
      evaluationModel.value.apiKey = '';
      keySaved = true;
    }
    const current = await api<AutomationSettings>('/automation/settings');
    const result = await api<AutomationSettings>('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...current, evaluationModel: input.name, evaluationEndpoint: input.endpoint }),
    });
    workspace.settings = result;
    form.value.evaluationModel = result.evaluationModel;
    form.value.evaluationEndpoint = result.evaluationEndpoint;
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

<template><header class="page-header"><div><h1>系统设置</h1></div><button v-if="['runtime','prompts','followup'].includes(tab)" class="button primary" :disabled="busy||!settingsDirty" @click="save"><LoaderCircle v-if="busy" class="spin" :size="16" /><Save v-else :size="16" />保存设置</button></header><div class="segmented view-tabs"><button v-for="item in [{id:'runtime',label:'任务执行'},{id:'environment',label:'Kooboo 连接'},{id:'model',label:'评测模型'},{id:'followup',label:'AI 跟进'},{id:'billing',label:'费用'},{id:'prompts',label:'场景提示词'},{id:'api',label:'外部 API'}]" :key="item.id" :class="{selected:tab===item.id}" @click="tab=item.id">{{item.label}}</button></div><p v-if="error" class="alert error" role="alert">{{error}}</p>
<form v-if="tab==='runtime'" @submit.prevent="save"><section class="panel settings-panel"><h2>自动执行队列</h2><div class="choice-grid"><label class="choice-card" :class="{chosen:form.enabled}"><input v-model="form.enabled" type="radio" :value="true" /><span><strong>持续执行</strong><small>服务自动补入排队任务</small></span></label><label class="choice-card" :class="{chosen:!form.enabled}"><input v-model="form.enabled" type="radio" :value="false" /><span><strong>暂停队列</strong><small>已开始的任务继续，保留排队任务</small></span></label></div><label class="check-label"><input v-model="form.autoEvaluate" type="checkbox" />生成完成后自动创建独立评测任务</label><div class="form-grid three-columns"><label class="field"><span>生成并发数</span><input v-model.number="form.generationConcurrency" class="input" type="number" min="1" max="10" required /></label><label class="field"><span>评测并发数</span><input v-model.number="form.evaluationConcurrency" class="input" type="number" min="1" max="5" required /></label><label class="field"><span>单任务时限（分钟）</span><input v-model.number="form.timeoutMinutes" class="input" type="number" min="1" max="240" required /></label></div></section><section class="panel settings-panel"><h2>本机运行</h2><div class="resource-meta"><div><span>API 与队列服务</span><p>{{platform.online?'已连接':'未连接'}}</p></div><div><span>浏览器运行环境</span><p>{{platform.browserReady?'已安装':'待安装'}}</p></div><div><span>任务数据</span><p>SQLite 持久化</p></div></div><p class="text-muted">生成执行由服务保持 Kooboo AI Chat 页面运行；关闭管理页面不影响队列。执行异常会交给内置 AI 查证和跟进；确实无法继续时提供中断原因和下一步。</p></section></form>
<section v-if="tab==='followup'" class="panel settings-panel"><h2>流程跟进 Agent</h2><label class="check-label"><input v-model="form.followup.enabled" type="checkbox" />自动处理准备、生成、交接和评测中的异常</label><div class="form-grid"><label class="field"><span>跟进并发数</span><input v-model.number="form.followup.concurrency" class="input" type="number" min="1" max="3" /></label><label class="field"><span>最多跟进次数</span><input v-model.number="form.followup.maxAttempts" class="input" type="number" min="1" max="20" /></label><label class="field"><span>跟进累计执行时限（分钟）</span><input v-model.number="form.followup.maxMinutes" class="input" type="number" min="1" max="120" /></label><label class="field"><span>跟进 token 预算</span><input v-model.number="form.followup.maxTokens" class="input" type="number" min="1000" max="2000000" /></label></div><label class="field"><span>跟进 Skill / SOP</span><textarea v-model="form.followup.sop" class="input code-editor" rows="18" /></label><p class="text-muted">使用已配置的评测模型，以独立 Codex 会话跟进。仅累计跟进 Agent 实际执行的时间，排队、定时等待、Kooboo 生成和独立评测均不计入。首次介入时固定本任务的 SOP 与预算；修改用于后续任务，点击恢复会采用新设置。系统保留每次决策和工具结果。</p></section>
<BillingSettings v-if="tab==='billing'"/>
<div v-if="tab==='environment'" class="embedded-settings"><EnvironmentSettings :environments-only="true" /></div>
<form v-if="tab==='model'" class="panel settings-panel settings-stack" @submit.prevent="saveModel">
  <h2>评测模型</h2>
  <div class="form-grid">
    <label class="field"><span>模型名称</span><input v-model="evaluationModel.name" class="input" required :disabled="busy||modelTesting||!saved" /></label>
    <label class="field"><span>API 地址</span><input v-model="evaluationModel.endpoint" class="input" type="url" placeholder="供应商 API 基础地址" required :disabled="busy||modelTesting||!saved" /></label>
  </div>
  <label class="field"><span>API Key <small>{{platform.settings?.model.hasApiKey?'已保存，留空保留':'尚未配置'}}</small></span><input v-model="evaluationModel.apiKey" class="input" type="password" autocomplete="new-password" :disabled="busy||modelTesting||!saved" /></label>
  <div class="model-actions">
    <button class="button primary" :disabled="busy||modelTesting||!saved||!modelDirty"><LoaderCircle v-if="busy" class="spin" :size="16" /><Save v-else :size="16" />保存</button>
    <button type="button" class="button secondary" :disabled="busy||modelTesting||!saved||modelDirty" :title="modelDirty?'请先保存修改':'验证图片识别与工具调用'" @click="testModel"><LoaderCircle v-if="modelTesting" class="spin" :size="16" />{{modelTesting?'测试中…':'测试图片与工具'}}</button>
  </div>
</form>
<section v-if="tab==='prompts'" class="panel settings-panel"><label class="field"><span>场景</span><BaseSelect v-model="scenario" :options="Object.entries(scenarios).map(([key, label]) => ({ value: key, label: (label) }))" /></label><label class="field"><span>委托提示词</span><textarea v-model="form.prompts[scenario]" class="input code-editor" rows="18" /></label><p class="text-muted">与资料、范围及补充要求组合为一段完整消息，复用 Kooboo 已有的 skill、reference 和 tools。</p></section>
<template v-if="tab==='api'"><section class="panel settings-panel"><div class="section-heading"><h2>报告读取</h2><button class="icon-button" aria-label="复制读取示例" @click="copy(apiExample)"><Copy :size="17" /></button></div><pre class="resource-description">{{apiExample}}</pre><label class="field"><span>报告读取令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.readToken" type="password" readonly /><button class="icon-button" aria-label="复制报告令牌" @click="copy(platform.settings?.credentials.readToken||'')"><Copy :size="17" /></button></div></label><p>待跟进任务：<code>GET /api/v1/automation/tasks?status=pending</code></p><p>报告详情：<code>GET /api/v1/automation/reports/:id</code></p><p>证据文件：<code>GET /api/v1/automation/reports/:id/artifacts/:file</code></p><p class="text-muted">按 externalSource + externalId 关联多个生成站和多轮评测。报告尚未生成时保留状态，report 为 null。读取令牌没有创建或跟进权限。</p></section><section class="panel settings-panel"><h2>外部 Admin 资源导入</h2><p><code>POST /api/v1/resources/import</code></p><label class="field"><span>资源导入令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.ingestToken" type="password" readonly /><button class="icon-button" aria-label="复制导入令牌" @click="copy(platform.settings?.credentials.ingestToken||'')"><Copy :size="17" /></button></div></label><pre class="resource-description">{{importExample}}</pre><p class="text-muted">相同外部来源与记录标识更新输入版本。首版 API 位于本机；其他机器访问需后续配置网络部署。</p></section></template>
</template>

<style scoped>
.settings-stack{display:flex;flex-direction:column;gap:20px;}
.settings-stack>h2,.settings-stack>.text-muted{margin:0;}
.model-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}
</style>
