import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskSummary } from '../shared/task-presentation.js';
import { createTaskEvaluationLoader, scoreTone, siteLink, taskEvaluation } from '../frontend/src/lib/task-list.js';

function task(id: string, kind: TaskSummary['kind'], extra: Partial<TaskSummary> = {}): TaskSummary {
  return { id, kind, resourceId: 'resource', resourceName: 'Site', scenario: 'materials', scope: 'homepage', environmentId: 'local', generatedSiteId: 'site', parentId: null,
    stage: kind, status: 'completed', stopped: true, createdAt: 1, updatedAt: 1, siteUrl: 'https://site.test', report: null, attention: '', nextStep: '', ...extra };
}
const report: NonNullable<TaskSummary['report']> = { quality: 'failed', scores: [{ viewport: 'desktop', value: 76 }, { viewport: 'mobile', value: null }], issueCount: 1, unverifiedCount: 1 };

test('generation scores come from their linked evaluation, never the most recent unrelated report', () => {
  const parent = task('parent', 'generation', { evaluationTaskId: 'review' });
  const review = task('review', 'evaluation', { report });
  const other = task('other', 'evaluation', { report: { ...report, scores: [{ viewport: 'desktop', value: 99 }] } });
  const tasks = new Map([parent, review, other].map(item => [item.id, item]));
  assert.equal(taskEvaluation(parent, tasks), review);
  assert.equal(taskEvaluation(review, tasks), review);
  assert.equal(taskEvaluation(task('no-review', 'generation'), tasks), undefined);
  assert.equal(taskEvaluation({ ...parent, generatedSiteId: 'different-site' }, tasks), undefined);
  assert.equal(taskEvaluation({ ...parent, scope: 'site' }, tasks), undefined);
  tasks.set(review.id, { ...review, report: null });
  assert.equal(taskEvaluation(parent, tasks), undefined);
});

test('a completed task keeps its own final scores when a newer task changes the same site or scope', () => {
  const review = task('homepage-review', 'evaluation', { report, reportCurrent: false });
  const parent = task('homepage', 'generation', { evaluationTaskId: review.id, optimization: { state: 'completed', policy: { targetScore: 90, maxRounds: 3, maxCostCny: null }, round: 2, activeTaskId: review.id, reportId: review.id, reason: '', nextStep: '' } });
  const newRun = task('full-site', 'generation', { scope: 'site', evaluationTaskId: 'new-review' });
  const newReview = task('new-review', 'evaluation', { scope: 'site', status: 'running' });
  const tasks = new Map([parent, review, newRun, newReview].map(item => [item.id, item]));
  assert.equal(taskEvaluation(parent, tasks), review);
  assert.equal(taskEvaluation(parent, tasks)!.reportCurrent, false);
  assert.deepEqual(taskEvaluation(parent, tasks)!.report!.scores, report.scores);
  assert.equal(taskEvaluation(newRun, tasks), undefined);
});

test('a repair in progress never presents the previous round score as the current score', () => {
  const review = task('review', 'evaluation', { report });
  const parent = task('parent', 'generation', { evaluationTaskId: review.id, optimization: { state: 'repairing', policy: { targetScore: 90, maxRounds: 3, maxCostCny: null }, round: 1, activeTaskId: 'repair', reportId: null, reason: '', nextStep: '' } });
  const tasks = new Map([[review.id, review]]);
  assert.equal(taskEvaluation(parent, tasks), undefined);
  parent.optimization!.reportId = review.id;
  assert.equal(taskEvaluation(parent, tasks), review);
});

test('hidden list scores are recovered from the compact summary once per task revision and marked as history', async () => {
  const hidden = task('review', 'evaluation'), original = { ...hidden, report };
  let requests = 0;
  const load = createTaskEvaluationLoader(async id => {
    requests++; assert.equal(id, hidden.id);
    return { task: original, evaluation: null, latest: null, currentReportId: null };
  });
  const [first, second] = await Promise.all([load(hidden), load(hidden)]);
  assert.equal(first, second); assert.equal(first!.reportCurrent, false); assert.deepEqual(first!.report!.scores, report.scores);
  assert.equal(await load(hidden), first); assert.equal(requests, 1);
  const parent = task('parent', 'generation', { evaluationTaskId: hidden.id });
  assert.deepEqual(taskEvaluation(parent, new Map([[hidden.id, first!]]))!.report!.scores, report.scores);
});

test('a result for a different revision or scope cannot fill the visible score', async () => {
  const hidden = task('review', 'evaluation');
  let requests = 0;
  const load = createTaskEvaluationLoader(async () => {
    requests++;
    return { task: { ...hidden, updatedAt: 2, report }, evaluation: null, latest: null, currentReportId: hidden.id };
  });
  assert.equal(await load(hidden), undefined);
  const result = await load({ ...hidden, updatedAt: 2 });
  assert.equal(result!.reportCurrent, true); assert.equal(requests, 2);
  const mismatch = createTaskEvaluationLoader(async () => ({ task: { ...hidden, scope: 'site', report }, evaluation: null, latest: null }));
  assert.equal(await mismatch(hidden), undefined);
});

test('a temporary summary failure can retry without requiring a server restart or task revision', async () => {
  const hidden = task('review', 'evaluation');
  let requests = 0;
  const load = createTaskEvaluationLoader(async () => {
    if (++requests === 1) throw Error('连接失败');
    return { task: { ...hidden, report }, evaluation: null, latest: null };
  });
  assert.equal(await load(hidden), undefined);
  assert.deepEqual((await load(hidden))!.report!.scores, report.scores);
  assert.equal(requests, 2);
});

test('score colors honor the target threshold and distinguish a real zero from missing verification', () => {
  assert.equal(scoreTone(80, 80), 'good'); assert.equal(scoreTone(100, 80), 'good');
  assert.equal(scoreTone(79.9, 80), 'warning'); assert.equal(scoreTone(60, 80), 'warning');
  assert.equal(scoreTone(59.9, 80), 'low'); assert.equal(scoreTone(0, 80), 'low');
  assert.equal(scoreTone(null, 80), 'unknown');
  assert.equal(scoreTone(85, 90), 'warning'); assert.equal(scoreTone(90, 90), 'good');
  assert.equal(scoreTone(55, 50), 'good');
});

test('generated site shortcuts only navigate to HTTP or HTTPS addresses', () => {
  assert.equal(siteLink('https://site.test/path?q=a&b=2'), 'https://site.test/path?q=a&b=2');
  assert.equal(siteLink('http://localhost:4180/'), 'http://localhost:4180/');
  for (const value of ['', 'not a url', 'javascript:alert(1)', 'data:text/html,test', '//site.test']) assert.equal(siteLink(value), undefined);
});
