<script setup lang="ts">
import type { CompletenessSettings } from '../../../shared/completeness';
import type { HarnessSettingBinding } from '../../../shared/harness';
import Disclosure from './Disclosure.vue';
defineProps<{ binding?: HarnessSettingBinding; resetBusy?: boolean }>();
const emit = defineEmits<{ reset: [] }>();
const model=defineModel<CompletenessSettings>({required:true});
</script>
<template><section class="panel settings-panel"><h2>全站交付</h2><label class="check-label"><input v-model="model.enabled" type="checkbox" />新建全站任务时建立交付清单并审核完整度</label><div class="form-grid"><label class="field"><span>每个任务的清单规划 token 预算</span><input v-model.number="model.maxTokens" class="input" type="number" min="1000" max="1000000000" /></label><label class="field"><span>规划活动时间（分钟）</span><input v-model.number="model.maxMinutes" class="input" type="number" min="1" max="30" /></label><label class="field"><span>规划最多模型请求</span><input v-model.number="model.maxRequests" class="input" type="number" min="1" max="200" /></label></div><p class="text-muted small-text">规划预算独立记录。评测时会重新核查来源，可补充遗漏项；必交付范围不能缩减。来源或实现无法确认时，保留未验证状态。首页任务不按全站清单扣分。</p><Disclosure label="清单规划 SOP"><div v-if="binding" class="harness-sop-bar"><span class="status-badge" :class="binding.customized ? 'pending' : 'completed'">{{ binding.customized ? '当前使用自定义规则' : binding.migratedLegacy ? '已自动同步至新版内置' : '使用新版内置 Harness' }}</span><div class="harness-sop-actions"><a class="text-action" href="#/harness">查看 AI 蓝图</a><button v-if="binding.customized" type="button" class="text-action" :disabled="resetBusy" @click="emit('reset')">恢复为新版内置</button></div></div><textarea v-model="model.sop" class="input" rows="12" /></Disclosure></section></template>
<style scoped>.harness-sop-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px}.harness-sop-actions{display:flex;align-items:center;gap:12px}</style>
