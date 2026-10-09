// Independent masks all use label index 1. Assign a palette per mask, not per label index.
export const MASK_PALETTE = [
  [0, 190, 235, 255], [255, 180, 45, 255], [190, 110, 245, 255],
  [75, 210, 135, 255], [245, 110, 155, 255], [80, 135, 255, 255],
  [220, 225, 80, 255], [245, 130, 60, 255], [100, 220, 210, 255],
  [225, 160, 230, 255], [180, 205, 245, 255], [220, 185, 135, 255],
];
export function validColor(value) {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && value[3] === 255;
}
export function initialMaskColor(key, used = []) {
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const available = MASK_PALETTE.filter(color => !used.some(other => other?.slice(0, 3).every((n, i) => n === color[i])));
  const palette = available.length ? available : MASK_PALETTE;
  return [...palette[hash % palette.length]];
}
