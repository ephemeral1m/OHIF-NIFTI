/** NIfTI-1 native IJK storage (i fastest); physical coordinates are mm LPS.
 * Project replacement for the 3.33.5 NIfTI loader's parsing/geometry path.
 * No DICOM conversion and no voxel flip during RAS -> LPS basis conversion.
 */
export const MAX_VOXEL_BYTES = 512 * 1024 * 1024;
export const MAX_HEADER_BYTES = 1024 * 1024;
const TYPES = {
  2: [Uint8Array, 1, 'getUint8'], 256: [Int8Array, 1, 'getInt8'],
  4: [Int16Array, 2, 'getInt16'], 512: [Uint16Array, 2, 'getUint16'],
  16: [Float32Array, 4, 'getFloat32'],
};
export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
export function transformPoint(a, p) {
  return a.slice(0, 3).map(row => row[3] + row[0] * p[0] + row[1] * p[1] + row[2] * p[2]);
}
export function validateAffine(a) {
  if (!a.flat().every(Number.isFinite)) return false;
  const cols = [0, 1, 2].map(i => a.slice(0, 3).map(row => row[i]));
  const lengths = cols.map(col => Math.hypot(...col));
  if (lengths.some(v => v < 1e-8)) return false;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const dot = cols[i].reduce((s, v, k) => s + v * cols[j][k], 0);
      if (Math.abs(dot / lengths[i] / lengths[j]) > 1e-5) return false;
    }
  }
  return true;
}
export function geometryKey(dimensions, affine) {
  return dimensions.join(',') + ':' + affine.flat().map(x => Math.floor(x * 1e5 + 0.5)).join(',');
}
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
export async function contentHash(scalarData, geometryHash) {
  const hashes = [];
  for (let start = 0; start < scalarData.length; start += 1024 * 1024) {
    hashes.push(await sha256(new Float32Array(scalarData.subarray(start, start + 1024 * 1024))));
  }
  return sha256(new TextEncoder().encode(geometryHash + hashes.join('')));
}
export function parseHeader(buffer, { unit, mask = false } = {}) {
  if (buffer.byteLength < 352) fail('NIFTI_TRUNCATED', 'NIfTI header is truncated.');
  const v = new DataView(buffer);
  const little = v.getInt32(0, true) === 348;
  if (!little && v.getInt32(0, false) !== 348) fail('NIFTI_FORMAT', 'Only single-file NIfTI-1 is supported.');
  if ([344, 345, 346, 347].map(i => v.getUint8(i)).join(',') !== '110,43,49,0') {
    fail('NIFTI_FORMAT', 'Expected NIfTI-1 n+1 magic.');
  }
  const i16 = p => v.getInt16(p, little);
  const f32 = p => v.getFloat32(p, little);
  if (i16(40) !== 3 || [4, 5, 6, 7].some(i => i16(40 + i * 2) > 1)) {
    fail('NIFTI_DIMENSIONS', 'Only three-dimensional scalar images are supported.');
  }
  const dimensions = [42, 44, 46].map(i16);
  if (dimensions.some(x => x < 1)) fail('NIFTI_DIMENSIONS', 'Invalid dimensions.');
  const datatype = i16(70);
  const type = TYPES[datatype] || (mask && ({ 8: [Int32Array, 4, 'getInt32'], 768: [Uint32Array, 4, 'getUint32'] })[datatype]);
  if (!type || i16(72) !== type[1] * 8) fail('NIFTI_DATATYPE', 'Unsupported scalar type or inconsistent bitpix.');
  const count = dimensions.reduce((a, b) => a * b, 1);
  const sourceBytes = count * type[1];
  if (sourceBytes > MAX_VOXEL_BYTES) fail('NIFTI_TOO_LARGE', 'Uncompressed voxel data exceeds 512 MiB.');
  const offset = f32(108);
  if (!Number.isInteger(offset) || offset < 352 || offset > MAX_HEADER_BYTES) fail('NIFTI_OFFSET', 'Invalid or oversized extended header.');
  let slope = f32(112), intercept = f32(116);
  // NIfTI: zero / NaN slope means no scaling, including the intercept.
  if (slope === 0 || Number.isNaN(slope)) { slope = 1; intercept = 0; }
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) fail('NIFTI_SCALING', 'Non-finite intensity scaling.');
  const scaled = slope !== 1 || intercept !== 0;
  const workType = scaled ? Float32Array : type[0];
  const workingBytes = count * workType.BYTES_PER_ELEMENT;
  if (workingBytes > MAX_VOXEL_BYTES) fail('NIFTI_TOO_LARGE', 'Scaled voxel data exceeds 512 MiB.');
  const sform = i16(254) > 0 ? [0, 1, 2].map(r => [0, 1, 2, 3].map(c => f32(280 + r * 16 + c * 4))).concat([[0, 0, 0, 1]]) : null;
  let qform = null;
  if (i16(252) > 0) {
    let b = f32(256), c = f32(260), d = f32(264);
    const norm = b*b + c*c + d*d;
    let a = Math.sqrt(Math.max(0, 1 - norm));
    if (norm > 1) { const n = Math.sqrt(norm); b /= n; c /= n; d /= n; a = 0; }
    const spacing = [80, 84, 88].map(f32);
    if (spacing.some(x => !Number.isFinite(x) || x <= 0)) fail('NIFTI_AFFINE', 'Invalid qform spacing.');
    spacing[2] *= f32(76) < 0 ? -1 : 1;
    qform = [
      [a*a+b*b-c*c-d*d, 2*b*c-2*a*d, 2*b*d+2*a*c, f32(268)],
      [2*b*c+2*a*d, a*a+c*c-b*b-d*d, 2*c*d-2*a*b, f32(272)],
      [2*b*d-2*a*c, 2*c*d+2*a*b, a*a+d*d-c*c-b*b, f32(276)],
    ].map(row => row.map((x, j) => j < 3 ? x * spacing[j] : x)).concat([[0, 0, 0, 1]]);
  }
  // A coded but sheared/invalid preferred affine is not silently replaced.
  const affine = sform || qform;
  if (!affine || !validateAffine(affine)) fail('NIFTI_AFFINE', 'A trustworthy, nonsingular affine without shear is required.');
  const rawUnit = v.getUint8(123) & 7;
  const units = { 1: 'm', 2: 'mm', 3: 'um' };
  const selectedUnit = units[rawUnit] || unit;
  if (!['m', 'mm', 'um'].includes(selectedUnit)) fail('NIFTI_UNIT_REQUIRED', 'Select the spatial unit for this file: m, mm or um.');
  const factor = { m: 1000, mm: 1, um: 0.001 }[selectedUnit];
  const voxelToLPS = affine.map((row, i) => row.map(x => i < 3 ? x * factor * (i < 2 ? -1 : 1) : x));
  const warnings = [];
  if (sform && qform && (!validateAffine(qform) || sform.flat().some((x, i) => Math.abs(x - qform.flat()[i]) * factor > 1e-3))) {
    warnings.push('sform and qform disagree; sform was selected.');
  }
  if (!units[rawUnit]) warnings.push(`Unknown file units explicitly interpreted as ${selectedUnit}.`);
  return {
    dimensions, datatype, little, offset, sourceBytes, workingBytes, count,
    rawDtype: type[0].name, workingDtype: workType.name, slope, intercept,
    sform, qform, affine, selectedAffine: sform ? 'sform' : 'qform',
    originalUnit: rawUnit, unit: selectedUnit, voxelToLPS, warnings,
  };
}
export function parseNifti(buffer, options = {}) {
  const header = parseHeader(buffer, options);
  const { offset, sourceBytes, count, datatype, slope, intercept, little } = header;
  if (buffer.byteLength !== offset + sourceBytes) fail('NIFTI_LENGTH', 'Truncated or unexpected trailing voxel data.');
  const type = TYPES[datatype] || ({ 8: [Int32Array, 4, 'getInt32'], 768: [Uint32Array, 4, 'getUint32'] })[datatype];
  const Constructor = slope !== 1 || intercept !== 0 ? Float32Array : type[0];
  const scalarData = new Constructor(count);
  const view = new DataView(buffer);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = view[type[2]](offset + i * type[1], little) * slope + intercept;
    scalarData[i] = value;
    if (!Number.isFinite(scalarData[i])) fail('NIFTI_INTENSITY', 'Non-finite or overflowing scaled voxel intensity.');
    if (options.mask && (!Number.isInteger(value) || value < 0)) fail('NIFTI_LABEL', 'Masks must contain nonnegative integer labels, not probabilities.');
    if (options.mask && scalarData[i] !== value) fail('NIFTI_LABEL_PRECISION', 'Scaled label cannot be represented exactly.');
    min = Math.min(min, scalarData[i]); max = Math.max(max, scalarData[i]);
  }
  return { ...header, scalarData, min, max };
}

/** Bounded streaming decompression also handles blob URLs without suffixes. */
export async function decodeBlob(blob, options = {}, progress = () => {}, beforeAllocate = () => {}) {
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = magic[0] === 31 && magic[1] === 139;
  const stream = gzip ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob.stream();
  const reader = stream.getReader();
  let prefix = new Uint8Array(352), used = 0, full, total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let consumed = 0;
      if (!full) {
        consumed = Math.min(prefix.length - used, value.length);
        prefix.set(value.subarray(0, consumed), used); used += consumed;
        if (used === 352) {
          const h = parseHeader(prefix.buffer, options);
          // The UI ledger must approve the actual header sizes before allocating.
          await beforeAllocate(h);
          full = new Uint8Array(h.offset + h.sourceBytes);
          full.set(prefix); total = 352; prefix = null;
        }
      }
      if (full) {
        const tail = value.subarray(consumed);
        if (total + tail.length > full.length) fail('NIFTI_LENGTH', 'Unexpected data exceeds declared voxel size.');
        full.set(tail, total); total += tail.length;
        progress(total / full.length);
      }
    }
    if (!full || total !== full.length) fail('NIFTI_TRUNCATED', 'NIfTI voxel payload is truncated.');
    return { ...parseNifti(full.buffer, options), format: gzip ? 'nii.gz' : 'nii' };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
