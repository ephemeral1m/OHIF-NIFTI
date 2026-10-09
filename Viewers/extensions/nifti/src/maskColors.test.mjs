import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMaskColor, MASK_PALETTE, validColor } from './maskColors.mjs';
test('independent label-1 masks get distinct, repeatable initial colors', () => {
  const allocate = () => {
    const used = [];
    for (let i = 0; i < MASK_PALETTE.length; i++) used.push(initialMaskColor('case:target:' + i, used));
    return used;
  };
  const colors = allocate();
  assert.equal(new Set(colors.map(JSON.stringify)).size, MASK_PALETTE.length);
  assert.deepEqual(colors, allocate());
  assert(colors.every(validColor));
});
test('invalid persisted colors are rejected', () => {
  for (const c of [null, [255, 0, 0], [1, 2, 3, 0], [256, 0, 0, 255], ['1', 2, 3, 255]]) assert.equal(validColor(c), false);
});
