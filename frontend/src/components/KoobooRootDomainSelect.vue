<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import BaseSelect from './BaseSelect.vue';
import { api, message, platform } from '../api';
import { rootDomainLabel, rootDomainValue, findRootDomain, type KoobooRootDomain } from '../../../shared/kooboo-domains';

const props = defineProps<{ environmentId: string; disabled?: boolean; autoSelect?: boolean; required?: boolean; emptyLabel?: string }>();
const model = defineModel<string>({ default: '' });
const emit = defineEmits<{ ready: [value: boolean] }>();
const domains = shallowRef<KoobooRootDomain[]>([]);
const loading = ref(false), error = ref('');
const environment = computed(() => platform.settings?.environments.find(env => env.id === props.environmentId));
const missing = computed(() => !!model.value && !loading.value && !error.value && !findRootDomain(domains.value, model.value));
const ready = computed(() => !props.disabled && !!environment.value?.hasToken && !loading.value && !error.value && !missing.value && (!props.required || !!model.value));
const options = computed(() => [
  { value: '', label: props.required ? '选择根域名' : props.emptyLabel || '每次建站时选择', disabled: !!props.required },
  ...(missing.value ? [{ value: model.value, label: model.value + '（已不可用）', disabled: true }] : []),
  ...domains.value.map(domain => ({ value: rootDomainValue(domain), label: rootDomainLabel(domain) })),
]);
let revision = 0;
async function load() {
  const current = ++revision;
  domains.value = []; error.value = ''; loading.value = false;
  if (props.disabled || !props.environmentId || !environment.value?.hasToken) return;
  loading.value = true;
  try {
    const result = await api<{ items: KoobooRootDomain[] }>(`/environments/${props.environmentId}/domains`);
    if (current !== revision) return;
    domains.value = result.items;
    const choice = model.value || (props.autoSelect ? environment.value?.defaultRootDomain || result.items[0]?.domainName || '' : '');
    const selected = findRootDomain(result.items, choice);
    model.value = selected ? rootDomainValue(selected) : choice;
    if (!result.items.length) error.value = '此环境没有可用根域名，请先在 Kooboo 中配置';
  } catch (reason) { if (current === revision) error.value = message(reason); }
  finally { if (current === revision) loading.value = false; }
}
watch(() => [props.environmentId, props.disabled, environment.value?.origin, environment.value?.apiOrigin, environment.value?.hasToken], load, { immediate: true });
watch(ready, value => emit('ready', value), { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { revision++; });
</script>

<template>
  <div>
    <BaseSelect v-model="model" :options="options" :required="required" :loading="loading" :disabled="disabled || !environment?.hasToken" />
    <p v-if="disabled || !environment?.hasToken" class="text-muted small-text">保存并连接此环境后可选择根域名</p>
    <p v-else-if="error || missing" class="error-text" role="alert">{{ error || '所选根域名已不可用，请重新选择' }} <button type="button" class="text-action" :disabled="loading" @click="load">重新读取</button></p>
  </div>
</template>
