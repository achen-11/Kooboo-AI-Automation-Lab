<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ArrowLeft, Plus, Save, Search, RotateCcw } from '@lucide/vue';
import { api, message, formatDate } from '../../api';
import { notify } from '../../lib/notifications';
import Disclosure from '../../components/Disclosure.vue';
import TablePagination from '../../components/TablePagination.vue';
import { scenarios, type Scenario } from '../../../../shared/automation';
import { experienceStageNames, experienceEvidenceNames, type Experience, type ExperienceInput, type ExperienceRevision, type ExperienceStage } from '../../../../shared/experience';
const props=defineProps<{id?:string}>();
const blank=():ExperienceInput=>({title:'',scenarios:[],stages:[],conditions:'',exclusions:'',guidance:''});
const list=shallowRef<{items:Experience[];page:number;pages:number;total:number}>(),item=shallowRef<Experience>();
const form=ref<ExperienceInput>(blank()),enabled=ref(true),reason=ref(''),baseline=ref(''),error=ref(''),busy=ref(false),search=ref(''),filter=ref(''),page=ref(1);
const scenario=ref<Scenario|''>(''),stage=ref<ExperienceStage|''>(''),appliedSearch=ref('');
const scenarioOptions:{value:Scenario|'';label:string}[]=[{value:'',label:'全部'},...Object.entries(scenarios).map(([value,label])=>({value:value as Scenario,label}))];
const stageOptions:{value:ExperienceStage|'';label:string}[]=[{value:'',label:'全部'},...Object.entries(experienceStageNames).map(([value,label])=>({value:value as ExperienceStage,label}))];
const hasFilters=computed(()=>!!(appliedSearch.value||filter.value||scenario.value||stage.value));
const history=shallowRef<{items:ExperienceRevision[];page:number;pages:number;total:number}>();
const detail=computed(()=>Boolean(props.id)),dirty=computed(()=>detail.value&&baseline.value!==JSON.stringify({form:form.value,enabled:enabled.value}));defineExpose({dirty});
let version=0;
async function load(){const request=++version;error.value='';busy.value=true;try{
  if(props.id==='new'){form.value=blank();item.value=undefined;enabled.value=true;baseline.value=JSON.stringify({form:form.value,enabled:enabled.value});return;}
  if(props.id){item.value=undefined;const value=await api<{item:Experience}>('/automation/experiences/'+props.id);if(request!==version)return;item.value=value.item;const e=value.item;form.value={title:e.title,scenarios:[...e.scenarios],stages:[...e.stages],conditions:e.conditions,exclusions:e.exclusions,guidance:e.guidance};enabled.value=e.enabled;baseline.value=JSON.stringify({form:form.value,enabled:enabled.value});reason.value='';history.value=undefined;}
  else {const query=new URLSearchParams({page:String(page.value),search:appliedSearch.value});if(filter.value)query.set('enabled',filter.value);if(scenario.value)query.set('scenario',scenario.value);if(stage.value)query.set('stage',stage.value);const value=await api<NonNullable<typeof list.value>>('/automation/experiences?'+query);if(request===version)list.value=value;}
}catch(e){if(request===version)error.value=message(e);}finally{if(request===version)busy.value=false;}}
watch([filter,scenario,stage,appliedSearch],()=>{page.value=1;},{flush:'sync'});
watch([()=>props.id,page,filter,scenario,stage,appliedSearch],()=>void load(),{immediate:true});
function searchList(){const value=search.value.trim();if(page.value===1&&appliedSearch.value===value)void load();else{page.value=1;appliedSearch.value=value;}}
function clearFilters(){search.value='';appliedSearch.value='';filter.value='';scenario.value='';stage.value='';}
async function save(){if(props.id!=='new'&&!item.value)return;busy.value=true;error.value='';try{const value=await api<Experience>('/automation/experiences'+(item.value?'/'+item.value.id:''),{method:item.value?'PUT':'POST',body:JSON.stringify({input:form.value,enabled:enabled.value,revision:item.value?.revision,reason:reason.value||'人工维护经验'})});baseline.value=JSON.stringify({form:form.value,enabled:enabled.value});notify.success('经验已保存');if(props.id==='new')window.location.hash='/experiences/'+value.id;else await load();}catch(e){error.value=message(e);}finally{busy.value=false;}}
async function loadHistory(p=1){try{history.value=await api(`/automation/experiences/${props.id}/history?page=${p}&pageSize=10`);}catch(e){error.value=message(e);}}
async function restore(from:number){if(!item.value)return;busy.value=true;try{await api(`/automation/experiences/${item.value.id}/restore`,{method:'POST',body:JSON.stringify({revision:item.value.revision,from,reason:'人工恢复历史版本 '+from})});await load();notify.success('已创建恢复版本');}catch(e){error.value=message(e);}finally{busy.value=false;}}
</script>
<template>
  <header class="page-header"><div><a v-if="detail" class="text-action" href="#/experiences"><ArrowLeft :size="15" />经验库</a><h1>{{detail?(item?.title||'新增经验'):'经验库'}}</h1></div><button v-if="detail" class="button primary" :disabled="busy||!dirty" @click="save"><Save :size="16" />保存</button><a v-else class="button primary" href="#/experiences/new"><Plus :size="16" />新增经验</a></header>
  <p v-if="error" class="alert error">{{error}}</p>
  <template v-if="!detail">
    <div class="experience-filters">
      <div class="experience-toolbar">
        <form class="experience-search" @submit.prevent="searchList"><div class="search-field"><Search :size="17" /><input v-model="search" maxlength="200" placeholder="搜索经验标题" aria-label="搜索经验" /></div><button class="button secondary small" :disabled="busy">搜索</button></form>
        <div class="segmented compact" role="group" aria-label="筛选启用状态"><button v-for="option in [{value:'',label:'全部状态'},{value:'true',label:'已启用'},{value:'false',label:'已停用'}]" :key="option.value" type="button" :class="{selected:filter===option.value}" :aria-pressed="filter===option.value" @click="filter=option.value">{{option.label}}</button></div>
        <button v-if="hasFilters" type="button" class="text-action experience-clear" @click="clearFilters"><RotateCcw :size="13" />清除筛选</button>
      </div>
      <div class="experience-filter-options">
        <div class="experience-filter-row"><span>场景</span><div class="segmented compact" role="group" aria-label="筛选适用场景"><button v-for="option in scenarioOptions" :key="option.value" type="button" :class="{selected:scenario===option.value}" :aria-pressed="scenario===option.value" @click="scenario=option.value">{{option.label}}</button></div></div>
        <div class="experience-filter-row"><span>阶段</span><div class="segmented compact" role="group" aria-label="筛选适用阶段"><button v-for="option in stageOptions" :key="option.value" type="button" :class="{selected:stage===option.value}" :aria-pressed="stage===option.value" @click="stage=option.value">{{option.label}}</button></div></div>
      </div>
    </div>
    <section class="panel" :aria-busy="busy"><div class="table-scroll"><table class="task-table"><thead><tr><th>经验</th><th>适用阶段</th><th>验证情况</th><th>状态</th><th>更新时间</th></tr></thead><tbody><tr v-for="e in list?.items" :key="e.id"><td><a class="text-action" :href="'#/experiences/'+e.id">{{e.title}}</a></td><td>{{e.stages.map(s=>experienceStageNames[s]).join('、')}}</td><td>{{experienceEvidenceNames[e.evidence]}}</td><td>{{e.enabled?'启用':'停用'}}</td><td>{{formatDate(e.updatedAt)}}</td></tr><tr v-if="!list?.items.length"><td colspan="5" class="text-muted">{{busy?'正在加载…':hasFilters?'没有符合筛选条件的经验。':'尚无经验。后续任务会根据执行与评测证据自动复盘，也可以手动新增。'}}</td></tr></tbody></table></div><TablePagination v-if="list" :page="list.page" :pages="list.pages" :total="list.total" :busy="busy" @change="page=$event" /></section>
  </template>
  <template v-else-if="props.id==='new'||item">
    <form class="panel settings-panel" @submit.prevent="save"><div class="section-heading"><h2>适用规则</h2><label class="check-label"><input v-model="enabled" type="checkbox" />启用</label></div><p v-if="item" class="text-muted small-text">版本 {{item.revision}} · {{experienceEvidenceNames[item.evidence]}}{{item.manualDisabled?' · 人工停用，AI 无权恢复':''}}</p><label class="field"><span>标题</span><input v-model="form.title" class="input" maxlength="200" required /></label><div class="form-grid"><fieldset><legend>场景</legend><label v-for="(name,key) in scenarios" :key="key" class="check-label"><input v-model="form.scenarios" type="checkbox" :value="key" />{{name}}</label></fieldset><fieldset><legend>阶段</legend><label v-for="(name,key) in experienceStageNames" :key="key" class="check-label"><input v-model="form.stages" type="checkbox" :value="key" />{{name}}</label></fieldset></div><label class="field"><span>适用条件</span><textarea v-model="form.conditions" class="input" rows="3" required /></label><label class="field"><span>不适用条件</span><textarea v-model="form.exclusions" class="input" rows="2" /></label><label class="field"><span>执行建议</span><textarea v-model="form.guidance" class="input" rows="7" required /></label><label class="field"><span>修改原因</span><input v-model="reason" class="input" placeholder="说明本次调整依据" /></label></form>
    <section v-if="item" class="panel settings-panel"><h2>来源与版本</h2><a v-if="item.sourceTaskId" class="text-action" :href="'#/tasks/'+item.sourceTaskId">查看来源任务</a><Disclosure v-if="item.sourceEvidence.length" label="来源证据"><ul class="task-text-list"><li v-for="e in item.sourceEvidence" :key="e">{{e}}</li></ul></Disclosure><button class="text-action" :disabled="busy" @click="loadHistory()">查看版本历史</button><template v-if="history"><div v-for="h in history.items" :key="h.experience.revision" class="version-entry"><div class="section-heading"><strong>版本 {{h.experience.revision}} · {{h.actor==='ai'?'AI':'人工'}}</strong><button v-if="h.experience.revision!==item.revision" class="text-action" :disabled="busy||dirty" @click="restore(h.experience.revision)"><RotateCcw :size="14" />恢复</button></div><p class="task-prose">{{h.reason}}</p><Disclosure label="查看内容"><pre class="task-technical">{{h.experience.guidance}}</pre></Disclosure></div><TablePagination :page="history.page" :pages="history.pages" :total="history.total" :busy="busy" @change="loadHistory" /></template></section>
  </template>
</template>
<style scoped>
.experience-filters{--experience-control-height:35px;display:flex;flex-direction:column;gap:10px;margin-bottom:18px}
.experience-toolbar,.experience-search{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.experience-toolbar{margin-bottom:2px}.experience-search{flex:0 1 420px;min-width:0;flex-wrap:nowrap;gap:8px}
.search-field{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:var(--experience-control-height);min-height:var(--experience-control-height);background:var(--paper);border:1px solid #dce3ee}.search-field input{min-width:0;width:100%;height:100%;padding:0;font-size:12px;line-height:1.5;color:var(--ink)}.search-field>svg{flex:none}
.experience-search>.button{height:var(--experience-control-height);min-height:var(--experience-control-height);padding-block:0}
.experience-toolbar>.segmented{height:var(--experience-control-height)}
.search-field:hover{border-color:#c5cfdf}.search-field:focus-within{border-color:var(--focus-border);box-shadow:var(--focus-shadow)}
.experience-filter-options{display:flex;align-items:center;flex-wrap:wrap;gap:10px 24px}
.experience-filter-row{display:flex;align-items:center;gap:14px;min-width:0}.experience-filter-row>span{flex:none;font-size:12px;color:var(--muted)}
.experience-filter-row .segmented{max-width:100%;min-width:0;flex-wrap:wrap;row-gap:3px}.experience-clear{min-height:var(--experience-control-height);font-size:12px}
fieldset{border:1px solid var(--border);border-radius:6px;padding:14px}legend{font-size:13px;padding:0 6px}
@media(max-width:650px){.experience-search{flex-basis:100%}.experience-toolbar{gap:10px}.experience-filter-row{align-items:flex-start;gap:10px}.experience-filter-row>span{padding-top:9px}.experience-filter-row .segmented button{padding-inline:10px}}
</style>
