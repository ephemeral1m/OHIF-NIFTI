#!/usr/bin/env python3
"""
Batch VoxTell Inference Pipeline
=================================
Processes pre-extracted LLM findings from batch_inference_results_v2.json.
For each patient with structured findings:
  1. Finds DICOM folder on disk, picks thinnest-slice CT series
  2. Uploads to Orthanc via REST API
  3. Runs VoxTell 3x per finding (en1, en2, en3)
  4. Merges via majority voting
  5. Saves merged NIfTI + JSON sidecar (exactly N masks per series = N findings)

Usage:
    # Dry run (resolve folders only, no upload/inference)
    python batch_voxtell_pipeline.py --dry-run

    # Single patient test
    python batch_voxtell_pipeline.py --patient-id 0001111762

    # Full run
    python batch_voxtell_pipeline.py

Requires:
    pip install requests numpy SimpleITK pydicom
"""

import argparse
import glob
import gzip
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests
import SimpleITK as sitk

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

DEFAULT_JSON_FILE = os.path.join(os.path.dirname(__file__), "..", "batch_inference_results_v2.json")
DEFAULT_DICOM_ROOT = "/media/ant/新加卷/lung_ct"
DEFAULT_ORTHANC_URL = "http://localhost:8042"
DEFAULT_MONAI_URL = "http://localhost:8002"
DEFAULT_NIFTI_SEGS_DIR = os.path.join(os.path.dirname(__file__), "monai-label", "nifti_segs")
MERGE_THRESHOLD = 0.5
VOXTELL_TIMEOUT = 300


# ---------------------------------------------------------------------------
# Step 1: Resolve DICOM folder
# ---------------------------------------------------------------------------

def resolve_dicom_folder(patient_id: str, dicom_root: str) -> Optional[Tuple[str, int]]:
    """Find the best CT series folder for a patient. Returns (series_path, num_slices)."""
    matches = glob.glob(os.path.join(dicom_root, f"*_{patient_id}"))
    if not matches:
        return None

    patient_dir = matches[0]

    # Find study subfolder (should be exactly one)
    study_dirs = [
        d for d in os.listdir(patient_dir)
        if os.path.isdir(os.path.join(patient_dir, d))
    ]
    if not study_dirs:
        logger.warning(f"No study folder in {patient_dir}")
        return None

    study_path = os.path.join(patient_dir, study_dirs[0])

    # Find all series subfolders, pick the one with most .dcm files
    best_series = None
    best_count = 0

    for series_name in os.listdir(study_path):
        series_path = os.path.join(study_path, series_name)
        if not os.path.isdir(series_path):
            continue
        lower = series_name.lower()
        if lower.endswith("dose info") or lower.endswith("dose report") or lower == "dose":
            continue

        dcm_count = len(glob.glob(os.path.join(series_path, "*.dcm")))
        if dcm_count <= 2:
            continue

        if dcm_count > best_count:
            best_count = dcm_count
            best_series = series_path

    if best_series is None:
        logger.warning(f"No valid CT series found in {study_path}")
        return None

    return best_series, best_count


# ---------------------------------------------------------------------------
# Step 2: Upload to Orthanc
# ---------------------------------------------------------------------------

def upload_series_to_orthanc(
    series_path: str,
    orthanc_url: str,
    auth: tuple,
) -> Tuple[str, str]:
    """Upload all .dcm files in a series to Orthanc. Returns (SeriesInstanceUID, StudyInstanceUID)."""
    dcm_files = sorted(glob.glob(os.path.join(series_path, "*.dcm")))
    if not dcm_files:
        raise ValueError(f"No .dcm files in {series_path}")

    parent_series_id = None
    parent_study_id = None
    uploaded = 0
    skipped = 0

    for i, dcm_path in enumerate(dcm_files):
        with open(dcm_path, "rb") as f:
            data = f.read()

        try:
            resp = requests.post(
                f"{orthanc_url}/instances",
                data=data,
                headers={"Content-Type": "application/dicom"},
                auth=auth,
                timeout=30,
            )
            resp.raise_for_status()
            result = resp.json()

            status = result.get("Status")
            if status in ("Success", "AlreadyStored"):
                if parent_series_id is None:
                    parent_series_id = result["ParentSeries"]
                    parent_study_id = result["ParentStudy"]
                uploaded += 1
                if status == "AlreadyStored":
                    skipped += 1
            else:
                logger.warning(f"  Unexpected status for {os.path.basename(dcm_path)}: {status}")

        except Exception as e:
            logger.warning(f"  Failed to upload {os.path.basename(dcm_path)}: {e}")

        if (i + 1) % 100 == 0:
            logger.info(f"  Uploaded {i + 1}/{len(dcm_files)} instances...")

    if parent_series_id is None:
        raise RuntimeError(f"All uploads failed for {series_path}")

    if skipped == uploaded:
        logger.info(f"  All {uploaded} instances already in Orthanc")
    else:
        logger.info(f"  Upload complete: {uploaded - skipped} new, {skipped} already stored")

    # Retrieve DICOM UIDs
    series_resp = requests.get(
        f"{orthanc_url}/series/{parent_series_id}", auth=auth, timeout=10
    ).json()
    series_uid = series_resp["MainDicomTags"]["SeriesInstanceUID"]

    study_resp = requests.get(
        f"{orthanc_url}/studies/{parent_study_id}", auth=auth, timeout=10
    ).json()
    study_uid = study_resp["MainDicomTags"]["StudyInstanceUID"]

    return series_uid, study_uid


# ---------------------------------------------------------------------------
# Step 3: VoxTell inference
# ---------------------------------------------------------------------------

def parse_monai_multipart(data: bytes, content_type: str) -> Tuple[dict, Optional[np.ndarray]]:
    """Parse gzip-compressed multipart response from MONAI Label."""
    boundary_match = re.search(r"boundary=([^\s;]+)", content_type)
    if not boundary_match:
        raise ValueError(f"No boundary in content-type: {content_type}")
    boundary = boundary_match.group(1).encode()

    parts = data.split(b"--" + boundary)
    meta = {}
    seg_data = None

    for part in parts:
        if b"Content-Type" not in part:
            continue

        header_end = part.find(b"\r\n\r\n")
        if header_end < 0:
            header_end = part.find(b"\n\n")
        if header_end < 0:
            continue
        body = part[header_end:].strip()

        if b"application/json" in part:
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            raw = json.loads(body)
            if isinstance(raw, str):
                meta = json.loads(raw)
            else:
                meta = raw

        elif b"application/octet-stream" in part:
            if body[:2] == b"\x1f\x8b":
                body = gzip.decompress(body)
            seg_data = np.frombuffer(body, dtype=np.uint8)

    return meta, seg_data


def call_voxtell_batch(
    series_uid: str,
    study_uid: str,
    text_prompts: List[str],
    monai_url: str,
    ref_shape: Tuple[int, ...],
) -> Tuple[Optional[dict], List[np.ndarray]]:
    """
    Call VoxTell with multiple text prompts in one request.
    Returns (meta_dict, list_of_3D_mask_arrays).
    The backend runs inference once for all prompts (single image load + sliding window).
    """
    url = f"{monai_url}/infer/segmentation"
    valid_prompts = [t for t in text_prompts if t]
    if not valid_prompts:
        return None, []

    params = {
        "largest_cc": False,
        "result_extension": ".nii.gz",
        "result_dtype": "uint16",
        "result_compress": False,
        "studyInstanceUID": study_uid,
        "restore_label_idx": False,
        "nninter": True,
        "texts": valid_prompts,
        "pos_points": [],
        "neg_points": [],
        "pos_boxes": [],
    }

    try:
        logger.info(f"    VoxTell batch call: {len(valid_prompts)} prompts")
        resp = requests.post(
            url,
            data={"params": json.dumps(params)},
            params={"image": series_uid, "output": "dicom_seg"},
            headers={"accept": "multipart/form-data"},
            timeout=VOXTELL_TIMEOUT * len(valid_prompts),
        )
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")
        if "multipart" not in content_type:
            logger.warning(f"VoxTell returned non-multipart: {content_type}")
            return None, []

        meta, seg = parse_monai_multipart(resp.content, content_type)

        num_masks = meta.get("num_masks") if meta else None
        mask_shape = tuple(meta.get("mask_shape", [])) if meta else None

        if seg is None:
            return meta, []

        if num_masks and mask_shape and num_masks > 1:
            expected_size = num_masks * np.prod(mask_shape)
            if seg.size == expected_size:
                masks = seg.reshape(num_masks, *mask_shape)
                result = [masks[i].astype(np.uint8) for i in range(num_masks)]
                for i, m in enumerate(result):
                    pos = int((m > 0).sum())
                    logger.info(f"    [prompt {i+1}] → {pos} positive voxels")
                return meta, result

        if seg.ndim == 1 and ref_shape and np.prod(ref_shape) == seg.size:
            logger.info(f"    Single mask response, reshaping to {ref_shape}")
            return meta, [seg.reshape(ref_shape).astype(np.uint8)]

        if seg.ndim == 3:
            return meta, [seg.astype(np.uint8)]

        logger.warning(f"    Unexpected seg shape {seg.shape}, size={seg.size}")
        return meta, []

    except requests.exceptions.Timeout:
        logger.error(f"VoxTell timed out for batch of {len(valid_prompts)} prompts")
        return None, []
    except Exception as e:
        logger.error(f"VoxTell batch failed: {e}")
        return None, []


# ---------------------------------------------------------------------------
# Step 4: Merge masks
# ---------------------------------------------------------------------------

def merge_masks(masks: List[np.ndarray], threshold: float = MERGE_THRESHOLD) -> Optional[np.ndarray]:
    """Merge multiple binary masks via majority voting."""
    if len(masks) == 0:
        return None
    if len(masks) == 1:
        return (masks[0] > 0).astype(np.uint8)

    stacked = np.stack([(m > 0).astype(np.float32) for m in masks], axis=0)
    vote_fraction = stacked.mean(axis=0)
    merged = (vote_fraction >= threshold).astype(np.uint8)

    logger.info(
        f"  Merged {len(masks)} masks: "
        f"union={int(np.any(stacked > 0, axis=0).sum())} voxels, "
        f"consensus(>={threshold:.0%})={int(merged.sum())} voxels"
    )
    return merged


# ---------------------------------------------------------------------------
# Step 5: Save merged NIfTI
# ---------------------------------------------------------------------------

def save_merged_nifti(
    mask_np: np.ndarray,
    reference_sitk: Optional[sitk.Image],
    series_uid: str,
    study_uid: str,
    finding: dict,
    finding_index: int,
    prompts_used: List[str],
    masks_collected: int,
    nifti_segs_dir: str,
    flipped: bool,
    threshold: float,
) -> str:
    """Save merged mask as NIfTI + JSON sidecar."""
    series_dir = os.path.join(nifti_segs_dir, series_uid)
    os.makedirs(series_dir, exist_ok=True)

    zh_label = finding.get("位置", "unknown")
    safe_name = re.sub(r"[^\w\s\-]", "", zh_label).strip().replace(" ", "_")[:40]
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    base_name = f"merged_{safe_name}_{timestamp}"

    nifti_path = os.path.join(series_dir, f"{base_name}.nii.gz")
    json_path = os.path.join(series_dir, f"{base_name}.json")

    mask_sitk = sitk.GetImageFromArray(mask_np)
    if reference_sitk is not None:
        mask_sitk.CopyInformation(reference_sitk)
    sitk.WriteImage(mask_sitk, nifti_path)

    en_label = finding.get("en1", finding.get("描述", ""))
    zh_label_full = finding.get("位置", "") + finding.get("描述", "")
    display_label = f"{en_label}\n{zh_label_full}"

    sidecar = {
        "algorithm": "batch_report",
        "label": display_label,
        "label_zh": zh_label_full,
        "series_uid": series_uid,
        "study_uid": study_uid,
        "created": datetime.now().isoformat(),
        "segments": {"1": display_label},
        "status": "draft",
        "flipped": flipped,
        "source": "batch_voxtell_pipeline",
        "finding_index": finding_index,
        "prompts_used": prompts_used,
        "masks_collected": masks_collected,
        "merge_threshold": threshold,
        "is_multifocal": finding.get("是否多发", "False"),
    }
    with open(json_path, "w") as f:
        json.dump(sidecar, f, indent=2, ensure_ascii=False)

    size_kb = os.path.getsize(nifti_path) / 1024
    logger.info(f"  Saved: {base_name}.nii.gz ({size_kb:.1f} KB, {int(mask_np.sum())} voxels)")
    return nifti_path


def get_reference_geometry(series_path: str) -> Tuple[Optional[sitk.Image], bool]:
    """Read DICOM series to get reference geometry and flipped flag."""
    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(series_path)
    if not dicom_files:
        return None, False

    reader.SetFileNames(dicom_files)
    img_sitk = reader.Execute()

    # Determine flipped flag from first two instance numbers
    flipped = False
    if len(dicom_files) >= 2:
        try:
            import pydicom
            ds0 = pydicom.dcmread(dicom_files[0], stop_before_pixels=True)
            ds1 = pydicom.dcmread(dicom_files[1], stop_before_pixels=True)
            n0 = getattr(ds0, "InstanceNumber", 0) or 0
            n1 = getattr(ds1, "InstanceNumber", 0) or 0
            flipped = int(n0) > int(n1)
        except Exception:
            pass

    return img_sitk, flipped


# ---------------------------------------------------------------------------
# Per-patient processing
# ---------------------------------------------------------------------------

def process_one_patient(
    entry: dict,
    dicom_root: str,
    orthanc_url: str,
    orthanc_auth: tuple,
    monai_url: str,
    nifti_segs_dir: str,
    threshold: float,
    dry_run: bool,
) -> dict:
    """Process one patient through the full pipeline."""
    patient_id = entry["patient_id"]
    name = entry.get("name", "")
    llm = entry.get("llm_response", {})

    result = {
        "patient_id": patient_id,
        "name": name,
        "findings_expected": 0,
        "masks_saved": 0,
        "errors": [],
    }

    if not llm.get("success", False):
        result["errors"].append("LLM extraction failed (success=false)")
        return result

    structured = llm.get("structured", [])
    result["findings_expected"] = len(structured)
    if not structured:
        logger.info(f"  No findings (normal study), skipping")
        return result

    # Step 1: Resolve DICOM folder
    resolved = resolve_dicom_folder(patient_id, dicom_root)
    if resolved is None:
        result["errors"].append(f"DICOM folder not found for {patient_id}")
        return result

    series_path, num_slices = resolved
    logger.info(f"  DICOM: {os.path.basename(series_path)} ({num_slices} slices)")

    if dry_run:
        for i, finding in enumerate(structured):
            logger.info(f"  Finding {i + 1}/{len(structured)}: {finding.get('位置', '?')} — {finding.get('en1', '')[:80]}")
        return result

    # Step 2: Upload to Orthanc
    try:
        series_uid, study_uid = upload_series_to_orthanc(series_path, orthanc_url, orthanc_auth)
        logger.info(f"  Series UID: {series_uid}")
        result["series_uid"] = series_uid
        result["study_uid"] = study_uid
    except Exception as e:
        result["errors"].append(f"Upload failed: {e}")
        return result

    # Get reference geometry for zero masks
    ref_sitk, flipped = get_reference_geometry(series_path)
    ref_shape = sitk.GetArrayFromImage(ref_sitk).shape if ref_sitk else None

    # Pre-create output directory so it's user-owned (not root from Docker auto-save)
    series_out = os.path.join(nifti_segs_dir, series_uid)
    os.makedirs(series_out, exist_ok=True)

    # Step 3-5: Process each finding
    for i, finding in enumerate(structured):
      try:
        en1 = finding.get("en1", "")
        en2 = finding.get("en2", "")
        en3 = finding.get("en3", "")
        prompts = [en1, en2, en3]
        location = finding.get("位置", "?")

        logger.info(f"  Finding {i + 1}/{len(structured)}: {location}")
        for j, p in enumerate(prompts):
            if p:
                logger.info(f"    [en{j+1}] '{p[:80]}...'")

        meta, masks_list = call_voxtell_batch(
            series_uid, study_uid, prompts, monai_url, ref_shape
        )

        if meta is not None:
            flipped_from_meta = meta.get("flipped", flipped)
            if isinstance(flipped_from_meta, str):
                flipped = flipped_from_meta.lower() == "true"
            else:
                flipped = bool(flipped_from_meta)

        masks = [m for m in masks_list if m is not None and m.ndim == 3 and m.any()]

        # Merge
        if masks:
            merged = merge_masks(masks, threshold)
        else:
            logger.warning(f"  All prompts returned empty — saving zero mask")
            if ref_sitk is not None:
                merged = np.zeros(sitk.GetArrayFromImage(ref_sitk).shape, dtype=np.uint8)
            elif ref_shape is not None:
                merged = np.zeros(ref_shape, dtype=np.uint8)
            else:
                result["errors"].append(f"Finding {i + 1}: no reference shape for zero mask")
                continue

        # Save merged
        save_merged_nifti(
            mask_np=merged,
            reference_sitk=ref_sitk,
            series_uid=series_uid,
            study_uid=study_uid,
            finding=finding,
            finding_index=i,
            prompts_used=prompts,
            masks_collected=len(masks),
            nifti_segs_dir=nifti_segs_dir,
            flipped=flipped,
            threshold=threshold,
        )
        result["masks_saved"] += 1
      except Exception as e:
        logger.error(f"  Finding {i + 1}/{len(structured)} failed: {e}", exc_info=True)
        result["errors"].append(f"Finding {i + 1} ({location}): {e}")
      finally:
        if i < len(structured) - 1:
            time.sleep(1)

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Batch VoxTell Inference Pipeline")
    parser.add_argument("--json-file", default=DEFAULT_JSON_FILE)
    parser.add_argument("--dicom-root", default=DEFAULT_DICOM_ROOT)
    parser.add_argument("--orthanc-url", default=DEFAULT_ORTHANC_URL)
    parser.add_argument("--monai-url", default=DEFAULT_MONAI_URL)
    parser.add_argument("--nifti-segs-dir", default=DEFAULT_NIFTI_SEGS_DIR)
    parser.add_argument("--orthanc-user", default="ohif")
    parser.add_argument("--orthanc-password", default=os.environ.get("MONAI_LABEL_DICOMWEB_PASSWORD", ""))
    parser.add_argument("--threshold", type=float, default=MERGE_THRESHOLD)
    parser.add_argument("--dry-run", action="store_true", help="Resolve folders only")
    parser.add_argument("--patient-id", default=None, help="Process only this patient")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--output-log", default=None)
    args = parser.parse_args()

    # Load JSON
    json_path = os.path.realpath(args.json_file)
    if not os.path.exists(json_path):
        logger.error(f"JSON file not found: {json_path}")
        sys.exit(1)

    with open(json_path) as f:
        all_entries = json.load(f)
    logger.info(f"Loaded {len(all_entries)} patients from {json_path}")

    # Filter
    entries = all_entries
    if args.patient_id:
        entries = [e for e in entries if e["patient_id"] == args.patient_id]
        logger.info(f"Filtered to patient {args.patient_id}: {len(entries)} entries")
    if args.limit:
        entries = entries[: args.limit]

    # Count findings
    total_findings = sum(
        len(e.get("llm_response", {}).get("structured", []))
        for e in entries
        if e.get("llm_response", {}).get("success", False)
    )
    logger.info(
        f"Will process {len(entries)} patients, "
        f"{total_findings} findings, "
        f"{total_findings * 3} VoxTell calls"
    )

    if not args.dry_run:
        # Connectivity checks
        try:
            requests.get(f"{args.orthanc_url}/system", auth=(args.orthanc_user, args.orthanc_password), timeout=5)
        except Exception as e:
            logger.error(f"Cannot reach Orthanc at {args.orthanc_url}: {e}")
            sys.exit(1)
        try:
            requests.get(f"{args.monai_url}/info/", timeout=5)
        except Exception as e:
            logger.error(f"Cannot reach MONAI Label at {args.monai_url}: {e}")
            sys.exit(1)

    # Process
    all_results = []
    auth = (args.orthanc_user, args.orthanc_password)

    for i, entry in enumerate(entries):
        pid = entry["patient_id"]
        name = entry.get("name", "")
        n_findings = len(entry.get("llm_response", {}).get("structured", []))
        success = entry.get("llm_response", {}).get("success", False)

        logger.info(f"\n{'=' * 60}")
        logger.info(f"[{i + 1}/{len(entries)}] {name} ({pid}) — {n_findings} findings, success={success}")
        logger.info(f"{'=' * 60}")

        result = process_one_patient(
            entry=entry,
            dicom_root=args.dicom_root,
            orthanc_url=args.orthanc_url,
            orthanc_auth=auth,
            monai_url=args.monai_url,
            nifti_segs_dir=args.nifti_segs_dir,
            threshold=args.threshold,
            dry_run=args.dry_run,
        )
        all_results.append(result)

        if result.get("errors"):
            for err in result["errors"]:
                logger.warning(f"  ERROR: {err}")

    # Summary
    logger.info(f"\n{'=' * 60}")
    logger.info("SUMMARY")
    logger.info(f"{'=' * 60}")
    logger.info(f"{'Patient':<20} {'Expected':>8} {'Saved':>6} {'Errors':>6}")
    logger.info(f"{'-' * 20} {'-' * 8} {'-' * 6} {'-' * 6}")
    for r in all_results:
        logger.info(
            f"{r['patient_id']:<20} {r['findings_expected']:>8} "
            f"{r.get('masks_saved', 0):>6} {len(r.get('errors', [])):>6}"
        )
    total_expected = sum(r["findings_expected"] for r in all_results)
    total_saved = sum(r.get("masks_saved", 0) for r in all_results)
    total_errors = sum(len(r.get("errors", [])) for r in all_results)
    logger.info(f"{'-' * 20} {'-' * 8} {'-' * 6} {'-' * 6}")
    logger.info(f"{'TOTAL':<20} {total_expected:>8} {total_saved:>6} {total_errors:>6}")

    # Save log
    log_path = args.output_log or f"batch_pipeline_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(log_path, "w") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    logger.info(f"\nLog saved to: {log_path}")


if __name__ == "__main__":
    main()
