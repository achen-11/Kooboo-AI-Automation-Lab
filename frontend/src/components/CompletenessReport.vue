<script setup lang="ts">
import { ref } from 'vue';
import type { CompletenessReport, RequirementCheck, Requirement } from '../../../shared/completeness';
import { requirementKindNames, requirementStatusNames } from '../../../shared/completeness';
import { useTaskSection } from '../views/automation/use-task-section';
import Disclosure from './Disclosure.vue';
import TablePagination from './TablePagination.vue';
const props=defineProps<{taskId:string}>(),page=ref(1);
const {data,loading,error,load}=useTaskSection<{report:Omit<CompletenessReport,'checks'>|null;items:(RequirementCheck&{requirement?:Requirement})[];limitations:string[];page:number;pages:number;total:number}>(()=>`/automation/tasks/${props.taskId}/completeness?page=${page.value}&pageSize=20`);
const labels={complete:'全站交付已验证',incomplete:'仍有交付缺失',unverified:'完整度有待验证'};
</script>
<template><section v-if="data?.report" class="panel settings-panel"><div class="section-heading"><h2>全站完整度</h2><strong>{{labels[data.report.state]}}</strong></div><p v-if="!data.report.sourceComplete" class="text-muted">来源范围尚有缺口，不能据此认定已覆盖全部交付。</p><Disclosure v-if="data.limitations.length" label="来源缺口"><p v-for="s in data.limitations" :key="s" class="task-prose">{{s}}</p></Disclosure><div class="table-scroll"><table class="task-table"><thead><tr><th>交付项</th><th>类型</th><th>结果</th></tr></thead><tbody><tr v-for="item in data.items" :key="item.id"><td><Disclosure :label="item.requirement?.title||item.id"><p class="task-prose">{{item.reason}}</p><p class="text-muted">{{item.requirement?.expectation}}</p><p v-if="item.actualCount!==null" class="task-prose">实际 {{item.actualCount}} / 预期 {{item.requirement?.expectedCount??'未知'}}</p><p v-if="item.sampledPaths.length" class="task-prose">检查路径：{{item.sampledPaths.join('、')}}</p><div class="completeness-evidence"><a v-for="(e,i) in item.evidence" :key="e" class="text-action" :href="'/api/v1/automation/reports/'+taskId+'/artifacts/'+encodeURIComponent(e)" target="_blank" rel="noopener noreferrer">证据 {{i+1}}</a></div></Disclosure></td><td>{{item.requirement?requirementKindNames[item.requirement.kind]:'交付项'}}</td><td>{{requirementStatusNames[item.status]}}</td></tr></tbody></table></div><TablePagination :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page=$event" /></section><p v-if="error" class="alert error">{{error}}<button class="text-action" @click="load">重试</button></p></template>
<style scoped>.completeness-evidence{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px}</style>
