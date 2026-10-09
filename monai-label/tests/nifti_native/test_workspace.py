import json
import nibabel as nib
import numpy as np
import pytest
from test_library import client
from test_format import phantom
from monailabel.utils.others.nifti_manifest import parse_manifest


def payload():
    return {'cases': [{'caseId': 'case-a', 'image': 'image.nii', 'segmentations': ['m1.nii.gz', 'm2.nii.gz', 'm3.nii.gz'],
        'reports': [{'id': 'r', 'name': 'Report', 'statements': [{'id': 'sentence', 'section': 'Lungs', 'text': 'Opacity.'}]}],
        'findings': [{'id': 'f', 'text': 'Opacity', 'segmentations': ['m1.nii.gz'], 'candidateStatementIds': ['sentence']}]}]}


def test_strict_case_references_and_unconfirmed_candidates():
    rows = parse_manifest(json.dumps(payload()).encode(), 'a.json')
    assert len(rows[0]['segmentations']) == 3
    assert rows[0]['findings'][0]['statementIds'] == []
    for change in ('mask', 'sentence', 'duplicate'):
        p = payload()
        if change == 'mask': p['cases'][0]['findings'][0]['segmentations'] = ['outside.nii']
        if change == 'sentence': p['cases'][0]['findings'][0]['candidateStatementIds'] = ['other-case-sentence']
        if change == 'duplicate': p['cases'].append(p['cases'][0])
        with pytest.raises(ValueError): parse_manifest(json.dumps(p).encode(), 'a.json')


def test_manifest_import_defaults_are_persisted(client):
    response = client.post('/nifti-images/manifest/preview', data={'modality': 'MR', 'unit': 'mm'}, files={'file': ('a.json', json.dumps(payload()).encode())})
    assert response.status_code == 200
    saved = client.get('/nifti-images/manifests/' + response.json()['id']).json()
    assert saved['modality'] == 'MR' and saved['unit'] == 'mm'
    assert 'modality' not in saved['items'][0]


def test_manifest_persistence_binding_conflicts_and_mask_identity(client, tmp_path, monkeypatch):
    monkeypatch.setenv('NIFTI_IMPORT_ROOTS', json.dumps([str(tmp_path)]))
    original = tmp_path / 'image.nii'; phantom(original)
    image = nib.load(original)
    for i in range(1, 4):
        voxels = np.zeros(image.shape, dtype=np.uint8); voxels[1, 1, 1] = i
        nib.save(nib.Nifti1Image(voxels, image.affine, image.header), tmp_path / f'm{i}.nii.gz')
    response = client.post('/nifti-images/manifest/preview', files={'file': ('a.json', json.dumps(payload()).encode())})
    assert response.status_code == 200, response.text
    manifest = response.json(); url = '/nifti-images/manifests/' + manifest['id']
    assert client.get(url).json() == manifest
    opened = client.post('/nifti-images/manifest/open', json={'manifestId': manifest['id'], 'caseId': 'case-a'})
    assert opened.status_code == 200, opened.text
    body = opened.json(); assert len(body['maskIds']) == 3
    current = body['manifest']; finding = current['items'][0]['findings'][0]
    assert finding['maskIds'] == body['maskIds'][:1]
    binding = {'caseId': 'case-a', 'findingId': 'f', 'statementIds': ['sentence'], 'expectedRevision': current['revision']}
    assert client.put(url + '/binding', json=binding).status_code == 200
    assert client.put(url + '/binding', json=binding).status_code == 409
    binding['expectedRevision'] += 1; binding['statementIds'] = ['cross-case']
    assert client.put(url + '/binding', json=binding).status_code == 422
    reopened = client.post('/nifti-images/manifest/open', json={'manifestId': manifest['id'], 'caseId': 'case-a'}).json()
    assert reopened['maskIds'] == body['maskIds']
    assert reopened['manifest']['items'][0]['findings'][0]['statementIds'] == ['sentence']
