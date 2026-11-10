<script setup lang="ts">
import { notify } from '../lib/notifications';
import { computed, ref, watch } from 'vue';
import { Save, Plus, Trash2, Copy, Eye, EyeOff, Cable, LoaderCircle, Pause, Play, LogIn } from '@lucide/vue';
import BaseSelect from '../components/BaseSelect.vue';
import Disclosure from '../components/Disclosure.vue';
import KoobooLoginDialog from '../components/KoobooLoginDialog.vue';
import KoobooRootDomainSelect from '../components/KoobooRootDomainSelect.vue';
import { defaultDeliveryPolicy } from '../../../shared/automation';
import type { PublicSettings } from '../../../shared/types';
import type { KoobooLoginResult } from '../../../shared/kooboo-auth';
import { api, platform, saveSettings, message } from '../api';

const props = defineProps<{ environmentsOnly: boolean }>();
const tab = ref(new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab') || 'runtime');
function initialForm() {
  const settings = structuredClone(JSON.parse(JSON.stringify(platform.settings!)));
  return { threshold: settings.threshold as number, paused: settings.paused as boolean,
    execution: { timeoutSeconds: (settings.execution?.timeoutSeconds ?? 300) as number, captureAttempts: (settings.execution?.captureAttempts ?? 2) as number },
    model: { endpoint: settings.model.endpoint as string, name: settings.model.name as string, apiKey: '', clearKey: false, hasApiKey: settings.model.hasApiKey as boolean },
    environments: (settings.environments as PublicSettings['environments']).map((env) => ({ ...env, defaultRootDomain: env.defaultRootDomain || '', token: '', clearToken: false,delivery:{...defaultDeliveryPolicy,...env.delivery,hasToken:env.delivery?.hasToken||false,token:'',clearToken:false} })),
  };
}
const form = ref(initialForm());
const baseline = ref(JSON.stringify(form.value));
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value);
const saving = ref(false), error = ref('');
const testing = ref(''), testMessages = ref<Record<string, { ok: boolean; text: string }>>({});
const reveal = ref<Record<string, boolean>>({});
const loginDialog = ref<InstanceType<typeof KoobooLoginDialog>>();
const modelTesting = ref(false);
const modelTestResult = ref<{ ok: boolean; text: string } | null>(null);
const modelDirty = computed(() => JSON.stringify(form.value.model) !== JSON.stringify(JSON.parse(baseline.value).model));
const endpoint = `${window.location.origin}/api/evaluations`;
watch(() => form.value.model, () => { modelTestResult.value = null; }, { deep: true });

async function save(): Promise<void> {
  saving.value = true; error.value = '';
  try { await saveSettings(form.value); form.value = initialForm(); baseline.value = JSON.stringify(form.value); testMessages.value = {}; notify.success('设置已保存，对之后开始执行的任务生效'); }
  catch (reason) { error.value = message(reason); }
  finally { saving.value = false; }
}
function addEnvironment(): void { form.value.environments.push({ id: crypto.randomUUID(), name: '', origin: '', apiOrigin: '', hasToken: false, defaultRootDomain: '', token: '', clearToken: false,delivery:{...defaultDeliveryPolicy,hasToken:false,token:'',clearToken:false} }); }
function domainConnectionChanged(env: ReturnType<typeof initialForm>['environments'][number]): boolean {
  const saved = platform.settings?.environments.find(item => item.id === env.id);
  return !saved || saved.origin !== env.origin || saved.apiOrigin !== env.apiOrigin || !!env.token || env.clearToken;
}
function updateOrigin(index: number, value: string): void {
  const env = form.value.environments[index];
  if (env.apiOrigin === env.origin || !env.apiOrigin) env.apiOrigin = value;
  env.origin = value;
}
function loginConnected(result: Extract<KoobooLoginResult, { status: 'connected' }>): void {
  const saved = result.environment;
  const draft = form.value.environments.find(env => env.id === saved.id);
  if (!draft) return;
  const baselineForm = JSON.parse(baseline.value) as ReturnType<typeof initialForm>;
  let previous = baselineForm.environments.find(env => env.id === saved.id);
  if (!previous) {
    previous = { ...saved, defaultRootDomain: saved.defaultRootDomain || '', token: '', clearToken: false, delivery: { ...defaultDeliveryPolicy, ...saved.delivery, hasToken: saved.delivery?.hasToken || false, token: '', clearToken: false } };
    baselineForm.environments.push(previous);
  }
  const connected = { name: saved.name, origin: saved.origin, apiOrigin: saved.apiOrigin, hasToken: saved.hasToken, token: '', clearToken: false };
  Object.assign(draft, connected); Object.assign(previous, connected);
  baseline.value = JSON.stringify(baselineForm);
  if (platform.settings) {
    const existing = platform.settings.environments.findIndex(env => env.id === saved.id);
    if (existing < 0) platform.settings.environments.push(saved); else platform.settings.environments[existing] = saved;
  }
  testMessages.value[saved.id] = { ok: true, text: `连接成功 · 可访问 ${result.sites} 个站点` };
  notify.success('Kooboo 已连接，访问凭据已加密保存');
}
async function testConnection(id: string): Promise<void> {
  testing.value = id;
  try { const result = await api<{ sites: number }>(`/environments/${id}/test`, { method: 'POST' }); testMessages.value[id] = { ok: true, text: `连接成功 · 可访问 ${result.sites} 个站点` }; }
  catch (reason) { testMessages.value[id] = { ok: false, text: message(reason) }; }
  finally { testing.value = ''; }
}
async function testModelConnection(): Promise<void> {
  modelTesting.value = true; modelTestResult.value = null;
  const tested = JSON.stringify(form.value.model);
  try {
    const result = await api<{ model: string; latencyMs: number }>('/model/test', { method: 'POST' });
    if (tested === JSON.stringify(form.value.model)) modelTestResult.value = { ok: true, text: `测试通过 · ${result.model} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 图片识别与 JSON 输出有效` };
  } catch (reason) { if (tested === JSON.stringify(form.value.model)) modelTestResult.value = { ok: false, text: message(reason) }; }
  finally { modelTesting.value = false; }
}
async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); notify.success('已复制'); error.value = ''; }
  catch { error.value = '复制失败，请选择文本后手动复制'; }
}
</script>

<template>
  <form @submit.prevent="save()">
    <header class="page-header"><div><h1>{{ props.environmentsOnly ? '环境连接' : '系统设置' }}</h1><p>{{ props.environmentsOnly ? '配置平台独立访问 Kooboo 的地址与凭据' : '管理任务执行、视觉模型与插件接入' }}</p></div><button class="button primary" :disabled="!dirty || saving || modelTesting"><LoaderCircle v-if="saving" class="spin" :size="18" /><Save v-else :size="18" />{{ saving ? '保存中…' : '保存设置' }}</button></header>
    <div v-if="!props.environmentsOnly" class="toolbar settings-tabs"><div class="segmented"><button type="button" :class="{ selected: tab === 'runtime' }" @click="tab = 'runtime'">运行设置</button><button type="button" :class="{ selected: tab === 'model' }" @click="tab = 'model'">模型接口</button><button type="button" :class="{ selected: tab === 'integration' }" @click="tab = 'integration'">插件与 Admin 接入</button></div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <template v-if="props.environmentsOnly">
      <section v-if="!form.environments.length" class="panel empty-state"><span class="empty-icon"><Cable :size="30" :stroke-width="1.4" /></span><h2>添加第一个 Kooboo 环境</h2><p>插件提交站点身份后，平台通过这里的配置读取站点地址和资料</p><button type="button" class="button primary" @click="addEnvironment()"><Plus :size="17" />添加环境</button></section>
      <section v-for="(env, index) in form.environments" :key="env.id" class="panel settings-panel">
        <div class="section-heading"><h2>{{ env.name || `Kooboo 环境 ${index + 1}` }}</h2><button type="button" class="icon-button danger-icon" aria-label="移除此环境" @click="form.environments.splice(index, 1)"><Trash2 :size="18" /></button></div>
        <div class="form-grid three-columns">
          <label class="field"><span>环境名称</span><input v-model="env.name" class="input" placeholder="例如：本机 Kooboo" required maxlength="100" /></label>
          <label class="field"><span>Kooboo 环境地址</span><input :value="env.origin" type="url" class="input" placeholder="http://localhost:3000" required @input="updateOrigin(index, ($event.target as HTMLInputElement).value)" /></label>
          <label class="field"><span>平台访问地址</span><input v-model="env.apiOrigin" type="url" class="input" placeholder="默认与环境地址相同" required /></label>
        </div>
        <div class="connection-login"><button type="button" class="button secondary" :disabled="saving || !env.name.trim() || !env.origin || !env.apiOrigin" @click="loginDialog?.open(env)"><LogIn :size="17" />{{ env.hasToken ? '重新登录' : '登录连接' }}</button><span v-if="env.hasToken" class="text-muted small-text">访问凭据已保存</span></div>
        <label class="field"><span>默认建站根域名</span><KoobooRootDomainSelect v-model="env.defaultRootDomain" :environment-id="env.id" :disabled="domainConnectionChanged(env)" /></label>
        <Disclosure label="手动填写访问令牌"><label class="field credential-field"><span>访问令牌 <small>{{ env.hasToken ? '已保存，留空保留' : 'Bearer Token' }}</small></span><div class="input-with-action"><input v-model="env.token" :type="reveal[env.id] ? 'text' : 'password'" autocomplete="new-password" :placeholder="env.hasToken ? '输入新令牌可替换当前令牌' : '填写 Kooboo 访问令牌'" /><button type="button" class="icon-button" :aria-label="reveal[env.id] ? '隐藏令牌' : '显示令牌'" @click="reveal[env.id] = !reveal[env.id]"><EyeOff v-if="reveal[env.id]" :size="18" /><Eye v-else :size="18" /></button></div></label></Disclosure>
        <label class="check-label"><input v-model="env.delivery.enabled" type="checkbox"/>启用跨环境交付</label>
        <div v-if="env.delivery.enabled" class="delivery-config"><label class="field"><span>迁移接口</span><input v-model="env.delivery.endpoint" type="url" class="input" required/></label><label class="field credential-field"><span>迁移服务令牌 <small>{{env.delivery.hasToken?'已保存，留空保留':'独立于 Kooboo 访问令牌'}}</small></span><input v-model="env.delivery.token" class="input" type="password" autocomplete="new-password"/></label><div class="form-grid"><label class="field"><span>交付方式</span><BaseSelect :model-value="env.delivery.auto?'auto':'manual'" @update:model-value="v=>env.delivery.auto=v==='auto'" :options="[{ value: 'manual', label: '评测后按需发起' }, { value: 'auto', label: '迁移 / 升级的全站评测后自动交付' }]" /></label><label class="field"><span>迁移接口超时（秒）</span><input v-model.number="env.delivery.timeoutSeconds" class="input" type="number" min="30" max="900" required/></label></div><label class="check-label"><input v-model="env.delivery.requirePassed" type="checkbox"/>源站评测通过后才允许交付</label><p class="text-muted small-text">交付去向由迁移服务决定，返回目标站后核验两端站点。保留源站；结果不确定时先核查回执。</p></div>
        <div class="inline-actions"><button type="button" class="button secondary small" :disabled="dirty || !!testing" @click="testConnection(env.id)"><LoaderCircle v-if="testing === env.id" class="spin" :size="16" /><Cable v-else :size="16" />测试连接</button><span v-if="testMessages[env.id]" :class="testMessages[env.id].ok ? 'success-text' : 'error-text'" role="status">{{ testMessages[env.id].text }}</span><span v-else-if="dirty" class="text-muted small-text">保存后可测试连接</span></div>
      </section>
      <button v-if="form.environments.length" type="button" class="button secondary" @click="addEnvironment()"><Plus :size="17" />添加环境</button>
      <p class="page-footnote">环境地址需与插件所报地址一致。账号登录可自动获取并加密保存访问凭据，不保存密码。</p>
    </template>

    <template v-else-if="tab === 'runtime'">
      <section class="panel settings-panel"><h2>任务执行</h2><div class="choice-grid">
        <label class="choice-card" :class="{ chosen: !form.paused }"><input v-model="form.paused" type="radio" :value="false" /><span><strong><Play :size="17" />持续执行</strong><small>自动处理已接收的任务，当前每次执行一项</small></span></label>
        <label class="choice-card" :class="{ chosen: form.paused }"><input v-model="form.paused" type="radio" :value="true" /><span><strong><Pause :size="17" />暂停队列</strong><small>保留待处理任务，已开始的任务继续完成</small></span></label>
      </div><div class="form-grid">
        <label class="field"><span>单个阶段执行预算</span><div class="input-with-unit"><input v-model.number="form.execution.timeoutSeconds" type="number" min="30" max="1800" step="1" required /><span>秒</span></div><p>用于单个视口采集和最终评分，默认 300 秒</p></label>
        <label class="field"><span>每个视口的采集次数上限</span><div class="input-with-unit"><input v-model.number="form.execution.captureAttempts" type="number" min="1" max="3" step="1" required /><span>次</span></div><p>包含首次采集，默认最多 2 次</p></label>
      </div></section>
      <section class="panel settings-panel"><h2>人工复核</h2><div class="form-grid"><label class="field"><span>低分筛选阈值</span><p>低于此分数的结果进入需复核，调整不会重新调用模型</p><div class="input-with-unit"><input v-model.number="form.threshold" type="number" min="0" max="100" step="1" required /><span>分</span></div></label><div class="field"><span>需复核范围</span><p>同时包含无法评分、低可信度、严重页面问题和覆盖不足</p><div class="readonly-value">低分 + 证据或覆盖异常</div></div></div></section>
      <section class="panel settings-panel"><h2>采集范围</h2><p class="section-note">当前采集首页静态视觉。视口尺寸、采样区域和超时在<a href="#/rules">评分规则</a>中维护，每个任务按所选版本执行。全站任务会标记覆盖不足。</p></section>
    </template>
    <template v-else-if="tab === 'model'">
      <section class="panel settings-panel">
        <h2>视觉模型</h2>
        <div class="form-grid">
          <label class="field full-width"><span>Chat Completions 接口</span><input v-model="form.model.endpoint" type="url" class="input" placeholder="https://服务地址/v1/chat/completions" /><p>填写支持图片输入与 JSON 输出的兼容接口完整地址</p></label>
          <label class="field"><span>模型名称</span><input v-model="form.model.name" class="input" placeholder="服务提供的视觉模型名称" /></label>
          <div class="field">
            <span>API Key <small>{{ form.model.hasApiKey ? '已保存，留空保留' : '填写服务访问密钥' }}</small></span>
            <div class="input-with-action"><input v-model="form.model.apiKey" aria-label="模型 API Key" :type="reveal.model ? 'text' : 'password'" autocomplete="new-password" placeholder="填写访问密钥" /><button type="button" class="icon-button" :aria-label="reveal.model ? '隐藏密钥' : '显示密钥'" @click="reveal.model = !reveal.model"><EyeOff v-if="reveal.model" :size="18" /><Eye v-else :size="18" /></button></div>
            <label v-if="form.model.hasApiKey" class="checkbox-field"><input v-model="form.model.clearKey" type="checkbox" />清除已保存的密钥</label>
          </div>
        </div>
        <div class="model-test-actions"><button type="button" class="button secondary" :disabled="modelTesting || saving || modelDirty || !form.model.endpoint || !form.model.name" @click="testModelConnection()"><LoaderCircle v-if="modelTesting" class="spin" :size="17" /><Cable v-else :size="17" />{{ modelTesting ? '测试中…' : '测试连接' }}</button><span class="section-note">{{ modelDirty ? '先保存模型配置，再进行测试' : '发送一张测试图片，验证图片识别、工具调用和结果读取' }}</span></div>
        <p v-if="modelTestResult" class="alert" :class="modelTestResult.ok ? 'success' : 'error'" :role="modelTestResult.ok ? 'status' : 'alert'">{{ modelTestResult.text }}</p>
      </section>
      <section class="panel settings-panel"><h2>评分约定</h2><div class="settings-facts"><p><span>结果形式</span><strong>分项评分 + 真实证据引用</strong></p><p><span>调用时限</span><strong>测试 45 秒 · 评分 {{ form.execution.timeoutSeconds }} 秒 / 次</strong></p><p><span>历史报告</span><strong>保留实际模型与规则快照</strong></p></div><p class="section-note">模型输出需通过结构与证据校验。当前规则尚未校准，分数用于辅助人工筛选。</p></section>
    </template>
    <template v-else-if="tab === 'integration'">
      <section class="panel settings-panel"><h2>建站插件接入</h2><label class="field"><span>任务接收接口</span><div class="input-with-action"><input :value="endpoint" readonly /><button type="button" class="icon-button" aria-label="复制接收接口" @click="copy(endpoint)"><Copy :size="17" /></button></div></label><label class="field"><span>插件投递令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.ingestToken" :type="reveal.ingest ? 'text' : 'password'" readonly /><button type="button" class="icon-button" :aria-label="reveal.ingest ? '隐藏投递令牌' : '显示投递令牌'" @click="reveal.ingest = !reveal.ingest"><EyeOff v-if="reveal.ingest" :size="17" /><Eye v-else :size="17" /></button><button type="button" class="icon-button" aria-label="复制投递令牌" @click="copy(platform.settings?.credentials.ingestToken || '')"><Copy :size="17" /></button></div></label><p class="section-note">在建站插件的“设置 → 评分平台”填写以上接口与令牌，规则版本填写“评分规则”中的已发布版本，新流程为 agent-ui-v1。</p></section>
      <section class="panel settings-panel"><h2>Admin 查询</h2><label class="field"><span>结果查询令牌</span><div class="input-with-action"><input :value="platform.settings?.credentials.readToken" :type="reveal.read ? 'text' : 'password'" readonly /><button type="button" class="icon-button" :aria-label="reveal.read ? '隐藏查询令牌' : '显示查询令牌'" @click="reveal.read = !reveal.read"><EyeOff v-if="reveal.read" :size="17" /><Eye v-else :size="17" /></button><button type="button" class="icon-button" aria-label="复制查询令牌" @click="copy(platform.settings?.credentials.readToken || '')"><Copy :size="17" /></button></div></label><pre class="code-block">GET /api/sites/{domain}/evaluations/latest
GET /api/sites/{domain}/evaluations
GET /api/jobs/{jobId}/evaluations/latest
GET /api/evaluations/{evaluationId}
Authorization: Bearer &lt;查询令牌&gt;</pre><p class="section-note">以上接口地址与令牌可提供给外部 Admin 查询结果。</p></section>
    </template>
  </form>
  <KoobooLoginDialog ref="loginDialog" @connected="loginConnected" />
</template>

<style scoped>
.connection-login{display:flex;align-items:center;gap:12px;margin-top:20px;}
.delivery-config{display:flex;flex-direction:column;gap:20px;padding:20px;margin-top:16px;background:var(--field);border-radius:12px;}
.delivery-config>.credential-field{margin-top:0;}
.delivery-config .input,.delivery-config :deep(.ui-select-trigger){background:var(--paper);}
.delivery-config .input:not(:focus),.delivery-config :deep(.ui-select-trigger:not(:focus-visible):not(.is-open):not(.is-invalid)){border-color:#dfe5ef;}
</style>
