import { randomUUID } from 'node:crypto';
import type { UpdateRelease, UpdateSource } from '../../shared/update.js';

export interface UpdateTransport {
  root?: string;
  request(method: 'prepare' | 'apply' | 'blocked' | 'cancel', payload?: { source?: UpdateSource; release?: UpdateRelease; message?: string }): Promise<void>;
  prepared(handler: () => void): void;
  close(): void;
}
export class LauncherBridge implements UpdateTransport {
  readonly root = process.connected && process.env.EVALUATOR_MANAGED_LAUNCHER === '1' ? process.env.EVALUATOR_INSTALL_ROOT : undefined;
  private callbacks = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private onPrepared?: () => void;
  private listener = (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
    const message = raw as { type: string; requestId?: string; error?: string };
    if (message.type === 'update:prepared') this.onPrepared?.();
    if (message.type === 'update:reply' && message.requestId) {
      const call = this.callbacks.get(message.requestId); if (!call) return;
      clearTimeout(call.timer); this.callbacks.delete(message.requestId);
      message.error ? call.reject(new Error(message.error)) : call.resolve();
    }
  };
  constructor() { if (this.root) process.on('message', this.listener); }
  request(method: 'prepare' | 'apply' | 'blocked' | 'cancel', payload = {}) {
    if (!this.root || !process.send || !process.connected) return Promise.reject(new Error('请使用带启动器的交付包，通过 npm start 启动后更新'));
    return new Promise<void>((resolve, reject) => {
      const requestId = randomUUID(), timer = setTimeout(() => { this.callbacks.delete(requestId); reject(new Error('启动器尚未确认操作，请查看更新进度')); }, 10000);
      this.callbacks.set(requestId, { resolve, reject, timer });
      process.send?.({ type: 'update:request', requestId, method, ...payload }, undefined, undefined, error => { if (error) { clearTimeout(timer); this.callbacks.delete(requestId); reject(new Error('无法连接启动器')); } });
    });
  }
  prepared(handler: () => void) { this.onPrepared = handler; }
  close() {
    process.off('message', this.listener);
    for (const call of this.callbacks.values()) { clearTimeout(call.timer); call.reject(new Error('平台正在重启')); }
    this.callbacks.clear();
  }
}
