#!/usr/bin/env python3
"""
Standalone VoxTell Inference
============================
Run VoxTell text-prompted segmentation on DICOM or NIfTI inputs
without the MONAI Label backend.

Usage:
    # Single prompt on a DICOM series folder
    python standalone_voxtell.py --input /path/to/dicom_series/ --prompts "liver"

    # Multiple prompts on a NIfTI file
    python standalone_voxtell.py --input scan.nii.gz --prompts "liver" "spleen" "kidney"

    # Majority-vote merge of 3 prompt variants
    python standalone_voxtell.py --input /path/to/dicom/ \
        --prompts "liver lesion" "hepatic mass" "liver tumor" --merge

    # Custom output directory and model path
    python standalone_voxtell.py --input scan.nii.gz --prompts "lung nodule" \
        --output-dir ./results --model-dir ./checkpoints/voxtell_v1.1

Requires:
    pip install torch SimpleITK numpy pydicom huggingface_hub voxtell
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime
from typing import List, Optional, Tuple

import numpy as np
import SimpleITK as sitk
import torch

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_MODEL_DIR = os.path.join(os.path.dirname(__file__), "monai-label", "checkpoints")
DEFAULT_HF_REPO = "mrokuss/VoxTell"
DEFAULT_MODEL_NAME = "voxtell_v1.1"
MERGE_THRESHOLD = 0.5


def download_model(model_dir: str, model_name: str, hf_repo: str) -> str:
    """Download VoxTell weights from HuggingFace if not present."""
    model_path = os.path.join(model_dir, model_name)
    if os.path.isdir(model_path) and os.listdir(model_path):
        logger.info(f"Found existing weights at {model_path}")
        return model_path

    logger.info(f"Downloading VoxTell weights to {model_dir}...")
    from huggingface_hub import snapshot_download
    snapshot_download(
        repo_id=hf_repo,
        allow_patterns=[f"{model_name}/*", "*.json"],
        local_dir=model_dir,
    )
    logger.info("Download complete")
    return model_path


def load_dicom_series(dicom_dir: str) -> Tuple[sitk.Image, dict]:
    """Load a DICOM series and extract metadata."""
    reader = sitk.ImageSeriesReader()
    dicom_files = reader.GetGDCMSeriesFileNames(dicom_dir)
    if not dicom_files:
        raise FileNotFoundError(f"No DICOM files found in {dicom_dir}")

    reader.SetFileNames(dicom_files)
    img = reader.Execute()

    meta = {"source": dicom_dir, "format": "DICOM", "num_slices": len(dicom_files)}

    try:
        from pydicom import dcmread
        ds = dcmread(dicom_files[0], stop_before_pixels=True)
        meta["modality"] = getattr(ds, "Modality", "Unknown")
        meta["series_description"] = getattr(ds, "SeriesDescription", "")
        meta["series_uid"] = getattr(ds, "SeriesInstanceUID", "")

        if len(dicom_files) >= 2:
            ds2 = dcmread(dicom_files[1], stop_before_pixels=True)
            n0 = int(getattr(ds, "InstanceNumber", 0) or 0)
            n1 = int(getattr(ds2, "InstanceNumber", 0) or 0)
            meta["flipped"] = n0 > n1
    except ImportError:
        logger.warning("pydicom not installed — skipping DICOM metadata extraction")

    return img, meta


def load_nifti(nifti_path: str) -> Tuple[sitk.Image, dict]:
    """Load a NIfTI file."""
    img = sitk.ReadImage(nifti_path)
    meta = {"source": nifti_path, "format": "NIfTI"}
    return img, meta


def load_input(input_path: str) -> Tuple[sitk.Image, dict]:
    """Auto-detect and load DICOM series or NIfTI file."""
    if os.path.isdir(input_path):
        logger.info(f"Loading DICOM series from {input_path}")
        return load_dicom_series(input_path)
    elif input_path.endswith((".nii", ".nii.gz")):
        logger.info(f"Loading NIfTI from {input_path}")
        return load_nifti(input_path)
    else:
        raise ValueError(f"Unsupported input: {input_path} (provide a DICOM folder or .nii/.nii.gz file)")


def run_inference(
    img: sitk.Image,
    prompts: List[str],
    model_path: str,
    device: str = "cuda:0",
) -> Tuple[List[np.ndarray], float]:
    """Run VoxTell inference. Returns list of masks in original orientation + elapsed time."""
    from voxtell.inference.predictor import VoxTellPredictor

    torch_device = torch.device(device)
    logger.info(f"Initializing VoxTellPredictor on {device}")
    predictor = VoxTellPredictor(model_dir=model_path, device=torch_device)

    orig_orient = sitk.DICOMOrientImageFilter_GetOrientationFromDirectionCosines(
        img.GetDirection()
    )
    logger.info(f"Original orientation: {orig_orient}")

    img_ras = sitk.DICOMOrient(img, "RAS")
    img_np = sitk.GetArrayFromImage(img_ras)[None]  # (1, Z, Y, X)

    logger.info(f"Running inference: {len(prompts)} prompt(s), volume shape {img_np.shape[1:]}")
    t0 = time.time()
    seg_ras = predictor.predict_single_image(img_np, prompts)  # (N, Z, Y, X)
    elapsed = time.time() - t0
    logger.info(f"Inference complete in {elapsed:.1f}s")

    masks = []
    for k in range(seg_ras.shape[0]):
        seg_sitk_ras = sitk.GetImageFromArray(seg_ras[k])
        seg_sitk_ras.CopyInformation(img_ras)
        seg_sitk = sitk.DICOMOrient(seg_sitk_ras, orig_orient)
        masks.append(sitk.GetArrayFromImage(seg_sitk))

    return masks, elapsed


def merge_masks(masks: List[np.ndarray], threshold: float = MERGE_THRESHOLD) -> np.ndarray:
    """Majority-vote merge of multiple binary masks."""
    if len(masks) == 1:
        return (masks[0] > 0).astype(np.uint8)
    stacked = np.stack([(m > 0).astype(np.float32) for m in masks], axis=0)
    merged = (stacked.mean(axis=0) >= threshold).astype(np.uint8)
    logger.info(
        f"Merged {len(masks)} masks: "
        f"union={int(np.any(stacked > 0, axis=0).sum())} voxels, "
        f"consensus(>={threshold:.0%})={int(merged.sum())} voxels"
    )
    return merged


def save_output(
    mask: np.ndarray,
    ref_img: sitk.Image,
    prompt: str,
    output_dir: str,
    meta: dict,
    elapsed: float,
    is_merged: bool = False,
) -> str:
    """Save segmentation mask as NIfTI + JSON sidecar."""
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    safe_prompt = prompt.replace(" ", "_").replace("/", "-")[:60]
    prefix = "merged" if is_merged else "voxtell"
    base_name = f"{prefix}_{safe_prompt}_{timestamp}"

    nifti_path = os.path.join(output_dir, f"{base_name}.nii.gz")
    json_path = os.path.join(output_dir, f"{base_name}.json")

    mask_sitk = sitk.GetImageFromArray(mask)
    mask_sitk.CopyInformation(ref_img)
    sitk.WriteImage(mask_sitk, nifti_path)

    positive_voxels = int((mask > 0).sum())
    sidecar = {
        "algorithm": "voxtell_standalone",
        "label": prompt,
        "created": datetime.now().isoformat(),
        "segments": {"1": prompt},
        "elapsed_sec": round(elapsed, 2),
        "positive_voxels": positive_voxels,
        "source": meta.get("source", ""),
        "source_format": meta.get("format", ""),
        "series_uid": meta.get("series_uid", ""),
        "modality": meta.get("modality", ""),
        "flipped": meta.get("flipped", False),
        "merged": is_merged,
    }
    with open(json_path, "w") as f:
        json.dump(sidecar, f, indent=2, ensure_ascii=False)

    size_kb = os.path.getsize(nifti_path) / 1024
    logger.info(f"Saved: {nifti_path} ({size_kb:.1f} KB, {positive_voxels} voxels)")
    return nifti_path


def main():
    parser = argparse.ArgumentParser(
        description="Standalone VoxTell text-prompted segmentation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--input", required=True, help="DICOM series folder or NIfTI file path")
    parser.add_argument("--prompts", nargs="+", required=True, help="Text prompts for segmentation")
    parser.add_argument("--output-dir", default="./voxtell_output", help="Output directory (default: ./voxtell_output)")
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR, help="Directory containing model weights")
    parser.add_argument("--model-name", default=DEFAULT_MODEL_NAME, help="Model subdirectory name")
    parser.add_argument("--hf-repo", default=DEFAULT_HF_REPO, help="HuggingFace repo for weight download")
    parser.add_argument("--device", default="cuda:0", help="Torch device (default: cuda:0)")
    parser.add_argument("--merge", action="store_true", help="Merge all prompt masks via majority vote instead of saving separately")
    parser.add_argument("--merge-threshold", type=float, default=MERGE_THRESHOLD, help="Merge voting threshold (default: 0.5)")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        logger.error(f"Input not found: {args.input}")
        sys.exit(1)

    model_path = download_model(args.model_dir, args.model_name, args.hf_repo)
    img, meta = load_input(args.input)

    logger.info(f"Volume size: {img.GetSize()}, spacing: {[f'{s:.2f}' for s in img.GetSpacing()]}")

    masks, elapsed = run_inference(img, args.prompts, model_path, args.device)

    ref_img = img
    saved_paths = []

    if args.merge:
        merged = merge_masks(masks, args.merge_threshold)
        label = " + ".join(args.prompts)
        path = save_output(merged, ref_img, label, args.output_dir, meta, elapsed, is_merged=True)
        saved_paths.append(path)
    else:
        for i, (mask, prompt) in enumerate(zip(masks, args.prompts)):
            positive = int((mask > 0).sum())
            logger.info(f"Prompt {i+1}/{len(args.prompts)}: '{prompt}' → {positive} voxels")
            path = save_output(mask, ref_img, prompt, args.output_dir, meta, elapsed / len(masks))
            saved_paths.append(path)

    logger.info(f"\nDone. {len(saved_paths)} file(s) saved to {args.output_dir}")
    for p in saved_paths:
        logger.info(f"  {p}")


if __name__ == "__main__":
    main()
