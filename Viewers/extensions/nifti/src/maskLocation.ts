import { cache } from '@cornerstonejs/core';
import { transformPoint } from './format.mjs';

export function maskLocation(source, mask) {
  if (mask.location?.revision === mask.revision) return mask.location.point;
  const occupied = [];
  for (let z = 0; z < mask.imageIds.length; z++) {
    const pixels = cache.getImage(mask.imageIds[z])?.voxelManager.getScalarData();
    if (!pixels) throw Error('Mask 缓存不完整，请重新加载。');
    if (pixels.includes(1)) occupied.push(z);
  }
  let point;
  if (occupied.length) {
    // Select an occupied plane and voxel, so hollow/disconnected targets remain visible.
    const z = occupied[Math.floor(occupied.length / 2)];
    const pixels = cache.getImage(mask.imageIds[z]).voxelManager.getScalarData();
    const width = source.descriptor.dimensions[0];
    let x = 0, y = 0, count = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] === 1) { x += i % width; y += Math.floor(i / width); count++; }
    x /= count; y /= count;
    let nearest = 0, distance = Infinity;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] === 1) {
      const d = (i % width - x) ** 2 + (Math.floor(i / width) - y) ** 2;
      if (d < distance) { distance = d; nearest = i; }
    }
    point = { slice: z, world: transformPoint(source.descriptor.voxelToLPS, [nearest % width, Math.floor(nearest / width), z]) };
  }
  mask.location = { revision: mask.revision, point };
  return point;
}
