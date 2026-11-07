import { resolve } from 'node:path';
import { createApp } from './app.js';
const port = Number(process.env.EVALUATOR_PORT || 4180);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EVALUATOR_PORT 不合法');
const { app } = await createApp({ directory: resolve(process.env.EVALUATOR_DATA_DIR || '.data'), startWorker: process.env.EVALUATOR_WORKER !== 'off' });
await app.listen({ host: '127.0.0.1', port });
console.log(`Kooboo AI Automation Lab: http://127.0.0.1:${port}`);
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void app.close().then(() => process.exit(0)); });
