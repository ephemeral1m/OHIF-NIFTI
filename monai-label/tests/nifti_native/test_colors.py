import json
import numpy as np
from test_library import client, upload
from test_format import phantom


def test_color_metadata_versions_and_legacy_preservation(client, tmp_path):
    path = tmp_path / 'source.nii'
    phantom(path)
    source = upload(client, path).json()
    pixels = np.ones(source['count'], dtype=np.uint8).tobytes()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    fields = {'geometryHash': source['geometryHash'], 'raw': 'true', 'provenance': json.dumps({'displayColor': [20, 180, 230, 255]})}
    first = client.post(url, data=fields, files={'file': ('mask.bin', pixels)})
    assert first.status_code == 200, first.text
    mask = first.json()['items'][0]
    assert mask['displayColor'] == [20, 180, 230, 255]
    fields.update(maskId=mask['maskId'], expectedVersion='1', provenance='{}')
    second = client.post(url, data=fields, files={'file': ('mask.bin', pixels)}).json()['items'][0]
    assert second['displayColor'] == mask['displayColor']
    fields.update(expectedVersion='2', provenance=json.dumps({'displayColor': [255, 175, 40, 255]}))
    third = client.post(url, data=fields, files={'file': ('mask.bin', pixels)}).json()['items'][0]
    assert third['displayColor'] == [255, 175, 40, 255]
    assert client.get(url).json()['items'][0]['displayColor'] == third['displayColor']
    assert client.get(url + '/' + mask['maskId'] + '?version=1').content == client.get(url + '/' + mask['maskId'] + '?version=3').content


def test_bad_color_does_not_commit_a_mask(client, tmp_path):
    path = tmp_path / 'source.nii'; phantom(path)
    source = upload(client, path).json()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    for color in ([0, 1, 2], [0, 1, 2, 0], [300, 1, 2, 255], [True, 1, 2, 255]):
        response = client.post(url, data={'geometryHash': source['geometryHash'], 'raw': 'true', 'provenance': json.dumps({'displayColor': color})}, files={'file': ('mask.bin', bytes(source['count']))})
        assert response.status_code == 422
    assert client.get(url).json()['items'] == []
