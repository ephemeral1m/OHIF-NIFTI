"""Record deployed identities and rollback pair without exporting credentials."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path('/home/ubuntu/ohif-ai')
release = root / 'deploy/nifti-streaming-release-20261008'

def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]

snapshot = json.loads((release / 'release.json').read_text())
receipt = {'images': snapshot, 'containers': {}, 'configurationHash': hashlib.sha256((release / 'nginx.conf').read_bytes()).hexdigest()}
for service, name in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
    container = inspect(name)
    assert container['Image'] == snapshot[service]['candidate']
    assert container['State']['Status'] == 'running'
    entry = receipt['containers'][name] = {'image': container['Image'], 'startedAt': container['State']['StartedAt'],
        'volumes': {v['Destination']: v.get('Name') for v in container['Mounts'] if v['Type'] == 'volume'}}
    if service == 'monai_sam2':
        env = dict(item.split('=', 1) for item in container['Config']['Env'])
        entry['streamingEnabled'] = env['ENABLE_NIFTI_STREAMING']
        entry['cacheMaximumBytes'] = int(env['NIFTI_STREAM_CACHE_MAX_BYTES'])
        assert entry['streamingEnabled'] == 'true'
        source = 'monai-label/monailabel/utils/others/nifti_stream.py'
        digest = subprocess.check_output(['docker', 'exec', name, 'sha256sum', '/code/monailabel/utils/others/nifti_stream.py'], text=True).split()[0]
        assert digest == hashlib.sha256((root / source).read_bytes()).hexdigest()
        entry['cacheImplementationHash'] = digest
receipt['rollbackCommand'] = 'python3 /home/ubuntu/ohif-ai/deploy/nifti/release-streaming.py rollback'
path = release / 'receipt.json'
path.write_text(json.dumps(receipt, indent=2)); os.chmod(path, 0o600)
print('Verified production image pair, backend source and streaming configuration; receipt saved.')
