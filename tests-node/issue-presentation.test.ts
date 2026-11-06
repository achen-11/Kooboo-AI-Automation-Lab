import test from 'node:test';
import assert from 'node:assert/strict';
import { presentedIssues, presentedHealth } from '../shared/issue-presentation.js';
import type { Issue } from '../shared/types.js';

const diagnostic: Issue = { severity: 'major', dimension: 'health', title: '图片未完整加载',
  detail: '2 张未完成，0 张损坏', evidence: ['target-desktop-top'],
  capture: { role: 'target', viewport: 'desktop', stage: '采集检查' } };
const visible: Issue = { severity: 'major', dimension: 'health', title: '图片未完整加载',
  detail: '服务区右侧出现破图图标，图片内容缺失', evidence: ['target-desktop-middle'] };

test('historical count warnings are hidden while visual findings retain original action indices', () => {
  const issues = [diagnostic, visible, { ...diagnostic, dimension: 'reference-assets' }];
  const original = structuredClone(issues);
  assert.deepEqual(presentedIssues(issues), [{ issue: visible, index: 1 }]);
  assert.deepEqual(issues, original);
  assert.equal(presentedIssues([{ ...diagnostic, capture: undefined }]).length, 0);
});

test('only health warnings caused exclusively by old image counts are cleared for display', () => {
  assert.equal(presentedHealth({ health: 'warning', issues: [diagnostic] }), 'ok');
  assert.equal(presentedHealth({ health: 'warning', issues: [diagnostic, visible] }), 'warning');
  assert.equal(presentedHealth({ health: 'warning', issues: [] }), 'warning');
  for (const health of ['critical', 'unknown', 'ok'] as const)
    assert.equal(presentedHealth({ health, issues: [diagnostic] }), health);
});
