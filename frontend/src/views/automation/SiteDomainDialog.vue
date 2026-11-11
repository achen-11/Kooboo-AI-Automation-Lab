<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { X, LoaderCircle } from '@lucide/vue';
import BaseSelect from '../../components/BaseSelect.vue';
import { api, message } from '../../api';
import { notify } from '../../lib/notifications';
import { bindingDomain, rootDomainLabel, type SiteDomainOptions } from '../../../../shared/kooboo-domains';
import type { GeneratedSite } from '../../../../shared/automation';

const emit = defineEmits<{ saved: [site: GeneratedSite] }>();
const dialog = ref<HTMLDialogElement>(), data = ref<SiteDomainOptions>();
const loading = ref(false), busy = ref(false), error = ref(''), siteId = ref('');
const rootDomain = ref(''), subDomain = ref('');
let revision = 0;
const root = computed(() => data.value?.domains.find(item => item.domainName === rootDomain.value));
const validSubDomain = computed(() => /^[a-z0-9_]{1,63}$/.test(subDomain.value));
const host = computed(() => root.value ? bindingDomain(subDomain.value, root.value) : '');
const valid = computed(() => validSubDomain.value && !!root.value && host.value.length <= 253 && host.value.split('.').every(label => label.length <= 63));
async function read() {
  const current = ++revision, id = siteId.value;
  loading.value = true; error.value = ''; data.value = undefined;
  try {
    const result = await api<SiteDomainOptions>(`/automation/sites/${id}/domains`);
    if (current !== revision) return;
    data.value = result; rootDomain.value = result.rootDomain; subDomain.value = result.subDomain;
  } catch (reason) { if (current === revision) error.value = message(reason); }
  finally { if (current === revision) loading.value = false; }
}
async function open(id: string) {
  if (busy.value) return;
  siteId.value = id; dialog.value?.showModal(); await read();
}
function close() { if (busy.value) return; revision++; dialog.value?.close(); }
async function save() {
  if (!valid.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const site = await api<GeneratedSite>(`/automation/sites/${siteId.value}/domains`, { method: 'POST', body: JSON.stringify({ rootDomain: rootDomain.value, subDomain: subDomain.value }) });
    dialog.value?.close(); notify.success('域名已重新绑定，站点访问地址已更新'); emit('saved', site);
  } catch (reason) { error.value = message(reason); }
  finally { busy.value = false; }
}
onBeforeUnmount(() => revision++);
defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal" aria-labelledby="site-domain-title" @cancel.prevent="close">
    <form @submit.prevent="save">
      <div class="modal-head"><h2 id="site-domain-title">重新绑定域名</h2><button type="button" class="icon-button" :disabled="busy" aria-label="关闭" @click="close"><X :size="20" /></button></div>
      <p v-if="loading" class="section-loading"><LoaderCircle class="spin" :size="18" />正在读取域名绑定…</p>
      <template v-else-if="data">
        <p v-if="data.site.url" class="text-muted domain-current">{{ data.site.url }}</p>
        <label class="field"><span>子域名</span><input v-model="subDomain" class="input" required maxlength="63" pattern="[a-z0-9_]{1,63}" :disabled="busy" autocomplete="off" spellcheck="false" /><span v-if="subDomain && !validSubDomain" class="error-text">只能使用小写字母、数字和下划线（_）</span></label>
        <label class="field"><span>根域名</span><BaseSelect v-model="rootDomain" required :disabled="busy" :options="data.domains.map(item=>({value:item.domainName,label:rootDomainLabel(item)}))" /></label>
        <p v-if="!data.domains.length" class="error-text">此环境没有可用根域名，请先在 Kooboo 中配置</p>
        <p v-if="host" class="domain-preview">{{ host }}</p>
        <p class="text-muted small-text">保留站点内容和原有域名绑定，更新平台访问地址。历史报告保留，新地址需重新评测。</p>
      </template>
      <p v-if="error" class="alert error" role="alert">{{ error }}<button v-if="!data" type="button" class="text-action" :disabled="loading" @click="read">重试</button></p>
      <div class="modal-actions"><button type="button" class="button secondary" :disabled="busy" @click="close">取消</button><button class="button primary" :disabled="loading || busy || !data || !valid"><LoaderCircle v-if="busy" class="spin" :size="16" />{{ busy ? '正在绑定…' : '确认绑定' }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.domain-current,.domain-preview{overflow-wrap:anywhere}.domain-preview{padding:12px;background:var(--field);border-radius:6px;font-variant-numeric:tabular-nums}
</style>
