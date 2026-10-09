"""Real FastAPI/SimpleITK draft roundtrips, fake Orthanc transport and no AI package."""
import importlib
import json
import sys
import types
from pathlib import Path

import numpy as np
import pytest
import SimpleITK as sitk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from monailabel.endpoints.health import model_runtime_error_handler
from monailabel.utils.others.model_runtime import ModelRuntimeError


@pytest.fixture
def draft_client(tmp_path, monkeypatch):
    # The tested endpoint never needs torch for saving/listing masks.
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(Tensor=type("UnusedTensor", (), {})))
    series_uid, study_uid = "1.2.826.0.1.3680043.10.999.1", "1.2.826.0.1.3680043.10.999"
    image = sitk.GetImageFromArray(np.arange(60, dtype=np.int16).reshape(3, 4, 5))
    image.SetSpacing((0.8, 0.9, 2.5))
    image.SetOrigin((10.0, 20.0, 30.0))
    cache = tmp_path / "dicom"
    class FakeDICOMWebDatastore:
        def __init__(self):
            self.calls = []
            self.fail = False
            self._datastore = types.SimpleNamespace(image_path=lambda: str(cache))
        def get_image_uri(self, series, study_instance_uid=None):
            self.calls.append((series, study_instance_uid))
            if self.fail: raise ConnectionError("Orthanc unavailable")
            folder = cache / series
            if not folder.exists():
                folder.mkdir(parents=True)
                writer = sitk.ImageFileWriter()
                writer.KeepOriginalImageUIDOn()
                for z in range(image.GetDepth()):
                    plane = image[:, :, z]
                    for key, value in {
                        "0008|0060": "CT", "0020|000d": study_uid, "0020|000e": series,
                        "0020|0013": str(z + 1), "0020|0037": "1\\0\\0\\0\\1\\0",
                        "0020|0032": "\\".join(map(str, image.TransformIndexToPhysicalPoint((0, 0, z)))),
                        "0018|0050": "2.5", "0018|0088": "2.5",
                    }.items(): plane.SetMetaData(key, value)
                    writer.SetFileName(str(folder / f"{z}.dcm"))
                    writer.Execute(plane)
            return str(folder)
    datastore = FakeDICOMWebDatastore()
    monkeypatch.setitem(sys.modules, "monailabel.datastore.dicom", types.SimpleNamespace(DICOMWebDatastore=FakeDICOMWebDatastore))
    monkeypatch.setitem(sys.modules, "monailabel.interfaces.utils.app", types.SimpleNamespace(
        app_instance=lambda: types.SimpleNamespace(datastore=lambda: datastore, _infers={})
    ))
    module = importlib.import_module("monailabel.endpoints.nifti_store")
    monkeypatch.setattr(module, "NIFTI_SEGS_DIR", str(tmp_path / "drafts"))
    monkeypatch.setattr(module, "get_nn_session", lambda: pytest.fail("Save must not load nnInteractive"))
    app = FastAPI()
    app.include_router(module.router)
    app.add_exception_handler(ModelRuntimeError, model_runtime_error_handler)
    with TestClient(app) as client:
        yield client, datastore, image, series_uid, study_uid, tmp_path / "drafts"


def save(client, series, study, mask, **params):
    return client.post(f"/nifti-segs/{series}", data={"params": json.dumps({
        "raw_binary": True, "studyInstanceUID": study, "label": "test", "algorithm": "brush", **params,
    })}, files={"seg_data": ("mask.bin", mask.tobytes(), "application/octet-stream")})


def test_brush_save_with_cold_cache_preserves_geometry(draft_client):
    client, store, image, series, study, drafts = draft_client
    mask = np.zeros((3, 4, 5), dtype=np.uint8)
    mask[1, 1:3, 2:4] = 1
    response = save(client, series, study, mask)
    assert response.status_code == 200, response.text
    assert store.calls == [(series, study)]
    result = sitk.ReadImage(str(drafts / series / response.json()["filename"]))
    np.testing.assert_array_equal(sitk.GetArrayFromImage(result), mask)
    assert result.GetSpacing() == pytest.approx(image.GetSpacing())
    assert result.GetOrigin() == pytest.approx(image.GetOrigin())
    assert result.GetDirection() == pytest.approx(image.GetDirection())
    assert client.get(f"/nifti-segs/{series}").status_code == 200
    assert client.get(f"/nifti-segs/{series}/{response.json()['filename']}").status_code == 200


def test_failed_dicom_retrieval_keeps_previous_draft(draft_client):
    client, store, image, series, study, drafts = draft_client
    mask = np.ones((3, 4, 5), dtype=np.uint8)
    first = save(client, series, study, mask).json()["filename"]
    folder = drafts / series
    before = {p.name: p.read_bytes() for p in folder.iterdir()}
    store.fail = True
    result = save(client, series, study, mask, origin=first)
    assert result.status_code == 502
    assert result.json()["detail"]["code"] == "SOURCE_DICOM_UNAVAILABLE"
    assert {p.name: p.read_bytes() for p in folder.iterdir()} == before


def test_empty_new_mask_and_bad_size_are_rejected(draft_client):
    client, store, image, series, study, drafts = draft_client
    assert save(client, series, study, np.zeros((3, 4, 5), dtype=np.uint8)).status_code == 400
    assert save(client, series, study, np.ones((2, 4, 5), dtype=np.uint8)).status_code == 400
    assert not list((drafts / series).iterdir())


def test_missing_study_does_not_use_shared_previous_study(draft_client):
    client, store, image, series, study, drafts = draft_client
    store._studyInstanceUID = "previous-unrelated-study"
    result = save(client, series, "", np.ones((3, 4, 5), dtype=np.uint8))
    assert result.status_code == 200
    assert store.calls == [(series, "")]


def test_restore_loads_session_explicitly_and_keeps_mask(draft_client, monkeypatch):
    client, store, image, series, study, drafts = draft_client
    mask = np.ones((3, 4, 5), dtype=np.uint8)
    filename = save(client, series, study, mask).json()["filename"]
    module = importlib.import_module("monailabel.endpoints.nifti_store")
    monkeypatch.setattr(sys.modules["torch"], "zeros", lambda shape, dtype: np.zeros(shape, dtype=dtype), raising=False)
    monkeypatch.setattr(sys.modules["torch"], "uint8", np.uint8, raising=False)
    class Session:
        original_image_shape = None
        preprocessed_image = None
        preprocess_future = None
        interactions = None
        def set_image(self, array):
            self.original_image_shape = array.shape
            self.preprocessed_image = array
        def set_target_buffer(self, target): self.target_buffer = target
        def add_initial_seg_interaction(self, data, run_prediction):
            assert run_prediction is False
            self.target_buffer[:] = data
    session = Session()
    monkeypatch.setattr(module, "get_nn_session", lambda: session)
    result = client.post(f"/nifti-segs/{series}/load-session", data={
        "filename": filename, "image": series, "studyInstanceUID": study,
    })
    assert result.status_code == 200, result.text
    np.testing.assert_array_equal(session.target_buffer, mask)
    assert session._ohif_series_uid == series
    assert store.calls == [(series, study), (series, study)]
    assert (drafts / series / filename).exists()


def test_unavailable_ai_does_not_remove_loaded_draft(draft_client, monkeypatch):
    client, store, image, series, study, drafts = draft_client
    filename = save(client, series, study, np.ones((3, 4, 5), dtype=np.uint8)).json()["filename"]
    module = importlib.import_module("monailabel.endpoints.nifti_store")
    def unavailable(): raise ModelRuntimeError("nninteractive", "MODEL_UNAVAILABLE", "Missing weights")
    monkeypatch.setattr(module, "get_nn_session", unavailable)
    result = client.post(f"/nifti-segs/{series}/load-session", data={"filename": filename, "image": series})
    assert result.status_code == 503
    assert result.json()["code"] == "MODEL_UNAVAILABLE"
    assert (drafts / series / filename).exists()
    assert client.get(f"/nifti-segs/{series}/{filename}").status_code == 200
