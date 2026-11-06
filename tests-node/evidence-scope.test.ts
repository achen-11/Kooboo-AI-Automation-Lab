import test from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence } from '../shared/types.js';
import { captureEvidenceComplete } from '../server/lib/pipeline.js';

function evidence(): Evidence {
  return {
    targetUrl: 'https://target.test/', targetTitle: 'Page', text: 'Visible page', readme: null,
    screenshots: [{ id: 'target-desktop-top', role: 'target', viewport: 'desktop', region: 'top',
      file: 'target-desktop.png', url: 'https://target.test/', capturedAt: 1, width: 1440, height: 900 }],
    health: 'ok', issues: [], fingerprint: 'a', stable: true,
    coverage: { requested: 'site', actual: 'homepage', complete: false, note: 'Static homepage' },
  };
}

test('legacy site-scope failure is never upgraded solely because screenshots exist', () => {
  const value = evidence();
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), false);
  value.coverage.captureComplete = true;
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), true);
  assert.equal(value.coverage.complete, false, 'requested site remains unfulfilled');
});

test('explicit capture completion cannot bypass diagnostic images, coverage errors or contradictory flags', () => {
  const value = evidence();
  value.coverage.captureComplete = true;
  value.screenshots[0].diagnostic = true;
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), false);
  value.screenshots[0].diagnostic = false;
  value.issues.push({ severity: 'major', dimension: 'coverage', title: 'Missing bottom', detail: 'Page height changed', evidence: ['target-desktop-top'] });
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), false);
  value.issues = [];
  value.coverage.requested = 'homepage';
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), false);
  value.coverage.complete = true;
  assert.equal(captureEvidenceComplete(value, 'target', 'desktop'), true);
});
