<script setup lang="ts">
import { notify } from '../../lib/notifications';
import { siteReportLink } from '../../lib/site-reports';
import type { SiteDeliverySummary } from '../../../../shared/site-delivery';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { Plus, Search, Upload, Play, FolderOpen, ArrowLeft, Pencil, ExternalLink, File, FileText, X, LoaderCircle, Link, History, ChevronLeft, ChevronRight, ChevronDown, Check } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import MaterialUploader from '../../components/MaterialUploader.vue';
import MaterialBrowser from '../../components/MaterialBrowser.vue';
import BatchMaterialImport from './BatchMaterialImport.vue';
import CreateTaskDialog from './CreateTaskDialog.vue';
import { api, message, go, platform, formatDate } from '../../api';
import { workspace, refresh, scopeName } from './common';
import { scenarios, type Resource, type ResourceInput, type GeneratedSite, type InputVersion, type MaterialFile, taskStatusNames } from '../../../../shared/automation';
const props=defineProps<{id?:string}>();
const query=ref(''),scenario=ref(''),page=ref(1),selected=ref<string[]>([]),error=ref('');
const editDialog=ref<HTMLDialogElement>(),attachDialog=ref<HTMLDialogElement>(),taskDialog=ref<InstanceType<typeof CreateTaskDialog>>();
const batchDialog=ref<InstanceType<typeof BatchMaterialImport>>(),materialUploader=ref<InstanceType<typeof MaterialUploader>>(),editSession=ref(0),pendingUploads=ref(false);
const busy=ref(false),uploading=ref(false),editing=ref<Resource|null>(null);const versions=ref<InputVersion[]>([]);
const reportsLoading = ref<string | null>(null);
async function openReports(site: GeneratedSite) {
  if (reportsLoading.value) return;
  reportsLoading.value = site.id;
  try {
    const delivery = await api<SiteDeliverySummary>(`/automation/site-deliveries/${site.id}`);
    if (delivery.detailTaskId) go(siteReportLink(delivery.detailTaskId).slice(1));
    else notify.info('该生成站尚未发起任务或评测');
  } catch (reason) { notify.error(message(reason)); }
  finally { reportsLoading.value = null; }
}
const blank=():ResourceInput=>({name:'',scenario:'materials',description:'',contentUrl:'',referenceUrl:'',externalSource:'',externalId:'',files:[]});
const form=ref(blank());const taskResources=ref<Resource[]>([]),taskSite=ref<GeneratedSite>(),taskKind=ref<'generation'|'evaluation'>('generation');
const filtered=computed(()=>workspace.resources.filter(r=>(!scenario.value||r.scenario===scenario.value)&&(!query.value||[r.name,r.description,r.contentUrl,r.externalId,r.externalSource].join(' ').toLowerCase().includes(query.value.toLowerCase()))));
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/20)));const rows=computed(()=>filtered.value.slice((page.value-1)*20,page.value*20));
const checked=computed(()=>rows.value.length>0&&rows.value.every(r=>selected.value.includes(r.id)));const partial=computed(()=>!checked.value&&rows.value.some(r=>selected.value.includes(r.id)));
const resource=computed(()=>workspace.resources.find(r=>r.id===props.id));const sites=computed(()=>workspace.sites.filter(s=>s.resourceId===props.id));const tasks=computed(()=>workspace.tasks.filter(t=>t.resourceId===props.id));
const tab=ref('sites');
const inputDetailsOpen=ref(false),inputDetailsId=useId();
const materialSites=computed(()=>{
  const item=resource.value;if(!item)return [];
  const reference=item.referenceUrl||item.contentUrl;
  if(item.contentUrl===reference&&item.contentUrl)return [{label:'内容 / 参考站',url:item.contentUrl}];
  return [...(item.contentUrl?[{label:'内容站',url:item.contentUrl}]:[]),...(reference?[{label:'参考站',url:reference}]:[])];
});
function hostname(url:string){try{return new URL(url).hostname;}catch{return url;}}
watch([query,scenario],()=>page.value=1);watch(pages,v=>page.value=Math.min(page.value,v));
async function load(){await refresh();if(props.id)try{versions.value=(await api<{versions:InputVersion[]}>(`/automation/resources/${props.id}`)).versions;}catch(e){error.value=message(e);}}
watch(()=>props.id,()=>{tab.value='sites';inputDetailsOpen.value=false;void load();});onMounted(load);
function toggleAll(event:Event){const checked=(event.target as HTMLInputElement).checked;const visible=new Set(rows.value.map(r=>r.id));selected.value=checked?[...new Set([...selected.value,...visible])]:selected.value.filter(id=>!visible.has(id));}
function edit(item?:Resource){editSession.value++;pendingUploads.value=false;editing.value=item||null;form.value=item?{name:item.name,scenario:item.scenario,description:item.description,contentUrl:item.contentUrl,referenceUrl:item.referenceUrl,externalSource:item.externalSource,externalId:item.externalId,files:item.files.map(f=>({...f}))}:blank();error.value='';editDialog.value?.showModal();}
async function save(){busy.value=true;error.value='';try{if(pendingUploads.value&&materialUploader.value&&!await materialUploader.value.upload())throw new Error('部分资料未上传，请检查文件列表后重试');const item=await api<Resource>(editing.value?`/automation/resources/${editing.value.id}`:'/automation/resources',{method:editing.value?'PUT':'POST',body:JSON.stringify({...form.value,...(editing.value?{revision:editing.value.revision}:{})})});editDialog.value?.close();await load();go(`/resources/${item.id}`);}catch(e){error.value=message(e);}finally{busy.value=false;}}
async function importJson(event:Event){const input=event.target as HTMLInputElement;error.value='';busy.value=true;try{const file=input.files?.[0];if(!file)return;const data=JSON.parse(await file.text());const result=await api<{items:Resource[]}>('/v1/resources/import',{method:'POST',body:JSON.stringify(Array.isArray(data)?data:[data])});await load();notify.success(`已导入 ${result.items.length} 条资源`);}catch(e){error.value=message(e);}finally{busy.value=false;input.value='';}}
async function create(items:Resource[],site?:GeneratedSite,kind:'generation'|'evaluation'='generation'){taskResources.value=items;taskSite.value=site;taskKind.value=kind;await nextTick();await taskDialog.value?.open();}
const attach=ref({name:'',siteId:'',url:'',environmentId:''});
function openAttach(){attach.value={name:'',siteId:'',url:'',environmentId:platform.settings?.environments[0]?.id||''};error.value='';attachDialog.value?.showModal();}
async function saveAttach(){busy.value=true;try{await api('/automation/sites',{method:'POST',body:JSON.stringify({...attach.value,resourceId:props.id})});attachDialog.value?.close();await load();}catch(e){error.value=message(e);}finally{busy.value=false;}}
</script>
<template>
<template v-if="!id"><header class="page-header"><div><h1>资源库</h1></div><div class="toolbar-actions"><button class="button secondary" @click="batchDialog?.open()"><FolderOpen :size="17"/>导入资料文件夹</button><label class="button secondary" :class="{disabled:busy}"><Upload :size="17" />导入 JSON<input class="sr-only" type="file" accept=".json" :disabled="busy" @change="importJson" /></label><button class="button primary" @click="edit()"><Plus :size="17" />新建资源</button></div></header>
<p v-if="error" class="alert error" role="alert">{{error}}</p>
<section class="panel"><div class="table-toolbar"><label class="search-field"><Search :size="18" /><input v-model="query" placeholder="搜索资源、站点或外部标识" aria-label="搜索资源" /></label><BaseSelect v-model="scenario" size="small" aria-label="筛选场景" :options="[{ value: '', label: '全部场景' }, ...Object.entries(scenarios).map(([key, label]) => ({ value: key, label: (label) }))]" /></div>
<div v-if="selected.length" class="selection-bar"><span>已选 {{selected.length}} 项</span><button class="text-action" @click="selected=[]">清空选择</button><button class="button primary small" @click="create(workspace.resources.filter(r=>selected.includes(r.id)))"><Play :size="15" />批量生成</button></div>
<div class="table-scroll"><table class="task-table resource-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择本页全部资源" :checked="checked" :indeterminate.prop="partial" :disabled="!rows.length" @change="toggleAll" /></th><th>资源名称</th><th>场景</th><th>内容站</th><th>生成站</th><th>更新时间</th><th /></tr></thead><tbody><tr v-for="item in rows" :key="item.id" :class="{'row-selected':selected.includes(item.id)}"><td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="item.id" :aria-label="`选择 ${item.name}`" /></td><td><a class="task-title" :href="`#/resources/${item.id}`">{{item.name}}</a><span class="table-subtitle">版本 {{item.revision}}<template v-if="item.externalSource"> · {{item.externalSource}} / {{item.externalId}}</template></span></td><td>{{scenarios[item.scenario]}}</td><td><a v-if="item.contentUrl" class="site-link" :href="item.contentUrl" target="_blank" rel="noopener noreferrer">{{hostname(item.contentUrl)}}<ExternalLink :size="12" /></a><span v-else class="text-muted">—</span></td><td>{{workspace.sites.filter(s=>s.resourceId===item.id).length}}</td><td class="date-cell">{{formatDate(item.updatedAt)}}</td><td><button class="button secondary small" @click="create([item])"><Play :size="14" />生成</button></td></tr></tbody></table></div>
<div v-if="!rows.length" class="empty-state"><span class="empty-icon"><FolderOpen :size="30" /></span><h2>{{workspace.resources.length?'没有匹配的资源':'添加第一份资源'}}</h2><p>填写说明、站点地址，或上传任意资料文件</p><button v-if="!workspace.resources.length" class="button secondary" @click="edit()"><Plus :size="16" />新建资源</button></div>
<footer class="table-footer"><span>共 {{filtered.length}} 项</span><div class="pagination"><button class="icon-button" :disabled="page<=1" aria-label="上一页" @click="page--"><ChevronLeft :size="17" /></button><span>{{page}} / {{pages}}</span><button class="icon-button" :disabled="page>=pages" aria-label="下一页" @click="page++"><ChevronRight :size="17" /></button></div></footer></section></template>
<template v-else-if="resource">
<div class="resource-detail-top">
  <header class="resource-detail-header">
    <div class="resource-detail-identity"><a class="icon-button resource-back" href="#/resources" aria-label="返回资源库" title="返回资源库"><ArrowLeft :size="18" /></a><h1 :title="resource.name">{{resource.name}}</h1></div>
    <div class="toolbar-actions"><button class="button secondary small resource-edit" aria-label="编辑资料" @click="edit(resource)"><Pencil :size="15" /><span>编辑资料</span></button><button class="button primary small" @click="create([resource])"><Plus :size="16" />新建生成站</button></div>
  </header>
  <div class="resource-detail-navigation"><nav class="segmented resource-detail-tabs" aria-label="资源详情分区"><button v-for="item in [{id:'sites',label:'生成站'},{id:'materials',label:'资料与输入'},{id:'history',label:'版本历史'},{id:'tasks',label:'任务记录'}]" :key="item.id" :class="{selected:tab===item.id}" :aria-pressed="tab===item.id" @click="tab=item.id">{{item.label}}</button></nav><span class="resource-detail-meta">{{scenarios[resource.scenario]}} · 输入版本 {{resource.revision}}</span></div>
</div>
<section v-if="tab==='sites'" class="panel"><div class="section-heading panel-heading"><h2>{{sites.length}} 个生成站</h2><button class="button secondary small" @click="openAttach()"><Link :size="15" />关联已有站点</button></div><div v-if="!sites.length" class="empty-state"><FolderOpen :size="30" /><h2>还没有生成站</h2><p>同一资源可以多次生成，也可以关联已有站点</p></div><div v-else class="site-grid"><article v-for="site in sites" :key="site.id" class="site-card"><h3>{{site.name}}</h3><a v-if="site.url" class="site-link" :href="site.url" target="_blank" rel="noopener noreferrer">{{site.url}}<ExternalLink :size="14" /></a><p v-else class="text-muted">公开地址待确认</p><span class="table-subtitle">{{formatDate(site.createdAt)}}</span><div class="inline-actions"><button class="button secondary small" @click="create([resource],site)">继续生成</button><button class="button primary small" :disabled="!site.url" @click="create([resource],site,'evaluation')">发起评测</button></div><button class="text-action" :disabled="Boolean(reportsLoading)" @click="openReports(site)"><LoaderCircle v-if="reportsLoading === site.id" class="spin" :size="14" />查看评测记录</button></article></div></section>
<section v-if="tab==='materials'" class="panel resource-materials">
  <MaterialBrowser :key="resource.id" :files="resource.files">
    <template #context>
      <a v-for="site in materialSites" :key="site.label" class="resource-material-link" :href="site.url" target="_blank" rel="noopener noreferrer" :title="site.url" :aria-label="`打开${site.label}：${site.url}`"><span class="resource-material-link-label">{{site.label}}</span><span class="resource-material-link-url">{{site.url}}</span><ExternalLink :size="12" aria-hidden="true" /></a>
      <button v-if="resource.description.trim()||resource.externalSource" type="button" class="resource-input-toggle" :aria-expanded="inputDetailsOpen" :aria-controls="inputDetailsId" @click="inputDetailsOpen=!inputDetailsOpen"><FileText :size="13" aria-hidden="true" />输入说明<ChevronDown v-if="inputDetailsOpen" :size="13" aria-hidden="true" /><ChevronRight v-else :size="13" aria-hidden="true" /></button>
    </template>
    <template #details>
      <div v-if="inputDetailsOpen" :id="inputDetailsId" class="resource-input-details">
        <pre v-if="resource.description.trim()">{{resource.description}}</pre>
        <p v-if="resource.externalSource"><span>外部来源</span>{{resource.externalSource}} / {{resource.externalId}}</p>
      </div>
    </template>
  </MaterialBrowser>
</section>
<section v-if="tab==='history'" class="panel settings-panel"><details v-for="version in versions" :key="version.id" class="version-entry"><summary class="disclosure-summary"><ChevronRight class="disclosure-chevron" :size="16" aria-hidden="true" /><History :size="16" />输入版本 {{version.revision}}<span>{{formatDate(version.createdAt)}}</span></summary><p>{{version.name}} · {{scenarios[version.scenario]}}</p><pre class="resource-description">{{version.description||'无文字说明'}}</pre><p v-if="version.contentUrl">内容站：{{version.contentUrl}}</p><p v-if="version.referenceUrl">参考站：{{version.referenceUrl}}</p><div class="attachment-list"><a v-for="file in version.files" :key="file.id" :href="`/api/automation/files/${file.id}`" class="attachment"><File :size="15" /><span>{{file.name}}</span></a></div></details></section>
<section v-if="tab==='tasks'" class="panel"><div v-if="!tasks.length" class="empty-state">暂无任务</div><div v-for="task in tasks" :key="task.id" class="resource-task"><a :href="`#/tasks/${task.id}`">{{task.kind==='generation'?'生成':'评测'}} · {{scopeName(task.scope)}}</a><span class="status-badge" :class="task.status">{{taskStatusNames[task.status]}}</span><span>{{formatDate(task.createdAt)}}</span></div></section></template>
<div v-else class="empty-state"><p>{{workspace.loaded?'资源不存在':'正在读取资源…'}}</p></div>
<CreateTaskDialog ref="taskDialog" :resources="taskResources" :site="taskSite" :kind="taskKind" />
<BatchMaterialImport ref="batchDialog" @imported="load"/>
<dialog ref="editDialog" class="modal wide-modal" @cancel="(!busy&&!uploading)||$event.preventDefault()"><form @submit.prevent="save"><div class="modal-head"><h2>{{editing?'编辑资源':'新建资源'}}</h2><button type="button" class="icon-button" :disabled="busy||uploading" aria-label="关闭" @click="editDialog?.close()"><X :size="20" /></button></div><label class="field"><span>资源名称</span><input v-model="form.name" class="input" required maxlength="200" /></label><label class="field"><span>场景</span><BaseSelect v-model="form.scenario" :options="Object.entries(scenarios).map(([key, label]) => ({ value: key, label: (label) }))" /></label><div class="form-grid"><label class="field"><span>内容站 URL</span><input v-model="form.contentUrl" class="input" type="url" :required="['migration','upgrade','site-template'].includes(form.scenario)" placeholder="https://" /></label><label class="field"><span>参考站 URL</span><input v-model="form.referenceUrl" class="input" type="url" :required="form.scenario==='upgrade'" placeholder="留空时使用内容站" /></label></div><label class="field"><span>资料说明 / 业务需求</span><textarea v-model="form.description" class="input" rows="7" placeholder="自由填写，无需遵循固定格式或文件命名" /></label><div class="field"><span>附件资料</span><MaterialUploader :key="editSession" ref="materialUploader" v-model="form.files" :disabled="busy" @busy="uploading=$event" @pending="pendingUploads=$event"/></div><div class="form-grid"><label class="field"><span>外部来源</span><input v-model="form.externalSource" class="input" placeholder="可选，如同事的 Admin" /></label><label class="field"><span>外部记录标识</span><input v-model="form.externalId" class="input" placeholder="与外部来源一起填写" /></label></div><p v-if="error" class="alert error" role="alert">{{error}}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy||uploading" @click="editDialog?.close()">取消</button><button class="button primary" :disabled="busy||uploading"><LoaderCircle v-if="busy" class="spin" :size="16" />{{pendingUploads?(editing?'上传并保存版本':'上传并创建资源'):(editing?'保存新版本':'创建资源')}}</button></div></form></dialog>
<dialog ref="attachDialog" class="modal"><form @submit.prevent="saveAttach"><div class="modal-head"><h2>关联已有生成站</h2><button type="button" class="icon-button" aria-label="关闭" @click="attachDialog?.close()"><X :size="20" /></button></div><label class="field"><span>环境</span><BaseSelect v-model="attach.environmentId" required :options="[{ value: '', label: '选择环境', disabled: true }, ...(platform.settings?.environments || []).map((env) => ({ value: env.id, label: (env.name) }))]" /></label><label class="field"><span>站点名称</span><input v-model="attach.name" class="input" required /></label><label class="field"><span>Kooboo Site ID</span><input v-model="attach.siteId" class="input" required /></label><label class="field"><span>公开地址</span><input v-model="attach.url" class="input" type="url" required /></label><p v-if="error" class="alert error">{{error}}</p><div class="modal-actions"><button class="button primary" :disabled="busy">保存关联</button></div></form></dialog>
</template>

<style scoped>
.resource-detail-top{display:flex;flex-direction:column;gap:12px;margin-bottom:18px}
.resource-detail-header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.resource-detail-identity{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.resource-detail-identity h1{min-width:0;font-size:22px;font-weight:700;line-height:1.35;letter-spacing:-.4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.resource-back{flex:none;margin-left:-5px}.resource-detail-header>.toolbar-actions{flex:none}
.resource-detail-navigation{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.resource-detail-tabs{max-width:100%;min-width:0;overflow-x:auto;padding:3px;border-radius:9px}
.resource-detail-tabs button{min-height:30px;padding:5px 14px;border-radius:7px;font-size:12px}
.resource-detail-meta{color:var(--muted);font-size:12px;white-space:nowrap}
.resource-materials{padding:0;overflow:hidden}
.resource-materials :deep(.material-browser){display:flex;flex-direction:column;height:calc(100dvh - 165px);min-height:460px;margin:0;border:0;border-radius:20px}
.resource-materials :deep(.material-browser-toolbar){flex:none}
.resource-materials :deep(.material-browser-context){flex:1 1 260px;gap:8px 14px}
.resource-materials :deep(.material-browser-layout){flex:1;height:auto;max-height:none;min-height:0}
.resource-material-link,.resource-input-toggle{display:inline-flex;align-items:center;gap:5px;min-height:30px;font-size:12px;white-space:nowrap}
.resource-material-link{min-width:0;max-width:min(100%,360px);flex:1 1 180px;color:var(--blue)}
.resource-material-link-label{flex:none;color:var(--muted);font-size:11px}
.resource-material-link-url{min-width:0;overflow:hidden;text-overflow:ellipsis}
.resource-material-link>svg{flex:none}.resource-material-link:hover .resource-material-link-url{text-decoration:underline;text-underline-offset:3px}
.resource-input-toggle{flex:none}
.resource-input-toggle{padding:3px 7px;border-radius:5px;color:var(--muted)}.resource-input-toggle:hover,.resource-input-toggle[aria-expanded=true]{color:var(--ink);background:var(--field)}
.resource-input-details{max-height:180px;flex:none;overflow:auto;padding:14px 18px;border-bottom:1px solid var(--line);background:#fafbfd;font-size:13px;line-height:1.8;color:#526079}
.resource-input-details>pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.resource-input-details>p{display:flex;flex-wrap:wrap;gap:8px}.resource-input-details>pre+p{margin-top:10px}.resource-input-details>p>span{color:var(--muted)}
@media(max-width:700px){.resource-detail-navigation{flex-wrap:wrap;gap:8px}.resource-detail-meta{font-size:11px}.resource-detail-tabs button{padding-inline:11px}}
@media(max-width:620px){.resource-materials :deep(.material-browser){height:auto;min-height:0}.resource-materials :deep(.material-browser-context){flex:1 1 auto;gap:10px}.resource-input-details{max-height:150px}}
@media(max-width:500px){.resource-detail-identity{gap:5px}.resource-detail-identity h1{font-size:18px}.resource-detail-header{gap:8px}.resource-detail-header>.toolbar-actions{gap:6px}.resource-edit{width:32px;padding:6px}.resource-edit>span{display:none}.resource-detail-header .button{font-size:12px}.resource-detail-tabs{width:100%}.resource-detail-tabs button{flex:1;padding-inline:9px}}
</style>
