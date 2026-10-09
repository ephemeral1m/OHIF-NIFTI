import json
import pytest
from test_library import client, upload
from test_format import phantom


def test_history_pagination_copy_lineage_and_version_isolation(client, tmp_path):
    path = tmp_path / 'source.nii'
    phantom(path)
    source = upload(client, path).json()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    seed = bytes([1]) + bytes(source['count'] - 1)
    fields = {'geometryHash': source['geometryHash'], 'raw': 'true', 'label': 'target'}
    first = client.post(url, data=fields, files={'file': ('mask.bin', seed)}).json()['items'][0]
    before = client.get(url + '/' + first['maskId'] + '?version=1').content
    second = client.post(url, data=dict(fields, maskId=first['maskId'], expectedVersion='1'),
                         files={'file': ('mask.bin', bytes([1, 1]) + seed[2:])}).json()['items'][0]
    assert second['version'] == 2
    history = client.get(url + '/history?limit=1').json()
    assert history['total'] == 2
    assert history['items'][0]['version'] == 2
    assert client.get(url + '/history?offset=1').json()['items'][0]['version'] == 1
    assert all(m['latestVersion'] == 2 for m in client.get(url + '/history').json()['items'])
    lineage = {'maskId': first['maskId'], 'version': 1}
    copy = client.post(url, data=dict(fields, provenance=json.dumps({'derivedFrom': lineage})),
                       files={'file': ('mask.bin', seed)}).json()['items'][0]
    assert copy['maskId'] != first['maskId']
    assert copy['version'] == 1 and copy['derivedFrom'] == lineage
    assert client.get(url + '/' + first['maskId'] + '?version=1').content == before
    assert len(client.get(url).json()['items']) == 2
    assert client.get('/nifti-images/' + '0'*32 + '/masks/history').status_code == 404
    for invalid in [{'maskId': [], 'version': 1}, {'maskId': first['maskId'], 'version': True}]:
        assert client.post(url, data=dict(fields, provenance=json.dumps({'derivedFrom': invalid})),
                           files={'file': ('mask.bin', seed)}).status_code == 422
    missing = dict(lineage, version=99)
    assert client.post(url, data=dict(fields, provenance=json.dumps({'derivedFrom': missing})),
                       files={'file': ('mask.bin', seed)}).status_code == 404


def test_history_cannot_cross_source_identity(client, tmp_path):
    path = tmp_path / 'source.nii'
    phantom(path)
    source = upload(client, path).json()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    response = client.post(url, data={'geometryHash': source['geometryHash'], 'raw': 'true',
        'provenance': json.dumps({'derivedFrom': {'maskId': '0'*32, 'version': 1}})},
        files={'file': ('mask.bin', bytes([1]) + bytes(source['count'] - 1))})
    assert response.status_code == 404
    assert client.get(url + '/history').json() == {'items': [], 'total': 0}
