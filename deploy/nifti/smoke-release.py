"""Post-release smoke: copy two public demo originals and verify native GPU.

Run on vanilla with MONAI_LABEL_DICOMWEB_USERNAME/PASSWORD in the environment.
It writes only original NIfTI demos to the production native library, no masks
and no DICOM/PACS annotations. Test source is 1126; production destination 1026.
"""
import json
import os
import uuid
import requests

auth = (os.environ['MONAI_LABEL_DICOMWEB_USERNAME'], os.environ['MONAI_LABEL_DICOMWEB_PASSWORD'])
client = requests.Session()
client.auth = auth
client.trust_env = False
test = 'http://127.0.0.1:1126'
production = 'http://127.0.0.1:1026'
report = {'sources': []}


def checked(response):
    response.raise_for_status()
    return response


anonymous = requests.Session()
anonymous.trust_env = False
assert anonymous.get(production + '/monai/nifti-images', timeout=30).status_code == 401
checked(client.get(production + '/nifti', timeout=30))
checked(client.get(production + '/monai/health', timeout=30))
studies = checked(client.get(production + '/pacs/dicom-web/studies', timeout=60)).json()
report['dicomStudyCount'] = len(studies)
sources = checked(client.get(test + '/monai/nifti-images', timeout=30)).json()['items']
for name, modality in [('ct-demo-chest.nii.gz', 'CT'), ('mr-demo-frame0.nii.gz', 'MR')]:
    source = next(s for s in sources if s['name'] == name)
    original = checked(client.get(test + '/monai/nifti-images/' + source['sourceId'] + '/file', timeout=120)).content
    stored = checked(client.post(production + '/monai/nifti-images',
        files={'file': (name, original)}, data={'modality': modality, 'unit': source['unit']}, timeout=120)).json()
    assert stored['contentHash'] == source['contentHash']
    downloaded = checked(client.get(production + '/monai/nifti-images/' + stored['sourceId'] + '/file', timeout=120)).content
    assert downloaded == original
    report['sources'].append({'name': name, 'sourceId': stored['sourceId'], 'originalBytes': len(original), 'downloadIdentical': True})
    if modality == 'MR':
        x, y, z = stored['dimensions']
        context = dict(version=2, sourceType='nifti', sourceId=stored['sourceId'], geometryHash=stored['geometryHash'],
            seriesUID='release-smoke', segmentationId='release-smoke', segmentIndex=1, revision=0, generation=0,
            requestId=uuid.uuid4().hex, shape=[z,y,x], maskOrder=list(range(z)), promptOrder=list(range(z)),
            gridConvention={'source':'IJK','model':'ZYX','physical':'LPS-mm'})
        result = checked(client.post(production + '/monai/nifti-images/' + stored['sourceId'] + '/infer',
            data={'params':json.dumps({'nn_context':context, 'pos_points':[[int(x*.3),int(y*.4),int(z*.6)]]})},
            files={'nn_seed':('mask.bin',bytes(x*y*z))}, timeout=180))
        boundary = result.headers['Content-Type'].split('boundary=')[1].encode()
        parts = result.content.split(b'--'+boundary)
        echo = json.loads(parts[1].split(b'\r\n\r\n',1)[1].rstrip(b'\r\n'))['nn_context']
        pixels = parts[2].split(b'\r\n\r\n',1)[1][:-2]
        assert echo['sourceId'] == stored['sourceId'] and len(pixels) == x*y*z and 0 < sum(pixels) and max(pixels) <= 1
        report['productionGPUForeground'] = sum(pixels)
report['passed'] = True
print(json.dumps(report, indent=2))
