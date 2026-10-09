import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseNifti, decodeBlob, transformPoint } from './format.mjs';

function fixture(slope = 1, intercept = 0) {
  const bytes = new ArrayBuffer(352 + 16);
  const v = new DataView(bytes);
  v.setInt32(0, 348, true); v.setInt16(40, 3, true);
  [42, 44, 46].forEach(p => v.setInt16(p, 2, true));
  v.setInt16(70, 4, true); v.setInt16(72, 16, true);
  v.setFloat32(108, 352, true); v.setFloat32(112, slope, true); v.setFloat32(116, intercept, true);
  v.setUint8(123, 2); v.setInt16(254, 1, true);
  const affine = [[Math.sqrt(.75), 0, 2.5, 0], [0, 2, 0, 0], [-.5, 0, Math.sqrt(.75)*5, 0]];
  affine.flat().forEach((x, i) => v.setFloat32(280 + i*4, x, true));
  new Uint8Array(bytes, 344, 4).set([110, 43, 49, 0]);
  for (let i = 0; i < 8; i++) v.setInt16(352 + i*2, 100, true);
  return bytes;
}
for (const [slope, intercept, expected] of [[1,-1024,-924],[2,0,200],[2,-1024,-824],[0,500,100]]) {
  test(`scaling ${slope}/${intercept}`, () => assert.equal(parseNifti(fixture(slope, intercept)).scalarData[0], expected));
}
test('oblique slice position uses affine column, not component-wise spacing', () => {
  const p = parseNifti(fixture());
  const at = transformPoint(p.voxelToLPS, [0,0,10]);
  assert.equal(at[0], -25);
  assert.ok(Math.abs(at[2] - 43.30127) < 1e-3);
});
test('gzip detection does not use a filename', async () => {
  const p = await decodeBlob(new Blob([gzipSync(new Uint8Array(fixture()))]));
  assert.equal(p.scalarData.length, 8);
});
test('truncated compressed stream rejects without hanging', async () => {
  const compressed = gzipSync(new Uint8Array(fixture()));
  await assert.rejects(decodeBlob(new Blob([compressed.subarray(0, compressed.length - 5)])));
});

test('actual header allocation is approved before decoding, including scaled masks', async () => {
  const allocations = [];
  const parsed = await decodeBlob(new Blob([gzipSync(new Uint8Array(fixture(2, 0)))]), { mask: true }, undefined,
    async header => { allocations.push([header.offset, header.sourceBytes, header.workingBytes]); });
  assert.deepEqual(allocations, [[352, 16, 32]]);
  assert.equal(parsed.scalarData[0], 200);
});

test('rejected memory reservation aborts decompression and permits a subsequent retry', async () => {
  const file = new Blob([gzipSync(new Uint8Array(fixture()))]);
  await assert.rejects(decodeBlob(file, {}, undefined, () => { throw Error('budget refusal'); }), /budget refusal/);
  assert.equal((await decodeBlob(file)).scalarData.length, 8);
});
