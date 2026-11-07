<script setup lang="ts">
import { ref } from 'vue';
import { LoaderCircle, RefreshCw } from '@lucide/vue';
import type { FollowupRun, TaskInterruption } from '../../../../shared/automation';
import { formatDate } from '../../api';
import Disclosure from '../../components/Disclosure.vue';
import TablePagination from '../../components/TablePagination.vue';
import { useTaskSection } from './use-task-section';
const props = defineProps<{ taskId: string; updatedAt: number }>();
const page = ref(1);
const { data, loading, error, load } = useTaskSection<{ context: string; error: string; followup?: FollowupRun; interruption?: TaskInterruption; items: { seq: number; time: number; message: string }[]; total: number; page: number; pages: number }>(
  () => `/automation/tasks/${props.taskId}/sections/execution?page=${page.value}&pageSize=20`, () => page.value === 1 ? props.updatedAt : 0);
const actionNames: Record<string, string> = { retry: '重试当前阶段', continue: '继续原会话', answer: '补充待输入内容', evaluate: '交接独立评测', wait: '等待执行', interrupt: '中断并说明原因' };
</script>
<template>
  <p v-if="error" class="alert error" role="alert">{{ error }}<button class="text-action" @click="load">重试</button></p>
  <p v-if="loading && !data" class="section-loading"><LoaderCircle class="spin" :size="17" />正在加载执行记录…</p>
  <template v-if="data">
    <section v-if="data.interruption" class="panel settings-panel task-section-stack"><h2>中断详情</h2><p class="task-prose">{{ data.interruption.reason }}</p><div><h3>下一步</h3><ul class="task-text-list"><li v-for="step in data.interruption.nextSteps" :key="step">{{ step }}</li></ul></div><p class="text-muted task-prose">{{ data.interruption.resumeFrom }}</p><Disclosure v-if="data.interruption.attempted.length" label="已尝试的处理"><ol class="task-text-list"><li v-for="(attempt, index) in data.interruption.attempted" :key="index">{{ attempt }}</li></ol></Disclosure></section>
    <section v-else-if="data.error" class="panel settings-panel"><h2>阶段异常</h2><p class="task-prose">{{ data.error }}</p></section>
    <section v-if="data.followup" class="panel settings-panel task-section-stack"><div class="section-heading"><h2>AI 跟进</h2><span class="text-muted small-text">{{ data.followup.attempts }} / {{ data.followup.policy.maxAttempts }} 次</span></div><p class="text-muted">累计执行 {{ Math.round(((data.followup.elapsedMs || 0) + (data.followup.activeElapsedMs || 0)) / 1000) }} 秒 / {{ data.followup.policy.maxMinutes }} 分钟预算</p><template v-if="data.followup.lastAction"><h3>{{ actionNames[data.followup.lastAction.action] }}</h3><p class="task-prose">{{ data.followup.lastAction.reason }}</p></template><Disclosure label="跟进策略与诊断标识"><p class="text-muted small-text">跟进预算仅计 AI 跟进实际执行时间，生成与独立评测另行计时。</p><pre class="task-technical">{{ data.followup.policy.sop }}</pre><p class="text-muted small-text">会话：{{ data.followup.threadId || '尚未建立' }}</p></Disclosure></section>
    <section class="panel settings-panel"><div class="section-heading"><h2>执行日志</h2><button class="icon-button" :disabled="loading" aria-label="刷新执行记录" @click="load"><RefreshCw :size="17" /></button></div><ol class="execution-log" :aria-busy="loading"><li v-for="event in data.items" :key="event.seq"><time>{{ formatDate(event.time) }}</time><pre>{{ event.message }}</pre></li></ol><p v-if="!data.items.length" class="text-muted">暂无执行记录</p><TablePagination :page="data.page" :pages="data.pages" :total="data.total" :busy="loading" @change="page = $event" /></section>
    <section v-if="data.context" class="panel settings-panel"><Disclosure label="最近会话上下文"><pre class="task-technical">{{ data.context }}</pre></Disclosure></section>
  </template>
</template>
