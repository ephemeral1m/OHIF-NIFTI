# Native NIfTI acceptance and rollback

All feature flags default to disabled in existing production configurations.
`config/nifti.js` enables viewing, library, editing and AI in the acceptance image.
The viewer and backend must be released together for context v2.

The test Compose project uses loopback port 1126, GPU 1, and separate source,
mask, prediction and Orthanc volumes. Only model weights and auth configuration
are shared read-only. Do not point test drafts at production paths.

Before starting, create `runtime.env` on vanilla with the existing
`MONAI_LABEL_DICOMWEB_USERNAME` and `MONAI_LABEL_DICOMWEB_PASSWORD`. Keep it mode
0600 and never commit it. No credentials belong in build arguments or images.

```
docker compose -f deploy/nifti/compose.test.yml build
docker compose -f deploy/nifti/compose.test.yml up -d --pull never
```

For local browser acceptance, forward loopback port 1126 over SSH. Production
continues at HTTPS 9443 until the acceptance checklist passes.

Rollback: stop the test Compose project without `--volumes`. The old production
images are tagged `ohif-ai-vanilla-viewer:pre-nifti-20260915` and
`ohif-ai-vanilla-monai:pre-nifti-20260915`. Never remove the new data volume during
rollback. Copy the entire NIfTI directory (including SQLite WAL/SHM while stopped)
for backup; originals and mask versions are immutable after commit.

Limits: 512 MiB voxels and scaled working buffer, 1 MiB extended header, 514 MiB
file upload, 520 MiB Nginx multipart envelope. Browser working-set default is
1.5 GiB and operations exceeding the budget are rejected. Unsupported formats
and registration/resampling are reported explicitly.

Local opening is private to the browser. Upload original / Save All / AI uploads
the source to the authenticated library. Local ZIP export includes separate
binary NIfTI files and a provenance manifest, preserving overlaps.

## Build reproducibility

The acceptance recipe inherits the frozen, patched baseline dependency image
`ohif-ai-nifti-build-base:20260915`; it does not install a newer Cornerstone loader.
The workspace adds only the existing locked `fflate@0.7.3`. An offline
`yarn install --frozen-lockfile` and the 3.33.5 patch verifier are also checked in
a disposable copy of that dependency image. Never run relinking in a live image.

For a clean viewer build without that cached baseline image:

```
docker build --build-arg APP_CONFIG=config/nifti.js \
  -f Viewers/platform/app/.recipes/Nginx-Orthanc/dockerfile \
  -t ohif-ai-nifti-viewer:clean Viewers
```

The normal recipe installs from the frozen lock, applies patch-package, copies
the project's existing Cornerstone overrides, verifies the Stack labelmap patch,
then compiles the application. The default APP_CONFIG keeps NIfTI disabled.

## Acceptance

Use the test URL `https://server-vanilla.tailb37712.ts.net:9444` or an SSH forward
to loopback 1126. Set `NIFTI_TEST_URL`, `NIFTI_TEST_USERNAME`, and
`NIFTI_TEST_PASSWORD` in the local process environment; never place credentials in
source, URLs or reports. Install Playwright and set `CHROMIUM_EXECUTABLE` to Edge
or Chromium if they are outside its normal browser cache. `PLAYWRIGHT_MODULE`,
`NIFTI_FIXTURES`, and `NIFTI_TEST_OUTPUT` are optional path overrides.

```
node deploy/nifti/browser-acceptance.cjs workflow
node deploy/nifti/browser-acceptance.cjs ui-manifest
node deploy/nifti/browser-acceptance.cjs ui-ai
node deploy/nifti/browser-acceptance.cjs ct-rate
node deploy/nifti/browser-acceptance.cjs memory
node deploy/nifti/browser-acceptance.cjs recovery
node deploy/nifti/browser-acceptance.cjs dicom
node deploy/nifti/browser-acceptance.cjs dicom-ai
node deploy/nifti/browser-acceptance.cjs dicom-interpolation
node deploy/nifti/browser-acceptance.cjs formats
python deploy/nifti/gpu-acceptance.py
node --test Viewers/extensions/nifti/src/format.test.mjs
node --test Viewers/.scripts/stack-labelmap-update.test.cjs
python -m pytest monai-label/tests/nifti_native monai-label/tests/stability_v1
```

Browser reports are written to `acceptance-results` (ignored). Failed memory
tests may include a heap snapshot for local diagnosis; do not publish heap files.
The memory test forces GC using CDP and checks WeakRef reachability, in addition
to private cache counts. Slice latency is measured after full loading and
reported separately from network/download time. See `docs/NIFTI_ACCEPTANCE.md`.

## Paired production release and rollback

For the 2026-09-16 worklist/manifest revision, use the distinct release script:

```
python3 deploy/nifti/release-ui.py prepare
python3 deploy/nifti/release-ui.py activate
# To restore the immediate previous native UI/backend:
python3 deploy/nifti/release-ui.py rollback
```

This preserves the 2026-09-15 native pair in `deploy/nifti-ui-release-20260916`
and leaves the original pre-native rollback snapshot intact. It adds only the
read-only `/data/cache/datasets/CT-RATE` mount and matching `NIFTI_IMPORT_ROOTS`.
Test fixture roots must not be exposed in production. Use `refresh` to select
a subsequent tested image pair without replacing the rollback boundary.

The pinned 3.33.5 interpolation runtime is patched by
`Viewers/.scripts/install-interpolation-runtime.js` and bundled at
`/itk/interpolation/`; verify the real DICOM interpolation button uses only this
same-origin location. See `docs/NIFTI_UI_REVISION_20260916.md` for revision results.

The following describes the original 2026-09-15 native release boundary:

After isolated acceptance, run on vanilla from this source tree:

```
python3 deploy/nifti/release.py prepare
python3 deploy/nifti/release.py activate
```

`prepare` captures exact running image IDs and the current Nginx configuration in
`/home/ubuntu/ohif-ai/deploy/nifti-release-20260915`. It refuses to replace a prior
snapshot. Review `release.json` and `candidate.yml` before activation. The script
retains all existing DICOM mounts, adds a distinct `ohif-ai-nifti-images` volume,
and changes only the viewer/backend services; production remains on GPU 0.
The isolated test images, test Orthanc and GPU 1 remain separate.

For a subsequently tested candidate, run `python3 deploy/nifti/release.py
refresh-candidate` before `activate`. This updates candidate image IDs while
preserving the original rollback images and Nginx configuration.

```
python3 deploy/nifti/release.py rollback
```

Rollback restores both exact previous images and previous Nginx configuration.
It does not migrate or delete either old DICOM drafts or new native NIfTI data.
Verify `/monai/health`, an authenticated viewer page and the DICOM list after a
switch. Do not use `docker compose down --volumes` during rollback.

## Storage audit and backup

Stop only the native-writing backend before taking a filesystem backup or doing
a recovery audit. Copy the whole volume, including SQLite WAL/SHM and immutable
source/mask version directories. Run `audit-library.py VOLUME_PATH`; expected
output is integrity `ok` with no missing/orphaned files. The audit never deletes
files. Preserve and investigate orphaned versions after an interrupted commit;
the writer allocates a later version instead of overwriting them.

Native logs include upload, parse, model-session and inference durations, working
bytes, busy responses and failure classes/codes. No voxel arrays or credentials
are logged. Browser diagnostics expose source/cache counts and budget usage via
the NIfTI utility module; they are not included in patient-facing controls.

Immutable originals and mask versions use `NIFTI_ACCEL_REDIRECT_PREFIX` to send
files through Nginx after API identity checks. The viewer mounts the same native
volume read-only at `/var/nifti-images`; its `/_nifti-files/` location is internal
and cannot be fetched directly. Without this setting (for API tests/development),
the backend uses its normal FileResponse implementation.

## Server NIfTI slice streaming (2026-10-08)

Server cases open at the middle original IJK slice unless a saved position or
explicit navigation supplies another slice. The displayed slice loads first;
only its nearest eight slices in either direction are prefetched. Previously
viewed slices remain reusable. This mode never automatically fetches `/file`.
Local file opening retains the existing complete worker parser.

The download icon in the native panel expands source loading status, retry and
complete-load controls. A spinner indicates active requests; a warning icon
indicates failed frames. Two-dimensional brush, eraser, threshold, mask saving
and native AI work without downloading the rest of the original. All mask
buffers and saved versions remain complete, including unviewed regions.
MPR/3D, sphere tools and interpolation await the missing original slices before
executing. Complete loading can be cancelled while preserving loaded slices and
all edits. History previews and mask selection await their required source slice.

Transport protocol 1 carries original dimensions, millimetre LPS geometry,
source/content/geometry identities, working and wire dtypes, and each frame's
decompressed length and SHA-256. Gzip level 1 is lossless. Float32 is sent as
int16 only if every voxel passes an IEEE-bit round trip; decoded pixels use the
original working dtype. Scaling is applied on the server exactly once. Frame
decode, hash verification and dtype restoration run in up to three reusable
workers owned by the case. Cancellation terminates the affected worker; case
closure terminates the pool. Authenticated assets with content hashes use private
immutable browser caching; entry HTML and runtime configuration remain uncached.
There are at most three active frame requests, of which at most two are
background work. Each attempt has a 60-second idle and 180-second total deadline;
transient failures get at most two retries. Invalid pixels never reach a viewport.

The complete shared source allocation remains in memory: this version reduces
network waiting and transfer, not source buffer size. The existing 512 MiB
working-data limit and configurable 1.5 GiB browser allocation budget apply.
Processing reservations have distinct request identities, including cancellation
and restart races. Closing a case cancels tasks and releases native metadata,
image/volume caches, workers and source buffers.

Enable frontend `enableNiftiStreaming` and backend `ENABLE_NIFTI_STREAMING`
together. Both default off. A frontend enabled against a backend without the
capability reports an error; it does not silently download a complete file.
The independently rebuildable cache uses `NIFTI_STREAM_CACHE_DIR`,
`NIFTI_STREAM_CACHE_MAX_BYTES` (10 GiB by default), and
`NIFTI_STREAM_ACCEL_REDIRECT_PREFIX`. Originals, SQLite records and mask versions
are never written by this cache. Preparation is deduplicated in one background
executor separate from the AI lock. Frames are compressed on demand; corrupt
cache files are rebuilt, and least recently used unpinned generations are
evicted with a short grace period for delegated file responses.

`/_nifti-stream-cache/` must be an Nginx **internal** location mounted read-only
in the viewer. Its `add_header` directives preserve `X-Nifti-Cache-Key`,
`X-Nifti-Frame` and the raw checksum ETag across X-Accel-Redirect. A direct browser
request cannot access this directory. The authenticated API exposes
`POST /{id}/stream/prepare`, `GET /{id}/stream` and `GET /{id}/frames/{index}`.

`release-streaming.py test` updates the existing isolated 1126/9444 environment
using separate source, mask and cache volumes. `prepare` records the exact active
production pair and configuration, then constructs a candidate with a separate
production cache volume. `activate` switches both images together; `rollback`
restores their saved pair. Neither operation deletes originals, masks or cache
volumes. OCI index/platform image identities are resolved using a disposable,
never-started probe container so rollback checks compare actual container images.

Browser acceptance scripts `streaming-acceptance.cjs` and
`streaming-edge-acceptance.cjs` record first-render timing, network paths,
decompressed frame decode timing, annotation recovery and ten-cycle memory
checks. Functional tests can use a temporary compressed SSH tunnel to isolated
1126 (`127.0.0.1:1326`) to avoid duplicating large uncompressed DICOM/mask uploads
on the slow relay. Performance measurements use the actual HTTPS entry alone,
with CDP 250000 bytes/s and 100 ms added latency, and exclude app initialization.
Do not compare tunnel functional timings with HTTPS performance targets.

Release acceptance on 2026-10-08: 131 backend pytest tests, 25 frontend Jest
tests and 17 Node parser/codec/scheduler tests passed. Isolated real-GPU tests
covered positive/negative points, boxes, scribbles, reset and target switching
with only 20 of 96 source slices loaded. Brush, eraser, intensity threshold,
complete-mask saving/reloading, history previews, focus pulses, display styles,
interpolation and ten open/close cycles passed. Closing a case also releases
Cornerstone 3.33.5's shared native brush preview, which otherwise retains a source
voxel manager after ToolGroup destruction. DICOM drafts, DICOM-SEG/PACS round
trips, MPR and interpolation passed in the isolated deployment.

On the acceptance Windows machine (Core Ultra 9 275HX, Edge 154, 1500 x 1000),
the actual production HTTPS entry with CDP 250000 bytes/s and 100 ms added
latency showed HOSP001 in 7.189 s with a cold server cache and 3.193 s warm.
The decoded displayed slice matched its server checksum. A 128 MiB synthetic
CT in isolated HTTPS measured 4.5 ms p95 across 50 cached slice changes using
the viewport's IMAGE_RENDERED event; none requested source frames. These are
render-path measurements, not a guarantee for all hardware or network conditions.
Production idle loading stopped at exactly 17/352 slices, and closing HOSP001
released its tracked original buffer. Read-only production DICOM browsing also
passed without saving or changing clinical annotations. Raw measurements,
screenshots and the consolidated receipt live in
`release-artifacts/nifti-streaming-20261008`.
