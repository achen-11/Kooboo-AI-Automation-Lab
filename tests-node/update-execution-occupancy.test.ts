import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { atomicJson } from '../server/updates/files.js';
import { maintenancePath } from '../server/updates/maintenance.js';
import type { UpdateTransport } from '../server/updates/bridge.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for update occupancy check');
    await delay(20);
  }
}

function updater(root: string) {
  const id = randomUUID(), path = resolve(root, '.updates/state.json');
  let prepared: (() => void) | undefined;
  const messages: { method: string; message?: string }[] = [];
  const transport: UpdateTransport = {
    root, prepared(handler) { prepared = handler; }, close() {},
    async request(method, data) {
      if (method === 'apply') assert.ok(existsSync(maintenancePath(resolve(root, 'data'))));
      if (method === 'blocked') atomicJson(path, { id, phase: 'blocked', message: data?.message });
      messages.push({ method, message: data?.message });
    },
  };
  return { transport, messages, async check() {
    atomicJson(path, { id, phase: 'ready', message: '', version: '999.0.0', updatedAt: Date.now() });
    assert.ok(prepared);
    prepared();
    await until(() => messages.some(m => m.method === 'apply' || m.method === 'blocked'));
  } };
}

test('three historical unknown stops allow installation without clearing interruptions or enabling retries', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'update-historical-stops-'));
  const update = updater(root), f = await createApp({ directory: resolve(root, 'data'), serveWeb: false, updateTransport: update.transport });
  try {
    const store = f.automationStore, settings = f.vault.automation();
    const resource = store.saveResource({ name: 'Historical reviews', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
    const site = { id: randomUUID(), resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId: '', siteId: randomUUID(), name: 'Existing site', url: 'https://generated.invalid/', createdAt: Date.now() };
    store.saveSite(site);
    const tasks = Array.from({ length: 3 }, () => {
      const task = store.create({ resourceIds: [resource.id], kind: 'evaluation', scope: 'homepage', environmentId: '', generatedSiteId: site.id, requirements: '' }, settings)[0];
      task.stopped = false;
      store.interrupt(task, { reason: 'Original executor stop was not confirmed', evidence: ['retained'], attempted: [], nextSteps: ['Check original execution'], resumeFrom: 'Keep evidence' });
      assert.equal(f.automationWorker.owns(task.id), false);
      return store.task(task.id)!;
    });
    const waiting = store.create({ resourceIds: [resource.id], kind: 'evaluation', scope: 'homepage', environmentId: '', generatedSiteId: site.id, requirements: '' }, settings)[0];
    const events = tasks.map(task => store.events(task.id));
    await update.check();
    assert.deepEqual(update.messages.map(m => m.method), ['apply']);
    store.recover();
    for (const [index, task] of tasks.entries()) {
      assert.deepEqual(store.task(task.id), task, 'update checking and restart preserve unresolved stop state');
      assert.deepEqual(store.events(task.id), events[index]);
    }
    assert.equal(store.claim('evaluation', 1), undefined, 'unknown stops continue to reserve execution capacity');
    assert.equal(store.task(waiting.id)?.status, 'queued');
  } finally { await f.app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unavailable background worker keeps installation blocked instead of assuming zero executions', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'update-unavailable-worker-'));
  const update = updater(root), directory = resolve(root, 'data');
  const f = await createApp({ directory, serveWeb: false, updateTransport: update.transport });
  try {
    await f.automationWorker.stop();
    await update.check();
    assert.deepEqual(update.messages.map(m => m.method), ['blocked']);
    assert.match(update.messages[0].message || '', /后台执行服务未就绪/);
    await until(() => !existsSync(maintenancePath(directory)));
  } finally { await f.app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('installation waits for the background barrier and blocks a real owned execution', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'update-owned-execution-'));
  const update = updater(root), directory = resolve(root, 'data');
  const f = await createApp({ directory, serveWeb: false, updateTransport: update.transport, backgroundEntry: new URL('./fixtures/background-blocker.ts', import.meta.url) });
  try {
    const store = f.automationStore;
    const resource = store.saveResource({ name: 'Owned execution', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
    const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: randomUUID(), requirements: '' }, f.vault.automation())[0];
    f.vault.updateAutomation({ ...f.vault.automation(), enabled: true });
    await until(() => existsSync(resolve(directory, 'cpu-started')));
    assert.equal(f.automationWorker.owns(task.id), true);
    await update.check();
    assert.deepEqual(update.messages.map(m => m.method), ['blocked']);
    assert.match(update.messages[0].message || '', /1 项任务或操作正在执行/);
    await until(() => !existsSync(maintenancePath(directory)));
    assert.equal(store.task(task.id)?.status, 'running', 'blocked update must not cancel the task');
  } finally { await f.app.close(); rmSync(root, { recursive: true, force: true }); }
});
