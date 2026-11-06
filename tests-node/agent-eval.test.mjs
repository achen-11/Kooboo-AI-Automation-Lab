import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIMENSIONS, positions, configHash, sha256, validateConfig, validateAssessment, verifyArtifacts } from '../scripts/agent-eval-core.mjs';

function fixture() {
  const config = { target: 'https://example.com/', reference: 'https://example.org/', viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }] };
  const captures = Object.fromEntries(['target', 'reference'].flatMap(role => config.viewports.map(viewport => {
    const id = `${role}-${viewport.id}`;
    return [id, { role, viewport, status: 'captured', coverage: { complete: true }, artifacts: [{ id: `${id}-a1-full`, file: `${id}.png` }] }];
  })));
  const manifest = { config, configHash: configHash(config), captures };
  const desktop = ['target-desktop-a1-full', 'reference-desktop-a1-full'];
  const mobile = ['target-mobile-a1-full', 'reference-mobile-a1-full'];
  const assessment = { summary: 'Observed visual differences', confidence: 'medium', limitations: ['Sample only'], issues: [],
    captureReviews: Object.keys(captures).map(captureId => ({ captureId, usable: true, reason: 'Reviewed actual pixels', evidence: [`${captureId}-a1-full`] })),
    dimensions: DIMENSIONS.map((d, i) => ({ id: d.id, score: [70, 60, 80, 90, 50, 40][i], reason: 'Visible comparison', evidence: d.id === 'mobile' ? mobile : desktop })) };
  return { manifest, assessment };
}
test('continuous tiles cover the actual page, including bottom and short pages', () => {
  assert.deepEqual(positions(500, 900), [0]);
  const ys = positions(12543, 900);
  assert.equal(ys[0], 0); assert.equal(ys.at(-1), 11643);
  assert.ok(ys.every((y, i) => i === 0 || y - ys[i - 1] <= 900));
  assert.equal(positions(50000, 900, 30000).at(-1), 29100);
});
test('unsafe IDs and access-bearing URLs are rejected before capture', () => {
  const { manifest } = fixture();
  assert.throws(() => validateConfig({ ...manifest.config, target: 'https://user:secret@example.com/' }));
  assert.throws(() => validateConfig({ ...manifest.config, viewports: [{ id: '../../escape', width: 390, height: 844 }] }));
});
test('weights and total are fixed by the tool rather than supplied by the agent', () => {
  const { manifest, assessment } = fixture();
  assessment.totalScore = 100;
  assessment.dimensions[0].weight = 100;
  const result = validateAssessment(assessment, manifest);
  assert.equal(result.totalScore, 65.5);
  assert.equal(result.dimensions[0].weight, 30);
});
test('missing or incomplete coverage prohibits a full-scope score', () => {
  const { manifest, assessment } = fixture();
  manifest.captures['reference-mobile'].coverage.complete = false;
  assert.throws(() => validateAssessment(assessment, manifest), /Incomplete capture/);
  delete manifest.captures['reference-mobile'];
  assert.throws(() => validateAssessment(assessment, manifest), /Capture missing/);
});
test('invented evidence and single-sided comparison are rejected', () => {
  const { manifest, assessment } = fixture();
  assessment.dimensions[0].evidence = ['made-up'];
  assert.throws(() => validateAssessment(assessment, manifest), /Unknown or missing evidence/);
  assessment.dimensions[0].evidence = ['target-desktop-a1-full'];
  assert.throws(() => validateAssessment(assessment, manifest), /Both site roles/);
});
test('mobile score requires actual mobile evidence from both sites', () => {
  const { manifest, assessment } = fixture();
  assessment.dimensions.at(-1).evidence = ['target-desktop-a1-full', 'reference-desktop-a1-full'];
  assert.throws(() => validateAssessment(assessment, manifest), /Mobile evidence/);
});
test('full-page diagnostics cannot silently replace viewport evidence', () => {
  const { manifest, assessment } = fixture();
  manifest.captures['reference-desktop'].artifacts[0].kind = 'full';
  assert.throws(() => validateAssessment(assessment, manifest), /Diagnostic image/);
});
test('invalid, duplicate and unreviewed dimensions cannot be published', () => {
  const { manifest, assessment } = fixture();
  assessment.dimensions[0].score = NaN;
  assert.throws(() => validateAssessment(assessment, manifest), /Invalid score/);
  assessment.dimensions[0].score = 101;
  assert.throws(() => validateAssessment(assessment, manifest), /Invalid score/);
  assessment.dimensions[0].score = 70;
  assessment.captureReviews[0].usable = false;
  assert.throws(() => validateAssessment(assessment, manifest), /Usable visual review/);
});
test('changed configuration is not accepted as the original evaluation', () => {
  const { manifest, assessment } = fixture();
  manifest.config.target = 'https://other.example/';
  assert.throws(() => validateAssessment(assessment, manifest), /config changed/);
});
test('file hashing catches evidence changed after collection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-eval-test-'));
  try {
    const bytes = Buffer.alloc(32); bytes.write('89504e470d0a1a0a', 0, 'hex'); bytes.writeUInt32BE(10, 16); bytes.writeUInt32BE(20, 20);
    await writeFile(join(dir, 'shot.png'), bytes);
    const manifest = { captures: { x: { artifacts: [{ id: 'x', file: 'shot.png', sha256: sha256(bytes), width: 10, height: 20 }] } } };
    assert.deepEqual(await verifyArtifacts(manifest, dir), ['x']);
    await writeFile(join(dir, 'shot.png'), Buffer.from('modified'));
    await assert.rejects(verifyArtifacts(manifest, dir), /Artifact changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
