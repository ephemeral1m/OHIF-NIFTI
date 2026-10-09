#!/usr/bin/env python3
"""
Report-to-Segmentation Pipeline
================================
1. Load report findings from report_dicom_bindings.json
2. Use LLM API to extract positive (abnormal) findings as structured descriptions
3. Use LLM API to augment each finding with multiple medical rephrasings
4. Call VoxTell inference API for each augmented description
5. Merge augmented results into one consensus mask per original finding
6. Save NIfTI masks named by the original positive description

Supported LLM providers:
    - anthropic  (Claude)           — pip install anthropic
    - openai     (GPT / o-series)   — pip install openai
    - openai-compatible             — any OpenAI-compatible endpoint (DeepSeek, Ollama, vLLM, etc.)

Usage:
    # Claude (default)
    ANTHROPIC_API_KEY=sk-ant-... python report_to_segmentation.py --dry-run --limit 5

    # OpenAI
    OPENAI_API_KEY=sk-... python report_to_segmentation.py --llm-provider openai --llm-model gpt-4o --dry-run

    # DeepSeek / any OpenAI-compatible endpoint
    python report_to_segmentation.py \
        --llm-provider openai-compatible \
        --llm-base-url https://api.deepseek.com/v1 \
        --llm-api-key sk-... \
        --llm-model deepseek-chat \
        --dry-run

    # Local Ollama
    python report_to_segmentation.py \
        --llm-provider openai-compatible \
        --llm-base-url http://localhost:11434/v1 \
        --llm-api-key ollama \
        --llm-model llama3 \
        --dry-run

    # Process specific patient
    python report_to_segmentation.py --patient-id 00694797

    # Full run
    python report_to_segmentation.py --orthanc-url http://localhost:8042 --monai-url http://localhost:8002

Requires:
    pip install requests numpy SimpleITK
    pip install anthropic   # if using --llm-provider anthropic
    pip install openai      # if using --llm-provider openai or openai-compatible
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
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

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_ORTHANC_URL = "http://localhost:8042"
DEFAULT_MONAI_URL = "http://localhost:8002"
DEFAULT_NIFTI_SEGS_DIR = "./monai-label/nifti_segs"  # host path (mounted as /code/nifti_segs)
NUM_AUGMENTATIONS = 3  # number of rephrasings per finding
MERGE_THRESHOLD = 0.5  # fraction of augmented runs that must agree for a voxel to be included


# ---------------------------------------------------------------------------
# Unified LLM Client
# ---------------------------------------------------------------------------

class LLMClient:
    """
    Unified wrapper for LLM APIs.
    Supports: anthropic, openai, openai-compatible (DeepSeek, Ollama, vLLM, etc.)
    """

    def __init__(self, provider: str, model: str, api_key: str = None, base_url: str = None):
        self.provider = provider
        self.model = model

        if provider == "anthropic":
            import anthropic
            self._client = anthropic.Anthropic(api_key=api_key)
        elif provider in ("openai", "openai-compatible"):
            import openai
            kwargs = {}
            if api_key:
                kwargs["api_key"] = api_key
            if base_url:
                kwargs["base_url"] = base_url
            self._client = openai.OpenAI(**kwargs)
        else:
            raise ValueError(f"Unknown LLM provider: {provider}")

    def chat(self, system: str, user: str, max_tokens: int = 1024) -> str:
        """Send a system + user message and return the assistant's text response."""
        if self.provider == "anthropic":
            response = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text.strip()
        else:
            # OpenAI / OpenAI-compatible
            response = self._client.chat.completions.create(
                model=self.model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            return response.choices[0].message.content.strip()

    @staticmethod
    def from_args(args) -> "LLMClient":
        """Create an LLMClient from parsed CLI arguments."""
        provider = args.llm_provider

        # Resolve API key: explicit flag > env var
        api_key = args.llm_api_key
        if not api_key:
            if provider == "anthropic":
                api_key = os.environ.get("ANTHROPIC_API_KEY")
            elif provider == "openai":
                api_key = os.environ.get("OPENAI_API_KEY")
            elif provider == "openai-compatible":
                api_key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY")

        if not api_key and provider != "openai-compatible":
            env_name = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"
            logger.error(f"No API key provided. Set --llm-api-key or {env_name}")
            sys.exit(1)

        # Resolve model: explicit flag > default per provider
        model = args.llm_model
        if not model:
            defaults = {
                "anthropic": "claude-sonnet-4-20250514",
                "openai": "gpt-4o",
                "openai-compatible": "gpt-4o",
            }
            model = defaults[provider]

        base_url = args.llm_base_url  # None for anthropic/openai (use SDK defaults)

        logger.info(f"LLM provider: {provider}, model: {model}" +
                     (f", base_url: {base_url}" if base_url else ""))
        return LLMClient(provider=provider, model=model, api_key=api_key, base_url=base_url)


# ---------------------------------------------------------------------------
# Step 0: Resolve DICOM series from Orthanc
# ---------------------------------------------------------------------------

def resolve_series_uid(patient_id: str, study_date: str, orthanc_url: str) -> Optional[str]:
    """Query Orthanc to find the CT series UID for a given patient + study date."""
    try:
        # Search for studies matching patient ID
        resp = requests.post(
            f"{orthanc_url}/tools/find",
            json={"Level": "Study", "Query": {"PatientID": patient_id}},
            timeout=30,
        )
        resp.raise_for_status()
        study_ids = resp.json()

        for study_id in study_ids:
            study_info = requests.get(f"{orthanc_url}/studies/{study_id}", timeout=10).json()
            orthanc_date = study_info.get("MainDicomTags", {}).get("StudyDate", "")
            # Normalize date formats: "20160830" vs "2016-08-30"
            normalized_date = study_date.replace("-", "")
            if orthanc_date == normalized_date:
                # Find the CT series in this study
                for series_id in study_info.get("Series", []):
                    series_info = requests.get(f"{orthanc_url}/series/{series_id}", timeout=10).json()
                    modality = series_info.get("MainDicomTags", {}).get("Modality", "")
                    if modality == "CT":
                        series_uid = series_info.get("MainDicomTags", {}).get("SeriesInstanceUID", "")
                        study_uid = study_info.get("MainDicomTags", {}).get("StudyInstanceUID", "")
                        if series_uid:
                            return series_uid, study_uid
        return None, None
    except Exception as e:
        logger.warning(f"Failed to resolve series for patient {patient_id}: {e}")
        return None, None


# ---------------------------------------------------------------------------
# Step 1: LLM — Extract positive findings from Chinese radiology report
# ---------------------------------------------------------------------------

EXTRACT_SYSTEM_PROMPT = """You are a medical NLP specialist. Given a Chinese radiology report conclusion,
extract ONLY the positive/abnormal findings. Ignore all normal/negative statements
(e.g., "未见明显...", "纹理清晰", "通畅", "对称", "居中", "未见...肿大").

For each positive finding, output a short English description suitable for a
text-prompted medical image segmentation model (VoxTell). The description should be
anatomically specific and describe what to segment.

Output JSON array of objects: [{"zh": "<original Chinese phrase>", "en": "<English segmentation prompt>"}]

If there are NO positive findings, output: []

Examples:
- "两下肺纹理增粗，双肺见散在斑片状高密度影" → [{"zh": "双肺散在斑片状高密度影", "en": "scattered patchy high-density opacities in bilateral lungs"}]
- "右肺上叶见单发磨玻璃结节影，大小约4mm" → [{"zh": "右肺上叶磨玻璃结节", "en": "ground-glass nodule in right upper lobe"}]
- "所示肝脏内见斑点状高密度影" → [{"zh": "肝脏斑点状高密度影", "en": "punctate high-density lesion in liver"}]"""


def extract_positive_findings(conclusion: str, llm: LLMClient) -> List[Dict[str, str]]:
    """Use LLM to extract positive findings from a Chinese radiology conclusion."""
    text = llm.chat(system=EXTRACT_SYSTEM_PROMPT, user=conclusion, max_tokens=1024)

    # Parse JSON from response (handle markdown code blocks)
    if "```" in text:
        match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
        if match:
            text = match.group(1)
    try:
        findings = json.loads(text)
        if not isinstance(findings, list):
            return []
        return [f for f in findings if isinstance(f, dict) and f.get("en")]
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse LLM extraction output: {text[:200]}")
        return []


# ---------------------------------------------------------------------------
# Step 2: LLM — Augment description with medical rephrasings
# ---------------------------------------------------------------------------

AUGMENT_SYSTEM_PROMPT = """You are a medical terminology expert. Given a radiological finding description
for a CT segmentation model, generate {n} alternative phrasings. Each rephrasing should:
- Use different but synonymous medical terminology
- Vary between formal radiology terms and clinical descriptions
- Keep the anatomical location and pathology type accurate
- Be suitable as a text prompt for a medical image segmentation model

Output a JSON array of strings. Do NOT include the original description.

Example input: "ground-glass nodule in right upper lobe"
Example output: ["GGO nodule in the right upper pulmonary lobe", "right upper lobe ground-glass opacity", "subsolid nodule right upper lobe"]"""


def augment_description(description: str, n: int, llm: LLMClient) -> List[str]:
    """Use LLM to generate n rephrasings of a segmentation description."""
    text = llm.chat(
        system=AUGMENT_SYSTEM_PROMPT.format(n=n),
        user=description,
        max_tokens=512,
    )

    if "```" in text:
        match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
        if match:
            text = match.group(1)
    try:
        rephrasings = json.loads(text)
        if isinstance(rephrasings, list):
            return [r for r in rephrasings if isinstance(r, str)][:n]
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse augmentation output: {text[:200]}")
    return []


# ---------------------------------------------------------------------------
# Step 3: Call VoxTell inference via MONAI Label HTTP API
# ---------------------------------------------------------------------------

def call_voxtell(
    series_uid: str,
    study_uid: str,
    text_prompt: str,
    monai_url: str,
) -> Optional[np.ndarray]:
    """
    Call VoxTell inference via the MONAI Label /infer/segmentation endpoint.
    Returns the segmentation mask as a numpy array, or None on failure.
    """
    url = f"{monai_url}/infer/segmentation"
    params = {
        "largest_cc": False,
        "result_extension": ".nii.gz",
        "result_dtype": "uint16",
        "result_compress": False,
        "studyInstanceUID": study_uid,
        "restore_label_idx": False,
        "nninter": False,
        "texts": [text_prompt],
        "pos_points": [],
        "neg_points": [],
        "pos_boxes": [],
    }

    form_data = {"params": json.dumps(params)}

    try:
        resp = requests.post(
            url,
            data=form_data,
            params={"image": series_uid, "output": "dicom_seg"},
            headers={"accept": "multipart/form-data"},
            timeout=300,
        )
        resp.raise_for_status()

        # Parse multipart response (same format as nninter)
        content_type = resp.headers.get("content-type", "")
        if "multipart" not in content_type:
            logger.warning(f"VoxTell returned non-multipart response: {content_type}")
            return None

        meta, seg_array = parse_monai_multipart(resp.content, content_type)
        return seg_array

    except requests.exceptions.Timeout:
        logger.error(f"VoxTell inference timed out for '{text_prompt}'")
        return None
    except Exception as e:
        logger.error(f"VoxTell inference failed for '{text_prompt}': {e}")
        return None


def parse_monai_multipart(data: bytes, content_type: str) -> Tuple[dict, np.ndarray]:
    """Parse the gzip-compressed multipart response from MONAI Label stream_multipart."""
    import gzip
    import io

    # Extract boundary from content-type
    boundary_match = re.search(r'boundary=([^\s;]+)', content_type)
    if not boundary_match:
        raise ValueError(f"No boundary in content-type: {content_type}")
    boundary = boundary_match.group(1).encode()

    parts = data.split(b"--" + boundary)
    meta = {}
    seg_data = None

    for part in parts:
        if b"Content-Type" not in part:
            continue

        if b"application/json" in part:
            # JSON metadata part
            header_end = part.find(b"\r\n\r\n")
            if header_end < 0:
                header_end = part.find(b"\n\n")
            json_bytes = part[header_end:].strip()
            # May be gzipped
            if json_bytes[:2] == b"\x1f\x8b":
                json_bytes = gzip.decompress(json_bytes)
            meta = json.loads(json_bytes)

        elif b"application/octet-stream" in part:
            # Binary segmentation part
            header_end = part.find(b"\r\n\r\n")
            if header_end < 0:
                header_end = part.find(b"\n\n")
            raw = part[header_end:].strip()
            # Likely gzipped
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            seg_data = np.frombuffer(raw, dtype=np.uint8)

    return meta, seg_data


# ---------------------------------------------------------------------------
# Step 4: Merge augmented masks via majority voting
# ---------------------------------------------------------------------------

def merge_masks(masks: List[np.ndarray], threshold: float = MERGE_THRESHOLD) -> np.ndarray:
    """
    Merge multiple binary masks via majority voting.
    A voxel is included if >= threshold fraction of masks have it as positive.
    """
    if len(masks) == 0:
        return None
    if len(masks) == 1:
        return (masks[0] > 0).astype(np.uint8)

    # Stack and vote
    stacked = np.stack([(m > 0).astype(np.float32) for m in masks], axis=0)
    vote_fraction = stacked.mean(axis=0)
    merged = (vote_fraction >= threshold).astype(np.uint8)

    logger.info(
        f"Merged {len(masks)} masks: "
        f"union={int(np.any(stacked > 0, axis=0).sum())} voxels, "
        f"consensus(>={threshold:.0%})={int(merged.sum())} voxels"
    )
    return merged


# ---------------------------------------------------------------------------
# Step 5: Save NIfTI mask to the nifti_segs store
# ---------------------------------------------------------------------------

def save_nifti_mask(
    mask: np.ndarray,
    series_uid: str,
    study_uid: str,
    finding_en: str,
    finding_zh: str,
    augmented_prompts: List[str],
    nifti_segs_dir: str,
    reference_nifti: Optional[sitk.Image] = None,
    monai_url: str = DEFAULT_MONAI_URL,
):
    """Save the merged mask as NIfTI via the nifti-segs API or directly to disk."""
    series_dir = os.path.join(nifti_segs_dir, series_uid)
    os.makedirs(series_dir, exist_ok=True)

    # Sanitize finding for filename (keep it readable)
    safe_name = re.sub(r'[^\w\s\-]', '', finding_en).strip().replace(' ', '_')[:80]
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    base_name = f"report_{safe_name}_{timestamp}"

    nifti_path = os.path.join(series_dir, f"{base_name}.nii.gz")
    json_path = os.path.join(series_dir, f"{base_name}.json")

    # Write NIfTI
    mask_sitk = sitk.GetImageFromArray(mask)
    if reference_nifti is not None:
        mask_sitk.CopyInformation(reference_nifti)
    sitk.WriteImage(mask_sitk, nifti_path)

    # Write sidecar
    sidecar = {
        "algorithm": "report_pipeline",
        "label": finding_en,
        "label_zh": finding_zh,
        "series_uid": series_uid,
        "study_uid": study_uid,
        "created": datetime.now().isoformat(),
        "segments": {"1": finding_en},
        "status": "auto_report",
        "source": "report_to_segmentation",
        "augmented_prompts": augmented_prompts,
        "merge_threshold": MERGE_THRESHOLD,
        "num_augmentations": len(augmented_prompts),
        "flipped": False,
    }
    with open(json_path, "w") as f:
        json.dump(sidecar, f, indent=2, ensure_ascii=False)

    logger.info(f"Saved: {nifti_path} ({os.path.getsize(nifti_path)} bytes)")
    return nifti_path


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_one_report(
    entry: dict,
    llm: LLMClient,
    orthanc_url: str,
    monai_url: str,
    nifti_segs_dir: str,
    dry_run: bool = False,
) -> dict:
    """Process a single report entry through the full pipeline."""
    patient_id = entry["patient_id"]
    study_date = entry["study_date"]
    reports = entry.get("reports", [])

    result = {
        "patient_id": patient_id,
        "study_date": study_date,
        "findings": [],
        "errors": [],
    }

    # Collect conclusions from all reports
    conclusions = []
    for r in reports:
        if r.get("diagnosis") == "阳性" and r.get("finding"):
            conclusions.append(r["finding"])

    if not conclusions:
        result["errors"].append("No positive diagnosis found")
        return result

    # Step 1: Extract positive findings
    all_findings = []
    for conclusion in conclusions:
        findings = extract_positive_findings(conclusion, llm)
        all_findings.extend(findings)

    if not all_findings:
        result["errors"].append("No positive findings extracted by LLM")
        return result

    logger.info(f"Patient {patient_id}: extracted {len(all_findings)} positive findings")
    for f in all_findings:
        logger.info(f"  - {f['en']} ({f['zh']})")

    if dry_run:
        result["findings"] = all_findings
        return result

    # Resolve series UID from Orthanc
    series_uid, study_uid = resolve_series_uid(patient_id, study_date, orthanc_url)
    if not series_uid:
        result["errors"].append(f"Could not resolve CT series in Orthanc for {patient_id}/{study_date}")
        return result
    logger.info(f"Resolved series: {series_uid}")

    # Process each finding
    for finding in all_findings:
        finding_en = finding["en"]
        finding_zh = finding.get("zh", "")

        # Step 2: Augment description
        augmented = augment_description(finding_en, NUM_AUGMENTATIONS, llm)
        all_prompts = [finding_en] + augmented  # original + augmented
        logger.info(f"  Finding '{finding_en}' → {len(all_prompts)} prompts (1 original + {len(augmented)} augmented)")

        # Step 3: Run VoxTell for each prompt
        masks = []
        for i, prompt in enumerate(all_prompts):
            logger.info(f"    [{i+1}/{len(all_prompts)}] VoxTell: '{prompt}'")
            mask = call_voxtell(series_uid, study_uid, prompt, monai_url)
            if mask is not None and mask.any():
                masks.append(mask)
                logger.info(f"    → {int((mask > 0).sum())} positive voxels")
            else:
                logger.warning(f"    → empty or failed")

            # Small delay to avoid hammering the GPU
            if i < len(all_prompts) - 1:
                time.sleep(1)

        if not masks:
            result["errors"].append(f"No valid masks for '{finding_en}'")
            continue

        # Step 4: Merge via majority voting
        merged = merge_masks(masks, MERGE_THRESHOLD)
        if merged is None or not merged.any():
            result["errors"].append(f"Merged mask is empty for '{finding_en}'")
            continue

        # Step 5: Save NIfTI
        saved_path = save_nifti_mask(
            mask=merged,
            series_uid=series_uid,
            study_uid=study_uid,
            finding_en=finding_en,
            finding_zh=finding_zh,
            augmented_prompts=all_prompts,
            nifti_segs_dir=nifti_segs_dir,
            monai_url=monai_url,
        )

        result["findings"].append({
            "en": finding_en,
            "zh": finding_zh,
            "prompts_used": all_prompts,
            "masks_collected": len(masks),
            "saved_path": saved_path,
        })

    return result


def main():
    parser = argparse.ArgumentParser(description="Report-to-Segmentation Pipeline")
    parser.add_argument("--report-file", default="report_dicom_bindings.json",
                        help="Path to report_dicom_bindings.json")
    parser.add_argument("--orthanc-url", default=DEFAULT_ORTHANC_URL)
    parser.add_argument("--monai-url", default=DEFAULT_MONAI_URL)
    parser.add_argument("--nifti-segs-dir", default=DEFAULT_NIFTI_SEGS_DIR,
                        help="Host path to nifti_segs directory")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process only first N positive reports")
    parser.add_argument("--patient-id", default=None,
                        help="Process only this patient ID")
    parser.add_argument("--dry-run", action="store_true",
                        help="Only extract findings (no VoxTell inference)")
    parser.add_argument("--augmentations", type=int, default=NUM_AUGMENTATIONS,
                        help=f"Number of augmented rephrasings per finding (default: {NUM_AUGMENTATIONS})")
    parser.add_argument("--threshold", type=float, default=MERGE_THRESHOLD,
                        help=f"Majority voting threshold (default: {MERGE_THRESHOLD})")
    parser.add_argument("--output-log", default=None,
                        help="Save processing log as JSON")

    # LLM provider options
    llm_group = parser.add_argument_group("LLM provider options")
    llm_group.add_argument("--llm-provider", default="anthropic",
                           choices=["anthropic", "openai", "openai-compatible"],
                           help="LLM provider (default: anthropic)")
    llm_group.add_argument("--llm-model", default=None,
                           help="Model name (default: claude-sonnet-4-20250514 / gpt-4o per provider)")
    llm_group.add_argument("--llm-api-key", default=None,
                           help="API key (overrides env var)")
    llm_group.add_argument("--llm-base-url", default=None,
                           help="Base URL for openai-compatible endpoints "
                                "(e.g. https://api.deepseek.com/v1, http://localhost:11434/v1)")

    args = parser.parse_args()

    global NUM_AUGMENTATIONS, MERGE_THRESHOLD
    NUM_AUGMENTATIONS = args.augmentations
    MERGE_THRESHOLD = args.threshold

    # Load reports
    report_path = Path(args.report_file)
    if not report_path.exists():
        # Try relative to script directory
        report_path = Path(__file__).parent / args.report_file
    if not report_path.exists():
        logger.error(f"Report file not found: {args.report_file}")
        sys.exit(1)

    with open(report_path) as f:
        all_entries = json.load(f)
    logger.info(f"Loaded {len(all_entries)} entries from {report_path}")

    # Filter positive reports
    positive_entries = [
        e for e in all_entries
        if any(r.get("diagnosis") == "阳性" for r in e.get("reports", []))
    ]
    logger.info(f"Found {len(positive_entries)} positive-diagnosis entries")

    if args.patient_id:
        positive_entries = [e for e in positive_entries if e["patient_id"] == args.patient_id]
        logger.info(f"Filtered to patient {args.patient_id}: {len(positive_entries)} entries")

    if args.limit:
        positive_entries = positive_entries[:args.limit]
        logger.info(f"Limited to first {args.limit} entries")

    # Initialize LLM client
    llm = LLMClient.from_args(args)

    # Process entries
    all_results = []
    total_findings = 0
    total_saved = 0

    for i, entry in enumerate(positive_entries):
        logger.info(f"\n{'='*60}")
        logger.info(f"[{i+1}/{len(positive_entries)}] Patient: {entry['patient_id']} ({entry['study_date']})")
        logger.info(f"{'='*60}")

        result = process_one_report(
            entry=entry,
            llm=llm,
            orthanc_url=args.orthanc_url,
            monai_url=args.monai_url,
            nifti_segs_dir=args.nifti_segs_dir,
            dry_run=args.dry_run,
        )
        all_results.append(result)

        n_findings = len(result.get("findings", []))
        n_saved = sum(1 for f in result.get("findings", []) if f.get("saved_path"))
        total_findings += n_findings
        total_saved += n_saved

        if result.get("errors"):
            for err in result["errors"]:
                logger.warning(f"  Error: {err}")

    # Summary
    logger.info(f"\n{'='*60}")
    logger.info(f"Pipeline complete:")
    logger.info(f"  Patients processed: {len(positive_entries)}")
    logger.info(f"  Total findings extracted: {total_findings}")
    logger.info(f"  Total masks saved: {total_saved}")
    logger.info(f"{'='*60}")

    # Save log
    log_path = args.output_log or f"pipeline_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    with open(log_path, "w") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    logger.info(f"Log saved to: {log_path}")


if __name__ == "__main__":
    main()
