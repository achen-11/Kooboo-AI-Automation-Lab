<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Check,
  Copy,
  ExternalLink,
  History,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from '@lucide/vue';
import Disclosure from '../../components/Disclosure.vue';
import { api, formatDate, message } from '../../api';
import { notify } from '../../lib/notifications';
import { activeScenarios, type Scenario, type Scope } from '../../../../shared/automation';
import {
  CHECK_RULE_ID_PATTERN,
  checkRuleCategoryPrefixes,
  type CheckRuleCategoryPrefix,
  type CheckRuleSeverity,
  type CheckerCheckRevision,
  type CheckerCheckRule,
  type CheckerChecksSnapshot,
  type ChecksRegressionReport,
} from '../../../../shared/checker-checks';

const loading = ref(true);
const error = ref('');
const snapshot = ref<CheckerChecksSnapshot | null>(null);
const suggestedIds = ref<Record<string, string>>({});
const busyRuleId = ref('');

const regressionBusy = ref(false);
const regressionError = ref('');
const regressionReport = ref<ChecksRegressionReport | null>(null);

const editorDialog = ref<HTMLDialogElement>();
const editorBusy = ref(false);
const editorError = ref('');
const editorIsNew = ref(true);
const editingRevision = ref(1);
const categoryPrefix = ref<CheckRuleCategoryPrefix>('R-CONTENT');
const form = ref({
  id: 'R-CONTENT-01',
  title: '',
  severity: 'major' as CheckRuleSeverity,
  trigger: '',
  exemptionsText: '',
  criterionCap: 72 as number | '',
  viewportCap: 78 as number | '',
  action: '判定 Major；对应维度封顶 ≤ 72、视口封顶 ≤ 78，强制 quality=failed。',
  scenarios: Object.keys(activeScenarios) as Scenario[],
  scopes: ['homepage', 'site'] as Scope[],
  enabled: true,
  rationale: '',
  reason: '',
});

const historyDialog = ref<HTMLDialogElement>();
const historyRuleId = ref('');
const historyRuleRevision = ref(1);
const historyItems = ref<CheckerCheckRevision[]>([]);
const historyLoading = ref(false);
const historyBusy = ref(false);
const historyError = ref('');

const dirty = computed(() => Boolean(editorDialog.value?.open));
defineExpose({ dirty, load });

const rules = computed(() => snapshot.value?.rules || []);
const calibrations = computed(() => snapshot.value?.calibrations || []);

const regressionMap = computed(() => {
  const map = new Map<string, ChecksRegressionReport['results'][number]>();
  for (const item of regressionReport.value?.results || []) {
    map.set(item.caseId, item);
  }
  return map;
});

function calibrationCount(ruleId: string) {
  return calibrations.value.filter(c => c.ruleId === ruleId).length;
}

function sourceLink(item: { sourceTaskId?: string; sourceReportId?: string }) {
  const id = item.sourceTaskId || item.sourceReportId;
  return id ? `#/tasks/${id}?tab=report` : '';
}

function selectCategoryPrefix(prefix: CheckRuleCategoryPrefix) {
  categoryPrefix.value = prefix;
  if (editorIsNew.value && suggestedIds.value[prefix]) {
    form.value.id = suggestedIds.value[prefix];
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api<{ snapshot: CheckerChecksSnapshot; suggestedIds: Record<string, string> }>(
      '/automation/checks',
    );
    snapshot.value = res.snapshot;
    suggestedIds.value = res.suggestedIds;
  } catch (reason) {
    error.value = message(reason);
  } finally {
    loading.value = false;
  }
}

async function runRegression() {
  if (regressionBusy.value) return;
  regressionBusy.value = true;
  regressionError.value = '';
  try {
    const report = await api<ChecksRegressionReport>('/automation/checks/regression', { method: 'POST' });
    regressionReport.value = report;
    if (report.failed === 0) {
      notify.success(`回归验证全部通过（${report.passed}/${report.total}）`);
    } else {
      notify.info(`回归验证完成：${report.passed} 通过，${report.failed} 失败`);
    }
  } catch (reason) {
    regressionError.value = message(reason);
  } finally {
    regressionBusy.value = false;
  }
}

async function copyMarkdown() {
  if (!snapshot.value?.markdown) return;
  try {
    await navigator.clipboard.writeText(snapshot.value.markdown);
    notify.success('已复制当前 CHECKS.md 快照');
  } catch {
    error.value = '浏览器剪贴板写入失败，请手动展开下方快照复制';
  }
}

function openCreate() {
  editorIsNew.value = true;
  editorError.value = '';
  categoryPrefix.value = 'R-CONTENT';
  form.value = {
    id: suggestedIds.value['R-CONTENT'] || 'R-CONTENT-01',
    title: '',
    severity: 'major',
    trigger: '',
    exemptionsText: '',
    criterionCap: 72,
    viewportCap: 78,
    action: '判定 Major；对应维度封顶 ≤ 72、视口封顶 ≤ 78，强制 quality=failed。',
    scenarios: Object.keys(activeScenarios) as Scenario[],
    scopes: ['homepage', 'site'],
    enabled: true,
    rationale: '',
    reason: '新增红线规则',
  };
  editorDialog.value?.showModal();
}

function openEdit(rule: CheckerCheckRule) {
  editorIsNew.value = false;
  editingRevision.value = rule.revision;
  editorError.value = '';
  form.value = {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    trigger: rule.trigger,
    exemptionsText: rule.exemptions.join('\n'),
    criterionCap: rule.criterionCap ?? '',
    viewportCap: rule.viewportCap ?? '',
    action: rule.action,
    scenarios: [...rule.scenarios],
    scopes: [...rule.scopes],
    enabled: rule.enabled,
    rationale: rule.rationale || '',
    reason: '',
  };
  editorDialog.value?.showModal();
}

function closeEditor() {
  if (!editorBusy.value) editorDialog.value?.close();
}

async function saveRule() {
  if (editorBusy.value) return;
  editorError.value = '';
  const id = form.value.id.trim().toUpperCase();
  if (!CHECK_RULE_ID_PATTERN.test(id)) {
    editorError.value = '规则编号须符合 R-<类别>-<数字> 格式（例如 R-CONTENT-01）';
    return;
  }
  const exemptions = form.value.exemptionsText
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  const criterionCap = form.value.criterionCap === '' ? null : Number(form.value.criterionCap);
  const viewportCap = form.value.viewportCap === '' ? null : Number(form.value.viewportCap);

  editorBusy.value = true;
  try {
    if (editorIsNew.value) {
      const res = await api<{
        rule: CheckerCheckRule;
        snapshot: CheckerChecksSnapshot;
        suggestedIds: Record<string, string>;
      }>('/automation/checks', {
        method: 'POST',
        body: JSON.stringify({
          rule: {
            id,
            title: form.value.title.trim(),
            severity: form.value.severity,
            trigger: form.value.trigger.trim(),
            exemptions,
            criterionCap,
            viewportCap,
            action: form.value.action.trim(),
            scenarios: form.value.scenarios,
            scopes: form.value.scopes,
            enabled: form.value.enabled,
            rationale: form.value.rationale.trim(),
          },
          reason: form.value.reason.trim() || '新建 CHECKS 红线规则',
        }),
      });
      snapshot.value = res.snapshot;
      suggestedIds.value = res.suggestedIds;
      editorDialog.value?.close();
      notify.success(`已新增红线规则 ${res.rule.id}`);
    } else {
      const res = await api<{
        rule: CheckerCheckRule;
        snapshot: CheckerChecksSnapshot;
        suggestedIds: Record<string, string>;
      }>(`/automation/checks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          revision: editingRevision.value,
          reason: form.value.reason.trim() || '修订 CHECKS 红线规则',
          title: form.value.title.trim(),
          severity: form.value.severity,
          trigger: form.value.trigger.trim(),
          exemptions,
          criterionCap,
          viewportCap,
          action: form.value.action.trim(),
          scenarios: form.value.scenarios,
          scopes: form.value.scopes,
          enabled: form.value.enabled,
          rationale: form.value.rationale.trim(),
        }),
      });
      snapshot.value = res.snapshot;
      suggestedIds.value = res.suggestedIds;
      editorDialog.value?.close();
      notify.success(`已保存 ${res.rule.id}（rev ${res.rule.revision}）`);
    }
  } catch (reason) {
    editorError.value = message(reason);
  } finally {
    editorBusy.value = false;
  }
}

async function toggleEnabled(rule: CheckerCheckRule) {
  if (busyRuleId.value) return;
  busyRuleId.value = rule.id;
  error.value = '';
  try {
    const res = await api<{
      rule: CheckerCheckRule;
      snapshot: CheckerChecksSnapshot;
      suggestedIds: Record<string, string>;
    }>(`/automation/checks/${encodeURIComponent(rule.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        revision: rule.revision,
        enabled: !rule.enabled,
        reason: rule.enabled ? '人工停用规则' : '人工重新启用规则',
      }),
    });
    snapshot.value = res.snapshot;
    suggestedIds.value = res.suggestedIds;
    notify.success(`已${res.rule.enabled ? '启用' : '停用'} ${res.rule.id}`);
  } catch (reason) {
    error.value = message(reason);
  } finally {
    busyRuleId.value = '';
  }
}

async function openHistory(rule: CheckerCheckRule) {
  historyRuleId.value = rule.id;
  historyRuleRevision.value = rule.revision;
  historyItems.value = [];
  historyError.value = '';
  historyDialog.value?.showModal();
  historyLoading.value = true;
  try {
    const res = await api<{ items: CheckerCheckRevision[] }>(
      `/automation/checks/${encodeURIComponent(rule.id)}/history`,
    );
    historyItems.value = res.items;
  } catch (reason) {
    historyError.value = message(reason);
  } finally {
    historyLoading.value = false;
  }
}

async function restoreRevision(fromRevision: number) {
  if (historyBusy.value || !historyRuleId.value) return;
  historyBusy.value = true;
  historyError.value = '';
  try {
    const res = await api<{
      rule: CheckerCheckRule;
      snapshot: CheckerChecksSnapshot;
      suggestedIds: Record<string, string>;
    }>(`/automation/checks/${encodeURIComponent(historyRuleId.value)}/restore`, {
      method: 'POST',
      body: JSON.stringify({
        revision: historyRuleRevision.value,
        from: fromRevision,
        reason: `人工恢复至 rev ${fromRevision}`,
      }),
    });
    snapshot.value = res.snapshot;
    suggestedIds.value = res.suggestedIds;
    historyDialog.value?.close();
    notify.success(`已将 ${res.rule.id} 恢复并创建 rev ${res.rule.revision}`);
  } catch (reason) {
    historyError.value = message(reason);
  } finally {
    historyBusy.value = false;
  }
}

async function removeCalibration(calId: string) {
  error.value = '';
  try {
    const res = await api<{ snapshot: CheckerChecksSnapshot }>(
      `/automation/checks/calibrations/${encodeURIComponent(calId)}`,
      { method: 'DELETE' },
    );
    snapshot.value = res.snapshot;
    if (regressionReport.value) {
      await runRegression();
    }
    notify.success('已删除人工标定反例');
  } catch (reason) {
    error.value = message(reason);
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="panel settings-panel">
    <div class="section-heading">
      <div>
        <h2><ShieldCheck :size="18" /> CHECKS.md 反模式红线库（一错一规）</h2>
        <p class="text-muted small-text">
          每次评测前宿主自动按场景与范围冻结当前启用规则为 `CHECKS.md`；可在任意评测报告问题下点击「沉淀为 CHECKS 规则」直接增补规则或豁免。
        </p>
      </div>
      <div class="toolbar-actions">
        <button type="button" class="button secondary" :disabled="regressionBusy || loading" @click="runRegression">
          <LoaderCircle v-if="regressionBusy" class="spin" :size="15" />
          <Play v-else :size="15" />
          运行回归验证
        </button>
        <button type="button" class="button secondary" :disabled="!snapshot" @click="copyMarkdown">
          <Copy :size="15" />复制 CHECKS.md
        </button>
        <button type="button" class="button primary" :disabled="loading" @click="openCreate">
          <Plus :size="15" />新建红线规则
        </button>
      </div>
    </div>

    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-if="loading && !snapshot" class="section-loading">
      <LoaderCircle class="spin" :size="17" />正在加载红线规则库…
    </p>

    <template v-if="snapshot">
      <div class="checks-meta-strip">
        <span class="status-badge">启用 {{ rules.filter(r => r.enabled).length }} / {{ rules.length }} 条规则</span>
        <span class="status-badge">标定反例 {{ calibrations.length }} 条</span>
        <span class="status-badge">快照指纹 <code>#{{ snapshot.hash.slice(0, 12) }}</code></span>
      </div>

      <div class="table-scroll">
        <table class="task-table checks-table">
          <thead>
            <tr>
              <th>规则编号 / 标题</th>
              <th>级别 / 封顶</th>
              <th>适用范围</th>
              <th>来源 / 标定</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in rules" :key="rule.id" :class="{ 'row-disabled': !rule.enabled }">
              <td class="wrapping-cell">
                <div class="checks-rule-id">
                  <code>{{ rule.id }}</code>
                  <span class="text-muted small-text">rev {{ rule.revision }}</span>
                </div>
                <strong>{{ rule.title }}</strong>
                <div class="table-subtitle">{{ rule.trigger }}</div>
                <div v-if="rule.exemptions.length" class="checks-exemptions">
                  豁免：{{ rule.exemptions.join('；') }}
                </div>
              </td>
              <td>
                <span
                  class="status-badge"
                  :class="rule.severity === 'minor' ? 'pending' : 'failed'"
                >
                  {{ rule.severity.toUpperCase() }}
                </span>
                <div class="table-subtitle">
                  维度 {{ rule.criterionCap !== null ? `≤ ${rule.criterionCap}` : '—' }} / 视口
                  {{ rule.viewportCap !== null ? `≤ ${rule.viewportCap}` : '—' }}
                </div>
              </td>
              <td>
                <div>{{ rule.scenarios.join(' / ') }}</div>
                <div class="table-subtitle">
                  {{ rule.scopes.map(s => (s === 'homepage' ? '首页' : '全站')).join(' / ') }}
                </div>
              </td>
              <td>
                <div>{{ rule.source === 'builtin' ? '内置种子' : '人工复核沉淀' }}</div>
                <div class="table-subtitle">标定反例 {{ calibrationCount(rule.id) }} 条</div>
                <a
                  v-if="sourceLink(rule)"
                  class="text-action small-link"
                  :href="sourceLink(rule)"
                >
                  来源报告<ExternalLink :size="12" />
                </a>
              </td>
              <td>
                <button
                  type="button"
                  class="text-action"
                  :disabled="busyRuleId === rule.id"
                  @click="toggleEnabled(rule)"
                >
                  {{ rule.enabled ? '已启用（点击停用）' : '已停用（点击启用）' }}
                </button>
              </td>
              <td>
                <div class="checks-row-actions">
                  <button type="button" class="text-action" @click="openEdit(rule)">
                    <Pencil :size="13" />编辑
                  </button>
                  <button type="button" class="text-action" @click="openHistory(rule)">
                    <History :size="13" />历史
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Disclosure :label="`CHECKS.md 冻结快照预览（#${snapshot.hash.slice(0, 10)}）`">
        <pre class="task-technical checks-md-pre">{{ snapshot.markdown }}</pre>
      </Disclosure>
    </template>
  </section>

  <section v-if="snapshot" class="panel settings-panel">
    <div class="section-heading">
      <div>
        <h2>自动回归标定反例（{{ calibrations.length }}）</h2>
        <p class="text-muted small-text">
          校验每条启用规则与豁免条款是否正确注入评测 Prompt，以及宿主封顶裁决是否严格阻断高分放行。
        </p>
      </div>
      <div v-if="regressionReport" class="checks-reg-summary">
        <span
          class="status-badge"
          :class="regressionReport.failed === 0 ? 'completed' : 'failed'"
        >
          确定性回归：{{ regressionReport.passed }} / {{ regressionReport.total }} 通过
        </span>
      </div>
    </div>

    <p v-if="regressionError" class="alert error" role="alert">{{ regressionError }}</p>
    <p v-if="regressionReport" class="alert info">{{ regressionReport.modeNote }}</p>

    <div class="table-scroll">
      <table class="task-table">
        <thead>
          <tr>
            <th>标定用例</th>
            <th>关联规则 / 期望</th>
            <th>证据与来源</th>
            <th>最近回归结果</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="cal in calibrations" :key="cal.id">
            <td class="wrapping-cell">
              <strong>{{ cal.title }}</strong>
              <div class="table-subtitle">{{ cal.notes }}</div>
            </td>
            <td>
              <code>{{ cal.ruleId }}</code>
              <span class="status-badge" :class="cal.kind === 'should-catch' ? 'failed' : 'completed'">
                {{ cal.kind === 'should-catch' ? '应拦截' : '豁免放行' }}
              </span>
              <div class="table-subtitle">
                {{ cal.scenario }} / {{ cal.scope === 'homepage' ? '首页' : '全站' }}
              </div>
            </td>
            <td>
              <div class="table-subtitle">
                {{ cal.evidenceFiles.length ? `${cal.evidenceFiles.length} 张截图` : '结构化模拟用例' }}
              </div>
              <a
                v-if="sourceLink(cal)"
                class="text-action small-link"
                :href="sourceLink(cal)"
              >
                来源报告<ExternalLink :size="12" />
              </a>
            </td>
            <td class="wrapping-cell">
              <template v-if="regressionMap.get(cal.id)">
                <span
                  class="status-badge"
                  :class="regressionMap.get(cal.id)!.passed ? 'completed' : 'failed'"
                >
                  {{ regressionMap.get(cal.id)!.passed ? '通过' : '失败' }}
                </span>
                <div class="table-subtitle">
                  实测 {{ regressionMap.get(cal.id)!.observedQuality }} ·
                  {{
                    regressionMap
                      .get(cal.id)!
                      .observedScores.map(s => `${s.viewport} ${s.value ?? '—'}`)
                      .join(' / ')
                  }}
                </div>
                <div
                  v-for="a in regressionMap.get(cal.id)!.assertions.filter(x => !x.passed)"
                  :key="a.name"
                  class="warning-text small-text"
                >
                  {{ a.name }}：{{ a.detail }}
                </div>
              </template>
              <span v-else class="text-muted small-text">点击右上「运行回归验证」</span>
            </td>
            <td>
              <button
                v-if="cal.source !== 'builtin'"
                type="button"
                class="icon-button danger-icon"
                aria-label="删除标定反例"
                @click="removeCalibration(cal.id)"
              >
                <Trash2 :size="15" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <dialog ref="editorDialog" class="modal promote-rule-modal" @cancel="!editorBusy || $event.preventDefault()">
    <form @submit.prevent="saveRule">
      <div class="modal-head">
        <h2>{{ editorIsNew ? '新建红线规则' : `编辑红线规则 ${form.id}（rev ${editingRevision}）` }}</h2>
        <button type="button" class="icon-button" :disabled="editorBusy" aria-label="关闭" @click="closeEditor">
          <X :size="20" />
        </button>
      </div>

      <div class="form-grid three-columns">
        <label v-if="editorIsNew" class="field">
          <span>规则类别</span>
          <select
            :value="categoryPrefix"
            class="input"
            @change="selectCategoryPrefix(($event.target as HTMLSelectElement).value as CheckRuleCategoryPrefix)"
          >
            <option v-for="(label, key) in checkRuleCategoryPrefixes" :key="key" :value="key">
              {{ key }} · {{ label }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>规则编号</span>
          <input v-model="form.id" class="input" :disabled="!editorIsNew" required />
        </label>
        <label class="field">
          <span>严重度</span>
          <select v-model="form.severity" class="input">
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span>规则标题</span>
        <input v-model="form.title" class="input" required maxlength="200" />
      </label>

      <label class="field">
        <span>触发条件</span>
        <textarea v-model="form.trigger" class="input" rows="3" required />
      </label>

      <div class="form-grid">
        <label class="field">
          <span>维度封顶（留空不封顶）</span>
          <input v-model.number="form.criterionCap" class="input" type="number" min="0" max="100" step="1" />
        </label>
        <label class="field">
          <span>视口总分封顶（留空不封顶）</span>
          <input v-model.number="form.viewportCap" class="input" type="number" min="0" max="100" step="1" />
        </label>
      </div>

      <label class="field">
        <span>裁决与封顶动作说明</span>
        <input v-model="form.action" class="input" required maxlength="500" />
      </label>

      <label class="field">
        <span>豁免条款（每行一条）</span>
        <textarea v-model="form.exemptionsText" class="input" rows="3" />
      </label>

      <div class="criterion-options promote-scope-row">
        <span>适用场景：</span>
        <label v-for="(label, key) in activeScenarios" :key="key" class="check-label">
          <input v-model="form.scenarios" type="checkbox" :value="key" />{{ label }}
        </label>
        <span>范围：</span>
        <label class="check-label"><input v-model="form.scopes" type="checkbox" value="homepage" />首页</label>
        <label class="check-label"><input v-model="form.scopes" type="checkbox" value="site" />全站</label>
        <label class="check-label"><input v-model="form.enabled" type="checkbox" />启用</label>
      </div>

      <label class="field">
        <span>变更说明（记录到版本历史）</span>
        <input v-model="form.reason" class="input" required maxlength="500" placeholder="说明本次变更原因" />
      </label>

      <p v-if="editorError" class="alert error" role="alert">{{ editorError }}</p>

      <div class="modal-actions">
        <button type="button" class="button secondary" :disabled="editorBusy" @click="closeEditor">取消</button>
        <button class="button primary" :disabled="editorBusy">
          <LoaderCircle v-if="editorBusy" class="spin" :size="16" />
          <Check v-else :size="16" />
          保存规则
        </button>
      </div>
    </form>
  </dialog>

  <dialog ref="historyDialog" class="modal promote-rule-modal" @cancel="!historyBusy || $event.preventDefault()">
    <div class="modal-head">
      <h2>版本历史 · {{ historyRuleId }}</h2>
      <button type="button" class="icon-button" :disabled="historyBusy" aria-label="关闭" @click="historyDialog?.close()">
        <X :size="20" />
      </button>
    </div>
    <p v-if="historyError" class="alert error" role="alert">{{ historyError }}</p>
    <p v-if="historyLoading" class="section-loading"><LoaderCircle class="spin" :size="16" />正在加载版本记录…</p>
    <div v-else class="history-list">
      <article v-for="rev in historyItems" :key="rev.revision" class="history-entry">
        <div class="history-entry-head">
          <strong>rev {{ rev.revision }} · {{ rev.actor === 'system' ? '系统初始化' : '人工复核' }}</strong>
          <span class="text-muted small-text">{{ formatDate(rev.createdAt) }}</span>
          <button
            v-if="rev.revision !== historyRuleRevision"
            type="button"
            class="text-action"
            :disabled="historyBusy"
            @click="restoreRevision(rev.revision)"
          >
            <RotateCcw :size="13" />恢复此版本
          </button>
          <span v-else class="status-badge completed">当前版本</span>
        </div>
        <div class="table-subtitle">{{ rev.reason }}</div>
        <div class="small-text">
          {{ rev.snapshot.severity.toUpperCase() }} · {{ rev.snapshot.title }} · 豁免 {{ rev.snapshot.exemptions.length }} 条
        </div>
      </article>
    </div>
  </dialog>
</template>

<style scoped>
.checks-meta-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.checks-table td { vertical-align: top; }
.checks-rule-id { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.checks-exemptions { margin-top: 4px; font-size: 12px; color: var(--muted); }
.checks-row-actions { display: flex; flex-direction: column; gap: 6px; }
.row-disabled { opacity: 0.65; }
.checks-md-pre { max-height: 360px; overflow-y: auto; margin-top: 8px; }
.small-link { font-size: 12px; margin-top: 4px; }
.promote-rule-modal { max-width: 780px; width: min(780px, calc(100vw - 32px)); }
.promote-rule-modal form { display: flex; flex-direction: column; gap: 12px; }
.promote-scope-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 13px; }
.history-list { display: flex; flex-direction: column; gap: 10px; max-height: 440px; overflow-y: auto; }
.history-entry { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--field); display: flex; flex-direction: column; gap: 4px; }
.history-entry-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.history-entry-head button, .history-entry-head .status-badge { margin-left: auto; }
</style>
