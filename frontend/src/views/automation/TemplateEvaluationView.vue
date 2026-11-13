<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  Image,
  Layers,
  LoaderCircle,
  RotateCcw,
  Search,
} from '@lucide/vue';
import type {
  TemplateCheckStatus,
  TemplateIssue,
  TemplateViewport,
  TemplateWorkflowResponse,
} from '../../../../shared/template-workflow';
import { formatDate } from '../../api';
import BaseSelect from '../../components/BaseSelect.vue';
import Disclosure from '../../components/Disclosure.vue';
import EvidenceViewer from '../../components/EvidenceViewer.vue';
import TablePagination from '../../components/TablePagination.vue';
import type { EvidenceContext } from '../../lib/evidence-preview';
import {
  appendUrlParam,
  buildPageViewCheckTree,
  mergeWorkflowEvidence,
  resolveTemplateEvidenceHref,
  shortRevision,
  summarizeTemplateEvaluation,
  templateCaptureModeNames,
  templateCheckStatusNames,
  templateEvidenceTitle,
  templateExecutorNames,
  templateIssueStatusNames,
  templateProvenanceNames,
  templateQualityNames,
  templateSeverityNames,
  templateViewportNames,
  toPreviewArtifacts,
  type EnrichedTemplateCheckResult,
  type TemplateProvenance,
  type TemplateSeverity,
} from '../../lib/template-workflow';

const props = defineProps<{
  workflow: TemplateWorkflowResponse;
  loading?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  retry: [];
  openBaseline: [target: { pagePath: string; viewId?: string }];
}>();

const evaluation = computed(() => props.workflow.evaluation);
const baseline = computed(() => props.workflow.baseline);
const checklist = computed(() => props.workflow.checklist);

const summary = computed(() =>
  evaluation.value ? summarizeTemplateEvaluation(evaluation.value, checklist.value) : null,
);

// Issue filters
const issueStatusFilter = ref<'all' | TemplateIssue['status']>('all');
const issueSeverityFilter = ref<'' | TemplateSeverity>('');
const issueViewportFilter = ref<'' | TemplateViewport>('');
const expandedIssueId = ref<string | null>(null);

// Check drill-down filters
const checkQuery = ref('');
const checkPageFilter = ref('');
const checkViewportFilter = ref<'' | TemplateViewport>('');
const checkStatusFilter = ref<'' | TemplateCheckStatus>('');
const checkProvenanceFilter = ref<'' | TemplateProvenance>('');
const highlightedCheckId = ref('');

// Gallery state (mounted only when opened, 12 images per page)
const galleryOpen = ref(false);
const galleryPage = ref(1);
const viewer = ref<InstanceType<typeof EvidenceViewer>>();

const allEvidence = computed(() => mergeWorkflowEvidence(baseline.value, evaluation.value));
const evidenceByName = computed(() => new Map(allEvidence.value.map(item => [item.name, item])));
const previewArtifacts = computed(() => toPreviewArtifacts(allEvidence.value, props.workflow.taskId));
const previewImageList = computed(() =>
  previewArtifacts.value.filter(item => item.type === 'image/png'),
);
const previewImageNames = computed(() => new Set(previewImageList.value.map(item => item.name)));

const galleryPages = computed(() => Math.max(1, Math.ceil(previewImageList.value.length / 12)));
const visibleGalleryImages = computed(() =>
  previewImageList.value.slice((galleryPage.value - 1) * 12, galleryPage.value * 12),
);

watch(galleryPages, max => {
  if (galleryPage.value > max) galleryPage.value = max;
});

const checksById = computed(
  () => new Map((evaluation.value?.checks || []).map(item => [item.id, item])),
);

const baselineViewMap = computed(() => {
  const map = new Map<string, { pageTitle: string; viewTitle: string }>();
  for (const page of baseline.value?.pages || []) {
    for (const view of page.views) {
      map.set(`${page.path}::${view.id}`, { pageTitle: page.title || page.path, viewTitle: view.title });
    }
  }
  return map;
});

function viewLabel(pagePath: string, viewId: string): string {
  return baselineViewMap.value.get(`${pagePath}::${viewId}`)?.viewTitle || viewId;
}

const filteredIssues = computed(() => {
  const list = evaluation.value?.issues || [];
  const severityOrder: Record<TemplateSeverity, number> = { critical: 0, major: 1, minor: 2 };
  const statusOrder: Record<TemplateIssue['status'], number> = { open: 0, unverified: 1, done: 2 };
  return list
    .filter(issue => {
      if (issueStatusFilter.value !== 'all' && issue.status !== issueStatusFilter.value) return false;
      if (issueSeverityFilter.value && issue.severity !== issueSeverityFilter.value) return false;
      if (issueViewportFilter.value && issue.viewport !== issueViewportFilter.value) return false;
      return true;
    })
    .slice()
    .sort((a, b) => {
      const st = statusOrder[a.status] - statusOrder[b.status];
      if (st !== 0) return st;
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
});

const hasIssueFilters = computed(
  () => Boolean(issueStatusFilter.value !== 'all' || issueSeverityFilter.value || issueViewportFilter.value),
);

function clearIssueFilters() {
  issueStatusFilter.value = 'all';
  issueSeverityFilter.value = '';
  issueViewportFilter.value = '';
}

const availablePageOptions = computed(() => {
  const paths = new Set<string>();
  for (const page of baseline.value?.pages || []) paths.add(page.path);
  for (const check of evaluation.value?.checks || []) paths.add(check.pagePath);
  return [
    { value: '', label: '全部页面' },
    ...[...paths].map(path => {
      const bPage = baseline.value?.pages.find(p => p.path === path);
      return { value: path, label: bPage?.title ? `${bPage.title}（${path}）` : path };
    }),
  ];
});

const drilldownPages = computed(() =>
  evaluation.value
    ? buildPageViewCheckTree(evaluation.value, baseline.value, checklist.value, {
        pagePath: checkPageFilter.value || undefined,
        viewport: checkViewportFilter.value,
        status: checkStatusFilter.value,
        provenance: checkProvenanceFilter.value,
        query: checkQuery.value,
      })
    : [],
);

const hasCheckFilters = computed(() =>
  Boolean(
    checkQuery.value.trim() ||
      checkPageFilter.value ||
      checkViewportFilter.value ||
      checkStatusFilter.value ||
      checkProvenanceFilter.value,
  ),
);

function clearCheckFilters() {
  checkQuery.value = '';
  checkPageFilter.value = '';
  checkViewportFilter.value = '';
  checkStatusFilter.value = '';
  checkProvenanceFilter.value = '';
}

const captureCounts = computed(() => {
  const captures = evaluation.value?.captures || [];
  return {
    page: captures.filter(c => c.mode === 'page').length,
    regions: captures.filter(c => c.mode === 'regions').length,
    inherited: captures.filter(c => c.mode === 'inherited').length,
    incomplete: captures.filter(c => !c.complete).length,
  };
});

function isImage(name: string): boolean {
  return previewImageNames.value.has(name);
}

function downloadHref(name: string): string | null {
  const item = evidenceByName.value.get(name);
  if (!item) return null;
  const href = resolveTemplateEvidenceHref(item, props.workflow.taskId);
  return href ? appendUrlParam(href, 'download', '1') : null;
}

function previewSrc(name: string): string {
  const item = evidenceByName.value.get(name);
  return (item && resolveTemplateEvidenceHref(item, props.workflow.taskId)) || '';
}

function fileLabel(name: string, index: number): string {
  const item = evidenceByName.value.get(name);
  return item ? templateEvidenceTitle(item, index) : `证据 ${index + 1}`;
}

/** Combine issue/check target evidence with matching viewport reference evidence from frozen baseline so EvidenceViewer supports side-by-side comparison. */
function withPairedReferenceEvidence(names: string[], pagePath: string, viewId: string, viewport: TemplateViewport): string[] {
  const set = new Set<string>(names);
  const bPage = baseline.value?.pages.find(p => p.path === pagePath);
  const bView = bPage?.views.find(v => v.id === viewId);
  const layout = bView?.layouts.find(l => l.viewport === viewport);
  for (const refFile of layout?.evidence || []) {
    if (isImage(refFile)) set.add(refFile);
  }
  return [...set];
}

function openIssueEvidence(issue: TemplateIssue, fileName: string) {
  const contexts: EvidenceContext[] = filteredIssues.value.map(item => ({
    title: `[#${item.id}] ${item.title} · ${item.pagePath} / ${viewLabel(item.pagePath, item.viewId)}（${templateViewportNames[item.viewport]}）`,
    detail: `预期：${item.expected}\n实际：${item.actual}\n验收条件：${item.acceptance}`,
    evidence: withPairedReferenceEvidence(item.evidence, item.pagePath, item.viewId, item.viewport),
    severity: item.severity,
  }));
  const idx = filteredIssues.value.findIndex(item => item.id === issue.id);
  void viewer.value?.open(contexts, Math.max(0, idx), fileName, true);
}

function openCheckEvidence(
  pagePath: string,
  viewId: string,
  item: EnrichedTemplateCheckResult,
  fileName: string,
) {
  const context: EvidenceContext = {
    title: `${pagePath} · ${viewLabel(pagePath, viewId)} · ${item.checkTitle}（${templateViewportNames[item.result.viewport]}）`,
    detail: `预期：${item.result.expected}\n实际：${item.result.actual}\n判定：${item.result.reason}`,
    evidence: withPairedReferenceEvidence(item.result.evidence, pagePath, viewId, item.result.viewport),
    severity: item.result.status === 'failed' ? item.severity : undefined,
  };
  void viewer.value?.open([context], 0, fileName, true);
}

function openCaptureEvidence(scopePath: string, viewport: TemplateViewport, files: string[], fileName: string) {
  const context: EvidenceContext = {
    title: `采集范围 · ${scopePath}（${templateViewportNames[viewport]}）`,
    detail: '',
    evidence: files,
  };
  void viewer.value?.open([context], 0, fileName, false);
}

function openGallery(fileName: string) {
  const context: EvidenceContext = {
    title: '工作流全部登记截图',
    detail: '',
    evidence: previewImageList.value.map(item => item.name),
  };
  void viewer.value?.open([context], 0, fileName, false);
}

async function jumpToCheckResult(issue: TemplateIssue) {
  clearCheckFilters();
  highlightedCheckId.value = issue.checkResultId;
  await nextTick();
  const el = document.getElementById(`check-result-${encodeURIComponent(issue.checkResultId)}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function statusBadgeTone(status: TemplateCheckStatus): string {
  if (status === 'passed') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'unverified') return 'warning';
  return '';
}

function provenanceBadgeTone(provenance: TemplateProvenance): string {
  if (provenance === 'measured') return 'measured-pill';
  if (provenance === 'inherited') return '';
  return 'warning';
}

function issueStatusDisplay(issue: TemplateIssue): string {
  if (issue.status === 'open' && props.workflow.phase === 'repair') {
    return '待修复 · 待独立复验';
  }
  return templateIssueStatusNames[issue.status];
}

function measurementEntries(measurements?: Record<string, number | string | boolean | null>) {
  if (!measurements) return [];
  return Object.entries(measurements).filter(([, v]) => v !== undefined);
}
</script>

<template>
  <div class="template-eval-stack">
    <p v-if="error" class="alert error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="text-action" @click="emit('retry')">重试</button>
    </p>

    <p v-if="loading && !evaluation" class="section-loading" role="status">
      <LoaderCircle class="spin" :size="18" />正在加载区块核验与问题闭环数据…
    </p>

    <!-- No current evaluation yet -->
    <section v-if="!loading && !evaluation" class="panel settings-panel eval-empty-panel">
      <div class="section-heading">
        <h2>
          {{
            workflow.phase === 'analysis'
              ? '等待生成前参考分析完成'
              : workflow.phase === 'generation'
                ? '等待站点生成完成后统一核验'
                : workflow.phase === 'evaluation'
                  ? '正在统一采集并按区块核验…'
                  : workflow.phase === 'repair'
                    ? '正在修复或执行局部复验…'
                    : '当前站点修订暂无匹配的独立核验结果'
          }}
        </h2>
        <button
          v-if="baseline"
          type="button"
          class="text-action"
          @click="emit('openBaseline', { pagePath: baseline.pages[0]?.path || '/' })"
        >
          查看冻结参考基线<ArrowUpRight :size="14" />
        </button>
      </div>
      <p class="task-prose text-muted">
        新评测流程在对应站点版本完成后统一采集必检页面与视口，共享证据执行脚本测量与按区块 AI 判断；站点修订变化或核验未完成时，不展示旧分数或空值为当前通过。
      </p>
      <div v-if="workflow.limitations.length" class="eval-limitations">
        <h3><AlertTriangle :size="15" />当前缺口与说明（{{ workflow.limitations.length }}）</h3>
        <ul class="task-text-list">
          <li v-for="gap in workflow.limitations" :key="gap">{{ gap }}</li>
        </ul>
      </div>
    </section>

    <!-- Active / Completed Template Evaluation -->
    <template v-if="evaluation && summary">
      <!-- 1. Verdict & Overview Metrics -->
      <div class="eval-summary-grid">
        <section class="panel eval-verdict-card">
          <span class="tiny-label">当前修订核验结论</span>
          <strong
            class="eval-verdict-title"
            :class="
              evaluation.complete && evaluation.quality === 'passed'
                ? 'success-text'
                : evaluation.quality === 'failed'
                  ? 'error-text'
                  : 'warning-text'
            "
          >
            {{
              !evaluation.complete && evaluation.quality === 'passed'
                ? '待补齐未完成覆盖'
                : templateQualityNames[evaluation.quality]
            }}
          </strong>
          <p class="text-muted small-text">
            {{
              evaluation.complete && evaluation.quality === 'passed'
                ? '必检覆盖完整且通过，无需进入修复'
                : summary.failedRequiredChecks
                  ? `${summary.failedRequiredChecks} 项必过检查未通过`
                  : summary.openIssues
                    ? `${summary.openIssues} 项问题待修复并独立复验`
                    : `${summary.unverifiedChecks} 项检查待补充验证`
            }}
          </p>
        </section>

        <section
          v-for="vp in summary.viewportScores"
          :key="vp.viewport"
          class="panel eval-metric-card"
        >
          <span class="tiny-label">{{ templateViewportNames[vp.viewport] }}加权得分</span>
          <strong class="eval-score-num">{{ vp.score ?? '—' }}</strong>
          <small class="text-muted">
            已计分 {{ vp.scoredCount }} 项{{ vp.unverifiedCount ? ` · 未验证 ${vp.unverifiedCount} 项` : '' }}
          </small>
        </section>

        <section class="panel eval-metric-card">
          <span class="tiny-label">问题闭环进展</span>
          <div class="eval-stat-pills">
            <span class="badge" :class="summary.openIssues ? 'bad' : 'good'">
              待修复 {{ summary.openIssues }}
            </span>
            <span class="badge good">已关闭 {{ summary.doneIssues }}</span>
            <span v-if="summary.unverifiedIssues" class="badge warning">
              未验证 {{ summary.unverifiedIssues }}
            </span>
          </div>
          <small class="text-muted">关闭须来自独立复验证据</small>
        </section>

        <section class="panel eval-metric-card">
          <span class="tiny-label">检查来源与复用</span>
          <div class="eval-stat-pills">
            <span class="badge measured-pill">实测 {{ summary.measuredChecks }}</span>
            <span class="badge">继承 {{ summary.inheritedChecks }}</span>
            <span v-if="summary.unverifiedProvenanceChecks" class="badge warning">
              待验证 {{ summary.unverifiedProvenanceChecks }}
            </span>
          </div>
          <small class="text-muted">
            修订 <code>{{ shortRevision(evaluation.siteRevision) }}</code> · {{ formatDate(evaluation.createdAt) }}
          </small>
        </section>
      </div>

      <!-- Limitations / Evidence Gaps Callout -->
      <section v-if="workflow.limitations.length || !evaluation.complete" class="panel settings-panel eval-limitations-panel">
        <div class="section-heading">
          <h2>
            <AlertTriangle :size="16" />
            <span>覆盖限制与证据缺口说明</span>
          </h2>
          <span v-if="!evaluation.complete" class="badge warning">覆盖未完成</span>
        </div>
        <ul v-if="workflow.limitations.length" class="task-text-list">
          <li v-for="gap in workflow.limitations" :key="gap">{{ gap }}</li>
        </ul>
        <p v-else class="text-muted small-text">
          当前核验尚有未完成采集或延后的细节检查，不能视为完整达标；证据缺口与站点缺陷分开处理。
        </p>
      </section>

      <!-- 2. Capture & Inheritance Scope -->
      <section v-if="evaluation.captures.length" class="panel settings-panel">
        <div class="section-heading">
          <div>
            <h2>本轮采集与证据复用范围</h2>
            <p class="section-sub">
              局部修改仅重采受影响区块与视口；继承表示经依赖核对沿用有效历史证据，不重复截图。
            </p>
          </div>
          <div class="eval-stat-pills">
            <span v-if="captureCounts.page" class="badge measured-pill">全页采集 {{ captureCounts.page }}</span>
            <span v-if="captureCounts.regions" class="badge measured-pill">局部重采 {{ captureCounts.regions }}</span>
            <span v-if="captureCounts.inherited" class="badge">继承 {{ captureCounts.inherited }}</span>
            <span v-if="captureCounts.incomplete" class="badge warning">未完成 {{ captureCounts.incomplete }}</span>
          </div>
        </div>

        <Disclosure :label="`展开采集与继承范围明细（${evaluation.captures.length} 项）`">
          <div class="table-scroll">
            <table class="task-table">
              <thead>
                <tr>
                  <th>页面 / 视口</th>
                  <th>采集方式</th>
                  <th>范围依据与目标选择器</th>
                  <th>来源版本 / 证据</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(cap, capIdx) in evaluation.captures" :key="`${cap.pagePath}-${cap.viewport}-${capIdx}`">
                  <td>
                    <strong>{{ cap.pagePath }}</strong>
                    <span class="table-subtitle">{{ templateViewportNames[cap.viewport] }}</span>
                  </td>
                  <td>
                    <span
                      class="badge"
                      :class="cap.mode === 'inherited' ? '' : 'measured-pill'"
                    >
                      {{ templateCaptureModeNames[cap.mode] }}
                    </span>
                    <span v-if="!cap.complete" class="table-subtitle warning-text">存在采集缺口</span>
                  </td>
                  <td class="wrapping-cell">
                    {{ cap.reason }}
                    <div v-if="cap.selectors.length" class="selector-chips">
                      <code v-for="sel in cap.selectors" :key="sel">{{ sel }}</code>
                    </div>
                  </td>
                  <td class="wrapping-cell">
                    <div v-if="cap.sourceTaskId || cap.sourceRevision" class="provenance-inline">
                      <a v-if="cap.sourceTaskId" class="text-action" :href="`#/tasks/${cap.sourceTaskId}`">
                        来源任务 {{ shortRevision(cap.sourceTaskId) }}
                      </a>
                      <span v-if="cap.sourceRevision" class="text-muted small-text">
                        修订 <code>{{ shortRevision(cap.sourceRevision) }}</code>
                      </span>
                    </div>
                    <div v-if="cap.evidence.length" class="evidence-links">
                      <template v-for="(file, fIdx) in cap.evidence" :key="file">
                        <button
                          v-if="isImage(file)"
                          type="button"
                          class="text-action"
                          @click="openCaptureEvidence(cap.pagePath, cap.viewport, cap.evidence, file)"
                        >
                          <Image :size="13" />{{ fileLabel(file, fIdx) }}
                        </button>
                        <a
                          v-else-if="downloadHref(file)"
                          class="text-action"
                          :href="downloadHref(file)!"
                          download
                        >
                          <Download :size="13" />{{ fileLabel(file, fIdx) }}
                        </a>
                      </template>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Disclosure>
      </section>

      <!-- 3. Stable-ID Issue Tracker -->
      <section class="panel settings-panel">
        <div class="section-heading">
          <div>
            <h2>稳定问题跟踪与验收条件</h2>
            <p class="section-sub">
              每个问题保持稳定 ID，汇总一批后交接修复；仅对应新复验证据通过后更新为已关闭。
            </p>
          </div>
          <span class="text-muted small-text">共 {{ evaluation.issues.length }} 项</span>
        </div>

        <div v-if="evaluation.issues.length" class="eval-filter-bar">
          <div class="segmented compact" role="group" aria-label="按问题闭环状态筛选">
            <button
              v-for="opt in ([
                ['all', `全部 (${evaluation.issues.length})`],
                ['open', `待修复 (${summary.openIssues})`],
                ['unverified', `未验证 (${summary.unverifiedIssues})`],
                ['done', `已关闭 (${summary.doneIssues})`],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: issueStatusFilter === opt[0] }"
              :aria-pressed="issueStatusFilter === opt[0]"
              @click="issueStatusFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <div class="segmented compact" role="group" aria-label="按严重程度筛选问题">
            <button
              v-for="opt in ([
                ['', '全部严重性'],
                ['critical', '严重'],
                ['major', '主要'],
                ['minor', '次要'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: issueSeverityFilter === opt[0] }"
              :aria-pressed="issueSeverityFilter === opt[0]"
              @click="issueSeverityFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <div class="segmented compact" role="group" aria-label="按视口筛选问题">
            <button
              v-for="opt in ([
                ['', '全部视口'],
                ['desktop', 'PC'],
                ['mobile', '移动端'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: issueViewportFilter === opt[0] }"
              :aria-pressed="issueViewportFilter === opt[0]"
              @click="issueViewportFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <button v-if="hasIssueFilters" type="button" class="text-action" @click="clearIssueFilters">
            <RotateCcw :size="13" />清除筛选
          </button>
        </div>

        <p v-if="!evaluation.issues.length" class="text-muted">
          当前没有登记的站点缺陷；请同时结合下方分区块检查覆盖与未验证项确认整体状态。
        </p>
        <p v-else-if="!filteredIssues.length" class="text-muted">
          没有符合当前筛选条件的问题。
        </p>

        <div v-if="filteredIssues.length" class="issue-card-list">
          <article
            v-for="issue in filteredIssues"
            :key="issue.id"
            class="template-issue-card"
            :class="{ 'is-done': issue.status === 'done' }"
          >
            <div class="template-issue-top">
              <div class="template-issue-badges">
                <code class="issue-id-chip">#{{ issue.id }}</code>
                <span
                  class="badge"
                  :class="issue.severity === 'critical' ? 'bad' : issue.severity === 'major' ? 'warning' : ''"
                >
                  {{ templateSeverityNames[issue.severity] }}
                </span>
                <span
                  class="badge"
                  :class="issue.status === 'done' ? 'good' : issue.status === 'open' ? 'bad' : 'warning'"
                >
                  <CheckCircle2 v-if="issue.status === 'done'" :size="12" />
                  {{ issueStatusDisplay(issue) }}
                </span>
              </div>

              <div class="template-issue-loc">
                <span>
                  <code>{{ issue.pagePath }}</code> · {{ viewLabel(issue.pagePath, issue.viewId) }}（{{ templateViewportNames[issue.viewport] }}）
                </span>
                <button
                  type="button"
                  class="text-action"
                  @click="jumpToCheckResult(issue)"
                >
                  定位检查项
                </button>
                <button
                  v-if="baseline"
                  type="button"
                  class="text-action"
                  @click="emit('openBaseline', { pagePath: issue.pagePath, viewId: issue.viewId })"
                >
                  对照参考基线<ArrowUpRight :size="13" />
                </button>
              </div>
            </div>

            <h3 class="template-issue-title">{{ issue.title }}</h3>

            <dl class="issue-detail-grid">
              <div>
                <dt>参考预期</dt>
                <dd>{{ issue.expected }}</dd>
              </div>
              <div>
                <dt>当前实际</dt>
                <dd>{{ issue.actual }}</dd>
              </div>
              <div class="full-span">
                <dt>关闭验收条件</dt>
                <dd>{{ issue.acceptance }}</dd>
              </div>
            </dl>

            <div class="template-issue-foot">
              <template v-if="checksById.get(issue.checkResultId)">
                <span class="text-muted small-text">
                  核验记录：{{ templateProvenanceNames[checksById.get(issue.checkResultId)!.provenance] }}
                  · 来源任务
                  <a class="inline-task-link" :href="`#/tasks/${checksById.get(issue.checkResultId)!.sourceTaskId}`">
                    {{ shortRevision(checksById.get(issue.checkResultId)!.sourceTaskId) }}
                  </a>
                  · 修订 <code>{{ shortRevision(checksById.get(issue.checkResultId)!.sourceRevision) }}</code>
                </span>
              </template>

              <button
                v-if="issue.evidence.length"
                type="button"
                class="text-action"
                :aria-expanded="expandedIssueId === issue.id"
                @click="expandedIssueId = expandedIssueId === issue.id ? null : issue.id"
              >
                <ChevronDown v-if="expandedIssueId === issue.id" :size="15" />
                <ChevronRight v-else :size="15" />
                {{ expandedIssueId === issue.id ? '收起相关证据' : `查看相关证据（${issue.evidence.length}）` }}
              </button>
            </div>

            <div v-if="expandedIssueId === issue.id && issue.evidence.length" class="evidence-grid">
              <template v-for="(file, fIdx) in issue.evidence" :key="file">
                <button
                  v-if="isImage(file)"
                  type="button"
                  class="evidence-preview-card"
                  :aria-label="'对比预览 ' + fileLabel(file, fIdx)"
                  @click="openIssueEvidence(issue, file)"
                >
                  <img :src="previewSrc(file)" loading="lazy" :alt="`${issue.title} · ${fileLabel(file, fIdx)}`" />
                  <span>{{ fileLabel(file, fIdx) }}<Image :size="13" /></span>
                </button>
                <a v-else-if="downloadHref(file)" :href="downloadHref(file)!" download>
                  <span>{{ fileLabel(file, fIdx) }}<Download :size="13" /></span>
                </a>
              </template>
            </div>
          </article>
        </div>
      </section>

      <!-- 4. Drill-down: Page -> Semantic View -> Check Results -->
      <section class="panel settings-panel">
        <div class="section-heading">
          <div>
            <h2>检查结果下钻（页面 → 语义区块 → 检查项）</h2>
            <p class="section-sub">
              区分本轮实测、依据依赖继承与尚未验证；未知结果不计零分或通过。
            </p>
          </div>
          <span class="text-muted small-text">
            通过 {{ summary.passedChecks }} · 未通过 {{ summary.failedChecks }} · 未验证 {{ summary.unverifiedChecks }} · 不适用 {{ summary.notApplicableChecks }}
          </span>
        </div>

        <div class="eval-filter-bar">
          <label class="search-field eval-check-search">
            <Search :size="15" />
            <input
              v-model="checkQuery"
              type="search"
              placeholder="搜索页面、区块、检查项、预期或实际"
              aria-label="搜索检查结果"
            />
          </label>

          <BaseSelect
            v-if="availablePageOptions.length > 2"
            v-model="checkPageFilter"
            size="small"
            aria-label="筛选页面"
            :options="availablePageOptions"
          />

          <div class="segmented compact" role="group" aria-label="筛选视口">
            <button
              v-for="opt in ([
                ['', '全部视口'],
                ['desktop', 'PC'],
                ['mobile', '移动端'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: checkViewportFilter === opt[0] }"
              :aria-pressed="checkViewportFilter === opt[0]"
              @click="checkViewportFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <div class="segmented compact" role="group" aria-label="筛选检查结果状态">
            <button
              v-for="opt in ([
                ['', '全部结论'],
                ['failed', '未通过'],
                ['unverified', '未验证'],
                ['passed', '通过'],
                ['not-applicable', '不适用'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: checkStatusFilter === opt[0] }"
              :aria-pressed="checkStatusFilter === opt[0]"
              @click="checkStatusFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <div class="segmented compact" role="group" aria-label="筛选结果来源">
            <button
              v-for="opt in ([
                ['', '全部来源'],
                ['measured', '本轮实测'],
                ['inherited', '依据继承'],
                ['unverified', '尚未验证'],
              ] as const)"
              :key="opt[0]"
              type="button"
              :class="{ selected: checkProvenanceFilter === opt[0] }"
              :aria-pressed="checkProvenanceFilter === opt[0]"
              @click="checkProvenanceFilter = opt[0]"
            >
              {{ opt[1] }}
            </button>
          </div>

          <button v-if="hasCheckFilters" type="button" class="text-action" @click="clearCheckFilters">
            <RotateCcw :size="13" />清除筛选
          </button>
        </div>

        <div v-if="drilldownPages.length" class="drilldown-page-list">
          <section
            v-for="page in drilldownPages"
            :key="page.pagePath"
            class="drilldown-page-block"
          >
            <header class="drilldown-page-head">
              <div class="drilldown-page-title">
                <Layers :size="16" />
                <h3>{{ page.pageTitle }}</h3>
                <code>{{ page.pagePath }}</code>
              </div>
              <div class="eval-stat-pills">
                <span v-if="page.failedCount" class="badge bad">未通过 {{ page.failedCount }}</span>
                <span v-if="page.unverifiedCount" class="badge warning">未验证 {{ page.unverifiedCount }}</span>
                <span class="badge good">通过 {{ page.passedCount }}</span>
              </div>
            </header>

            <div class="drilldown-view-list">
              <div
                v-for="view in page.views"
                :key="view.viewId"
                class="drilldown-view-card"
              >
                <div class="drilldown-view-head">
                  <div class="drilldown-view-title">
                    <strong>{{ view.viewTitle }}</strong>
                    <code>{{ view.viewId }}</code>
                    <span v-if="view.role" class="badge">{{ view.role }}</span>
                    <span v-if="view.required" class="badge warning">必需区块</span>
                  </div>
                  <button
                    v-if="view.baselineView"
                    type="button"
                    class="text-action"
                    @click="emit('openBaseline', { pagePath: page.pagePath, viewId: view.viewId })"
                  >
                    在基线中定位<ArrowUpRight :size="13" />
                  </button>
                </div>

                <!-- Inline expandable baseline intent for quick reference -->
                <Disclosure
                  v-if="view.baselineView?.layouts.length"
                  label="查看本站该区块冻结双端要求"
                >
                  <div class="inline-baseline-grid">
                    <div
                      v-for="layout in view.baselineView.layouts"
                      :key="layout.viewport"
                      class="inline-baseline-item"
                    >
                      <strong>{{ templateViewportNames[layout.viewport] }}：</strong>
                      <span>{{ layout.intent }}</span>
                      <span v-if="layout.exceptions" class="text-muted">（例外：{{ layout.exceptions }}）</span>
                    </div>
                  </div>
                </Disclosure>

                <div class="drilldown-check-rows">
                  <article
                    v-for="item in view.checks"
                    :id="`check-result-${encodeURIComponent(item.result.id)}`"
                    :key="item.result.id"
                    class="drilldown-check-item"
                    :class="{ 'is-highlighted': highlightedCheckId === item.result.id }"
                  >
                    <div class="drilldown-check-head">
                      <div class="drilldown-check-meta">
                        <strong>{{ item.checkTitle }}</strong>
                        <code>{{ item.result.checkId }}</code>
                        <span class="badge">{{ templateViewportNames[item.result.viewport] }}</span>
                        <span v-if="item.required" class="badge warning">必过项</span>
                        <span v-if="item.executor" class="badge">{{ templateExecutorNames[item.executor] }}</span>
                        <span v-if="item.tolerancePx !== undefined" class="text-muted small-text">
                          容差 {{ item.tolerancePx }}px
                        </span>
                      </div>

                      <div class="drilldown-check-verdict">
                        <span class="badge" :class="provenanceBadgeTone(item.result.provenance)">
                          {{ templateProvenanceNames[item.result.provenance] }}
                        </span>
                        <span class="badge" :class="statusBadgeTone(item.result.status)">
                          {{ templateCheckStatusNames[item.result.status] }}
                        </span>
                        <strong v-if="item.result.score !== null" class="check-score">
                          {{ item.result.score }}
                        </strong>
                      </div>
                    </div>

                    <div class="drilldown-check-comparison">
                      <p><strong>预期：</strong>{{ item.result.expected || '—' }}</p>
                      <p><strong>实际：</strong>{{ item.result.actual || '—' }}</p>
                      <p class="check-reason">
                        <strong>{{ item.result.status === 'not-applicable' ? '不适用依据：' : '判定依据：' }}</strong>
                        {{ item.result.reason || '—' }}
                      </p>
                    </div>

                    <div
                      v-if="measurementEntries(item.result.measurements).length"
                      class="measurement-chips"
                      aria-label="脚本测量结果"
                    >
                      <span
                        v-for="[mKey, mVal] in measurementEntries(item.result.measurements)"
                        :key="mKey"
                        class="measurement-chip"
                      >
                        <code>{{ mKey }}</code>: <strong>{{ String(mVal) }}</strong>
                      </span>
                    </div>

                    <div v-if="item.result.evidence.length" class="evidence-links">
                      <template v-for="(file, fIdx) in item.result.evidence" :key="file">
                        <button
                          v-if="isImage(file)"
                          type="button"
                          class="text-action"
                          @click="openCheckEvidence(page.pagePath, view.viewId, item, file)"
                        >
                          <Image :size="13" />{{ fileLabel(file, fIdx) }}
                        </button>
                        <a
                          v-else-if="downloadHref(file)"
                          class="text-action"
                          :href="downloadHref(file)!"
                          download
                        >
                          <Download :size="13" />{{ fileLabel(file, fIdx) }}
                        </a>
                      </template>
                    </div>

                    <Disclosure label="来源版本与继承依据">
                      <div class="provenance-detail-box">
                        <p>
                          <span>结果来源：{{ templateProvenanceNames[item.result.provenance] }}</span>
                          ·
                          <span>
                            来源任务：
                            <a class="inline-task-link" :href="`#/tasks/${item.result.sourceTaskId}`">
                              {{ item.result.sourceTaskId }}
                            </a>
                          </span>
                          ·
                          <span>来源站点修订：<code>{{ item.result.sourceRevision }}</code></span>
                        </p>
                        <p v-if="item.result.inheritanceReason">
                          <strong>继承依据：</strong>{{ item.result.inheritanceReason }}
                        </p>
                      </div>
                    </Disclosure>
                  </article>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div v-else class="empty-state compact-empty">
          <FileSearch :size="28" />
          <h2>{{ evaluation.checks.length ? '没有匹配的检查结果' : '尚无检查明细记录' }}</h2>
          <p v-if="evaluation.checks.length">可调整筛选条件查看全部 {{ evaluation.checks.length }} 项区块检查记录。</p>
          <button v-if="hasCheckFilters" type="button" class="button secondary small" @click="clearCheckFilters">
            清除筛选
          </button>
        </div>
      </section>

      <!-- 5. Full Registered Screenshot Gallery (lazy mounted, 12 per page) -->
      <section v-if="previewImageList.length" class="panel settings-panel">
        <div class="section-heading">
          <button
            type="button"
            class="text-action"
            :aria-expanded="galleryOpen"
            @click="galleryOpen = !galleryOpen"
          >
            <ChevronDown v-if="galleryOpen" :size="16" />
            <ChevronRight v-else :size="16" />
            全部工作流截图证据（{{ previewImageList.length }}）
          </button>
        </div>
        <template v-if="galleryOpen">
          <div class="evidence-grid">
            <button
              v-for="(file, idx) in visibleGalleryImages"
              :key="file.name"
              type="button"
              class="evidence-preview-card"
              :aria-label="'预览 ' + fileLabel(file.name, (galleryPage - 1) * 12 + idx)"
              @click="openGallery(file.name)"
            >
              <img
                :src="file.href"
                loading="lazy"
                :alt="fileLabel(file.name, (galleryPage - 1) * 12 + idx)"
              />
              <span>{{ fileLabel(file.name, (galleryPage - 1) * 12 + idx) }}<Image :size="13" /></span>
            </button>
          </div>
          <TablePagination
            :page="galleryPage"
            :pages="galleryPages"
            :total="previewImageList.length"
            @change="galleryPage = $event"
          />
        </template>
      </section>
    </template>

    <EvidenceViewer
      v-if="previewArtifacts.length"
      ref="viewer"
      :task-id="workflow.taskId"
      :artifacts="previewArtifacts"
    />
  </div>
</template>

<style scoped>
.template-eval-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.eval-empty-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.eval-empty-panel > .section-heading {
  margin-bottom: 0;
}
.eval-limitations,
.eval-limitations-panel {
  background: #fff9f0;
  border: 1px solid #f4dfc0;
}
.eval-limitations {
  padding: 14px 16px;
  border-radius: 10px;
}
.eval-limitations h3,
.eval-limitations-panel h2 {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #9a5b13;
  font-size: 14px;
}
.eval-summary-grid {
  display: grid;
  grid-template-columns: 1.35fr repeat(4, minmax(150px, 1fr));
  gap: 16px;
}
.eval-Summary-grid > .panel,
.eval-verdict-card,
.eval-metric-card {
  margin-bottom: 0;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}
.eval-verdict-title {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
}
.eval-score-num {
  font-size: 32px;
  font-weight: 650;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.eval-stat-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.measured-pill {
  color: #3559b5;
  background: #eaf0ff;
}
.section-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
.selector-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.selector-chips code {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--field);
}
.provenance-inline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.eval-filter-bar {
  display: flex;
  align-items: center;
  gap: 10px 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.eval-check-search {
  flex: 1 1 250px;
  max-width: 340px;
  min-height: 35px;
}
.eval-check-search input {
  padding: 7px 0;
  font-size: 12px;
}
.issue-card-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.template-issue-card {
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid #e7ecf4;
  background: var(--paper);
}
.template-issue-card.is-done {
  background: #fbfdfc;
  border-color: #d9eee5;
}
.template-issue-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.template-issue-badges,
.template-issue-loc {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.issue-id-chip {
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--field);
  color: #475569;
  font-size: 11px;
  font-weight: 600;
}
.template-issue-loc code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--field);
}
.template-issue-title {
  margin: 12px 0 10px;
  font-size: 15px;
  font-weight: 650;
}
.issue-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  margin: 0;
  padding: 12px 14px;
  border-radius: 9px;
  background: #f8faff;
}
.issue-detail-grid > div {
  min-width: 0;
}
.issue-detail-grid .full-span {
  grid-column: 1 / -1;
  padding-top: 8px;
  border-top: 1px solid #e9eef6;
}
.issue-detail-grid dt {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 3px;
}
.issue-detail-grid dd {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.template-issue-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.inline-task-link {
  color: var(--blue);
}
.inline-task-link:hover {
  text-decoration: underline;
}
.drilldown-page-list {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.drilldown-page-block {
  border: 1px solid #e4eaf3;
  border-radius: 14px;
  overflow: hidden;
  background: #fafbfe;
}
.drilldown-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 18px;
  background: #f2f5fb;
  border-bottom: 1px solid #e4eaf3;
}
.drilldown-page-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.drilldown-page-title h3 {
  font-size: 15px;
  font-weight: 650;
}
.drilldown-page-title code {
  font-size: 12px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--paper);
  color: var(--muted);
}
.drilldown-view-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.drilldown-view-card {
  border: 1px solid #e7ecf4;
  border-radius: 11px;
  padding: 16px;
  background: var(--paper);
}
.drilldown-view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.drilldown-view-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 14px;
}
.drilldown-view-title code {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--field);
  color: var(--muted);
}
.inline-baseline-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f8faff;
  font-size: 12px;
  line-height: 1.65;
  margin-bottom: 10px;
}
.drilldown-check-rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}
.drilldown-check-item {
  padding: 14px 16px;
  border-radius: 9px;
  border: 1px solid #edf1f7;
  background: #fcfdff;
  scroll-margin-top: 20px;
}
.drilldown-check-item.is-highlighted {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px #5079ed1a;
}
.drilldown-check-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.drilldown-check-meta,
.drilldown-check-verdict {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 13px;
}
.drilldown-check-meta code {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--field);
  color: var(--muted);
}
.check-score {
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}
.drilldown-check-comparison {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  line-height: 1.7;
  color: #334155;
  overflow-wrap: anywhere;
}
.drilldown-check-comparison strong {
  color: #526079;
}
.check-reason {
  color: #475569;
}
.measurement-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.measurement-chip {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--field);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.provenance-detail-box {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--field);
  font-size: 12px;
  line-height: 1.7;
  color: #475569;
}
.compact-empty {
  min-height: 180px;
  padding: 32px 16px;
}
@media (max-width: 1200px) {
  .eval-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .eval-verdict-card {
    grid-column: 1 / -1;
  }
}
@media (max-width: 720px) {
  .eval-summary-grid,
  .issue-detail-grid {
    grid-template-columns: 1fr;
  }
  .eval-check-search {
    max-width: none;
    width: 100%;
  }
}
</style>
