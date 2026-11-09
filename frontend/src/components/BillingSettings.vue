<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { api, message, formatDate } from '../api';
import type { PriceSnapshot } from '../../../shared/billing';
import { notify } from '../lib/notifications';
const prices=ref<PriceSnapshot[]>([]),draft=ref<PriceSnapshot>(),calendar=ref(''),error=ref(''),busy=ref(false);
async function load(){
  error.value='';
  try{
    const {items}=await api<{items:PriceSnapshot[]}>('/automation/prices');
    const latest=items.at(-1);
    // Clone the plain API data before Vue wraps the saved versions in reactive proxies.
    const nextDraft=latest?structuredClone(latest):undefined;
    prices.value=items;draft.value=nextDraft;calendar.value=JSON.stringify(nextDraft?.holidays||{},null,2);
  }catch(e){error.value=message(e);}
}
onMounted(load);
async function publish(){if(!draft.value)return;busy.value=true;error.value='';try{await api('/automation/prices',{method:'POST',body:JSON.stringify({...draft.value,id:undefined,verifiedAt:Date.now(),effectiveFrom:Date.now(),holidays:JSON.parse(calendar.value)})});await load();notify.success('新价格版本已发布，仅用于之后的请求');}catch(e){error.value=message(e);}finally{busy.value=false;}}
</script>
<template><section class="panel settings-panel billing-settings"><h2>DeepSeek 价格版本</h2><p class="text-muted">单位为人民币 / 百万 tokens。北京时间工作日（不含中国法定节假日）09–12、14–18 为高峰，其余时段闲时。</p><template v-if="draft"><label class="field"><span>官方价格来源</span><input v-model="draft.source" class="input" type="url"/></label><label class="field"><span>适用模型（每行一个）</span><textarea class="input" rows="4" :value="draft.models.join('\n')" @input="draft.models=($event.target as HTMLTextAreaElement).value.split('\n').map(v=>v.trim()).filter(Boolean)"/></label><div class="table-scroll"><table class="task-table"><thead><tr><th>时段</th><th>缓存命中输入</th><th>未命中输入</th><th>输出</th></tr></thead><tbody><tr v-for="band in ['peak','offpeak'] as const" :key="band"><td>{{band==='peak'?'高峰':'闲时'}}</td><td v-for="key in ['cached','input','output'] as const" :key="key"><input v-model.number="draft[band][key]" class="input" type="number" min="0" step="0.001"/></td></tr></tbody></table></div><label class="field"><span>中国法定节假日（日历 JSON，按年份列出 YYYY-MM-DD）</span><textarea v-model="calendar" class="input code-editor" rows="8" spellcheck="false"/></label><button class="button primary" :disabled="busy" @click="publish">发布新价格版本</button></template><p v-if="error" class="alert error">{{error}}</p><details v-if="prices.length"><summary class="disclosure-summary"><ChevronRight class="disclosure-chevron" :size="16" aria-hidden="true" />{{prices.length}} 个历史版本</summary><p v-for="price in prices" :key="price.id">{{price.id}} · 生效于 {{formatDate(price.effectiveFrom)}}</p></details></section></template>

<style scoped>
.billing-settings{display:flex;flex-direction:column;gap:20px}.billing-settings>h2{margin:0}.billing-settings>.button{align-self:flex-start}
</style>
