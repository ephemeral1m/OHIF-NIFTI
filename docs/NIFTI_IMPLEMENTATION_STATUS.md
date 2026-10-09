# Native NIfTI implementation

> Current checkpoint (2026-10-09): see [local development state](CURRENT_STATE_2026-10-09.md).
> The vanilla deployment statements below are historical records, not a fresh
> validation of the server or a deployment of the latest local UI changes.

Scope: the approved M0–M5 plan, NIfTI-1 3D scalar CT/MR, independent source identity,
512 MiB source and scaled buffer limits, single-user AI. The paired release is
active on vanilla HTTPS 9443; isolated acceptance remains on HTTPS 9444.

**Latest: first usability phase is active (2026-09-16).** Explicit 16/14/24px
list typography, working settings/import dialogs, clear storage/type/path labels,
and versioned independent mask colors shared across Stack/MPR. See
`NIFTI_PHASE1_20260916.md` for current images, verification and immediate rollback.
The sections below are historical release records.

**2026-09-16 revision is now active:** dedicated NIfTI worklist/icon, CT-RATE
CSV/JSON import, shared DICOM tool/segmentation panels, group-selection correction
and same-origin interpolation runtime. Production smoke passed with the four
existing DICOM studies and two native sources intact. Exact current images,
123-test backend results and new UI/GPU/memory checks are recorded in
`NIFTI_UI_REVISION_20260916.md`. Immediate previous native rollback is preserved in
`deploy/nifti-ui-release-20260916`; the sections below record the original M0–M5
release on 2026-09-15, not a rerun of every historical test for the UI revision.

## Baseline

- Source: `release-artifacts/nifti-baseline-20260915-200752/source.tar.gz`;
  2,679 files, SHA-256 manifest alongside it. Data, models and credentials excluded.
- Vanilla viewer: `a820277ecf07`, preserved as
  `ohif-ai-vanilla-viewer:pre-nifti-20260915`.
- Vanilla backend: `b92644acd931`, preserved as
  `ohif-ai-vanilla-monai:pre-nifti-20260915`.
- OHIF 3.10.4 / Cornerstone 3.33.5. Existing labelmap patch must remain applied.
- Baseline production-mode build, frozen offline install and patch verification reproduced on vanilla.

## Milestones

| Stage | State |
| --- | --- |
| M0 baseline and fixtures | Complete: source/image snapshots, deterministic and anatomical fixtures, isolated deployment |
| M1 format and geometry | Complete: bounded Worker loader, scaling, affine/LPS and numerical regressions |
| M2 local workbench | Complete: five scalar types, Stack/MPR, cancellation, ten-cycle memory and loaded-scroll acceptance |
| M3 source library | Complete: authenticated SQLite/filesystem library, persistent identities, Nginx file offload |
| M4 masks | Complete: independent labels, Worker alignment, versioned save/reload and ZIP export |
| M5 nnInteractive v2 | Complete native loop: points/boxes/scribbles, target isolation, save/reload and resumed editing |

## Release gate

Native acceptance has passed in Edge/Chromium and on vanilla GPU 1. Python:
114 passed; Jest: 67 tests across 10 suites; Node loader/Stack regressions: 8 passed.
See `NIFTI_ACCEPTANCE.md` for measured results and their scope.

DICOM browsing, MPR, manual-mask PACS voxel roundtrip, v1 AI and old NIfTI draft
save/reload have passed. PACS export/reload of the restored AI draft also passed:
7,816 foreground voxels, identical SHA-256 and source SOP references. The final
reload waits for source CT metadata, which may arrive after SEG metadata.

Storage audit: SQLite integrity `ok`, no missing files or orphaned versions.
The test backend was stopped for the audit and restarted with its data intact.
The production Compose configuration and Nginx syntax were checked before the
paired switch. Production smoke passed: 401 without authentication, authenticated
viewer/library 200, four existing DICOM studies, byte-identical CT/MR originals,
and native inference on GPU 0 (28 foreground voxels in the MR smoke result).

Original 2026-09-15 released image IDs (now the immediate rollback pair):

- Viewer: `sha256:c89026992080f48fd1ebd4e8af6146ee5aec6a8dd4c25eab10a481c8b628a1ee`
- Backend: `sha256:707ce5dbacf7527e27fce4023f763cdb718dd16d5a26f707461e7bb10d6d39f1`

The exact old IDs and Nginx configuration are preserved in
`/home/ubuntu/ohif-ai/deploy/nifti-release-20260915` on vanilla. The release script
switches both components together and retains all data volumes on rollback.

## Access and data separation

- Production: `https://server-vanilla.tailb37712.ts.net:9443/nifti`
- Isolated acceptance: `https://server-vanilla.tailb37712.ts.net:9444/nifti`
- Production NIfTI volume: `ohif-ai-nifti-images`; test volumes remain separate.
- Production chest CT source: `9cfbe22f17874f6ba18406d9e52c8bb0`
- Production MR source: `01ca10b076054b33ae81049258c2504c`

Only the two public demo originals were copied to the production native library.
Test masks and test PACS writes remain in the isolated environment. Existing
DICOM annotations and UID-directory drafts were not migrated or rewritten.
