#!/usr/bin/env python3
"""
Generate test NIfTI drafts with CORRECT geometry and flip state.
Reads actual DICOM series to match orientation/spacing/origin exactly.
"""
import json
import os
from datetime import datetime, timedelta

import numpy as np
import SimpleITK as sitk
from pydicom import dcmread

NIFTI_SEGS_DIR = "/code/nifti_segs"
DICOM_CACHE = "/root/.cache/monailabel/dicom"


def find_dicom_dir(series_uid):
    """Find the cached DICOM directory for a series."""
    for root, dirs, files in os.walk(DICOM_CACHE):
        if series_uid in dirs:
            return os.path.join(root, series_uid)
    return None


def get_flip_state(dicom_dir):
    """Determine flipped state from first two DICOM files (same logic as basic_infer.py)."""
    reader = sitk.ImageSeriesReader()
    filenames = reader.GetGDCMSeriesFileNames(dicom_dir)
    if len(filenames) < 2:
        return False
    ds1 = dcmread(filenames[0], stop_before_pixels=True)
    ds2 = dcmread(filenames[1], stop_before_pixels=True)
    i1 = ds1[0x00200013].value if 0x00200013 in ds1 else 0
    i2 = ds2[0x00200013].value if 0x00200013 in ds2 else 0
    flipped = i1 > i2
    print(f"  InstanceNumber[0]={i1}, InstanceNumber[1]={i2}, flipped={flipped}")
    return flipped


def make_sphere_mask(shape, center, radii):
    z, y, x = np.ogrid[:shape[0], :shape[1], :shape[2]]
    dist = ((z - center[0]) / max(radii[0], 1)) ** 2 + \
           ((y - center[1]) / max(radii[1], 1)) ** 2 + \
           ((x - center[2]) / max(radii[2], 1)) ** 2
    return (dist <= 1.0).astype(np.uint8)


def generate_for_series(series_uid):
    print(f"\nSeries: {series_uid}")
    dicom_dir = find_dicom_dir(series_uid)
    if not dicom_dir:
        print("  DICOM dir not found in cache — skip (open this series in OHIF first)")
        return

    # Read DICOM image with SimpleITK (same as basic_infer.py)
    reader = sitk.ImageSeriesReader()
    filenames = reader.GetGDCMSeriesFileNames(dicom_dir)
    reader.SetFileNames(filenames)
    img_sitk = reader.Execute()
    img_np = sitk.GetArrayFromImage(img_sitk)
    nz, ny, nx = img_np.shape
    print(f"  Shape: {nz}x{ny}x{nx}")

    flipped = get_flip_state(dicom_dir)

    out_dir = os.path.join(NIFTI_SEGS_DIR, series_uid)
    # Clean old test drafts
    if os.path.isdir(out_dir):
        for f in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, f))
        print("  Cleaned old drafts")
    os.makedirs(out_dir, exist_ok=True)

    drafts = [
        {"label": "Liver", "algorithm": "voxtell",
         "center_frac": (0.55, 0.45, 0.35), "radii_frac": (0.08, 0.12, 0.10)},
        {"label": "Lung_nodule", "algorithm": "voxtell",
         "center_frac": (0.35, 0.40, 0.60), "radii_frac": (0.02, 0.015, 0.015), "radii_min": 3},
        {"label": "Spine", "algorithm": "body_seg",
         "center_frac": (0.50, 0.65, 0.50), "radii_frac": (0.15, 0.03, 0.025), "radii_min": 3},
    ]

    for i, d in enumerate(drafts):
        cf = d["center_frac"]
        rf = d["radii_frac"]
        rmin = d.get("radii_min", 1)
        center = (int(nz * cf[0]), int(ny * cf[1]), int(nx * cf[2]))
        radii = (max(int(nz * rf[0]), rmin), max(int(ny * rf[1]), rmin), max(int(nx * rf[2]), rmin))

        mask_np = make_sphere_mask((nz, ny, nx), center, radii)
        nonzero = int(np.count_nonzero(mask_np))

        # Create SimpleITK image with SAME geometry as source DICOM
        mask_sitk = sitk.GetImageFromArray(mask_np)
        mask_sitk.CopyInformation(img_sitk)  # copies spacing, origin, direction

        ts = datetime.now() - timedelta(hours=3 - i)
        base_name = f"{d['algorithm']}_{d['label']}_{ts.strftime('%Y%m%d%H%M%S')}"
        nifti_path = os.path.join(out_dir, f"{base_name}.nii.gz")
        json_path = os.path.join(out_dir, f"{base_name}.json")

        # Write NIfTI with correct geometry
        sitk.WriteImage(mask_sitk, nifti_path)

        # Write sidecar with correct flipped value
        sidecar = {
            "algorithm": d["algorithm"],
            "label": d["label"],
            "created": ts.isoformat(),
            "segments": {"1": d["label"]},
            "status": "draft",
            "flipped": flipped,
        }
        with open(json_path, "w") as f:
            json.dump(sidecar, f, indent=2)

        print(f"  {d['label']}: {nonzero} voxels, flipped={flipped}")

    # Verify by reading back
    for f in sorted(os.listdir(out_dir)):
        if f.endswith('.json'):
            with open(os.path.join(out_dir, f)) as fh:
                sc = json.load(fh)
            print(f"  Verify: {sc['label']} flipped={sc['flipped']}")


if __name__ == "__main__":
    # These series should already be cached from prior OHIF access
    series_list = [
        "1.2.392.200036.9116.2.5.1.48.1224104463.1623210381.600332",  # AI GUO QING
        "1.2.840.113704.1.111.4208.1546231231.11",                      # AI CHANG CAI
        "1.2.392.200036.9116.2.5.1.48.1224104463.1637296342.816910",  # AN XIU CUN
    ]
    for s in series_list:
        generate_for_series(s)
    print("\nDone!")
