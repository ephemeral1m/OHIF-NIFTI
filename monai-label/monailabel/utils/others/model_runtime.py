"""Lazy, local-only model resources. Importing this module never imports AI packages.

The single-user nnInteractive session is serialized across infer/reset/load-session.
Its lock is deliberately separate from status reads used by the health endpoint.
"""
import functools
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)
NN_SESSION_LOCK = threading.RLock()


class ModelRuntimeError(RuntimeError):
    def __init__(self, model, code, message):
        super().__init__(message)
        self.model, self.code, self.message = model, code, message

    def payload(self):
        return {"code": self.code, "model": self.model, "message": self.message}


class LazyModel:
    def __init__(self, name, enabled, factory):
        self.name, self.enabled, self.factory = name, enabled, factory
        self._lock = threading.Lock()
        self._status_lock = threading.Lock()
        self._state = "uninitialized" if enabled else "disabled"
        self._value = None
        self._error = None

    def status(self):
        with self._status_lock:
            result = {"state": self._state}
            if self._error:
                result.update(self._error)
            return result

    def check(self):
        if not self.enabled:
            raise ModelRuntimeError(self.name, "MODEL_DISABLED", f"{self.name} is disabled in this deployment.")
        with self._status_lock:
            if self._error:
                raise ModelRuntimeError(**self._error)

    def peek(self):
        return self._value

    def get(self):
        self.check()
        with self._lock:
            self.check()
            if self._value is not None:
                return self._value
            with self._status_lock:
                self._state = "loading"
            logger.info("Model loading: %s (local weights only)", self.name)
            try:
                value = self.factory()
                if value is None:
                    raise RuntimeError("Model factory returned no resource")
            except Exception as exc:
                error = exc if isinstance(exc, ModelRuntimeError) else ModelRuntimeError(
                    self.name,
                    "MODEL_UNAVAILABLE" if isinstance(exc, ImportError) else "MODEL_LOAD_FAILED",
                    f"{self.name} could not load; check backend logs and local weights, then restart the backend.",
                )
                with self._status_lock:
                    # Store only text, never an exception traceback retaining model tensors.
                    self._state, self._error = "failed", error.payload()
                logger.exception("Model load failed: %s; base API remains available", self.name)
                if error is exc:
                    raise
                raise error from exc
            with self._status_lock:
                self._value, self._state = value, "ready"
            logger.info("Model ready: %s", self.name)
            return value


def _enabled(name, default=False):
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _weights(model, folder, names):
    root = Path(os.environ.get("MONAI_CHECKPOINTS_DIR", "/code/checkpoints")) / folder
    missing = [name for name in names if not (root / name).is_file() or (root / name).stat().st_size == 0]
    if missing:
        raise ModelRuntimeError(model, "MODEL_UNAVAILABLE", f"{model}: missing local weights/config: {', '.join(missing)}")
    return root


def _load_nninteractive():
    root = _weights("nninteractive", "nnInteractive_v1.0", [
        "fold_0/checkpoint_final.pth", "plans.json", "dataset.json", "inference_session_class.json",
    ])
    import torch
    from nnInteractive.inference.inference_session import nnInteractiveInferenceSession

    if not torch.cuda.is_available():
        raise ModelRuntimeError("nninteractive", "MODEL_UNAVAILABLE", "nnInteractive requires an available CUDA device.")
    session = nnInteractiveInferenceSession(
        device=torch.device("cuda:0"), use_torch_compile=False, verbose=False,
        torch_n_threads=os.cpu_count() or 1, do_autozoom=True,
    )
    try:
        session.initialize_from_trained_model_folder(str(root))
    except Exception:
        executor = getattr(session, "executor", None)
        if executor:
            executor.shutdown(wait=False, cancel_futures=True)
        raise
    session._ohif_series_uid = None
    return session


def _unsupported(name):
    # V1 intentionally cannot opt heavy models back into the API process.
    raise ModelRuntimeError(name, "MODEL_UNAVAILABLE", f"{name} is not supported by the stability-v1 runtime.")


MODELS = {
    "nninteractive": LazyModel("nninteractive", _enabled("ENABLE_NNINTERACTIVE", True), _load_nninteractive),
    **{name: LazyModel(name, _enabled(flag), functools.partial(_unsupported, name)) for name, flag in [
        ("voxtell", "ENABLE_VOXTELL"), ("sam2", "ENABLE_SAM_MODELS"),
        ("medsam2", "ENABLE_SAM_MODELS"), ("sam3", "ENABLE_SAM_MODELS"), ("medgemma", "ENABLE_MEDGEMMA"),
    ]},
}


def model_status():
    return {name: model.status() for name, model in MODELS.items()}


def requested_model(params):
    mode = params.get("nninter")
    if mode == "medGemma":
        return "medgemma"
    if mode is False:
        name = params.get("medsam2", "sam2")
        return name if name in {"medsam2", "sam3"} else "sam2"
    if mode in ("init", "reset"):
        return "nninteractive"
    if any(isinstance(t, str) and t.strip() for t in params.get("texts", []) or []):
        return "voxtell"
    return "nninteractive" if mode else None


def check_request(params):
    name = requested_model(params)
    if name:
        MODELS[name].check()
    return name


def nn_locked(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        with NN_SESSION_LOCK:
            return fn(*args, **kwargs)
    return wrapped


def get_nn_session():
    return MODELS["nninteractive"].get()


def prepare_nn_image(session, series_uid, image):
    """Caller holds NN_SESSION_LOCK. Series identity, not shape, owns preprocessing."""
    changed = (
        getattr(session, "_ohif_series_uid", None) != series_uid
        or session.original_image_shape != image.shape
        or session.preprocessed_image is None
    )
    if changed:
        import torch
        # Join previous preprocessing before changing the shared image.
        try:
            for attr in ("preprocess_future", "interactions_future"):
                future = getattr(session, attr, None)
                if future is not None:
                    future.result(timeout=60)
            session._ohif_series_uid = None
            session._ohif_nn_binding = None
            session.set_image(image)
            session.set_target_buffer(torch.zeros(image.shape[1:], dtype=torch.uint8))
            for attr in ("preprocess_future", "interactions_future"):
                future = getattr(session, attr, None)
                if future is not None:
                    future.result(timeout=60)
                    setattr(session, attr, None)
            if session.preprocessed_image is None:
                raise RuntimeError("Image preprocessing did not complete")
            session._ohif_series_uid = series_uid
        except Exception as exc:
            session._ohif_series_uid = None
            logger.exception("nnInteractive source image preparation failed")
            raise ModelRuntimeError("nninteractive", "MODEL_UNAVAILABLE", "Image preprocessing failed; check backend logs before retrying.") from exc
    return changed
