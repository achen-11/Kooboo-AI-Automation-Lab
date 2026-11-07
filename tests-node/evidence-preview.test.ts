import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonFor, evidenceImages, evidenceLabel } from '../frontend/src/lib/evidence-preview.js';
import type { MaterialFile } from '../shared/automation.js';

const image = (name: string, role?: MaterialFile['role'], viewport?: MaterialFile['viewport']): MaterialFile => ({ id: name, name, role, viewport, type: 'image/png', size: 1, sha256: 'a'.repeat(64) });

test('issue preview retains citation order, omits unavailable/non-image files and never borrows unrelated evidence', () => {
  const target = image('target.png', 'target', 'desktop'), reference = image('reference.png', 'reference', 'desktop');
  const json = { ...image('observation.json'), type: 'application/json' };
  const artifacts = [reference, json, target];
  const scoped = evidenceImages(artifacts, ['target.png', 'missing.png', 'observation.json', 'target.png']);
  assert.deepEqual(scoped, [target]);
  assert.equal(comparisonFor(scoped, target), null);
  assert.deepEqual(evidenceImages(artifacts, ['target.png', 'reference.png']), [target, reference]);
});

test('comparison keeps the clicked image on the correct side and only uses the same viewport', () => {
  const target = image('target.png', 'target', 'desktop'), clicked = image('clicked.png', 'reference', 'desktop');
  const other = image('other.png', 'reference', 'desktop'), mobile = image('mobile.png', 'reference', 'mobile');
  const files = [target, other, mobile, clicked];
  assert.deepEqual(comparisonFor(files, clicked), { reference: clicked, target });
  assert.equal(comparisonFor([target, mobile], target), null);
  assert.equal(comparisonFor([image('unknown.png'), target], image('unknown.png')), null);
  assert.equal(comparisonFor([image('content.png', 'content', 'desktop'), target], image('content.png', 'content', 'desktop')), null);
  assert.equal(comparisonFor([image('legacy.png', 'reference'), image('legacy-target.png', 'target')], image('legacy.png', 'reference')), null);
});

test('evidence labels distinguish the site and viewport without guessing missing metadata', () => {
  assert.equal(evidenceLabel(image('ref.png', 'reference', 'desktop'), 0), '参考站 · PC · 证据 1');
  assert.equal(evidenceLabel(image('target.png', 'target', 'mobile'), 1), '生成站 · 移动端 · 证据 2');
  assert.equal(evidenceLabel(image('unknown.png'), 2), '截图 · 证据 3');
});
