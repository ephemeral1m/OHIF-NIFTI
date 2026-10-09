import { sha256 } from './format.mjs';
export const scalarTypes = { u1: Uint8Array, i1: Int8Array, u2: Uint16Array, i2: Int16Array, f4: Float32Array };
export const dtypeName = value => value.replace(/[<>=|]/g, '');

export async function decodeFrame(blob, wireDtype, workingDtype, frame) {
  const Wire = scalarTypes[dtypeName(wireDtype)], Working = scalarTypes[dtypeName(workingDtype)];
  if (!Wire || !Working || !Number.isSafeInteger(frame.bytes) || frame.bytes <= 0) throw Error('Unsupported NIfTI frame descriptor.');
  const reader = blob.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const raw = new Uint8Array(frame.bytes); let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (offset + value.length > raw.length) throw Error('NIfTI frame exceeds its declared size.');
      raw.set(value, offset); offset += value.length;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (offset !== raw.length || await sha256(raw) !== frame.sha256) throw Error('NIfTI 切片校验失败，请重试。');
  const wire = new Wire(raw.buffer);
  return Wire === Working ? wire : new Working(wire);
}
