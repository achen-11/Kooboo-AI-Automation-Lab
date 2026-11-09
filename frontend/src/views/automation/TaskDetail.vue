<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, ArrowUpRight, ExternalLink, Ban, Play, FileText, Send, X, LoaderCircle, MoreHorizontal, CircleAlert, Check, Clock3, Download } from '@lucide/vue';
import { scenarios, taskStatusNames, optimizationStateNames, supportsAutomaticOptimization, type AutomationTask, type AutomationSettings, type Resource, type GeneratedSite } from '../../../../shared/automation';
import { initialTaskTab, stageNames, type TaskSnapshot, type TaskTab } from '../../../../shared/task-presentation';
import { api, formatDate, go, message } from '../../api';
import { notify } from '../../lib/notifications';
import { siteReportLink } from '../../lib/site-reports';
import TaskUsage from '../../components/TaskUsage.vue';
import SiteTaskUsage from './SiteTaskUsage.vue';
import TaskExecution from './TaskExecution.vue';
import TaskInput from './TaskInput.vue';
import TaskReport from './TaskReport.vue';
import SiteReports from './SiteReports.vue';
import TaskDeliverySection from './TaskDeliverySection.vue';
import SiteDeliveryPanel from './SiteDeliveryPanel.vue';
import TaskCollection from './TaskCollection.vue';
import CreateTaskDialog from './CreateTaskDialog.vue';
import DiagnosticExportDialog from './DiagnosticExportDialog.vue';
import { useTaskSection } from './use-task-section';
import { scopeName, workspace } from './common';
const props = defineProps<{ id: string }>();
const tab = ref<TaskTab>(initialTaskTab(window.location.hash.split('?')[1] || ''));
const { data, loading, error, load } = useTaskSection<TaskSnapshot>(() => `/automation/tasks/${props.id}/summary`);
const task = computed(() => data.value?.task);
const evaluation = computed(() => data.value?.evaluation);
const optimizationActive=computed(()=>task.value?.optimization&&!['completed','stopped'].includes(task.value.optimization.state));
const current = computed(() => task.value?.optimization?.state==='planning'?task.value:data.value?.active|| (task.value?.kind === 'generation' && task.value.status === 'completed' && evaluation.value ? evaluation.value : task.value));
const report = computed(() => task.value?.optimization&&!data.value?.currentReportId?null:task.value?.report || evaluation.value?.report);
const siteRefresh = ref(0);
const busy = ref(false), actionError = ref(''), followKind = ref<'generation' | 'evaluation'>('generation'), requirements = ref('');
const optimizeDialog=ref<HTMLDialogElement>(),optimizeScore=ref(85),optimizeRounds=ref(3),optimizeCost=ref<number|string>('');
const canEnableOptimization=computed(()=>task.value?.kind==='generation'&&supportsAutomaticOptimization(task.value.scenario)&&!task.value.optimization&&task.value.status==='completed'&&evaluation.value?.status==='completed'&&canCreateRound.value);
async function openOptimization(){more.value?.removeAttribute('open');if(busy.value)return;busy.value=true;actionError.value='';try{const settings=await api<AutomationSettings>('/automation/settings');optimizeScore.value=settings.optimization?.targetScore??85;optimizeRounds.value=settings.optimization?.maxRounds??3;optimizeCost.value=settings.optimization?.maxCostCny??'';optimizeDialog.value?.showModal();}catch(reason){actionError.value=message(reason);}finally{busy.value=false;}}
async function enableOptimization(){if(!task.value||busy.value)return;busy.value=true;actionError.value='';try{await api(`/automation/tasks/${task.value.id}/optimize`,{method:'POST',body:JSON.stringify({targetScore:optimizeScore.value,maxRounds:optimizeRounds.value,maxCostCny:optimizeCost.value===''?null:Number(optimizeCost.value)})});optimizeDialog.value?.close();notify.success('已开启自动优化');await load();}catch(reason){actionError.value=message(reason);}finally{busy.value=false;}}
const followDialog = ref<HTMLDialogElement>(), more = ref<HTMLDetailsElement>();
const diagnosticDialog = ref<InstanceType<typeof DiagnosticExportDialog>>();
function openDiagnostic() { more.value?.removeAttribute('open'); void diagnosticDialog.value?.open(); }
const canRecover = computed(() => current.value?.stopped && ['pending', 'failed', 'interrupted'].includes(current.value.status));
const canCancel = computed(() => current.value && (!current.value.stopped || ['queued', 'following-up'].includes(current.value.status)) && !['completed', 'failed', 'cancelled', 'interrupted'].includes(current.value.status));
const canCreateRound = computed(() => !optimizationActive.value && (!data.value?.active||data.value.active.stopped&&!['queued','running','following-up','cancelling'].includes(data.value.active.status)) && task.value?.stopped && task.value.generatedSiteId && !['queued', 'running', 'following-up', 'cancelling'].includes(task.value.status) && (!evaluation.value || evaluation.value.stopped && !['queued', 'running', 'following-up', 'cancelling'].includes(evaluation.value.status)));
const canContinue = computed(() => canCreateRound.value && !canRecover.value && task.value?.kind === 'generation' && task.value.status === 'completed');
const continueDialog = ref<InstanceType<typeof CreateTaskDialog>>();
const continueResources = ref<Resource[]>([]), continueSite = ref<GeneratedSite>();
async function openContinuation() {
  if (!task.value || !canContinue.value || busy.value) return;
  const source = task.value;
  busy.value = true; actionError.value = '';
  try {
    const [input, settings] = await Promise.all([
      api<{ resource: Resource; sites: GeneratedSite[] }>(`/automation/resources/${source.resourceId}`),
      api<AutomationSettings>('/automation/settings'),
    ]);
    if (task.value?.id !== source.id) return;
    const site = input.sites.find(item => item.id === source.generatedSiteId);
    if (!site) throw new Error('原生成站不存在，请到资源中检查站点关联');
    continueResources.value = [input.resource]; continueSite.value = site; workspace.settings = settings;
    await nextTick(); await continueDialog.value?.open({ scope: 'site' });
  } catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
const tabs = computed<{ id: TaskTab; label: string }[]>(() => [
  { id: 'overview', label: '概览' }, { id: 'report', label: '评测结果' }, { id: 'execution', label: '执行记录' }, { id: 'usage', label: '用量费用' }, { id: 'input', label: '输入与配置' }, ...(data.value?.deliveryEnabled ? [{ id: 'delivery' as const, label: '交付' }] : []),
]);
const revision = computed(() => `${task.value?.updatedAt}:${evaluation.value?.updatedAt}:${data.value?.active?.updatedAt}`);
const reportRevision = computed(() => JSON.stringify([task.value?.optimization,task.value?.status, evaluation.value?.status, report.value]));
const qualities = { passed: '达到标准', failed: '需要改进', unverified: '有待验证' };
const viewportNames: Record<string, string> = { desktop: 'PC', mobile: '移动端', business: '业务' };
function selectTab(value: TaskTab) {
  tab.value = value; more.value?.removeAttribute('open');
  window.history.replaceState(null, '', value === 'report' ? siteReportLink(props.id) : `#/tasks/${props.id}${value === 'overview' ? '' : `?tab=${value}`}`);
}
function openTaskReport() {
  const id = task.value?.kind === 'evaluation' ? task.value.id : evaluation.value?.id;
  if (id) go(siteReportLink(props.id, id).slice(1));
}
function hashChanged() { tab.value = initialTaskTab(window.location.hash.split('?')[1] || ''); }
async function tabKey(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const items = tabs.value;
  const position = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
  selectTab(items[position].id); await nextTick(); document.getElementById(`task-tab-${items[position].id}`)?.focus();
}
async function action(suffix: string, id = current.value?.id) {
  if (!id || busy.value) return;
  busy.value = true; actionError.value = '';
  try { await api(`/automation/tasks/${id}/${suffix}`, { method: 'POST' }); notify.success(suffix === 'resume' ? '已交给 AI 继续跟进' : ['cancel','optimization/stop'].includes(suffix) ? '已提交停止请求' : '已确认原执行停止'); await load(); }
  catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
function followup(kind: 'generation' | 'evaluation') {
  more.value?.removeAttribute('open'); followKind.value = kind; requirements.value = kind === 'evaluation' ? '按本轮规则重新评测，独立保存证据与报告。' : ''; actionError.value = ''; followDialog.value?.showModal();
}
async function submit() {
  if (!task.value || busy.value) return;
  busy.value = true; actionError.value = '';
  try { const result = await api<{ items: AutomationTask[] }>(`/automation/tasks/${task.value.id}/followup`, { method: 'POST', body: JSON.stringify({ kind: followKind.value, requirements: requirements.value }) }); followDialog.value?.close(); go(`/tasks/${result.items[0].id}`); }
  catch (reason) { actionError.value = message(reason); }
  finally { busy.value = false; }
}
let timer: ReturnType<typeof setInterval>;
function dismissMore(event: MouseEvent) { if (more.value && !more.value.contains(event.target as Node)) more.value.removeAttribute('open'); }
function escape(event: KeyboardEvent) { if (event.key === 'Escape') more.value?.removeAttribute('open'); }
onMounted(() => { timer = setInterval(() => { if (!document.hidden && !loading.value && !busy.value) void load().then(() => siteRefresh.value++); }, 4000); window.addEventListener('hashchange', hashChanged); document.addEventListener('click', dismissMore); document.addEventListener('keydown', escape); });
onUnmounted(() => { clearInterval(timer); window.removeEventListener('hashchange', hashChanged); document.removeEventListener('click', dismissMore); document.removeEventListener('keydown', escape); });
</script>
<template>
  <a class="back-link" href="#/tasks"><ArrowLeft :size="16" />任务中心</a>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !task" class="section-loading"><LoaderCircle class="spin" :size="18" />正在加载任务…</p>
  <template v-if="task">
    <header class="page-header task-detail-header"><div class="task-heading"><h1>{{ task.resourceName }}</h1><p>{{ scenarios[task.scenario] }} · {{ task.kind === 'generation' ? '生成任务' : '评测任务' }} · {{ scopeName(task.scope) }} <span class="status-badge task-header-status" :class="current?.status">{{ task.optimization && !(task.optimization.state==='waiting-evaluation'&&task.optimization.activeTaskId===task.id) ? optimizationStateNames[task.optimization.state] : current ? taskStatusNames[current.status] : taskStatusNames[task.status] }}</span></p></div><div class="toolbar-actions task-header-actions">
      <a v-if="task.siteUrl" class="button secondary" :href="task.siteUrl" target="_blank" rel="noopener noreferrer"><ExternalLink :size="16" />打开站点</a>
      <button v-if="canRecover" class="button primary" :disabled="busy" @click="action('resume')"><Play :size="16" />恢复任务</button>
      <button v-if="canContinue" class="button primary" :disabled="busy" @click="openContinuation"><LoaderCircle v-if="busy" class="spin" :size="16" /><Send v-else :size="16" />{{ task.scope === 'homepage' ? '补全全站' : '继续生成' }}</button>
      <button v-if="!canRecover && report && tab !== 'report'" class="button" :class="canContinue ? 'secondary' : 'primary'" @click="selectTab('report')"><FileText :size="16" />查看评测结果</button>
      <button v-else-if="!canRecover && canCreateRound && !evaluation && task.kind === 'generation'" class="button" :class="canContinue ? 'secondary' : 'primary'" :disabled="busy || !task.siteUrl" @click="followup('evaluation')"><FileText :size="16" />发起评测</button>
      <button v-if="optimizationActive" class="button secondary" :disabled="busy||current?.status==='cancelling'" @click="action('optimization/stop',task.id)"><Ban :size="16" />停止优化</button>
      <button v-else-if="canCancel" class="button secondary" :disabled="busy || current?.status === 'cancelling'" @click="action('cancel')"><Ban :size="16" />{{ current?.status === 'cancelling' ? '正在停止' : '取消任务' }}</button>
      <details ref="more" class="task-more"><summary class="button secondary"><MoreHorizontal :size="17" /><span>更多</span></summary><div class="task-action-menu"><template v-if="canCreateRound"><button v-if="canEnableOptimization" @click="openOptimization"><Play :size="15" />自动优化到目标</button><button v-if="!canContinue" @click="followup('generation')"><Send :size="15" />提交生成跟进</button><button :disabled="!task.siteUrl" @click="followup('evaluation')"><FileText :size="15" />{{ report ? '重新评测' : '发起评测' }}</button></template><button @click="openDiagnostic"><Download :size="15" />导出排障包</button></div></details>
    </div></header>
    <CreateTaskDialog ref="continueDialog" :resources="continueResources" :site="continueSite" />
    <DiagnosticExportDialog :key="task.id" ref="diagnosticDialog" :task-id="task.id" />
    <p v-if="actionError && !followDialog?.open" class="alert error" role="alert">{{ actionError }}</p>
    <nav class="task-tabs" role="tablist" aria-label="任务详情分区"><button v-for="(item, index) in tabs" :id="`task-tab-${item.id}`" :key="item.id" role="tab" :aria-selected="tab === item.id" :aria-controls="`task-panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" :class="{ selected: tab === item.id }" @click="selectTab(item.id)" @keydown="tabKey($event, index)">{{ item.label }}</button></nav>
    <div :id="`task-panel-${tab}`" role="tabpanel" :aria-labelledby="`task-tab-${tab}`" class="task-tab-content">
      <template v-if="tab === 'overview'">
        <TaskCollection v-if="task.scope==='site' && ['migration','upgrade'].includes(task.scenario)" :task-id="task.id" :revision="revision" />
        <SiteDeliveryPanel v-if="task.generatedSiteId" :site-id="task.generatedSiteId" :revision="revision + ':' + siteRefresh" />
        <section v-if="task.optimization" class="panel settings-panel"><div class="section-heading"><h2>{{optimizationStateNames[task.optimization.state]}}</h2><span>修复 {{task.optimization.round}}<template v-if="!task.completionFirst || task.hardMaxRounds"> / {{task.hardMaxRounds ?? task.optimization.policy.maxRounds}}</template><template v-else> · 持续至质量达标</template></span></div><p class="task-prose">双端目标 {{task.optimization.policy.targetScore}} 分<span v-if="task.optimization.policy.maxCostCny!==null"> · 费用上限 ¥ {{task.optimization.policy.maxCostCny}}</span></p><p v-if="!report" class="task-prose">当前版本待完成独立评测，历史分数请在评测结果中查看。</p><p v-if="task.optimization.reason" class="task-prose">{{task.optimization.reason}}</p><p v-if="task.optimization.nextStep" class="task-prose">下一步：{{task.optimization.nextStep}}</p></section>
        <section class="panel settings-panel"><div class="section-heading"><h2>流程进展</h2><span class="text-muted small-text">{{ formatDate(task.createdAt) }} 创建</span></div><div class="task-workflow"><div class="workflow-stage"><span class="workflow-stage-icon" :class="task.status"><Check v-if="task.status === 'completed'" :size="18" /><LoaderCircle v-else-if="['running', 'following-up'].includes(task.status)" class="spin" :size="18" /><CircleAlert v-else-if="task.attention" :size="18" /><Clock3 v-else :size="18" /></span><div><strong>{{ task.kind === 'generation' ? '站点生成' : '独立评测' }}</strong><p>{{ taskStatusNames[task.status] }}</p></div></div><template v-if="task.kind === 'generation'"><div class="workflow-connector" /><div class="workflow-stage"><span class="workflow-stage-icon" :class="evaluation?.status"><Check v-if="evaluation?.status === 'completed'" :size="18" /><LoaderCircle v-else-if="evaluation && ['running', 'following-up'].includes(evaluation.status)" class="spin" :size="18" /><CircleAlert v-else-if="evaluation?.attention" :size="18" /><Clock3 v-else :size="18" /></span><div><strong>独立评测</strong><p>{{ evaluation ? taskStatusNames[evaluation.status] : task.status === 'completed' ? '尚未发起' : '等待生成完成' }}</p></div></div></template></div><p v-if="current?.status === 'following-up'" class="task-overview-note">AI 正在跟进{{ stageNames[current.stage || ''] || '当前阶段' }}，系统会继续执行并保留结果。</p></section>
        <section v-if="current?.attention" class="panel settings-panel task-section-stack"><div class="section-heading"><h2>需要处理</h2><span class="status-badge" :class="current.status">{{ taskStatusNames[current.status] }}</span></div><p class="task-prose">{{ current.attention }}</p><p v-if="current.nextStep" class="task-prose"><strong>下一步：</strong>{{ current.nextStep }}</p><div class="task-actions"><button v-if="current.stopped" class="button primary" :disabled="busy" @click="action('resume')"><Play :size="16" />交给 AI 恢复</button><button v-else class="button secondary" :disabled="busy" @click="action('confirm-stopped')">已检查并确认原执行停止</button><a v-if="current.id !== task.id" class="text-action" :href="`#/tasks/${current.id}?tab=execution`">查看评测中断详情<ArrowUpRight :size="14" /></a><button v-else class="text-action" @click="selectTab('execution')">查看完整原因与处理记录<ArrowUpRight :size="14" /></button></div><p v-if="!current.stopped" class="text-muted small-text">请先检查原会话或执行进程，确认停止后再恢复。</p></section>
        <section v-if="report" class="panel settings-panel"><div class="section-heading"><h2>本次任务评测</h2><button class="text-action" @click="openTaskReport">查看完整报告<ArrowUpRight :size="14" /></button></div><div class="overview-results"><strong :class="report.quality === 'passed' ? 'success-text' : 'warning-text'">{{ qualities[report.quality] }}</strong><div v-for="score in report.scores" :key="score.viewport"><span>{{ viewportNames[score.viewport] || score.viewport }}</span><strong>{{ score.value ?? '未验证' }}</strong></div></div><p class="task-overview-note">{{ report.issueCount }} 个问题 · {{ report.unverifiedCount }} 项未验证</p></section>
        <section class="panel settings-panel"><div class="section-heading"><h2>最新进展</h2><a v-if="data?.latest && data.latest.taskId !== task.id" class="text-action" :href="'#/tasks/' + data.latest.taskId + '?tab=execution'">查看执行记录<ArrowUpRight :size="14" /></a><button v-else class="text-action" @click="selectTab('execution')">查看执行记录<ArrowUpRight :size="14" /></button></div><p class="task-prose">{{ task.optimization ? (task.optimization.reason||optimizationStateNames[task.optimization.state]) : evaluation?.status === 'completed' && report ? '生成与独立评测均已结束，报告和证据已保存。' : task.kind === 'evaluation' && report ? '本轮评测已结束，报告和证据已保存。' : data?.latest?.message || '任务已创建，等待执行。' }}</p><div class="task-related-links"><a :href="`#/resources/${task.resourceId}`">查看资源<ArrowUpRight :size="14" /></a><a v-if="evaluation" :href="`#/tasks/${evaluation.id}?tab=report`">关联评测任务<ArrowUpRight :size="14" /></a><a v-if="task.parentId" :href="`#/tasks/${task.parentId}`">上一轮任务<ArrowUpRight :size="14" /></a></div></section>
        <section v-if="!task.generatedSiteId" class="panel settings-panel"><div class="section-heading"><h2>费用摘要</h2><button class="text-action" @click="selectTab('usage')">查看用量费用<ArrowUpRight :size="14" /></button></div><p class="overview-cost">{{ task.usage?.priced ? '¥ ' + task.usage.knownCny.toFixed(4) : '待核算' }}<span>已知用量估算{{ task.usage?.missing ? '小计' : '' }}</span></p><p v-if="task.usage?.missing" class="warning-text task-overview-note">{{ task.usage.missing }} 条记录待核算</p></section>
      </template>
      <SiteReports v-else-if="tab === 'report' && task.generatedSiteId" :key="task.generatedSiteId" :task-id="task.id" :site-id="task.generatedSiteId" :task-kind="task.kind" :revision="revision + ':' + siteRefresh" :detail-revision="reportRevision" />
      <TaskReport v-else-if="tab === 'report'" :task-id="task.id" :revision="reportRevision" />
      <TaskExecution v-else-if="tab === 'execution'" :task-id="task.id" :updated-at="data?.active?.updatedAt||task.updatedAt" />
      <SiteTaskUsage v-else-if="tab === 'usage' && task.generatedSiteId" :task-id="task.id" :site-id="task.generatedSiteId" :revision="revision + ':' + siteRefresh" />
      <TaskUsage v-else-if="tab === 'usage'" :task-id="task.id" :summary="task.usage" />
      <TaskInput v-else-if="tab === 'input'" :task-id="task.id" :resource-id="task.resourceId" :scope="task.scope" />
      <TaskDeliverySection v-else-if="tab === 'delivery' && data?.deliveryEnabled" :task-id="task.id" :revision="revision" @changed="load" />
      <section v-else class="panel empty-state"><h2>此任务未启用交付</h2><button class="text-action" @click="selectTab('overview')">返回概览</button></section>
    </div>
    <dialog ref="optimizeDialog" class="modal"><form @submit.prevent="enableOptimization"><div class="modal-head"><h2>开启自动优化</h2><button type="button" class="icon-button" :disabled="busy" aria-label="关闭" @click="optimizeDialog?.close()"><X :size="20" /></button></div><p class="text-muted">沿用当前站点、输入和规则；依据独立报告继续修复并复评。</p><div class="form-grid"><label class="field"><span>双端目标分数</span><input v-model.number="optimizeScore" class="input" type="number" min="1" max="100" required /></label><label class="field"><span>最多修复轮数</span><input v-model.number="optimizeRounds" class="input" type="number" min="1" max="10" required /></label><label class="field"><span>费用上限（元，可选）</span><input v-model.number="optimizeCost" class="input" type="number" min="0.0001" step="any" placeholder="不设置" /></label></div><p v-if="actionError" class="alert error">{{actionError}}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="optimizeDialog?.close()">取消</button><button class="button primary" :disabled="busy"><LoaderCircle v-if="busy" class="spin" :size="16" /><Play v-else :size="16" />开启优化</button></div></form></dialog>
    <dialog ref="followDialog" class="modal"><form @submit.prevent="submit"><div class="modal-head"><h2>{{ followKind === 'evaluation' ? '发起新一轮评测' : '提交生成跟进' }}</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="followDialog?.close()"><X :size="20" /></button></div><p class="text-muted">在当前生成站创建新一轮任务，保留原任务及报告。</p><label class="field"><span>{{ followKind === 'evaluation' ? '评测要求' : '跟进消息' }}</span><textarea v-model="requirements" class="input" rows="6" required /></label><p v-if="actionError" class="alert error">{{ actionError }}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="followDialog?.close()">取消</button><button class="button primary" :disabled="busy"><LoaderCircle v-if="busy" class="spin" :size="16" /><Send v-else :size="16" />加入队列</button></div></form></dialog>
  </template>
</template>
