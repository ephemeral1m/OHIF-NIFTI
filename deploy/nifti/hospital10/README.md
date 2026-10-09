# HOSP001–HOSP010 NIfTI batch

Requested source task: `01a0e705-110f-72a2-a0a6-9bf1082f0827` (Clone并跑通NV-Reason-CT).
Batch identifier: `hospital-10-20261008`. These are the ten hospital cases selected and converted on ant, not the earlier ReX cases.

## Loading

1. Open `https://server-vanilla.tailb37712.ts.net:9443/nifti`.
2. Choose **导入 CSV / JSON**, select **CT**, then load `outputs/hospital-10-20261008/hospital_10_images.csv`.
3. Open any of HOSP001–HOSP010. Paths are absolute; the relative-path base does not need changing.

The CSV has image, segmentation1 and segmentation2 columns. No segmentation files were provided with this batch; both optional columns are empty. All ten originals are also registered in the server library as CT.

## Storage and verification

- Original converted files on ant: `/home/ant/nv-reason-colipri-val/ct/HOSP001.nii.gz` through `HOSP010.nii.gz`.
- Vanilla batch: `/home/ubuntu/ohif-ai/nifti-demo/hospital-10-20261008`.
- Transfer: SSH/rsync directly between the servers, exact files, SHA-256 checked on destination. Total compressed size: 1,521,777,685 bytes. No resampling or recompression. Staging files are hard-linked to final files after verification, not duplicated allocations.
- The new batch directory is an independent read-only backend mount and allowed import root.
- Source NIfTI datatype is float32 HU; largest voxel buffer is 387 MiB. Full parsing of all ten cases passes the application's geometry, intensity, gzip and size checks.
- Imported originals use the existing `nifti_images` volume. Further saved masks use the existing sourceId/version scheme; original converted files stay unchanged.
- `inventory.json`, `registrations.json` and `acceptance.json` record checks and identities. No patient identity mapping or DICOM source files were transferred.
- Browser acceptance: the CSV lists all ten cases; HOSP001 opens with 352 slices and a visible CT image, with no page errors. All ten passed server parsing; only HOSP001 was opened fully in the browser during this check.
- On the acceptance connection, downloading HOSP001 (153.7 MiB compressed) took approximately 11 minutes before viewing. This is an observed first-load transfer time, not a slice-rendering benchmark; the files were not downsampled to reduce it.

## Deployment

Viewer and backend images remain those from the 2026-09-24 release. Only the backend mount/environment configuration changed; it was restarted to expose the new root.

Current override: `/home/ubuntu/ohif-ai/deploy/nifti-hospital10-release-20261008/candidate.yml`.
The same directory contains `previous.yml` for reverting the added mount/root. Reverting configuration does not delete this batch or imported library records.

## Follow-up report and left-panel work

`case_associations.json` is an integration draft, not a report-enabled viewer format. Its cases can be read by today's JSON image loader, but the loader currently ignores additional report fields.

It records batch-scoped caseId, content SHA-256, sourceId, geometryHash and report references keyed by the same HOSP number. Referenced reports remain on ant: hospital original, NV English output, NV Chinese translation and COLIPRI finding scores. The hospital fields 报告结论 and 报告表现 retain their original names. Translations point to the corresponding original report; model scores are not converted into confirmed findings or masks.

Next UI scope: retain the full imported case list in the left panel; expand each case into image/report/finding/segmentation entries; show hospital and model reports in a dedicated right panel; bind all navigation through these stable case/source/report IDs. No report panel or left-panel behavior changes were made in this data-transfer task.
