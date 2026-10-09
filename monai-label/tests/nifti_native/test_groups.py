import hashlib
import json
import uuid
import nibabel as nib
import numpy as np
from monailabel.endpoints import nifti_images as api
from test_library import client, upload
from test_format import phantom
from test_mask_restore import setup_masks


def test_labels_share_group_and_save_restore_copy_keep_membership(client, tmp_path):
    path = tmp_path / 'source.nii'; phantom(path)
    source = upload(client, path).json(); image = nib.load(path)
    data = np.zeros(image.shape, dtype=np.uint16); data[0, 0, 0] = 1; data[1, 1, 1] = 4
    path2 = tmp_path / 'finding.nii.gz'; nib.save(nib.Nifti1Image(data, image.affine, image.header), path2)
    url = '/nifti-images/' + source['sourceId'] + '/masks'
    fields = {'geometryHash': source['geometryHash'], 'label': path2.name}
    a, b = client.post(url, data=fields, files={'file': (path2.name, path2.read_bytes())}).json()['items']
    group = a['segmentationSet']; assert group == b['segmentationSet']
    assert {a['originalLabel'], b['originalLabel']} == {1, 4}
    seed = bytes([1]) + bytes(source['count'] - 1)
    raw = dict(fields, raw='true', provenance=json.dumps({'segmentationSet': group}))
    updated = client.post(url, data=dict(raw, maskId=a['maskId'], expectedVersion=1), files={'file': ('seed.bin', seed)}).json()['items'][0]
    assert updated['segmentationSet'] == group and updated['version'] == 2
    restored = client.post(url + '/' + a['maskId'] + '/restore', json={'version': 1, 'expectedVersion': 2, 'requestId': str(uuid.uuid4())}).json()['item']
    assert restored['segmentationSet'] == group and restored['maskId'] == a['maskId']
    copied = client.post(url, data=dict(raw, provenance=json.dumps({'derivedFrom': {'maskId': a['maskId'], 'version': 1}})), files={'file': ('copy.bin', seed)}).json()['items'][0]
    assert copied['segmentationSet'] == group and copied['maskId'] != a['maskId']
    other_group = dict(group, id=uuid.uuid4().hex, kind='copy', name='方案 B')
    reply = client.post(url, data=dict(raw, provenance=json.dumps({'segmentationSet': other_group}), maskId=b['maskId'], expectedVersion=1), files={'file': ('seed.bin', seed)})
    assert reply.status_code == 409
    scheme = client.post(url, data=dict(raw, provenance=json.dumps({'segmentationSet': other_group, 'derivedFrom': {'maskId': a['maskId'], 'version': 1}})), files={'file': ('copy.bin', seed)}).json()['items'][0]
    assert scheme['segmentationSet']['id'] == other_group['id']
    # Same basename in another import must not merge without explicit identity.
    unrelated = client.post(url, data=fields, files={'file': (path2.name, path2.read_bytes())}).json()['items'][0]
    assert unrelated['segmentationSet']['id'] != group['id']


def test_legacy_import_batch_backfill_is_idempotent_and_does_not_rewrite_versions(client, tmp_path):
    url, a, _, b = setup_masks(client, tmp_path)
    sid = a['sourceId']
    original_files = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (api.root()/sid/'masks').rglob('*') if p.is_file()}
    with api.database() as db:
        db.execute('DELETE FROM segmentation_group_members'); db.execute('DELETE FROM segmentation_groups')
        for row in db.execute('SELECT source,id,version,metadata FROM masks').fetchall():
            meta = json.loads(row['metadata']); meta.pop('segmentationSet', None)
            db.execute('UPDATE masks SET metadata=? WHERE source=? AND id=? AND version=?', (json.dumps(meta), row['source'], row['id'], row['version']))
        db.execute('CREATE TABLE IF NOT EXISTS manifest_imports (source TEXT, hash TEXT, masks TEXT, PRIMARY KEY(source,hash))')
        db.execute('INSERT INTO manifest_imports VALUES (?,?,?)', (sid, 'batch-proof', json.dumps([a['maskId'], b['maskId']])))
    first = client.get(url).json()['items']; second = client.get(url).json()['items']
    assert first == second
    assert len({m['segmentationSet']['id'] for m in first}) == 1
    assert {m['maskId'] for m in first} == {a['maskId'], b['maskId']}
    assert {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (api.root()/sid/'masks').rglob('*') if p.is_file()} == original_files
    assert client.get(url+'/history', params={'maskId': a['maskId']}).json()['total'] == 2


def test_group_provenance_validation_and_cross_source_isolation(client, tmp_path):
    url, a, _, _ = setup_masks(client, tmp_path)
    for value in [{'id': '../../escape'}, 'bad', dict(a['segmentationSet'], id='x'*32)]:
        reply = client.post(url, data={'geometryHash': a['geometryHash'], 'raw': 'true', 'provenance': json.dumps({'segmentationSet': value})}, files={'file': ('x', b'1')})
        assert reply.status_code == 422
    group = a['segmentationSet']
    with api.database() as db:
        from monailabel.utils.others.nifti_groups import group_for
        assert group_for(db, '0'*32, a['maskId']) is None
        assert group_for(db, a['sourceId'], a['maskId']) == group
