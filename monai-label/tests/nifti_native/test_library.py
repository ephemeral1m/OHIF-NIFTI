import gzip
import os
from pathlib import Path
import nibabel as nib
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from monailabel.endpoints import nifti_images
from test_format import phantom


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('NIFTI_IMAGES_DIR', str(tmp_path / 'library'))
    monkeypatch.setenv('ENABLE_NIFTI_LIBRARY', 'true')
    monkeypatch.setenv('ENABLE_NIFTI_EDITING', 'true')
    app = FastAPI()
    app.include_router(nifti_images.router)
    with TestClient(app) as client:
        yield client


def upload(client, path):
    return client.post('/nifti-images', files={'file': (path.name, path.read_bytes())})


def test_original_persistence_deduplication_and_bad_upload(client, tmp_path):
    path = tmp_path / 'image.nii'
    phantom(path)
    response = upload(client, path)
    assert response.status_code == 200, response.text
    source = response.json()
    gz = tmp_path / 'image.nii.gz'
    gz.write_bytes(gzip.compress(path.read_bytes()))
    assert upload(client, gz).json()['sourceId'] == source['sourceId']
    assert client.get('/nifti-images').json()['total'] == 1
    assert client.get('/nifti-images/' + source['sourceId'] + '/file').content == path.read_bytes()
    path.write_bytes(b'broken')
    assert upload(client, path).status_code == 422
    assert client.get('/nifti-images').json()['total'] == 1
    assert not list(nifti_images.root().glob('.upload-*'))
    # Reopen the database connection / file independent of the upload handler.
    assert nifti_images.get_source(source['sourceId'])['contentHash'] == source['contentHash']


def test_multi_label_versions_and_export(client, tmp_path):
    source_file = tmp_path / 'source.nii'
    phantom(source_file)
    source = upload(client, source_file).json()
    img = nib.load(source_file)
    labels = np.zeros(img.shape, dtype=np.uint16)
    labels[0, 0, 0] = 300
    labels[1, 1, 1] = 900
    mask_file = tmp_path / 'labels.nii.gz'
    nib.save(nib.Nifti1Image(labels, img.affine, img.header), mask_file)
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    response = client.post(url, data={'geometryHash': source['geometryHash'], 'label': 'lesion'}, files={'file': (mask_file.name, mask_file.read_bytes())})
    assert response.status_code == 200, response.text
    masks = response.json()['items']
    assert {m['originalLabel'] for m in masks} == {300, 900}
    for m in masks:
        raw = client.get(url + '/' + m['maskId']).content
        testfile = tmp_path / 'roundtrip.nii.gz'
        testfile.write_bytes(raw)
        actual = nib.load(testfile).get_fdata()
        np.testing.assert_array_equal(actual, labels == m['originalLabel'])
        seed = (labels == m['originalLabel']).astype(np.uint8).transpose(2, 1, 0).tobytes()
        fields = {'geometryHash': source['geometryHash'], 'raw': 'true', 'maskId': m['maskId'], 'expectedVersion': '1', 'label': 'lesion / target'}
        saved = client.post(url, data=fields, files={'file': ('seed.bin', seed)}).json()['items'][0]
        assert saved['version'] == 2
        assert saved['name'] == 'lesion / target'
        assert client.post(url, data=fields, files={'file': ('seed.bin', seed)}).status_code == 409
    assert client.get('/nifti-images/' + source['sourceId'] + '/export').status_code == 200


def test_feature_gates_and_controlled_paths(client, monkeypatch):
    assert client.get('/nifti-images/not-a-server-id/metadata').status_code == 404
    monkeypatch.setenv('ENABLE_NIFTI_LIBRARY', 'false')
    assert client.get('/nifti-images').status_code == 404


def test_file_offload_uses_only_registered_library_path(client, tmp_path, monkeypatch):
    path = tmp_path / 'image.nii'
    phantom(path)
    source = upload(client, path).json()
    monkeypatch.setenv('NIFTI_ACCEL_REDIRECT_PREFIX', '/_nifti-files')
    response = client.get('/nifti-images/' + source['sourceId'] + '/file')
    assert response.headers['x-accel-redirect'] == '/_nifti-files/' + source['sourceId'] + '/source.nii'
    assert response.content == b''
    assert 'image.nii' in response.headers['content-disposition']


def test_failed_multi_mask_transaction_leaves_no_partial_record(client, tmp_path, monkeypatch):
    original = tmp_path / 'original.nii'
    phantom(original)
    source = upload(client, original).json()
    image = nib.load(original)
    labels = np.zeros(image.shape, dtype=np.uint16)
    labels[0, 0, 0], labels[1, 1, 1] = 300, 900
    path = tmp_path / 'masks.nii.gz'
    nib.save(nib.Nifti1Image(labels, image.affine, image.header), path)
    real_write = nifti_images.write_mask
    count = 0
    def fail_second(*args):
        nonlocal count
        count += 1
        if count == 2:
            raise OSError('simulated disk failure')
        return real_write(*args)
    monkeypatch.setattr(nifti_images, 'write_mask', fail_second)
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    with pytest.raises(OSError, match='simulated disk failure'):
        client.post(url, data={'geometryHash': source['geometryHash']}, files={'file': ('masks.nii.gz', path.read_bytes())})
    assert client.get(url).json()['items'] == []
    assert not list((nifti_images.root() / source['sourceId'] / 'masks').rglob('mask.nii.gz'))


def test_orphan_version_is_never_overwritten(client, tmp_path):
    path = tmp_path / 'source.nii'
    data, _ = phantom(path)
    source = upload(client, path).json()
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    fields = {'geometryHash': source['geometryHash'], 'raw': 'true', 'labelOnly': 'true'}
    seed = bytes(data.size)
    first = client.post(url, data=fields, files={'file': ('mask.bin', seed)}).json()['items'][0]
    orphan = nifti_images.root() / source['sourceId'] / 'masks' / first['maskId'] / '2'
    orphan.mkdir()
    (orphan / 'uncommitted').write_text('preserve for audit')
    fields.update(maskId=first['maskId'], expectedVersion='1')
    reply = client.post(url, data=fields, files={'file': ('mask.bin', seed)})
    assert reply.status_code == 200, reply.text
    assert reply.json()['items'][0]['version'] == 3
    assert (orphan / 'uncommitted').read_text() == 'preserve for audit'
