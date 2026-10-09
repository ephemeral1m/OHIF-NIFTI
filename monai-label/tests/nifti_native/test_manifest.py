import json
from pathlib import Path
import nibabel as nib
import numpy as np
import pytest
from test_library import client
from test_format import phantom
from monailabel.utils.others.nifti_manifest import parse_manifest, resolve_image


def test_csv_bom_quoted_paths_and_optional_columns():
    rows = parse_manifest('\ufeffimage,seg1,seg2\r\n"case, one.nii.gz",,mask.nii.gz\r\nsecond.nii,,\r\n'.encode(), 'cases.csv')
    assert rows[0]['image'] == 'case, one.nii.gz'
    assert rows[0]['segmentations'] == ['mask.nii.gz']
    assert rows[1]['segmentations'] == []


@pytest.mark.parametrize('payload', [[], {'cases': 'bad'}, [{'image': 'a.nii', 'segmentations': [1]}], [['a.nii', 'b', 'c', 'd']], [{'image': ''}]])
def test_invalid_manifests(payload):
    with pytest.raises(ValueError): parse_manifest(json.dumps(payload).encode(), 'cases.json')


def test_path_containment(tmp_path, monkeypatch):
    allowed = tmp_path / 'allowed'; allowed.mkdir()
    valid = allowed / 'image.nii'; valid.write_bytes(b'header')
    outside = tmp_path / 'outside.nii'; outside.write_bytes(b'outside')
    monkeypatch.setenv('NIFTI_IMPORT_ROOTS', json.dumps([str(allowed)]))
    assert resolve_image('image.nii') == valid
    with pytest.raises(ValueError): resolve_image('../outside.nii')
    with pytest.raises(ValueError): resolve_image(str(outside))
    with pytest.raises(ValueError): resolve_image('missing.nii')
    with pytest.raises(ValueError): resolve_image(str(valid), str(tmp_path))


def test_manifest_two_masks_roundtrip_and_reopen_dedup(client, tmp_path, monkeypatch):
    dataset = tmp_path / 'dataset'; dataset.mkdir()
    monkeypatch.setenv('NIFTI_IMPORT_ROOTS', json.dumps([str(dataset)]))
    source = dataset / 'image.nii'; phantom(source)
    image = nib.load(source)
    for i in (1, 2):
        pixels = np.zeros(image.shape, dtype=np.uint8); pixels[i, i, i] = 1
        mask = nib.Nifti1Image(pixels, image.affine); mask.header.set_xyzt_units('mm')
        nib.save(mask, dataset / f'mask{i}.nii.gz')
    payload = {'image': 'image.nii', 'segmentations': ['mask1.nii.gz', 'mask2.nii.gz']}
    preview = client.post('/nifti-images/manifest/preview', files={'file': ('cases.json', json.dumps([payload]).encode())})
    assert preview.status_code == 200, preview.text
    assert preview.json()['items'][0]['status'] == 'ready'
    assert client.get('/nifti-images').json()['total'] == 0
    response = client.post('/nifti-images/manifest/open', json=payload)
    assert response.status_code == 200, response.text
    result = response.json(); assert result['errors'] == []
    assert len(result['maskIds']) == 2
    repeated = client.post('/nifti-images/manifest/open', json=payload).json()
    assert repeated['descriptor']['sourceId'] == result['descriptor']['sourceId']
    assert repeated['maskIds'] == result['maskIds']
    masks = client.get('/nifti-images/' + result['descriptor']['sourceId'] + '/masks').json()['items']
    assert len(masks) == 2
    assert (dataset / 'mask1.nii.gz').exists()


def test_preview_invalid_path_remains_visible_and_open_rechecks(client, tmp_path, monkeypatch):
    monkeypatch.setenv('NIFTI_IMPORT_ROOTS', json.dumps([str(tmp_path)]))
    response = client.post('/nifti-images/manifest/preview', files={'file': ('cases.csv', b'image,seg1,seg2\nmissing.nii,,\n')})
    assert response.json()['items'][0]['status'] == 'invalid'
    assert client.post('/nifti-images/manifest/open', json={'image': '../escape.nii'}).status_code == 422
