import json
import uuid
from monailabel.endpoints import nifti_images
from test_library import client, upload
from test_format import phantom


def setup_masks(client, tmp_path):
    file = tmp_path / 'source.nii'
    phantom(file)
    source = upload(client, file).json()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    fields = {'geometryHash': source['geometryHash'], 'raw': 'true', 'label': 'A'}
    seed = bytes([1]) + bytes(source['count'] - 1)
    first = client.post(url, data=fields, files={'file': ('a.bin', seed)}).json()['items'][0]
    second = client.post(url, data=dict(fields, maskId=first['maskId'], expectedVersion='1', label='A renamed'),
                        files={'file': ('a.bin', bytes([1,1]) + seed[2:])}).json()['items'][0]
    other = client.post(url, data=dict(fields, label='B'), files={'file': ('b.bin', seed)}).json()['items'][0]
    return url, first, second, other


def test_individual_history_and_restore_preserve_identity_and_pixels(client, tmp_path):
    url, first, second, other = setup_masks(client, tmp_path)
    mid = first['maskId']
    history = client.get(url + '/history', params={'maskId': mid, 'limit': 1}).json()
    assert history['total'] == 2 and history['items'][0]['maskId'] == mid
    assert history['items'][0]['version'] == 2
    older = client.get(url + '/history', params={'maskId': mid, 'limit': 1, 'offset': 1}).json()
    assert older['items'][0]['version'] == 1
    original_bytes = client.get(url + '/' + mid + '?version=1').content
    order_before = [m['maskId'] for m in client.get(url).json()['items']]
    request = {'version': 1, 'expectedVersion': 2, 'requestId': str(uuid.uuid4())}
    restored = client.post(url + '/' + mid + '/restore', json=request)
    assert restored.status_code == 200, restored.text
    record = restored.json()['item']
    assert record['maskId'] == mid and record['version'] == 3
    assert record['name'] == 'A renamed' and record['restoredFrom'] == 1 and record['parentVersion'] == 2
    assert client.get(url + '/' + mid + '?version=3').content == original_bytes
    assert client.get(url + '/' + mid + '?version=1').content == original_bytes
    assert len(client.get(url).json()['items']) == 2
    assert [m['maskId'] for m in client.get(url).json()['items']] == order_before
    assert client.get(url).json()['items'][0]['versionCount'] == 3
    assert client.get(url + '/history', params={'maskId': other['maskId']}).json()['total'] == 1
    repeated = client.post(url + '/' + mid + '/restore', json=request).json()
    assert repeated['replayed'] and repeated['item']['version'] == 3
    assert client.get(url + '/history', params={'maskId': mid}).json()['total'] == 3
    assert client.post(url + '/' + mid + '/restore', json=dict(request, requestId=str(uuid.uuid4()))).status_code == 409
    assert client.post(url + '/' + mid + '/restore', json=dict(request, version=2)).status_code == 409
    assert client.get(url + '/history', params={'maskId': '0'*32}).status_code == 404
    assert client.post(url + '/' + '0'*32 + '/restore', json=request).status_code == 404


def test_restore_validation_feature_gate_and_missing_history(client, tmp_path, monkeypatch):
    url, first, _, _ = setup_masks(client, tmp_path)
    endpoint = url + '/' + first['maskId'] + '/restore'
    request = {'version': 1, 'expectedVersion': 2, 'requestId': str(uuid.uuid4())}
    assert client.post(endpoint, json=dict(request, version=True)).status_code == 422
    assert client.post(endpoint, json=dict(request, version=99)).status_code == 404
    assert client.post(endpoint, json=dict(request, version=2)).status_code == 409
    monkeypatch.setenv('ENABLE_NIFTI_EDITING', 'false')
    assert client.post(endpoint, json=request).status_code == 404


def test_restore_filesystem_failure_rolls_back_version_and_retry_record(client, tmp_path, monkeypatch):
    url, first, _, _ = setup_masks(client, tmp_path)
    request = {'version': 1, 'expectedVersion': 2, 'requestId': str(uuid.uuid4())}
    original_sync = nifti_images.sync_directory
    def fail_after_rename(path):
        if path.name == first['maskId']:
            raise OSError('simulated persistence failure')
        original_sync(path)
    monkeypatch.setattr(nifti_images, 'sync_directory', fail_after_rename)
    import pytest
    with pytest.raises(OSError, match='simulated persistence failure'):
        client.post(url + '/' + first['maskId'] + '/restore', json=request)
    assert client.get(url + '/history', params={'maskId': first['maskId']}).json()['total'] == 2
    assert not (nifti_images.root() / first['sourceId'] / 'masks' / first['maskId'] / '3').exists()
    monkeypatch.setattr(nifti_images, 'sync_directory', original_sync)
    response = client.post(url + '/' + first['maskId'] + '/restore', json=request).json()
    assert response['item']['version'] == 3 and response['replayed'] is False
