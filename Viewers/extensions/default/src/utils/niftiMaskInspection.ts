export type BinaryMaskInspection = {
  buffer?: Uint8Array;
  maskHash: string;
  nonZeroVoxels: number;
};

type InspectBinaryMaskSlicesOptions = {
  sliceCount: number;
  getSlice: (sliceIndex: number) => ArrayLike<number>;
  segmentIndex: number;
  flipped: boolean;
  includeBuffer: boolean;
  allowEmpty?: boolean;
  yieldEverySlices?: number;
  yieldToMainThread?: () => Promise<void>;
};

async function defaultYieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as any).scheduler;
  if (typeof scheduler?.yield === 'function') {
    await scheduler.yield();
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

export async function inspectBinaryMaskSlices({
  sliceCount,
  getSlice,
  segmentIndex,
  flipped,
  includeBuffer,
  allowEmpty = false,
  yieldEverySlices = 16,
  yieldToMainThread = defaultYieldToMainThread,
}: InspectBinaryMaskSlicesOptions): Promise<BinaryMaskInspection> {
  if (sliceCount <= 0) {
    throw new Error('No labelmap slices found for this segmentation');
  }

  let nonZeroVoxels = 0;
  let sliceLength = 0;
  let buffer: Uint8Array | undefined;
  let hash = 0x811c9dc5;

  for (let outputSliceIndex = 0; outputSliceIndex < sliceCount; outputSliceIndex++) {
    const sourceSliceIndex = flipped ? sliceCount - outputSliceIndex - 1 : outputSliceIndex;
    const source = getSlice(sourceSliceIndex);

    if (!sliceLength) {
      sliceLength = source.length;
      if (includeBuffer) {
        buffer = new Uint8Array(sliceCount * sliceLength);
      }
    } else if (source.length !== sliceLength) {
      throw new Error('Inconsistent labelmap slice sizes');
    }

    const outputOffset = outputSliceIndex * sliceLength;
    for (let voxelIndex = 0; voxelIndex < source.length; voxelIndex++) {
      const value = source[voxelIndex] === segmentIndex ? 1 : 0;
      nonZeroVoxels += value;
      if (buffer) {
        buffer[outputOffset + voxelIndex] = value;
      }
      hash ^= value;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    if (
      yieldEverySlices > 0 &&
      outputSliceIndex + 1 < sliceCount &&
      (outputSliceIndex + 1) % yieldEverySlices === 0
    ) {
      await yieldToMainThread();
    }
  }

  if (!sliceLength) {
    throw new Error('No labelmap voxels found for this segmentation');
  }
  if (nonZeroVoxels === 0 && !allowEmpty) {
    throw new Error('Segment mask is empty');
  }

  return {
    buffer,
    maskHash: `${sliceCount * sliceLength}:${hash.toString(16).padStart(8, '0')}`,
    nonZeroVoxels,
  };
}
