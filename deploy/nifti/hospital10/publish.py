"""Publish the explicitly selected anonymous CT batch as a read-only import root."""
import gzip
import hashlib
import json
import os
import struct
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()

batch = project / 'nifti-demo/hospital-10-20261008'
staging = batch / '.incoming'
expected = [f'HOSP{i:03d}.nii.gz' for i in range(1, 11)]
hashes = dict((line.split()[1], line.split()[0]) for line in (staging / 'hospital10_vanilla_sha256.txt').read_text().splitlines())
assert sorted(hashes) == expected
records = []
for name in expected:
    p = staging / name
    digest = digest_file(p)
    assert digest == hashes[name], f'Checksum mismatch: {name}'
    with gzip.open(p, 'rb') as f:
        h = f.read(352)
    assert struct.unpack_from('<i', h)[0] == 348 and h[344:348] == b'n+1\0'
    dims = struct.unpack_from('<8h', h, 40)
    dtype, bits = struct.unpack_from('<2h', h, 70)
    assert dims[0] == 3 and dtype == 16 and bits == 32
    voxel_bytes = dims[1] * dims[2] * dims[3] * bits // 8
    assert voxel_bytes <= 512 * 1024 ** 2
    records.append({'caseId': name.split('.')[0], 'image': str(batch / name), 'sha256': digest,
                    'compressedBytes': p.stat().st_size, 'voxelBytes': voxel_bytes,
                    'dimensions': list(dims[1:4]), 'dtype': 'float32', 'modality': 'CT'})
for record in records:
    p = Path(record['image'])
    if p.exists():
        assert digest_file(p) == record['sha256']
    else:
        # Keep the validated staging copy until batch verification is finished.
        os.link(staging / p.name, p)
    p.chmod(0o600)
(batch / 'inventory.json').write_text(json.dumps({'batchId': 'hospital-10-20261008', 'cases': records}, indent=2))

release = project / 'deploy/nifti-hospital10-release-20261008'
release.mkdir(exist_ok=True)
candidate = release / 'candidate.yml'
if not candidate.exists():
    config = json.loads((project / 'deploy/nifti-compact-release-20260924/candidate.yml').read_text())
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        actual = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]['Image']
        assert actual == config['services'][service]['image'], 'Deployment changed; inspect before proceeding'
    (release / 'previous.yml').write_text(json.dumps(config, indent=2))
    backend = config['services']['monai_sam2']
    roots = json.loads(backend['environment']['NIFTI_IMPORT_ROOTS'])
    if str(batch) not in roots: roots.append(str(batch))
    backend['environment']['NIFTI_IMPORT_ROOTS'] = json.dumps(roots)
    mount = f'{batch}:{batch}:ro'
    if mount not in backend['volumes']: backend['volumes'].append(mount)
    candidate.write_text(json.dumps(config, indent=2))
command = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(project / 'docker-compose.yml'),
           '-f', str(project / 'deploy/vanilla/compose.vanilla.yml'), '-f', str(candidate)]
subprocess.run(command + ['config', '--quiet'], check=True)
subprocess.run(command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2'], check=True)
print(json.dumps({'root': str(batch), 'cases': len(records), 'bytes': sum(r['compressedBytes'] for r in records),
                  'maxVoxelMiB': max(r['voxelBytes'] for r in records) // 1024 ** 2}))
