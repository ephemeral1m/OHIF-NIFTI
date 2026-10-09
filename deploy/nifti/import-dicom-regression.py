"""Import only published demo files into the isolated Orthanc service.

Run in a disposable container on ohif-nifti-test_default with /demo mounted
read-only. The hard-coded host deliberately cannot target production Orthanc.
"""
from pathlib import Path
import os
import requests

files = sorted(Path('/demo/siim/files').rglob('*.dcm'))
if not files:
    raise SystemExit('No public DICOM demo files were mounted.')
session = requests.Session()
session.trust_env = False
session.auth = (os.environ['MONAI_LABEL_DICOMWEB_USERNAME'], os.environ['MONAI_LABEL_DICOMWEB_PASSWORD'])
base = 'http://orthanc:8042'
for index, file in enumerate(files):
    response = session.post(base + '/instances', data=file.read_bytes(), timeout=60)
    response.raise_for_status()
    if (index + 1) % 100 == 0:
        print(f'{index + 1}/{len(files)} imported', flush=True)
print(session.get(base + '/statistics').text)
