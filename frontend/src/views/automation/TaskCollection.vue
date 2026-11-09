<script setup lang="ts">
import { ref } from 'vue';
import type { CollectionRun } from '../../../../shared/collection';
import { useTaskSection } from './use-task-section';
import { api, message } from '../../api';
const props=defineProps<{taskId:string;revision:string}>();
const {data,error}=useTaskSection<{collection:CollectionRun|null;snapshot:{id:string;sha256:string;files:number}|null;artifacts:{items:{path:string;size:number}[];total:number}}>(()=>`/automation/tasks/${props.taskId}/collection`,()=>props.revision);
const statuses={collecting:'采集中',reviewing:'独立复核中',repairing:'修正中',ready:'A 段已通过',blocked:'等待外部条件'};
const checks:Record<string,string>={A1:'范围',A2:'入口发现',A3:'栏目与记录',A4:'原始采集',A5:'内容提取',A6:'素材',A7:'版本交接'};
const evidence=ref(''),evidenceError=ref('');
async function show(path:string){try{evidenceError.value='';const result=await api<{text:string;nextOffset:number|null}>(`/automation/tasks/${props.taskId}/collection/evidence?path=${encodeURIComponent(path)}`);evidence.value=result.text+(result.nextOffset!==null?'\n\n（预览到此，完整原件保留在采集资料中）':'');}catch(reason){evidenceError.value=message(reason);}}
</script>
<template>
  <section v-if="data?.collection || error" class="panel settings-panel">
    <p v-if="error" class="alert error">{{error}}</p>
    <template v-if="data?.collection">
      <div class="section-heading"><h2>来源采集 · A 段</h2><strong>{{statuses[data.collection.status]}}</strong></div>
      <p class="task-prose">{{data.collection.completed.join(' → ') || '准备采集运行环境'}}</p>
      <p v-if="data.collection.next" class="task-prose">{{data.collection.next.description}}</p>
      <p v-if="data.collection.error" class="warning-text task-prose">{{data.collection.error}}</p>
      <ul v-if="data.collection.checks.length" class="collection-checks"><li v-for="check in data.collection.checks" :key="check.id"><strong>{{check.id}} {{checks[check.id]}}</strong><span>{{check.status==='verified'?'通过':check.status==='failed'?'需修正':'未验证'}}</span><p>{{check.reason}}</p></li></ul>
      <p v-if="data.snapshot" class="task-prose">资料版本 {{data.snapshot.id}} · {{data.snapshot.files}} 份资料</p>
      <details><summary>采集证据与检查点（{{data.artifacts.total}}）</summary><div class="collection-evidence"><button v-for="file in data.artifacts.items" :key="file.path" class="text-action" @click="show(file.path)">{{file.path}}</button></div><p v-if="evidenceError" class="alert error">{{evidenceError}}</p><pre v-if="evidence">{{evidence}}</pre></details>
    </template>
  </section>
</template>
<style scoped>
.collection-checks{padding:0;list-style:none;display:grid;gap:12px}.collection-checks li{display:grid;grid-template-columns:1fr auto;gap:4px}.collection-checks p{grid-column:1 / -1;margin:0;color:var(--text-muted);line-height:1.6}.collection-evidence{display:grid;gap:8px;margin:16px 0;max-height:240px;overflow:auto}.collection-evidence button{text-align:left;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:12px}summary{cursor:pointer}
</style>
