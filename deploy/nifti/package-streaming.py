"""Package this release without dependency trees, clinical files or credentials."""
from pathlib import Path
import hashlib
import json
import tarfile

root = Path(__file__).resolve().parents[2]
paths = [
    'deploy/nifti/README.md', 'deploy/nifti/browser-acceptance.cjs', 'deploy/nifti/display-acceptance.cjs',
    'Viewers/extensions/cornerstone/src/commandsModule.ts',
    'Viewers/extensions/cornerstone/src/services/ViewportService/CornerstoneViewportService.ts',
    'Viewers/extensions/default/src/commandsModule.ts',
    'Viewers/extensions/default/src/utils/nnInteractiveController.ts',
    'Viewers/extensions/nifti/jest.config.js',
    'Viewers/platform/app/public/config/nifti.js',
    'monai-label/monailabel/endpoints/nifti_images.py',
    'monai-label/monailabel/utils/others/nifti_stream.py',
    'monai-label/tests/nifti_native/test_stream.py',
    'deploy/nifti/compose.test.yml', 'deploy/nifti/nginx.test.conf',
    'deploy/nifti/viewer.Dockerfile', 'deploy/nifti/backend.Dockerfile',
]
paths += [p.relative_to(root).as_posix() for p in (root / 'Viewers/extensions/nifti/src').iterdir() if p.is_file()]
paths += [p.relative_to(root).as_posix() for p in (root / 'deploy/nifti').glob('*streaming*') if p.is_file()]
out = root / 'release-artifacts/nifti-streaming-20261008'
out.mkdir(exist_ok=True, parents=True)
records = {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in sorted(set(paths))}
with tarfile.open(out / 'update.tar.gz', 'w:gz') as archive:
    for p in records:
        archive.add(root / p, arcname=p, recursive=False)
(out / 'files.json').write_text(json.dumps(records, indent=2))
print(f'Packaged {len(records)} source/configuration files.')
