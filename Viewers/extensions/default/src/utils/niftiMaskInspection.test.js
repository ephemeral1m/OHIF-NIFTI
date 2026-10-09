import { inspectBinaryMaskSlices } from './niftiMaskInspection';

function legacyInspect(slices, segmentIndex, flipped) {
  const ordered = flipped ? [...slices].reverse() : slices;
  const buffer = new Uint8Array(ordered.length * ordered[0].length);
  let hash = 0x811c9dc5;
  let nonZeroVoxels = 0;

  ordered.forEach((slice, sliceIndex) => {
    slice.forEach((value, voxelIndex) => {
      const binaryValue = value === segmentIndex ? 1 : 0;
      buffer[sliceIndex * slice.length + voxelIndex] = binaryValue;
      nonZeroVoxels += binaryValue;
      hash ^= binaryValue;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    });
  });

  return {
    buffer,
    maskHash: `${buffer.length}:${hash.toString(16).padStart(8, '0')}`,
    nonZeroVoxels,
  };
}

describe('inspectBinaryMaskSlices', () => {
  const slices = [
    new Uint8Array([0, 2, 1, 2]),
    new Uint8Array([2, 0, 2, 0]),
    new Uint8Array([0, 0, 0, 2]),
  ];

  test.each([false, true])('matches the legacy payload and hash when flipped=%s', async flipped => {
    const expected = legacyInspect(slices, 2, flipped);
    const actual = await inspectBinaryMaskSlices({
      sliceCount: slices.length,
      getSlice: index => slices[index],
      segmentIndex: 2,
      flipped,
      includeBuffer: true,
      yieldEverySlices: 0,
    });

    expect(actual.maskHash).toBe(expected.maskHash);
    expect(actual.nonZeroVoxels).toBe(expected.nonZeroVoxels);
    expect(actual.buffer).toEqual(expected.buffer);
  });

  test('does not allocate an output buffer for dirty inspection', async () => {
    const result = await inspectBinaryMaskSlices({
      sliceCount: slices.length,
      getSlice: index => slices[index],
      segmentIndex: 2,
      flipped: false,
      includeBuffer: false,
      yieldEverySlices: 0,
    });

    expect(result.buffer).toBeUndefined();
    expect(result.maskHash).toBe(legacyInspect(slices, 2, false).maskHash);
  });

  test('keeps the empty-mask safety rule and stable hash', async () => {
    const emptySlices = [new Uint8Array(4), new Uint8Array(4)];
    const options = {
      sliceCount: emptySlices.length,
      getSlice: index => emptySlices[index],
      segmentIndex: 1,
      flipped: false,
      includeBuffer: false,
      yieldEverySlices: 0,
    };

    await expect(inspectBinaryMaskSlices(options)).rejects.toThrow('Segment mask is empty');
    const allowed = await inspectBinaryMaskSlices({ ...options, allowEmpty: true });
    expect(allowed.nonZeroVoxels).toBe(0);
    expect(allowed.maskHash).toBe(legacyInspect(emptySlices, 1, false).maskHash);
  });

  test('yields at the requested slice interval', async () => {
    const yieldToMainThread = jest.fn().mockResolvedValue(undefined);
    await inspectBinaryMaskSlices({
      sliceCount: slices.length,
      getSlice: index => slices[index],
      segmentIndex: 2,
      flipped: false,
      includeBuffer: false,
      yieldEverySlices: 1,
      yieldToMainThread,
    });

    expect(yieldToMainThread).toHaveBeenCalledTimes(slices.length - 1);
  });
});
