"""Run on vanilla. Read existing credentials without printing them."""
import json
import os
from pathlib import Path
import subprocess

directory = Path(__file__).resolve().parent
inspect = json.loads(subprocess.check_output(['docker', 'inspect', 'monai_sam2']))[0]
allowed = {'MONAI_LABEL_DICOMWEB_USERNAME', 'MONAI_LABEL_DICOMWEB_PASSWORD'}
lines = [entry for entry in inspect['Config']['Env'] if entry.split('=', 1)[0] in allowed]
if len(lines) != 2:
    raise RuntimeError('Existing DICOM credentials were not found.')
path = directory / 'runtime.env'
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    stream.write('\n'.join(lines) + '\n')
os.chmod(path, 0o600)
print('Test runtime environment prepared; credentials not displayed.')
