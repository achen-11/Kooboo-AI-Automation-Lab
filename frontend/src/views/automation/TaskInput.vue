<script setup lang="ts">
import { LoaderCircle, ArrowUpRight } from '@lucide/vue';
import type { AutomationRule, InputVersion, OptimizationPolicy } from '../../../../shared/automation';
import TaskLearning from '../../components/TaskLearning.vue';
import TaskManifest from '../../components/TaskManifest.vue';
import Disclosure from '../../components/Disclosure.vue';
import { useTaskSection } from './use-task-section';
import { scopeName } from './common';
const props = defineProps<{ taskId: string; resourceId: string; scope: string }>();
const { data, loading, error, load } = useTaskSection<{ message: string; version?: InputVersion; rule: AutomationRule | null; threadId: string; rootDomain?: string; model: { name: string; endpoint: string } | null; optimization?:{policy:OptimizationPolicy} }>(() => `/automation/tasks/${props.taskId}/sections/input`);
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载输入与配置…</p>
  <template v-if="data">
    <section v-if="data.optimization" class="panel settings-panel"><h2>优化配置快照</h2><dl class="task-facts"><div><dt>双端目标</dt><dd>{{data.optimization.policy.targetScore}} 分</dd></div><div><dt>最多修复</dt><dd>{{data.optimization.policy.maxRounds}} 轮</dd></div><div><dt>费用上限</dt><dd>{{data.optimization.policy.maxCostCny===null?'未设置':'¥ '+data.optimization.policy.maxCostCny}}</dd></div></dl><Disclosure label="优化 SOP"><pre class="task-technical">{{data.optimization.policy.sop}}</pre></Disclosure></section>
    <section class="panel settings-panel"><div class="section-heading"><h2>本轮输入</h2><a class="text-action" :href="`#/resources/${resourceId}`">查看资源<ArrowUpRight :size="14" /></a></div><dl class="task-facts"><div><dt>输入版本</dt><dd>{{ data.version ? '版本 ' + data.version.revision : '暂无版本信息' }}</dd></div><div><dt>任务范围</dt><dd>{{ scopeName(scope) }}</dd></div><div v-if="data.version?.contentUrl"><dt>内容站</dt><dd><a :href="data.version.contentUrl" target="_blank" rel="noopener noreferrer">{{ data.version.contentUrl }}</a></dd></div><div v-if="data.version?.referenceUrl"><dt>参考站</dt><dd><a :href="data.version.referenceUrl" target="_blank" rel="noopener noreferrer">{{ data.version.referenceUrl }}</a></dd></div></dl><Disclosure label="完整委托消息"><pre class="task-technical">{{ data.message }}</pre></Disclosure><Disclosure v-if="data.version?.files.length" :label="'资料清单（' + data.version.files.length + '）'"><ul class="task-text-list"><li v-for="file in data.version.files" :key="file.id">{{ file.name }}</li></ul></Disclosure></section>
    <section v-if="data.rule" class="panel settings-panel"><h2>评测规则快照</h2><p class="task-prose">{{ data.rule.name }}</p><div v-for="criterion in data.rule.criteria" :key="criterion.id" class="version-entry"><strong>{{ criterion.label }} · {{ criterion.weight }}%{{ criterion.required ? ' · 必过项' : '' }}</strong><p>{{ criterion.instruction }}</p></div><Disclosure label="评测 SOP"><pre class="task-technical">{{ data.rule.sop }}</pre></Disclosure><Disclosure v-if="data.rule.references" label="评测参考资料"><pre class="task-technical">{{ data.rule.references }}</pre></Disclosure><Disclosure label="版本标识"><p class="task-prose">{{ data.rule.hash }}</p></Disclosure></section>
    <TaskManifest :task-id="taskId" />
    <TaskLearning :task-id="taskId" mode="input" />
    <section class="panel settings-panel"><Disclosure label="执行配置与标识"><dl class="task-facts"><div v-if="data.rootDomain"><dt>建站根域名</dt><dd>{{ data.rootDomain }}</dd></div><div><dt>模型</dt><dd>{{ data.model?.name || '尚未固定' }}</dd></div><div><dt>任务 ID</dt><dd>{{ taskId }}</dd></div><div><dt>输入版本 ID</dt><dd>{{ data.version?.id || '—' }}</dd></div><div><dt>执行会话</dt><dd>{{ data.threadId || '尚未建立' }}</dd></div></dl></Disclosure></section>
  </template>
</template>
