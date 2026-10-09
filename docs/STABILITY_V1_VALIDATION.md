# Stability v1 validation — 2026-08-26

Implemented in `E:\ohif-ai`; **not yet rebuilt/deployed** from this Codex session.

## Completed checks

- Frontend: five Jest suites, 23 tests passed (draft reconciliation, binary masks,
  memory ledger, multipart transport and new backend error decoding).
- Backend: 18 component tests passed. Includes a synthetic DICOM-to-NIfTI roundtrip
  preserving voxel values, dimensions, spacing, origin and direction; source fetch
  failure preserves existing files; empty masks/bad sizes are rejected; explicit
  draft/session synchronization; missing model leaves the draft retrievable;
  missing Study UID does not reuse a previous request's study.
- Runtime checks cover single initialization across concurrent callers, shared
  session locking, missing/corrupt weights, same-shaped different series, 503
  dispatch before touching the application/datastore, and model-independent health.
- Python source parses successfully. The four modified frontend TS/TSX files
  transpile syntactically without errors. Deployment PowerShell syntax is valid.
- Tests use an isolated host test environment, not the running container's package
  versions. AI execution and Orthanc transport are mocked; FastAPI, SimpleITK and
  the save/load endpoint code are real.
- TestClient emitted one upstream deprecation warning about httpx; no test failed.

## Blocked / not claimed

Docker returned Access denied reading the user's normal config/context even after
read permission was requested and granted. No alternative credential/config path
was used to bypass the restriction. No images were built, no containers restarted,
and no production caches or data were removed.

Therefore full MONAI startup, GPU inference, a ten-minute no-OOM/restart observation,
browser workflows and PACS saving have **not** been validated. Run
`Deploy-Stability-V1.ps1` in normal PowerShell, then the manual checks in
`STABILITY_V1.md`. A static source check is not a successful deployment.
