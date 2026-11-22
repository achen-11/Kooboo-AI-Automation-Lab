<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Check, LoaderCircle, Plus, ShieldCheck, X } from '@lucide/vue';
import { api, message } from '../../api';
import { notify } from '../../lib/notifications';
import {
  activeScenarios,
  type MaterialFile,
  type Scenario,
  type Scope,
} from '../../../../shared/automation';
import {
  CHECK_RULE_ID_PATTERN,
  checkRuleCategoryPrefixes,
  type CheckRuleCategoryPrefix,
  type CheckRuleSeverity,
  type CheckerCheckRule,
  type CheckerChecksSnapshot,
} from '../../../../shared/checker-checks';

export interface PromoteCheckRuleOptions {
  reportTaskId: string;
  rootTaskId?: string;
  scenario?: Scenario;
  scope?: Scope;
  siteUrl?: string;
  artifacts: MaterialFile[];
  prefillIssue?: {
    severity: 'critical' | 'major' | 'minor';
    title: string;
    detail: string;
    evidence: string[];
  };
}

const emit = defineEmits<{ saved: [rule: CheckerCheckRule] }>();

const dialog = ref<HTMLDialogElement>();
const loadingMeta = ref(false);
const busy = ref(false);
const error = ref('');

const mode = ref<'new-rule' | 'append-exemption'>('new-rule');
const current = ref<PromoteCheckRuleOptions | null>(null);
const existingRules = ref<CheckerCheckRule[]>([]);
const suggestedIds = ref<Record<string, string>>({});

const categoryPrefix = ref<CheckRuleCategoryPrefix>('R-CONTENT');
const ruleId = ref('R-CONTENT-01');
const title = ref('');
const severity = ref<CheckRuleSeverity>('major');
const trigger = ref('');
const exemptionsText = ref('');
const criterionCap = ref<number | ''>(72);
const viewportCap = ref<number | ''>(78);
const actionText = ref('判定 Major；对应维度封顶 ≤ 72、视口封顶 ≤ 78，强制 quality=failed。');
const selectedScenarios = ref<Scenario[]>(['materials', 'upgrade', 'migration']);
const selectedScopes = ref<Scope[]>(['homepage', 'site']);
const rationale = ref('');

const targetRuleId = ref('R-VISUAL-01');
const newExemption = ref('');

const alsoCreateCalibration = ref(true);
const selectedEvidence = ref<string[]>([]);
const calViewport = ref<'desktop' | 'mobile' | 'both'>('desktop');
const calCriterionId = ref('sections');

const pngArtifacts = computed(() =>
  (current.value?.artifacts || []).filter(file => file.type === 'image/png'),
);

const selectedTargetRule = computed(() =>
  existingRules.value.find(r => r.id === targetRuleId.value) || existingRules.value[0],
);

watch(categoryPrefix, next => {
  if (suggestedIds.value[next]) {
    ruleId.value = suggestedIds.value[next];
  }
});

watch(severity, next => {
  if (mode.value !== 'new-rule') return;
  if (next === 'critical') {
    if (criterionCap.value === '' || criterionCap.value > 55) criterionCap.value = 55;
    if (viewportCap.value === '' || viewportCap.value > 55) viewportCap.value = 55;
    actionText.value = '判定 Critical；对应维度与视口封顶 ≤ 55，强制 quality=failed 且禁止 ready。';
  } else if (next === 'major') {
    criterionCap.value = 72;
    viewportCap.value = 78;
    actionText.value = '判定 Major；对应维度封顶 ≤ 72、视口封顶 ≤ 78，强制 quality=failed。';
  } else {
    criterionCap.value = '';
    viewportCap.value = '';
    actionText.value = '记为 Minor 并在修复清单指出具体问题与截图依据。';
  }
});

function artifactUrl(name: string) {
  if (!current.value?.reportTaskId) return '';
  return `/api/v1/automation/reports/${encodeURIComponent(current.value.reportTaskId)}/artifacts/${encodeURIComponent(name)}`;
}

function toggleEvidence(name: string) {
  const idx = selectedEvidence.value.indexOf(name);
  if (idx >= 0) selectedEvidence.value.splice(idx, 1);
  else if (selectedEvidence.value.length < 10) selectedEvidence.value.push(name);
}

async function open(options: PromoteCheckRuleOptions) {
  current.value = options;
  error.value = '';
  mode.value = 'new-rule';
  alsoCreateCalibration.value = true;
  newExemption.value = '';

  const issue = options.prefillIssue;
  title.value = issue?.title || '';
  trigger.value = issue ? `${issue.title}：${issue.detail}`.slice(0, 1200) : '';
  severity.value = issue?.severity || 'major';
  exemptionsText.value = '';
  rationale.value = issue
    ? `源于报告 ${options.reportTaskId} 人工复核问题「${issue.title}」，固化为前置红线规则。`
    : `源于报告 ${options.reportTaskId} 人工复核反馈。`;

  const issueText = `${issue?.title || ''} ${issue?.detail || ''}`;
  if (/svg|图片|主图|招牌|logo|摄影|配图/i.test(issueText)) categoryPrefix.value = 'R-VISUAL';
  else if (/布局|溢出|遮挡|换行|断行|菜单|页脚|导航|对齐/i.test(issueText)) categoryPrefix.value = 'R-LAYOUT';
  else if (/完整|漏|未验|页面|清单/i.test(issueText)) categoryPrefix.value = 'R-COVER';
  else categoryPrefix.value = 'R-CONTENT';

  selectedScenarios.value = options.scenario
    ? [...new Set<Scenario>(['materials', 'upgrade', 'migration', options.scenario])].filter(
        s => s in activeScenarios || s === options.scenario,
      )
    : (Object.keys(activeScenarios) as Scenario[]);
  selectedScopes.value = options.scope === 'site' ? ['site'] : ['homepage', 'site'];

  const validPngNames = new Set(options.artifacts.filter(f => f.type === 'image/png').map(f => f.name));
  const prefilled = (issue?.evidence || []).filter(name => validPngNames.has(name));
  selectedEvidence.value = prefilled.length
    ? prefilled.slice(0, 4)
    : options.artifacts.filter(f => f.type === 'image/png').slice(0, 2).map(f => f.name);

  const firstSelected = options.artifacts.find(f => f.name === selectedEvidence.value[0]);
  calViewport.value = firstSelected?.viewport === 'mobile' ? 'mobile' : 'desktop';
  calCriterionId.value = /hero|首屏/i.test(issueText) ? 'hero' : /布局|导航|结构|菜单/i.test(issueText) ? 'structure' : 'sections';

  dialog.value?.showModal();
  loadingMeta.value = true;
  try {
    const res = await api<{ snapshot: CheckerChecksSnapshot; suggestedIds: Record<string, string> }>('/automation/checks');
    existingRules.value = res.snapshot.rules;
    suggestedIds.value = res.suggestedIds;
    if (res.suggestedIds[categoryPrefix.value]) {
      ruleId.value = res.suggestedIds[categoryPrefix.value];
    }
    if (res.snapshot.rules.length) {
      targetRuleId.value = res.snapshot.rules[0].id;
    }
  } catch (reason) {
    error.value = message(reason);
  } finally {
    loadingMeta.value = false;
  }
}

function close() {
  if (!busy.value) dialog.value?.close();
}

async function submit() {
  if (!current.value || busy.value) return;
  error.value = '';
  const scenario = current.value.scenario || 'materials';
  const scope = current.value.scope || 'homepage';

  if (mode.value === 'append-exemption') {
    const target = selectedTargetRule.value;
    if (!target) {
      error.value = '请选择要追加豁免的现有规则';
      return;
    }
    const exemptionLine = newExemption.value.trim();
    if (!exemptionLine) {
      error.value = '请填写要追加的豁免条款';
      return;
    }
    busy.value = true;
    try {
      const res = await api<{ rule: CheckerCheckRule }>(`/automation/checks/${encodeURIComponent(target.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          revision: target.revision,
          reason: rationale.value.trim() || `从报告 ${current.value.reportTaskId} 人工复核追加误判豁免`,
          appendExemption: exemptionLine,
          sourceReportId: current.value.reportTaskId,
          ...(current.value.rootTaskId ? { sourceTaskId: current.value.rootTaskId } : {}),
          ...(current.value.siteUrl ? { sourceSiteUrl: current.value.siteUrl } : {}),
          reviewKind: 'false-positive',
          ...(alsoCreateCalibration.value
            ? {
                calibration: {
                  title: `${target.id} 误判豁免：${exemptionLine}`.slice(0, 180),
                  kind: 'should-pass',
                  scenario,
                  scope,
                  sourceReportId: current.value.reportTaskId,
                  ...(current.value.rootTaskId ? { sourceTaskId: current.value.rootTaskId } : {}),
                  ...(current.value.siteUrl ? { sourceSiteUrl: current.value.siteUrl } : {}),
                  evidenceFiles: selectedEvidence.value,
                  notes: rationale.value.trim() || `人工判定为合理豁免：${exemptionLine}`,
                  viewport: calViewport.value,
                  criterionId: calCriterionId.value || 'sections',
                  expected: {
                    quality: 'passed',
                    minDesktopScore: 85,
                    requireRuleInPrompt: true,
                    expectedExemptionText: exemptionLine.slice(0, 120),
                  },
                },
              }
            : {}),
        }),
      });
      dialog.value?.close();
      notify.success(`已为 ${res.rule.id} 追加豁免条款并保存为 rev ${res.rule.revision}`);
      emit('saved', res.rule);
    } catch (reason) {
      error.value = message(reason);
    } finally {
      busy.value = false;
    }
    return;
  }

  const normalizedId = ruleId.value.trim().toUpperCase();
  if (!CHECK_RULE_ID_PATTERN.test(normalizedId)) {
    error.value = '规则编号需符合 R-<类别>-<2~3位数字>，例如 R-CONTENT-01';
    return;
  }
  if (!title.value.trim() || !trigger.value.trim() || !actionText.value.trim()) {
    error.value = '请填写完整的规则标题、触发条件与裁决动作';
    return;
  }
  if (!selectedScenarios.value.length || !selectedScopes.value.length) {
    error.value = '请至少选择一个适用场景和适用范围';
    return;
  }

  const parsedCriterionCap = criterionCap.value === '' ? null : Number(criterionCap.value);
  const parsedViewportCap = viewportCap.value === '' ? null : Number(viewportCap.value);
  const exemptions = exemptionsText.value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  busy.value = true;
  try {
    const res = await api<{ rule: CheckerCheckRule }>('/automation/checks', {
      method: 'POST',
      body: JSON.stringify({
        rule: {
          id: normalizedId,
          title: title.value.trim(),
          severity: severity.value,
          trigger: trigger.value.trim(),
          exemptions,
          criterionCap: parsedCriterionCap,
          viewportCap: parsedViewportCap,
          action: actionText.value.trim(),
          scenarios: selectedScenarios.value,
          scopes: selectedScopes.value,
          enabled: true,
          sourceReportId: current.value.reportTaskId,
          ...(current.value.rootTaskId ? { sourceTaskId: current.value.rootTaskId } : {}),
          ...(current.value.siteUrl ? { sourceSiteUrl: current.value.siteUrl } : {}),
          reviewKind: 'missed-defect',
          rationale: rationale.value.trim(),
        },
        reason: rationale.value.trim() || `从报告 ${current.value.reportTaskId} 人工复核沉淀规则`,
        ...(alsoCreateCalibration.value
          ? {
              calibration: {
                title: `${normalizedId} · ${title.value.trim()}`.slice(0, 180),
                kind: 'should-catch',
                scenario,
                scope,
                sourceReportId: current.value.reportTaskId,
                ...(current.value.rootTaskId ? { sourceTaskId: current.value.rootTaskId } : {}),
                ...(current.value.siteUrl ? { sourceSiteUrl: current.value.siteUrl } : {}),
                evidenceFiles: selectedEvidence.value,
                notes: trigger.value.trim(),
                viewport: calViewport.value,
                criterionId: calCriterionId.value || null,
                simulatedIssue: {
                  severity: severity.value,
                  title: title.value.trim(),
                  detail: trigger.value.trim().slice(0, 1800),
                  ruleId: normalizedId,
                  viewport: calViewport.value,
                  criterionId: calCriterionId.value || null,
                },
              },
            }
          : {}),
      }),
    });
    dialog.value?.close();
    notify.success(`已沉淀红线规则 ${res.rule.id}${alsoCreateCalibration.value ? ' 及回归标定反例' : ''}`);
    emit('saved', res.rule);
  } catch (reason) {
    error.value = message(reason);
  } finally {
    busy.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal promote-rule-modal" @cancel="!busy || $event.preventDefault()">
    <form @submit.prevent="submit">
      <div class="modal-head">
        <div class="promote-head-title">
          <ShieldCheck :size="20" />
          <h2>沉淀为 CHECKS.md 规则（一错一规）</h2>
        </div>
        <button type="button" class="icon-button" :disabled="busy" aria-label="关闭" @click="close">
          <X :size="20" />
        </button>
      </div>

      <div class="segmented view-tabs promote-mode-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'new-rule'"
          :class="{ selected: mode === 'new-rule' }"
          @click="mode = 'new-rule'"
        >
          新增红线规则（漏判 / 虚高）
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="mode === 'append-exemption'"
          :class="{ selected: mode === 'append-exemption' }"
          @click="mode = 'append-exemption'"
        >
          追加规则豁免（误判纠偏）
        </button>
      </div>

      <p v-if="loadingMeta" class="text-muted small-text"><LoaderCircle class="spin" :size="14" />正在加载已有红线规则…</p>

      <template v-if="mode === 'new-rule'">
        <div class="form-grid three-columns">
          <label class="field">
            <span>规则类别</span>
            <select v-model="categoryPrefix" class="input">
              <option v-for="(label, key) in checkRuleCategoryPrefixes" :key="key" :value="key">
                {{ key }} · {{ label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>规则编号</span>
            <input v-model="ruleId" class="input" required placeholder="R-CONTENT-01" />
          </label>
          <label class="field">
            <span>默认严重度</span>
            <select v-model="severity" class="input">
              <option value="critical">Critical（严重阻断）</option>
              <option value="major">Major（主要缺陷）</option>
              <option value="minor">Minor（次要瑕疵）</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>规则标题（简明总结错误模式）</span>
          <input v-model="title" class="input" required maxlength="200" placeholder="例如：公开页面与页脚严禁残留内部制作口径文案" />
        </label>

        <label class="field">
          <span>触发条件（明确什么画面或内容即命中该红线）</span>
          <textarea v-model="trigger" class="input" rows="3" required placeholder="描述在截图中可观测的触发特征" />
        </label>

        <div class="form-grid three-columns">
          <label class="field">
            <span>维度封顶（留空则不封顶）</span>
            <input v-model.number="criterionCap" class="input" type="number" min="0" max="100" step="1" placeholder="例如 72" />
          </label>
          <label class="field">
            <span>视口总分封顶（留空则按默认）</span>
            <input v-model.number="viewportCap" class="input" type="number" min="0" max="100" step="1" placeholder="例如 78" />
          </label>
          <label class="field">
            <span>关联评分维度 ID（用于封顶）</span>
            <select v-model="calCriterionId" class="input">
              <option value="hero">hero（Hero 首屏）</option>
              <option value="structure">structure（页面结构）</option>
              <option value="sections">sections（其他区段）</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>裁决与封顶动作说明</span>
          <input v-model="actionText" class="input" required maxlength="500" />
        </label>

        <label class="field">
          <span>明确豁免场景（每行一条，可选）</span>
          <textarea v-model="exemptionsText" class="input" rows="2" placeholder="例如：品牌名称本身包含外文标识" />
        </label>

        <div class="criterion-options promote-scope-row">
          <span>适用场景：</span>
          <label v-for="(label, key) in activeScenarios" :key="key" class="check-label">
            <input v-model="selectedScenarios" type="checkbox" :value="key" />{{ label }}
          </label>
          <span>范围：</span>
          <label class="check-label"><input v-model="selectedScopes" type="checkbox" value="homepage" />仅首页</label>
          <label class="check-label"><input v-model="selectedScopes" type="checkbox" value="site" />全站</label>
        </div>
      </template>

      <template v-else>
        <label class="field">
          <span>目标红线规则</span>
          <select v-model="targetRuleId" class="input">
            <option v-for="rule in existingRules" :key="rule.id" :value="rule.id">
              {{ rule.id }} · {{ rule.title }}（rev {{ rule.revision }}）
            </option>
          </select>
        </label>
        <div v-if="selectedTargetRule" class="promote-exemption-box">
          <strong>当前已有豁免：</strong>
          <ul v-if="selectedTargetRule.exemptions.length" class="task-text-list">
            <li v-for="ex in selectedTargetRule.exemptions" :key="ex">{{ ex }}</li>
          </ul>
          <span v-else class="text-muted small-text">暂无豁免条款</span>
        </div>
        <label class="field">
          <span>新增豁免条款</span>
          <input v-model="newExemption" class="input" required maxlength="400" placeholder="例如：咖啡豆原产地英文烘焙标识属正当专业标注，不按 R-VISUAL-02 扣分" />
        </label>
      </template>

      <label class="field">
        <span>人工复核理由 / 变更说明</span>
        <input v-model="rationale" class="input" maxlength="1000" placeholder="说明本次为何沉淀或修订规则" />
      </label>

      <label class="disposition-check">
        <input v-model="alsoCreateCalibration" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时沉淀为自动回归标定反例（{{ mode === 'new-rule' ? '应拦截 should-catch' : '应放行 should-pass' }}）</strong>
          <span>绑定本次报告截图作为回归测试夹具；后续修改规则或调整 Prompt 时可一键回归验证。</span>
        </div>
      </label>

      <div v-if="alsoCreateCalibration && pngArtifacts.length" class="promote-evidence-picker">
        <div class="promote-evidence-head">
          <span>绑定截图证据（已选 {{ selectedEvidence.length }} 张）</span>
          <label class="promote-vp-select">
            <span>视口：</span>
            <select v-model="calViewport" class="input small-input">
              <option value="desktop">PC（desktop）</option>
              <option value="mobile">移动端（mobile）</option>
              <option value="both">双端（both）</option>
            </select>
          </label>
        </div>
        <div class="promote-evidence-grid">
          <button
            v-for="file in pngArtifacts.slice(0, 12)"
            :key="file.name"
            type="button"
            class="promote-thumb"
            :class="{ selected: selectedEvidence.includes(file.name) }"
            @click="toggleEvidence(file.name)"
          >
            <img :src="artifactUrl(file.name)" :alt="file.name" loading="lazy" />
            <span>{{ file.viewport || 'unknown' }} · {{ file.role || 'target' }}</span>
          </button>
        </div>
      </div>

      <p v-if="error" class="alert error" role="alert">{{ error }}</p>

      <div class="modal-actions">
        <button type="button" class="button secondary" :disabled="busy" @click="close">取消</button>
        <button class="button primary" :disabled="busy">
          <LoaderCircle v-if="busy" class="spin" :size="16" />
          <Plus v-else-if="mode === 'new-rule'" :size="16" />
          <Check v-else :size="16" />
          {{ mode === 'new-rule' ? '保存到 CHECKS.md 规则库' : '追加豁免并生成新版本' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.promote-rule-modal { max-width: 780px; width: min(780px, calc(100vw - 32px)); }
.promote-rule-modal form { display: flex; flex-direction: column; gap: 12px; }
.promote-head-title { display: inline-flex; align-items: center; gap: 8px; }
.promote-head-title h2 { margin: 0; font-size: 17px; }
.promote-mode-tabs { margin: 0; }
.promote-scope-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 13px; }
.promote-exemption-box { padding: 10px 12px; border-radius: 8px; background: var(--field); border: 1px solid var(--line); font-size: 13px; }
.promote-exemption-box strong { display: block; margin-bottom: 4px; }
.promote-evidence-picker { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 10px; background: var(--field); border: 1px solid var(--line); }
.promote-evidence-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; color: var(--muted); }
.promote-vp-select { display: inline-flex; align-items: center; gap: 6px; }
.small-input { padding: 4px 8px; font-size: 12px; width: auto; }
.promote-evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; max-height: 180px; overflow-y: auto; }
.promote-thumb { border: 2px solid transparent; border-radius: 8px; padding: 4px; background: var(--paper); cursor: pointer; display: flex; flex-direction: column; gap: 4px; text-align: left; }
.promote-thumb.selected { border-color: var(--blue); background: color-mix(in srgb, var(--blue) 8%, var(--paper)); }
.promote-thumb img { width: 100%; height: 64px; object-fit: cover; border-radius: 4px; }
.promote-thumb span { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
