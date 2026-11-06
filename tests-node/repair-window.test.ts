import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRepairWindow } from '../frontend/src/lib/repair-handoff.js';
import type { RepairPayload, RepairReceipt, RepairTarget } from '../shared/issue-actions.js';
const target: RepairTarget = { environmentId: 'env', environmentName: 'fixture', origin: 'https://admin.test', siteId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', siteName: 'fixture' };
const payload: RepairPayload = { type: 'site-evaluator:repair', version: 1, id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', siteId: target.siteId, text: '修复', images: [] };
function fixture() {
  const original = globalThis.window;
  const listeners = new Set<(event: MessageEvent) => void>();
  globalThis.window = { addEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.add(handler), removeEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.delete(handler) } as unknown as Window & typeof globalThis;
  const posted: unknown[][] = [], popup = { closed: false, postMessage: (...args: unknown[]) => posted.push(args) } as unknown as Window;
  const receipts: RepairReceipt[] = [];
  const stop = connectRepairWindow(popup, target, payload, r => receipts.push(r));
  function emit(data: unknown, origin = target.origin, source: unknown = popup) { for (const fn of [...listeners]) fn({ data, origin, source } as MessageEvent); }
  return { popup, receipts, posted, listeners, emit, close() { stop(); globalThis.window = original; } };
}
test('sender transfers only to bound popup origin after exact nonce/site handshake; receipt means queued', () => {
  const f = fixture();
  try {
    const ready = { type: 'site-evaluator:ready', id: payload.id, siteId: payload.siteId };
    f.emit(ready, 'https://evil.test'); f.emit(ready, target.origin, {}); f.emit({ ...ready, id: 'wrong' }); f.emit({ ...ready, siteId: 'wrong' });
    assert.equal(f.posted.length, 0);
    f.emit(ready); f.emit(ready);
    assert.equal(f.posted.length, 2); assert.deepEqual(f.posted[0], [payload, target.origin]);
    const receipt = { type: 'site-evaluator:receipt', id: payload.id, siteId: payload.siteId, accepted: true, sessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' };
    f.emit({ ...receipt, sessionId: '' }); assert.equal(f.receipts.length, 0);
    f.emit(receipt); f.emit(receipt);
    assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].accepted, true); assert.equal(f.listeners.size, 0);
  } finally { f.close(); }
});
test('closed popup and receiver timeout produce uncertain delivery and dispose listeners', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let f = fixture();
  try {
    (f.popup as { closed: boolean }).closed = true; t.mock.timers.tick(1000);
    assert.equal(f.receipts[0].error, 'unknown'); assert.equal(f.listeners.size, 0);
  } finally { f.close(); }
  f = fixture();
  try {
    t.mock.timers.tick(120001);
    assert.equal(f.receipts[0].error, 'unknown'); assert.equal(f.listeners.size, 0);
  } finally { f.close(); }
});
