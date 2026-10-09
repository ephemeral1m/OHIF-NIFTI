"""Read-only sizing probe for native NIfTI slice delivery; no production API changes."""
import gzip
import hashlib
import json
import time
from pathlib import Path

import numpy as np
from monailabel.utils.others.nifti_source import read_nifti


path = Path('/home/ubuntu/ohif-ai/nifti-demo/hospital-10-20261008/HOSP001.nii.gz')
started = time.perf_counter()
meta, voxels = read_nifti(path)
parse_seconds = time.perf_counter() - started
exact_int16 = True
flat = voxels.reshape(-1)
for offset in range(0, flat.size, 1024 * 1024):
    values = flat[offset:offset + 1024 * 1024]
    if ((values < -32768).any() or (values > 32767).any()
            or not np.array_equal(values, values.astype('<i2').astype(values.dtype))):
        exact_int16 = False
        break

rows = []
center = voxels.shape[0] // 2
for slices in (1, 9, 17, 33):
    start = center - slices // 2
    block = voxels[start:start + slices]
    dtypes = ('<f4', '<i2') if exact_int16 else ('<f4',)
    for dtype in dtypes:
        raw = np.ascontiguousarray(block, dtype=dtype).tobytes()
        for level in (1, 6):
            tick = time.perf_counter()
            compressed = gzip.compress(raw, compresslevel=level, mtime=0)
            compression_seconds = time.perf_counter() - tick
            decoded = gzip.decompress(compressed)
            assert decoded == raw
            reconstructed = np.frombuffer(decoded, dtype=dtype).reshape(block.shape)
            assert np.array_equal(reconstructed, block)
            rows.append(dict(start=start, slices=slices, dtype=dtype,
                             rawBytes=len(raw), gzipBytes=len(compressed),
                             gzipLevel=level, compressSeconds=compression_seconds,
                             sha256=hashlib.sha256(raw).hexdigest(), roundtripExact=True))

print(json.dumps(dict(case='HOSP001', sourceBytes=path.stat().st_size,
                      dimensions=meta['dimensions'], workingDtype=str(voxels.dtype),
                      workingBytes=voxels.nbytes, parseSeconds=parse_seconds,
                      min=meta['min'], max=meta['max'], exactInt16=exact_int16,
                      geometryHash=meta['geometryHash'], contentHash=meta['contentHash'],
                      rows=rows), indent=2))
