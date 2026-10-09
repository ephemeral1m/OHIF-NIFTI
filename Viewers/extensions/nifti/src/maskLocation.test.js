jest.mock('@cornerstonejs/core', () => ({ cache: { getImage: jest.fn() } }), { virtual: true });
jest.mock('./format.mjs', () => ({ transformPoint: (a, p) => a.slice(0, 3).map(row => row[3] + p.reduce((sum, x, i) => sum + row[i] * x, 0)) }));
import { cache } from '@cornerstonejs/core';
import { maskLocation } from './maskLocation';

test('focus selects an occupied voxel using the full affine and invalidates after edits', () => {
  const slices = [new Uint8Array(9), Uint8Array.from([1,0,0,0,0,0,0,0,1]), new Uint8Array(9)];
  cache.getImage.mockImplementation(id => ({ voxelManager: { getScalarData: () => slices[id] } }));
  const source = { descriptor: { dimensions: [3,3,3], voxelToLPS: [[0,0,-2,10],[-1,0,0,20],[0,3,0,30],[0,0,0,1]] } };
  const mask = { imageIds: [0,1,2], revision: 0 };
  expect(maskLocation(source, mask)).toEqual({ slice: 1, world: [8,20,30] });
  const calls = cache.getImage.mock.calls.length;
  maskLocation(source, mask); expect(cache.getImage.mock.calls.length).toBe(calls);
  slices[1].fill(0); mask.revision++;
  expect(maskLocation(source, mask)).toBeUndefined();
});
