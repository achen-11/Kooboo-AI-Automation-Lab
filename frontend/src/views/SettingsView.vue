<script setup lang="ts">
import { notify } from '../lib/notifications';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Save,
  Plus,
  Trash2,
  Copy,
  Eye,
  EyeOff,
  Cable,
  LoaderCircle,
  Pause,
  Play,
  LogIn,
  Globe,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Sparkles,
} from '@lucide/vue';
import BaseSelect from '../components/BaseSelect.vue';
import Disclosure from '../components/Disclosure.vue';
import KoobooLoginDialog from '../components/KoobooLoginDialog.vue';
import KoobooBrowserLoginDialog from '../components/KoobooBrowserLoginDialog.vue';
import KoobooRootDomainSelect from '../components/KoobooRootDomainSelect.vue';
import { defaultDeliveryPolicy } from '../../../shared/automation';
import type { PublicSettings } from '../../../shared/types';
import type { KoobooBrowserLoginStatus, KoobooLoginResult } from '../../../shared/kooboo-auth';
import { api, platform, saveSettings, message } from '../api';

const props = defineProps<{ environmentsOnly: boolean }>();
const tab = ref(new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab') || 'runtime');

function initialForm() {
  const settings = structuredClone(JSON.parse(JSON.stringify(platform.settings!))) as PublicSettings;
  const defaults = settings.deliveryDefaults;
  return {
    threshold: settings.threshold,
    paused: settings.paused,
    execution: {
      timeoutSeconds: settings.execution?.timeoutSeconds ?? 300,
      captureAttempts: settings.execution?.captureAttempts ?? 2,
    },
    deliveryDefaults: {
      endpoint: defaults?.savedEndpoint || '',
      token: '',
      clearToken: false,
      hasToken: defaults?.hasToken || false,
      hasSavedToken: defaults?.hasSavedToken || false,
      tokenFromEnv: defaults?.tokenFromEnv || false,
      endpointFromEnv: defaults?.endpointFromEnv || false,
      effectiveEndpoint: defaults?.endpoint || defaultDeliveryPolicy.endpoint,
      reusableEnvironmentId: defaults?.reusableEnvironmentId || '',
      reusableEnvironmentName: defaults?.reusableEnvironmentName || '',
    },
    model: {
      endpoint: settings.model.endpoint,
      name: settings.model.name,
      apiKey: '',
      clearKey: false,
      hasApiKey: settings.model.hasApiKey,
    },
    environments: settings.environments.map((env) => ({
      ...env,
      defaultRootDomain: env.defaultRootDomain || '',
      cloneFallbackEnvironmentId: env.cloneFallbackEnvironmentId || '',
      token: '',
      clearToken: false,
      delivery: {
        ...defaultDeliveryPolicy,
        ...env.delivery,
        endpoint: env.delivery?.endpoint || '',
        verifyWithAi: env.delivery?.verifyWithAi ?? true,
        hasToken: env.delivery?.hasToken || false,
        hasCustomToken: env.delivery?.hasCustomToken ?? Boolean(env.delivery?.hasToken && !defaults?.hasToken),
        effectiveEndpoint: env.delivery?.effectiveEndpoint || defaults?.endpoint || defaultDeliveryPolicy.endpoint,
        token: '',
        clearToken: false,
      },
    })),
  };
}

type SettingsForm = ReturnType<typeof initialForm>;
type EnvironmentDraft = SettingsForm['environments'][number];

const form = ref<SettingsForm>(initialForm());
const baseline = ref(JSON.stringify(form.value));
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value);
defineExpose({ dirty });

const saving = ref(false), error = ref(''), adoptingToken = ref(false);
const testing = ref(''), testMessages = ref<Record<string, { ok: boolean; text: string }>>({});
const reveal = ref<Record<string, boolean>>({});
const collapsedEnvs = ref<Record<string, boolean>>({});
const defaultsExpanded = ref(!form.value.deliveryDefaults.hasToken);
const loginDialog = ref<InstanceType<typeof KoobooLoginDialog>>();
const browserLoginDialog = ref<InstanceType<typeof KoobooBrowserLoginDialog>>();
const envCards = new Map<string, HTMLElement>();
const nameInputs = new Map<string, HTMLInputElement>();
const modelTesting = ref(false);
const modelTestResult = ref<{ ok: boolean; text: string } | null>(null);
const modelDirty = computed(() => JSON.stringify(form.value.model) !== JSON.stringify((JSON.parse(baseline.value) as SettingsForm).model));
const endpoint = `${window.location.origin}/api/evaluations`;
watch(() => form.value.model, () => { modelTestResult.value = null; }, { deep: true });

const effectiveDefaultEndpoint = computed(() =>
  form.value.deliveryDefaults.endpoint.trim()
  || platform.settings?.deliveryDefaults?.endpoint
  || defaultDeliveryPolicy.endpoint,
);

const effectiveDefaultHasToken = computed(() => {
  if (form.value.deliveryDefaults.token.trim()) return true;
  if (form.value.deliveryDefaults.clearToken) return form.value.deliveryDefaults.tokenFromEnv;
  return form.value.deliveryDefaults.hasToken;
});

const allCollapsed = computed(() =>
  form.value.environments.length > 0 && form.value.environments.every((env) => Boolean(collapsedEnvs.value[env.id])),
);

function setEnvCardRef(id: string, el: unknown): void {
  if (el instanceof HTMLElement) envCards.set(id, el);
  else envCards.delete(id);
}

function setNameInputRef(id: string, el: unknown): void {
  if (el instanceof HTMLInputElement) nameInputs.set(id, el);
  else nameInputs.delete(id);
}

function envHostLabel(origin: string): string {
  if (!origin) return '';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function envStatusBadge(env: EnvironmentDraft): { label: string; tone: 'completed' | 'pending' | '' } {
  if (domainConnectionChanged(env)) return { label: '连接待保存', tone: 'pending' };
  if (env.hasToken) return { label: '已连接', tone: 'completed' };
  return { label: '未登录', tone: '' };
}

function hasEnvDeliveryOverride(env: EnvironmentDraft): boolean {
  const customEndpoint = env.delivery.endpoint.trim();
  const endpointChanged = Boolean(customEndpoint && customEndpoint !== effectiveDefaultEndpoint.value);
  const tokenPresent = !env.delivery.clearToken && Boolean(env.delivery.token.trim() || env.delivery.hasCustomToken);
  return endpointChanged || tokenPresent;
}

function envEffectiveEndpoint(env: EnvironmentDraft): string {
  return env.delivery.endpoint.trim() || effectiveDefaultEndpoint.value;
}

function envEffectiveHasToken(env: EnvironmentDraft): boolean {
  const ownToken = !env.delivery.clearToken && Boolean(env.delivery.token.trim() || env.delivery.hasCustomToken);
  return ownToken || effectiveDefaultHasToken.value;
}

function clearEnvDeliveryOverride(env: EnvironmentDraft): void {
  env.delivery.endpoint = '';
  env.delivery.token = '';
  if (env.delivery.hasCustomToken) env.delivery.clearToken = true;
}

function toggleAllCollapsed(): void {
  const next = !allCollapsed.value;
  for (const env of form.value.environments) {
    collapsedEnvs.value[env.id] = next;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await saveSettings(form.value);
    form.value = initialForm();
    baseline.value = JSON.stringify(form.value);
    testMessages.value = {};
    if (!form.value.deliveryDefaults.hasToken) defaultsExpanded.value = true;
    notify.success('设置已保存，对之后开始执行的任务生效');
  } catch (reason) {
    error.value = message(reason);
  } finally {
    saving.value = false;
  }
}

function discardChanges(): void {
  form.value = JSON.parse(baseline.value) as SettingsForm;
  error.value = '';
  notify.info('已放弃未保存的修改');
}

async function adoptReusableToken(): Promise<void> {
  const sourceId = form.value.deliveryDefaults.reusableEnvironmentId;
  if (!sourceId || adoptingToken.value) return;
  adoptingToken.value = true;
  error.value = '';
  try {
    const updated = await api<PublicSettings>('/settings/delivery-defaults/adopt-token', {
      method: 'POST',
      body: JSON.stringify({ environmentId: sourceId }),
    });
    platform.settings = updated;
    const nextDefaults = {
      endpoint: updated.deliveryDefaults?.savedEndpoint || '',
      token: '',
      clearToken: false,
      hasToken: updated.deliveryDefaults?.hasToken || false,
      hasSavedToken: updated.deliveryDefaults?.hasSavedToken || false,
      tokenFromEnv: updated.deliveryDefaults?.tokenFromEnv || false,
      endpointFromEnv: updated.deliveryDefaults?.endpointFromEnv || false,
      effectiveEndpoint: updated.deliveryDefaults?.endpoint || defaultDeliveryPolicy.endpoint,
      reusableEnvironmentId: updated.deliveryDefaults?.reusableEnvironmentId || '',
      reusableEnvironmentName: updated.deliveryDefaults?.reusableEnvironmentName || '',
    };
    Object.assign(form.value.deliveryDefaults, nextDefaults);
    const baselineForm = JSON.parse(baseline.value) as SettingsForm;
    Object.assign(baselineForm.deliveryDefaults, nextDefaults);
    for (const draft of form.value.environments) {
      const savedEnv = updated.environments.find((item) => item.id === draft.id);
      if (savedEnv?.delivery) {
        draft.delivery.hasToken = savedEnv.delivery.hasToken;
        draft.delivery.hasCustomToken = savedEnv.delivery.hasCustomToken;
        draft.delivery.effectiveEndpoint = savedEnv.delivery.effectiveEndpoint;
      }
      const baselineEnv = baselineForm.environments.find((item) => item.id === draft.id);
      if (baselineEnv && savedEnv?.delivery) {
        baselineEnv.delivery.hasToken = savedEnv.delivery.hasToken;
        baselineEnv.delivery.hasCustomToken = savedEnv.delivery.hasCustomToken;
        baselineEnv.delivery.effectiveEndpoint = savedEnv.delivery.effectiveEndpoint;
      }
    }
    baseline.value = JSON.stringify(baselineForm);
    notify.success('已将该环境的迁移令牌设为全局默认');
  } catch (reason) {
    error.value = message(reason);
  } finally {
    adoptingToken.value = false;
  }
}

async function addEnvironment(): Promise<void> {
  const id = crypto.randomUUID();
  form.value.environments.push({
    id,
    name: '',
    origin: '',
    apiOrigin: '',
    hasToken: false,
    defaultRootDomain: '',
    cloneFallbackEnvironmentId: '',
    token: '',
    clearToken: false,
    delivery: {
      ...defaultDeliveryPolicy,
      endpoint: '',
      verifyWithAi: true,
      hasToken: effectiveDefaultHasToken.value,
      hasCustomToken: false,
      effectiveEndpoint: effectiveDefaultEndpoint.value,
      token: '',
      clearToken: false,
    },
  });
  collapsedEnvs.value[id] = false;
  await nextTick();
  envCards.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  nameInputs.get(id)?.focus();
}

function removeEnvironment(index: number): void {
  const target = form.value.environments[index];
  if (!target) return;
  const isSaved = Boolean(platform.settings?.environments.some((item) => item.id === target.id));
  const hasContent = Boolean(target.name.trim() || target.origin.trim() || target.hasToken);
  if ((isSaved || hasContent) && !window.confirm(`确定移除环境「${target.name.trim() || target.origin || `Kooboo 环境 ${index + 1}`}」？保存设置后生效。`)) {
    return;
  }
  const [removed] = form.value.environments.splice(index, 1);
  if (!removed) return;
  delete collapsedEnvs.value[removed.id];
  for (const item of form.value.environments) {
    if (item.cloneFallbackEnvironmentId === removed.id) item.cloneFallbackEnvironmentId = '';
  }
}

function fallbackEnvironmentOptions(currentId: string) {
  return [
    { value: '', label: '不启用（原站克隆失败后直接中断）' },
    ...form.value.environments
      .filter((other) => other.id !== currentId)
      .map((other) => ({ value: other.id, label: other.name.trim() || other.origin || other.id })),
  ];
}

function domainConnectionChanged(env: EnvironmentDraft): boolean {
  const saved = platform.settings?.environments.find((item) => item.id === env.id);
  return !saved || saved.origin !== env.origin || saved.apiOrigin !== env.apiOrigin || !!env.token || env.clearToken;
}

function updateOrigin(index: number, value: string): void {
  const env = form.value.environments[index];
  if (env.apiOrigin === env.origin || !env.apiOrigin) env.apiOrigin = value;
  env.origin = value;
}

function applyBrowserOrigin(payload: { id: string; origin: string }): void {
  const env = form.value.environments.find((item) => item.id === payload.id);
  if (!env) return;
  env.origin = payload.origin;
  env.apiOrigin = payload.origin;
}

function loginConnected(result: Extract<KoobooLoginResult | KoobooBrowserLoginStatus, { status: 'connected' }>): void {
  const saved = result.environment;
  const draft = form.value.environments.find((env) => env.id === saved.id);
  if (!draft) return;
  const baselineForm = JSON.parse(baseline.value) as SettingsForm;
  let previous = baselineForm.environments.find((env) => env.id === saved.id);
  if (!previous) {
    previous = {
      ...saved,
      defaultRootDomain: saved.defaultRootDomain || '',
      cloneFallbackEnvironmentId: saved.cloneFallbackEnvironmentId || '',
      token: '',
      clearToken: false,
      delivery: {
        ...defaultDeliveryPolicy,
        ...saved.delivery,
        endpoint: saved.delivery?.endpoint || '',
        verifyWithAi: saved.delivery?.verifyWithAi ?? true,
        hasToken: saved.delivery?.hasToken || false,
        hasCustomToken: saved.delivery?.hasCustomToken ?? Boolean(saved.delivery?.hasToken && !platform.settings?.deliveryDefaults?.hasToken),
        effectiveEndpoint: saved.delivery?.effectiveEndpoint || effectiveDefaultEndpoint.value,
        token: '',
        clearToken: false,
      },
    };
    baselineForm.environments.push(previous);
  }
  const connected = { name: saved.name, origin: saved.origin, apiOrigin: saved.apiOrigin, hasToken: saved.hasToken, token: '', clearToken: false };
  Object.assign(draft, connected);
  Object.assign(previous, connected);
  baseline.value = JSON.stringify(baselineForm);
  if (platform.settings) {
    const existing = platform.settings.environments.findIndex((env) => env.id === saved.id);
    if (existing < 0) platform.settings.environments.push(saved);
    else platform.settings.environments[existing] = saved;
  }
  testMessages.value[saved.id] = { ok: true, text: `连接成功 · 可访问 ${result.sites} 个站点` };
  notify.success('Kooboo 已连接，访问凭据已加密保存');
}

async function testConnection(id: string): Promise<void> {
  testing.value = id;
  try {
    const result = await api<{ sites: number }>(`/environments/${id}/test`, { method: 'POST' });
    testMessages.value[id] = { ok: true, text: `连接成功 · 可访问 ${result.sites} 个站点` };
  } catch (reason) {
    testMessages.value[id] = { ok: false, text: message(reason) };
  } finally {
    testing.value = '';
  }
}

async function testModelConnection(): Promise<void> {
  modelTesting.value = true;
  modelTestResult.value = null;
  const tested = JSON.stringify(form.value.model);
  try {
    const result = await api<{ model: string; latencyMs: number }>('/model/test', { method: 'POST' });
    if (tested === JSON.stringify(form.value.model)) modelTestResult.value = { ok: true, text: `测试通过 · ${result.model} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · 图片识别与 JSON 输出有效` };
  } catch (reason) {
    if (tested === JSON.stringify(form.value.model)) modelTestResult.value = { ok: false, text: message(reason) };
  } finally {
    modelTesting.value = false;
  }
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    notify.success('已复制');
    error.value = '';
  } catch {
    error.value = '无法访问剪贴板，请手动选择复制';
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
  if (document.querySelector('dialog[open]')) return;
  if (!dirty.value || saving.value || modelTesting.value) return;
  event.preventDefault();
  void save();
}

onMounted(() => { window.addEventListener('keydown', onKeydown); });
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <form @submit.prevent="save()">
    <header class="page-header">
      <div>
        <h1>{{ props.environmentsOnly ? '环境连接' : '系统设置' }}</h1>
        <p>{{ props.environmentsOnly ? '配置平台独立访问 Kooboo 的地址、登录凭据与跨环境交付默认值' : '管理任务执行、视觉模型与插件接入' }}</p>
      </div>
      <div class="toolbar-actions">
        <button v-if="props.environmentsOnly && form.environments.length > 1" type="button" class="button secondary" @click="toggleAllCollapsed()">
          {{ allCollapsed ? '全部展开' : '全部收起' }}
        </button>
        <button v-if="props.environmentsOnly && form.environments.length" type="button" class="button secondary" @click="addEnvironment()">
          <Plus :size="17" />添加环境
        </button>
        <button class="button primary" :disabled="!dirty || saving || modelTesting">
          <LoaderCircle v-if="saving" class="spin" :size="18" /><Save v-else :size="18" />{{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </header>
    <div v-if="!props.environmentsOnly" class="toolbar settings-tabs"><div class="segmented"><button type="button" :class="{ selected: tab === 'runtime' }" @click="tab = 'runtime'">运行设置</button><button type="button" :class="{ selected: tab === 'model' }" @click="tab = 'model'">模型接口</button><button type="button" :class="{ selected: tab === 'integration' }" @click="tab = 'integration'">插件与 Admin 接入</button></div></div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <template v-if="props.environmentsOnly">
      <section class="panel settings-panel defaults-panel">
        <div class="section-heading">
          <div class="env-title-group">
            <h2>默认跨环境迁移服务</h2>
            <span class="status-badge" :class="effectiveDefaultHasToken ? 'completed' : 'pending'">
              {{ form.deliveryDefaults.tokenFromEnv && !form.deliveryDefaults.token && !form.deliveryDefaults.hasSavedToken ? '使用环境变量令牌' : effectiveDefaultHasToken ? '默认令牌已就绪' : '尚未配置默认令牌' }}
            </span>
          </div>
          <button type="button" class="text-action" @click="defaultsExpanded = !defaultsExpanded">
            {{ defaultsExpanded ? '收起' : '编辑默认配置' }}
          </button>
        </div>
        <p class="text-muted small-text defaults-summary">
          接口：<code>{{ effectiveDefaultEndpoint }}</code>
          <span v-if="form.deliveryDefaults.endpointFromEnv && !form.deliveryDefaults.endpoint.trim()">（环境变量预置）</span>
          · 启用跨环境交付的环境将默认继承此处配置，仅需在特殊环境按需覆盖。
        </p>

        <div v-if="!effectiveDefaultHasToken && form.deliveryDefaults.reusableEnvironmentId" class="adopt-banner">
          <span>
            <Sparkles :size="15" />
            检测到环境「<strong>{{ form.deliveryDefaults.reusableEnvironmentName }}</strong>」已保存迁移令牌，可直接设为全局默认，无需重新查找复制。
          </span>
          <button type="button" class="button secondary small" :disabled="adoptingToken || saving" @click="adoptReusableToken()">
            <LoaderCircle v-if="adoptingToken" class="spin" :size="14" />{{ adoptingToken ? '同步中…' : '设为全局默认令牌' }}
          </button>
        </div>

        <div v-if="defaultsExpanded" class="defaults-fields">
          <div class="form-grid">
            <label class="field">
              <span>默认迁移接口 <small>留空沿用 {{ defaultDeliveryPolicy.endpoint }}</small></span>
              <input
                v-model="form.deliveryDefaults.endpoint"
                type="url"
                class="input"
                :placeholder="platform.settings?.deliveryDefaults?.endpoint || defaultDeliveryPolicy.endpoint"
              />
            </label>
            <div class="field">
              <span>
                默认迁移服务令牌
                <small>
                  {{ form.deliveryDefaults.hasSavedToken ? '已加密保存，留空保留' : form.deliveryDefaults.tokenFromEnv ? '已从环境变量读取，填写可覆盖' : '独立于 Kooboo 访问令牌' }}
                </small>
              </span>
              <div class="input-with-action">
                <input
                  v-model="form.deliveryDefaults.token"
                  :type="reveal.deliveryDefault ? 'text' : 'password'"
                  autocomplete="new-password"
                  :placeholder="form.deliveryDefaults.hasSavedToken ? '输入新令牌可替换当前默认令牌' : '填写全局默认迁移服务令牌'"
                />
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="reveal.deliveryDefault ? '隐藏默认令牌' : '显示默认令牌'"
                  @click="reveal.deliveryDefault = !reveal.deliveryDefault"
                >
                  <EyeOff v-if="reveal.deliveryDefault" :size="18" /><Eye v-else :size="18" />
                </button>
              </div>
              <label v-if="form.deliveryDefaults.hasSavedToken" class="checkbox-field">
                <input v-model="form.deliveryDefaults.clearToken" type="checkbox" />清除已保存的默认令牌
              </label>
            </div>
          </div>
        </div>
      </section>

      <section v-if="!form.environments.length" class="panel empty-state">
        <span class="empty-icon"><Cable :size="30" :stroke-width="1.4" /></span>
        <h2>添加第一个 Kooboo 环境</h2>
        <p>插件提交站点身份后，平台通过这里的配置读取站点地址和资料</p>
        <button type="button" class="button primary" @click="addEnvironment()"><Plus :size="17" />添加环境</button>
      </section>

      <section
        v-for="(env, index) in form.environments"
        :key="env.id"
        :ref="el => setEnvCardRef(env.id, el)"
        class="panel settings-panel env-card"
      >
        <div class="section-heading env-card-head">
          <button
            type="button"
            class="env-collapse-trigger"
            :aria-expanded="!collapsedEnvs[env.id]"
            @click="collapsedEnvs[env.id] = !collapsedEnvs[env.id]"
          >
            <ChevronRight v-if="collapsedEnvs[env.id]" :size="18" />
            <ChevronDown v-else :size="18" />
            <h2>{{ env.name.trim() || `Kooboo 环境 ${index + 1}` }}</h2>
            <span class="status-badge" :class="envStatusBadge(env).tone">{{ envStatusBadge(env).label }}</span>
            <span v-if="envHostLabel(env.origin)" class="env-meta-chip">{{ envHostLabel(env.origin) }}</span>
            <span v-if="env.delivery.enabled" class="env-meta-chip">跨环境交付</span>
          </button>
          <button type="button" class="icon-button danger-icon" aria-label="移除此环境" @click="removeEnvironment(index)"><Trash2 :size="18" /></button>
        </div>

        <div v-show="!collapsedEnvs[env.id]" class="env-card-body">
          <div class="form-grid three-columns">
            <label class="field">
              <span>环境名称</span>
              <input
                :ref="el => setNameInputRef(env.id, el)"
                v-model="env.name"
                class="input"
                placeholder="例如：本机 Kooboo / 香港环境"
                required
                maxlength="100"
              />
            </label>
            <label class="field">
              <span>Kooboo 环境地址</span>
              <input
                :value="env.origin"
                type="url"
                class="input"
                placeholder="https://www.localkooboo.com"
                required
                @input="updateOrigin(index, ($event.target as HTMLInputElement).value)"
              />
            </label>
            <label class="field">
              <span>平台访问地址</span>
              <input v-model="env.apiOrigin" type="url" class="input" placeholder="默认与环境地址相同" required />
            </label>
          </div>

          <div class="connection-login">
            <button
              type="button"
              class="button secondary"
              :disabled="saving || !env.name.trim() || !env.origin || !env.apiOrigin"
              @click="browserLoginDialog?.open(env)"
            >
              <Globe :size="17" />{{ env.hasToken ? '浏览器重新登录' : '浏览器登录获取' }}
            </button>
            <button
              type="button"
              class="button secondary"
              :disabled="saving || !env.name.trim() || !env.origin || !env.apiOrigin"
              @click="loginDialog?.open(env)"
            >
              <LogIn :size="17" />{{ env.hasToken ? '账号密码重登' : '账号密码登录' }}
            </button>
            <span v-if="env.hasToken" class="success-text small-text">访问凭据已加密保存</span>
            <span v-else-if="!env.name.trim() || !env.origin || !env.apiOrigin" class="text-muted small-text">请先填写名称与环境地址后登录</span>
          </div>
          <p class="text-muted small-text login-mode-hint">推荐使用「浏览器登录获取」，支持 Google / SSO / 验证码登录，登录成功后自动读取并保存令牌，无需手动复制。</p>

          <label class="field"><span>默认建站根域名</span><KoobooRootDomainSelect v-model="env.defaultRootDomain" :environment-id="env.id" :disabled="domainConnectionChanged(env)" /></label>
          <label class="field">
            <span>克隆失败自动回退环境</span>
            <BaseSelect v-model="env.cloneFallbackEnvironmentId" :options="fallbackEnvironmentOptions(env.id)" />
            <p class="text-muted small-text">旧站升级在准备阶段克隆原站导入 0 页时，自动清理当前空站并切换至所选环境重新建站、克隆与执行（需目标环境已登录连接）。</p>
          </label>

          <Disclosure label="高级：手动填写访问令牌（仅排障使用）">
            <label class="field credential-field">
              <span>访问令牌 <small>{{ env.hasToken ? '已保存，留空保留' : 'Bearer Token / jwt_token' }}</small></span>
              <div class="input-with-action">
                <input
                  v-model="env.token"
                  :type="reveal[env.id] ? 'text' : 'password'"
                  autocomplete="new-password"
                  :placeholder="env.hasToken ? '输入新令牌可替换当前令牌' : '仅在无法浏览器登录时手动粘贴 jwt_token'"
                />
                <button type="button" class="icon-button" :aria-label="reveal[env.id] ? '隐藏令牌' : '显示令牌'" @click="reveal[env.id] = !reveal[env.id]">
                  <EyeOff v-if="reveal[env.id]" :size="18" /><Eye v-else :size="18" />
                </button>
              </div>
            </label>
          </Disclosure>

          <label class="check-label"><input v-model="env.delivery.enabled" type="checkbox" />启用跨环境交付</label>
          <div v-if="env.delivery.enabled" class="delivery-config">
            <div class="delivery-inheritance-bar">
              <span>
                <template v-if="hasEnvDeliveryOverride(env)">
                  当前使用此环境自定义迁移配置 · <code>{{ envEffectiveEndpoint(env) }}</code>
                </template>
                <template v-else>
                  当前继承全局默认迁移服务 · <code>{{ envEffectiveEndpoint(env) }}</code>
                </template>
              </span>
              <button
                v-if="hasEnvDeliveryOverride(env)"
                type="button"
                class="text-action"
                @click="clearEnvDeliveryOverride(env)"
              >
                <RotateCcw :size="13" />恢复使用全局默认
              </button>
            </div>
            <p v-if="!envEffectiveHasToken(env)" class="alert info">
              <span>尚未配置可用迁移令牌：请在页面上方「默认跨环境迁移服务」配置一次默认令牌，或在下方展开「自定义迁移接口与令牌」单独填写。</span>
            </p>
            <div class="form-grid">
              <label class="field">
                <span>默认交付偏好</span>
                <BaseSelect
                  :model-value="env.delivery.auto ? 'auto' : 'manual'"
                  @update:model-value="v => env.delivery.auto = v === 'auto'"
                  :options="[
                    { value: 'manual', label: '默认关闭（完成后按需手动发起）' },
                    { value: 'auto', label: '默认开启（完成后自动交付）' },
                  ]"
                />
              </label>
              <label class="field">
                <span>迁移接口超时（秒）</span>
                <input v-model.number="env.delivery.timeoutSeconds" class="input" type="number" min="30" max="900" required />
              </label>
            </div>
            <label class="check-label"><input v-model="env.delivery.requirePassed" type="checkbox" />存在源站评测时，需评测通过后才允许交付</label>
            <label class="check-label"><input v-model="env.delivery.verifyWithAi" type="checkbox" />迁移后启用 AI 双端截图核验</label>
            <Disclosure
              :label="hasEnvDeliveryOverride(env) ? '自定义迁移接口与令牌（已覆盖全局默认）' : '自定义迁移接口与令牌（可选覆盖）'"
              :open="hasEnvDeliveryOverride(env)"
            >
              <div class="delivery-override-fields">
                <label class="field">
                  <span>迁移接口（可选覆盖）</span>
                  <input
                    v-model="env.delivery.endpoint"
                    type="url"
                    class="input"
                    :placeholder="`留空继承默认：${effectiveDefaultEndpoint}`"
                  />
                </label>
                <div class="field">
                  <span>
                    迁移服务令牌（可选覆盖）
                    <small>{{ env.delivery.hasCustomToken ? '已保存独立令牌，留空保留' : '留空继承全局默认令牌' }}</small>
                  </span>
                  <div class="input-with-action">
                    <input
                      v-model="env.delivery.token"
                      :type="reveal[`delivery:${env.id}`] ? 'text' : 'password'"
                      autocomplete="new-password"
                      :placeholder="env.delivery.hasCustomToken ? '输入新令牌可替换独立覆盖' : '留空继承全局默认令牌'"
                    />
                    <button
                      type="button"
                      class="icon-button"
                      :aria-label="reveal[`delivery:${env.id}`] ? '隐藏迁移令牌' : '显示迁移令牌'"
                      @click="reveal[`delivery:${env.id}`] = !reveal[`delivery:${env.id}`]"
                    >
                      <EyeOff v-if="reveal[`delivery:${env.id}`]" :size="18" /><Eye v-else :size="18" />
                    </button>
                  </div>
                  <label v-if="env.delivery.hasCustomToken" class="checkbox-field">
                    <input v-model="env.delivery.clearToken" type="checkbox" />清除独立令牌（恢复继承全局默认）
                  </label>
                </div>
              </div>
            </Disclosure>
            <p class="text-muted small-text">关闭 AI 双端截图核验后，迁移完成仅执行目标站 HTTP 可达性检查（不启动浏览器截图与模型评审，零额外 token）。创建任务时可按单次任务覆盖交付偏好。交付去向由迁移服务决定，保留源站；结果不确定时先核查回执。</p>
          </div>

          <div class="inline-actions">
            <button type="button" class="button secondary small" :disabled="domainConnectionChanged(env) || !env.hasToken || !!testing" @click="testConnection(env.id)">
              <LoaderCircle v-if="testing === env.id" class="spin" :size="16" /><Cable v-else :size="16" />测试连接
            </button>
            <span v-if="testMessages[env.id]" :class="testMessages[env.id].ok ? 'success-text' : 'error-text'" role="status">{{ testMessages[env.id].text }}</span>
            <span v-else-if="domainConnectionChanged(env)" class="text-muted small-text">保存当前环境连接变更后可测试连接</span>
            <span v-else-if="!env.hasToken" class="text-muted small-text">请先完成登录连接</span>
          </div>
        </div>
      </section>

      <div v-if="form.environments.length" class="bottom-add-row">
        <button type="button" class="button secondary" @click="addEnvironment()"><Plus :size="17" />添加环境</button>
      </div>
      <p class="page-footnote">环境地址需与插件所报地址一致。浏览器登录或账号登录均会本地加密保存访问凭据，不保存密码。</p>
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
          <label class="field full-width"><span>Responses 接口</span><input v-model="form.model.endpoint" type="url" class="input" placeholder="https://api.deepseek.com/responses" /><p>填写支持图片输入与 JSON 输出的兼容接口完整地址</p></label>
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

    <div v-if="dirty || saving" class="settings-sticky-bar" role="region" aria-label="未保存设置操作栏">
      <span class="sticky-dirty-state"><i />有未保存的设置修改（快捷键 ⌘S / Ctrl+S）</span>
      <div class="toolbar-actions">
        <button type="button" class="button secondary" :disabled="saving" @click="discardChanges()">放弃修改</button>
        <button type="submit" class="button primary" :disabled="!dirty || saving || modelTesting">
          <LoaderCircle v-if="saving" class="spin" :size="17" /><Save v-else :size="17" />{{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>
  </form>
  <KoobooLoginDialog
    ref="loginDialog"
    @connected="loginConnected"
    @switch-to-browser="browserLoginDialog?.open($event)"
  />
  <KoobooBrowserLoginDialog
    ref="browserLoginDialog"
    @connected="loginConnected"
    @use-origin="applyBrowserOrigin"
  />
</template>

<style scoped>
.defaults-panel { display: flex; flex-direction: column; gap: 14px; }
.defaults-panel .section-heading { margin-bottom: 0; }
.defaults-summary { margin: 0; line-height: 1.7; }
.defaults-fields { padding-top: 6px; border-top: 1px solid var(--line); }
.adopt-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #eff4ff;
  color: #2f4369;
  font-size: 13px;
}
.adopt-banner > span { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.env-card-head { margin-bottom: 0; }
.env-collapse-trigger {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  flex: 1;
  text-align: left;
  padding: 4px 0;
}
.env-collapse-trigger h2 { margin: 0; }
.env-title-group { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.env-meta-chip {
  font-size: 11px;
  color: var(--muted);
  background: var(--field);
  padding: 3px 8px;
  border-radius: 6px;
}
.env-card-body { margin-top: 20px; display: flex; flex-direction: column; gap: 18px; }
.env-card-body > .field,
.env-card-body > .check-label,
.env-card-body > .inline-actions,
.env-card-body > .connection-login { margin-top: 0; margin-block: 0; }
.connection-login { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.login-mode-hint { margin: -8px 0 0; }
.delivery-config { display: flex; flex-direction: column; gap: 16px; padding: 20px; background: var(--field); border-radius: 12px; }
.delivery-config > .alert { margin: 0; }
.delivery-config > .check-label { margin-block: 0; }
.delivery-inheritance-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 12px;
  color: #536078;
}
.delivery-override-fields { display: flex; flex-direction: column; gap: 16px; }
.delivery-config .input, .delivery-config :deep(.ui-select-trigger) { background: var(--paper); }
.delivery-config .input-with-action { background: var(--paper); border-color: #dfe5ef; }
.delivery-config .input:not(:focus), .delivery-config :deep(.ui-select-trigger:not(:focus-visible):not(.is-open):not(.is-invalid)) { border-color: #dfe5ef; }
.bottom-add-row { display: flex; justify-content: flex-start; margin-bottom: 12px; }
.settings-sticky-bar {
  position: sticky;
  bottom: 16px;
  z-index: 15;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 18px;
  background: #fff;
  border: 1px solid #dbe3f0;
  border-radius: 14px;
  padding: 13px 18px;
  box-shadow: 0 10px 28px #18213114;
}
.sticky-dirty-state { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #36455e; font-weight: 500; }
.sticky-dirty-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--orange); }
</style>
