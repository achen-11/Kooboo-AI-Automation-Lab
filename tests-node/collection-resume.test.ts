import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { RequestBudget } from '../server/automation/request-budget.js';

for (const child of [false, true]) {
  test(`resuming stopped ${child ? 'child' : 'root'} collection restores optimization handoff and preserves history and charges`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'collection-resume-'));
    const f = await createApp({ directory, serveWeb: false, startWorker: false });
    try {
      const login = await f.app.inject({ method: 'POST', url: '/api/login' });
      const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
      const store = f.automationStore, settings = f.vault.automation();
      const resource = store.saveResource({ name: 'Source', scenario: 'migration', description: 'Complete source', contentUrl: 'https://source.invalid/', referenceUrl: '', externalSource: '', externalId: '', files: [] });
      const input = { resourceIds: [resource.id], environmentId: randomUUID(), kind: 'generation' as const, scope: 'site' as const, requirements: '' };
      const root = store.create({ ...input, optimization: { targetScore: 90, maxRounds: 3, maxCostCny: 20 } }, settings)[0];
      root.collectionId = randomUUID();
      const task = child ? store.create({ ...input, parentId: root.id, optimizationRootId: root.id }, settings)[0] : root;
      task.collectionId = root.collectionId;
      store.scheduleFollowup(task, settings.followup);
      Object.assign(task.followup!, { attempts: 3, tokens: 123456, elapsedMs: 789, state: 'interrupted' });
      Object.assign(task.autonomy!, { stopReason: 'collection blocked' });
      task.autonomy!.checkpoint.nextAt = 123;
      task.status = 'interrupted'; task.stopped = true;
      // A historical report must not select planning while A still needs collection.
      task.stage = 'optimization';
      const run = root.optimization!;
      run.reportId = randomUUID(); run.activeTaskId = task.id;
      run.rounds.push({ number: 1, revision: randomUUID(), generationTaskId: task.id, sourceReportId: run.reportId, startedAt: 10 });
      run.noImprovement = 1; run.state = 'stopped'; run.reason = 'collection blocked'; run.nextSteps = ['resume A']; run.stoppedAt = 100;
      if (child) store.put(task);
      store.put(root);
      const history = structuredClone(run.rounds), followup = structuredClone(task.followup), autonomy = structuredClone(task.autonomy);
      const budget = new RequestBudget(store.db, { key: 'followup:' + task.followup!.budgetId, runKey: 'historical', maxTokens: 1000000, maxRequests: 4 });
      budget.reserve('old-charge', Buffer.from('{}')); budget.complete('old-charge', { input_tokens: 500, output_tokens: 100 });
      const charges = structuredClone(budget.state());
      const response = await f.app.inject({ method: 'POST', url: `/api/automation/tasks/${task.id}/resume`, headers });
      assert.equal(response.statusCode, 200);
      const restoredRoot = store.task(root.id)!, restoredTask = store.task(task.id)!;
      assert.equal(restoredRoot.optimization!.state, 'waiting-evaluation');
      assert.equal(restoredRoot.optimization!.stoppedAt, undefined);
      assert.equal(restoredRoot.optimization!.reason, '');
      assert.deepEqual(restoredRoot.optimization!.nextSteps, []);
      assert.deepEqual(restoredRoot.optimization!.rounds, history);
      assert.equal(restoredRoot.optimization!.activeTaskId, task.id);
      assert.equal(restoredRoot.optimization!.reportId, run.reportId);
      assert.equal(restoredRoot.optimization!.noImprovement, 1);
      assert.deepEqual(restoredRoot.optimization!.policy, run.policy);
      assert.equal(restoredTask.status, 'queued');
      assert.deepEqual(restoredTask.followup, followup);
      assert.deepEqual(restoredTask.autonomy!.history, autonomy!.history);
      assert.deepEqual(restoredTask.autonomy!.window, autonomy!.window);
      assert.equal(restoredTask.autonomy!.stopReason, undefined);
      assert.equal(restoredTask.autonomy!.checkpoint.nextAt, undefined);
      assert.deepEqual(budget.state(), charges);
      assert.equal(store.tasks().length, child ? 2 : 1);
    } finally {
      await f.app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
