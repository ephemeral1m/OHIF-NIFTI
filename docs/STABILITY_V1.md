# OHIF/MONAI stability v1

## Deployment boundary

This release keeps the existing single-user nnInteractive workflow and NIfTI/PACS saves.
VoxTell, Qwen, SAM2/MedSAM2/SAM3 and MedGemma are not initialized in the API process.
The old inference branches remain in source for a later isolated-model deployment;
setting their enable flags to true does **not** restore heavy-model support in v1.
It returns MODEL_UNAVAILABLE. Keep all heavy-model flags false.

nnInteractive is loaded on the first infer/init/load-session request, only from
`/code/checkpoints/nnInteractive_v1.0`. No startup or request-time model download is
performed. Missing/corrupt weights or an unavailable CUDA device return HTTP 503.
After fixing a model load failure, restart MONAI to retry loading. Health checks do
not retry model initialization. A reset before the first AI use does not load it.

`GET /health` (or `/monai/health` through Nginx) returns `status: ok` for the base API,
plus per-model states: disabled, uninitialized, loading, ready, failed.
Model errors contain `code`, `model`, `message`; source DICOM failures return HTTP
502 with `detail.code = SOURCE_DICOM_UNAVAILABLE`. No draft format migration occurs.

Inference and draft synchronization still run synchronously on the API event loop
to preserve the existing SIGALRM timeout mechanism. They share a reentrant lock.
Health/status and other requests may wait while inference runs. This is not process
isolation: an OS-level OOM during nnInteractive itself can still kill the container.
The known VoxTell/Qwen startup OOM path is removed. Multi-user/concurrent inference
and independent inference workers are outside this release.

## Backup and rollout

Original files were copied and checksum-verified before edits under
`release-artifacts/stability-v1-backup-20260826-180648` (plus the subsequently backed-up
root `.dockerignore`). Weights, HF caches, Orthanc data and saved masks are unchanged.
Backups are excluded from the Docker build context.

In normal Windows PowerShell, with Docker Desktop running:

```powershell
& "E:\ohif-ai\Deploy-Stability-V1.ps1"
```

If package downloads inside builds need the existing port-7890 proxy:

```powershell
& "E:\ohif-ai\Deploy-Stability-V1.ps1" -Proxy "http://host.docker.internal:7890"
```

The script tags existing images for rollback, rebuilds BOTH images without skipping
an already-present image, starts all services, checks model flags and observes the
MONAI container for 600 seconds. It does not prune images or remove caches/volumes.
Docker Hub access still uses Docker Desktop's own proxy settings; build arguments
do not fix registry authentication/network failures.

The log is `deploy-stability-v1-<timestamp>.log` in the project root. A passing base
service check is not GPU/browser acceptance. Do the following separately:

1. After container recreation (fresh internal DICOM cache), open an existing series,
   draw with the ordinary brush without any AI action, Save Draft and Save All.
2. Reload the saved masks; check slice position, orientation, overlap and labels.
3. Use nnInteractive positive/negative points and boxes, reset, then load an existing
   draft and refine/save. Switch between two different same-sized series and repeat.
4. Check Save to PACS and existing DICOM-SEG reload. dcmqi download is disabled;
   this application's PACS save uses pydicom_seg, not the optional dcmqi executable.
5. Observe `docker logs --follow monai_sam2`, `/health`, and restart/OOM status.

Do not clear production source caches manually for testing. Recreating the MONAI
container naturally starts its non-persistent source cache empty while preserving
the bind-mounted masks and weights. Synthetic tests use temporary directories only.

## Tests

Backend component tests require Python 3.12+ for the pinned test-only dependency set:

```powershell
$env:PYTHONPATH = "E:\ohif-ai\monai-label"
python -m pytest "E:\ohif-ai\monai-label\tests\stability_v1" -q
```

They use real FastAPI/SimpleITK and synthetic DICOM, with a fake Orthanc transport
and no model weights/CUDA. They do not constitute a full MONAI application boot.
Frontend Jest targets are `niftiDraftState`, `niftiMaskInspection`,
`niftiMemoryLedger`, `multipart`, and `backendError` in extension-default/src/utils.

## Rollback

Before rollback, stop MONAI and the Viewer. Restore only changed source/config files
from the backup; remove only the new stability-v1 source files if reverting the
source tree. Do not restore/delete mounted data directories. The deployment log
lists the exact `monai:pre-stability-v1-<timestamp>` and
`webapp:pre-stability-v1-<timestamp>` image tags. Retag those as `monai:latest` and
`webapp:latest`, restore the original Compose file, then `docker compose up -d --no-build`.
