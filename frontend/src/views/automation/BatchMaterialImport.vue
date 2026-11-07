<script setup lang="ts">
import { computed, ref } from 'vue';
import { FolderOpen, Upload, X, LoaderCircle } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import MaterialTree from '../../components/MaterialTree.vue';
import { fileSelection, droppedMaterials, uploadMaterial } from './material-upload';
import { packageGroups, uniqueMaterialPaths, type PickedMaterial } from '../../../../shared/materials';
import { scenarios, type Scenario, type Resource, type MaterialFile } from '../../../../shared/automation';
import { api, message } from '../../api';
import { notify } from '../../lib/notifications';
const emit=defineEmits<{imported:[]}>();
const dialog=ref<HTMLDialogElement>(),picked=ref<PickedMaterial[]>([]),busy=ref(false),error=ref(''),single=ref('batch'),shareLoose=ref(false);
type Group={name:string;scenario:Scenario;contentUrl:string;referenceUrl:string;description:string;files:PickedMaterial[];uploaded:MaterialFile[];key:string;done?:Resource;error:string;progress:number;include:boolean};
const groups=ref<Group[]>([]),loose=ref<PickedMaterial[]>([]);
const total=computed(()=>groups.value.filter(g=>g.include).reduce((s,g)=>s+g.files.length+(shareLoose.value?loose.value.length:0),0));
function regroup(){const paths=picked.value.map(f=>f.path.split('/'));const root=paths.length>0&&paths.every(p=>p.length>1&&p[0]===paths[0][0]);const files=picked.value.map(f=>({...f,path:root?f.path.split('/').slice(1).join('/'):f.path}));const result=packageGroups(files,single.value==='single');loose.value=result.loose;groups.value=result.groups.map(g=>({...g,scenario:'materials',contentUrl:'',referenceUrl:'',description:'',uploaded:[],key:crypto.randomUUID(),error:'',progress:0,include:true}));}
function select(event:Event){const input=event.target as HTMLInputElement;try{picked.value=fileSelection(input.files);regroup();error.value='';}catch(e){error.value=message(e);}input.value='';}
async function drop(e:DragEvent){if(busy.value||groups.value.some(g=>g.uploaded.length)||!e.dataTransfer)return;try{picked.value=await droppedMaterials(e.dataTransfer);regroup();error.value='';}catch(reason){error.value=message(reason);}}
function open(){if(busy.value)return;dialog.value?.showModal();}
defineExpose({open});
async function run(){busy.value=true;error.value='';try{
  if(!groups.value.some(g=>g.include))throw new Error('请选择至少一条资源');
  if(loose.value.length&&!shareLoose.value)throw new Error('父目录有未分组文件；请作为共享资料，或切换为单个资源导入');
  for(const g of groups.value.filter(g=>g.include&&!g.done)){
    const files=[...g.files,...(shareLoose.value?loose.value:[])];uniqueMaterialPaths(files.map(f=>({name:f.path})));if(files.length>1000)throw new Error(`${g.name} 超过 1000 个附件`);
    if(!g.name.trim())throw new Error('资源名称不能为空');
    if(['migration','upgrade','site-template'].includes(g.scenario)&&!g.contentUrl)throw new Error(`${g.name} 需要内容站 URL`);
    if(g.scenario==='upgrade'&&!g.referenceUrl)throw new Error(`${g.name} 需要参考站 URL`);
    for(const url of [g.contentUrl,g.referenceUrl].filter(Boolean))if(!/^https?:$/.test(new URL(url).protocol))throw new Error('请填写 HTTP(S) 地址');
  }
  for(const g of groups.value.filter(g=>g.include&&!g.done)){
    g.error='';try{
      const files=[...g.files,...(shareLoose.value?loose.value:[])];for(const file of files){if(g.uploaded.some(f=>f.name===file.path))continue;g.uploaded.push(await uploadMaterial(file));g.progress=g.uploaded.length;}
      g.done=await api<Resource>('/automation/resources',{method:'POST',headers:{'Idempotency-Key':'resource-import-'+g.key},body:JSON.stringify({name:g.name,scenario:g.scenario,description:g.description,contentUrl:g.contentUrl,referenceUrl:g.referenceUrl,externalId:'',externalSource:'',files:g.uploaded})});
    }catch(reason){g.error=message(reason);}
  }
  emit('imported');const count=groups.value.filter(g=>g.done).length;const remaining=groups.value.filter(g=>g.include&&!g.done).length;if(remaining)notify.warning(`本批已创建 ${count} 条，${remaining} 条待重试`);else notify.success(`已创建 ${count} 条资源`);
}catch(reason){error.value=message(reason);}finally{busy.value=false;}}
</script>
<template><dialog ref="dialog" class="modal batch-import" @cancel="e=>{if(busy)e.preventDefault()}"><div class="modal-head"><h2>导入资料文件夹</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="dialog?.close()"><X :size="20"/></button></div><div class="material-drop" @dragover.prevent @drop.prevent="drop"><label class="button secondary"><FolderOpen :size="16"/>选择资料父目录<input class="sr-only" type="file" multiple webkitdirectory :disabled="busy||groups.some(g=>g.uploaded.length>0)" @change="select"/></label><span class="text-muted">也可以拖入文件夹</span></div>
<div v-if="picked.length" class="inline-actions"><BaseSelect v-model="single" :disabled="busy||groups.some(g=>g.uploaded.length>0)" aria-label="资料分组方式" @update:model-value="regroup" :options="[{ value: 'batch', label: '每个直接子目录创建一条资源' }, { value: 'single', label: '整个目录创建一条资源' }]" /><span>{{groups.length}} 条资源 · {{total}} 个附件</span></div>
<div v-if="loose.length" class="alert info"><label><input v-model="shareLoose" type="checkbox" :disabled="busy||groups.some(g=>g.uploaded.length>0)"/>将父目录的 {{loose.length}} 个文件作为每条资源的共享资料</label><span>{{loose.map(f=>f.path).join('、')}}</span></div>
<article v-for="g in groups" :key="g.key" class="batch-group"><div class="inline-actions"><input v-model="g.include" type="checkbox" :disabled="busy||!!g.done" :aria-label="`导入 ${g.name}`"/><input v-model="g.name" class="input" :disabled="busy||g.uploaded.length>0" aria-label="资源名称"/><BaseSelect v-model="g.scenario" :disabled="busy||g.uploaded.length>0" aria-label="资源场景" :options="Object.entries(scenarios).map(([key, label]) => ({ value: key, label: (label) }))" /><strong v-if="g.done" class="success-text">已创建</strong></div><div class="form-grid"><label class="field"><span>内容站 URL</span><input v-model="g.contentUrl" class="input" type="url" :disabled="busy||g.uploaded.length>0"/></label><label class="field"><span>参考站 URL</span><input v-model="g.referenceUrl" class="input" type="url" :disabled="busy||g.uploaded.length>0"/></label></div><details><summary>{{g.files.length}} 个附件 · 已上传 {{g.progress}}</summary><MaterialTree :files="g.files.map(f=>({name:f.path}))"/></details><p v-if="g.error" class="error-text">{{g.error}}</p></article><p v-if="error" class="alert error" role="alert">{{error}}</p><div class="modal-actions"><button v-if="groups.some(g=>!!g.done)" type="button" class="button secondary" :disabled="busy" @click="picked=[];groups=[];loose=[];error=''">开始另一批</button><button type="button" class="button secondary" :disabled="busy" @click="dialog?.close()">关闭</button><button type="button" class="button primary" :disabled="busy||!groups.some(g=>g.include&&!g.done)" @click="run"><LoaderCircle v-if="busy" class="spin" :size="16"/><Upload v-else :size="16"/>{{busy?'导入中…':groups.some(g=>g.error)?'重试未完成资源':'确认导入'}}</button></div></dialog></template>
<style scoped>.batch-import{width:min(900px,94vw)}.batch-group{padding:18px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:12px}.batch-group .inline-actions>.input{flex:1;min-width:160px}.material-drop{display:flex;align-items:center;gap:16px;padding:16px;border:1px dashed var(--line);border-radius:10px;margin-bottom:16px}.batch-group summary{cursor:pointer;font-size:13px;color:var(--muted)}</style>
