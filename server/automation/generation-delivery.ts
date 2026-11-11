import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GenerationDelivery, GenerationDeliverySummary } from '../../shared/generation-delivery.js';
import type { GenerationObservation } from './generation-session.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';

export class GenerationDeliveryStore {
  constructor(readonly store: AutomationStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS auto_generation_deliveries(
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS auto_generation_deliveries_task ON auto_generation_deliveries(task_id,created_at DESC);`);
  }

  get(id: string): GenerationDelivery | undefined {
    const row = this.store.db.prepare('SELECT json FROM auto_generation_deliveries WHERE id=?').get(id);
    return row ? JSON.parse(row.json) : undefined;
  }

  list(taskId: string): GenerationDeliverySummary[] {
    return this.store.db.prepare("SELECT json_remove(json,'$.text','$.answer') AS json FROM auto_generation_deliveries WHERE task_id=? ORDER BY created_at DESC,rowid DESC").all(taskId)
      .map(row => JSON.parse(row.json));
  }

  /** Persist the exact payload before entering the remote send. No regeneration on reads. */
  archive(value: GenerationDelivery) {
    if (this.get(value.id)) throw new Conflict('发送快照已存在，不能覆盖原文');
    this.store.db.prepare('INSERT INTO auto_generation_deliveries VALUES(?,?,?,?)')
      .run(value.id, value.taskId, value.createdAt, JSON.stringify(value));
  }

  private update(value: GenerationDelivery) {
    this.store.db.prepare('UPDATE auto_generation_deliveries SET json=? WHERE id=?').run(JSON.stringify(value), value.id);
  }

  sending(id: string) {
    const value = this.get(id); if (!value || value.state !== 'prepared') return;
    value.state = 'unknown'; value.attemptedAt = Date.now(); this.update(value);
  }

  /** Mark a pre-flight bridge rejection as failed only when proven never accepted on the same live page. */
  rejectPreSend(id: string, reason: string) {
    const value = this.get(id); if (!value || value.acceptedAt || !['prepared', 'unknown'].includes(value.state)) return;
    value.state = 'failed'; value.preSendRejectedError = reason; this.update(value);
  }

  accept(id: string, conversationId: string) {
    const value = this.get(id); if (!value || value.conversationId && value.conversationId !== conversationId) return;
    value.conversationId = conversationId;
    value.acceptedAt ??= Date.now();
    if (value.state === 'prepared' || value.state === 'unknown') value.state = 'accepted';
    this.update(value);
  }

  observe(state: GenerationObservation) {
    if (state.delivery?.state !== 'accepted') return;
    const value = this.get(state.delivery.id);
    if (!value || value.taskId !== state.taskId || value.siteId.toLowerCase() !== state.siteId.toLowerCase()
      || state.delivery.conversationId !== state.conversationId || value.conversationId && value.conversationId !== state.conversationId) return;
    if (value.runId && value.runId !== state.runId) return;
    const terminal = !state.running && ['completed', 'failed', 'interrupted'].includes(state.state)
      && state.outcome?.conversationId === state.conversationId && !!state.outcome.runId
      && state.outcome.runId === state.runId && state.outcome.runId !== value.previousRunId && state.outcome.status === state.state;
    if (terminal && (value.runId !== state.runId || value.state !== state.state)) {
      value.conversationId = state.conversationId; value.acceptedAt ??= Date.now();
      value.runId = state.runId; value.state = state.state as GenerationDelivery['state']; this.update(value);
    } else if (!value.acceptedAt) this.accept(value.id, state.conversationId);
  }
}

const imagePath = (directory: string, sha256: string) => {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Conflict('图片快照标识不合法');
  return resolve(directory, 'generation-delivery-images', sha256 + '.png');
};

export function archiveDeliveryImages(directory: string, images: { uri: string; mediaType: 'image/png' }[] = []): GenerationDelivery['images'] {
  return images.map(image => {
    if (!image.uri.startsWith('data:image/png;base64,')) throw new Conflict('图片快照格式不合法');
    const bytes = Buffer.from(image.uri.slice('data:image/png;base64,'.length), 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex'), path = imagePath(directory, sha256);
    mkdirSync(resolve(directory, 'generation-delivery-images'), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!readFileSync(path).equals(bytes)) throw new Conflict('图片快照校验失败');
    }
    return { sha256, size: bytes.length, mediaType: image.mediaType };
  });
}

export function readDeliveryImage(directory: string, image: GenerationDelivery['images'][number]) {
  const bytes = readFileSync(imagePath(directory, image.sha256));
  if (bytes.length !== image.size || createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Conflict('图片快照校验失败');
  return bytes;
}

/** Synchronous pre-save guards in Kooboo automation-bridge.ts before localStorage/send. */
export function isPreSendBridgeRejection(error: unknown) {
  const text = error instanceof Error ? error.message : String(error || '');
  return /(?:Invalid delivery identity|Conversation is not ready|Conversation changed|Reply to the pending call first|Missing message or pending input)/.test(text);
}
