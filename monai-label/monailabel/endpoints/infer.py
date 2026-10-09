# Copyright (c) MONAI Consortium
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import secrets
import logging
import os
import pathlib
import re
import shutil
import tempfile
import time
from enum import Enum
from datetime import date, datetime
from typing import Optional
from glob import glob as glob
import io
from copy import deepcopy
import gzip
import SimpleITK as sitk
import numpy as np

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, Response
from requests_toolbelt import MultipartEncoder

import pydicom
from pydicom.filereader import dcmread
from pydicom.sr.codedict import codes
from pydicom.uid import generate_uid

from monailabel.config import RBAC_USER, settings
from monailabel.datastore.dicom import DICOMWebDatastore
from monailabel.datastore.utils.convert import binary_to_image, nifti_to_dicom_seg, itk_image_to_dicom_seg
from monailabel.endpoints.user.auth import RBAC, User
from monailabel.interfaces.app import MONAILabelApp
from monailabel.interfaces.utils.app import app_instance
from monailabel.utils.others.generic import get_mime_type, remove_file
from monailabel.utils.others.stream import stream_multipart

from monailabel.datastore.utils.dicom import dicom_web_upload_dcm

logger = logging.getLogger(__name__)
_SERIES_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_series_uid(series_uid: str) -> str:
    if not series_uid or "/" in series_uid or "\\" in series_uid or ".." in series_uid:
        raise HTTPException(status_code=400, detail="Invalid series UID")
    if not _SERIES_RE.fullmatch(series_uid):
        raise HTTPException(status_code=400, detail="Invalid series UID")
    return series_uid

router = APIRouter(
    prefix="/infer",
    tags=["Infer"],
    responses={
        404: {"description": "Not found"},
        200: {
            "description": "OK",
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "points": {
                                "type": "string",
                                "description": "Reserved for future; Currently it will be empty",
                            },
                            "file": {
                                "type": "string",
                                "format": "binary",
                                "description": "The result NIFTI image which will have segmentation mask",
                            },
                        },
                    },
                    "encoding": {
                        "points": {"contentType": "text/plain"},
                        "file": {"contentType": "application/octet-stream"},
                    },
                },
                "application/json": {"schema": {"type": "string", "example": "{}"}},
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                "application/dicom": {"schema": {"type": "string", "format": "binary"}},
            },
        },
    },
)


class ResultType(str, Enum):
    image = "image"
    json = "json"
    all = "all"
    dicom_seg = "dicom_seg"


def send_response(datastore, result, output, background_tasks):
    res_img = result.get("file")
    res_json = result.get("params")

    if type(res_img) == str:
        if not os.path.exists(res_img):
            res_img = datastore.get_label_uri(res_img, res_tag)
        else:
            background_tasks.add_task(remove_file, res_img)

    if output == "json":
        return res_json
    if type(res_img) == str:
        m_type = get_mime_type(res_img)

    if output == "image":
        return FileResponse(res_img, media_type=m_type, filename=os.path.basename(res_img))

    if output == "dicom_seg":
        start = time.time()
        res_dicom_seg = result.get("dicom_seg")
        if res_dicom_seg is None:
            logger.info("No dicom_seg?")
            raise HTTPException(status_code=500, detail="Error processing inference")
        else:
            logger.info("File response!")
            if type(res_dicom_seg) != str:
                fields = {
                    "prompt_info": res_json.get("prompt_info"),
                    "flipped": res_json.get("flipped"),
                    "nninter_elapsed": res_json.get("nninter_elapsed"),
                    "voxtell_elapsed": res_json.get("voxtell_elapsed"),
                    "sam_elapsed": res_json.get("sam_elapsed"),
                    "label_name": res_json.get("label_name"),
                    "draft_filename": res_json.get("draft_filename"),
                    "num_masks": res_json.get("num_masks"),
                    "mask_shape": res_json.get("mask_shape"),
                    "text_prompts": res_json.get("text_prompts"),
                }
                return stream_multipart(fields, res_dicom_seg)
            else:
                logger.info("No prompt info?")
                return Response(res_dicom_seg, media_type="application/json")
            #return FileResponse(res_dicom_seg, media_type="application/dicom", filename=os.path.basename(res_dicom_seg))

    res_fields = dict()
    res_fields["params"] = (None, json.dumps(res_json), "application/json")
    if res_img and os.path.exists(res_img):
        res_fields["image"] = (os.path.basename(res_img), open(res_img, "rb"), m_type)
    else:
        logger.info(f"Return only Result Json as Result Image is not available: {res_img}")
        return res_json

    return_message = MultipartEncoder(fields=res_fields)
    return Response(content=return_message.to_string(), media_type=return_message.content_type)
def run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    output: Optional[ResultType] = None,
    nn_seed=None,
):
    request = {"model": model, "image": image}

    if not file and not image and not session_id:
        raise HTTPException(status_code=500, detail="Neither Image nor File not Session ID input is provided")

    from monailabel.utils.others.model_runtime import check_request
    p = json.loads(params) if params else {}
    check_request(p)  # Reject disabled features before resolving/downloading DICOM.
    if p.get('nninter') is True:
        from monailabel.utils.others.nn_context import validate_context
        validate_context(p.get('nn_context'), image)
    instance: MONAILabelApp = app_instance()

    if file:
        file_ext = "".join(pathlib.Path(file.filename).suffixes) if file.filename else ".nii.gz"
        image_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(image_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            request["image"] = image_file
            background_tasks.add_task(remove_file, image_file)

    if label:
        file_ext = "".join(pathlib.Path(label.filename).suffixes) if label.filename else ".nii.gz"
        label_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(label_file, "wb") as buffer:
            shutil.copyfileobj(label.file, buffer)
            background_tasks.add_task(remove_file, label_file)

        # if binary file received, e.g. scribbles from OHIF - then convert using reference image
        if file_ext == ".bin":
            image_uri = instance.datastore().get_image_uri(image)
            label_file = binary_to_image(image_uri, label_file)

        request["label"] = label_file

    config = instance.info().get("config", {}).get("infer", {})
    request.update(config)

    request.update(p)

    if session_id:
        session = instance.sessions().get_session(session_id)
        if session:
            request["image"] = session.image
            request["session"] = session.to_json()

    # Never accept a client-supplied local path. Own seed lifetime even if infer
    # fails; BackgroundTasks alone does not run on an exception response.
    request.pop('_nn_seed_file', None)
    seed_path = None
    try:
        if nn_seed is not None:
            from monailabel.utils.others.nn_context import MAX_SEED_BYTES, fail
            with tempfile.NamedTemporaryFile(suffix='.nn-seed.bin', delete=False) as seed_stream:
                seed_path = seed_stream.name
                total = 0
                while True:
                    chunk = nn_seed.file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_SEED_BYTES:
                        fail('NN_INVALID_SEED', 'Selected mask exceeds upload limit.', 413)
                    seed_stream.write(chunk)
            request['_nn_seed_file'] = seed_path
        logger.info('Infer model=%s image=%s request=%s', model, image,
                    p.get('nn_context', {}).get('requestId'))
        result = instance.infer(request)
    finally:
        if seed_path and os.path.exists(seed_path):
            os.unlink(seed_path)
    prompt_json = result['params']
    if result is None:
        raise HTTPException(status_code=500, detail="Failed to execute infer")

    # Dicom Seg Integration
    if output == "dicom_seg":
        dicom_seg_file = None
        if not isinstance(instance.datastore(), DICOMWebDatastore):
            raise HTTPException(status_code=500, detail="DICOM SEG format is not supported in a non-DICOM datastore")
        #elif p.get("label_info") is None:
        #    raise HTTPException(status_code=404, detail="Parameters for DICOM SEG inference cannot be empty!")
        # Transform image uri to id (similar to _to_id in local datastore)
        image_path = instance.datastore().get_image_uri(image)
        #suffixes = [".nii", ".nii.gz", ".nrrd"]
        #image_path = [image_uri.replace(suffix, "") for suffix in suffixes if image_uri.endswith(suffix)][0]
        res_img = result.get("file") if result.get("file") is not None else result.get("label")
        if type(res_img) == str:
            return Response(res_img, media_type="application/json")

        #dicom_seg_file = nifti_to_dicom_seg(image_path, res_img, prompt_json, use_itk=True)
        #with open(dicom_seg_file, "rb") as f:
        #    dicom_bytes = f.read()
        #result["dicom_seg"] = dicom_bytes
        res_json = result.get("params")
        fields = {
                    "prompt_info": res_json.get("prompt_info"),
                    "flipped": res_json.get("flipped"),
                    "nninter_elapsed": res_json.get("nninter_elapsed"),
                    "voxtell_elapsed": res_json.get("voxtell_elapsed"),
                    "sam_elapsed": res_json.get("sam_elapsed"),
                    "label_name": res_json.get("label_name"),
                    "draft_filename": res_json.get("draft_filename"),
                    "num_masks": res_json.get("num_masks"),
                    "mask_shape": res_json.get("mask_shape"),
                    "text_prompts": res_json.get("text_prompts"),
                    "nn_context": res_json.get("nn_context"),
                }
        return stream_multipart(fields, res_img)

    return send_response(instance.datastore(), result, output, background_tasks)

def read_seg_file(seg):
    """
    Reads a DICOM-SEG file and extracts the pixel array and segment metadata.
    """
    num_frames = seg.NumberOfFrames
    rows = seg.Rows
    columns = seg.Columns
    num_segments = len(seg.SegmentSequence)

    # Unpack PixelData
    pixel_array = np.unpackbits(np.frombuffer(seg.PixelData, dtype=np.uint8)).reshape(num_frames, rows, columns)

    # Get the SOPInstanceUIDs from ReferencedSeriesSequence
    referenced_instance_uids = [
        item.ReferencedSOPInstanceUID
        for item in seg.ReferencedSeriesSequence[0].ReferencedInstanceSequence
    ]
    # Reorganize pixel array by segment
    frames_per_segment = num_frames // num_segments

    # Filter out empty frames for each segment
    reduced_pixel_array = []
    filtered_frames = []
    total_frame_count=0
    for i in range(num_segments):
        # Extract frames for the current segment
        segment_frames = pixel_array[i * frames_per_segment:(i + 1) * frames_per_segment]
        
        for slice_index, frame in enumerate(segment_frames):
            if np.any(frame > 0):
                reduced_pixel_array.append(frame)
                if len(segment_frames) == len(referenced_instance_uids):
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, referenced_instance_uids[slice_index]))  # 1-based indexing
                else:
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, seg.PerFrameFunctionalGroupsSequence[total_frame_count].DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID))
                total_frame_count+=1
    reduced_pixel_array = np.stack(reduced_pixel_array)
    return reduced_pixel_array, filtered_frames, seg


def save_combined_segmentation(combined_pixel_array, all_segments, combined_frames, metadata_source):
    """
    Saves the combined segmentation as a new DICOM-SEG file by reusing metadata from existing files.
    """
    # Reuse metadata from the source
    combined_segmentation = metadata_source

    # Update metadata for combined segmentation
    combined_segmentation.NumberOfFrames = combined_pixel_array.shape[0]
    combined_segmentation.SegmentSequence = all_segments
    combined_segmentation.SeriesInstanceUID = generate_uid()
    
    # Update PerFrameFunctionalGroupsSequence
    new_per_frame_sequence = []
    for segment_index, slice_index, sop_instance_uid in combined_frames:
        frame = deepcopy(combined_segmentation.PerFrameFunctionalGroupsSequence[0])
        frame.FrameContentSequence[0].DimensionIndexValues = [segment_index, slice_index]
        frame.SegmentIdentificationSequence[0].ReferencedSegmentNumber = segment_index
        # Update ReferencedSOPInstanceUID in DerivationImageSequence
        frame.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID = sop_instance_uid
        new_per_frame_sequence.append(frame)
    combined_segmentation.PerFrameFunctionalGroupsSequence = new_per_frame_sequence

    # Pack the combined binary pixel array
    packed_pixel_data = np.packbits(combined_pixel_array.astype(np.uint8), axis=-1)
    combined_segmentation.PixelData = packed_pixel_data.tobytes()
    return combined_segmentation

@router.post("/save-nifti/{model}", summary="Save segmentation as NIfTI to training dataset store")
async def api_save_nifti(
    model: str,
    image: str = "",
    params: str = Form("{}"),
    labelmap: UploadFile = File(None),
):
    p = json.loads(params) if params else {}
    image = _safe_series_uid(image)

    # --- Get pred array ---
    if labelmap is not None:
        raw_bytes = await labelmap.read()
        labelmap_dtype = np.uint16 if str(p.get("labelmap_dtype", "uint8")).lower() == "uint16" else np.uint8
        pred_flat = np.frombuffer(raw_bytes, dtype=labelmap_dtype)
    else:
        from monailabel.tasks.infer.basic_infer import session
        if session.target_buffer is None:
            raise HTTPException(status_code=400, detail="No active segmentation in session")
        pred_flat = session.target_buffer.clone().numpy().astype(np.uint8).flatten()

    # --- Resolve source DICOM for geometry ---
    instance = app_instance()
    datastore = instance.datastore()
    if not isinstance(datastore, DICOMWebDatastore):
        raise HTTPException(status_code=400, detail="Save NIfTI requires a DICOM Web datastore")
    datastore._studyInstanceUID = p.get("studyInstanceUID", "")
    datastore.get_image_uri(image)
    image_dir = os.path.realpath(os.path.join(datastore._datastore.image_path(), image))
    logger.info(f"save-nifti: image_dir={image_dir}")

    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(str(image_dir))
    logger.info(f"save-nifti: {len(dicom_files)} DICOM files")
    reader.SetFileNames(dicom_files)
    img_sitk = reader.Execute()

    # Reshape flat buffer
    source_ds = pydicom.dcmread(dicom_files[0], stop_before_pixels=True)
    rows = int(source_ds.Rows)
    cols = int(source_ds.Columns)
    expected_voxels = len(dicom_files) * rows * cols
    if pred_flat.size != expected_voxels:
        raise HTTPException(
            status_code=400,
            detail=f"Labelmap voxel count mismatch: got {pred_flat.size}, expected {expected_voxels}",
        )
    pred = pred_flat.reshape((len(dicom_files), rows, cols))
    if not pred.any():
        raise HTTPException(status_code=400, detail="Segmentation is empty")

    # Build SimpleITK image with correct geometry
    pred_dtype = np.uint16 if int(pred.max()) > 255 else np.uint8
    pred_sitk = sitk.GetImageFromArray(pred.astype(pred_dtype))
    pred_sitk.CopyInformation(img_sitk)

    # Write NIfTI
    nifti_dir = os.path.join("/code/nifti_segs", image)
    os.makedirs(nifti_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    segments_meta = json.loads(p.get("segments", "[]"))
    import re
    seg_label = p.get("segmentationLabel", "").strip() or f"seg_{timestamp}"
    safe_label = re.sub(r'[\n\r/\\:\*\?"<>\|]', '_', seg_label)
    safe_label = re.sub(r'_+', '_', safe_label).strip('_ ')[:80] or "unknown"
    base_name = f"edited_{safe_label}_{timestamp}"
    nifti_path = os.path.join(nifti_dir, f"{base_name}.nii.gz")
    sitk.WriteImage(pred_sitk, nifti_path)

    # Write sidecar JSON
    segment_map = {}
    for s in segments_meta:
        segment_map[str(s.get("segmentIndex", 0))] = s.get("label", f"segment_{s.get('segmentIndex')}")
    sidecar = {
        "algorithm": "edited",
        "label": seg_label,
        "series_uid": image,
        "study_uid": p.get("studyInstanceUID", ""),
        "created": datetime.now().isoformat(),
        "segments": segment_map,
        "status": "edited",
        "source": "ohif_save_nifti",
        "flipped": bool(p.get("flipped", False)),
    }
    origins_raw = p.get("origins")
    if origins_raw:
        try:
            sidecar["origins"] = json.loads(origins_raw) if isinstance(origins_raw, str) else origins_raw
        except Exception:
            pass
    json_path = os.path.join(nifti_dir, f"{base_name}.json")
    with open(json_path, "w") as f:
        json.dump(sidecar, f, indent=2)

    logger.info(f"save-nifti: wrote {nifti_path} ({os.path.getsize(nifti_path)} bytes)")
    return {
        "filename": f"{base_name}.nii.gz",
        "series_uid": image,
        "label": seg_label,
        "n_segments": len(segment_map),
        "sidecar": sidecar,
    }


@router.post("/save/{model}", summary="Save segmentation to PACS as multi-class DICOM-SEG")
async def api_save_segmentation(
    model: str,
    image: str,
    params: str = Form("{}"),
    labelmap: UploadFile = File(None),
):
    import pydicom_seg as _pds
    p = json.loads(params) if params else {}
    image = _safe_series_uid(image)

    # --- Get pred array ---
    if labelmap is not None:
        # Primary path: frontend sends full multi-class labelmap (uint8, flat)
        raw_bytes = await labelmap.read()
        labelmap_dtype = np.uint16 if str(p.get("labelmap_dtype", "uint8")).lower() == "uint16" else np.uint8
        pred_flat = np.frombuffer(raw_bytes, dtype=labelmap_dtype)
    else:
        # Fallback: single-class from session buffer
        from monailabel.tasks.infer.basic_infer import session
        if session.target_buffer is None:
            raise HTTPException(status_code=400, detail="No active segmentation in session")
        pred_flat = session.target_buffer.clone().numpy().astype(np.uint8).flatten()

    # --- Setup datastore ---
    instance = app_instance()
    datastore = instance.datastore()
    if not isinstance(datastore, DICOMWebDatastore):
        raise HTTPException(status_code=400, detail="Save to PACS requires a DICOM Web datastore")
    datastore._studyInstanceUID = p.get("studyInstanceUID", "")
    datastore.get_image_uri(image)
    image_dir = os.path.realpath(os.path.join(datastore._datastore.image_path(), image))
    logger.info(f"save: image_dir={image_dir}")

    # Load DICOM geometry
    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(str(image_dir))
    logger.info(f"save: {len(dicom_files)} DICOM files")
    reader.SetFileNames(dicom_files)
    img_sitk = reader.Execute()

    source_datasets = [pydicom.dcmread(f, stop_before_pixels=True) for f in dicom_files]
    for ds in source_datasets:
        if hasattr(ds, 'SpecificCharacterSet'):
            ds.SpecificCharacterSet = 'ISO_IR 192'

    # Reshape flat buffer using source DICOM dimensions
    rows = int(source_datasets[0].Rows)
    cols = int(source_datasets[0].Columns)
    expected_voxels = len(dicom_files) * rows * cols
    if pred_flat.size != expected_voxels:
        raise HTTPException(
            status_code=400,
            detail=f"Labelmap voxel count mismatch: got {pred_flat.size}, expected {expected_voxels}",
        )
    pred = pred_flat.reshape((len(dicom_files), rows, cols))
    if not pred.any():
        raise HTTPException(status_code=400, detail="Segmentation is empty")

    from monailabel.utils.others.dicom_labelmap import order_labelmap_by_sop, dicom_description
    pred = order_labelmap_by_sop(pred, p.get('labelmap_sop_instance_uids'),
                                [str(ds.SOPInstanceUID) for ds in source_datasets])

    # k-direction fix (SimpleITK cross-product vs actual GDCM ascending z)
    direction = list(img_sitk.GetDirection())
    if len(source_datasets) >= 2:
        ipp0 = [float(x) for x in source_datasets[0].ImagePositionPatient]
        ipp1 = [float(x) for x in source_datasets[1].ImagePositionPatient]
        dz = [ipp1[i] - ipp0[i] for i in range(3)]
        dz_norm = float(np.linalg.norm(dz))
        if dz_norm > 1e-6:
            direction[6] = dz[0] / dz_norm
            direction[7] = dz[1] / dz_norm
            direction[8] = dz[2] / dz_norm
            logger.info(f"save: corrected k-direction from IPP diff: {direction[6:9]}")

    pred_sitk = sitk.GetImageFromArray(pred)
    pred_sitk.SetOrigin(img_sitk.GetOrigin())
    pred_sitk.SetSpacing(img_sitk.GetSpacing())
    pred_sitk.SetDirection(direction)
    mask_sitk = sitk.Cast(pred_sitk, sitk.sitkUInt16)

    # Build segment attributes for each unique non-zero label
    unique_labels = sorted(int(v) for v in np.unique(pred) if v > 0)
    if not unique_labels:
        raise HTTPException(status_code=400, detail="No non-zero segments found")

    segments_meta = json.loads(p.get("segments", "[]"))
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    series_label = p.get("segmentationLabel", "").strip() or f"seg_{timestamp}"

    segment_attributes = []
    for idx in unique_labels:
        m = next((s for s in segments_meta if s.get("segmentIndex") == idx), {})
        label = m.get("label", f"nninter_pred_{timestamp}_{idx}")
        alg_name = m.get("algorithmName", "nninter_0.0")
        rgb = [int(x) for x in np.random.random(size=3) * 256]
        segment_attributes.append({
            "labelID": idx,
            "SegmentLabel": label,
            "SegmentDescription": dicom_description(m.get("description", "")),
            "SegmentAlgorithmType": "AUTOMATIC",
            "SegmentAlgorithmName": alg_name,
            "SegmentedPropertyCategoryCodeSequence": {
                "CodeValue": "123037004", "CodingSchemeDesignator": "SCT",
                "CodeMeaning": "Anatomical Structure",
            },
            "SegmentedPropertyTypeCodeSequence": {
                "CodeValue": "78961009", "CodingSchemeDesignator": "SCT",
                "CodeMeaning": label,
            },
            "recommendedDisplayRGBValue": rgb,
        })

    # Build pydicom template Dataset directly (bypass dcmqi JSON schema
    # validation in from_dcmqi_metainfo which rejects valid inputs).
    template = pydicom.Dataset()
    template.ContentCreatorName = "Reader1"
    template.ClinicalTrialSeriesID = "Session1"
    template.ClinicalTrialTimePointID = "1"
    template.SeriesDescription = series_label
    template.SeriesNumber = "300"
    template.InstanceNumber = "1"
    template.ContentLabel = "SEGMENTATION"
    template.ContentDescription = "MONAI Label - Image segmentation"
    template.ClinicalTrialCoordinatingCenterName = "MONAI"
    template.BodyPartExamined = ""

    seg_datasets = []
    for attr in segment_attributes:
        seg_ds = pydicom.Dataset()
        seg_ds.SegmentNumber = attr["labelID"]
        seg_ds.SegmentAlgorithmType = attr.get("SegmentAlgorithmType", "AUTOMATIC")
        seg_ds.SegmentAlgorithmName = attr.get("SegmentAlgorithmName", "")
        if "SegmentLabel" in attr:
            seg_ds.SegmentLabel = attr["SegmentLabel"]
        if "SegmentDescription" in attr:
            seg_ds.SegmentDescription = attr["SegmentDescription"]
        for code_tag in ("SegmentedPropertyCategoryCodeSequence",
                         "SegmentedPropertyTypeCodeSequence"):
            code_data = attr[code_tag]
            code_ds = pydicom.Dataset()
            for k, v in code_data.items():
                setattr(code_ds, k, v)
            setattr(seg_ds, code_tag, pydicom.Sequence([code_ds]))
        if "recommendedDisplayRGBValue" in attr:
            seg_ds.RecommendedDisplayCIELabValue = _pds.template.rgb_to_cielab(
                attr["recommendedDisplayRGBValue"]
            )
        seg_datasets.append(seg_ds)
    template.SegmentSequence = pydicom.Sequence(seg_datasets)

    writer = _pds.MultiClassWriter(
        template=template, inplane_cropping=False,
        skip_empty_slices=True, skip_missing_segment=False,
    )

    dicom_seg_file = ""
    try:
        dcm = writer.write(mask_sitk, source_datasets)

        # Manually add ReferencedSeriesSequence (pydicom_seg v0.4.1 omits it)
        if not getattr(dcm, "ReferencedSeriesSequence", None) and source_datasets:
            from pydicom.dataset import Dataset as _DS
            from pydicom.sequence import Sequence as _Seq
            series_ds = _DS()
            series_ds.SeriesInstanceUID = source_datasets[0].SeriesInstanceUID
            ref_insts = []
            for src in source_datasets:
                ri = _DS()
                ri.ReferencedSOPClassUID = src.SOPClassUID
                ri.ReferencedSOPInstanceUID = src.SOPInstanceUID
                ref_insts.append(ri)
            series_ds.ReferencedInstanceSequence = _Seq(ref_insts)
            dcm.ReferencedSeriesSequence = _Seq([series_ds])

        dicom_seg_file = os.path.join(tempfile.gettempdir(), f"nninter_seg_{timestamp}.dcm")
        dcm.save_as(dicom_seg_file)
        if not os.path.exists(dicom_seg_file):
            raise HTTPException(status_code=500, detail="DICOM-SEG creation failed")

        series_uid = dicom_web_upload_dcm(dicom_seg_file, datastore._client)
    finally:
        if dicom_seg_file and os.path.exists(dicom_seg_file):
            os.unlink(dicom_seg_file)

    return {"series_uid": series_uid, "image": image,
            "label_name": series_label, "n_segments": len(unique_labels)}


@router.post("/{model}", summary=f"{RBAC_USER}Run Inference for supported model")
async def api_run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    nn_seed: UploadFile = File(None),
    output: Optional[ResultType] = None,
    user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_USER)),
):
    return run_inference(background_tasks, model, image, session_id, params, file, label, output, nn_seed)
