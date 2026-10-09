"""Native NIfTI-1 source geometry. IJK is x-fastest; numpy is [z,y,x].

No model imports. Payload limits apply while decompressing, before allocating
the voxel array. Physical coordinates, masks and prompts use millimetre LPS.
"""
import gzip
import hashlib
import math
import struct
from pathlib import Path

import numpy as np

MAX_VOXEL_BYTES = 512 * 1024 * 1024
MAX_HEADER_BYTES = 1024 * 1024
TYPES = {2: 'u1', 256: 'i1', 4: 'i2', 512: 'u2', 16: 'f4'}


class NiftiError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise NiftiError(code, message)


def valid_affine(a):
    if not np.isfinite(a).all():
        return False
    lengths = np.linalg.norm(a[:3, :3], axis=0)
    if (lengths < 1e-8).any():
        return False
    directions = a[:3, :3] / lengths
    return np.allclose(directions.T @ directions, np.eye(3), rtol=0, atol=1e-5)


def geometry_hash(dimensions, affine):
    values = ','.join(str(math.floor(float(x) * 1e5 + 0.5)) for x in affine.flatten())
    key = ','.join(map(str, dimensions)) + ':' + values
    return hashlib.sha256(key.encode()).hexdigest()


def parse_header(raw, unit=None, mask=False):
    if len(raw) < 352:
        fail('NIFTI_TRUNCATED', 'NIfTI header is truncated.')
    endian = '<' if struct.unpack_from('<i', raw)[0] == 348 else '>'
    def get(fmt, offset):
        return struct.unpack_from(endian + fmt, raw, offset)[0]
    if get('i', 0) != 348 or raw[344:348] != b'n+1\0':
        fail('NIFTI_FORMAT', 'Only single-file NIfTI-1 is supported.')
    if get('h', 40) != 3 or any(get('h', 40 + i * 2) > 1 for i in range(4, 8)):
        fail('NIFTI_DIMENSIONS', 'Only three-dimensional scalar images are supported.')
    dims = [get('h', p) for p in (42, 44, 46)]
    if min(dims) < 1:
        fail('NIFTI_DIMENSIONS', 'Invalid dimensions.')
    datatype = get('h', 70)
    dtype_name = (TYPES | ({8: 'i4', 768: 'u4'} if mask else {})).get(datatype)
    if dtype_name is None:
        fail('NIFTI_DATATYPE', 'Unsupported scalar type.')
    dtype = np.dtype(endian + dtype_name)
    if get('h', 72) != dtype.itemsize * 8:
        fail('NIFTI_DATATYPE', 'Inconsistent bitpix.')
    count = math.prod(dims)
    size = count * dtype.itemsize
    if size > MAX_VOXEL_BYTES:
        fail('NIFTI_TOO_LARGE', 'Uncompressed voxels exceed 512 MiB.')
    offset = get('f', 108)
    if not math.isfinite(offset) or not offset.is_integer() or not 352 <= offset <= MAX_HEADER_BYTES:
        fail('NIFTI_OFFSET', 'Invalid or oversized extended header.')
    slope, intercept = get('f', 112), get('f', 116)
    if slope == 0 or math.isnan(slope):
        slope, intercept = 1., 0.
    if not math.isfinite(slope) or not math.isfinite(intercept):
        fail('NIFTI_SCALING', 'Non-finite intensity scaling.')
    scaled = slope != 1 or intercept != 0
    working_bytes = count * (4 if scaled else dtype.itemsize)
    if working_bytes > MAX_VOXEL_BYTES:
        fail('NIFTI_TOO_LARGE', 'Scaled voxels exceed 512 MiB.')
    sform = qform = None
    if get('h', 254) > 0:
        sform = np.eye(4)
        sform[:3] = [[get('f', 280 + r * 16 + c * 4) for c in range(4)] for r in range(3)]
    if get('h', 252) > 0:
        b, c, d = [get('f', p) for p in (256, 260, 264)]
        norm = b*b + c*c + d*d
        a = math.sqrt(max(0, 1 - norm))
        if norm > 1:
            b, c, d = np.array([b, c, d]) / math.sqrt(norm)
        spacing = np.array([get('f', p) for p in (80, 84, 88)])
        if not np.isfinite(spacing).all() or (spacing <= 0).any():
            fail('NIFTI_AFFINE', 'Invalid qform spacing.')
        spacing[2] *= -1 if get('f', 76) < 0 else 1
        qform = np.eye(4)
        qform[:3, :3] = np.array([
            [a*a+b*b-c*c-d*d, 2*b*c-2*a*d, 2*b*d+2*a*c],
            [2*b*c+2*a*d, a*a+c*c-b*b-d*d, 2*c*d-2*a*b],
            [2*b*d-2*a*c, 2*c*d+2*a*b, a*a+d*d-c*c-b*b],
        ]) * spacing
        qform[:3, 3] = [get('f', p) for p in (268, 272, 276)]
    affine = sform if sform is not None else qform
    if affine is None or not valid_affine(affine):
        fail('NIFTI_AFFINE', 'A trustworthy affine without shear is required.')
    raw_unit = raw[123] & 7
    known_unit = {1: 'm', 2: 'mm', 3: 'um'}.get(raw_unit)
    selected_unit = known_unit or unit
    if selected_unit not in ('m', 'mm', 'um'):
        fail('NIFTI_UNIT_REQUIRED', 'Select the spatial unit: m, mm or um.')
    factor = {'m': 1000, 'mm': 1, 'um': .001}[selected_unit]
    lps = affine.copy()
    lps[:3] *= np.array([-factor, -factor, factor])[:, None]
    warnings = []
    if sform is not None and qform is not None and (
            not valid_affine(qform) or np.max(np.abs(sform - qform)) * factor > 1e-3):
        warnings.append('sform and qform disagree; sform was selected.')
    if not known_unit:
        warnings.append(f'Unknown file units explicitly interpreted as {selected_unit}.')
    return dict(dimensions=dims, datatype=datatype, endian=endian, offset=int(offset),
                sourceBytes=size, workingBytes=working_bytes, count=count,
                rawDtype=dtype_name, workingDtype='f4' if scaled else dtype_name,
                slope=slope, intercept=intercept,
                sform=sform.tolist() if sform is not None else None,
                qform=qform.tolist() if qform is not None else None,
                affine=affine.tolist(), selectedAffine='sform' if sform is not None else 'qform',
                originalUnit=raw_unit, unit=selected_unit, voxelToLPS=lps.tolist(),
                geometryHash=geometry_hash(dims, lps), warnings=warnings)


def read_nifti(path, unit=None, mask=False):
    with open(path, 'rb') as original:
        compressed = original.read(2) == b'\x1f\x8b'
        original.seek(0)
        stream = gzip.GzipFile(fileobj=original) if compressed else original
        try:
            header_bytes = stream.read(352)
            meta = parse_header(header_bytes, unit, mask)
            extra = stream.read(meta['offset'] - 352)
            if len(extra) != meta['offset'] - 352:
                fail('NIFTI_TRUNCATED', 'Truncated extended header.')
            payload = stream.read(meta['sourceBytes'] + 1)
            if len(payload) != meta['sourceBytes']:
                fail('NIFTI_LENGTH', 'Truncated or unexpected trailing voxel data.')
        except (OSError, EOFError) as exc:
            fail('NIFTI_GZIP', f'Invalid gzip stream: {type(exc).__name__}.')
        finally:
            if compressed:
                stream.close()
    raw = np.frombuffer(payload, dtype=meta['endian'] + meta['rawDtype'])
    # Apply in float64 chunks, round once into the browser's float32 working dtype.
    data = np.empty(meta['count'], dtype=meta['workingDtype'])
    for start in range(0, len(raw), 1024 * 1024):
        end = start + 1024 * 1024
        values = raw[start:end].astype(np.float64) * meta['slope'] + meta['intercept']
        if mask and (not np.isfinite(values).all() or (values < 0).any() or (values != np.floor(values)).any()):
            fail('NIFTI_LABEL', 'Masks require nonnegative integer labels, not probabilities.')
        with np.errstate(over='ignore'):
            data[start:end] = values
        if not np.isfinite(data[start:end]).all():
            fail('NIFTI_INTENSITY', 'Non-finite or overflowing scaled voxel intensity.')
        if mask and not np.array_equal(data[start:end].astype(np.float64), values):
            fail('NIFTI_LABEL_PRECISION', 'Scaled label cannot be represented exactly.')
    meta['format'] = 'nii.gz' if compressed else 'nii'
    meta['min'], meta['max'] = float(data.min()), float(data.max())
    digest = hashlib.sha256(meta['geometryHash'].encode())
    # Canonical scaled float32 data recognizes gzip and byte-order variants.
    for start in range(0, len(data), 1024 * 1024):
        digest.update(hashlib.sha256(data[start:start + 1024 * 1024].astype('<f4').tobytes()).hexdigest().encode())
    meta['contentHash'] = digest.hexdigest()
    meta['hashVersion'] = 1
    return meta, data.reshape(tuple(reversed(meta['dimensions'])))


def align_mask(mask, mask_meta, source_meta):
    """Lossless source IJK -> mask IJK permutation; never interpolate labels."""
    a = np.asarray(mask_meta['voxelToLPS'])
    target = np.asarray(source_meta['voxelToLPS'])
    mapping = np.linalg.solve(a, target)
    rounded = np.rint(mapping)
    linear = rounded[:3, :3]
    if (not np.array_equal(np.abs(linear).sum(axis=0), [1, 1, 1]) or
            not np.array_equal(np.abs(linear).sum(axis=1), [1, 1, 1])):
        fail('NIFTI_MASK_GEOMETRY', 'Mask requires resampling or registration.')
    # Compare physical corners, not just matrix coefficients / slice counts.
    import itertools
    corners = np.array(list(itertools.product(*[(0, n - 1) for n in source_meta['dimensions']])))
    homogeneous = np.c_[corners, np.ones(8)].T
    if np.max(np.abs(a @ rounded @ homogeneous - target @ homogeneous)) > 1e-3:
        fail('NIFTI_MASK_GEOMETRY', 'Mask grid does not match source within 0.001 mm.')
    mapped = (rounded @ homogeneous)[:3]
    if not np.array_equal(mapped.min(axis=1), [0, 0, 0]) or not np.array_equal(mapped.max(axis=1), np.array(mask_meta['dimensions']) - 1):
        fail('NIFTI_MASK_GEOMETRY', 'Mask covers a different physical grid.')
    xyz = mask.transpose(2, 1, 0)
    axes = np.argmax(np.abs(linear), axis=0)
    aligned = xyz.transpose(tuple(axes))
    for axis, mask_axis in enumerate(axes):
        if linear[mask_axis, axis] < 0:
            aligned = np.flip(aligned, axis=axis)
    return np.ascontiguousarray(aligned.transpose(2, 1, 0)), rounded.astype(int).tolist()


def write_mask(path, data, meta):
    """Binary output uses the original source grid, affine and spatial units."""
    raw = bytearray(352)
    struct.pack_into('<i', raw, 0, 348)
    struct.pack_into('<8h', raw, 40, 3, *meta['dimensions'], 1, 1, 1, 1)
    struct.pack_into('<hh', raw, 70, 2, 8)
    affine = np.asarray(meta['affine'])
    struct.pack_into('<8f', raw, 76, 1., *np.linalg.norm(affine[:3, :3], axis=0), 1., 1., 1., 1.)
    struct.pack_into('<3f', raw, 108, 352., 1., 0.)
    raw[123] = {'m': 1, 'mm': 2, 'um': 3}[meta['unit']]
    struct.pack_into('<h', raw, 254, 1)
    struct.pack_into('<12f', raw, 280, *affine[:3].flatten())
    raw[344:348] = b'n+1\0'
    with gzip.open(path, 'wb') as stream:
        stream.write(raw)
        stream.write(np.ascontiguousarray(data, dtype=np.uint8).tobytes())
