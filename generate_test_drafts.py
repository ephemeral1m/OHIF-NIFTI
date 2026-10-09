#!/usr/bin/env python3
"""
Generate test NIfTI segmentation drafts for testing the Load Drafts feature.
Creates synthetic organ masks (spheres/ellipsoids) at realistic locations.
"""

import json
import os
import struct
from datetime import datetime, timedelta

import numpy as np
import requests

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
NIFTI_SEGS_DIR = os.environ.get("NIFTI_SEGS_DIR", "/code/nifti_segs")

# Target CT series to generate drafts for
TARGET_SERIES = [
    {
        "series_uid": "1.2.392.200036.9116.2.5.1.48.1224104463.1623210381.600332",
        "desc": "AI GUO QING - Lung 1.0 (382 slices)",
    },
    {
        "series_uid": "1.2.840.113704.1.111.4208.1546231231.11",
        "desc": "AI CHANG CAI (349 slices)",
    },
    {
        "series_uid": "1.2.392.200036.9116.2.5.1.48.1224104463.1637296342.816910",
        "desc": "AN XIU CUN - Lung 1.0 (388 slices)",
    },
]


def get_series_geometry(series_uid: str):
    """Get dimensions from Orthanc for a series."""
    # Find the Orthanc series ID
    resp = requests.post(
        f"{ORTHANC_URL}/tools/find",
        json={"Level": "Series", "Query": {"SeriesInstanceUID": series_uid}},
    )
    results = resp.json()
    if not results:
        print(f"  Series not found in Orthanc: {series_uid}")
        return None

    orthanc_id = results[0]
    series_info = requests.get(f"{ORTHANC_URL}/series/{orthanc_id}").json()
    instances = series_info.get("Instances", [])
    if not instances:
        return None

    # Get geometry from first instance
    inst_tags = requests.get(f"{ORTHANC_URL}/instances/{instances[0]}/simplified-tags").json()
    rows = int(inst_tags.get("Rows", 512))
    cols = int(inst_tags.get("Columns", 512))
    n_slices = len(instances)

    return {"rows": rows, "cols": cols, "slices": n_slices}


def make_sphere_mask(shape, center, radii):
    """Create an ellipsoid mask."""
    z, y, x = np.ogrid[: shape[0], : shape[1], : shape[2]]
    dist = (
        ((z - center[0]) / radii[0]) ** 2
        + ((y - center[1]) / radii[1]) ** 2
        + ((x - center[2]) / radii[2]) ** 2
    )
    return (dist <= 1.0).astype(np.uint8)


def write_nifti_gz(data: np.ndarray, path: str):
    """Write a minimal NIfTI-1 .nii.gz file from a numpy uint8 array."""
    import gzip

    nz, ny, nx = data.shape
    # NIfTI-1 header: 348 bytes
    header = bytearray(348)
    # sizeof_hdr
    struct.pack_into("<i", header, 0, 348)
    # dim: [3, nx, ny, nz, 1, 1, 1, 1]
    struct.pack_into("<8h", header, 40, 3, nx, ny, nz, 1, 1, 1, 1)
    # datatype = 2 (uint8), bitpix = 8
    struct.pack_into("<h", header, 70, 2)
    struct.pack_into("<h", header, 72, 8)
    # pixdim: [1, 1, 1, 1, ...]
    struct.pack_into("<8f", header, 76, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0)
    # vox_offset: 352 (header + 4 byte extension)
    struct.pack_into("<f", header, 108, 352.0)
    # magic: "n+1\0"
    header[344:348] = b"n+1\x00"

    # Extension: 4 zero bytes
    ext = b"\x00\x00\x00\x00"

    # Data in Fortran order (NIfTI convention: x varies fastest)
    raw_data = np.asfortranarray(data).tobytes()

    with gzip.open(path, "wb") as f:
        f.write(bytes(header))
        f.write(ext)
        f.write(raw_data)


def generate_drafts_for_series(series_uid: str, desc: str):
    """Generate 2-3 synthetic drafts for a series."""
    print(f"\nProcessing: {desc}")
    print(f"  SeriesUID: {series_uid}")

    geom = get_series_geometry(series_uid)
    if geom is None:
        print("  SKIPPED - could not get geometry")
        return

    nz, ny, nx = geom["slices"], geom["rows"], geom["cols"]
    print(f"  Dimensions: {nz} x {ny} x {nx}")

    out_dir = os.path.join(NIFTI_SEGS_DIR, series_uid)
    os.makedirs(out_dir, exist_ok=True)

    # Draft 1: "Liver" - large ellipsoid in right side of abdomen
    center1 = (int(nz * 0.55), int(ny * 0.45), int(nx * 0.35))
    radii1 = (int(nz * 0.08), int(ny * 0.12), int(nx * 0.10))
    mask1 = make_sphere_mask((nz, ny, nx), center1, radii1)
    nonzero1 = int(np.count_nonzero(mask1))
    ts1 = datetime.now() - timedelta(hours=3)

    name1 = f"voxtell_Liver_{ts1.strftime('%Y%m%d%H%M%S')}"
    write_nifti_gz(mask1, os.path.join(out_dir, f"{name1}.nii.gz"))
    sidecar1 = {
        "algorithm": "voxtell",
        "label": "Liver",
        "created": ts1.isoformat(),
        "segments": {"1": "Liver"},
        "status": "draft",
        "flipped": False,
    }
    with open(os.path.join(out_dir, f"{name1}.json"), "w") as f:
        json.dump(sidecar1, f, indent=2)
    print(f"  Draft 1: Liver ({nonzero1} voxels)")

    # Draft 2: "Lung nodule" - small sphere
    center2 = (int(nz * 0.35), int(ny * 0.40), int(nx * 0.60))
    radii2 = (int(nz * 0.02) + 2, int(ny * 0.015) + 2, int(nx * 0.015) + 2)
    mask2 = make_sphere_mask((nz, ny, nx), center2, radii2)
    nonzero2 = int(np.count_nonzero(mask2))
    ts2 = datetime.now() - timedelta(hours=1, minutes=30)

    name2 = f"voxtell_Lung_nodule_{ts2.strftime('%Y%m%d%H%M%S')}"
    write_nifti_gz(mask2, os.path.join(out_dir, f"{name2}.nii.gz"))
    sidecar2 = {
        "algorithm": "voxtell",
        "label": "Lung nodule",
        "created": ts2.isoformat(),
        "segments": {"1": "Lung nodule"},
        "status": "draft",
        "flipped": False,
    }
    with open(os.path.join(out_dir, f"{name2}.json"), "w") as f:
        json.dump(sidecar2, f, indent=2)
    print(f"  Draft 2: Lung nodule ({nonzero2} voxels)")

    # Draft 3: "Spine" - elongated vertical ellipsoid
    center3 = (int(nz * 0.50), int(ny * 0.65), int(nx * 0.50))
    radii3 = (int(nz * 0.15), int(ny * 0.03) + 2, int(nx * 0.025) + 2)
    mask3 = make_sphere_mask((nz, ny, nx), center3, radii3)
    nonzero3 = int(np.count_nonzero(mask3))
    ts3 = datetime.now() - timedelta(minutes=45)

    name3 = f"batch_Spine_{ts3.strftime('%Y%m%d%H%M%S')}"
    write_nifti_gz(mask3, os.path.join(out_dir, f"{name3}.nii.gz"))
    sidecar3 = {
        "algorithm": "body_seg",
        "label": "Spine",
        "created": ts3.isoformat(),
        "segments": {"1": "Spine"},
        "status": "draft",
        "flipped": False,
    }
    with open(os.path.join(out_dir, f"{name3}.json"), "w") as f:
        json.dump(sidecar3, f, indent=2)
    print(f"  Draft 3: Spine ({nonzero3} voxels)")

    print(f"  Saved 3 drafts to {out_dir}")


if __name__ == "__main__":
    print("Generating test NIfTI drafts...")
    for target in TARGET_SERIES:
        generate_drafts_for_series(target["series_uid"], target["desc"])

    print("\n--- Verifying ---")
    for root, dirs, files in os.walk(NIFTI_SEGS_DIR):
        nifti_count = len([f for f in files if f.endswith(".nii.gz")])
        json_count = len([f for f in files if f.endswith(".json")])
        if nifti_count > 0:
            rel = os.path.relpath(root, NIFTI_SEGS_DIR)
            print(f"  {rel}: {nifti_count} NIfTI + {json_count} JSON")

    print("\nDone! Test the API with:")
    for target in TARGET_SERIES:
        uid = target["series_uid"]
        print(f"  curl http://localhost:8002/monai/nifti-segs/{uid}")
