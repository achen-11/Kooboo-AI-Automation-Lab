import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule } from '../server/lib/rules.js';
import rule from '../server/lib/agent-rule.js';
import { maxRuleDimensions } from '../shared/rules.js';

test('custom rule dimensions are bounded, unique and publishable only at 100% weight', () => {
  const dimensions = [{ id: 'custom-content', label: '内容完整性', weight: 100, instruction: '检查实际截图中的内容完整性' }];
  assert.deepEqual(parseRule({ ...rule, dimensions }).dimensions, dimensions);
  assert.throws(() => parseRule({ ...rule, dimensions: [] }));
  assert.throws(() => parseRule({ ...rule, dimensions: [dimensions[0], dimensions[0]] }, false), /不能重复/);
  for (const id of ['', 'Bad Id', 'a'.repeat(81)]) {
    assert.throws(() => parseRule({ ...rule, dimensions: [{ ...dimensions[0], id }] }, false));
  }
  for (const field of ['label', 'instruction']) {
    assert.throws(() => parseRule({ ...rule, dimensions: [{ ...dimensions[0], [field]: '  ' }] }, false));
  }
  const unbalanced = { ...rule, dimensions: [{ ...dimensions[0], weight: 20 }] };
  assert.equal(parseRule(unbalanced, false).dimensions[0].weight, 20);
  assert.throws(() => parseRule(unbalanced), /100%/);
  const many = Array.from({ length: maxRuleDimensions }, (_, index) => ({ ...dimensions[0], id: `custom-${index}`, weight: index ? 0 : 100 }));
  assert.equal(parseRule({ ...rule, dimensions: many }).dimensions.length, maxRuleDimensions);
  assert.throws(() => parseRule({ ...rule, dimensions: [...many, { ...dimensions[0], id: 'overflow' }] }));
});
