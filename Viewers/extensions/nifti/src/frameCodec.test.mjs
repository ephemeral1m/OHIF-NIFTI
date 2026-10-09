import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeFrame } from './frameCodec.mjs';

test('gzip restores all scalar types and packed float32 without intensity scaling', async () => {
  for (const Type of [Uint8Array, Int8Array, Uint16Array, Int16Array, Float32Array]) {
    const dtype = new Map([[Uint8Array,'u1'],[Int8Array,'i1'],[Uint16Array,'u2'],[Int16Array,'i2'],[Float32Array,'f4']]).get(Type);
    const pixels = new Type([0,12,100]); const raw=Buffer.from(pixels.buffer);
    const frame={bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')};
    const restored=await decodeFrame(new Blob([gzipSync(raw)]),dtype,dtype,frame);
    assert.deepEqual(new Uint8Array(restored.buffer),new Uint8Array(pixels.buffer));
    if(Type===Int16Array) assert.deepEqual([...await decodeFrame(new Blob([gzipSync(raw)]),'i2','f4',frame)], [...pixels]);
  }
});
test('rejects wrong hash, truncation, and excess decompressed data', async () => {
  const raw=Buffer.from([1,2,3,4]), good={bytes:4,sha256:createHash('sha256').update(raw).digest('hex')};
  await assert.rejects(decodeFrame(new Blob([gzipSync(raw)]),'u1','u1',{...good,sha256:'0'.repeat(64)}));
  await assert.rejects(decodeFrame(new Blob([gzipSync(raw).subarray(0,10)]),'u1','u1',good));
  await assert.rejects(decodeFrame(new Blob([gzipSync(Buffer.alloc(100))]),'u1','u1',good));
});
