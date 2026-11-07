<script setup lang="ts">
import { ref } from 'vue';
import { api, message } from '../api';
import { notify } from '../lib/notifications';
import { useTaskSection } from '../views/automation/use-task-section';
import Disclosure from './Disclosure.vue';
const props=defineProps<{taskId:string}>(),busy=ref(false),error=ref(''),reason=ref('');
const {data,load,error:loadError}=useTaskSection<{items:{id:string;accountId:string;state:string;charged:number}[]}>(()=>`/automation/tasks/${props.taskId}/budget`);
async function acknowledge(id:string){if(!reason.value.trim()){error.value='请先说明核查依据';return;}busy.value=true;error.value='';try{await api(`/automation/tasks/${props.taskId}/budget/acknowledge`,{method:'POST',body:JSON.stringify({requestId:id,reason:reason.value})});notify.success('已保留预占额度并记录核查');reason.value='';await load();}catch(e){error.value=message(e);}finally{busy.value=false;}}
</script>
<template><section v-if="data?.items.length" class="panel settings-panel"><h2>待核查的预算预占</h2><p class="text-muted">正在执行或缺少完整 usage 的请求会保留额度。全部执行停止并核查后，可确认继续保留预占；实际费用仍以用量记录为准。</p><Disclosure label="查看并核查请求"><p v-if="error" class="alert error">{{error}}</p><label class="field"><span>核查依据</span><input v-model="reason" class="input" placeholder="说明如何确认原请求已停止" /></label><div v-for="item in data.items" :key="item.id" class="version-entry"><div class="section-heading"><span>{{item.state==='active'?'执行状态待确认':'用量缺失'}} · 预占 {{item.charged.toLocaleString()}} token</span><button class="text-action" :disabled="busy" @click="acknowledge(item.id)">保留预占并确认</button></div><p class="text-muted small-text">{{item.id}}</p></div></Disclosure></section><p v-if="loadError" class="alert error">{{loadError}}<button class="text-action" @click="load">重试</button></p></template>
