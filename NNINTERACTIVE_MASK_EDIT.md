# nnInteractive selected-mask editing — 2026-08-26

## Startup regression hotfix (20:58)

The first implementation eagerly subscribed to `segmentationService` while the default extension's command module was being registered. `pluginConfig.json` loads default before cornerstone; Cornerstone only registers segmentation/viewport services in its later preRegistration hook. This reproduced `Cannot read properties of undefined (reading 'subscribe')` and could leave default extension modules unregistered, breaking the worklist.

The controller now resolves Cornerstone services at first capture/event after they become available, and binds listeners once. Missing/partially registered services cannot crash command-module startup or permanently poison the closure with undefined values. Added tests reproduce the previous failure, then verify late registration, first AI operation and no duplicate subscriptions. **62 frontend tests pass**, with zero strict TypeScript diagnostics. This hotfix changes frontend only; MONAI does not need another rebuild. Backup: `release-artifacts/nninteractive-startup-fix-20260826-205848/`.

Build `ohif_viewer` only, then recreate it with `up -d --no-deps --no-build ohif_viewer`; refresh the browser after deployment. Automated tests verify the startup-order fix, not the currently deployed browser. Browser inspection during this fix timed out; live page recovery still requires deployment verification.

## User-visible contract

- Create/select a mask with the existing segmentation panel. AI never creates a group or segment.
- AI starts from the current browser pixels, including unsaved brush/eraser edits. Empty targets start empty.
- AI can add AND remove selected-mask pixels. Other groups and other segment labels are protected.
- Refine/New and its E shortcut are removed. Reset clears AI history, not mask pixels or ordinary measurements.
- Switching targets, changing pixels or discarding a response forces a fresh seed. Consecutive prompts on an unchanged target reuse the model/image/session.
- Draft loading does not initialize AI. Save Draft / Save All / Load Drafts / Save to PACS retain their existing implementation and file formats.

## Implementation and protocol

The command delegates to `nnInteractiveController.ts` (OHIF adapter) and `nnInteractiveEdit.ts` (single-request coordinator). Identity is Series UID + segmentationId + segmentIndex, fenced by selection generation and immediate pixel revision. Prompt owners are captured on measurement creation; only new prompts belonging to that target/epoch are transmitted. A response is checked against its request and against current foreground hash before in-place commit. The pixel commit prevalidates the whole result and preserves other labels and draft metadata.

`POST /infer/segmentation?image=<SeriesUID>&output=dicom_seg` keeps multipart output. `params.nn_context` version 1 carries target IDs, requestId, revision, generation, sessionToken, shape `[z,y,x]`, `slices` (SOP UID, position, orientation and spacing), and `promptSlices` (ordered SOP UIDs). Optional `nn_seed` is a raw uint8 binary selected-mask volume in labelmap slice order. Maximum seed size is 480 MiB, below nginx's existing 500M limit. Existing source/DICOM geometry must match. Multi-frame and non-native/non-monotonic slice layouts are explicitly refused, not guessed/resampled.

Backend resolves actual source slice order and maps seed/prompts to it; output pixels are mapped back to labelmap order. The bundled custom MPR tools already normalize prompt z to display-set order: the adapter must not send volume order and flip twice. Response `flipped` describes browser-to-source conversion for the unchanged draft/PACS exporters; it is NOT an instruction to flip the returned AI pixels again.

The existing nnInteractive RLock covers source setup, context binding, seed initialization and prediction. Tokens are consumed before interactions and regenerated only on success. `NN_RESYNC_REQUIRED` (409) allows one fresh-seed retry, only if the browser target is still current. `NN_PROTOCOL_REQUIRED` (409) rejects old unsafe clients. Invalid geometry/seed/prompts use 422. Existing disabled-model 503 responses are unchanged. Legacy draft session loading invalidates the browser binding.

No per-mask GPU model or permanent volume copies are introduced. Temporary seed files are removed on success/failure. Request/response buffers are tracked in the existing memory ledger; the adapter logs no volume payloads. Existing source-image cache and lazy model loading remain in place.

## Backup and rollback

Original modified files: `release-artifacts/nninteractive-mask-backup-20260826-200946/`.
No existing weights, caches or drafts were removed. Frontend and backend must be rebuilt/deployed together; do not deploy only the viewer. The existing `Deploy-Stability-V1.ps1` backs up image tags, builds both services, starts the stack and checks 600 seconds of base-service stability. It never prunes Docker data.

User PowerShell from E:\ohif-ai:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\ohif-ai\Deploy-Stability-V1.ps1"
```

If the existing build requires a proxy, pass its configured URL via the script's `-Proxy` parameter. Refresh the browser after deployment. For rollback, restore BOTH corresponding pre-deployment image tags and recreate both services with `--no-build`; keep data volumes untouched.

## Verification and limitations

Local verification completed: **60 frontend tests / 8 suites**, **36 backend tests**, and **0 TypeScript strict diagnostics** in the new adapter/coordinator. Existing baseline was 42 frontend and 18 backend tests. One upstream Starlette TestClient deprecation warning remains. The isolated Jest config in the Codex workspace includes the new suites. No full Viewer build or live deployment is implied by these results.

Automated coverage includes the real CommandsManager nninter method through the production controller, HTTP multipart decode and in-place writeback, with only browser services/network/GPU mocked. Tests reproduce A/1 brush -> B/1 empty AI without C, isolate prompt ownership, preserve draft lineage, exercise empty output, live coalescing, stale responses, brush resync, reset and backend restart. Backend tests execute the production BasicInferTask.__call__ with mocked GPU IO, and test full identity/token fencing, source geometry, forward/reverse seed/prompt mapping, and existing cold-cache draft persistence.

These tests do NOT establish real-GPU segmentation quality, browser rendering correctness, PACS round-trip success or 10-minute deployed stability. These require rebuilding both images and a real browser acceptance run. Pending acceptance checklist:

- [ ] A brush -> B empty positive point; only B changes, group count unchanged.
- [ ] Positive/negative point, box, scribble/lasso, reset, and brush -> AI -> brush -> AI.
- [ ] Same-number masks in different groups, different masks in one group, same-sized different series.
- [ ] Switch away/back, lock/delete target or draw while AI is pending; no stale commit.
- [ ] Save Draft/Save All, reload and compare dimensions/direction/pixels; Save to PACS.
- [ ] Restart MONAI; fresh seed restores AI from unsaved browser pixels, no stale session.
- [ ] Observe health, OOMKilled and RestartCount for at least 10 minutes; inspect memory ledger after repeated edits.

Scope remains single machine/single user. Ordinary brush/save behavior and undo policy are not redesigned. In-flight inference may still occupy the backend event loop as in stability v1; process-level model isolation remains out of scope.
