import copy
import io
import json
from types import SimpleNamespace
import numpy as np
import pytest
from fastapi import HTTPException
from monailabel.utils.others.nifti_context import validate_context, read_seed, validate_prompts
from monailabel.utils.others.nn_context import bind_context, finish_context
from test_library import client, upload
from test_format import phantom


def context(source):
    n = source['dimensions'][2]
    return dict(version=2, sourceType='nifti', sourceId=source['sourceId'], geometryHash=source['geometryHash'],
        seriesUID='internal-study-series', segmentationId='mask-A', segmentIndex=1, revision=0, generation=0,
        requestId='request-1', shape=source['dimensions'][::-1], maskOrder=list(range(n)), promptOrder=list(range(n)),
        gridConvention={'source': 'IJK', 'model': 'ZYX', 'physical': 'LPS-mm'})


@pytest.mark.parametrize('damage', ['version', 'sourceId', 'geometryHash', 'shape', 'gridConvention', 'maskOrder'])
def test_wrong_source_grid_protocol_rejected(damage):
    source = {'sourceId': 'a'*32, 'geometryHash': 'geometry', 'dimensions': [2, 3, 4]}
    c = context(source)
    c[damage] = None
    with pytest.raises(HTTPException): validate_context(c, source)


def test_native_seed_reverse_and_bounds():
    seed = np.arange(24).reshape(4, 3, 2) % 2
    np.testing.assert_array_equal(read_seed(io.BytesIO(seed.astype(np.uint8).tobytes()), [4,3,2], [3,2,1,0]), seed[::-1])
    with pytest.raises(HTTPException): read_seed(io.BytesIO(b'\x02'*24), [4,3,2], [0,1,2,3])
    with pytest.raises(HTTPException): validate_prompts({'pos_points': [[2,0,0]]}, [0,1,2,3], [4,3,2])


def test_native_infer_seed_prompt_and_session_restart(client, tmp_path, monkeypatch):
    from monailabel.utils.others import model_runtime
    monkeypatch.setenv('ENABLE_NIFTI_AI', 'true')
    path = tmp_path / 'source.nii'
    phantom(path)
    source = upload(client, path).json()
    c = context(source)
    class Session:
        _ohif_series_uid = None
        _ohif_nn_binding = None
        def add_initial_seg_interaction(self, seed, run_prediction): self.target_buffer = seed.copy()
        def add_point_interaction(self, point, include_interaction): self.target_buffer[point] = int(include_interaction)
    session = Session()
    monkeypatch.setattr(model_runtime, 'get_nn_session', lambda: session)
    def prepare(s, identity, image):
        s._ohif_series_uid = identity
        s._ohif_nn_binding = None
        s.target_buffer = np.zeros(image.shape[1:], np.uint8)
    monkeypatch.setattr(model_runtime, 'prepare_nn_image', prepare)
    seed = np.zeros(c['shape'], np.uint8)
    seed[2,3,4] = 1
    params = {'nn_context': c, 'pos_points': [[1,2,3]]}
    url = '/nifti-images/' + source['sourceId'] + '/infer'
    response = client.post(url, data={'params': json.dumps(params)}, files={'nn_seed': ('mask.bin', seed.tobytes())})
    assert response.status_code == 200, response.text
    assert session.target_buffer[2,3,4] == 1
    assert session.target_buffer[3,2,1] == 1
    c['sessionToken'] = session._ohif_nn_binding['token']
    response = client.post(url, data={'params': json.dumps(params)})
    assert response.status_code == 200
    # Switching target cannot reuse token from a different selected mask.
    c['sessionToken'] = session._ohif_nn_binding['token']
    c['segmentationId'] = 'mask-B'
    assert client.post(url, data={'params': json.dumps(params)}).status_code == 409
    session._ohif_nn_binding = None
    assert client.post(url, data={'params': json.dumps(params)}).status_code == 409
    assert client.post(url, data={'params': json.dumps(params)}, files={'nn_seed': ('mask.bin', seed.tobytes())}).status_code == 200
