"""Run on vanilla: preserve the original source snapshot, then stage a candidate."""
import json
import hashlib
import tarfile
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-streaming-release-20261008'
release.mkdir(exist_ok=True)
files = json.loads((project / 'deploy/files.json').read_text())
before = release / 'source-before.tar.gz'
if not before.exists():
    with tarfile.open(before, 'w:gz') as archive:
        for name in files:
            path = project / name
            if path.is_file():
                archive.add(path, arcname=name, recursive=False)
with tarfile.open(project / 'deploy/update.tar.gz') as archive:
    for member in archive.getmembers():
        if not member.isfile() or not (project / member.name).resolve().is_relative_to(project.resolve()):
            raise RuntimeError('Unsafe source package member.')
    archive.extractall(project)
for name, digest in files.items():
    if hashlib.sha256((project / name).read_bytes()).hexdigest() != digest:
        raise RuntimeError('Candidate source checksum mismatch: ' + name)
print('Candidate staged; original source snapshot retained.')
