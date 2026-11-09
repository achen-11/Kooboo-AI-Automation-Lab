import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AutomationStore } from './automation/store.js';

/** Only control messages cross IPC. Task data and secrets stay in the existing stores. */
export class BackgroundWorkers {
  private child?: ChildProcess;
  private owned = new Set<string>();
  private exited?: Promise<void>;
  private stopping?: Promise<void>;
  private ready = false;
  private failed = false;
  constructor(private directory: string, readonly store: AutomationStore, private entry?: URL) {}

  async start() {
    if (this.child) return;
    const compiled = new URL('./background-entry.js', import.meta.url);
    const entry = this.entry || (existsSync(compiled) ? compiled : new URL('./background-entry.ts', import.meta.url));
    const child = this.child = fork(fileURLToPath(entry), [this.directory], {
      // A source checkout needs tsx; never inherit a test runner or inspector port.
      execArgv: entry.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.exited = new Promise(resolve => child.once('close', () => {
      this.ready = false;
      this.owned.clear();
      if (!this.stopping) this.failed = true;
      resolve();
    }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台执行服务未能及时就绪')), 30000);
      timer.unref();
      const fail = () => { clearTimeout(timer); reject(new Error('后台执行服务启动失败')); };
      child.once('error', fail);
      child.once('exit', fail);
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'ownership' && 'ids' in message && Array.isArray(message.ids)) {
          this.owned = new Set(message.ids.filter((id): id is string => typeof id === 'string'));
        }
        if (message.type === 'ready') {
          clearTimeout(timer);
          child.removeListener('error', fail);
          child.removeListener('exit', fail);
          this.ready = true;
          resolve();
        }
      });
    });
    // An error after startup must not become an unhandled process error.
    child.on('error', () => { this.failed = true; });
  }

  get healthy() { return this.ready && !this.failed; }
  cancel(id: string) { if (this.child?.connected) this.child.send({ type: 'cancel', id }, () => {}); }
  owns(id: string) {
    if (!this.child?.connected || this.failed) return false;
    if (this.owned.has(id)) return true;
    // A claim is committed before the executor can publish its first IPC update.
    const header = this.store.header(id);
    if (header && (!header.stopped || header.delivery?.stopped === false)) return true;
    return this.store.db.prepare("SELECT id FROM auto_learning_runs WHERE id=? AND status='running'").get(id) !== undefined;
  }
  async stop() {
    if (!this.child || !this.exited) return;
    if (!this.stopping) {
      this.stopping = this.exited;
      if (this.child.connected) this.child.send({ type: 'stop' }, () => {});
    }
    await this.stopping;
  }
}
