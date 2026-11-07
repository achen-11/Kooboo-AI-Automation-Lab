/** Presentation of persisted automation events; unknown legacy messages remain ordinary records. */
export type ExecutionKind = 'system' | 'assistant' | 'tool';
export type ExecutionStatus = 'completed' | 'running' | 'failed' | 'unknown';
export type ExecutionFilter = 'all' | 'error' | ExecutionKind;
export interface ExecutionEvent { seq: number; time: number; message: string }
export interface ExecutionRecord extends ExecutionEvent {
  kind: ExecutionKind;
  status: ExecutionStatus;
  title: string;
  preview: string;
  content: string;
  command: boolean;
}
interface EventRule {
  prefix: string;
  suffix?: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  title: string;
  command?: boolean;
}

/** Only producer-owned prefixes establish a type or failure; text inside commands is never classified. */
export const executionRules: readonly EventRule[] = [
  ...['执行工具 ', '跟进工具执行 '].flatMap(prefix => [
    { prefix: prefix + 'completed：', kind: 'tool' as const, status: 'completed' as const, title: '运行命令', command: true },
    { prefix: prefix + 'failed：', kind: 'tool' as const, status: 'failed' as const, title: '运行命令', command: true },
    { prefix: prefix + 'in_progress：', kind: 'tool' as const, status: 'running' as const, title: '运行命令', command: true },
  ]),
  { prefix: '工具 ', suffix: '：failed', kind: 'tool', status: 'failed', title: '工具调用' },
  { prefix: '工具 ', suffix: '：completed', kind: 'tool', status: 'completed', title: '工具调用' },
  { prefix: '工具 ', suffix: '：in_progress', kind: 'tool', status: 'running', title: '工具调用' },
  { prefix: '工具 ', kind: 'tool', status: 'unknown', title: '工具调用' },
  { prefix: 'AI 工具失败：', kind: 'tool', status: 'failed', title: '工具调用失败' },
  { prefix: 'AI 工具 ', kind: 'tool', status: 'unknown', title: '跟进工具' },
  { prefix: 'AI 跟进未完成：', kind: 'system', status: 'failed', title: 'AI 跟进未完成' },
  { prefix: '任务已中断：', kind: 'system', status: 'failed', title: '任务已中断' },
  { prefix: 'AI 跟进：', kind: 'assistant', status: 'unknown', title: 'AI 跟进' },
  { prefix: 'AI 评测：', kind: 'assistant', status: 'unknown', title: 'AI 评测' },
  { prefix: 'AI 决策：', kind: 'assistant', status: 'unknown', title: 'AI 决策' },
  { prefix: 'AI 已安排 ', kind: 'assistant', status: 'unknown', title: 'AI 决策' },
];

export function executionRecord(event: ExecutionEvent): ExecutionRecord {
  const rule = executionRules.find(rule => event.message.startsWith(rule.prefix) && (!rule.suffix || event.message.endsWith(rule.suffix)));
  const content = rule ? event.message.slice(rule.prefix.length, rule.suffix ? -rule.suffix.length : undefined).trimStart() : event.message;
  const preview = content.replace(/\s+/g, ' ').trim();
  return { ...event, kind: rule?.kind || 'system', status: rule?.status || 'unknown', title: rule?.title || '流程记录',
    command: rule?.command || false, content, preview: preview.length > 240 ? preview.slice(0, 240) + '…' : preview };
}

export interface ExecutionHead { taskId: string; latestSeq: number; total: number }
/** Minimal workflow shape also supports existing generation/evaluation pairs. */
export interface ExecutionTaskScope {
  id: string;
  kind: 'generation' | 'evaluation';
  evaluationTaskId?: string | null;
  optimizationRound?: number;
  optimization?: { rounds: { generationTaskId: string; evaluationTaskId?: string | null }[] };
}
export function executionTaskIds(task: ExecutionTaskScope): string[] {
  return [...new Set([task.id, ...(task.evaluationTaskId ? [task.evaluationTaskId] : []), ...(task.optimization?.rounds.flatMap(round => [round.generationTaskId, ...(round.evaluationTaskId ? [round.evaluationTaskId] : [])]) || [])])];
}
export function executionTaskLabel(task: ExecutionTaskScope, root: ExecutionTaskScope): string {
  return root.optimization && task.id === root.id ? '总流程' : (task.optimizationRound ? `修复 ${task.optimizationRound}` : '初始') + ' · ' + (task.kind === 'generation' ? '生成' : '评测');
}
export interface ExecutionPage extends ExecutionHead {
  snapshotSeq: number;
  pageSize: number;
  hasOlder: boolean;
  items: ExecutionRecord[];
  related: { id: string; label: string }[];
}

export const executionKindNames: Record<ExecutionKind, string> = { system: '流程', assistant: 'AI 消息', tool: '工具' };
export const executionStatusNames: Record<ExecutionStatus, string> = { completed: '已完成', running: '运行中', failed: '失败', unknown: '已记录' };
