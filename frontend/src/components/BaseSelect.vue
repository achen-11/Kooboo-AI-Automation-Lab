<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, useId, watch, type AriaAttributes, type StyleValue } from 'vue';
import { Check, ChevronDown, LoaderCircle, Search } from '@lucide/vue';
import { filterSelectOptions, moveSelectIndex, sameSelectValue, selectMenuPlacement, selectValue, type SelectOption, type SelectValue } from '../lib/select';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  options: readonly SelectOption[];
  disabled?: boolean;
  loading?: boolean;
  required?: boolean;
  name?: string;
  form?: string;
  id?: string;
  placeholder?: string;
  searchable?: boolean;
  size?: 'default' | 'small';
  variant?: 'field' | 'quiet' | 'title';
}>(), { placeholder: '请选择', size: 'default', variant: 'field', searchable: undefined });
const [model, modifiers] = defineModel<SelectValue>();
const emit = defineEmits<{ change: [event: Event]; invalid: [event: Event] }>();
const attrs = useAttrs(), instanceId = useId();
const controlId = computed(() => props.id || `select-${instanceId}`), listId = `select-list-${instanceId}`, errorId = `select-error-${instanceId}`;
const root = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>(), panel = ref<HTMLElement>(), list = ref<HTMLElement>(), search = ref<HTMLInputElement>(), native = ref<HTMLSelectElement>();
const opened = ref(false), query = ref(''), active = ref(-1), validationError = ref('');
const unavailable = computed(() => props.disabled || props.loading);
const searchable = computed(() => props.searchable ?? props.options.length > 8);
const selected = computed(() => props.options.find(option => sameSelectValue(model.value, option.value)));
const filtered = computed(() => filterSelectOptions(props.options, query.value));
const activeId = computed(() => opened.value && active.value >= 0 ? `${listId}-${active.value}` : undefined);
// Layout belongs to the wrapper; accessibility and DOM event attributes belong to the trigger.
function triggerAttrs() { const { class: _class, style: _style, ...rest } = attrs; return rest; }

function place() {
  if (!opened.value || !trigger.value || !panel.value) return;
  const rect = trigger.value.getBoundingClientRect(), viewport = window.visualViewport;
  if (rect.bottom < (viewport?.offsetTop || 0) || rect.top > (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight)) { close(); return; }
  const position = selectMenuPlacement(rect, { width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight, left: viewport?.offsetLeft, top: viewport?.offsetTop });
  const menu = panel.value;
  menu.style.width = `${position.width}px`; menu.style.maxHeight = `${position.maxHeight}px`; menu.style.left = `${position.left}px`;
  menu.style.top = `${position.opensAbove ? rect.top - menu.getBoundingClientRect().height - 6 : rect.bottom + 6}px`;
}
function revealActive() { list.value?.querySelector<HTMLElement>(`[id="${listId}-${active.value}"]`)?.scrollIntoView({ block: 'nearest' }); }
async function open(direction: 1 | -1 = 1) {
  if (unavailable.value || opened.value) return;
  opened.value = true; query.value = '';
  const index = filtered.value.findIndex(option => sameSelectValue(model.value, option.value) && !option.disabled);
  active.value = index >= 0 ? index : moveSelectIndex(filtered.value, -1, direction);
  await nextTick();
  if (!opened.value || !panel.value) return;
  panel.value.showPopover(); place();
  if (searchable.value) search.value?.focus({ preventScroll: true });
  revealActive();
}
function close(restoreFocus = false) {
  if (!opened.value) return;
  opened.value = false; panel.value?.hidePopover();
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function changed(event: Event) {
  const option = props.options.find(option => String(option.value) === (event.target as HTMLSelectElement).value);
  if (!option || option.disabled) return;
  model.value = selectValue(option.value, model.value, !!modifiers.number);
  validationError.value = ''; emit('change', event);
}
function choose(index: number) {
  const option = filtered.value[index];
  if (!option || option.disabled || unavailable.value) return;
  if (!sameSelectValue(model.value, option.value) && native.value) {
    native.value.value = String(option.value);
    native.value.dispatchEvent(new Event('change', { bubbles: true }));
  }
  close(true);
}
let typed = '', typedAt = 0;
function onKeydown(event: KeyboardEvent) {
  if (unavailable.value || event.isComposing) return;
  if (event.key === 'Escape' && opened.value) { event.preventDefault(); event.stopPropagation(); close(true); return; }
  if (event.key === 'Tab') { if (opened.value) close(true); return; }
  const typing = event.target === search.value;
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(typing && ['Home', 'End'].includes(event.key))) {
    event.preventDefault();
    const delta = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
    if (!opened.value) {
      void open(delta).then(() => {
        if (event.key === 'Home' || event.key === 'End') { active.value = moveSelectIndex(filtered.value, -1, delta); revealActive(); }
      });
      return;
    }
    active.value = moveSelectIndex(filtered.value, event.key === 'Home' || event.key === 'End' ? -1 : active.value, delta);
    revealActive(); return;
  }
  if (event.key === 'Enter' || (event.key === ' ' && !typing)) {
    event.preventDefault();
    if (opened.value) choose(active.value); else void open();
    return;
  }
  if (!typing && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (searchable.value) { void open().then(() => { query.value += event.key; }); return; }
    const now = Date.now(); typed = now - typedAt > 700 ? event.key : typed + event.key; typedAt = now;
    void open().then(() => {
      const text = typed.toLocaleLowerCase();
      const index = filtered.value.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(text));
      if (index >= 0) { active.value = index; revealActive(); }
    });
  }
}
function invalid(event: Event) {
  event.preventDefault(); validationError.value = '请选择一项'; emit('invalid', event);
  if (!native.value?.form || native.value.form.querySelector(':invalid') === native.value) trigger.value?.focus();
}
function outside(event: Event) { if (opened.value && event.target instanceof Node && !root.value?.contains(event.target)) close(); }
function scrolled(event: Event) { if (!(event.target instanceof Node) || !panel.value?.contains(event.target)) place(); }
watch([() => JSON.stringify(props.options), query, model], async () => {
  if (model.value !== undefined && selected.value && !selected.value.disabled) validationError.value = '';
  if (!opened.value) return;
  active.value = filtered.value.findIndex(option => sameSelectValue(model.value, option.value) && !option.disabled);
  if (active.value < 0) active.value = moveSelectIndex(filtered.value, -1, 1);
  await nextTick(); place(); revealActive();
});
watch(unavailable, value => { if (value) close(); });
onMounted(() => {
  document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
  window.addEventListener('resize', place); window.addEventListener('scroll', scrolled, true);
  window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
});
onBeforeUnmount(() => {
  close();
  document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside);
  window.removeEventListener('resize', place); window.removeEventListener('scroll', scrolled, true);
  window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
});
defineExpose({ focus: () => trigger.value?.focus(), open, close, checkValidity: () => native.value?.checkValidity(), reportValidity: () => native.value?.reportValidity() });
</script>

<template>
  <span ref="root" class="ui-select" :class="[attrs.class, { 'ui-select-small': size === 'small', 'ui-select-quiet': variant === 'quiet', 'ui-select-title': variant === 'title' }]" :style="attrs.style as StyleValue">
    <button :id="controlId" ref="trigger" v-bind="triggerAttrs()" type="button" class="ui-select-trigger" :class="{ 'is-open': opened, 'is-invalid': validationError, 'is-placeholder': !selected || (selected.disabled && selected.value === '') }" role="combobox" aria-haspopup="listbox" :aria-expanded="opened" :aria-controls="opened ? listId : undefined" :aria-activedescendant="activeId" :aria-required="required || undefined" :aria-invalid="validationError ? true : (attrs['aria-invalid'] as AriaAttributes['aria-invalid'])" :aria-describedby="[attrs['aria-describedby'], validationError ? errorId : ''].filter(Boolean).join(' ') || undefined" :disabled="unavailable" :title="selected?.label || placeholder" @click="opened ? close() : open()" @keydown.stop="onKeydown">
      <span class="ui-select-value">{{ selected?.label || placeholder }}</span><LoaderCircle v-if="loading" class="spin" :size="16" aria-hidden="true" /><ChevronDown v-else class="ui-select-chevron" :size="16" aria-hidden="true" />
    </button>
    <select ref="native" class="ui-select-native" :value="model" :name="name" :form="form" :required="required" :disabled="unavailable" tabindex="-1" aria-hidden="true" @change="changed" @invalid="invalid"><option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option></select>
    <span v-if="validationError" :id="errorId" class="ui-select-error" role="alert">{{ validationError }}</span>
    <div v-if="opened" ref="panel" popover="manual" class="ui-select-menu" @keydown.stop="onKeydown">
      <div v-if="searchable" class="ui-select-search"><Search :size="15" aria-hidden="true" /><input ref="search" v-model="query" type="text" placeholder="搜索选项…" aria-label="搜索选项" role="combobox" aria-autocomplete="list" :aria-expanded="opened" :aria-controls="listId" :aria-activedescendant="activeId" autocomplete="off" @click.stop /></div>
      <div :id="listId" ref="list" class="ui-select-list" role="listbox" :aria-label="String(attrs['aria-label'] || '可选项')">
        <template v-for="(option, index) in filtered" :key="option.value">
          <div v-if="option.group && option.group !== filtered[index - 1]?.group" class="ui-select-group">{{ option.group }}</div>
          <div :id="`${listId}-${index}`" class="ui-select-option" :class="{ 'is-active': active === index, 'is-selected': sameSelectValue(model, option.value), 'is-disabled': option.disabled }" role="option" :aria-selected="sameSelectValue(model, option.value)" :aria-disabled="option.disabled || undefined" :title="option.label" @pointermove="!option.disabled && (active = index)" @mousedown.prevent @click.stop.prevent="choose(index)"><span>{{ option.label }}</span><Check v-if="sameSelectValue(model, option.value)" :size="16" aria-hidden="true" /></div>
        </template>
        <p v-if="!filtered.length" class="ui-select-empty">{{ query ? '没有匹配的选项' : '暂无选项' }}</p>
      </div>
    </div>
  </span>
</template>

<style scoped>
.ui-select{position:relative;display:inline-flex;flex-direction:column;min-width:0;width:100%;max-width:100%;padding:0;border:0;background:transparent;vertical-align:middle;font-weight:400}
.ui-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;min-width:0;min-height:42px;padding:10px 13px;background:var(--field);border:1px solid transparent;border-radius:9px;color:var(--ink);font:inherit;font-size:14px;text-align:left;transition:border-color .15s,background .15s,box-shadow .15s}
.ui-select-trigger:hover:not(:disabled){background:#eaf0f8}.ui-select-trigger:focus-visible,.ui-select-trigger.is-open{outline:0;border-color:var(--focus-border);box-shadow:var(--focus-shadow)}.ui-select-trigger:disabled{opacity:.5;cursor:default}.ui-select-trigger.is-invalid{border-color:var(--red)}.ui-select-trigger.is-placeholder{color:var(--muted)}
.ui-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ui-select-chevron{flex:none;color:var(--muted);transition:transform .15s}.is-open .ui-select-chevron{transform:rotate(180deg)}
.ui-select-small{width:auto;min-width:125px}.ui-select-small .ui-select-trigger{min-height:36px;padding:7px 11px;font-size:12px}.ui-select-quiet .ui-select-trigger{background:transparent;color:var(--muted)}.ui-select-title{width:auto;min-width:0}.ui-select-title .ui-select-trigger{background:transparent;font-size:13px;font-weight:600;min-height:36px;padding:6px 8px}.ui-select-title .ui-select-trigger:hover:not(:disabled){background:var(--field)}
.ui-select-native{position:absolute;width:1px;height:1px;inset:0;opacity:0;clip-path:inset(50%);overflow:hidden;pointer-events:none}.ui-select-error{display:block;margin-top:6px;font-size:12px;color:var(--red)}
.ui-select-menu{position:fixed;inset:auto;margin:0;padding:6px;border:1px solid #e2e7ef;border-radius:11px;color:var(--ink);background:var(--paper);box-shadow:0 10px 36px #1c315a24;font:inherit;font-size:13px;overflow:hidden}.ui-select-menu:popover-open{display:flex;flex-direction:column}.ui-select-menu::backdrop{background:transparent}
.ui-select-search{display:flex;align-items:center;gap:9px;flex:none;margin:1px 2px 6px;padding:8px 9px;border-bottom:1px solid var(--line);color:var(--muted)}.ui-select-search input{min-width:0;width:100%;border:0;background:transparent;outline:0;padding:0;font-size:13px}.ui-select-search:focus-within{border-bottom-color:var(--blue)}
.ui-select-list{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.ui-select-option{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 11px;border-radius:6px;cursor:pointer;line-height:1.55}.ui-select-option>span{min-width:0;overflow-wrap:anywhere}.ui-select-option.is-active:not(.is-disabled){background:var(--field)}.ui-select-option.is-selected{color:var(--blue);font-weight:600}.ui-select-option.is-selected.is-active{background:#edf2ff}.ui-select-option.is-disabled{color:#a1aaba;cursor:default}.ui-select-group{padding:9px 11px 4px;font-size:11px;color:var(--muted)}.ui-select-empty{padding:24px 12px;text-align:center;color:var(--muted);font-size:13px}
@media(prefers-reduced-motion:reduce){.ui-select-trigger,.ui-select-chevron{transition:none}}
</style>
