"""Deterministic, asymmetric synthetic acceptance data; contains no patient data.

Requires numpy and nibabel (test dependencies). The 128 MiB case is optional.
"""
import argparse
import json
from pathlib import Path
import nibabel as nib
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('output', type=Path)
parser.add_argument('--standard-128mib', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
manifest = []
cases = [('ct-oblique', (128, 160, 96), np.int16, (1., 1.2, 2.5), 'CT'),
         ('mr-anisotropic', (128, 128, 80), np.float32, (.9, .9, 2.), 'MR')]
if args.standard_128mib:
    cases.append(('ct-standard-128mib', (512, 512, 256), np.int16, (.8, .8, 1.5), 'CT'))
for name, dims, dtype, spacing, modality in cases:
    x, y, z = [np.linspace(-1, 1, n, dtype=np.float32) for n in dims]
    radius = x[:, None, None]**2 + (y[None, :, None] / .8)**2 + (z[None, None, :] / .9)**2
    raw = np.where(radius < .8, 600 + x[:, None, None]*70 + z[None, None, :]*40, 0).astype(dtype)
    # Two non-interchangeable landmarks distinguish left/right, anterior/posterior and superior/inferior.
    centers = [(int(dims[0]*.3), int(dims[1]*.4), int(dims[2]*.6)),
               (int(dims[0]*.65), int(dims[1]*.5), int(dims[2]*.35))]
    labels = np.zeros(dims, dtype=np.uint16)
    for index, center in enumerate(centers):
        box = tuple(slice(c-4-index, c+5+index) for c in center)
        raw[box] = 950 if index == 0 else 300
        labels[box] = 300 if index == 0 else 900
    angle = .3 if modality == 'CT' else -.2
    c, s = np.cos(angle), np.sin(angle)
    affine = np.eye(4)
    affine[:3, :3] = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) @ np.diag(spacing)
    affine[:3, 3] = [-70, -90, 30]
    image = nib.Nifti1Image(raw, affine)
    image.set_sform(affine, 1); image.set_qform(affine, 1)
    image.header.set_xyzt_units('mm')
    if modality == 'CT': image.header.set_slope_inter(2, -1024)
    filename = args.output / (name + '.nii.gz')
    nib.save(image, filename)
    mask = nib.Nifti1Image(labels, affine)
    mask.header.set_xyzt_units('mm')
    nib.save(mask, args.output / (name + '-labels.nii.gz'))
    manifest.append({'file': filename.name, 'modality': modality, 'dimensions': dims,
                     'voxelBytes': raw.nbytes, 'voxelLandmarks': centers,
                     'rasLandmarks': [nib.affines.apply_affine(affine, p).tolist() for p in centers],
                     'labelValues': [300, 900], 'synthetic': True})
for dtype in ['uint8', 'int8', 'uint16', 'int16', 'float32']:
    x, y, z = np.indices((32, 40, 24))
    ramp = x + 2*y + z - 60
    data = (ramp if dtype.startswith(('int', 'float')) else ramp + 60).astype(dtype)
    image = nib.Nifti1Image(data, np.diag([1., 1.5, 2., 1.]))
    image.header.set_xyzt_units('mm')
    for suffix in ['nii', 'nii.gz']:
        filename = f'scalar-{dtype}.{suffix}'
        nib.save(image, args.output / filename)
        manifest.append({'file': filename, 'dtype': dtype, 'dimensions': [32, 40, 24], 'synthetic': True})
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print(f'Generated {len(cases)} phantom sources with matching masks and ten scalar-format fixtures.')
