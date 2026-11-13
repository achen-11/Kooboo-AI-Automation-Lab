<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  ExternalLink,
  Image,
  Layers,
  Search,
} from '@lucide/vue';
import type {
  TemplateEvidence,
  TemplateView,
  TemplateViewLayout,
  TemplateWorkflowResponse,
} from '../../../../shared/template-workflow';
import { formatDate } from '../../api';
import Disclosure from '../../components/Disclosure.vue';
import EvidenceViewer from '../../components/EvidenceViewer.vue';
import type { EvidenceContext } from '../../lib/evidence-preview';
import { siteLink } from '../../lib/task-list';
import {
  appendUrlParam,
  resolveTemplateEvidenceHref,
  shortRevision,
  templateCheckKindNames,
  templateEvidenceTitle,
  templateExecutorNames,
  templateRelationNames,
  templateSeverityNames,
  templateViewportNames,
  toPreviewArtifacts,
} from '../../lib/template-workflow';
import { bytes, scopeName } from './common';

const props = defineProps<{
  workflow: TemplateWorkflowResponse;
  focusTarget?: { pagePath: string; viewId?: string; nonce: number } | null;
}>();

const selectedPagePath = ref('');
const viewSearch = ref('');
const highlightedViewId = ref('');
const viewer = ref<InstanceType<typeof EvidenceViewer>>();

const baseline = computed(() => props.workflow.baseline);
const checklist = computed(() => props.workflow.checklist);
const checkMap = computed(() => new Map((checklist.value?.checks || []).map(c => [c.id, c])));

const pages = computed(() => baseline.value?.pages || []);
const activePage = computed(
  () => pages.value.find(page => page.path === selectedPagePath.value) || pages.value[0] || null,
);

watch(
  pages,
  list => {
    if (list.length && !list.some(page => page.path === selectedPagePath.value)) {
      selectedPagePath.value = list[0].path;
    }
  },
  { immediate: true },
);

const filteredViews = computed(() => {
  const list = activePage.value?.views || [];
  const q = viewSearch.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(view => {
    const text = [
      view.id,
      view.title,
      view.role,
      ...view.layouts.flatMap(l => [l.intent, l.exceptions, l.selector, ...l.constraints.map(c => c.expected)]),
    ]
      .join(' ')
      .toLowerCase();
    return text.includes(q);
  });
});

const totalViews = computed(() => pages.value.reduce((sum, page) => sum + page.views.length, 0));
const requiredViews = computed(() =>
  pages.value.reduce((sum, page) => sum + page.views.filter(v => v.required).length, 0),
);

const allBaselineLimitations = computed(() => {
  const items = new Set<string>([
    ...(baseline.value?.limitations || []),
    ...props.workflow.limitations,
  ]);
  return [...items].filter(Boolean);
});

const evidenceByName = computed(
  () => new Map((baseline.value?.evidence || []).map(item => [item.name, item])),
);
const previewArtifacts = computed(() =>
  toPreviewArtifacts(baseline.value?.evidence || [], props.workflow.taskId),
);
const previewImageNames = computed(
  () => new Set(previewArtifacts.value.filter(f => f.type === 'image/png').map(f => f.name)),
);

function canPreviewImage(name: string): boolean {
  return previewImageNames.value.has(name);
}

function evidenceDownloadHref(name: string): string | null {
  const item = evidenceByName.value.get(name);
  if (!item) return null;
  const href = resolveTemplateEvidenceHref(item, props.workflow.taskId);
  return href ? appendUrlParam(href, 'download', '1') : null;
}

function evidenceItemLabel(name: string, index: number): string {
  const item = evidenceByName.value.get(name);
  return item ? templateEvidenceTitle(item, index) : `来源证据 ${index + 1}`;
}

function openLayoutEvidence(view: TemplateView, layout: TemplateViewLayout, fileName: string) {
  const context: EvidenceContext = {
    title: `${activePage.value?.path || ''} · ${view.title}（${templateViewportNames[layout.viewport]}）`,
    detail: [layout.intent, layout.exceptions ? `允许例外：${layout.exceptions}` : '']
      .filter(Boolean)
      .join('\n'),
    evidence: layout.evidence,
  };
  void viewer.value?.open([context], 0, fileName, false);
}

function openAllBaselineEvidence(fileName: string) {
  const images = (baseline.value?.evidence || []).filter(item => canPreviewImage(item.name));
  const context: EvidenceContext = {
    title: '冻结来源截图证据',
    detail: baseline.value?.referenceUrl || '',
    evidence: images.map(item => item.name),
  };
  void viewer.value?.open([context], 0, fileName, false);
}

function viewDomId(pagePath: string, viewId: string): string {
  return `baseline-view-${encodeURIComponent(pagePath)}-${encodeURIComponent(viewId)}`;
}

watch(
  () => props.focusTarget?.nonce,
  async () => {
    const target = props.focusTarget;
    if (!target || !pages.value.length) return;
    if (pages.value.some(page => page.path === target.pagePath)) {
      selectedPagePath.value = target.pagePath;
    }
    viewSearch.value = '';
    highlightedViewId.value = target.viewId || '';
    await nextTick();
    if (target.viewId) {
      const el = document.getElementById(viewDomId(selectedPagePath.value, target.viewId));
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
  { immediate: true },
);

function orderedLayouts(layouts: TemplateViewLayout[]): TemplateViewLayout[] {
  const order = { desktop: 0, mobile: 1 };
  return layouts.slice().sort((a, b) => order[a.viewport] - order[b.viewport]);
}

function formatEvidenceMeta(item: TemplateEvidence): string {
  return [
    item.role === 'reference' ? '参考站' : item.role === 'content' ? '内容站' : '生成站',
    item.viewport ? templateViewportNames[item.viewport] : '',
    bytes(item.size),
    `SHA ${item.sha256.slice(0, 10)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
</script>

<template>
  <section class="panel settings-panel baseline-panel">
    <div class="section-heading">
      <div>
        <h2>冻结参考分析与共同基线</h2>
        <p class="baseline-subtitle">
          生成与所有评测轮次共用同一冻结来源版本，正常复验不重复采集参考站。
        </p>
      </div>
      <div v-if="baseline" class="baseline-badges">
        <span class="badge" :class="baseline.complete ? 'good' : 'warning'">
          <CheckCircle2 v-if="baseline.complete" :size="13" />
          <AlertTriangle v-else :size="13" />
          {{ baseline.complete ? '来源覆盖完整' : '存在来源缺口' }}
        </span>
        <span class="badge">基线 v{{ baseline.revision }}</span>
        <span class="text-muted small-text">{{ formatDate(baseline.createdAt) }}</span>
      </div>
    </div>

    <!-- Baseline not yet produced -->
    <template v-if="!baseline">
      <div class="baseline-pending-box">
        <strong>
          {{
            workflow.phase === 'analysis'
              ? '正在采集并分析来源站点…'
              : workflow.phase === 'interrupted'
                ? '参考分析阶段未完成冻结基线'
                : '尚未生成冻结参考基线'
          }}
        </strong>
        <p class="text-muted small-text">
          本地分析工具完成页面与语义区块识别后，将在此固定双端布局约束、内容对应及来源证据。未生成基线前不以空值推断通过。
        </p>
      </div>
      <div v-if="allBaselineLimitations.length" class="baseline-limitations">
        <h3>当前已知限制与缺口（{{ allBaselineLimitations.length }}）</h3>
        <ul class="task-text-list">
          <li v-for="gap in allBaselineLimitations" :key="gap">{{ gap }}</li>
        </ul>
      </div>
    </template>

    <!-- Frozen Baseline Details -->
    <template v-else>
      <dl class="task-facts baseline-facts">
        <div>
          <dt>参考站</dt>
          <dd>
            <a
              v-if="siteLink(baseline.referenceUrl)"
              :href="siteLink(baseline.referenceUrl)"
              target="_blank"
              rel="noopener noreferrer"
              class="site-ext-link"
            >
              <span>{{ baseline.referenceUrl }}</span>
              <ExternalLink :size="13" />
            </a>
            <span v-else>{{ baseline.referenceUrl || '—' }}</span>
          </dd>
        </div>
        <div>
          <dt>内容来源与素材政策</dt>
          <dd>
            <a
              v-if="baseline.contentUrl && siteLink(baseline.contentUrl)"
              :href="siteLink(baseline.contentUrl)"
              target="_blank"
              rel="noopener noreferrer"
              class="site-ext-link"
            >
              <span>{{ baseline.contentUrl }}</span>
              <ExternalLink :size="13" />
            </a>
            <span v-else class="text-muted">
              无独立内容站 · 采用模板示例文案与 <code>imagePlaceholder</code>（不复用参考站图片资源）
            </span>
          </dd>
        </div>
        <div>
          <dt>冻结范围与结构</dt>
          <dd>
            {{ scopeName(baseline.scope) }} · {{ pages.length }} 个页面 · {{ totalViews }} 个语义区块（必检 {{ requiredViews }} 个）
          </dd>
        </div>
        <div>
          <dt>输入版本绑定</dt>
          <dd><code>{{ shortRevision(baseline.inputVersionId) }}</code></dd>
        </div>
      </dl>

      <div v-if="allBaselineLimitations.length" class="baseline-limitations" role="region" aria-label="来源缺口与限制">
        <h3>
          <AlertTriangle :size="15" />
          <span>来源缺口与未确认事项（{{ allBaselineLimitations.length }}）</span>
        </h3>
        <ul class="task-text-list">
          <li v-for="item in allBaselineLimitations" :key="item">{{ item }}</li>
        </ul>
        <p class="limitation-footnote">
          观察事实与未确认部分已分离记录；补充来源或变更要求将生成新修订并使受影响结论重新验证。
        </p>
      </div>

      <div v-if="baseline.contentMapping" class="baseline-mapping">
        <h3>内容与参考结构对应</h3>
        <p class="task-prose">{{ baseline.contentMapping }}</p>
      </div>

      <Disclosure
        v-if="baseline.experienceGuidance?.length"
        :label="`生成前命中的简短适用经验（${baseline.experienceGuidance.length} 条）`"
      >
        <div class="baseline-guidance-list">
          <article
            v-for="exp in baseline.experienceGuidance"
            :key="`${exp.id}-${exp.revision}`"
            class="baseline-guidance-card"
          >
            <div class="baseline-guidance-head">
              <div class="toolbar-actions">
                <span class="badge">经验 v{{ exp.revision }}</span>
                <span v-if="exp.reason" class="text-muted small-text">命中依据：{{ exp.reason }}</span>
              </div>
              <a
                class="text-action"
                :href="/^[a-f0-9-]+$/i.test(exp.id) ? `#/experiences/${exp.id}` : '#/experiences'"
              >
                查看经验详情<ArrowUpRight :size="13" />
              </a>
            </div>
            <p class="task-prose">{{ exp.guidance }}</p>
          </article>
        </div>
      </Disclosure>

      <!-- Page & Semantic View Explorer -->
      <div v-if="pages.length" class="baseline-explorer">
        <div class="baseline-explorer-bar">
          <div
            v-if="pages.length > 1"
            class="segmented compact baseline-page-tabs"
            role="tablist"
            aria-label="选择基线页面"
          >
            <button
              v-for="page in pages"
              :key="page.path"
              type="button"
              role="tab"
              :aria-selected="activePage?.path === page.path"
              :class="{ selected: activePage?.path === page.path }"
              @click="selectedPagePath = page.path"
            >
              {{ page.title || page.path }}
              <span>{{ page.views.length }}</span>
            </button>
          </div>
          <div v-else-if="activePage" class="single-page-label">
            <Layers :size="15" />
            <strong>{{ activePage.title || '首页' }}</strong>
            <code>{{ activePage.path }}</code>
            <span class="text-muted small-text">{{ activePage.views.length }} 个语义区块</span>
          </div>

          <label v-if="(activePage?.views.length || 0) > 4" class="search-field baseline-view-search">
            <Search :size="15" />
            <input
              v-model="viewSearch"
              type="search"
              placeholder="筛选本页语义区块或布局约束"
              aria-label="筛选本页语义区块"
            />
          </label>
        </div>

        <div v-if="activePage && filteredViews.length" class="baseline-view-list">
          <article
            v-for="(view, viewIndex) in filteredViews"
            :id="viewDomId(activePage.path, view.id)"
            :key="view.id"
            class="baseline-view-card"
            :class="{ 'is-highlighted': highlightedViewId === view.id }"
          >
            <header class="baseline-view-head">
              <div class="baseline-view-title">
                <span class="view-order-num">{{ viewIndex + 1 }}</span>
                <h3>{{ view.title }}</h3>
                <code>{{ view.id }}</code>
                <span v-if="view.role" class="badge">{{ view.role }}</span>
              </div>
              <span class="badge" :class="view.required ? 'warning' : ''">
                {{ view.required ? '必需区块' : '可选区块' }}
              </span>
            </header>

            <div v-if="view.layouts.length" class="baseline-layout-grid">
              <div
                v-for="layout in orderedLayouts(view.layouts)"
                :key="layout.viewport"
                class="baseline-layout-pane"
              >
                <div class="baseline-layout-head">
                  <strong>{{ templateViewportNames[layout.viewport] }}布局要求</strong>
                  <code v-if="layout.selector" class="anchor-chip" :title="'参考站定位选择器（不要求目标站使用相同 DOM）：' + layout.selector">
                    参考锚点 {{ layout.selector }}
                  </code>
                </div>

                <p class="baseline-intent">{{ layout.intent || '未记录额外布局描述' }}</p>

                <ul v-if="layout.constraints.length" class="constraint-list">
                  <li v-for="constraint in layout.constraints" :key="constraint.id" class="constraint-item">
                    <div class="constraint-tags">
                      <span class="badge executor-pill">
                        {{ checkMap.get(constraint.checkId)?.title || constraint.checkId }}
                      </span>
                      <span v-if="constraint.relation" class="badge">
                        {{ templateRelationNames[constraint.relation] }}
                      </span>
                      <span v-if="constraint.preserveLines" class="badge">保持行数关系</span>
                    </div>
                    <p>{{ constraint.expected }}</p>
                    <div v-if="constraint.anchors.length" class="constraint-anchors">
                      <span class="tiny-label">参考子锚点：</span>
                      <code v-for="anchor in constraint.anchors" :key="anchor">{{ anchor }}</code>
                    </div>
                  </li>
                </ul>

                <p v-if="layout.exceptions" class="baseline-exception">
                  <strong>允许变化 / 正常例外：</strong>{{ layout.exceptions }}
                </p>

                <div v-if="layout.evidence.length" class="evidence-links">
                  <template v-for="(file, fileIdx) in layout.evidence" :key="file">
                    <button
                      v-if="canPreviewImage(file)"
                      type="button"
                      class="text-action"
                      @click="openLayoutEvidence(view, layout, file)"
                    >
                      <Image :size="13" />{{ evidenceItemLabel(file, fileIdx) }}
                    </button>
                    <a
                      v-else-if="evidenceDownloadHref(file)"
                      class="text-action"
                      :href="evidenceDownloadHref(file)!"
                      download
                    >
                      <Download :size="13" />{{ evidenceItemLabel(file, fileIdx) }}
                    </a>
                  </template>
                </div>
              </div>
            </div>
            <p v-else class="text-muted small-text">该区块暂无分视口布局明细。</p>
          </article>
        </div>

        <p v-else-if="activePage" class="text-muted small-text">
          没有匹配筛选条件的语义区块。
        </p>
      </div>

      <!-- All Registered Baseline Evidence -->
      <Disclosure
        v-if="baseline.evidence.length"
        :label="`冻结来源证据清单（${baseline.evidence.length}）`"
      >
        <div class="baseline-evidence-list">
          <div v-for="(item, idx) in baseline.evidence" :key="item.name" class="baseline-evidence-row">
            <div class="baseline-evidence-info">
              <strong>{{ templateEvidenceTitle(item, idx) }}</strong>
              <span class="text-muted small-text">{{ formatEvidenceMeta(item) }}</span>
            </div>
            <div class="toolbar-actions">
              <button
                v-if="canPreviewImage(item.name)"
                type="button"
                class="text-action"
                @click="openAllBaselineEvidence(item.name)"
              >
                <Image :size="14" />预览截图
              </button>
              <a
                v-if="evidenceDownloadHref(item.name)"
                class="text-action"
                :href="evidenceDownloadHref(item.name)!"
                download
              >
                <Download :size="14" />下载
              </a>
            </div>
          </div>
        </div>
      </Disclosure>
    </template>

    <!-- Frozen General Checklist Snapshot -->
    <div v-if="checklist" class="frozen-checklist-box">
      <Disclosure
        :label="`本任务冻结通用检查集 · v${checklist.revision} ${checklist.name}（启用 ${checklist.checks.filter(c => c.enabled).length} 项）`"
      >
        <div class="frozen-checklist-head">
          <span class="text-muted small-text">
            快照哈希 <code>{{ checklist.hash.slice(0, 16) }}</code> · 发布于 {{ formatDate(checklist.createdAt) }}
          </span>
          <a class="text-action" href="#/rules">管理通用检查集<ArrowUpRight :size="14" /></a>
        </div>
        <div class="table-scroll">
          <table class="task-table">
            <thead>
              <tr>
                <th>检查项</th>
                <th>类别 / 执行方式</th>
                <th>严重性 / 容差</th>
                <th>核验说明与例外</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="check in checklist.checks.filter(c => c.enabled)" :key="check.id">
                <td>
                  <strong>{{ check.title }}</strong>
                  <span class="table-subtitle">
                    <code>{{ check.id }}</code>{{ check.required ? ' · 必过项' : '' }}
                  </span>
                </td>
                <td>
                  {{ templateCheckKindNames[check.kind] }}
                  <span class="table-subtitle">{{ templateExecutorNames[check.executor] }}</span>
                </td>
                <td>
                  {{ templateSeverityNames[check.severity] }}
                  <span class="table-subtitle">容差 {{ check.tolerancePx }}px · 权重 {{ check.weight }}</span>
                </td>
                <td class="wrapping-cell">
                  {{ check.instruction }}
                  <span v-if="check.exceptions" class="table-subtitle">允许例外：{{ check.exceptions }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Disclosure>
    </div>

    <EvidenceViewer
      v-if="previewArtifacts.length"
      ref="viewer"
      :task-id="workflow.taskId"
      :artifacts="previewArtifacts"
    />
  </section>
</template>

<style scoped>
.baseline-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.baseline-panel > .section-heading {
  margin-bottom: 0;
  align-items: flex-start;
  flex-wrap: wrap;
}
.baseline-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
.baseline-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.baseline-pending-box {
  padding: 18px 20px;
  border-radius: 12px;
  background: var(--field);
}
.baseline-pending-box strong {
  display: block;
  font-size: 14px;
  margin-bottom: 6px;
}
.baseline-facts {
  margin: 0;
  padding: 16px 18px;
  border-radius: 12px;
  background: #f8faff;
}
.baseline-facts code {
  font-size: 12px;
  background: #eef2f9;
  padding: 2px 6px;
  border-radius: 4px;
}
.site-ext-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--blue);
  overflow-wrap: anywhere;
}
.site-ext-link:hover {
  text-decoration: underline;
}
.baseline-limitations {
  padding: 15px 18px;
  border-radius: 11px;
  background: #fff8ee;
  border: 1px solid #f5e2c4;
}
.baseline-limitations h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 650;
  color: #9a5b13;
}
.limitation-footnote {
  margin-top: 10px;
  font-size: 12px;
  color: #8c6a3d;
}
.baseline-mapping {
  padding: 15px 18px;
  border-radius: 11px;
  background: var(--field);
}
.baseline-mapping h3 {
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 6px;
}
.baseline-guidance-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.baseline-guidance-card {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--field);
  border: 1px solid #e7edf6;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.baseline-guidance-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.baseline-explorer {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.baseline-explorer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.baseline-page-tabs {
  max-width: 100%;
  overflow-x: auto;
}
.single-page-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.single-page-label code {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--field);
  color: var(--muted);
  font-size: 12px;
}
.baseline-view-search {
  width: min(320px, 100%);
  min-height: 34px;
}
.baseline-view-search input {
  padding: 6px 0;
  font-size: 12px;
}
.baseline-view-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.baseline-view-card {
  border: 1px solid #e6ebf3;
  border-radius: 12px;
  padding: 18px;
  background: var(--paper);
  scroll-margin-top: 20px;
}
.baseline-view-card.is-highlighted {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px #5079ed18;
}
.baseline-view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.baseline-view-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.view-order-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #edf2ff;
  color: var(--blue);
  font-size: 12px;
  font-weight: 650;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.baseline-view-title h3 {
  font-size: 15px;
  font-weight: 650;
}
.baseline-view-title code {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--field);
  color: var(--muted);
}
.baseline-layout-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.baseline-layout-pane {
  padding: 14px 16px;
  border-radius: 10px;
  background: #f8faff;
  border: 1px solid #edf1f8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.baseline-layout-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.baseline-layout-head strong {
  font-size: 13px;
}
.anchor-chip {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  background: #eef2f9;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.baseline-intent {
  font-size: 13px;
  line-height: 1.75;
  color: #334155;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.constraint-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.constraint-item {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--paper);
  border: 1px solid #e9eef6;
  font-size: 12px;
  line-height: 1.65;
}
.constraint-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 5px;
}
.executor-pill {
  color: #3b61bc;
  background: #edf2ff;
}
.constraint-anchors {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.constraint-anchors code {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--field);
  color: #526079;
}
.baseline-exception {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.65;
  padding-top: 6px;
  border-top: 1px dashed #e2e8f0;
  overflow-wrap: anywhere;
}
.baseline-evidence-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.baseline-evidence-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--field);
}
.baseline-evidence-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.baseline-evidence-info strong {
  font-size: 13px;
}
.frozen-checklist-box {
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.frozen-checklist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
@media (max-width: 860px) {
  .baseline-layout-grid {
    grid-template-columns: 1fr;
  }
}
</style>
