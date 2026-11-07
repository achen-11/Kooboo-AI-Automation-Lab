import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSelectOptions, moveSelectIndex, sameSelectValue, selectMenuPlacement, selectValue } from '../frontend/src/lib/select.js';

test('select navigation skips disabled placeholders and wraps safely for empty/all-disabled lists', () => {
  const options = [{ value: '', label: '请选择', disabled: true }, { value: 0, label: '零' }, { value: 1, label: '禁用', disabled: true }, { value: 2, label: '二' }];
  assert.equal(moveSelectIndex(options, -1, 1), 1);
  assert.equal(moveSelectIndex(options, 1, 1), 3);
  assert.equal(moveSelectIndex(options, 3, 1), 1);
  assert.equal(moveSelectIndex(options, -1, -1), 3);
  assert.equal(moveSelectIndex(options, 1, -1), 3);
  assert.equal(moveSelectIndex([], -1, 1), -1);
  assert.equal(moveSelectIndex([{ value: '', label: '', disabled: true }], -1, 1), -1);
});

test('select search supports Chinese, case and full-width text while preserving group and disabled state', () => {
  const options = [{ value: 'a', label: '生产环境', group: 'Kooboo' }, { value: 'b', label: 'ＤＥＳＫＴＯＰ', disabled: true }, { value: 'c', label: '移动端', group: '截图' }];
  assert.deepEqual(filterSelectOptions(options, ' 生产 '), [options[0]]);
  assert.deepEqual(filterSelectOptions(options, 'desktop'), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, 'KOOboo'), [options[0]]);
  assert.deepEqual(filterSelectOptions(options, 'missing'), []);
  assert.deepEqual(filterSelectOptions(options, ''), options);
});

test('select values retain numeric zero, numeric modifiers and optional empty-string selections', () => {
  assert.equal(sameSelectValue(0, '0'), true); assert.equal(sameSelectValue(undefined, ''), false);
  assert.equal(selectValue('2', 0), 2); assert.equal(selectValue('2', '', true), 2);
  assert.equal(selectValue('2', ''), '2'); assert.equal(selectValue(0, ''), 0);
  assert.equal(selectValue('', 2, true), ''); assert.equal(selectValue('site', 1), 'site');
});

test('select menus stay inside narrow viewports, flip above low controls and account for a shifted visual viewport', () => {
  const narrow = selectMenuPlacement({ left: 300, top: 40, bottom: 80, width: 500 }, { width: 320, height: 640 });
  assert.equal(narrow.width, 304); assert.equal(narrow.left, 8); assert.equal(narrow.opensAbove, false);
  const low = selectMenuPlacement({ left: 750, top: 540, bottom: 580, width: 160 }, { width: 1000, height: 600 });
  assert.equal(low.opensAbove, true); assert.equal(low.maxHeight, 360); assert.ok(low.left + low.width <= 992);
  const keyboard = selectMenuPlacement({ left: 15, top: 360, bottom: 400, width: 200 }, { width: 390, height: 300, top: 200 });
  assert.equal(keyboard.opensAbove, true); assert.equal(keyboard.maxHeight, 146);
});
