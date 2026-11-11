<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, LoaderCircle, RotateCcw, Trash2, X } from '@lucide/vue';
import { api, message } from '../../api';
import { notify } from '../../lib/notifications';
import {
  discardReasonPresets,
  type DispositionState,
  type DispositionTargetKind,
} from '../../../../shared/dispositions';

export interface DispositionDialogOptions {
  kind: DispositionTargetKind;
  ids: string[];
  state: DispositionState;
  label: string;
  canCascadeResources?: boolean;
  defaultCascadeResources?: boolean;
  canCascadeDeliveries?: boolean;
  defaultCascadeDeliveries?: boolean;
}

const emit = defineEmits<{ saved: [state: DispositionState] }>();
const dialog = ref<HTMLDialogElement>();
const busy = ref(false);
const error = ref('');
const current = ref<DispositionDialogOptions>({
  kind: 'delivery',
  ids: [],
  state: 'completed',
  label: '',
});
const note = ref('');
const cascadeResources = ref(false);
const cascadeDeliveries = ref(false);

const title = computed(() => {
  if (current.value.state === 'completed') return '标记为已完成';
  if (current.value.state === 'discarded') {
    return current.value.kind === 'delivery' ? '舍弃生成站任务' : '舍弃资源';
  }
  return '移回在列';
});

const confirmLabel = computed(() => {
  if (current.value.state === 'completed') return '确认完成';
  if (current.value.state === 'discarded') return '确认舍弃';
  return '移回在列';
});

function togglePreset(preset: string) {
  const trimmed = note.value.trim();
  if (trimmed === preset) {
    note.value = '';
    return;
  }
  note.value = trimmed ? `${trimmed}；${preset}`.slice(0, 500) : preset;
}

function open(options: DispositionDialogOptions) {
  current.value = { ...options, ids: [...options.ids] };
  note.value = '';
  error.value = '';
  cascadeResources.value = Boolean(options.canCascadeResources && (options.defaultCascadeResources ?? true));
  cascadeDeliveries.value = Boolean(options.canCascadeDeliveries && (options.defaultCascadeDeliveries ?? true));
  dialog.value?.showModal();
}

function close() {
  if (!busy.value) dialog.value?.close();
}

async function submit() {
  if (busy.value || !current.value.ids.length) return;
  busy.value = true;
  error.value = '';
  try {
    await api('/automation/dispositions', {
      method: 'POST',
      body: JSON.stringify({
        kind: current.value.kind,
        ids: current.value.ids,
        state: current.value.state,
        note: current.value.state === 'active' ? '' : note.value,
        ...(current.value.canCascadeResources ? { cascadeResources: cascadeResources.value } : {}),
        ...(current.value.canCascadeDeliveries ? { cascadeDeliveries: cascadeDeliveries.value } : {}),
      }),
    });
    const count = current.value.ids.length;
    const unitName = current.value.kind === 'delivery' ? '项任务' : '项资源';
    dialog.value?.close();
    notify.success(
      current.value.state === 'completed'
        ? `已将 ${count} ${unitName}标记为已完成`
        : current.value.state === 'discarded'
          ? `已将 ${count} ${unitName}移入已舍弃`
          : `已将 ${count} ${unitName}移回在列`,
    );
    emit('saved', current.value.state);
  } catch (reason) {
    error.value = message(reason);
  } finally {
    busy.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog ref="dialog" class="modal" @cancel="!busy || $event.preventDefault()">
    <form @submit.prevent="submit">
      <div class="modal-head">
        <h2>{{ title }}</h2>
        <button type="button" class="icon-button" :disabled="busy" aria-label="关闭" @click="close">
          <X :size="20" />
        </button>
      </div>

      <p v-if="current.state === 'completed' && current.kind === 'delivery'" class="disposition-copy">
        确认将“{{ current.label }}”标记为已完成？其关联的生成、评测与修复记录将一并从“在列”收起，历史报告与费用记录完整保留。
      </p>
      <p v-else-if="current.state === 'completed' && current.kind === 'resource'" class="disposition-copy">
        确认将“{{ current.label }}”标记为已完成？该资源将从默认资源列表中收起，可随时在“已完成”筛选中查看或恢复。
      </p>
      <p v-else-if="current.state === 'discarded' && current.kind === 'delivery'" class="disposition-copy">
        确认舍弃“{{ current.label }}”？该生成站任务将移入“已舍弃”，<strong>不影响所属资源</strong>，历史报告与费用账单继续保留。
      </p>
      <p v-else-if="current.state === 'discarded' && current.kind === 'resource'" class="disposition-copy">
        确认将“{{ current.label }}”标记为已舍弃？该资源将移入“已舍弃”，后续仍可移回在列。
      </p>
      <p v-else class="disposition-copy">
        确认将“{{ current.label }}”移回“在列”列表继续管理？
      </p>

      <label v-if="current.canCascadeResources && current.state === 'completed'" class="disposition-check">
        <input v-model="cascadeResources" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时将所属资源标记为已完成</strong>
          <span>表示该资源已完成复刻/交付；同一资源下其余未归档的已停止旧尝试将自动收起为“已舍弃”。</span>
        </div>
      </label>

      <label v-if="current.canCascadeResources && current.state === 'active'" class="disposition-check">
        <input v-model="cascadeResources" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时将所属资源移回在列</strong>
          <span>资源库中也一并恢复到“在列”视图。</span>
        </div>
      </label>

      <label v-if="current.canCascadeDeliveries && current.state === 'discarded'" class="disposition-check">
        <input v-model="cascadeDeliveries" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时收起该资源下未归档的生成站任务</strong>
          <span>将已停止或排队中的关联任务一并移入“已舍弃”，避免任务中心残留孤儿任务。</span>
        </div>
      </label>

      <label v-if="current.canCascadeDeliveries && current.state === 'completed'" class="disposition-check">
        <input v-model="cascadeDeliveries" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时将关联生成站标记为已完成</strong>
          <span>将该资源下对应的在列生成站一并归入“已完成”。</span>
        </div>
      </label>

      <label v-if="current.canCascadeDeliveries && current.state === 'active'" class="disposition-check">
        <input v-model="cascadeDeliveries" type="checkbox" :disabled="busy" />
        <div>
          <strong>同时将关联的已完成生成站移回在列</strong>
          <span>此前单独标记为“已舍弃”的废站仍保持收起。</span>
        </div>
      </label>

      <div v-if="current.state !== 'active'" class="field disposition-note-field">
        <span>{{ current.state === 'discarded' ? '原因或备注（可选）' : '备注（可选）' }}</span>
        <div v-if="current.state === 'discarded'" class="disposition-presets" role="group" aria-label="常用舍弃原因">
          <button
            v-for="preset in discardReasonPresets"
            :key="preset"
            type="button"
            class="disposition-preset"
            :class="{ active: note.trim() === preset }"
            :disabled="busy"
            @click="togglePreset(preset)"
          >
            {{ preset }}
          </button>
        </div>
        <input
          v-model="note"
          class="input"
          maxlength="500"
          :disabled="busy"
          :placeholder="current.state === 'discarded' ? '可不填，如：测试环境已销毁、首版效果太差重做' : '可不填，如：已确认验收'"
        />
      </div>

      <p v-if="error" class="alert error" role="alert">{{ error }}</p>

      <div class="modal-actions">
        <button type="button" class="button secondary" :disabled="busy" @click="close">取消</button>
        <button
          class="button"
          :class="current.state === 'discarded' ? 'danger' : 'primary'"
          :disabled="busy"
        >
          <LoaderCircle v-if="busy" class="spin" :size="16" />
          <Check v-else-if="current.state === 'completed'" :size="16" />
          <Trash2 v-else-if="current.state === 'discarded'" :size="16" />
          <RotateCcw v-else :size="16" />
          {{ confirmLabel }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.disposition-copy {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.disposition-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  margin: 0 0 14px;
  border-radius: 10px;
  background: var(--field);
  cursor: pointer;
}
.disposition-check input {
  margin-top: 3px;
  flex: none;
}
.disposition-check div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.disposition-check strong {
  font-size: 13px;
  font-weight: 600;
}
.disposition-check span {
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.disposition-note-field {
  margin-bottom: 14px;
}
.disposition-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.disposition-preset {
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line, #dfe5ef);
  background: #fff;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.disposition-preset:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
}
.disposition-preset.active {
  background: #e9effd;
  border-color: #9bb4f2;
  color: var(--blue);
  font-weight: 500;
}
.button.danger {
  background: var(--red, #cf4c5a);
  color: #fff;
}
.button.danger:hover:not(:disabled) {
  background: #b94250;
}
.button.danger:disabled {
  background: var(--field);
  color: var(--muted);
}
</style>
