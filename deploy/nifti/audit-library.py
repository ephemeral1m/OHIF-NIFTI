"""Read-only recovery audit. Run while the NIfTI service is stopped.

Usage: python audit-library.py /path/to/nifti_images
Reports incomplete/orphaned transactions; never deletes or repairs medical data.
"""
import json
import sqlite3
import shutil
import sys
import tempfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
# SQLite may need to recreate its shared-memory index when a stopped WAL database
# is mounted read-only. Recover a temporary copy; never write to the real volume.
audit_copy = tempfile.TemporaryDirectory(prefix='nifti-audit-')
for suffix in ['', '-wal', '-shm']:
    source = root / ('index.sqlite3' + suffix)
    if source.exists(): shutil.copyfile(source, Path(audit_copy.name) / source.name)
if not (Path(audit_copy.name) / 'index.sqlite3').is_file():
    raise SystemExit('No NIfTI index exists at the selected volume path.')
db = sqlite3.connect(Path(audit_copy.name) / 'index.sqlite3')
report = {'integrity': db.execute('PRAGMA integrity_check').fetchone()[0], 'missing': [], 'orphaned': []}
expected = set()
for identity, metadata in db.execute('SELECT id,metadata FROM sources'):
    meta = json.loads(metadata)
    file = root / identity / ('source.' + meta['format'])
    expected.add(file)
    if not file.is_file(): report['missing'].append(str(file.relative_to(root)))
for source, identity, version in db.execute('SELECT source,id,version FROM masks'):
    for name in ['mask.nii.gz', 'metadata.json']:
        file = root / source / 'masks' / identity / str(version) / name
        expected.add(file)
        if not file.is_file(): report['missing'].append(str(file.relative_to(root)))
for file in root.rglob('*'):
    if file.is_file() and file not in expected and not file.name.startswith('index.sqlite3'):
        report['orphaned'].append(str(file.relative_to(root)))
db.close()
audit_copy.cleanup()
print(json.dumps(report, indent=2))
raise SystemExit(0 if report['integrity'] == 'ok' and not report['missing'] and not report['orphaned'] else 1)
