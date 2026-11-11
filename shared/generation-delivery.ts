/** A historical delivery is immutable; only its receipt/ execution status changes. */
export interface GenerationDelivery {
  id: string;
  taskId: string;
  versionId: string;
  siteId: string;
  packageId?: string;
  kind: 'initial' | 'continue' | 'answer' | 'repair';
  batch?: { number: number; total: number };
  createdAt: number;
  attemptedAt?: number;
  acceptedAt?: number;
  conversationId: string;
  previousRunId?: string;
  runId?: string;
  preSendRejectedError?: string;
  state: 'prepared' | 'unknown' | 'accepted' | 'completed' | 'failed' | 'interrupted';
  text?: string;
  answer?: Record<string, unknown>;
  callId?: string;
  textBytes: number;
  images: { sha256: string; size: number; mediaType: 'image/png' }[];
}
export type GenerationDeliverySummary = Omit<GenerationDelivery, 'text' | 'answer'>;

export const generationDeliveryKinds = { initial: '初始生成', continue: '跟进', answer: '回答输入', repair: '修复' };
export const generationDeliveryStates = {
  prepared: '待发送', unknown: '发送结果待确认', accepted: '已接受',
  completed: '本轮执行结束', failed: '本轮执行失败', interrupted: '本轮执行中断',
};
