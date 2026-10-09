import json
import subprocess
from urllib.parse import urlparse

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)

container = json.loads(docker('inspect', 'ohif-nifti-test-monai_sam2-1'))[0]
for item in container['Config']['Env']:
    key, _, value = item.partition('=')
    if key in ('MONAI_LABEL_STUDIES', 'MONAI_LABEL_DICOMWEB_URL'):
        print(key, 'host:', urlparse(value).hostname)
print('entry:', container['Config']['Cmd'])
print('hash:', docker('run', '--rm', '--entrypoint', 'sha256sum', 'ohif-ai-nifti-monai:streaming-20261008', '/code/monailabel/utils/others/nifti_stream.py').strip())
