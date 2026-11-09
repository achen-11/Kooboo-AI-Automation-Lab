import { resolve } from 'node:path';
import { createApp } from './app.js';
const port = Number(process.env.EVALUATOR_PORT || 4180);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EVALUATOR_PORT 不合法');
const { app, store, automationWorker } = await createApp({ directory: resolve(process.env.EVALUATOR_DATA_DIR || '.data'), startWorker: process.env.EVALUATOR_WORKER !== 'off' });
await app.listen({ host: '127.0.0.1', port });
console.log(`Kooboo AI Automation Lab: http://127.0.0.1:${port}`);
let closing: Promise<void> | undefined;
const close = () => { closing ||= app.close().then(() => { process.exit(0); }); return closing; };
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void close(); });
if (process.connected && process.env.EVALUATOR_MANAGED_LAUNCHER === '1') {
  const { runningVersion } = await import('./updates/files.js');
  const healthy = Object.values(store.db.prepare('PRAGMA quick_check').get() || {})[0] === 'ok' && (process.env.EVALUATOR_WORKER === 'off' || ('healthy' in automationWorker && automationWorker.healthy));
  process.send?.({ type: 'update:booted', version: runningVersion, healthy });
  process.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'update:shutdown') void close(); });
  process.on('disconnect', () => { void close(); });
}
