import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continuousSlices, pairOptions, relatedIssues, roleShots, scopedShots, selectPair, selectShot } from '../shared/comparison.js';
import { stageDuration } from '../frontend/src/lib/stage-duration.js';
import type { Pairing, Selection } from '../shared/comparison.js';
import type { Issue, Run, Screenshot } from '../shared/types.js';

function screenshot(id: string, role: Screenshot['role'], pageY: number, viewport: Screenshot['viewport'] = 'desktop'): Screenshot {
  return { id, role, pageY, viewport, region: id, file: `${id}.png`, width: viewport === 'desktop' ? 1440 : 390, height: 900, url: 'https://example.test/', capturedAt: 1 };
}
const shots = [screenshot('r1', 'reference', 0), screenshot('r2', 'reference', 810), screenshot('r3', 'reference', 1620), screenshot('t1', 'target', 0), screenshot('t2', 'target', 810), screenshot('t3', 'target', 1620), screenshot('rm', 'reference', 0, 'mobile'), screenshot('tm', 'target', 0, 'mobile')];
const pairs: Pairing[] = [
  { name: '头部', reference: ['r1'], target: ['t1'] },
  { name: '首屏', reference: ['r1'], target: ['t1'] },
  { name: '介绍', reference: ['r2', 'r3'], target: ['t3'] },
  { name: '移动首屏', reference: ['rm'], target: ['tm'] },
];
const initial: Selection = { reference: 'r1', target: 't1', pairIndex: 0 };

test('linked switching follows semantic pairing instead of the same tile index or y', () => {
  const next = selectShot(initial, 'reference', 'r2', shots, pairs, 'desktop', true);
  assert.equal(next.reference, 'r2'); assert.equal(next.target, 't3'); assert.equal(next.pairIndex, 2);
  const reverse = selectShot(initial, 'target', 't3', shots, pairs, 'desktop', true);
  assert.equal(reverse.reference, 'r2'); assert.equal(reverse.target, 't3');
});

test('unlinked navigation never changes the opposite selection; relinking uses the active evidence', () => {
  const unlinked = selectShot(initial, 'reference', 'r3', shots, pairs, 'desktop', false);
  assert.equal(unlinked.reference, 'r3'); assert.equal(unlinked.target, 't1');
  const linked = selectShot(unlinked, 'reference', 'r3', shots, pairs, 'desktop', true);
  assert.equal(linked.reference, 'r3'); assert.equal(linked.target, 't3');
});

test('an explicit region survives when multiple regions share one screenshot', () => {
  const options = pairOptions(shots, pairs, 'desktop');
  const next = selectPair(initial, options[1], shots, 'desktop');
  assert.equal(next.pairIndex, 1);
  assert.deepEqual(selectShot(next, 'target', 't1', shots, pairs, 'desktop', true), next);
});

test('opening a secondary evidence ID does not replace it with the first image in its region', () => {
  const next = selectShot(initial, 'reference', 'r3', shots, pairs, 'desktop', true);
  assert.equal(next.reference, 'r3'); assert.equal(next.target, 't3');
});

test('an unmapped tile preserves the other side instead of inventing a semantic match', () => {
  const next = selectShot(initial, 'target', 't2', shots, pairs, 'desktop', true);
  assert.equal(next.target, 't2'); assert.equal(next.reference, 'r1'); assert.equal(next.pairIndex, -1);
});

test('without regional metadata linking uses bounded sequence order and tolerates a missing side', () => {
  const partial = shots.filter(s => s.id !== 't3');
  const next = selectShot(initial, 'reference', 'r3', partial, [], 'desktop', true);
  assert.equal(next.target, 't2');
  assert.equal(selectShot(initial, 'reference', 'r3', shots.filter(s => s.role === 'reference'), [], 'desktop', true).target, '');
});

test('viewports remain isolated and invalid evidence cannot change selection', () => {
  assert.deepEqual(pairOptions(shots, pairs, 'mobile').map(p => p.index), [3]);
  assert.deepEqual(selectShot(initial, 'reference', 'rm', shots, pairs, 'desktop', true), initial);
  assert.deepEqual(roleShots(shots, 'target', 'mobile').map(s => s.id), ['tm']);
});

test('issue preview includes cited evidence and a real counterpart, never an unrelated default image', () => {
  assert.deepEqual(scopedShots(shots, ['r3'], pairs).map(s => s.id), ['r3', 't3']);
  assert.deepEqual(scopedShots(shots, ['t2'], pairs).map(s => s.id), ['t2']);
  assert.deepEqual(scopedShots(shots, ['materials'], pairs), []);
  assert.deepEqual(scopedShots(shots, ['rm'], pairs).map(s => s.id), ['rm', 'tm']);
});

test('continuous browsing trims overlap including a nearly duplicate final tile without changing originals', () => {
  const originals = [screenshot('a', 'reference', 0), screenshot('b', 'reference', 810), screenshot('c', 'reference', 900)];
  const before = structuredClone(originals), slices = continuousSlices(originals);
  assert.deepEqual(slices.map(s => ({ crop: s.cropTop, height: s.height })), [{ crop: 0, height: 900 }, { crop: 90, height: 810 }, { crop: 810, height: 90 }]);
  assert.equal(slices.reduce((sum, s) => sum + s.height, 0), 1800);
  assert.deepEqual(originals, before);
});

test('continuous browsing exposes gaps in partial issue evidence and retains images without positioning metadata', () => {
  const partial = continuousSlices([shots[0], shots[2]]);
  assert.equal(partial[1].gap, 720);
  const legacy = { ...shots[1], pageY: undefined };
  assert.equal(continuousSlices([shots[0], legacy])[1].height, 900);
  assert.equal(continuousSlices([shots[0], { ...shots[0], id: 'duplicate' }]).length, 1);
});

test('related issues follow all visible image IDs while excluding unrelated/materials-only issues', () => {
  const issues = ['r1', 'r2', 't3', 'materials'].map((id, index) => ({ title: `issue${index}`, severity: 'minor', dimension: 'layout', detail: '', evidence: [id] })) as Issue[];
  assert.deepEqual(relatedIssues(issues, ['r1', 'r2']).map(i => i.title), ['issue0', 'issue1']);
  assert.equal(relatedIssues(issues, []).length, 0);
});

test('stage timing hides Agent submission timestamps, reused or incomplete values, and zero-second artifacts', () => {
  const legacy = {} as Run, agent = { pipeline: { agent: {} } } as Run;
  const completed = { status: 'completed', startedAt: 1000, finishedAt: 39000 } as const;
  assert.equal(stageDuration(agent, completed), '');
  assert.equal(stageDuration(agent, completed, true), '38 秒');
  assert.equal(stageDuration(legacy, { ...completed, finishedAt: 1001 }), '');
  assert.equal(stageDuration(legacy, { ...completed, status: 'reused' }), '');
  assert.equal(stageDuration(legacy, { ...completed, status: 'running', finishedAt: null }), '');
  assert.equal(stageDuration(legacy, { ...completed, finishedAt: 0 }), '');
  assert.equal(stageDuration(legacy, { ...completed, finishedAt: 66000 }), '1 分 5 秒');
});

test('mixed issue evidence retains each actual paired counterpart', () => {
  const result = scopedShots(shots, ['r1', 't3'], pairs).map(s => s.id);
  for (const id of ['r1', 't1', 't3', 'r2', 'r3']) assert.ok(result.includes(id), id);
  assert.ok(!result.includes('t2'));
});
