import concurrent.futures
import ast
import json
import os
import subprocess
import sys
import threading
import types
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from monailabel.utils.others import model_runtime as runtime
from monailabel.endpoints.health import router, model_runtime_error_handler


def test_import_has_no_heavy_dependencies_or_downloads():
    code = """
import sys
import monailabel.utils.others.model_runtime as r
assert not any(n in sys.modules for n in ['torch', 'nnInteractive', 'voxtell', 'transformers', 'huggingface_hub'])
assert r.model_status()['nninteractive']['state'] == 'uninitialized'
assert all(v['state'] == 'disabled' for k,v in r.model_status().items() if k != 'nninteractive')
"""
    env = dict(os.environ, ENABLE_NNINTERACTIVE="true", ENABLE_VOXTELL="false", ENABLE_SAM_MODELS="false", ENABLE_MEDGEMMA="false")
    subprocess.run([sys.executable, "-c", code], env=env, check=True)


def test_concurrent_get_initializes_once():
    entered, release = threading.Event(), threading.Event()
    calls, value = [], object()
    def factory():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return value
    resource = runtime.LazyModel("nninteractive", True, factory)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(resource.get) for _ in range(4)]
        assert entered.wait(5)
        assert resource.status()["state"] == "loading"  # status never takes the loading lock
        release.set()
        assert all(j.result() is value for j in jobs)
    assert calls == [1]
    assert resource.status()["state"] == "ready"


def test_failure_is_cached_and_not_retried_by_health():
    calls = []
    def factory():
        calls.append(1)
        raise ValueError("corrupt checkpoint")
    resource = runtime.LazyModel("nninteractive", True, factory)
    for _ in range(2):
        with pytest.raises(runtime.ModelRuntimeError) as error:
            resource.get()
        assert error.value.code == "MODEL_LOAD_FAILED"
    assert resource.status()["state"] == "failed"
    assert calls == [1]


def test_missing_weights_do_not_import_torch(tmp_path, monkeypatch):
    monkeypatch.setenv("MONAI_CHECKPOINTS_DIR", str(tmp_path))
    resource = runtime.LazyModel("nninteractive", True, runtime._load_nninteractive)
    with pytest.raises(runtime.ModelRuntimeError) as error:
        resource.get()
    assert error.value.code == "MODEL_UNAVAILABLE"
    assert resource.status()["state"] == "failed"


@pytest.mark.parametrize("params,name", [
    ({"nninter": "medGemma", "texts": ["report"]}, "medgemma"),
    ({"nninter": True, "texts": ["liver"]}, "voxtell"),
    ({"nninter": False, "medsam2": "sam2"}, "sam2"),
    ({"nninter": False, "medsam2": "medsam2"}, "medsam2"),
    ({"nninter": False, "medsam2": "sam3"}, "sam3"),
])
def test_disabled_models_return_503_and_health_stays_ok(params, name, monkeypatch):
    monkeypatch.setitem(runtime.MODELS, name, runtime.LazyModel(name, False, lambda: pytest.fail("factory called")))
    app = FastAPI()
    app.include_router(router)
    app.add_exception_handler(runtime.ModelRuntimeError, model_runtime_error_handler)
    # Compile the production dispatch function without unrelated CUDA/MONAI imports.
    # Disabled requests must exit before the app/datastore is even accessed.
    source = Path(__file__).parents[2] / "monailabel/endpoints/infer.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "run_inference")
    function.returns = None
    for arg in function.args.args: arg.annotation = None
    function.args.defaults = [ast.Constant(None) for _ in function.args.defaults]
    namespace = {"json": json, "HTTPException": HTTPException, "app_instance": lambda: pytest.fail("app accessed")}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), str(source), "exec"), namespace)
    @app.post("/infer")
    def infer():
        return namespace["run_inference"](None, "segmentation", image="series", params=json.dumps(params))
    with TestClient(app) as client:
        result = client.post("/infer")
        assert result.status_code == 503
        assert result.json()["code"] == "MODEL_DISABLED"
        assert result.json()["model"] == name
        assert client.get("/health").json()["status"] == "ok"


def test_same_shape_different_series_prepares_again(monkeypatch):
    fake_torch = types.SimpleNamespace(zeros=lambda shape, dtype: object(), uint8="uint8")
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    class Session:
        original_image_shape = None
        preprocessed_image = None
        preprocess_future = None
        def __init__(self): self.calls = 0
        def set_image(self, image):
            self.calls += 1
            self.original_image_shape = image.shape
            self.preprocessed_image = object()
        def set_target_buffer(self, target): self.target_buffer = target
    session = Session()
    image = types.SimpleNamespace(shape=(1, 2, 3, 4))
    with runtime.NN_SESSION_LOCK:
        assert runtime.prepare_nn_image(session, "series-a", image)
        assert not runtime.prepare_nn_image(session, "series-a", image)
        assert runtime.prepare_nn_image(session, "series-b", image)
    assert session.calls == 2
    assert session._ohif_series_uid == "series-b"


def test_shared_session_lock_serializes_callers():
    entered, release, second = threading.Event(), threading.Event(), threading.Event()
    @runtime.nn_locked
    def first():
        entered.set()
        assert release.wait(5)
    @runtime.nn_locked
    def other(): second.set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(first)
        assert entered.wait(5)
        b = pool.submit(other)
        assert not second.wait(0.05)
        release.set()
        a.result()
        b.result()
    assert second.is_set()


def test_failed_model_does_not_change_base_readiness(monkeypatch):
    def fail(): raise ValueError("bad checkpoint")
    resource = runtime.LazyModel("nninteractive", True, fail)
    monkeypatch.setitem(runtime.MODELS, "nninteractive", resource)
    with pytest.raises(runtime.ModelRuntimeError): resource.get()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        result = client.get("/health")
        assert result.status_code == 200
        assert result.json()["status"] == "ok"
        assert result.json()["models"]["nninteractive"]["state"] == "failed"
    assert isinstance(resource._error, dict)  # no traceback retaining model memory
