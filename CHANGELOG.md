# OHIF-AI — Code Change Record

All custom changes made to the OHIF-AI stack on top of the upstream OHIF Viewer + MONAI-Label base.
Changes are listed in chronological order by session.

---

## Session 1 — Weight Persistence & MedGemma Toggle

**Goal:** Persist nnInteractive/VoxTell weights across container restarts; make MedGemma optional.

### `docker-compose.yml`

Added two volume mounts and one environment variable to the `monai_sam2` service:

```yaml
volumes:
  - ./monai-label/checkpoints:/code/checkpoints   # host-persist nnInter/VoxTell/SAM weights
  - ./monai-label/hf_cache:/root/.cache/huggingface  # host-persist HuggingFace cache
environment:
  - ENABLE_MEDGEMMA=false   # guard to skip 35 GB MedGemma download/load
```

> **Gotcha:** the `checkpoints` mount shadows the image's baked-in SAM2/MedSAM2 `.pt` files.
> Copy them to the host before first start:
> `docker cp monai_sam2:/code/checkpoints/. ./monai-label/checkpoints/`

### `monai-label/monailabel/tasks/infer/basic_infer.py`

**A — nnInteractive skip-if-exists guard** (around line 89):
```python
# Before: unconditional download
snapshot_download(repo_id=REPO_ID, ...)

# After: skip if already on disk
if not os.path.isdir(model_local_path) or not os.listdir(model_local_path):
    snapshot_download(repo_id=REPO_ID, ...)
```

**B — VoxTell skip-if-exists guard** (around line 97):
```python
# Same pattern applied to VoxTell (mrokuss/VoxTell)
if not os.path.isdir(vox_local_path) or not os.listdir(vox_local_path):
    snapshot_download(repo_id="mrokuss/VoxTell", ...)
```

**C — MedGemma load guard** (around line 141):
```python
ENABLE_MEDGEMMA = os.environ.get("ENABLE_MEDGEMMA", "true").lower() == "true"
gem_processor = None
gem_model = None
if ENABLE_MEDGEMMA:
    gem_processor = transformers.AutoProcessor.from_pretrained(...)
    gem_model = transformers.AutoModelForImageTextToText.from_pretrained(...)
```

**D — MedGemma inference early-return** (around line 560):
```python
if nnInter == "medGemma":
    if gem_model is None:
        logger.warning("MedGemma is disabled. Set ENABLE_MEDGEMMA=true ...")
        return "MedGemma is disabled.", final_result_json
    # ... existing inference code unchanged
```

### `.gitignore`

Added `monai-label/hf_cache/` to prevent committing large HuggingFace cache files.

---

## Session 2 — Save to PACS

**Goal:** Add a "Save to PACS" button that converts the current nnInteractive labelmap to a
multi-class DICOM-SEG and stores it in Orthanc via DICOMweb STOW-RS.

### `monai-label/monailabel/endpoints/infer.py`

Added `POST /infer/save/{model}` route **before** `/{model}` (route ordering is critical in
FastAPI — a route declared after `/{model}` would be swallowed as a model name).

Key implementation details:
- Accepts optional `labelmap` binary upload (flat uint8, Z×rows×cols) from the frontend;
  falls back to `session.target_buffer` for single-class saves.
- Sets `datastore._studyInstanceUID` before `get_image_uri()` to mirror the pattern used
  in `app.py:285`.
- Reads DICOM geometry via `sitk.ImageSeriesReader` and corrects the k-direction using
  actual DICOM ImagePositionPatient differences (SimpleITK cross-product can disagree
  with GDCM's ascending-Z ordering).
- Uses `pydicom_seg.MultiClassWriter` to encode the mask as a proper DICOM-SEG object.
- Manually injects `ReferencedSeriesSequence` (pydicom_seg v0.4.1 omits it).
- Uploads the resulting `.dcm` via `dicom_web_upload_dcm`, then deletes the temp file.

Added `from datetime import datetime` import.

### `Viewers/extensions/default/src/commandsModule.ts`

Added `saveToPACS` action (before `jumpToSegment` in the file):

- Finds the nnInteractive segmentation by scanning all segmentations for segments whose
  `cachedStats.algorithmType === SeriesInstanceUID`. Falls back to the active segmentation.
- Reads all labelmap slices from the Cornerstone3D image cache via `voxelManager.getScalarData()`.
- Detects slice flip: if `cachedStats.flipped === true`, reverses the slice order to match
  GDCM's ascending-Z ordering expected by the backend.
- Concatenates slices into a flat `Uint8Array` and POSTs it as multipart form-data alongside
  a JSON `params` object (studyInstanceUID, segment metadata, label).
- Shows a promise-based notification (loading → success/error).

Registered in the definitions map: `saveToPACS: actions.saveToPACS`.

### `Viewers/modes/longitudinal/src/toolbarButtons.ts`

Added `saveToPACS` button entry after `resetNninter`:

```typescript
{
  id: 'saveToPACS',
  uiType: 'ohif.toolBoxButton',
  props: {
    icon: 'content-save',
    label: 'Save to PACS',
    tooltip: 'Save current segmentation to PACS as DICOM-SEG',
    commands: 'saveToPACS',
  },
},
```

### `Viewers/modes/longitudinal/src/index.ts`

Added `'saveToPACS'` to `aiToolBoxSection` array so the button is rendered in the AI toolbar.

---

## Session 3 — Fix Brush/Eraser & SEG-Load Conflicts (Issues 3 & 4) ⚠️ ISSUES STILL PERSIST

**Goal:**
- **Issue 3:** Brush/Eraser tools had no effect after nnInteractive segmentation.
- **Issue 4:** Loading a saved DICOM-SEG from the study browser wiped the nnInteractive
  segmentation from the right panel.

> **⚠️ Status: Both issues still persist.** The changes below were applied but did not fully
> resolve the problems. Further investigation is needed.

### Root cause — Issue 3

`postSegmentationProcessing` set `referencedVolumeId: currentDisplaySets.displaySetInstanceUID`
on the nnInteractive labelmap. A display-set UID is **not** a valid Cornerstone3D volume ID.
When BrushTool encountered this field it called `cache.getVolume(referencedVolumeId)`, got
`null`, and silently wrote nothing. The OHIF standard path (`createLabelmapForDisplaySet`,
`createSegmentationForSEGDisplaySet`) deliberately omits `referencedVolumeId`.

### Root cause — Issue 4

When the user double-clicks a saved DICOM-SEG in the left study browser, `OHIFCornerstoneSEGViewport`
mounts and two `useEffect` hooks both call `segmentationService.clearSegmentationRepresentations(viewportId)`,
removing all reps including nnInteractive. The SEG hydration flow only re-adds the DICOM-SEG
representation; nothing re-adds nnInteractive.

The `loadSegmentationsForViewport` command in `cornerstone-dicom-seg/commandsModule.ts` had a
restore loop we had added previously, but this command is never called during DICOM-SEG hydration —
making that code dead.

---

### `Viewers/extensions/default/src/commandsModule.ts` — Fix Issue 3

Removed `referencedVolumeId` from both labelmap data objects in `postSegmentationProcessing`:

**New segmentation path (~line 140):**
```typescript
// Before
data: {
  imageIds: derivedImageIds,
  referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
  referencedImageIds: imageIds,
}

// After
data: {
  imageIds: derivedImageIds,
  referencedImageIds: imageIds,
}
```

**Existing segmentation update path (~line 181):**
```typescript
// Before
[LABELMAP]: {
  ...existingLabelmapData,
  imageIds: derivedImageIds,
  referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
  referencedImageIds: imageIds,
}

// After
[LABELMAP]: {
  ...existingLabelmapData,
  imageIds: derivedImageIds,
  referencedImageIds: imageIds,
}
```

---

### `Viewers/extensions/cornerstone-dicom-seg/src/viewports/OHIFCornerstoneSEGViewport.tsx` — Fix Issue 4

**A — Added ref** (near line 67, alongside existing refs):
```typescript
const repsToRestoreRef = useRef<any[]>([]);
```

**B — Save non-DICOM-SEG reps before clearing** (in `useEffect([segDisplaySet])`, before the
`clearSegmentationRepresentations` call):
```typescript
// Save non-DICOM-SEG representations (e.g. nnInteractive) before clearing
const existingReps = segmentationService.getSegmentationRepresentations(viewportId);
repsToRestoreRef.current = existingReps.filter(rep => {
  const ds = displaySetService.getDisplaySetByUID(rep.segmentationId);
  return !ds || ds.Modality !== 'SEG';
});
// on new seg display set, remove all segmentations from all viewports
segmentationService.clearSegmentationRepresentations(viewportId);
```

Filter logic: for nnInteractive, `rep.segmentationId` is not a display-set UID so `ds` is
`null` → `!ds` is true → kept. For DICOM-SEG reps, `ds.Modality === 'SEG'` → filtered out.

**C — Restore reps after successful hydration** (in the `promptHydrateSEG` `.then` callback):
```typescript
// Before
}).then(isHydrated => {
  if (isHydrated) {
    setIsHydrated(true);
  }
});

// After
}).then(async isHydrated => {
  if (isHydrated) {
    setIsHydrated(true);
    const repsToRestore = repsToRestoreRef.current;
    repsToRestoreRef.current = [];
    for (const rep of repsToRestore) {
      try {
        await segmentationService.addSegmentationRepresentation(viewportId, {
          segmentationId: rep.segmentationId,
        });
      } catch (e) {
        console.warn('Could not restore segmentation representation', rep.segmentationId, e);
      }
    }
  }
});
```

---

### `Viewers/extensions/cornerstone-dicom-seg/src/commandsModule.ts` — Housekeeping

Removed the dead csTools-state-scan restore loop from `loadSegmentationsForViewport` (was
lines 79–98). This loop was never called during DICOM-SEG hydration; the fix for Issue 4 is
now correctly placed in the viewport component itself.

```typescript
// DELETED (was lines 79-98):
const allCsSegs = cornerstoneToolsSegmentation.state.getSegmentations();
for (const csSeg of allCsSegs) {
  if (csSeg.segmentationId === segmentationId) continue;
  const existing = segmentationService.getSegmentationRepresentations(
    targetViewportId, { segmentationId: csSeg.segmentationId }
  );
  if (!existing.length) {
    try {
      await segmentationService.addSegmentationRepresentation(
        targetViewportId, { segmentationId: csSeg.segmentationId }
      );
    } catch (e) {
      console.warn('Could not restore representation for', csSeg.segmentationId, e);
    }
  }
}
```

---

## Session 4 — Fix Save-to-PACS for VoxTell

**Goal:** Save-to-PACS button crashed with `NotImplementedError` when saving VoxTell (or any)
segmentation results.

### Root cause

`pydicom_seg` v0.4.1's `template.from_dcmqi_metainfo()` runs a `jsonschema` Draft-4 validation
against the dcmqi seg-schema before building the template Dataset. The schema has
`additionalProperties: false` and strict VR-length constraints; any mismatch causes the
validator to return `is_valid → False`, which the library handles by raising
`NotImplementedError()` — an uninformative error that hides the real validation failure.

### Fix — `monai-label/monailabel/endpoints/infer.py`

Replaced the `from_dcmqi_metainfo(template_dict)` call with direct construction of the
`pydicom.Dataset` template. The new code sets the same DICOM tags and builds the
`SegmentSequence` (with proper code sequences and CIELab colour conversion) identically to
what the library does internally — just without the fragile JSON schema gate.

```python
# Before (line ~426):
template = _pds.template.from_dcmqi_metainfo(template_dict)

# After: build pydicom.Dataset directly
template = pydicom.Dataset()
template.ContentCreatorName = "Reader1"
# ... remaining tags ...
template.SegmentSequence = pydicom.Sequence(seg_datasets)
```

---

## Session 5 — NIfTI Segmentation Draft Store

**Goal:** Persistent storage for pre-computed batch segmentation results (VoxTell, body seg, lung
nodule detection, etc.) as NIfTI files. Doctors can load drafts in the viewer, refine with
nnInteractive, then optionally promote to PACS via Save-to-PACS. NIfTI is the draft/working
format; DICOM-SEG in Orthanc is the published/approved format.

### Backend — CRUD + Session Loading

#### `monai-label/monailabel/endpoints/nifti_store.py` *(new file)*

FastAPI router under `/nifti-segs/` with 5 routes:

| Route | Purpose |
|---|---|
| `GET /{series_uid}` | List drafts — reads `*.json` sidecars, returns array. `[]` if no dir. |
| `GET /{series_uid}/{filename}` | Retrieve — reads NIfTI + sidecar, returns via `stream_multipart()` (same format as nninter response, so frontend reuses `parseMultipart()` unchanged). |
| `DELETE /{series_uid}/{filename}` | Delete draft — removes `.nii.gz` + `.json` files. |
| `POST /{series_uid}` | Save draft — for batch pipeline use. Accepts `params` JSON + `seg_data` binary upload. |
| `POST /{series_uid}/load-session` | **Critical** — Loads NIfTI mask into nnInteractive `session` for refinement. |

**`load-session` implementation details:**
- Reads NIfTI mask and source DICOM image via SimpleITK
- Calls `session.set_image(img_np)` only if needed (first time or shape changed); waits for
  async preprocessing to complete (up to 10s)
- Calls `session.add_initial_seg_interaction(seg_np, run_prediction=False)` — the correct
  nnInteractive API that populates both `target_buffer` (original coords) and `interactions[0]`
  (channel -7, preprocessed/cropped coords — what the network reads as current segmentation state)
- Sets `_session_image["seriesInstanceUID"]` on the BasicInfer task instance so future
  nnInteractive calls don't re-initialize the image
- Clears `_session_used_interactions` so new prompts aren't de-duplicated against stale history

**Sidecar JSON format:**
```json
{
  "algorithm": "voxtell",
  "label": "Liver",
  "created": "2026-03-19T10:56:00",
  "segments": {"1": "Liver"},
  "status": "draft",
  "flipped": false
}
```

#### `monai-label/monailabel/app.py`

Registered nifti_store router (after session router):
```python
from monailabel.endpoints import nifti_store
app.include_router(nifti_store.router, prefix=settings.MONAI_LABEL_API_STR)
```

#### `monai-label/monailabel/tasks/infer/basic_infer.py`

**VoxTell auto-save** (before `return voxtell_seg_np, final_result_json`, ~line 714):
- Writes NIfTI via `sitk.WriteImage(voxtell_seg_sitk, path)` (reuses existing SimpleITK image)
- Writes JSON sidecar with algorithm, label, timestamp, segments, flipped state
- Wrapped in `try/except` — failure does not break the live inference path
- Target: `/code/nifti_segs/{seriesInstanceUID}/`
- Flipped value computed from `instanceNumber > instanceNumber2` (same as nninter response)

#### `docker-compose.yml`

Added volume mount for persistent draft storage:
```yaml
- ./monai-label/nifti_segs:/code/nifti_segs
```

#### `.gitignore`

Added `monai-label/nifti_segs/`

### Frontend — Load Drafts into Viewer

#### `Viewers/extensions/default/src/commandsModule.ts`

Four new actions added before `saveToPACS`:

**`listNiftiDrafts`** — Gets seriesUID from active viewport, calls
`GET /monai/nifti-segs/{seriesUID}`, returns array of draft metadata.

**`syncDraftToSession`** — POSTs to `/monai/nifti-segs/{seriesUID}/load-session` with
`{filename, image, studyInstanceUID}` as FormData. Called after loading a draft to enable
nnInteractive refinement.

**`loadNiftiDraft({ seriesUID, filename, studyInstanceUID })`** — Full draft loading pipeline:
1. Fetches draft via `GET /monai/nifti-segs/{seriesUID}/{filename}` (arraybuffer)
2. Parses multipart response via `parseMultipart()` (same format as nninter)
3. Reuses active segmentation if same series, else creates new UUID
4. Picks next available segmentNumber
5. Creates derived labelmap images, applies Z-flip if `meta.flipped === "true"`
6. Writes mask slice-by-slice via `voxelManager.setScalarData()`
7. Sets `cachedStats.algorithmName = 'draft_${algorithm}'` (used to detect draft segments)
8. Calls `postSegmentationProcessing()` (same shared function as nninter — ensures brush/Save-to-PACS compatibility)
9. Sets `toolboxState.setRefineNew(false)` so nninter refines this segment
10. Calls `syncDraftToSession()` to load mask into backend nnInteractive session

**`showDraftsList`** — Calls `listNiftiDrafts()`, shows numbered selection dialog via
`callInputDialog`. On selection, calls `loadNiftiDraft()`. Shows notification if no drafts.

**nninter response handler — draft overlay fix** (~line 1874):
When refining a segment loaded from a draft (`algorithmName.startsWith('draft_')`), the
existing segment data is **not** cleared before writing the nninter prediction. This overlays
the prediction on the draft instead of replacing it, preventing data loss on slices where the
prediction's spatial extent differs from the draft. After the first nninter interaction,
`algorithmName` changes to the standard nninter name, so subsequent interactions use the normal
clear+replace behavior.

All four commands registered in the definitions map.

#### `Viewers/modes/longitudinal/src/toolbarButtons.ts`

Added `loadDrafts` button:
```typescript
{
  id: 'loadDrafts',
  uiType: 'ohif.toolBoxButton',
  props: {
    type: 'tool',
    icon: 'tool-stack-scroll',
    label: 'Load Drafts',
    tooltip: 'Load pre-computed segmentation drafts',
    commands: 'showDraftsList',
  },
},
```

#### `Viewers/modes/longitudinal/src/index.ts`

Added `'loadDrafts'` to `aiToolBoxSection` array after `'saveToPACS'`.

### Test Data Generation

**`generate_test_drafts.py`** — v1 generator. Uses Orthanc API for geometry, writes minimal
NIfTI with hardcoded `flipped: false`. Generates 3 synthetic organ masks (Liver, Lung nodule,
Spine) per series.

**`generate_test_drafts_v2.py`** — v2 generator. Reads actual DICOM from MONAI Label's cache
via SimpleITK, uses `CopyInformation(img_sitk)` for correct NIfTI geometry (spacing, origin,
direction), computes correct `flipped` value from InstanceNumber ordering. Run inside the
container:
```bash
docker cp generate_test_drafts_v2.py monai_sam2:/tmp/
docker exec monai_sam2 python3 /tmp/generate_test_drafts_v2.py
```

### nnInteractive Compatibility — Investigation Notes

The nnInteractive session integration was verified to be working correctly:

- **Backend confirmed working**: `add_initial_seg_interaction` correctly populates both
  `target_buffer` and `interactions[0]`. Diagnostic logging showed the loaded mask (42829
  nonzero voxels) is preserved through to the nninter inference call, and the prediction
  output (50905 voxels) is a genuine refinement — not a reset to empty.
- **No session reset between load and interaction**: Logs confirmed no `init` or `resetNninter`
  call occurs between `load-session` and the first nninter point interaction.
- **Visual "replacement" was model behavior, not a bug**: The nnInteractive network reshapes
  the mask based on its anatomical understanding. Synthetic test masks that don't match real
  anatomy produce predictions that look visually different but are legitimate refinements.
  Testing with 2 of 3 drafts on AI GUO QING and all 3 drafts on another series confirmed
  correct refinement behavior.

### Known Limitations

- ~~**Brush tool cannot edit loaded drafts or nnInteractive results**~~ — **Resolved in Session 6.**
  Root cause was `voxelManager.setScalarData()` replacing the internal buffer, detaching the
  image cache reference. Fix: in-place buffer writes.
- Test drafts require the series to be opened in OHIF first (to populate the DICOM cache)
  before `generate_test_drafts_v2.py` can generate correct geometry.

---

## Session 6 — Fix Brush Tool on nnInteractive & NIfTI Segmentations

**Goal:** Brush tool could not edit slices that had existing mask data from nnInteractive or
NIfTI draft loading. Brush worked on empty slices but silently failed on populated ones.

### Root cause — `voxelManager.setScalarData()` buffer replacement

`voxelManager.setScalarData(newArray)` **replaces the internal TypedArray buffer** with a new
one. However, the Cornerstone3D image cache retains a reference to the **old** buffer. The brush
tool writes pixels through the cache (old buffer), while the display reads from the voxelManager
(new buffer). Result: brush writes go into a detached buffer that nothing renders.

This only affected slices where `setScalarData()` was called (i.e., slices with mask data).
Empty slices kept their original buffer intact, so the cache reference remained valid and brush
worked normally — which is why brush worked on empty slices but not on populated ones.

### How we found it

The bug was open since Session 3 and survived multiple wrong theories:

1. **Session 3: `referencedVolumeId` theory** — Thought brush failed because
   `postSegmentationProcessing` set an invalid volume ID. Removing it didn't fix it.
2. **Session 5: Stack vs Volume mismatch** — Tried `convertStackToVolumeLabelmap` to convert
   stack-based labelmaps to volume-based. Caused viewer crash on first load (viewport type
   change triggers full re-mount). Removed.
3. **Session 5: Stats handler crashes** — `SEGMENTATION_DATA_MODIFIED` handler crashed in
   `getStatistics` and `runSegmentBidirectional`, propagating through brush's
   `fill` → `acceptPreview` chain and triggering React Error Boundary. Wrapping in try/catch
   revealed brush was actually painting on empty slices — just not on slices with mask data.
4. **Session 6: The breakthrough** — The observation "brush works on empty slices but NOT on
   slices with existing mask" was the critical clue. The only difference: `setScalarData()` had
   been called on populated slices during loading, replacing their buffer. Empty slices had the
   original buffer intact. Tracing the cache → voxelManager reference chain confirmed the
   buffer detachment.

### Fix — `Viewers/extensions/default/src/commandsModule.ts`

Replaced **all 8 `voxelManager.setScalarData()` calls** across `loadNiftiDraft` and the nninter
response handler (both overlap and non-overlap paths) with in-place buffer writes:

```typescript
// BROKEN — replaces buffer, detaches cache reference:
voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));

// FIXED — writes to same buffer, cache stays linked:
const scalarData = voxelManager.getScalarData();
for (let j = 0; j < scalarData.length; j++) {
  scalarData[j] = sliceData[j] === 1 ? segmentNumber : scalarData[j];
}
```

Three patterns were converted:
- **Slice data write** (new mask data): `scalarData[j] = sliceData[j] === 1 ? segmentNumber : scalarData[j]`
- **Segment clear** (refine mode): `if (scalarData[j] === segmentNumber) scalarData[j] = 0`
- **Merge write** (overlay on existing): `if (sliceData[j] === 1) scalarData[j] = segmentNumber`

Also removed unused `convertStackToVolumeLabelmap` import (leftover from Session 5 investigation).

### Additional fixes from Session 5 investigation

#### `Viewers/extensions/cornerstone/src/utils/segmentationHandlers.ts`

Wrapped `SEGMENTATION_DATA_MODIFIED` handler in outer try/catch and added inner try/catch
around `runSegmentBidirectional` to prevent stats computation errors from crashing the brush
tool's event chain.

#### `Viewers/extensions/cornerstone/src/utils/updateSegmentationStats.ts`

Wrapped `getStatistics()` call in try/catch — returns `null` on failure instead of propagating
`TypeError: l is null` up through the brush event chain.

---

## Session 7 — Fix Brush Rendering Lag (GPU Texture Stale After Brush Strokes)

**Goal:** Brush strokes on nnInteractive/NIfTI segmentations wrote correct data to the CPU
buffer but the viewport displayed stale GPU textures. Edits only became visible after scrolling
away and back (which forced a texture re-upload). After Session 6 fixed the buffer-detachment
issue, brush data was correct — but the display pipeline never re-uploaded it to the GPU.

### Root cause — Two missing links in the rendering chain

**Problem 1: VTK MTime not bumped after data changes**

For stack viewports, each labelmap slice is a VTK image actor. VTK tracks data freshness via
an internal modification counter (MTime) on `vtkDataArray`. When the brush tool writes voxels
via `voxelManager.setAtIJK()`, the underlying TypedArray contents change (shared reference), but
VTK's `vtkDataArray` MTime is **never incremented**. On `viewport.render()`, VTK compares MTime
to the last render — unchanged → uses cached GPU texture → brush strokes invisible.

**Problem 2: No rendering trigger after brush strokes**

The brush tool dispatches `SEGMENTATION_DATA_MODIFIED` after painting. The `SegmentationService`
catches this event and broadcasts it via OHIF's event system. However, **nobody called
`triggerSegmentationRender()`** in response. The `SegmentationRenderingEngine` had no event
listener for `SEGMENTATION_DATA_MODIFIED`. The only subscriber was the debounced stats handler
(1000ms) in `segmentationHandlers.ts`. So the rendering pipeline (`labelmapDisplay.render()` →
`_setLabelmapColorAndOpacity()`) was never invoked after brush strokes.

### How we found it

1. **First attempt — remove `sliceChanged` guard** (`labelmapDisplay.js`): Removed the
   optimization that skipped `_addLabelmapToViewport()` when the slice hadn't changed. Didn't
   help — `addImageSlicesToViewports()` skips actors that already exist (same actorUID).

2. **Second attempt — `inputData.modified()`** (`labelmapDisplay.js`): Added
   `mapper.getInputData().modified()` in `_setLabelmapColorAndOpacity()` to bump VTK's MTime.
   Partially worked — brush was immediate on the current slice right after nnInteractive, but
   broke after any scrolling. This revealed that the MTime fix was correct but
   `_setLabelmapColorAndOpacity()` wasn't being called after brush strokes.

3. **Third attempt — event listener** (`SegmentationRenderingEngine.js`): Added a
   `SEGMENTATION_DATA_MODIFIED` event listener in the constructor that calls
   `this.renderSegmentation(segmentationId)`. Combined with the MTime fix, this completed the
   rendering chain: brush stroke → event → RAF → `labelmapDisplay.render()` →
   `inputData.modified()` → `viewport.render()` → GPU texture re-upload → brush visible.

### Fix 1 — `Viewers/backup/esm/labelmapDisplay.js`

In `_setLabelmapColorAndOpacity()`, after obtaining the `labelmapActor`, force VTK to recognize
data changes by bumping the input data's MTime:

```javascript
const labelmapActor = labelmapActorEntry.actor;
// Force VTK to re-upload the GPU texture from the (potentially modified) CPU buffer.
try {
    const mapper = labelmapActor.getMapper();
    if (mapper) {
        const inputData = mapper.getInputData();
        if (inputData && inputData.modified) {
            inputData.modified();
        }
    }
} catch (e) {
    // Ignore — some actor types may not support this
}
```

### Fix 2 — `Viewers/backup/esm/SegmentationRenderingEngine.js`

Added event listener in the constructor so that `SEGMENTATION_DATA_MODIFIED` events (fired by
the brush tool after painting) trigger the segmentation rendering pipeline:

```javascript
// In constructor:
eventTarget.addEventListener(
    csToolsEvents.SEGMENTATION_DATA_MODIFIED,
    (evt) => {
        const { segmentationId } = evt.detail;
        if (segmentationId) {
            this.renderSegmentation(segmentationId);
        }
    }
);
```

This completes the chain: brush stroke → `SEGMENTATION_DATA_MODIFIED` → `renderSegmentation()`
→ RAF → `labelmapDisplay.render()` → `_setLabelmapColorAndOpacity()` → `inputData.modified()`
→ `viewport.render()` → VTK re-uploads GPU texture → brush visible immediately.

### Fix 3 — `Viewers/extensions/cornerstone/src/utils/segmentationHandlers.ts`

Skip expensive `getStatistics()` recomputation (scans ~78M voxels for a 512×512×300 volume)
when all segments already have cached stats from the nninter/draft loading pipeline. Before
Session 5's try/catch fix, `getStatistics()` crashed immediately (`TypeError: l is null`),
acting as an accidental fast-path. After the crash was caught, the full computation ran on
every `SEGMENTATION_DATA_MODIFIED` event (debounced 1000ms), blocking the main thread.

```typescript
const segmentsNeedingStats = segmentIndices.filter(index => {
    const segment = segmentation.segments[index];
    return !segment?.cachedStats?.namedStats ||
           Object.keys(segment.cachedStats.namedStats).length === 0;
});
if (segmentsNeedingStats.length === 0) {
    return;
}
```

### Note on patched Cornerstone3D files

Both `labelmapDisplay.js` and `SegmentationRenderingEngine.js` live in `Viewers/backup/esm/`
and are copied into `node_modules/@cornerstonejs/tools/dist/esm/` during Docker build via the
Dockerfile at `Viewers/platform/app/.recipes/Nginx-Orthanc/dockerfile` (lines 63, 68).

---

## Summary Table

| Session | Issue | Files Changed |
|---|---|---|
| 1 | Weight persistence, MedGemma toggle | `docker-compose.yml`, `basic_infer.py`, `.gitignore` |
| 2 | Save to PACS button | `endpoints/infer.py`, `commandsModule.ts` (default ext), `toolbarButtons.ts`, `index.ts` (longitudinal mode) |
| 3 ⚠️ | Brush/eraser broken after nnInteractive | `commandsModule.ts` (default ext) — removed `referencedVolumeId` — **resolved in Session 6** |
| 3 ⚠️ | SEG load wipes nnInteractive from panel | `OHIFCornerstoneSEGViewport.tsx` — save/restore non-SEG reps around clear — **still persists** |
| 3 ⚠️ | Dead restore loop cleanup | `commandsModule.ts` (cornerstone-dicom-seg ext) |
| 4 | Save-to-PACS crash (`NotImplementedError`) | `endpoints/infer.py` — bypass `from_dcmqi_metainfo` validation |
| 5 | NIfTI draft store + nnInteractive compat | `nifti_store.py` (new), `app.py`, `basic_infer.py`, `docker-compose.yml`, `.gitignore`, `commandsModule.ts` (default ext), `toolbarButtons.ts`, `index.ts` (longitudinal mode) |
| 6 | **Brush data fix** — in-place buffer writes | `commandsModule.ts` (default ext), `segmentationHandlers.ts`, `updateSegmentationStats.ts` |
| 7 | **Brush rendering fix** — GPU texture re-upload | `labelmapDisplay.js` (backup/esm), `SegmentationRenderingEngine.js` (backup/esm), `segmentationHandlers.ts` |
| 8 | UI label height, navigation fix, standalone VoxTell, Docker build fixes | `DataRow.tsx`, `commandsModule.ts` (default + cornerstone ext), `SegmentationService.ts`, `Dockerfile` (both), `start.sh`, `standalone_voxtell.py` (new) |

---

## Session 8 — UI Fixes, Navigation Bug, Standalone VoxTell, Docker Build Fixes

**Goal:** Three feature/bug tasks plus Docker build pipeline fixes.

### 1. Segmentation Label Dynamic Height

**Problem:** The label bar in the right-panel segmentation results had a fixed 2-line clamp,
truncating long text.

#### `Viewers/platform/ui-next/src/components/DataRow/DataRow.tsx`

- Removed `[overflow:hidden] [display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical]`
  from both `<span>` elements (tooltip-wrapped and plain), replaced with `break-words`.
- Changed row container from `items-center` to `items-start` with `min-h-[28px]` so the number
  box stays top-aligned when labels wrap to many lines.
- The tooltip for long titles (>25 chars) is preserved — it now acts as a convenience hover
  rather than the only way to read truncated text.

### 2. Segmentation Mask Navigation Bug

**Problem:** Clicking a segmentation result in the right panel did not jump to the correct slice.

Three bugs fixed:

#### `Viewers/extensions/cornerstone/src/commandsModule.ts`

`setActiveSegmentAndCenterCommand` did not pass `viewportId` to `jumpToSegmentCenter()`,
forcing it to guess which viewport to navigate:

```typescript
// Before
segmentationService.jumpToSegmentCenter(segmentationId, segmentIndex);

// After
const activeViewportId = viewportGridService.getActiveViewportId();
segmentationService.jumpToSegmentCenter(segmentationId, segmentIndex, activeViewportId);
```

#### `Viewers/extensions/cornerstone/src/services/SegmentationService/SegmentationService.ts`

`_getSegmentCenter()` used `!center` as a falsy check. When `center === 0` (valid — mask at
the start of the volume), `!0` is `true`, causing it to fall through to
`cachedStats.namedStats.center.value` which doesn't exist for our custom segments:

```typescript
// Before — broken when center === 0
if (!center) {
  return { world: cachedStats.namedStats.center.value };
}
return center;

// After — explicit null/undefined check
if (center !== undefined && center !== null) {
  return center;
}
if (cachedStats.namedStats?.center?.value) {
  return { world: cachedStats.namedStats.center.value };
}
return undefined;
```

#### `Viewers/extensions/default/src/commandsModule.ts`

In the VoxTell overlap path (~line 1149), `z_range.push(i)` did not account for flipped images.
After `derivedImages_new.reverse()`, index `i` in the reversed array no longer matches the
viewport's image index. All other code paths (nnInteractive overlap, non-overlap, loadNiftiDraft)
already handled this correctly:

```typescript
// Before — wrong viewport index when flipped
z_range.push(i);

// After — matches all other code paths
if (flipped) {
  z_range.push(derivedImages_new.length - i - 1);
} else {
  z_range.push(i);
}
```

### 3. Standalone VoxTell Inference Script

#### `standalone_voxtell.py` *(new file)*

Self-contained pipeline for running VoxTell text-prompted segmentation without the MONAI Label
backend. Accepts DICOM folder or NIfTI file as input.

Features:
- Auto-detects input format (DICOM series folder or `.nii.gz`)
- Downloads VoxTell weights from HuggingFace if not present
- Handles RAS orientation conversion and restoration (same logic as `basic_infer.py`)
- Supports multiple text prompts with optional `--merge` majority-vote mode
- Outputs NIfTI + JSON sidecar per mask
- Extracts DICOM metadata (modality, series description, flipped flag) via pydicom

```bash
# Single prompt on a DICOM series
python standalone_voxtell.py --input /path/to/dicom/ --prompts "liver"

# Multiple prompts, saved separately
python standalone_voxtell.py --input scan.nii.gz --prompts "liver" "spleen" "kidney"

# Majority-vote merge of 3 prompt variants
python standalone_voxtell.py --input /path/to/dicom/ \
    --prompts "liver lesion" "hepatic mass" "liver tumor" --merge
```

### 4. Docker Build Pipeline Fixes

#### `Viewers/platform/app/.recipes/Nginx-Orthanc/dockerfile`

Three fixes to the OHIF viewer Dockerfile:

**A — Missing `preinstall.js`:**
`package.json` defines `"preinstall": "node preinstall.js"` but the Dockerfile only copied
`package.json` and `yarn.lock`. Added `preinstall.js` to the COPY line.

**B — Missing `lerna`:**
`yarn run build` calls `lerna run build:viewer` but `lerna` is not in `devDependencies`.
Added `RUN npm install -g lerna@7.4.2`.

**C — Missing addOns workspace packages:**
The root `package.json` workspaces include `addOns/externals/*`, but only `addOns/package.json`
was copied. `addOns/externals/devDependencies/package.json` contains build dependencies including
`mini-css-extract-plugin`. Added COPY lines for both nested workspace packages.

#### `monai-label/Dockerfile`

**SAM weight download cache fix:** Moved the `wget` commands for SAM2 and MedSAM2 (~300MB each)
**before** `COPY ./monai-label/. ./`. Previously they came after the source COPY, so any Python
source file change invalidated the Docker layer cache and triggered fresh 600MB downloads. Now
the wget layers are cached as long as `requirements.txt`, `sam2/`, and `sam3/` don't change.

#### `start.sh`

Replaced `docker compose up --build` (rebuilt all 3 services every time) with a selective
rebuild script:

```bash
bash start.sh              # Start all (no rebuild) — fastest
bash start.sh viewer       # Rebuild OHIF viewer only
bash start.sh monai        # Rebuild MONAI backend only
bash start.sh all          # Rebuild everything
```
