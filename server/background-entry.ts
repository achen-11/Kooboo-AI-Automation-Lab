import { resolve } from 'node:path';
import { Store } from './lib/store.js';
import { Vault } from './lib/vault.js';
import { Artifacts } from './lib/artifacts.js';
import { Worker } from './worker.js';
import { AutomationStore } from './automation/store.js';
import { AutomationWorker } from './automation/worker.js';
import { installBackgroundFailureMonitor } from './background-diagnostics.js';

const directory = resolve(process.argv[2]);
const vault = new Vault(directory);
const store = new Store(resolve(directory, 'database.sqlite'));
const automationStore = new AutomationStore(store.db, value => {
  const settings = vault.get();
  for (const secret of [settings.model.apiKey, settings.updateSource?.token || '', ...settings.environments.flatMap(env => [env.token, env.delivery?.token || ''])]) {
    if (secret) value = value.replaceAll(secret, '[已隐藏]');
  }
  return value.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]');
});
installBackgroundFailureMonitor(directory,value=>automationStore.sanitize(value));
const worker = new Worker(store, vault, new Artifacts(store.db, resolve(directory, 'artifacts')), directory);
const automationWorker = new AutomationWorker(automationStore, vault, directory);
const send = (message: unknown) => { if (process.connected) process.send?.(message, undefined, undefined, () => {}); };
automationWorker.onOwnershipChanged = () => send({ type: 'ownership', ids: automationWorker.ownedIds() });
let stopping: Promise<void> | undefined;
function stop() {
  return stopping ||= (async () => {
    await Promise.all([worker.stop(), automationWorker.stop()]);
    store.close();
    process.exit(0);
  })();
}
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'cancel' && 'id' in message && typeof message.id === 'string') {
    const reqId = 'reqId' in message && typeof message.reqId === 'string' ? message.reqId : undefined;
    void automationWorker.cancel(message.id).finally(() => {
      if (reqId) send({ type: 'cancelled', reqId, ids: automationWorker.ownedIds() });
    });
  }
  if (message.type === 'stop') void stop();
  if (message.type === 'quiesce' && 'id' in message) {
    // The persisted maintenance marker is already visible before this event-loop barrier.
    send({ type: 'quiesced', id: message.id, active: automationWorker.ownedIds().length + Number(worker.busy) });
  }
});
process.on('disconnect', () => { void stop(); });
for (const event of ['SIGTERM', 'SIGINT'] as const) process.on(event, () => { void stop(); });
automationWorker.start();
worker.start();
send({ type: 'ready' });
