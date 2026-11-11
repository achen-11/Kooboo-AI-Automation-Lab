<script setup lang="ts">
import { notify } from '../../lib/notifications';
import { siteReportLink } from '../../lib/site-reports';
import type { SiteDeliverySummary } from '../../../../shared/site-delivery';
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { Plus, Search, Upload, Play, Folder, FolderOpen, FolderInput, Trash2, ArrowLeft, Pencil, ExternalLink, File, FileText, X, LoaderCircle, Link, History, ChevronLeft, ChevronRight, ChevronDown, Check, RotateCcw } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import Disclosure from '../../components/Disclosure.vue';
import MaterialUploader from '../../components/MaterialUploader.vue';
import MaterialBrowser from '../../components/MaterialBrowser.vue';
import BatchMaterialImport from './BatchMaterialImport.vue';
import CreateTaskDialog from './CreateTaskDialog.vue';
import SiteDomainDialog from './SiteDomainDialog.vue';
import DispositionDialog from './DispositionDialog.vue';
import { api, message, go, platform, formatDate } from '../../api';
import { workspace, refresh, scopeName } from './common';
import { scenarios, type Resource, type ResourceInput, type GeneratedSite, type InputVersion, type MaterialFile, taskStatusNames } from '../../../../shared/automation';
import { dispositionFilterOptions, dispositionStateNames, matchesDispositionFilter, type DispositionFilter, type DispositionState, type ItemDisposition } from '../../../../shared/dispositions';
import { filterResources, resourceFolderDescendants, resourceFolderTree, resourceSiteCounts, type ResourceFolder } from '../../../../shared/resource-library';
const props=defineProps<{id?:string}>();
const domainDialog=ref<InstanceType<typeof SiteDomainDialog>>();
const dispositionDialog=ref<InstanceType<typeof DispositionDialog>>();
const query=ref(''),scenario=ref(''),folder=ref(''),generated=ref(''),disposition=ref<DispositionFilter>('active'),page=ref(1),selected=ref<string[]>([]),error=ref('');
const folderDialog=ref<HTMLDialogElement>(),folderAction=ref<'create'|'rename'|'delete'>('create'),folderEditing=ref<ResourceFolder>(),folderName=ref(''),folderError=ref(''),folderBusy=ref(false);
const folderParent=ref(''),collapsedFolders=ref(new Set<string>());
const moveDialog=ref<HTMLDialogElement>(),moveIds=ref<string[]>([]),moveFolder=ref(''),moveError=ref(''),moveBusy=ref(false),editFolder=ref('');
const currentFolder=computed(()=>workspace.resourceFolders.find(item=>item.id===folder.value));
const folderTree=computed(()=>resourceFolderTree(workspace.resourceFolders));
const visibleFolders=computed(()=>folderTree.value.filter(item=>!item.ancestors.some(id=>collapsedFolders.value.has(id))));
const folderOptions=computed(()=>[{value:'',label:'未分组'},...folderTree.value.map(item=>({value:item.id,label:item.path}))]);
const folderParentOptions=computed(()=>{
  const excluded=folderEditing.value?resourceFolderDescendants(workspace.resourceFolders,folderEditing.value.id):new Set<string>();
  return [{value:'',label:'顶级文件夹'},...folderTree.value.filter(item=>!excluded.has(item.id)).map(item=>({value:item.id,label:item.path}))];
});
const dispositionPool=computed(()=>workspace.resources.filter(item=>matchesDispositionFilter(item.disposition,disposition.value)));
const folderCounts=computed(()=>{
  const counts=new Map<string,number>(),nodes=new Map(folderTree.value.map(item=>[item.id,item]));
  for(const item of dispositionPool.value){const key=item.folderId||'ungrouped';for(const id of [key,...(nodes.get(key)?.ancestors||[])])counts.set(id,(counts.get(id)||0)+1);}
  return counts;
});
function folderLabel(id?:string|null){return folderTree.value.find(item=>item.id===id)?.path||'未分组';}
function toggleFolder(id:string){if(collapsedFolders.value.has(id))collapsedFolders.value.delete(id);else collapsedFolders.value.add(id);}
function selectFolder(id:string){folder.value=id;for(const ancestor of folderTree.value.find(item=>item.id===id)?.ancestors||[])collapsedFolders.value.delete(ancestor);}
function openFolder(action:'create'|'rename'|'delete',parentId?:string){
  folderAction.value=action;folderEditing.value=action==='create'?undefined:currentFolder.value;
  folderParent.value=action==='create'?(parentId??currentFolder.value?.id??''):folderEditing.value?.parentId||'';
  folderName.value=folderEditing.value?.name||'';folderError.value='';folderDialog.value?.showModal();
}
async function saveFolder(){
  folderBusy.value=true;folderError.value='';
  try{
    const target=folderEditing.value;
    if(folderAction.value==='delete')await api(`/automation/resource-folders/${target!.id}`,{method:'DELETE'});
    else{
      const saved=await api<ResourceFolder>(target?`/automation/resource-folders/${target.id}`:'/automation/resource-folders',{method:target?'PUT':'POST',body:JSON.stringify({name:folderName.value,parentId:folderParent.value||null})});
      folder.value=saved.id;
    }
    if(folderAction.value==='delete')folder.value='';
    folderDialog.value?.close();await load();selectFolder(folder.value);notify.success(folderAction.value==='delete'?'文件夹已删除':folderAction.value==='rename'?'文件夹已更新':'文件夹已创建');
  }catch(reason){folderError.value=message(reason);}finally{folderBusy.value=false;}
}
function openMove(ids:string[]){moveIds.value=[...ids];moveFolder.value=workspace.resources.find(item=>item.id===ids[0])?.folderId||'';moveError.value='';moveDialog.value?.showModal();}
async function saveMove(){
  moveBusy.value=true;moveError.value='';
  try{await api('/automation/resources/move',{method:'POST',body:JSON.stringify({resourceIds:moveIds.value,folderId:moveFolder.value||null})});moveDialog.value?.close();selected.value=[];await load();notify.success(`已移动 ${moveIds.value.length} 项资源`);}
  catch(reason){moveError.value=message(reason);}finally{moveBusy.value=false;}
}
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
const siteCounts=computed(()=>resourceSiteCounts(workspace.sites));
const filtered=computed(()=>filterResources(workspace.resources,siteCounts.value,{query:query.value,scenario:scenario.value,folder:folder.value,generated:generated.value,disposition:disposition.value},workspace.resourceFolders));
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/20)));const rows=computed(()=>filtered.value.slice((page.value-1)*20,page.value*20));
const checked=computed(()=>rows.value.length>0&&rows.value.every(r=>selected.value.includes(r.id)));const partial=computed(()=>!checked.value&&rows.value.some(r=>selected.value.includes(r.id)));
const selectedResources=computed(()=>workspace.resources.filter(r=>selected.value.includes(r.id)));
const activeSelectedResources=computed(()=>selectedResources.value.filter(r=>!r.disposition));
const canBatchComplete=computed(()=>selectedResources.value.some(r=>r.disposition?.state!=='completed'));
const canBatchDiscard=computed(()=>selectedResources.value.some(r=>r.disposition?.state!=='discarded'));
const canBatchRestore=computed(()=>selectedResources.value.some(r=>Boolean(r.disposition)));
const resource=computed(()=>workspace.resources.find(r=>r.id===props.id));const sites=computed(()=>workspace.sites.filter(s=>s.resourceId===props.id));const tasks=computed(()=>workspace.tasks.filter(t=>t.resourceId===props.id));
const primarySites=computed(()=>sites.value.filter(s=>s.disposition?.state!=='discarded'));
const discardedSites=computed(()=>sites.value.filter(s=>s.disposition?.state==='discarded'));
function dispositionTitle(d?:ItemDisposition){if(!d)return '';const head=`${dispositionStateNames[d.state]} · ${formatDate(d.updatedAt)}`;return d.note?`${head}：${d.note}`:head;}
function openResourceDisposition(items:Resource[],nextState:DispositionState){
  const candidates=items.filter(r=>(r.disposition?.state||'active')!==nextState);
  if(!candidates.length)return;
  const label=candidates.length===1?candidates[0].name:`已选 ${candidates.length} 项资源`;
  const canCascadeDeliveries=nextState==='discarded'
    ?candidates.some(r=>workspace.sites.some(s=>s.resourceId===r.id&&!s.disposition)||workspace.tasks.some(t=>t.resourceId===r.id&&!t.generatedSiteId&&!t.disposition))
    :nextState==='completed'
      ?candidates.every(r=>workspace.sites.filter(s=>s.resourceId===r.id&&!s.disposition).length<=1)&&candidates.some(r=>workspace.sites.some(s=>s.resourceId===r.id&&!s.disposition))
      :candidates.some(r=>workspace.sites.some(s=>s.resourceId===r.id&&s.disposition?.state==='completed'));
  dispositionDialog.value?.open({kind:'resource',ids:candidates.map(r=>r.id),state:nextState,label,canCascadeDeliveries,defaultCascadeDeliveries:canCascadeDeliveries});
}
function openSiteDisposition(site:GeneratedSite,nextState:DispositionState){
  dispositionDialog.value?.open({
    kind:'delivery',ids:[site.id],state:nextState,label:site.name||resource.value?.name||'生成站',
    canCascadeResources:nextState==='completed'?resource.value?.disposition?.state!=='completed':nextState==='active'?Boolean(resource.value?.disposition):false,
    defaultCascadeResources:nextState==='completed'||(site.disposition?.state==='completed'&&resource.value?.disposition?.state==='completed'),
  });
}
async function onDispositionSaved(){selected.value=[];await load();}
const tab=ref('sites');
const inputDetailsOpen=ref(false),inputDetailsId=useId();
const materialSites=computed(()=>{
  const item=resource.value;if(!item)return [];
  const reference=item.referenceUrl||item.contentUrl;
  if(item.contentUrl===reference&&item.contentUrl)return [{label:'内容 / 参考站',url:item.contentUrl}];
  return [...(item.contentUrl?[{label:'内容站',url:item.contentUrl}]:[]),...(reference?[{label:'参考站',url:reference}]:[])];
});
function hostname(url:string){try{return new URL(url).hostname;}catch{return url;}}
watch([query,scenario,folder,generated,disposition],()=>{page.value=1;selected.value=[];});watch(pages,v=>page.value=Math.min(page.value,v));
async function load(){await refresh();if(props.id)try{versions.value=(await api<{versions:InputVersion[]}>(`/automation/resources/${props.id}`)).versions;}catch(e){error.value=message(e);}}
watch(()=>props.id,()=>{tab.value='sites';inputDetailsOpen.value=false;void load();});onMounted(load);
function toggleAll(event:Event){const checked=(event.target as HTMLInputElement).checked;const visible=new Set(rows.value.map(r=>r.id));selected.value=checked?[...new Set([...selected.value,...visible])]:selected.value.filter(id=>!visible.has(id));}
function edit(item?:Resource){editSession.value++;pendingUploads.value=false;editing.value=item||null;editFolder.value=item?item.folderId||'':currentFolder.value?.id||'';form.value=item?{name:item.name,scenario:item.scenario,description:item.description,contentUrl:item.contentUrl,referenceUrl:item.referenceUrl,externalSource:item.externalSource,externalId:item.externalId,files:item.files.map(f=>({...f})),siteName:item.siteName,subDomain:item.subDomain,rootDomain:item.rootDomain}:blank();error.value='';editDialog.value?.showModal();}
async function save(){busy.value=true;error.value='';try{if(pendingUploads.value&&materialUploader.value&&!await materialUploader.value.upload())throw new Error('部分资料未上传，请检查文件列表后重试');const item=await api<Resource>(editing.value?`/automation/resources/${editing.value.id}`:'/automation/resources',{method:editing.value?'PUT':'POST',body:JSON.stringify({...form.value,folderId:editFolder.value||null,...(editing.value?{revision:editing.value.revision}:{})})});editDialog.value?.close();await load();go(`/resources/${item.id}`);}catch(e){error.value=message(e);}finally{busy.value=false;}}
async function importJson(event:Event){const input=event.target as HTMLInputElement;error.value='';busy.value=true;try{const file=input.files?.[0];if(!file)return;const data=JSON.parse(await file.text());const result=await api<{items:Resource[]}>('/v1/resources/import',{method:'POST',body:JSON.stringify(Array.isArray(data)?data:[data])});await load();notify.success(`已导入 ${result.items.length} 条资源`);}catch(e){error.value=message(e);}finally{busy.value=false;input.value='';}}
async function create(items:Resource[],site?:GeneratedSite,kind:'generation'|'evaluation'='generation'){taskResources.value=items;taskSite.value=site;taskKind.value=kind;await nextTick();await taskDialog.value?.open();}
const attach=ref({name:'',siteId:'',url:'',environmentId:''});
function openAttach(){attach.value={name:'',siteId:'',url:'',environmentId:platform.settings?.environments[0]?.id||''};error.value='';attachDialog.value?.showModal();}
async function saveAttach(){busy.value=true;try{await api('/automation/sites',{method:'POST',body:JSON.stringify({...attach.value,resourceId:props.id})});attachDialog.value?.close();await load();}catch(e){error.value=message(e);}finally{busy.value=false;}}
</script>
<template>
<template v-if="!id"><header class="page-header"><div><h1>资源库</h1></div><div class="toolbar-actions"><button class="button secondary" @click="batchDialog?.open()"><FolderOpen :size="17"/>导入资料文件夹</button><label class="button secondary" :class="{disabled:busy}"><Upload :size="17" />导入 JSON<input class="sr-only" type="file" accept=".json" :disabled="busy" @change="importJson" /></label><button class="button primary" @click="edit()"><Plus :size="17" />新建资源</button></div></header>
<p v-if="error" class="alert error" role="alert">{{error}}</p>
<div class="resource-library">
  <aside class="resource-folders panel">
    <div class="resource-folders-heading"><span>文件夹</span><button class="icon-button" aria-label="新建顶级文件夹" title="新建顶级文件夹" @click="openFolder('create','')"><Plus :size="17" /></button></div>
    <nav aria-label="资源文件夹">
      <button :class="{active:folder===''}" :aria-pressed="folder===''" @click="folder=''"><FolderOpen :size="16" /><span>全部资源</span><small>{{dispositionPool.length}}</small></button>
      <button :class="{active:folder==='ungrouped'}" :aria-pressed="folder==='ungrouped'" @click="folder='ungrouped'"><Folder :size="16" /><span>未分组</span><small>{{folderCounts.get('ungrouped')||0}}</small></button>
      <div v-for="item in visibleFolders" :key="item.id" class="resource-folder-row" :class="{active:folder===item.id}" :style="{'--folder-depth':item.depth}">
        <button v-if="item.hasChildren" class="resource-folder-expander" :aria-label="`${collapsedFolders.has(item.id)?'展开':'收起'} ${item.name}`" :aria-expanded="!collapsedFolders.has(item.id)" @click="toggleFolder(item.id)"><ChevronRight :size="13" :class="{'folder-expanded':!collapsedFolders.has(item.id)}" /></button><span v-else class="resource-folder-indent" aria-hidden="true" />
        <button class="resource-folder-select" :aria-pressed="folder===item.id" :title="item.path" @click="selectFolder(item.id)"><FolderOpen v-if="folder===item.id" :size="16" /><Folder v-else :size="16" /><span>{{item.name}}</span><small>{{folderCounts.get(item.id)||0}}</small></button>
      </div>
    </nav>
    <div v-if="currentFolder" class="resource-folder-actions"><button class="icon-button" :aria-label="`在 ${currentFolder.name} 中新建子文件夹`" title="新建子文件夹" @click="openFolder('create')"><Plus :size="15" /></button><button class="icon-button" :aria-label="`编辑文件夹 ${currentFolder.name}`" title="编辑文件夹" @click="openFolder('rename')"><Pencil :size="15" /></button><button class="icon-button" :aria-label="`删除文件夹 ${currentFolder.name}`" title="删除文件夹" @click="openFolder('delete')"><Trash2 :size="15" /></button></div>
  </aside>
  <section class="panel resource-list"><div class="table-toolbar resource-filters"><label class="search-field"><Search :size="18" /><input v-model="query" placeholder="搜索资源、站点或外部标识" aria-label="搜索资源" /></label><BaseSelect v-model="disposition" size="small" aria-label="归档状态" :options="dispositionFilterOptions" /><BaseSelect v-model="scenario" size="small" aria-label="筛选场景" :options="[{ value: '', label: '全部场景' }, ...Object.entries(scenarios).map(([key, label]) => ({ value: key, label }))]" /><BaseSelect v-model="generated" size="small" aria-label="筛选是否有生成站" :options="[{value:'',label:'全部生成状态'},{value:'yes',label:'有生成站'},{value:'no',label:'无生成站'}]" /></div>
  <div v-if="selected.length" class="selection-bar"><span>已选 {{selected.length}} 项</span><button class="text-action" @click="selected=[]">清空选择</button><div class="selection-actions"><button class="button secondary small" @click="openMove(selected)"><FolderInput :size="15" />移动到文件夹</button><button v-if="canBatchRestore" class="button secondary small" @click="openResourceDisposition(selectedResources,'active')"><RotateCcw :size="15" />移回在列</button><button v-if="canBatchDiscard" class="button secondary small" @click="openResourceDisposition(selectedResources,'discarded')"><Trash2 :size="15" />舍弃</button><button v-if="canBatchComplete" class="button secondary small" @click="openResourceDisposition(selectedResources,'completed')"><Check :size="15" />标为已完成</button><button v-if="activeSelectedResources.length" class="button primary small" @click="create(activeSelectedResources)"><Play :size="15" />批量生成</button></div></div>
  <div class="table-scroll"><table class="task-table resource-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" aria-label="选择本页全部资源" :checked="checked" :indeterminate.prop="partial" :disabled="!rows.length" @change="toggleAll" /></th><th>资源名称</th><th>文件夹</th><th>场景</th><th>内容站</th><th>生成站</th><th>更新时间</th><th /></tr></thead><tbody><tr v-for="item in rows" :key="item.id" :class="{'row-selected':selected.includes(item.id)}"><td class="checkbox-cell"><input v-model="selected" type="checkbox" :value="item.id" :aria-label="`选择 ${item.name}`" /></td><td><div class="resource-title-row"><a class="task-title" :href="`#/resources/${item.id}`">{{item.name}}</a><span v-if="item.disposition" class="disposition-badge" :class="item.disposition.state" :title="dispositionTitle(item.disposition)">{{dispositionStateNames[item.disposition.state]}}</span></div><span class="table-subtitle">版本 {{item.revision}}<template v-if="item.externalSource"> · {{item.externalSource}} / {{item.externalId}}</template></span><span v-if="item.disposition?.note" class="table-subtitle disposition-note" :title="item.disposition.note">{{item.disposition.note}}</span></td><td><button class="resource-folder-link" :title="folderLabel(item.folderId)" @click="selectFolder(item.folderId||'ungrouped')">{{folderLabel(item.folderId)}}</button></td><td>{{scenarios[item.scenario]}}</td><td><a v-if="item.contentUrl" class="site-link" :href="item.contentUrl" target="_blank" rel="noopener noreferrer">{{hostname(item.contentUrl)}}<ExternalLink :size="12" /></a><span v-else class="text-muted">—</span></td><td>{{siteCounts.get(item.id)||0}}</td><td class="date-cell">{{formatDate(item.updatedAt)}}</td><td><button v-if="!item.disposition" class="button secondary small" @click="create([item])"><Play :size="14" />生成</button><button v-else class="button secondary small" @click="openResourceDisposition([item],'active')"><RotateCcw :size="14" />移回在列</button></td></tr></tbody></table></div>
  <div v-if="!rows.length" class="empty-state"><span class="empty-icon"><FolderOpen :size="30" /></span><h2>{{workspace.resources.length?(disposition==='completed'?'暂无已完成的资源':disposition==='discarded'?'暂无已舍弃的资源':'没有匹配的资源'):'添加第一份资源'}}</h2><p v-if="!workspace.resources.length">填写说明、站点地址，或上传任意资料文件</p><button v-if="(!workspace.resources.length||currentFolder)&&disposition==='active'" class="button secondary" @click="edit()"><Plus :size="16" />新建资源</button></div>
  <footer class="table-footer"><span>共 {{filtered.length}} 项</span><div class="pagination"><button class="icon-button" :disabled="page<=1" aria-label="上一页" @click="page--"><ChevronLeft :size="17" /></button><span>{{page}} / {{pages}}</span><button class="icon-button" :disabled="page>=pages" aria-label="下一页" @click="page++"><ChevronRight :size="17" /></button></div></footer></section>
</div></template>
<template v-else-if="resource">
<div class="resource-detail-top">
  <header class="resource-detail-header">
    <div class="resource-detail-identity"><a class="icon-button resource-back" href="#/resources" aria-label="返回资源库" title="返回资源库"><ArrowLeft :size="18" /></a><h1 :title="resource.name">{{resource.name}}</h1><span v-if="resource.disposition" class="disposition-badge" :class="resource.disposition.state" :title="dispositionTitle(resource.disposition)">{{dispositionStateNames[resource.disposition.state]}}</span></div>
    <div class="toolbar-actions"><button class="button secondary small resource-edit" aria-label="编辑资料" @click="edit(resource)"><Pencil :size="15" /><span>编辑资料</span></button><template v-if="resource.disposition"><button class="button secondary small" @click="openResourceDisposition([resource],'active')"><RotateCcw :size="15" />移回在列</button></template><template v-else><button class="button secondary small" @click="openResourceDisposition([resource],'completed')"><Check :size="15" />标为已完成</button><button class="button secondary small" @click="openResourceDisposition([resource],'discarded')"><Trash2 :size="15" />舍弃</button><button class="button primary small" @click="create([resource])"><Plus :size="16" />新建生成站</button></template></div>
  </header>
  <p v-if="resource.disposition?.note" class="resource-disposition-note">归档说明：{{resource.disposition.note}}</p>
  <div class="resource-detail-navigation"><nav class="segmented resource-detail-tabs" aria-label="资源详情分区"><button v-for="item in [{id:'sites',label:'生成站'},{id:'materials',label:'资料与输入'},{id:'history',label:'版本历史'},{id:'tasks',label:'任务记录'}]" :key="item.id" :class="{selected:tab===item.id}" :aria-pressed="tab===item.id" @click="tab=item.id">{{item.label}}</button></nav><span class="resource-detail-meta">{{scenarios[resource.scenario]}} · 输入版本 {{resource.revision}}</span></div>
</div>
<section v-if="tab==='sites'" class="panel"><div class="section-heading panel-heading"><h2>{{discardedSites.length?`${primarySites.length} 个有效生成站`:`${sites.length} 个生成站`}}</h2><button v-if="!resource.disposition" class="button secondary small" @click="openAttach()"><Link :size="15" />关联已有站点</button></div><div v-if="!primarySites.length&&!discardedSites.length" class="empty-state"><FolderOpen :size="30" /><h2>还没有生成站</h2><p>同一资源可以多次生成，也可以关联已有站点</p></div><div v-else-if="!primarySites.length" class="empty-state"><FolderOpen :size="30" /><h2>当前没有在列生成站</h2><p>历史废站已收起在下方折叠区，可新建生成站重新开始。</p></div><div v-if="primarySites.length" class="site-grid"><article v-for="site in primarySites" :key="site.id" class="site-card"><div class="site-card-head"><h3>{{site.name}}</h3><span v-if="site.disposition" class="disposition-badge" :class="site.disposition.state" :title="dispositionTitle(site.disposition)">{{dispositionStateNames[site.disposition.state]}}</span></div><a v-if="site.url" class="site-link" :href="site.url" target="_blank" rel="noopener noreferrer">{{site.url}}<ExternalLink :size="14" /></a><p v-else class="text-muted">公开地址待确认</p><span class="table-subtitle">{{formatDate(site.createdAt)}}</span><span v-if="site.disposition?.note" class="table-subtitle disposition-note" :title="site.disposition.note">{{site.disposition.note}}</span><div class="inline-actions"><template v-if="!site.disposition&&!resource.disposition"><button class="button secondary small" @click="domainDialog?.open(site.id)">换绑域名</button><button class="button secondary small" @click="create([resource],site)">继续生成</button><button class="button primary small" :disabled="!site.url" @click="create([resource],site,'evaluation')">发起评测</button><button class="button secondary small" @click="openSiteDisposition(site,'completed')"><Check :size="14" />已完成</button><button class="button secondary small" @click="openSiteDisposition(site,'discarded')"><Trash2 :size="14" />舍弃</button></template><button v-else class="button secondary small" @click="openSiteDisposition(site,'active')"><RotateCcw :size="14" />移回在列</button></div><button class="text-action" :disabled="Boolean(reportsLoading)" @click="openReports(site)"><LoaderCircle v-if="reportsLoading === site.id" class="spin" :size="14" />查看评测记录</button></article></div><div v-if="discardedSites.length" class="discarded-sites-wrap"><Disclosure :label="`已舍弃的生成站（${discardedSites.length}）`"><div class="site-grid discarded-site-grid"><article v-for="site in discardedSites" :key="site.id" class="site-card site-card-discarded"><div class="site-card-head"><h3>{{site.name}}</h3><span class="disposition-badge discarded" :title="dispositionTitle(site.disposition)">已舍弃</span></div><a v-if="site.url" class="site-link" :href="site.url" target="_blank" rel="noopener noreferrer">{{site.url}}<ExternalLink :size="14" /></a><span class="table-subtitle">{{formatDate(site.createdAt)}}</span><span v-if="site.disposition?.note" class="table-subtitle disposition-note" :title="site.disposition.note">{{site.disposition.note}}</span><div class="inline-actions"><button class="button secondary small" @click="openSiteDisposition(site,'active')"><RotateCcw :size="14" />移回在列</button></div><button class="text-action" :disabled="Boolean(reportsLoading)" @click="openReports(site)"><LoaderCircle v-if="reportsLoading === site.id" class="spin" :size="14" />查看评测记录</button></article></div></Disclosure></div></section>
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
<dialog ref="folderDialog" class="modal" @cancel="!folderBusy||$event.preventDefault()">
  <form @submit.prevent="saveFolder">
    <div class="modal-head"><h2>{{folderAction==='delete'?'删除文件夹':folderAction==='rename'?'编辑文件夹':'新建文件夹'}}</h2><button type="button" class="icon-button" :disabled="folderBusy" aria-label="关闭" @click="folderDialog?.close()"><X :size="20" /></button></div>
    <p v-if="folderAction==='delete'" class="resource-folder-delete">删除“{{folderEditing?.name}}”及其所有子文件夹后，其中的资源将移至“未分组”。</p>
    <template v-else><label class="field"><span>文件夹名称</span><input v-model="folderName" class="input" required maxlength="100" autofocus /></label><label class="field"><span>父级文件夹</span><BaseSelect v-model="folderParent" :options="folderParentOptions" aria-label="父级文件夹" /></label></template>
    <p v-if="folderError" class="alert error" role="alert">{{folderError}}</p>
    <div class="modal-actions"><button type="button" class="button secondary" :disabled="folderBusy" @click="folderDialog?.close()">取消</button><button class="button" :class="folderAction==='delete'?'danger':'primary'" :disabled="folderBusy"><LoaderCircle v-if="folderBusy" class="spin" :size="16" />{{folderAction==='delete'?'删除文件夹':'保存'}}</button></div>
  </form>
</dialog>
<dialog ref="moveDialog" class="modal" @cancel="!moveBusy||$event.preventDefault()">
  <form @submit.prevent="saveMove">
    <div class="modal-head"><h2>移动 {{moveIds.length}} 项资源</h2><button type="button" class="icon-button" :disabled="moveBusy" aria-label="关闭" @click="moveDialog?.close()"><X :size="20" /></button></div>
    <label class="field"><span>目标文件夹</span><BaseSelect v-model="moveFolder" :options="folderOptions" aria-label="目标文件夹" /></label>
    <p v-if="moveError" class="alert error" role="alert">{{moveError}}</p>
    <div class="modal-actions"><button type="button" class="button secondary" :disabled="moveBusy" @click="moveDialog?.close()">取消</button><button class="button primary" :disabled="moveBusy"><LoaderCircle v-if="moveBusy" class="spin" :size="16" />移动</button></div>
  </form>
</dialog>
<dialog ref="editDialog" class="modal wide-modal" @cancel="(!busy&&!uploading)||$event.preventDefault()"><form @submit.prevent="save"><div class="modal-head"><h2>{{editing?'编辑资源':'新建资源'}}</h2><button type="button" class="icon-button" :disabled="busy||uploading" aria-label="关闭" @click="editDialog?.close()"><X :size="20" /></button></div><label class="field"><span>资源名称</span><input v-model="form.name" class="input" required maxlength="200" /></label><label class="field"><span>文件夹</span><BaseSelect v-model="editFolder" :options="folderOptions" aria-label="资源所属文件夹" /></label><label class="field"><span>场景</span><BaseSelect v-model="form.scenario" :options="Object.entries(scenarios).map(([key, label]) => ({ value: key, label: (label) }))" /></label><div class="form-grid"><label class="field"><span>内容站 URL</span><input v-model="form.contentUrl" class="input" type="url" :required="['migration','upgrade','site-template'].includes(form.scenario)" placeholder="https://" /></label><label class="field"><span>参考站 URL</span><input v-model="form.referenceUrl" class="input" type="url" :required="form.scenario==='upgrade'" placeholder="留空时使用内容站" /></label></div><label class="field"><span>资料说明 / 业务需求</span><textarea v-model="form.description" class="input" rows="7" placeholder="自由填写，无需遵循固定格式或文件命名" /></label><div class="field"><span>附件资料</span><MaterialUploader :key="editSession" ref="materialUploader" v-model="form.files" :disabled="busy" @busy="uploading=$event" @pending="pendingUploads=$event"/></div><div class="form-grid"><label class="field"><span>外部来源</span><input v-model="form.externalSource" class="input" placeholder="可选，如同事的 Admin" /></label><label class="field"><span>外部记录标识</span><input v-model="form.externalId" class="input" placeholder="与外部来源一起填写" /></label></div><p v-if="error" class="alert error" role="alert">{{error}}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy||uploading" @click="editDialog?.close()">取消</button><button class="button primary" :disabled="busy||uploading"><LoaderCircle v-if="busy" class="spin" :size="16" />{{pendingUploads?(editing?'上传并保存版本':'上传并创建资源'):(editing?'保存新版本':'创建资源')}}</button></div></form></dialog>
<SiteDomainDialog ref="domainDialog" @saved="load" />
<DispositionDialog ref="dispositionDialog" @saved="onDispositionSaved" />
<dialog ref="attachDialog" class="modal"><form @submit.prevent="saveAttach"><div class="modal-head"><h2>关联已有生成站</h2><button type="button" class="icon-button" aria-label="关闭" @click="attachDialog?.close()"><X :size="20" /></button></div><label class="field"><span>环境</span><BaseSelect v-model="attach.environmentId" required :options="[{ value: '', label: '选择环境', disabled: true }, ...(platform.settings?.environments || []).map((env) => ({ value: env.id, label: (env.name) }))]" /></label><label class="field"><span>站点名称</span><input v-model="attach.name" class="input" required /></label><label class="field"><span>Kooboo Site ID</span><input v-model="attach.siteId" class="input" required /></label><label class="field"><span>公开地址</span><input v-model="attach.url" class="input" type="url" required /></label><p v-if="error" class="alert error">{{error}}</p><div class="modal-actions"><button class="button primary" :disabled="busy">保存关联</button></div></form></dialog>
</template>

<style scoped>
.resource-library{display:grid;grid-template-columns:190px minmax(0,1fr);gap:18px;align-items:start}
.resource-folders{padding:10px}.resource-folders-heading{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 10px 10px;font-size:13px;font-weight:600}
.resource-folders nav{display:flex;flex-direction:column;gap:3px;max-height:65dvh;overflow:auto}
.resource-folders nav>button,.resource-folder-select{display:flex;align-items:center;gap:9px;width:100%;min-width:0;min-height:38px;padding:8px 10px;border-radius:7px;text-align:left;font-size:13px;color:var(--muted)}
.resource-folders nav>button:hover,.resource-folder-row:hover{background:var(--field);color:var(--ink)}.resource-folders nav>button.active,.resource-folder-row.active{background:#e9effd;color:var(--blue)}
.resource-folders nav button>span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.resource-folders nav button>svg{flex:none}.resource-folders nav small{font-size:11px;font-variant-numeric:tabular-nums}
.resource-folder-row{display:flex;align-items:center;min-width:calc(115px + var(--folder-depth)*14px);padding-left:calc(2px + var(--folder-depth)*14px);border-radius:7px;color:var(--muted)}
.resource-folder-row .resource-folder-select{flex:1;gap:7px;padding-left:2px;color:inherit}.resource-folder-expander,.resource-folder-indent{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;min-height:32px;padding:0;color:inherit}.resource-folder-expander:hover{color:var(--blue)}.folder-expanded{transform:rotate(90deg)}
.resource-folder-actions{display:flex;justify-content:flex-end;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.resource-list{min-width:0}.resource-filters{flex-wrap:wrap;gap:10px}.resource-filters .search-field{flex:1 1 240px;min-width:160px;width:auto}.resource-filters>:deep(.ui-select){flex:0 1 145px}
.resource-folder-link{display:block;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px;text-align:left}.resource-folder-link:hover{color:var(--blue)}
.resource-folder-delete{font-size:14px;line-height:1.7;overflow-wrap:anywhere}
.selection-actions{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.resource-title-row,.site-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.site-card-head{justify-content:space-between;margin-bottom:12px}
.site-card-head h3{margin-bottom:0}
.disposition-badge{display:inline-flex;align-items:center;flex:none;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:550;line-height:1.4;white-space:nowrap}
.disposition-badge.completed{color:#16765d;background:#eaf7f1}
.disposition-badge.discarded{color:#64748b;background:#eef2f7}
.disposition-note{display:block;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.resource-disposition-note{margin:0;font-size:12px;color:var(--muted);line-height:1.6;overflow-wrap:anywhere}
.discarded-sites-wrap{padding:0 24px 20px;border-top:1px solid var(--line)}
.discarded-site-grid{padding:12px 0 0}
.site-card-discarded{opacity:.82;background:#fafbfd}
.button.danger{background:var(--red);color:#fff}.button.danger:hover:not(:disabled){background:#b94250}.button.danger:disabled{background:var(--field);color:var(--muted)}
@media(max-width:1000px){.resource-library{grid-template-columns:155px minmax(0,1fr);gap:12px}}
@media(max-width:700px){.resource-library{grid-template-columns:minmax(0,1fr)}.resource-folders nav{max-height:240px}.resource-folders-heading{padding-bottom:4px}.resource-folder-actions{margin-top:4px;padding-top:4px}.resource-filters .search-field{flex-basis:100%}.resource-filters>:deep(.ui-select){flex:1 1 130px}}
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
