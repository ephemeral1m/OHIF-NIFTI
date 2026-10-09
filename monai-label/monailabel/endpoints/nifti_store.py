import json
import logging
import os
import re
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Optional

import numpy as np
import SimpleITK as sitk
import torch
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from monailabel.utils.others.stream import stream_multipart
from monailabel.utils.others.source_image import read_source_dicom
from monailabel.utils.others.model_runtime import ModelRuntimeError, get_nn_session, nn_locked, prepare_nn_image

logger = logging.getLogger(__name__)

NIFTI_SEGS_DIR = "/code/nifti_segs"
_SERIES_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_LOCKS_GUARD = threading.Lock()
_DRAFT_LOCKS = {}

router = APIRouter(
    prefix="/nifti-segs",
    tags=["NIfTI Drafts"],
    responses={404: {"description": "Not found"}},
)


def _safe_series_uid(series_uid: str) -> str:
    if not series_uid or "/" in series_uid or "\\" in series_uid or ".." in series_uid:
        raise HTTPException(status_code=400, detail="Invalid series UID")
    if not _SERIES_RE.fullmatch(series_uid):
        raise HTTPException(status_code=400, detail="Invalid series UID")
    return series_uid


def _safe_filename(filename: str) -> str:
    if (
        not filename
        or os.path.basename(filename) != filename
        or "/" in filename
        or "\\" in filename
        or ".." in filename
        or not filename.endswith(".nii.gz")
    ):
        raise HTTPException(status_code=400, detail="Invalid draft filename")
    return filename


def _safe_path(*parts: str) -> str:
    root = os.path.realpath(NIFTI_SEGS_DIR)
    path = os.path.realpath(os.path.join(root, *parts))
    if path != root and not path.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="Invalid draft path")
    return path


def _series_dir(series_uid: str) -> str:
    return _safe_path(_safe_series_uid(series_uid))


@contextmanager
def _draft_lock(series_uid: str, origin: Optional[str] = None):
    key = (series_uid, origin or "__series__")
    with _LOCKS_GUARD:
        lock = _DRAFT_LOCKS.setdefault(key, threading.Lock())
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def _sanitize_for_filename(text: str, max_len: int = 80) -> str:
    import re
    safe = re.sub(r'[\n\r/\\:\*\?"<>\|]', '_', text)
    safe = re.sub(r'_+', '_', safe).strip('_ ')
    return safe[:max_len] if safe else "unknown"


def _read_sidecar(json_path: str) -> dict:
    with open(json_path, "r") as f:
        return json.load(f)


def _origin_is_label_only(series_dir: str, origin: str) -> bool:
    """Verify an existing lineage is label-only without trusting the client."""
    origin_path = os.path.join(series_dir, origin)
    sidecar_path = origin_path.replace(".nii.gz", ".json")

    if not os.path.isfile(origin_path):
        return False

    if os.path.isfile(sidecar_path):
        try:
            sidecar = _read_sidecar(sidecar_path)
            if "is_empty" in sidecar:
                return sidecar.get("is_empty") is True
        except Exception:
            logger.warning("Failed to inspect draft sidecar %s", sidecar_path, exc_info=True)

    try:
        origin_np = sitk.GetArrayFromImage(sitk.ReadImage(origin_path))
        return not np.any(origin_np)
    except Exception:
        logger.warning("Failed to inspect draft origin %s", origin_path, exc_info=True)
        return False


def _empty_save_is_allowed(series_dir: str, origin: Optional[str], allow_empty: bool) -> bool:
    return bool(allow_empty and origin and _origin_is_label_only(series_dir, origin))


@router.get("/{series_uid}", summary="List NIfTI drafts for a series")
async def list_drafts(series_uid: str):
    d = _series_dir(series_uid)
    if not os.path.isdir(d):
        return []
    results = []
    for fname in sorted(os.listdir(d)):
        if fname.endswith(".json"):
            try:
                sidecar = _read_sidecar(os.path.join(d, fname))
                sidecar["filename"] = fname.replace(".json", ".nii.gz")
                results.append(sidecar)
            except Exception:
                logger.warning(f"Failed to read sidecar {fname}", exc_info=True)
    return results


@router.get("/{series_uid}/{filename}", summary="Retrieve a NIfTI draft")
async def get_draft(series_uid: str, filename: str):
    d = _series_dir(series_uid)
    filename = _safe_filename(filename)
    nifti_path = os.path.join(d, filename)
    json_path = nifti_path.replace(".nii.gz", ".json")

    if not os.path.exists(nifti_path):
        raise HTTPException(status_code=404, detail=f"Draft not found: {filename}")

    # Read NIfTI as numpy array
    img_sitk = sitk.ReadImage(nifti_path)
    seg_np = sitk.GetArrayFromImage(img_sitk).astype(np.uint8)

    # Read sidecar
    sidecar = {}
    if os.path.exists(json_path):
        sidecar = _read_sidecar(json_path)

    if sidecar.get("algorithm") == "imported_ila":
        seg_np = (seg_np > 0).astype(np.uint8)

    # Build meta dict matching nninter response format
    meta = {
        "prompt_info": sidecar.get("segments", {}),
        "flipped": sidecar.get("flipped", False),
        "nninter_elapsed": 0.0,
        "sam_elapsed": 0.0,
        "label_name": sidecar.get("label", filename),
        "algorithm": sidecar.get("algorithm", "unknown"),
        "draft_filename": filename,
        "origin": sidecar.get("origin", None),
    }
    return stream_multipart(meta, seg_np)


@router.delete("/{series_uid}/{filename}", summary="Delete a NIfTI draft")
async def delete_draft(series_uid: str, filename: str):
    d = _series_dir(series_uid)
    filename = _safe_filename(filename)
    nifti_path = os.path.join(d, filename)
    json_path = nifti_path.replace(".nii.gz", ".json")

    deleted = []
    for p in [nifti_path, json_path]:
        if os.path.exists(p):
            os.remove(p)
            deleted.append(os.path.basename(p))

    if not deleted:
        raise HTTPException(status_code=404, detail=f"Draft not found: {filename}")
    return {"deleted": deleted}


@router.post("/{series_uid}", summary="Save a NIfTI draft (batch pipeline)")
async def save_draft(
    series_uid: str,
    params: str = Form("{}"),
    seg_data: UploadFile = File(...),
):
    p = json.loads(params) if params else {}
    series_uid = _safe_series_uid(series_uid)
    d = _series_dir(series_uid)
    os.makedirs(d, mode=0o777, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    label = p.get("label", "unknown")
    algorithm = _sanitize_for_filename(p.get("algorithm", "batch"), 32)
    origin = p.get("origin", None)
    if origin:
        origin = _safe_filename(origin)
    is_raw_binary = p.get("raw_binary", False)
    allow_empty = p.get("allow_empty") is True

    base_name = f"{algorithm}_{_sanitize_for_filename(label)}_{timestamp}"
    nifti_path = os.path.join(d, f"{base_name}.nii.gz")
    json_path = os.path.join(d, f"{base_name}.json")
    tmp_nifti_path = os.path.join(d, f".{base_name}.tmp.nii.gz")
    tmp_json_path = os.path.join(d, f".{base_name}.tmp.json")

    raw = await seg_data.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty segmentation payload")

    sidecar = {
        "algorithm": algorithm,
        "label": label,
        "created": datetime.now().isoformat(),
        "segments": p.get("segments", {"1": label}),
        "status": "draft",
        "flipped": p.get("flipped", False),
    }
    if origin:
        sidecar["origin"] = origin

    with _draft_lock(series_uid, origin):
        try:
            if is_raw_binary:
                # Reconstruct NIfTI from raw flat binary + source DICOM geometry
                from monailabel.interfaces.utils.app import app_instance

                datastore = app_instance().datastore()
                ref_sitk = read_source_dicom(datastore, series_uid, p.get("studyInstanceUID", ""))
                ref_shape = tuple(reversed(ref_sitk.GetSize()))
                expected_bytes = int(np.prod(ref_shape))
                if len(raw) != expected_bytes:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Segmentation byte count mismatch: got {len(raw)}, expected {expected_bytes}",
                    )
                seg_np = np.frombuffer(raw, dtype=np.uint8).reshape(ref_shape)
                seg_sitk = sitk.GetImageFromArray(seg_np)
                seg_sitk.CopyInformation(ref_sitk)
                sitk.WriteImage(seg_sitk, tmp_nifti_path)
            else:
                with open(tmp_nifti_path, "wb") as f:
                    f.write(raw)
                try:
                    seg_np = sitk.GetArrayFromImage(sitk.ReadImage(tmp_nifti_path))
                except HTTPException:
                    raise
                except Exception as exc:
                    raise HTTPException(status_code=400, detail=f"Invalid NIfTI payload: {exc}") from exc

            nonzero_voxels = int(np.count_nonzero(seg_np))
            is_empty = nonzero_voxels == 0
            if is_empty and not _empty_save_is_allowed(d, origin, allow_empty):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Empty segmentation is allowed only when updating an existing "
                        "label-only draft lineage"
                    ),
                )

            sidecar["is_empty"] = is_empty
            sidecar["nonzero_voxels"] = nonzero_voxels
            with open(tmp_json_path, "w") as f:
                json.dump(sidecar, f, indent=2)

            os.replace(tmp_nifti_path, nifti_path)
            os.replace(tmp_json_path, json_path)

            if origin:
                # Delete any previous refined draft with the same origin only after the
                # replacement has been committed successfully.
                for fname in os.listdir(d):
                    if not fname.endswith(".json") or fname == os.path.basename(json_path):
                        continue
                    try:
                        sc = _read_sidecar(os.path.join(d, fname))
                        if sc.get("origin") == origin:
                            old_nii = os.path.join(d, fname.replace(".json", ".nii.gz"))
                            old_json = os.path.join(d, fname)
                            for old_f in [old_nii, old_json]:
                                if os.path.exists(old_f):
                                    os.remove(old_f)
                                    logger.info(f"Removed previous refined draft: {old_f}")
                    except Exception:
                        logger.warning(f"Failed while pruning old refined draft {fname}", exc_info=True)
        finally:
            for tmp_path in (tmp_nifti_path, tmp_json_path):
                if os.path.exists(tmp_path):
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        logger.warning(f"Failed to remove temp draft file: {tmp_path}", exc_info=True)

    return {"filename": f"{base_name}.nii.gz", "sidecar": sidecar}


@router.post("/{series_uid}/load-session", summary="Load NIfTI draft into nnInteractive session")
async def load_session(
    series_uid: str,
    filename: str = Form(...),
    image: str = Form(...),
    studyInstanceUID: str = Form(""),
):
    # Keep execution on the event-loop/main thread: nnInteractive uses SIGALRM.
    return _load_session(series_uid, filename, image, studyInstanceUID)


@nn_locked
def _load_session(series_uid, filename, image, studyInstanceUID):
    from monailabel.interfaces.utils.app import app_instance

    series_uid = _safe_series_uid(series_uid)
    filename = _safe_filename(filename)
    image = _safe_series_uid(image)
    if image != series_uid:
        raise HTTPException(status_code=400, detail="Draft and source series must match")
    d = _series_dir(series_uid)
    nifti_path = os.path.join(d, filename)
    if not os.path.exists(nifti_path):
        raise HTTPException(status_code=404, detail=f"Draft not found: {filename}")

    session = get_nn_session()

    from monailabel.utils.others.nn_context import invalidate_context
    invalidate_context(session)  # Legacy draft sync may not claim a browser mask.

    # Load NIfTI
    seg_sitk = sitk.ReadImage(nifti_path)
    seg_np = (sitk.GetArrayFromImage(seg_sitk) > 0).astype(np.uint8)

    # Resolve source data without relying on an earlier AI initialization request.
    instance = app_instance()
    img_sitk = read_source_dicom(instance.datastore(), series_uid, studyInstanceUID)
    img_np = sitk.GetArrayFromImage(img_sitk)[None]
    if seg_np.shape != img_np.shape[1:]:
        raise HTTPException(status_code=400, detail="Draft dimensions do not match the source DICOM series")
    prepare_nn_image(session, series_uid, img_np)

    # Step 2: Use add_initial_seg_interaction — the CORRECT nnInteractive API.
    # This does (in order):
    #   a) reset_interactions() — zeros interactions tensor + target_buffer
    #   b) copies seg_np into target_buffer (original image coords)
    #   c) crops seg_np to preprocessed coords → writes into interactions[0] (channel -7)
    # This is what the network reads as "current segmentation state" during inference.
    logger.info(f"load-session: seg_np nonzero={int(np.count_nonzero(seg_np))}, shape={seg_np.shape}")
    try:
        session.add_initial_seg_interaction(seg_np, run_prediction=False)
    except Exception as exc:
        session._ohif_series_uid = None
        logger.exception("Could not restore nnInteractive draft session")
        raise ModelRuntimeError("nninteractive", "MODEL_UNAVAILABLE", "Draft is preserved, but AI session synchronization failed.") from exc

    # Verify state after add_initial_seg_interaction
    _tb_nz = 0
    _ch0_nz = 0
    if session.target_buffer is not None:
        _tb = session.target_buffer.numpy() if isinstance(session.target_buffer, torch.Tensor) else session.target_buffer
        _tb_nz = int(np.count_nonzero(_tb))
    if session.interactions is not None:
        _ch0 = session.interactions[0]
        _ch0 = _ch0.numpy() if isinstance(_ch0, torch.Tensor) else _ch0
        _ch0_nz = int(np.count_nonzero(_ch0))
    logger.info(f"load-session: AFTER add_initial_seg: target_buffer nonzero={_tb_nz}, interactions[0] nonzero={_ch0_nz}")

    # Update BasicInfer task instance state:
    # 1. Set _session_image so next nnInteractive call doesn't re-init the image
    # 2. Clear _session_used_interactions so new prompts aren't de-duplicated
    try:
        infer_tasks = instance._infers
        for task in infer_tasks.values():
            if hasattr(task, '_session_image'):
                task._session_image["seriesInstanceUID"] = series_uid
                # Clear interaction history so user's new points aren't skipped
                if hasattr(task, '_session_used_interactions'):
                    for key, lst in task._session_used_interactions.items():
                        lst.clear()
    except Exception:
        logger.warning("Could not update BasicInfer task instance", exc_info=True)

    logger.info(f"Loaded NIfTI draft into session: {filename}, shape={seg_np.shape}")
    return {"status": "ok", "filename": filename, "shape": list(seg_np.shape)}
