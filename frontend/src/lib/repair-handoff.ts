import type { RepairPayload, RepairReceipt, RepairTarget } from '../../../shared/issue-actions.js';

/** A receipt acknowledges queue acceptance, never successful implementation. */
export function connectRepairWindow(popup: Window, target: RepairTarget, payload: RepairPayload, onReceipt: (receipt: RepairReceipt) => void): () => void {
  let finished = false;
  function stop(): void { window.removeEventListener('message', receive); clearTimeout(timeout); clearInterval(probe); }
  function finish(receipt: RepairReceipt): void { if (finished) return; finished = true; stop(); onReceipt(receipt); }
  function receive(event: MessageEvent): void {
    const data = event.data;
    if (event.source !== popup || event.origin !== target.origin || !data || data.id !== payload.id || data.siteId !== payload.siteId) return;
    if (data.type === 'site-evaluator:ready') popup.postMessage(payload, target.origin);
    if (data.type === 'site-evaluator:receipt' && typeof data.accepted === 'boolean' && (!data.accepted || typeof data.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(data.sessionId))) {
      finish({ type: data.type, id: payload.id, siteId: payload.siteId, accepted: data.accepted, sessionId: data.sessionId, error: typeof data.error === 'string' ? data.error.slice(0, 300) : undefined });
    }
  }
  window.addEventListener('message', receive);
  const timeout = setTimeout(() => finish({ type: 'site-evaluator:receipt', id: payload.id, siteId: payload.siteId, accepted: false, error: 'unknown' }), 120000);
  const probe = setInterval(() => { if (popup.closed) finish({ type: 'site-evaluator:receipt', id: payload.id, siteId: payload.siteId, accepted: false, error: 'unknown' }); }, 1000);
  return stop;
}
