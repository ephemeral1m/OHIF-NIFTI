"""Real GPU and original-grid mask roundtrip acceptance; uses isolated test credentials from environment."""
import json
import os
import sys
import time
from pathlib import Path
import httpx
import numpy as np

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'monai-label'))
from monailabel.utils.others.nifti_source import read_nifti
username = os.environ['NIFTI_TEST_USERNAME']
password = os.environ['NIFTI_TEST_PASSWORD']
base = os.environ.get('NIFTI_TEST_URL', 'http://localhost:1126')
output = Path(os.environ.get('NIFTI_TEST_OUTPUT', root / 'deploy/nifti/acceptance-results'))
output.mkdir(parents=True, exist_ok=True)
results = []
with httpx.Client(base_url=base, auth=(username, password), timeout=600, trust_env=False) as client:
    assert httpx.get(base + '/monai/nifti-images', trust_env=False).status_code == 401
    for case, modality in [('ct-demo-chest', 'CT'), ('mr-demo-frame0', 'MR')]:
        path = root / 'release-artifacts/nifti-phantoms' / (case + '.nii.gz')
        response = client.post('/monai/nifti-images', files={'file': (path.name, path.read_bytes())}, data={'modality': modality})
        response.raise_for_status()
        source = response.json()
        shape = source['dimensions'][::-1]
        c = dict(version=2, sourceType='nifti', sourceId=source['sourceId'], geometryHash=source['geometryHash'],
                 seriesUID='test-' + source['sourceId'], segmentationId='test-mask', segmentIndex=1,
                 revision=0, generation=0, requestId=case + '-1', shape=shape,
                 maskOrder=list(range(shape[0])), promptOrder=list(range(shape[0])),
                 gridConvention={'source': 'IJK', 'model': 'ZYX', 'physical': 'LPS-mm'})
        seed = np.zeros(shape, np.uint8)
        params = {'nn_context': c, 'pos_points': [[int(source['dimensions'][0]*.3), int(source['dimensions'][1]*.4), int(source['dimensions'][2]*.6)]]}
        started = time.monotonic()
        print(f'{case}: source uploaded, starting real GPU inference', flush=True)
        response = client.post('/monai/nifti-images/' + source['sourceId'] + '/infer',
                               data={'params': json.dumps(params)}, files={'nn_seed': ('mask.bin', seed.tobytes())})
        record = {'case': case, 'sourceId': source['sourceId'], 'status': response.status_code,
                  'elapsed': round(time.monotonic()-started, 3), 'synthetic': False}
        if response.status_code != 200:
            record['error'] = response.text[:2000]
        else:
            boundary = response.headers['content-type'].split('boundary=')[1]
            parts = response.content.split(('--' + boundary).encode())
            metadata = json.loads(parts[1].split(b'\r\n\r\n', 1)[1].rstrip(b'\r\n'))
            pixels = parts[2].split(b'\r\n\r\n', 1)[1][:-2]
            assert len(pixels) == seed.size
            assert max(pixels) <= 1
            record['foreground'] = sum(pixels)
            record['contextMatches'] = metadata['nn_context']['sourceId'] == source['sourceId']
            assert record['contextMatches']
            assert record['foreground'] > 0
            saved = client.post('/monai/nifti-images/' + source['sourceId'] + '/masks',
                data={'raw': 'true', 'geometryHash': source['geometryHash'], 'label': 'GPU acceptance', 'labelOnly': str(not any(pixels)).lower()},
                files={'file': ('mask.bin', pixels)})
            saved.raise_for_status()
            mask = saved.json()['items'][0]
            downloaded = client.get('/monai/nifti-images/' + source['sourceId'] + '/masks/' + mask['maskId'])
            downloaded.raise_for_status()
            out = output / (case + '-gpu-mask.nii.gz')
            out.write_bytes(downloaded.content)
            meta, restored = read_nifti(out, mask=True)
            assert restored.tobytes() == pixels
            assert meta['geometryHash'] == source['geometryHash']
            record['maskRoundtrip'] = True
        results.append(record)
        print(json.dumps(record), flush=True)
(output / 'gpu-anatomical.json').write_text(json.dumps(results, indent=2))
if any(r['status'] != 200 for r in results): raise SystemExit(1)
