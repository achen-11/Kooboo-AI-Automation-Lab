<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  ArrowDown,
  ArrowUp,
  Check,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from '@lucide/vue';
import type {
  TemplateCheckDefinition,
  TemplateCheckKind,
  TemplateChecklist,
  TemplateChecklistInput,
} from '../../../../shared/template-workflow';
import { formatDate, message } from '../../api';
import BaseSelect from '../../components/BaseSelect.vue';
import { notify } from '../../lib/notifications';
import {
  cloneChecklistForEdit,
  createBlankTemplateCheck,
  sanitizeTemplateChecklistInput,
  templateCheckKindNames,
  templateExecutorNames,
  templateSeverityNames,
  templateViewportNames,
  validateTemplateChecklist,
  type TemplateExecutor,
  type TemplateSeverity,
} from '../../lib/template-workflow';
import {
  fetchTemplateChecklists,
  publishTemplateChecklist,
} from '../../lib/template-workflow-client';
import { scopeName } from './common';
import { appendDesignerChecks } from '../../../../shared/template-design';

const DRAFT_KEY = 'automation-template-checklist-draft';

const items = ref<TemplateChecklist[]>([]);
const selectedId = ref('');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const unavailableReason = ref('');

const query = ref('');
const statusFilter = ref<'all' | 'enabled' | 'disabled' | 'required'>('all');
const executorFilter = ref<'' | TemplateExecutor>('');

const editing = ref(false);
const form = ref<TemplateChecklistInput>({ name: '', checks: [] });
const savedSnapshot = ref('');
const hasDraft = ref(false);

const dirty = computed(() => editing.value && JSON.stringify(form.value) !== savedSnapshot.value);
defineExpose({ dirty });

const selectedChecklist = computed(
  () => items.value.find(item => item.id === selectedId.value) || items.value[0] || null,
);
const isLatestSelected = computed(
  () => Boolean(selectedChecklist.value && items.value[0]?.id === selectedChecklist.value.id),
);

const enabledCount = computed(
  () => selectedChecklist.value?.checks.filter(item => item.enabled).length ?? 0,
);
const requiredCount = computed(
  () => selectedChecklist.value?.checks.filter(item => item.enabled && item.required).length ?? 0,
);

const hasActiveFilters = computed(
  () => Boolean(query.value.trim() || statusFilter.value !== 'all' || executorFilter.value),
);

const visibleChecks = computed(() => {
  const source = selectedChecklist.value?.checks || [];
  const q = query.value.trim().toLowerCase();
  return source.filter(check => {
    if (statusFilter.value === 'enabled' && !check.enabled) return false;
    if (statusFilter.value === 'disabled' && check.enabled) return false;
    if (statusFilter.value === 'required' && !check.required) return false;
    if (executorFilter.value && check.executor !== executorFilter.value) return false;
    if (q) {
      const text = [check.title, check.id, check.instruction, check.exceptions].join(' ').toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
});

const validation = computed(() => validateTemplateChecklist(form.value));

const versionOptions = computed(() =>
  items.value.map((item, idx) => ({
    value: item.id,
    label: `v${item.revision} · ${item.name}${idx === 0 ? '（当前默认）' : ''} · ${formatDate(item.createdAt)}`,
  })),
);

const kindOptions = Object.entries(templateCheckKindNames).map(([value, label]) => ({
  value: value as TemplateCheckKind,
  label,
}));

const executorOptions = Object.entries(templateExecutorNames).map(([value, label]) => ({
  value: value as TemplateExecutor,
  label,
}));

const severityOptions = Object.entries(templateSeverityNames).map(([value, label]) => ({
  value: value as TemplateSeverity,
  label,
}));

function clearFilters() {
  query.value = '';
  statusFilter.value = 'all';
  executorFilter.value = '';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await fetchTemplateChecklists();
    if (result.status === 'unavailable') {
      unavailableReason.value = result.reason;
      items.value = [];
      selectedId.value = '';
      return;
    }
    unavailableReason.value = '';
    items.value = result.data;
    if (!items.value.some(item => item.id === selectedId.value)) {
      selectedId.value = items.value[0]?.id || '';
    }
  } catch (reason) {
    error.value = message(reason);
  } finally {
    loading.value = false;
  }
}

function startEdit() {
  const base = selectedChecklist.value;
  form.value = base
    ? cloneChecklistForEdit(base)
    : { name: 'AI Site 区块检查 · 新版本', checks: [createBlankTemplateCheck([])] };
  savedSnapshot.value = JSON.stringify(form.value);
  editing.value = true;
  error.value = '';
}

function cancelEdit() {
  if (dirty.value && !window.confirm('放弃未发布的检查集修改？')) return;
  editing.value = false;
  error.value = '';
}

function addCheck() {
  if (form.value.checks.length >= 100) return;
  form.value.checks.push(createBlankTemplateCheck(form.value.checks));
}

function addDesignerChecks() {
  const checks = appendDesignerChecks(form.value.checks);
  if (checks.length > 100) { notify.error('加入设计规范后超过 100 项，请先移除不需要的检查项。'); return; }
  const added = checks.length - form.value.checks.length;
  form.value.checks = checks;
  notify.info(added ? `已加入 ${added} 组设计规范，发布新版本后生效。` : '当前检查集已包含设计规范。');
}

function removeCheck(index: number) {
  if (form.value.checks.length <= 1) return;
  form.value.checks.splice(index, 1);
}

function moveCheck(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= form.value.checks.length) return;
  const [moved] = form.value.checks.splice(index, 1);
  form.value.checks.splice(target, 0, moved);
}

function readLocalDraft(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(DRAFT_KEY) : null;
  } catch {
    return null;
  }
}

function writeLocalDraft(raw: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(DRAFT_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

function clearLocalDraft() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Ignore storage access errors in restricted environments
  }
}

function saveDraft() {
  if (!writeLocalDraft(JSON.stringify(form.value))) {
    error.value = '当前浏览器环境不支持本地存储草稿';
    return;
  }
  savedSnapshot.value = JSON.stringify(form.value);
  hasDraft.value = true;
  notify.info('本地草稿已暂存在此浏览器，尚未发布到服务端。');
}

function restoreDraft() {
  try {
    const raw = readLocalDraft();
    if (!raw) return;
    const parsed = JSON.parse(raw) as TemplateChecklistInput;
    if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.checks)) {
      throw new Error('草稿结构无效');
    }
    form.value = parsed;
    savedSnapshot.value = JSON.stringify(form.value);
    editing.value = true;
    error.value = '';
    notify.info('已恢复本地草稿，确认无误后需发布为新版本才会生效。');
  } catch {
    error.value = '本地草稿损坏或无法读取';
  }
}

function discardDraft() {
  clearLocalDraft();
  hasDraft.value = false;
  notify.info('已清除本地草稿');
}

async function publish() {
  if (busy.value || unavailableReason.value) return;
  if (!validation.value.valid) {
    error.value = validation.value.errors[0] || '请先修正检查项校验问题';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const payload = sanitizeTemplateChecklistInput(form.value);
    const created = await publishTemplateChecklist(payload);
    items.value = [created, ...items.value.filter(item => item.id !== created.id)];
    selectedId.value = created.id;
    editing.value = false;
    clearLocalDraft();
    hasDraft.value = false;
    notify.success(`已发布检查集 v${created.revision}，后续新建 AI Site 模板任务将冻结此版本。`);
  } catch (reason) {
    error.value = message(reason);
  } finally {
    busy.value = false;
  }
}

function severityBadgeClass(severity: TemplateCheckDefinition['severity']) {
  return severity === 'critical' ? 'bad' : severity === 'major' ? 'warning' : '';
}

onMounted(() => {
  hasDraft.value = Boolean(readLocalDraft());
  void load();
});
</script>

<template>
  <div class="checklist-manager">
    <div class="checklist-topbar">
      <p class="checklist-boundary">
        管理新建 AI Site 模板任务共享的通用检查项与容差；具体页面的语义区块、双端排列和内容对应保存在各任务的冻结参考基线中，不混入通用规则。
      </p>
      <div class="toolbar-actions">
        <template v-if="!editing">
          <button
            v-if="hasDraft"
            type="button"
            class="button secondary"
            @click="restoreDraft"
          >
            <History :size="16" />恢复本地草稿
          </button>
          <button
            type="button"
            class="button secondary"
            :disabled="loading"
            aria-label="刷新检查集版本"
            @click="load"
          >
            <RefreshCw :size="16" :class="{ spin: loading }" />刷新
          </button>
          <button
            type="button"
            class="button primary"
            :disabled="loading || Boolean(unavailableReason)"
            @click="startEdit"
          >
            <Pencil :size="16" />{{ selectedChecklist ? '编辑为新版本' : '创建检查集版本' }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="button secondary" :disabled="busy" @click="cancelEdit">
            <X :size="16" />取消
          </button>
          <button type="button" class="button secondary" :disabled="busy" @click="saveDraft">
            <Save :size="16" />暂存本地草稿
          </button>
          <button
            type="submit"
            class="button primary"
            form="template-checklist-form"
            :disabled="busy || !validation.valid || Boolean(unavailableReason)"
          >
            <LoaderCircle v-if="busy" class="spin" :size="16" />
            <Check v-else :size="16" />发布为新版本
          </button>
        </template>
      </div>
    </div>

    <p v-if="unavailableReason" class="alert info" role="status">
      <span>{{ unavailableReason }}</span>
      <button type="button" class="text-action" :disabled="loading" @click="load">重新检查</button>
    </p>
    <p v-if="error" class="alert error" role="alert">
      <span>{{ error }}</span>
      <button v-if="!editing" type="button" class="text-action" @click="load">重试</button>
    </p>

    <p v-if="loading && !items.length && !editing" class="section-loading" role="status">
      <LoaderCircle class="spin" :size="18" />正在加载模板通用检查集…
    </p>

    <!-- Read Mode -->
    <template v-else-if="!editing">
      <section v-if="selectedChecklist" class="panel settings-panel">
        <div class="checklist-version-row">
          <label class="field checklist-version-select">
            <span>已发布不可变版本</span>
            <BaseSelect
              v-model="selectedId"
              aria-label="选择模板检查集版本"
              :options="versionOptions"
            />
          </label>
          <div class="checklist-meta-pills">
            <span class="badge" :class="isLatestSelected ? 'good' : ''">
              {{ isLatestSelected ? '当前新任务默认冻结' : '历史快照版本' }}
            </span>
            <span class="badge">启用 {{ enabledCount }} / {{ selectedChecklist.checks.length }}</span>
            <span class="badge warning">必过 {{ requiredCount }} 项</span>
            <code class="checklist-hash" :title="selectedChecklist.hash">
              {{ selectedChecklist.hash.slice(0, 14) }}
            </code>
          </div>
        </div>

        <div class="checklist-filters">
          <label class="search-field checklist-search">
            <Search :size="16" />
            <input
              v-model="query"
              type="search"
              placeholder="按标题、检查项 ID、说明或例外筛选"
              aria-label="筛选检查项"
            />
          </label>
          <div class="segmented compact" role="group" aria-label="按检查项状态筛选">
            <button
              v-for="opt in ([
                ['all', '全部'],
                ['enabled', '已启用'],
                ['required', '必过项'],
                ['disabled', '已停用'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: statusFilter === opt[0] }"
              :aria-pressed="statusFilter === opt[0]"
              @click="statusFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>
          <div class="segmented compact" role="group" aria-label="按执行方式筛选">
            <button
              v-for="opt in ([
                ['', '全部执行方式'],
                ['script', '脚本核验'],
                ['hybrid', '脚本 + AI'],
                ['ai', 'AI 判断'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: executorFilter === opt[0] }"
              :aria-pressed="executorFilter === opt[0]"
              @click="executorFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>
          <button
            v-if="hasActiveFilters"
            type="button"
            class="text-action"
            @click="clearFilters"
          >
            <RotateCcw :size="13" />清除筛选
          </button>
        </div>

        <div v-if="visibleChecks.length" class="check-card-list">
          <article
            v-for="check in visibleChecks"
            :key="check.id"
            class="check-card"
            :class="{ 'is-disabled': !check.enabled }"
          >
            <div class="check-card-head">
              <div class="check-card-title">
                <h3>{{ check.title }}</h3>
                <code>{{ check.id }}</code>
                <span v-if="!check.enabled" class="badge">已停用</span>
                <span v-else-if="check.required" class="badge warning">必过项</span>
              </div>
              <div class="check-card-tags">
                <span class="badge" :class="severityBadgeClass(check.severity)">
                  {{ templateSeverityNames[check.severity] }}
                </span>
                <span class="badge">{{ templateCheckKindNames[check.kind] }}</span>
                <span class="badge executor-tag">{{ templateExecutorNames[check.executor] }}</span>
              </div>
            </div>

            <p class="check-instruction">{{ check.instruction }}</p>
            <p v-if="check.exceptions" class="check-exception">
              <strong>允许例外：</strong>{{ check.exceptions }}
            </p>

            <dl class="check-meta-bar">
              <div>
                <dt>适用范围</dt>
                <dd>{{ check.scopes.map(scopeName).join(' / ') }}</dd>
              </div>
              <div>
                <dt>适用视口</dt>
                <dd>{{ check.viewports.map(v => templateViewportNames[v]).join(' / ') }}</dd>
              </div>
              <div>
                <dt>像素容差</dt>
                <dd>{{ check.tolerancePx }} px</dd>
              </div>
              <div>
                <dt>汇总权重</dt>
                <dd>{{ check.weight }}</dd>
              </div>
            </dl>
          </article>
        </div>
        <div v-else class="empty-state compact-empty">
          <h2>没有匹配的检查项</h2>
          <p>当前筛选条件下无结果，可清除筛选查看全部 {{ selectedChecklist.checks.length }} 项检查。</p>
          <button type="button" class="button secondary small" @click="clearFilters">清除筛选</button>
        </div>
      </section>

      <section v-else-if="!unavailableReason && !error" class="panel empty-state">
        <h2>尚无已发布的模板检查集</h2>
        <p>发布首个通用检查集版本后，新建 AI Site 模板任务会自动冻结该版本。</p>
      </section>
    </template>

    <!-- Edit Mode -->
    <form
      v-else
      id="template-checklist-form"
      class="checklist-edit-stack"
      @submit.prevent="publish"
    >
      <section class="panel settings-panel">
        <div class="section-heading">
          <h2>编辑新检查集版本</h2>
          <button v-if="hasDraft" type="button" class="text-action" @click="discardDraft">
            清除已存本地草稿
          </button>
        </div>
        <p class="text-muted small-text checklist-publish-hint">
          发布后会生成不可变新版本（自动递增版本号），已创建任务的冻结检查集与历史评测结果不会改变。
        </p>
        <label class="field">
          <span>版本名称</span>
          <input
            v-model="form.name"
            class="input"
            maxlength="200"
            required
            placeholder="例如：AI Site 区块检查 v2"
          />
        </label>
        <ul v-if="validation.errors.length" class="checklist-validation-summary" role="alert">
          <li v-for="msg in validation.errors" :key="msg">{{ msg }}</li>
        </ul>
      </section>

      <section class="panel settings-panel">
        <div class="section-heading">
          <h2>检查项清单（{{ form.checks.length }}）</h2>
          <button type="button" class="button secondary small" @click="addDesignerChecks">加入设计规范</button>
          <button
            type="button"
            class="button secondary small"
            :disabled="form.checks.length >= 100"
            @click="addCheck"
          >
            <Plus :size="15" />添加检查项
          </button>
        </div>

        <article
          v-for="(check, index) in form.checks"
          :key="index"
          class="check-editor-card"
          :class="{ 'has-error': Boolean(validation.checkErrors[index]?.length) }"
        >
          <div class="check-editor-toolbar">
            <div class="check-editor-toggles">
              <span class="check-index">#{{ index + 1 }}</span>
              <label class="check-label">
                <input v-model="check.enabled" type="checkbox" />启用
              </label>
              <label class="check-label">
                <input v-model="check.required" type="checkbox" />必过项（失败不予达标）
              </label>
            </div>
            <div class="check-editor-order">
              <button
                type="button"
                class="icon-button"
                :disabled="index === 0"
                :aria-label="`上移第 ${index + 1} 项`"
                title="上移"
                @click="moveCheck(index, -1)"
              >
                <ArrowUp :size="16" />
              </button>
              <button
                type="button"
                class="icon-button"
                :disabled="index === form.checks.length - 1"
                :aria-label="`下移第 ${index + 1} 项`"
                title="下移"
                @click="moveCheck(index, 1)"
              >
                <ArrowDown :size="16" />
              </button>
              <button
                type="button"
                class="icon-button danger-icon"
                :disabled="form.checks.length <= 1"
                :aria-label="`删除第 ${index + 1} 项`"
                title="删除检查项"
                @click="removeCheck(index)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>

          <div class="form-grid">
            <label class="field">
              <span>检查项标题</span>
              <input
                v-model="check.title"
                class="input"
                maxlength="200"
                required
                placeholder="例如：移动端正文边缘留白"
              />
            </label>
            <label class="field">
              <span>稳定标识 ID<small>小写字母、数字、连字符</small></span>
              <input
                v-model="check.id"
                class="input"
                maxlength="80"
                pattern="[a-z][a-z0-9-]{0,79}"
                required
                placeholder="例如：content-gutter"
              />
            </label>
          </div>

          <div class="form-grid check-editor-five-cols">
            <label class="field">
              <span>检查类别</span>
              <BaseSelect v-model="check.kind" :options="kindOptions" />
            </label>
            <label class="field">
              <span>执行方式</span>
              <BaseSelect v-model="check.executor" :options="executorOptions" />
            </label>
            <label class="field">
              <span>缺陷严重性</span>
              <BaseSelect v-model="check.severity" :options="severityOptions" />
            </label>
            <label class="field">
              <span>像素容差 (px)</span>
              <input
                v-model.number="check.tolerancePx"
                class="input"
                type="number"
                min="0"
                max="1000"
                step="1"
                required
              />
            </label>
            <label class="field">
              <span>权重</span>
              <input
                v-model.number="check.weight"
                class="input"
                type="number"
                min="0"
                max="100"
                step="0.1"
                required
              />
            </label>
          </div>

          <div class="criterion-options check-scope-row">
            <span>适用范围</span>
            <label class="check-label">
              <input v-model="check.scopes" type="checkbox" value="homepage" />仅首页
            </label>
            <label class="check-label">
              <input v-model="check.scopes" type="checkbox" value="site" />全站
            </label>
            <span class="scope-divider">适用视口</span>
            <label class="check-label">
              <input v-model="check.viewports" type="checkbox" value="desktop" />PC
            </label>
            <label class="check-label">
              <input v-model="check.viewports" type="checkbox" value="mobile" />移动端
            </label>
          </div>

          <label class="field check-textarea-field">
            <span>核验说明与预期标准</span>
            <textarea
              v-model="check.instruction"
              class="input"
              rows="3"
              maxlength="8000"
              required
              placeholder="说明脚本测量或 AI 按区块核验的判断标准；匹配不确定时保留未验证"
            />
          </label>

          <label class="field check-textarea-field">
            <span>正常例外说明<small>可选，防止机械误判正常设计</small></span>
            <textarea
              v-model="check.exceptions"
              class="input"
              rows="2"
              maxlength="4000"
              placeholder="例如：满宽背景图、横向轮播露出卡片、因替换文案长度变化产生的合理换行不判为缺陷"
            />
          </label>

          <ul v-if="validation.checkErrors[index]?.length" class="field-error-list" role="alert">
            <li v-for="err in validation.checkErrors[index]" :key="err">{{ err }}</li>
          </ul>
        </article>

        <div class="inline-actions">
          <button
            type="button"
            class="button secondary"
            :disabled="form.checks.length >= 100"
            @click="addCheck"
          >
            <Plus :size="16" />添加检查项
          </button>
        </div>
      </section>

      <div class="rule-actions">
        <span class="text-muted small-text">
          {{ validation.valid ? `共 ${form.checks.length} 项检查，启用 ${form.checks.filter(c => c.enabled).length} 项，校验通过` : validation.errors[0] }}
        </span>
        <div class="toolbar-actions">
          <button type="button" class="button secondary" :disabled="busy" @click="saveDraft">
            <Save :size="16" />暂存本地草稿
          </button>
          <button
            type="submit"
            class="button primary"
            :disabled="busy || !validation.valid || Boolean(unavailableReason)"
          >
            <LoaderCircle v-if="busy" class="spin" :size="16" />
            <Check v-else :size="16" />发布为新版本
          </button>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.checklist-topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.checklist-boundary {
  max-width: 780px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.checklist-version-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  flex-wrap: wrap;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.checklist-version-select {
  flex: 1 1 360px;
  max-width: 560px;
}
.checklist-meta-pills {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.checklist-hash {
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--field);
  color: var(--muted);
  font-size: 11px;
}
.checklist-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 18px 0;
}
.checklist-search {
  flex: 1 1 260px;
  max-width: 360px;
  min-height: 35px;
}
.checklist-search input {
  padding: 7px 0;
  font-size: 12px;
}
.check-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.check-card {
  padding: 18px 20px;
  border: 1px solid #e7ecf4;
  border-radius: 12px;
  background: var(--paper);
}
.check-card.is-disabled {
  opacity: 0.65;
  background: #fafbfd;
}
.check-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.check-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.check-card-title h3 {
  font-size: 15px;
  font-weight: 650;
}
.check-card-title code {
  font-size: 11px;
  color: var(--muted);
  background: var(--field);
  padding: 2px 7px;
  border-radius: 5px;
}
.check-card-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.executor-tag {
  color: #3b61bc;
  background: #edf2ff;
}
.check-instruction {
  margin-top: 10px;
  color: #3e4b5e;
  font-size: 13px;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.check-exception {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #f7f9fc;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.check-exception strong {
  color: #526079;
}
.check-meta-bar {
  display: flex;
  align-items: center;
  gap: 12px 28px;
  flex-wrap: wrap;
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
}
.check-meta-bar > div {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.check-meta-bar dt {
  color: var(--muted);
}
.check-meta-bar dd {
  margin: 0;
  font-weight: 550;
  color: #334155;
  font-variant-numeric: tabular-nums;
}
.compact-empty {
  min-height: 180px;
  padding: 32px 18px;
}
.checklist-edit-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.checklist-publish-hint {
  margin: -8px 0 16px;
  line-height: 1.7;
}
.checklist-validation-summary,
.field-error-list {
  margin: 14px 0 0;
  padding: 10px 14px 10px 30px;
  border-radius: 8px;
  background: #fceff1;
  color: var(--red);
  font-size: 12px;
  line-height: 1.7;
}
.check-editor-card {
  padding: 20px;
  border: 1px solid #e6ebf3;
  border-radius: 12px;
  margin-bottom: 14px;
  background: #fcfdff;
}
.check-editor-card.has-error {
  border-color: #ebb3ba;
}
.check-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.check-editor-toggles {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.check-index {
  font-weight: 700;
  color: var(--blue);
  font-variant-numeric: tabular-nums;
}
.check-editor-order {
  display: flex;
  align-items: center;
  gap: 4px;
}
.check-editor-five-cols {
  margin-top: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr)) 130px 110px;
}
.check-scope-row {
  margin-top: 16px;
}
.scope-divider {
  margin-left: 10px;
}
.check-textarea-field {
  margin-top: 16px;
}
@media (max-width: 1100px) {
  .check-editor-five-cols {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 750px) {
  .checklist-topbar {
    flex-direction: column;
  }
  .check-editor-five-cols {
    grid-template-columns: 1fr;
  }
  .checklist-search {
    max-width: none;
    width: 100%;
  }
}
</style>
