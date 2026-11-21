<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { X, Send, LoaderCircle, ChevronDown, ChevronRight, ExternalLink } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import KoobooRootDomainSelect from '../../components/KoobooRootDomainSelect.vue';
import { api, message, platform, go } from '../../api';
import { notify } from '../../lib/notifications';
import { workspace, refresh } from './common';
import type { AutomationRule, GeneratedSite, KoobooSandboxCapabilities, Resource, Scope } from '../../../../shared/automation';
import { effectiveTemplateUsageMode, requiredKoobooSandboxCapability, supportsAutomaticOptimization } from '../../../../shared/automation';
import { generationSiteNames, siteNamingError } from '../../../../shared/kooboo-domains';
import type { PublicSettings } from '../../../../shared/types';
const props=defineProps<{resources:Resource[];site?:GeneratedSite;kind?:'generation'|'evaluation'}>();
const emit=defineEmits<{created:[]}>();
const dialog=ref<HTMLDialogElement>();const error=ref('');const busy=ref(false);const preview=ref(false);
const scope=ref<Scope>('homepage');const environmentId=ref('');const requirements=ref('');const ruleId=ref('');const rules=ref<AutomationRule[]>([]);
const requestId=ref(crypto.randomUUID());
const rootDomain=ref(''),rootDomainReady=ref(false);
const siteName=ref(''),subDomain=ref('');
const autoDelivery=ref(false),savingDeliveryPref=ref(false);
const dialogOpen=ref(false),capabilities=ref<KoobooSandboxCapabilities|null>(null),capabilitiesLoading=ref(false);
let capRevision=0;
const resourceRoots=computed(()=>props.resources.some(resource=>!!resource.rootDomain));
function initialRoot(id:string){const roots=[...new Set(props.resources.map(resource=>resource.rootDomain||''))];return resourceRoots.value?(roots.length===1?roots[0]||'':''):platform.settings?.environments.find(env=>env.id===id)?.defaultRootDomain||'';}
function initialAutoDelivery(id:string){
  if(props.site?.hasDelivery)return false;
  const delivery=platform.settings?.environments.find(env=>env.id===id)?.delivery;
  return Boolean(delivery?.enabled&&delivery.hasToken&&delivery.auto);
}
const targetEnvId=computed(()=>props.site?.environmentId||environmentId.value);
const selectedEnvironment=computed(()=>platform.settings?.environments.find(env=>env.id===targetEnvId.value));
const envDelivery=computed(()=>selectedEnvironment.value?.delivery);
const siteAlreadyDelivered=computed(()=>Boolean(props.site?.hasDelivery));
const canAutoDeliver=computed(()=>Boolean(envDelivery.value?.enabled&&envDelivery.value?.hasToken&&!siteAlreadyDelivered.value));
watch(environmentId,id=>{rootDomain.value=initialRoot(id);rootDomainReady.value=false;autoDelivery.value=initialAutoDelivery(id);},{flush:'sync'});
const optimize=ref('no'),targetScore=ref(85),maxRounds=ref<number|string>(3),maxCostCny=ref<number|string>('');
const completionFirst=computed(()=>!props.site&&scope.value==='site'&&props.resources.every(r=>['migration','upgrade'].includes(r.scenario)));
watch(completionFirst,value=>{if(value)maxRounds.value='';else if(maxRounds.value==='')maxRounds.value=workspace.settings.optimization?.maxRounds||3;});
const canOptimize=computed(()=>kind.value==='generation'&&props.resources.length>0&&props.resources.every(r=>supportsAutomaticOptimization(r.scenario)));
const kind=computed(()=>props.kind||'generation');
const templateResources=computed(()=>kind.value==='generation'?props.resources.filter(r=>Boolean(r.referenceTemplateId?.trim())):[]);
async function loadCapabilities(force=false){
  const envId=targetEnvId.value;
  if(!dialogOpen.value||!templateResources.value.length||!envId){capabilities.value=null;capabilitiesLoading.value=false;return;}
  const current=++capRevision;capabilitiesLoading.value=true;if(force)capabilities.value=null;
  try{
    const query=new URLSearchParams({environmentId:envId});if(force)query.set('refresh','1');
    const result=await api<KoobooSandboxCapabilities>(`/automation/kooboo/capabilities?${query}`);
    if(current===capRevision&&targetEnvId.value===envId)capabilities.value=result;
  }catch{if(current===capRevision)capabilities.value=null;}
  finally{if(current===capRevision)capabilitiesLoading.value=false;}
}
watch([dialogOpen,targetEnvId,()=>templateResources.value.map(r=>r.id).join(',')],()=>{capabilities.value=null;void loadCapabilities(false);},{flush:'post'});
onBeforeUnmount(()=>{capRevision++;});
const templateBlockers=computed(()=>{
  const cap=capabilities.value;
  if(!cap||!templateResources.value.length||(cap.environmentId&&cap.environmentId!==targetEnvId.value))return [];
  const blockers:string[]=[];
  for(const r of templateResources.value){
    if(props.site){
      if(cap.importFromTemplate==='unsupported')blockers.push(`${r.name}：在已有生成站上使用 Kooboo 模板需要新版 Kooboo「模板导入参考 Sandbox」接口（当前环境暂未升级），请改用外部参考站 URL 或新建任务。`);
      continue;
    }
    const mode=effectiveTemplateUsageMode(r,false);
    const req=requiredKoobooSandboxCapability(r.scenario,mode);
    if(req&&cap[req.key]==='unsupported'){
      blockers.push(`${r.name}：所选模板模式需要「${req.label}」，但当前 Kooboo 环境暂未升级该接口，建站会被拦截。请将资源参考来源改为外部参考站 URL，或切换已升级环境。`);
    }
  }
  return blockers;
});
const templateSoftWarning=computed(()=>{
  const cap=capabilities.value;
  if(templateBlockers.value.length||!templateResources.value.length||!cap||(cap.environmentId&&cap.environmentId!==targetEnvId.value))return '';
  return cap.transferByLevel==='unsupported'?'当前 Kooboo 环境版本较早，可直接用所选模板建站，但缺少新版模板原位适配规范（template-adaptation.md），生成效果可能弱于新版环境。':'';
});
const namingErrors=computed(()=>kind.value!=='generation'||props.site?[]:props.resources.flatMap(resource=>{
  const names=generationSiteNames(props.resources.length===1?{siteName:siteName.value,subDomain:subDomain.value}:{},resource);
  return (['siteName','subDomain'] as const).flatMap(field=>{
    const value=names[field];const message=value===undefined?'':siteNamingError(value,field==='subDomain'?'子域名':'站点名称');
    return message?[{field,message,resourceName:resource.name}]:[];
  });
}));
const kindRules=computed(()=>rules.value.filter(r=>r.kind===(props.resources[0]?.scenario==='app-template'?'app':'site')&&(!r.scenarios||r.scenarios.includes(props.resources[0]!.scenario))&&r.criteria.some(c=>c.scopes.includes(scope.value))));
async function open(options?:{scope?:Scope}){optimize.value=canOptimize.value?'yes':'no';targetScore.value=workspace.settings.optimization?.targetScore||85;maxRounds.value=workspace.settings.optimization?.maxRounds||3;maxCostCny.value=workspace.settings.optimization?.maxCostCny??'';requestId.value=crypto.randomUUID();error.value='';preview.value=false;capabilities.value=null;scope.value=options?.scope??(props.resources[0]?.scenario.includes('template')?'site':'homepage');if(completionFirst.value)maxRounds.value='';requirements.value='';environmentId.value=props.site?.environmentId||platform.settings?.environments[0]?.id||'';rootDomain.value=initialRoot(environmentId.value);rootDomainReady.value=false;autoDelivery.value=initialAutoDelivery(environmentId.value);siteName.value=props.resources.length===1?props.resources[0]?.siteName||'':'';subDomain.value=props.resources.length===1?props.resources[0]?.subDomain||'':'';ruleId.value='';dialogOpen.value=true;dialog.value?.showModal();try{rules.value=(await api<{items:AutomationRule[]}>('/automation/rules')).items;}catch(e){error.value=message(e);}}
async function saveDeliveryPreference(){
  const env=selectedEnvironment.value;
  if(!env||savingDeliveryPref.value||busy.value)return;
  savingDeliveryPref.value=true;error.value='';
  try{
    platform.settings=await api<PublicSettings>(`/automation/environments/${env.id}/delivery-preference`,{method:'PUT',body:JSON.stringify({auto:autoDelivery.value})});
    notify.success(autoDelivery.value?'已设为该环境默认开启自动交付':'已设为该环境默认关闭自动交付');
  }catch(e){error.value=message(e);}finally{savingDeliveryPref.value=false;}
}
async function submit(){busy.value=true;error.value='';try{if(namingErrors.value.length)throw new Error(namingErrors.value[0]!.message);if(templateBlockers.value.length)throw new Error(templateBlockers.value[0]!);if(kind.value==='generation'&&!props.site&&!rootDomainReady.value)throw new Error('请先选择可用的建站根域名');const newSite=kind.value==='generation'&&!props.site;const result=await api<{items:{id:string}[]}>('/automation/tasks',{method:'POST',headers:{'Idempotency-Key':requestId.value},body:JSON.stringify({resourceIds:props.resources.map(r=>r.id),kind:kind.value,scope:scope.value,environmentId:environmentId.value,rootDomain:newSite?rootDomain.value||undefined:undefined,siteName:newSite&&props.resources.length===1?siteName.value.trim()||undefined:undefined,subDomain:newSite&&props.resources.length===1?subDomain.value.trim()||undefined:undefined,requirements:requirements.value,generatedSiteId:props.site?.id,ruleId:ruleId.value||undefined,autoDelivery:envDelivery.value?.enabled&&!siteAlreadyDelivered.value?(canAutoDeliver.value?autoDelivery.value:false):undefined,optimization:canOptimize.value&&optimize.value==='yes'?{targetScore:targetScore.value,maxRounds:maxRounds.value===''?undefined:Number(maxRounds.value),maxCostCny:maxCostCny.value===''?null:Number(maxCostCny.value)}:undefined})});dialog.value?.close();await refresh();emit('created');go(result.items.length===1?`/tasks/${result.items[0].id}`:'/tasks');}catch(e){error.value=message(e);}finally{busy.value=false;}}
const messages=computed(()=>props.resources.map(resource=>({name:resource.name,text:[props.site?'在已有目标站继续生成，不新建站点。':workspace.settings.prompts[resource.scenario],`本次范围：${scope.value==='homepage'?'仅首页，其他页面不属于本次交付范围。':'全站，按资料和用户目标完成全部范围。'}`,`内容站：${resource.contentUrl||'未提供'}\n参考站：${resource.referenceUrl||resource.contentUrl||'未提供'}`,'资料说明（作为业务内容）：\n'+resource.description,requirements.value?'补充要求：\n'+requirements.value:'','尽量一次自主完成，不反复询问。确实阻塞时说明已完成工作和需要的输入。'].filter(Boolean).join('\n\n')})));
defineExpose({open});
</script>
<template><dialog ref="dialog" class="modal wide-modal" @close="dialogOpen=false;capRevision++" @cancel="!busy || $event.preventDefault()"><form @submit.prevent="submit"><div class="modal-head"><h2>{{kind==='evaluation'?'发起评测':site?'继续生成':'创建生成任务'}}</h2><button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="dialog?.close()"><X :size="20" /></button></div><p class="text-muted">{{resources.length}} 个资源{{site?' · '+site.name:''}}</p>
<label v-if="!site" class="field"><span>Kooboo 环境</span><BaseSelect v-model="environmentId" required :options="[{ value: '', label: '选择环境', disabled: true }, ...(platform.settings?.environments || []).map((env) => ({ value: env.id, label: (env.name) }))]" /></label>
<label v-if="!site&&kind==='generation'" class="field"><span>建站根域名</span><KoobooRootDomainSelect :key="requestId + environmentId" v-model="rootDomain" :environment-id="environmentId" :auto-select="!resourceRoots" :required="!resourceRoots" empty-label="沿用资源或环境配置" @ready="rootDomainReady=$event" /></label>
<div v-if="!site&&kind==='generation'&&resources.length===1" class="form-grid"><label class="field"><span>站点名称（可选）</span><input v-model="siteName" class="input" maxlength="63" pattern="[A-Za-z0-9_]{1,63}" placeholder="留空使用子域名或自动生成" autocomplete="off" /><span v-if="namingErrors.some(item=>item.field==='siteName')" class="error-text" role="alert">{{namingErrors.find(item=>item.field==='siteName')?.message}}</span></label><label class="field"><span>子域名（可选）</span><input v-model="subDomain" class="input" maxlength="63" pattern="[A-Za-z0-9_]{1,63}" placeholder="留空使用站点名称或自动生成" autocomplete="off" /><span v-if="namingErrors.some(item=>item.field==='subDomain')" class="error-text" role="alert">{{namingErrors.find(item=>item.field==='subDomain')?.message}}</span></label></div>
<template v-if="resources.length>1"><p v-for="item in namingErrors" :key="item.resourceName+item.field" class="error-text" role="alert">{{item.resourceName}}：{{item.message}}</p></template>
<label class="field"><span>{{kind==='evaluation'?'评测':'生成'}}范围</span><BaseSelect v-model="scope" :options="[{ value: 'homepage', label: '仅首页' }, { value: 'site', label: '全站' }]" /></label>
<template v-if="canOptimize"><label class="field"><span>执行目标</span><BaseSelect v-model="optimize" :options="[{value:'no',label:'生成并评测'},{value:'yes',label:'自动优化到目标'}]" /></label><div v-if="optimize==='yes'" class="form-grid three-columns"><label class="field"><span>双端目标分数</span><input v-model.number="targetScore" class="input" type="number" min="1" max="100" required /></label><label class="field"><span>最多修复轮数{{completionFirst?'（可选）':''}}</span><input v-model.number="maxRounds" class="input" type="number" min="1" max="10" :required="!completionFirst" :placeholder="completionFirst?'持续至质量达标':''" /></label><label class="field"><span>费用上限（元，可选）</span><input v-model.number="maxCostCny" class="input" type="number" min="0.0001" step="any" placeholder="不设置" /></label></div></template>
<label v-if="kind==='evaluation'||optimize==='yes'&&canOptimize" class="field"><span>评测规则</span><BaseSelect v-model="ruleId" :options="[{ value: '', label: '最近发布的适用规则' }, ...kindRules.map((rule) => ({ value: rule.id, label: (rule.name) + ' · ' + (rule.hash.slice(0,8)) }))]" /></label>
<div v-if="envDelivery?.enabled" class="delivery-option-card">
  <template v-if="siteAlreadyDelivered">
    <div class="delivery-option-row">
      <strong>该生成站已有跨环境交付记录</strong>
      <a v-if="site?.deliveredUrl" class="text-action" :href="site.deliveredUrl" target="_blank" rel="noopener noreferrer">打开交付站<ExternalLink :size="13" /></a>
    </div>
    <p class="text-muted small-text">当前版本不重复迁移或覆盖已有目标站。</p>
  </template>
  <template v-else-if="!envDelivery.hasToken">
    <div class="delivery-option-row">
      <strong>跨环境交付尚未配置迁移服务令牌</strong>
      <a class="text-action" href="#/settings">前往系统设置</a>
    </div>
    <p class="text-muted small-text">补齐迁移服务令牌后可在创建任务时自动交付并核验。</p>
  </template>
  <template v-else>
    <label class="check-label"><input v-model="autoDelivery" type="checkbox" :disabled="busy || savingDeliveryPref" />完成后自动跨环境交付</label>
    <p class="text-muted small-text">{{ canOptimize && optimize === 'yes' ? '自动优化达标后自动触发迁移并核验目标站' : kind === 'evaluation' ? '源站独立评测完成后自动触发迁移并核验目标站' : '生成与独立评测完成后自动触发迁移并核验目标站' }}（{{ envDelivery.requirePassed ? '需源站评测通过' : '不限评测结论' }}）。</p>
    <div class="delivery-pref-bar">
      <span v-if="autoDelivery !== Boolean(envDelivery.auto)" class="text-muted small-text">当前环境默认：{{ envDelivery.auto ? '开启' : '关闭' }}</span>
      <span v-else class="text-muted small-text">当前采用该环境默认偏好（{{ envDelivery.auto ? '默认开启' : '默认关闭' }}）</span>
      <button v-if="autoDelivery !== Boolean(envDelivery.auto)" type="button" class="text-action" :disabled="busy || savingDeliveryPref" @click="saveDeliveryPreference">{{ savingDeliveryPref ? '保存中…' : '设为该环境默认' }}</button>
      <a v-else class="text-action" href="#/settings">调整交付设置</a>
    </div>
  </template>
</div>
<label class="field"><span>补充要求</span><textarea v-model="requirements" class="input" rows="4" placeholder="可留空，使用已保存的场景提示词与资料" /></label>
<button type="button" class="text-action" :aria-expanded="preview" @click="preview=!preview"><ChevronDown v-if="preview" :size="16" aria-hidden="true" /><ChevronRight v-else :size="16" aria-hidden="true" />{{preview?'收起':'预览'}}委托内容</button><div v-if="preview" class="message-preview"><div v-for="m in messages" :key="m.name"><strong>{{m.name}}</strong><pre>{{m.text}}</pre></div></div>
<div v-if="templateBlockers.length" class="alert error" role="alert"><span>{{templateBlockers.join(' ')}}</span><button type="button" class="text-action" :disabled="capabilitiesLoading" @click="loadCapabilities(true)">{{capabilitiesLoading?'检测中…':'重新检测'}}</button></div><div v-else-if="templateSoftWarning" class="alert info"><span>{{templateSoftWarning}}</span><button type="button" class="text-action" :disabled="capabilitiesLoading" @click="loadCapabilities(true)">{{capabilitiesLoading?'检测中…':'重新检测'}}</button></div><p v-if="!workspace.settings.enabled" class="alert info">执行队列已暂停，提交后保留在队列中，可在系统设置启用。</p><p v-if="!environmentId && !site" class="alert info"><a href="#/settings">先在系统设置添加 Kooboo 环境</a></p><p v-if="error" class="alert error" role="alert">{{error}}</p><div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="dialog?.close()">取消</button><button class="button primary" :disabled="busy || !!namingErrors.length || !!templateBlockers.length || !resources.length || (!environmentId&&!site) || (!site&&kind==='generation'&&!rootDomainReady)"><LoaderCircle v-if="busy" class="spin" :size="16" /><Send v-else :size="16" />加入队列</button></div></form></dialog></template>

<style scoped>
.delivery-option-card{display:flex;flex-direction:column;gap:8px;padding:14px 16px;margin:6px 0;background:var(--field);border:1px solid #e3e8f2;border-radius:10px}
.delivery-option-card .check-label{font-weight:600}
.delivery-option-card p{margin:0;line-height:1.5}
.delivery-option-row,.delivery-pref-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px}
.delivery-pref-bar .text-action{padding:0;font-size:12px}
</style>
