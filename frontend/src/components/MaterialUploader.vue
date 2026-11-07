<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Upload, FolderOpen, RotateCw, X } from '@lucide/vue';
import BaseSelect from './BaseSelect.vue';
import MaterialTree from './MaterialTree.vue';
import { fileSelection, droppedMaterials, uploadMaterial } from '../views/automation/material-upload';
import type { PickedMaterial } from '../../../shared/materials';
import { uniqueMaterialPaths } from '../../../shared/materials';
import type { MaterialFile } from '../../../shared/automation';
import { message } from '../api';
const props=defineProps<{modelValue:MaterialFile[];disabled?:boolean}>();
const emit=defineEmits<{'update:modelValue':[files:MaterialFile[]];busy:[value:boolean];pending:[value:boolean]}>();
const queue=ref<(PickedMaterial&{status?:string;error?:string;uploaded?:MaterialFile})[]>([]),busy=ref(false),error=ref(''),dragging=ref(false),keepRoot=ref(true),conflict=ref('skip');
const canStrip=computed(()=>{const paths=queue.value.map(q=>q.path.split('/'));return paths.length>0&&paths.every(p=>p.length>1&&p[0]===paths[0][0]);});
watch(()=>queue.value.length,length=>emit('pending',length>0),{immediate:true});
const pending=computed(()=>queue.value.map(q=>({...q,name:canStrip.value&&!keepRoot.value?q.path.split('/').slice(1).join('/'):q.path})));
function choose(event:Event){const input=event.target as HTMLInputElement;try{queue.value=fileSelection(input.files);keepRoot.value=true;error.value='';}catch(e){error.value=message(e);}input.value='';}
async function drop(event:DragEvent){dragging.value=false;if(busy.value||props.disabled||!event.dataTransfer)return;try{queue.value=await droppedMaterials(event.dataTransfer);keepRoot.value=true;error.value='';}catch(e){error.value=message(e);}}
async function upload(){busy.value=true;emit('busy',true);error.value='';try{
  uniqueMaterialPaths(pending.value);if(props.modelValue.length+pending.value.filter(q=>!props.modelValue.some(f=>f.name.toLowerCase()===q.name.toLowerCase())).length>1000)throw new Error('每条资源最多 1000 个附件');
  for(let i=0;i<pending.value.length;i++){
    const item=pending.value[i],q=queue.value[i];if(q.status==='完成')continue;
    const old=props.modelValue.find(f=>f.name.toLowerCase()===item.name.toLowerCase());if(old&&conflict.value==='skip'){q.status='已跳过同路径';continue;}
    q.status='上传中';q.error='';try{const file=q.uploaded?.name===item.name?q.uploaded:await uploadMaterial({file:item.file,path:item.name});q.uploaded=file;emit('update:modelValue',[...props.modelValue.filter(f=>f.name.toLowerCase()!==item.name.toLowerCase()),file]);q.status='完成';}catch(e){q.status='失败';q.error=message(e);}
  }
  if(queue.value.every(q=>q.status==='完成'||q.status==='已跳过同路径'))queue.value=[];
}catch(e){error.value=message(e);}finally{busy.value=false;emit('busy',false);}return queue.value.length===0;}
defineExpose({upload});
</script>
<template><div class="material-uploader"><div class="material-drop" :class="{dragging}" @dragover.prevent="dragging=true" @dragleave.prevent="dragging=false" @drop.prevent="drop"><div class="inline-actions"><label class="button secondary small"><Upload :size="16"/>选择文件<input class="sr-only" type="file" multiple :disabled="disabled||busy" @change="choose"/></label><label class="button secondary small"><FolderOpen :size="16"/>选择文件夹<input class="sr-only" type="file" multiple webkitdirectory :disabled="disabled||busy" @change="choose"/></label><span class="text-muted">或将文件、文件夹拖到这里</span></div></div>
<template v-if="queue.length"><div class="inline-actions"><label v-if="canStrip" class="check-label"><input v-model="keepRoot" type="checkbox" :disabled="busy||queue.some(q=>!!q.uploaded)"/>保留最外层目录 {{queue[0]?.path.split('/')[0]}}</label><BaseSelect v-model="conflict" aria-label="同路径文件处理" :disabled="busy"><option value="skip">同路径文件：跳过</option><option value="replace">同路径文件：替换</option></BaseSelect></div><MaterialTree :files="pending"/><div v-for="(q,i) in queue.filter(q=>q.status)" :key="i" class="small-text" :class="q.error?'error-text':'text-muted'">{{q.path}} · {{q.status}} {{q.error}}</div><div class="inline-actions"><button type="button" class="button primary small" :disabled="busy||disabled" @click="upload"><RotateCw v-if="queue.some(q=>q.error)" :size="15"/><Upload v-else :size="15"/>{{busy?'正在上传…':queue.some(q=>q.error)?'重试失败文件':'上传所选资料'}} ({{queue.length}})</button><button type="button" class="button secondary small" :disabled="busy" @click="queue=[]"><X :size="15"/>清空选择</button></div></template>
<p v-if="error" class="error-text" role="alert">{{error}}</p><MaterialTree v-if="modelValue.length" :files="modelValue" removable :disabled="busy||disabled" @remove="name=>emit('update:modelValue',modelValue.filter(f=>f.name!==name))"/><span class="text-muted small-text">{{modelValue.length}} / 1000 个附件 · 单文件最多 16 MB</span></div></template>
<style scoped>.material-uploader{display:flex;flex-direction:column;gap:12px}.material-drop{padding:18px;border:1px dashed var(--line);border-radius:10px}.material-drop.dragging{border-color:var(--blue);background:var(--field)}.material-uploader :deep(.ui-select){max-width:230px}.material-uploader .inline-actions{margin-top:0;flex-wrap:wrap}</style>
