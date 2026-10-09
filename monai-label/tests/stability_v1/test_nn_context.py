import copy
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import HTTPException
from monailabel.utils.others.nn_context import (
    validate_context, bind_context, finish_context, geometry_mapping,
    read_seed, remap_prompts, invalidate_context,
)


def context(group='B', revision=0, token=None):
    return dict(version=1, seriesUID='series', segmentationId=group, segmentIndex=1,
                requestId='request', revision=revision, generation=0, sessionToken=token,
                shape=[2, 2, 2], slices=[dict(sopInstanceUID='two'), dict(sopInstanceUID='one')],
                promptSlices=['two', 'one'])


class Session:
    def __init__(self):
        self.seeds = []
    def add_initial_seg_interaction(self, seed, run_prediction=False):
        self.seeds.append(seed.copy())


def test_missing_context_rejects_unsafe_legacy_inference():
    with pytest.raises(HTTPException) as error:
        validate_context(None, 'series')
    assert error.value.status_code == 409


def test_new_group_same_number_requires_new_seed():
    session = Session()
    c = context('A')
    bind_context(session, c, np.ones((2, 2, 2), dtype=np.uint8))
    reply = finish_context(session, c)
    with pytest.raises(HTTPException) as error:
        bind_context(session, context('B', token=reply['sessionToken']), None)
    assert error.value.detail['code'] == 'NN_RESYNC_REQUIRED'
    bind_context(session, context('B'), np.zeros((2, 2, 2), dtype=np.uint8))
    assert not session.seeds[-1].any()


def geometry_context(reverse=True):
    source = [dict(sopInstanceUID=uid, rows=2, columns=2,
                   position=[0, 0, z], orientation=[1, 0, 0, 0, 1, 0], spacing=[1, 1])
              for z, uid in enumerate(('one', 'two'))]
    c = context()
    c['slices'] = copy.deepcopy(source[::-1] if reverse else source)
    c['promptSlices'] = [s['sopInstanceUID'] for s in c['slices']]
    return c, source


@pytest.mark.parametrize('reverse', [True, False])
def test_seed_and_point_mapping_use_dicom_references_not_instance_number(tmp_path, reverse):
    c, source = geometry_context(reverse)
    order, prompt_order = geometry_mapping(c, source, [2, 2, 2])
    path = tmp_path / 'seed.bin'
    incoming = np.zeros((2, 2, 2), np.uint8)
    incoming[0, 0, 0] = 1
    path.write_bytes(incoming.tobytes())
    seed = read_seed(str(path), c, order)
    assert seed[1 if reverse else 0, 0, 0] == 1
    np.testing.assert_array_equal(seed[order], incoming)
    data = {'pos_points': [[0, 0, 0]], 'neg_boxes': [[[0, 0, 0], [1, 1, 1]]]}
    remap_prompts(data, prompt_order, [2, 2, 2])
    assert data['pos_points'][0][2] == (1 if reverse else 0)


@pytest.mark.parametrize('damage', ['uid', 'position', 'orientation', 'spacing', 'shape', 'duplicate'])
def test_geometry_mismatch_rejected_before_mask_changes(damage):
    c, source = geometry_context()
    if damage == 'uid': c['slices'][0]['sopInstanceUID'] = 'wrong'
    elif damage == 'shape': c['shape'] = [2, 3, 2]
    elif damage == 'duplicate': c['slices'][0] = c['slices'][1]
    else: c['slices'][0][damage][0] = 99
    with pytest.raises(HTTPException) as error:
        geometry_mapping(c, source, [2, 2, 2])
    assert error.value.status_code == 422


def test_bad_seed_length_and_nonbinary_pixels_fail(tmp_path):
    c, source = geometry_context()
    path = tmp_path / 'seed.bin'
    for raw in [b'\0', b'\0' * 9, b'\2' * 8]:
        path.write_bytes(raw)
        with pytest.raises(HTTPException): read_seed(str(path), c, [1, 0])


def test_tokens_are_single_use_and_legacy_sync_invalidates_binding():
    session = Session()
    c = context()
    bind_context(session, c, np.zeros((2, 2, 2), np.uint8))
    response = finish_context(session, c)
    followup = context(token=response['sessionToken'])
    bind_context(session, followup, None)
    with pytest.raises(HTTPException): bind_context(session, followup, None)
    finish_context(session, followup)
    invalidate_context(session)
    with pytest.raises(HTTPException): bind_context(session, followup, None)


@pytest.mark.parametrize('field,value', [('segmentationId', 'A'), ('segmentIndex', 2), ('seriesUID', 'other'), ('generation', 1)])
def test_full_identity_and_generation_fence_the_session(field, value):
    session = Session()
    c = context()
    bind_context(session, c, np.zeros((2, 2, 2), np.uint8))
    reply = finish_context(session, c)
    other = context(token=reply['sessionToken'])
    other[field] = value
    with pytest.raises(HTTPException): bind_context(session, other, None)


def test_real_basic_infer_command_binds_seed_maps_point_and_rejects_cross_group(tmp_path, monkeypatch):
    """Execute the production __call__, replacing only GPU/DICOM IO dependencies."""
    import ast
    import contextlib
    import logging
    import sys
    import time
    from datetime import datetime
    from pathlib import Path
    from monailabel.utils.others import model_runtime as runtime

    class Tensor:
        def __init__(self, value): self.value = value
        def numpy(self): return self.value
        def clone(self): return Tensor(self.value.copy())
    class FakeSession(Session):
        def __init__(self):
            super().__init__()
            self.target_buffer = Tensor(np.zeros((2, 2, 2), np.uint8))
            self.interactions = None
            self.preprocessed_image = True
            self.original_image_shape = (2, 2, 2)
        def add_initial_seg_interaction(self, seed, run_prediction=False):
            super().add_initial_seg_interaction(seed, run_prediction)
            self.target_buffer = Tensor(seed.copy())
        def add_point_interaction(self, point, include_interaction):
            self.target_buffer.value[point] = int(include_interaction)
    session = FakeSession()
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(Tensor=Tensor))
    c, source = geometry_context()
    path = tmp_path / 'seed.bin'
    path.write_bytes(b'\0' * 8)
    file = Path(__file__).parents[2] / 'monailabel/tasks/infer/basic_infer.py'
    tree = ast.parse(file.read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'BasicInferTask')
    function = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '__call__')
    function.returns = None
    for arg in function.args.args: arg.annotation = None
    function.args.defaults = [ast.Constant(None) for _ in function.args.defaults]
    namespace = dict(copy=copy, time=time, datetime=datetime, np=np,
                     logger=logging.getLogger('nn-test'), name_to_device=lambda *args: 'cpu',
                     sitk=SimpleNamespace(GetArrayFromImage=lambda image: image),
                     CallBackTypes=SimpleNamespace(PRE_TRANSFORMS=1, INFERER=2, INVERT_TRANSFORMS=3, POST_TRANSFORMS=4, WRITER=5),
                     nn_locked=runtime.nn_locked, check_request=lambda data: 'nninteractive',
                     get_nn_session=lambda: session, prepare_nn_image=lambda *args: False,
                     timeout_context=lambda **kwargs: contextlib.nullcontext(), ModelRuntimeError=runtime.ModelRuntimeError)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), str(file), 'exec'), namespace)
    task = SimpleNamespace(_config={}, _session_image={}, _session_used_interactions={'pos_points': set()},
                           _dicom_cache={'series': dict(img=np.zeros((2, 2, 2)), instanceNumber=123, instanceNumber2=999,
                           contrast_center=None, contrast_window=None, image_series_desc='test', dicom_filenames=[], nn_geometry=source)})
    task.is_prompt_used = lambda *args: False
    task.add_prompt = lambda *args: None
    req = dict(image='/cache/series.nii.gz', nninter=True, nn_context=c, _nn_seed_file=str(path), texts=[],
               pos_points=[[1, 1, 0]])
    pred, result = namespace['__call__'](task, req)
    assert pred[0, 1, 1] == 1  # Result is back in the original browser slice order.
    assert session.target_buffer.numpy()[1, 1, 1] == 1
    assert len(session.seeds) == 1
    other = context('C', token=result['nn_context']['sessionToken'])
    other['slices'] = c['slices']
    req.update(nn_context=other)
    req.pop('_nn_seed_file')
    with pytest.raises(HTTPException) as error: namespace['__call__'](task, req)
    assert error.value.detail['code'] == 'NN_RESYNC_REQUIRED'


def test_real_endpoint_removes_seed_tempfile_on_failure_and_ignores_client_path(tmp_path, monkeypatch):
    import ast
    import io
    import json
    import logging
    import os
    import tempfile
    from pathlib import Path
    monkeypatch.setattr(tempfile, 'tempdir', str(tmp_path))
    c, _ = geometry_context()
    seen = []
    def infer(request):
        path = request['_nn_seed_file']
        assert path != 'untrusted-client-path'
        assert Path(path).read_bytes() == b'\0' * 8
        seen.append(path)
        raise HTTPException(status_code=503, detail='mock model failure')
    app = SimpleNamespace(info=lambda: {}, infer=infer)
    source = Path(__file__).parents[2] / 'monailabel/endpoints/infer.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_inference')
    function.returns = None
    for arg in function.args.args: arg.annotation = None
    function.args.defaults = [ast.Constant(None) for _ in function.args.defaults]
    namespace = dict(json=json, os=os, tempfile=tempfile, app_instance=lambda: app,
                     HTTPException=HTTPException, logger=logging.getLogger('endpoint-test'))
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), str(source), 'exec'), namespace)
    with pytest.raises(HTTPException) as error:
        namespace['run_inference'](None, 'segmentation', image='series',
            params=json.dumps(dict(nninter=True, nn_context=c, _nn_seed_file='untrusted-client-path')),
            nn_seed=SimpleNamespace(file=io.BytesIO(b'\0' * 8)))
    assert error.value.status_code == 503
    assert len(seen) == 1 and not Path(seen[0]).exists()
