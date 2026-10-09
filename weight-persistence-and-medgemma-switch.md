# Weight Persistence & MedGemma Switch — Change Record

## Context

The OHIF-AI stack runs three AI backends in `monai_sam2`:
- **SAM2 / MedSAM2 / SAM3** — checkpoint weights baked into the Docker image at build time via `wget`
- **nnInteractive** — weights downloaded from HuggingFace at container startup (runtime)
- **VoxTell** — weights downloaded from HuggingFace at container startup (runtime)
- **MedGemma** — 35 GB LLM downloaded from HuggingFace at container startup (runtime)

Before these changes, `/code/checkpoints` had no volume mount, so every container
restart re-downloaded nnInteractive and VoxTell, and always loaded MedGemma
(wasting GPU memory and startup time even when not needed).

---

## Files Modified

### 1. `docker-compose.yml`

**Added** two volume mounts and one environment variable to the `monai_sam2` service:

```yaml
volumes:
  - ./monai-label/predictions:/code/predictions
  - ./monai-label/checkpoints:/code/checkpoints        # NEW
  - ./monai-label/hf_cache:/root/.cache/huggingface   # NEW
environment:
  - CUDA_VISIBLE_DEVICES=0
  - NVIDIA_VISIBLE_DEVICES=all
  - NVIDIA_DRIVER_CAPABILITIES=all
  - ENABLE_MEDGEMMA=false                              # NEW
```

**Important:** the volume mount for `checkpoints` shadows the image's baked-in
`/code/checkpoints/` directory. This means SAM2 (`sam2.1_hiera_tiny.pt`) and
MedSAM2 (`MedSAM2_latest.pt`) — which are downloaded by the Dockerfile at build
time — become invisible inside the container once the mount is active. These two
files must be present on the **host** side of the mount before starting the
container. See "Recovering weights from a stopped/running container" below.

---

### 2. `monai-label/monailabel/tasks/infer/basic_infer.py`

#### Change A — nnInteractive skip-if-exists (was lines 89–93)

```python
# Before
download_path = snapshot_download(repo_id=REPO_ID, allow_patterns=[...], local_dir=DOWNLOAD_DIR)

# After
model_local_path = os.path.join(DOWNLOAD_DIR, MODEL_NAME)
if not os.path.isdir(model_local_path) or not os.listdir(model_local_path):
    print(f"Downloading nnInteractive weights to {model_local_path}...")
    snapshot_download(repo_id=REPO_ID, allow_patterns=[...], local_dir=DOWNLOAD_DIR)
else:
    print(f"Found existing nnInteractive weights at {model_local_path}, skipping download.")
```

#### Change B — VoxTell skip-if-exists (was lines 97–101)

```python
# Before
vox_download_path = snapshot_download(repo_id="mrokuss/VoxTell", allow_patterns=[...], local_dir=DOWNLOAD_DIR)

# After
vox_local_path = os.path.join(DOWNLOAD_DIR, VOX_MODEL_NAME)
if not os.path.isdir(vox_local_path) or not os.listdir(vox_local_path):
    print(f"Downloading VoxTell weights to {vox_local_path}...")
    snapshot_download(repo_id="mrokuss/VoxTell", allow_patterns=[...], local_dir=DOWNLOAD_DIR)
else:
    print(f"Found existing VoxTell weights at {vox_local_path}, skipping download.")
```

#### Change C — MedGemma ENABLE_MEDGEMMA guard (was lines 141–154)

```python
# Before — always loaded unconditionally
gem_model_kwargs = dict(dtype=torch.bfloat16, device_map="auto", offload_buffers=True)
gem_processor = transformers.AutoProcessor.from_pretrained(gem_model_id, use_fast=True, **gem_model_kwargs)
gem_model = transformers.AutoModelForImageTextToText.from_pretrained(gem_model_id, **gem_model_kwargs)

# After
ENABLE_MEDGEMMA = os.environ.get("ENABLE_MEDGEMMA", "true").lower() == "true"
gem_processor = None
gem_model = None
if ENABLE_MEDGEMMA:
    gem_model_kwargs = dict(dtype=torch.bfloat16, device_map="auto", offload_buffers=True)
    gem_processor = transformers.AutoProcessor.from_pretrained(gem_model_id, use_fast=True, **gem_model_kwargs)
    gem_model = transformers.AutoModelForImageTextToText.from_pretrained(gem_model_id, **gem_model_kwargs)
else:
    print("MedGemma is disabled (ENABLE_MEDGEMMA=false). Skipping download and loading.")
```

#### Change D — MedGemma inference guard (line ~560)

Early-return with a clear error message when `gem_model is None`:

```python
if nnInter == "medGemma":
    if gem_model is None:
        logger.warning("MedGemma is disabled. Set ENABLE_MEDGEMMA=true in docker-compose.yml and restart.")
        return "MedGemma is disabled. ...", final_result_json
    if len(data['texts'])==1 ...  # existing code unchanged
```

---

### 3. `.gitignore`

Added `monai-label/hf_cache/` alongside the existing `monai-label/checkpoints/*` entry
to prevent committing large HuggingFace cache files.

---

## Behaviour After Changes

| Scenario | nnInteractive / VoxTell | MedGemma |
|---|---|---|
| First launch | Downloads to host-mounted dir | Downloads if `ENABLE_MEDGEMMA=true` |
| Relaunch (weights exist) | Skips download, loads from disk | Loads from HF cache on host dir |
| `ENABLE_MEDGEMMA=false` (default) | Unaffected | Not downloaded, not loaded; inference returns clear error |

---

## Recovering Weights from a Stopped/Running Container

If the container already has weights and you add the volume mount after the fact,
the mount will shadow the image's baked-in files. Copy them out first:

```bash
# Works on both running and stopped containers (as long as not removed)
mkdir -p ./monai-label/checkpoints
docker cp monai_sam2:/code/checkpoints/. ./monai-label/checkpoints/
```

If the container was removed, the runtime-downloaded weights (nnInteractive, VoxTell)
are lost and must be re-downloaded. The build-time weights (SAM2, MedSAM2) can be
fetched directly — these are the same URLs the Dockerfile uses:

```bash
cd ./monai-label/checkpoints
wget https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt
wget https://huggingface.co/wanglab/MedSAM2/resolve/main/MedSAM2_latest.pt
```

---

## Architecture Exploration: nnInteractive vs MedGemma

These two features are **completely independent**. They share the same dispatch
variable (`nnInter = data['nninter']`) but operate in separate `if` branches that
each return early, never reaching the other's code.

| `nnInter` value | What runs |
|---|---|
| `"reset"` | Clears nnInteractive session state |
| `"init"` | Loads image into nnInteractive session |
| `"medGemma"` | MedGemma report generation only |
| anything else | VoxTell (if text prompt) or nnInteractive (point/bbox/lasso/scribble) |

Setting `ENABLE_MEDGEMMA=false` has **zero effect** on nnInteractive segmentation.

---

## Architecture Exploration: Where Segmentation Results Are Stored

**Segmentation results are never written to disk.** The pipeline is fully in-memory:

```
session.target_buffer.clone()   →  GPU tensor
  .numpy()                       →  numpy ndarray (RAM)
  returned as result["file"]     →  misleadingly named, it IS a numpy array
  stream_multipart()             →  gzip-compressed on-the-fly → StreamingResponse to OHIF
```

The commented-out `sitk.WriteImage(...)` calls in `basic_infer.py` (lines 976, 1231)
confirm disk writing was intentionally disabled.

`/code/predictions/` is only used for **sentinel placeholder paths** on control
branches (reset, init, error), not for actual segmentation output.

### Key files in the segmentation pipeline

| File | Role |
|---|---|
| `monailabel/tasks/infer/basic_infer.py` | Main inference logic; all model loading and dispatch |
| `monailabel/interfaces/app.py:241` | `infer()` — wraps `(ndarray, json)` into `{"file": ..., "params": ...}` |
| `monailabel/endpoints/infer.py` | HTTP endpoint; calls `stream_multipart` with the ndarray |
| `monailabel/utils/others/stream.py` | Gzip-streams ndarray as multipart/form-data to OHIF |
| `monailabel/transform/writer.py` | `Writer` class — used only by standard MONAI pipeline, NOT by nnInteractive/SAM2 paths |
| `monailabel/utils/others/medgemma.py` | Pure utility functions (windowing, base64 encode); no downloads |
