import gzip
import hashlib
import time

import numpy as np
import pytest
from monailabel.utils.others.nifti_source import read_nifti
from monailabel.utils.others.nifti_stream import FrameCache, wire_dtype, cache, StreamError
from test_library import client, upload
from test_format import phantom


def wait_ready(store, meta):
    for _ in range(200):
        state = store.status(meta)
        if state['state'] in ('ready', 'failed'):
            assert state['state'] == 'ready', state
            return state['descriptor']
        time.sleep(.01)
    pytest.fail('stream prepare did not finish')


@pytest.mark.parametrize('dtype', [np.uint8, np.int8, np.uint16, np.int16, np.float32])
@pytest.mark.parametrize('endian', ['<', '>'])
@pytest.mark.parametrize('slope,intercept', [(1, 0), (2, -1024), (.25, .125)])
def test_all_frames_bit_exact(tmp_path, dtype, endian, slope, intercept):
    path = tmp_path / 'source.nii.gz'
    phantom(path, dtype=dtype, endian=endian, slope=slope, intercept=intercept)
    meta, pixels = read_nifti(path)
    meta['sourceId'] = 'a' * 32
    store = FrameCache(tmp_path / 'cache')
    try:
        store.prepare(meta, path)
        desc = wait_ready(store, meta)
        assert desc['preScaled'] and desc['geometryHash'] == meta['geometryHash']
        for i, frame in enumerate(desc['frames']):
            compressed, _ = store.frame(meta, path, i)
            raw = gzip.decompress(compressed.read_bytes())
            assert len(raw) == frame['bytes']
            assert hashlib.sha256(raw).hexdigest() == frame['sha256']
            decoded = np.frombuffer(raw, dtype=desc['wireDtype']).astype(pixels.dtype).reshape(pixels.shape[1:])
            assert decoded.tobytes() == pixels[i].tobytes()
    finally:
        store.close()


def test_float_pack_preserves_ieee_bits():
    assert wire_dtype(np.array([0., -1000., 3014.], dtype='f4')).str == '<i2'
    for data in ([.25], [32768.], [-0.]):
        assert wire_dtype(np.array(data, dtype='f4')).str == '<f4'


def test_dedup_restart_corruption_identity_and_quota(tmp_path):
    path = tmp_path / 'source.nii'
    phantom(path)
    meta, _ = read_nifti(path); meta['sourceId'] = 'a' * 32
    store = FrameCache(tmp_path / 'cache')
    store.prepare(meta, path)
    first = store.jobs[store.key(meta)]
    store.prepare(meta, path)
    assert store.jobs[store.key(meta)] is first
    wait_ready(store, meta)
    frame, _ = store.frame(meta, path, 5)
    expected = frame.read_bytes()
    frame.write_bytes(b'broken')
    assert store.frame(meta, path, 5)[0].read_bytes() == expected
    store.close()
    store = FrameCache(tmp_path / 'cache', retention=0)
    assert store.status(meta)['state'] == 'ready'
    with pytest.raises(StreamError): store.frame(meta, path, -1)
    raw = store.root / store.key(meta) / 'voxels.raw'
    raw.write_bytes(b'x' * raw.stat().st_size)
    with pytest.raises(StreamError): store.frame(meta, path, 6)
    wait_ready(store, meta)
    changed = dict(meta, contentHash='0' * 64)
    store.prepare(changed, path)
    store.jobs[store.key(changed)].result()
    assert store.status(changed)['state'] == 'failed'
    assert not (store.root / store.key(changed)).exists()
    store.limit = 1
    with pytest.raises(StreamError): store._capacity(2, 'protected')
    store.close()
    assert path.is_file()


def test_stream_api_gate_auth_boundary_and_file_offload(client, tmp_path, monkeypatch):
    monkeypatch.setenv('NIFTI_STREAM_CACHE_DIR', str(tmp_path / 'frames'))
    path = tmp_path / 'source.nii'; phantom(path)
    meta = upload(client, path).json(); base = '/nifti-images/' + meta['sourceId']
    assert client.post(base + '/stream/prepare').status_code == 404
    monkeypatch.setenv('ENABLE_NIFTI_STREAMING', 'true')
    assert client.get(base + '/metadata').json()['capabilities']['streamingViewing']
    assert client.post(base + '/stream/prepare').status_code in (200, 202)
    wait_ready(cache(), meta)
    state = client.get(base + '/stream').json()
    response = client.get(base + '/frames/5')
    assert response.status_code == 200 and response.headers['content-type'] == 'application/gzip'
    assert response.headers['x-nifti-cache-key'] == state['descriptor']['cacheKey']
    assert gzip.decompress(response.content)
    assert client.get(base + '/frames/1000').status_code == 404
    assert client.get('/nifti-images/path/stream').status_code == 404
    monkeypatch.setenv('NIFTI_STREAM_ACCEL_REDIRECT_PREFIX', '/_nifti-stream-cache')
    offload = client.get(base + '/frames/5')
    assert offload.content == b''
    assert offload.headers['x-accel-redirect'].startswith('/_nifti-stream-cache/')
    assert client.get('/nifti-images').json()['total'] == 1
    cache().close()


def test_lru_evicts_only_unpinned_cache_and_releases_bookkeeping(tmp_path):
    store = FrameCache(tmp_path / 'cache', retention=0)
    records = []
    for i in range(2):
        path = tmp_path / f'source{i}.nii'
        phantom(path, intercept=i)
        meta, _ = read_nifti(path); meta['sourceId'] = str(i) * 32
        store.prepare(meta, path); wait_ready(store, meta)
        records.append((meta, path, store.root / store.key(meta)))
    old, new = records
    old[2].touch()
    import os
    os.utime(old[2], (1, 1))
    new_size = sum(p.stat().st_size for p in new[2].rglob('*') if p.is_file())
    store.limit = new_size + 100
    store.pins[store.key(old[0])] = 1
    with pytest.raises(StreamError): store._capacity(50, store.key(new[0]))
    assert old[2].exists()
    store.pins[store.key(old[0])] = 0
    store._capacity(50, store.key(new[0]))
    assert not old[2].exists() and new[2].exists()
    assert store.key(old[0]) not in store.jobs
    assert all(record[1].is_file() for record in records)
    store.close()
