# Native NIfTI acceptance record — 2026-09-15

Acceptance runs use the isolated vanilla deployment on HTTPS 9444 / loopback
1126, GPU 1, and separate Orthanc, draft and NIfTI volumes. Production 9443 / GPU 0
is not modified by these tests. Final release state is recorded in
`NIFTI_IMPLEMENTATION_STATUS.md`.

## Automated checks

| Check | Result |
| --- | --- |
| Python native format/library/context plus DICOM stability | 114 passed; two test-runtime deprecation warnings |
| Frontend selected-target, stale response, mask, memory/budget, multipart/error and toolbar | 10 Jest suites, 67 tests passed |
| Native loader scaling/affine/gzip/failure and multi-target Stack update regressions | 8 Node tests passed |
| Frozen dependency install | Offline `yarn install --frozen-lockfile` passed in a disposable baseline image |
| Cornerstone Stack labelmap patch | 3.33.5 verifier passed; full production-mode viewer builds passed |
| HTTPS access control | 401 without authentication; authenticated viewer/library 200 |

Python format tests compare deterministic data against NiBabel/SimpleITK,
including five scalar types, both endiannesses, scaling combinations, units,
affines, invalid/truncated/oversized input, and mask label values above 255.
Source identity is compared across the Python and JavaScript implementations.
Library tests include duplicate content, mask versions, failed writes with
rollback, orphan-version preservation, restart reads and path validation.
Protocol tests cover source mismatch, seed order, target/token isolation and a
model-session restart. The DICOM v1 SOP checks remain enabled.

## Browser and GPU evidence

Machine: Windows, Intel Core Ultra 9 275HX, headless browser viewport 1500×950.
Raw JSON reports and screenshots are in `deploy/nifti/acceptance-results`.

- Edge: local oblique Stack, actual mouse brush, labels 300/900 import, MPR,
  independent ZIP export, Save All and server-link reload were exercised.
  Sampled MPR IJK-to-LPS mappings matched the source affine with 0 mm error.
- Final native controls check: UI target selection and brush changed 1,835
  voxels only in the selected mask; the second mask remained empty. Opacity
  was 0.25, Live Mode toggled, and removing the other mask preserved the first
  mask's hash. No runtime errors were reported.
- Edge: real GPU positive/negative points, target switch and reset preserved
  the other target's voxel hash. Box and scribble gestures also passed against
  the real GPU endpoint.
- Chromium: the full AI → Save All → refresh → load → negative-point edit loop
  passed; the saved voxel hash was restored and every other loaded mask retained
  its hash after resumed editing.
- Chromium: uint8, int8, uint16, int16 and float32 each loaded as both `.nii` and
  `.nii.gz` in Stack and MPR without runtime errors.
- Edge: corrupt gzip recovery, unuploaded-source refresh recovery, download
  cancellation, zero remaining reservations and subsequent reopening passed.
- Nginx file offload: downloaded source identity and mask geometry matched;
  authenticated direct access to the internal file path returned 404.
- GPU endpoint: an anatomical chest CT and a 3D MR frame each completed
  native inference, save and load with identical binary voxels and geometry.
  Foreground counts were 106 and 28 respectively. End-to-end request times were
  101.062 s and 4.563 s; these include remote transfer and are not model-only
  inference timings. Synthetic CT/MR also passed this roundtrip.
- Edge: ten successive Stack source close/open cycles released all private
  metadata and cache reservations; after forced GC the old source buffers were
  no longer reachable through WeakRefs.
- Chromium 151.0.7922.34: ten mixed Stack/MPR/new-mask close/open cycles passed
  the same reachability check. No old source allocation remained reachable.

For the 128 MiB source, 50 loaded-slice changes generated **zero fetch/XHR
requests**. The measured API-change-to-`IMAGE_RENDERED` p95 was **4.7 ms in Edge**
and **4.6 ms in Chromium**, below the 100 ms target. This is a headless rendering
measurement, not a promise about initial downloads or every interactive device.
Tailscale/VPN routing and transfer time remain separate concerns.

## Regression findings

The legacy DICOM segmentation panel rejects OT modality, which also hid editing
controls for native images opened with generic intensity. Native mode now uses
its own target selection, brush/eraser, opacity, visibility, label/color, removal
and Live Mode controls. DICOM export remains unavailable in native mode.
The Cornerstone Stack data-update listener also indexed stable actors by array
position. A multiple-target brush check exposed an undefined cached image after
switching targets. The pinned 3.33.5 project patch now matches current image IDs
to each actor's referenced image, skips stale actors, and has a deterministic
regression test for multiple targets and reordered actors.

The source baseline had a toolbar initialization race for very fast local data
and viewport teardown paths retaining DOM/image buffers. The implementation
initializes nested toolbar evaluators before refresh, always unregisters the
global enable listener, clears viewport/prefetch state, and resolves corner-menu
DOM from current viewport identity instead of retaining it in app-level state.

A pre-existing DICOM manual-mask PACS path relied on an AI-only `flipped` flag.
New saves carry exact source SOP identities and the backend maps them to its
authoritative frame order. Unknown/duplicate/missing references are rejected;
legacy requests retain their existing interpretation. DICOM draft formats and
UID directory layouts are unchanged.

The DICOM AI/draft regression also found that a restored draft's structured
prompt description was being assigned directly to DICOM ST. Export now converts
that description to bounded text; the original draft metadata is preserved.

## Fixtures and reproducibility

`deploy/nifti/generate-phantoms.py` generates non-symmetric CT/MR phantoms,
physical landmarks, anisotropic/oblique grids and labels 300/900. The optional
128 MiB image contains exactly 512×512×256 int16 source voxels. Matching masks,
manifest and scalar-format fixtures are under `release-artifacts/nifti-phantoms`.

Anatomical CT was derived read-only from the already imported public SIIM chest
DICOM demo. The MR fixture is spatial frame zero of NiBabel's packaged
`tests/data/example4d.nii.gz`; `derive-demo.py` records this preparation in a
sidecar. Native 4D loading remains rejected. Test Orthanc contains a copy of the
800 existing public DICOM instances; no production annotations are used for
writes. See the deployment README for exact test commands and environment.

## Release gate

Native Worker, format/recovery, extended AI, memory and full native editing
roundtrip checks have passed. DICOM v1 AI and NIfTI draft voxel roundtrip passed;
the final PACS retry after description normalization is recorded separately.
That retry succeeded; the final reloaded mask has 7,816 foreground voxels and
the same `ce9c3904…` SHA-256 and SOP references as the original AI-edited draft.
One test initially attempted SEG hydration before its CT metadata existed;
waiting for the referenced display set resolved that test timing issue.
The implementation status records the paired production image IDs and switch
state. Heap snapshots are diagnostic files and are excluded from the evidence
bundle.

Production checks passed after the paired switch: four existing DICOM studies,
authenticated viewer and native library, byte-identical copies of the public
CT/MR originals, and real native MR inference on GPU 0. The new production
library contains no copied acceptance masks. SQLite audit returned `ok` with no
missing or orphaned files; restart preserved the acceptance library.

## Local mask display regression — 2026-10-09

Fixed duplicate Stack labelmap actors after slice navigation, explicit outline
disable (including the volume preLoad path), and the faint outline-only fill
when outline opacity is zero. Native NIfTI volumes now expose the immutable
scaled intensity range required by MPR opacity restoration. Webpack's cache key
includes the project segmentation patches so restarting development cannot
silently reuse a stale node_modules rendering replacement.

Validation on the local Docker development service:

- Three renderer/Stack identity regression tests passed, plus 14 existing NIfTI
  presentation, memory-budget and mask-recovery Jest tests.
- `deploy/local/mask-style-check.cjs` passed with `valid_254_a_2` (13 masks) in
  Stack and with `MASK_MPR=1` after entering and leaving MPR. Zero/90% fill,
  outline width, explicit outline disable, zero outline, group opacity and
  other-target opacity were checked against actual renderer objects.
- Both paths retained exactly 14 actors (one source + 13 masks), with no page
  errors or unhandled rejections. Screenshots confirmed MPR views and no mask
  residue after hiding all targets. Evidence is in
  `local-data/acceptance/mask-style.json` and `mask-style-mpr-result.json`.
- Installed Cornerstone 3.33.5 replacement verification passed. Frontend was
  restarted; no source images, saved masks or user browser edits were modified.

This check covers the reported local display regression; a full DICOM AI/PACS
acceptance run was not repeated. Existing browser tabs must be refreshed after
saving any pending edits to discard old renderer objects.

### ReX `valid_254_a_2` repeated-region audit

The subsequent content audit found a separate cause of apparent residual fill:
original ReX finding axes 0, 1 and 2 are voxel-identical (44,653 foreground
voxels each, labels 1/2/3). The derived 3D files match those original axes.
All 13 stored binary masks match their original finding/label exactly; they
represent only seven distinct binary regions. F1/F2/F3 therefore render three
copies of each shared region when all findings are visible.

`deploy/datasets/rexgroundingct/audit-mask-overlap.py` performs the read-only
source/derived/server comparison. `deploy/local/mask-content-check.cjs` verified
the actual VTK scalar data at slice indices 73, 109, 50 and back to 73: 13
distinct buffers, 13 actors, all slice hashes matching the saved source masks.
Evidence: `local-data/acceptance/valid_254_a_2-mask-audit.json` and
`valid_254_a_2-render-audit.json`. No saved mask or manifest was modified.

Opacity control tests alone do not establish distinct mask content. Shared
regions should be explained in the finding UI; hiding other targets isolates
the selected target today. Automatic destructive deduplication would lose the
independent finding associations and is not an appropriate display fix.

### Layout menu and finding titles — 2026-10-09

Native custom grids now populate otherwise-empty cells with the active source;
DICOM multi-series selection retains its existing behavior. Volume preparation
is selected from the requested protocol's viewport types, including
`primaryAxial`, rather than matching `mpr`/`3d` in its ID. After setting native
volumes, loaded source masks are reconciled and rendered so the reused primary
viewport does not lose masks while peer viewports hydrate. The layout popover
and its SVG fills use the black/purple workbench palette.

Annotation group titles resolve manifest finding names/text through saved mask
IDs. Missing/blank/unmatched findings preserve the stored group name. Multiple
associated findings remain visible; names are presentation-only and do not
rewrite mask provenance.

`deploy/local/layout-check.cjs` passed on `train_13249_b_2`: initial Axial Primary,
top-row 1x1/1x2/2x2/2x3, and custom 2x2. Every final-path viewport had seven
actors (source plus six masks), with no unhandled rejections. Initial Stack to
1x2 was also checked with `GRID_FIRST=1`. Six group-title/presentation Jest tests
passed. Browser evidence and screenshots are under `local-data/acceptance/layout-*`.
An existing Toolbox nested-button React warning remains; no full DICOM/PACS
regression was performed for these local UI changes.

### MPR annotation tools and native panel prototype — 2026-10-09

The MPR group lacked all brush/eraser/threshold instances although its AI
prompt tools were registered. Stack and MPR now construct the same drawing
tool configurations (including the registered scissors tools). Segmentation
button evaluation rejects unsupported groups and missing active segments.
Toolbar dispatch no longer mutates registered commands with stale option
closures; delayed sphere activation cannot override a later tool selection.
The legacy manual Toolbox no longer reacts to the AI-only lock effect.

The native panel replaces both old toolboxes with one black/violet tool card:
AI prompts and manual editing tabs, active-tool status, icon tiles, contextual
parameters, polarity/live/lock controls, and existing action commands. It uses
the actual toolbar state and cancels superseded asynchronous AI preparation.

`deploy/local/tool-switch-check.cjs` passed in isolated Edge on
`train_13092_a_2` with fourteen masks: 36 tool selections across Stack and all
three Axial Primary viewports; repeated sphere/circle changes; registered
command count remaining zero. Real brush strokes in axial, sagittal and
coronal planes each changed exactly the selected mask. SHA-256 comparisons
of all mask buffers confirmed thirteen other masks stayed unchanged. No page
errors or inference requests occurred, and no test edits were saved.

The existing nnInteractive controller/edit/argument suites passed 41 tests,
including MPR prompt order and native v2 source mapping. Actual GPU inference
and a full DICOM/PACS regression were not rerun. Webpack compiled with its
existing circular-chunk and repeated InjectManifest warnings. Browser evidence:
`local-data/acceptance/tool-switch.json`, `tool-studio-manual.png`,
`tool-studio-ai.png`, and `tool-studio.png`.

### Top/collapsible tools, prompt cursors, Crosshairs toggle — 2026-10-09

The native annotation tool card is the first item in the right annotation panel.
Its header folds/unfolds the body without unmounting controls or changing the
active tool. The header retains the active-tool badge while folded.

The baseline browser reported `cursor: auto` for Probe2 in Stack and all MPR
viewports: custom AI tool names lacked cursor descriptors, and unspecified
`useCursors` disabled cursor updates. AI aliases now register their base tool
SVG cursors; cursors default on while an explicit `useCursors: false` remains
respected. Crosshairs now dispatches the existing active/disabled toggle, with
previous-primary restoration and a WindowLevel fallback. The active-group-ID
helper returns an ID rather than a group object.

`deploy/local/annotation-controls-check.cjs` passed in isolated Edge on
`train_13249_b_2`: top placement, fold/expand retaining Points, browser decoding
of the SVG cursor, inherited canvas cursors in all three MPR viewports,
Crosshairs on/off restoring Points, two on/off rounds restoring Brush, and
direct Points activation disabling Crosshairs. No page errors occurred.
Screenshots visually checked: `annotation-top.png`, `annotation-collapsed.png`;
state evidence: `local-data/acceptance/annotation-controls.json`. No inference
or mask edits were performed for this check. Existing webpack warnings remain.

### Axial Primary after an in-place case switch — 2026-10-09

Reproduced after using Axial Primary on case A, switching to B, and immediately
requesting Axial Primary again. A fresh Stack-only case switch did not reproduce
it. The captured error was `getDisplaySetByUID: displaySetInstanceUid must be a
string, you passed null`: old study selector overrides survived source release,
and clearing the active selector had stored null instead of deleting its key.

Selector clearing now deletes the override. Successful native case switches
remove only the released study's selector, grid, stage and toggle caches;
failed staging retains the previous study's state and cleans the staged study.
Protocol validation remains strict.

Six Jest tests passed (switchCase plus releaseStudyLayoutState). The isolated
Edge regression `deploy/local/case-layout-check.cjs` passed A -> B -> C -> A,
including a 2x2 layout before switching to C, then direct Axial Primary for
each case. It covered train_12470_a_1, train_13249_b_2 and train_13092_a_2;
all three MPR viewports retained source plus 3/6/14 masks respectively, with
one active source and no console/page errors. Evidence: `case-layout.json`
and `case-layout.png` under local-data/acceptance. No masks were edited or saved.

### Default browse and explicit annotation activation — 2026-10-09

Native NIfTI starts in Pan (labelled 浏览, first button in the top toolbar),
including successful in-place case switches and the unused MPR tool group.
Left drag pans and the existing wheel binding scrolls slices. Clicking an
active annotation tool again returns all groups to browse. Changing the
AI/manual category no longer implicitly activates a tool. Browse retains AI
marker visibility in Enabled mode without passive handle editing. Existing
AI preparation is invalidated when another tool is activated.

Four switchCase Jest tests passed. `deploy/local/browse-tools-check.cjs` passed
in isolated Edge: initial browse, all eight AI/manual tool toggle pairs in
Stack and each of three MPR viewports, toolbar browse exiting AI/Crosshairs,
actual image panning, and case replacement resetting AI to Pan. No page errors,
inference requests or mask saves. Evidence: `browse-tools.json` and visually
checked `browse-tools.png` in local-data/acceptance. An initial test timed out
while frontend edits were rebuilding; the completed build passed the rerun.
Existing tool-switch/annotation-controls scripts now respect toggle semantics
when ensuring a tool is active. Existing webpack warnings remain.
The updated annotation-controls browser regression also passed: panel collapse,
AI SVG cursor decoding, and repeated Crosshairs toggles restoring Points/Brush.

### Experimental brand and unified image catalogs — 2026-10-10

The approved aperture concept is implemented as curved SVG strokes with rounded
end caps (34 CSS pixels in the header), replacing the CSS-mask prototype.
The shared Header defaults to OHIF-AI / EXPERIMENTAL in NIfTI, DICOM and viewer
routes while retaining explicit white-label overrides. Palette tokens now live
beside the shared brand, preserving existing viewer colors. Catalog-only rules
restyle legacy DICOM filters, study expansion, pagination and menu portals.

NIfTI uses a unified catalog shell with clear source tabs, compact contextual
help, searchable manifest rows, report/Finding/segmentation-file counts,
expandable file details, sticky open actions and the existing import dialogs.
Counts describe manifest file references, not the number of segmentation targets.
No persistence, source parsing, inference or mask semantics changed.

`deploy/local/catalog-design-check.cjs` passed in isolated Edge at 125% device
scale: five ReX manifest cases, search and empty results, file expansion, settings
and import dialogs, library refresh, DICOM patient filtering and series expansion,
NIfTI opening with six masks, and DICOM synthetic CT rendering (24 slices).
1440px and 800px layouts were checked; horizontal overflow stays inside the table.
Dialog opacity/background and the 34px viewer logo were verified. No page errors
or annotation saves. Evidence: catalog-design.json and catalog-*.png under
local-data/acceptance. Earlier harness attempts used the wrong patient input ID
and queried the viewport service before initialization; both test waits/selectors
were corrected. The frontend compiles with the two existing webpack warnings.

### Approved single-line wordmark — 2026-10-10

User selected the lighter text-only variant, superseding the aperture icon.
The shared brand now reads OHIF-AI - Experimental on a single baseline: 20px
main name with purple AI and a 14px muted suffix. Existing teal interface
accents remain. The icon and stacked uppercase subtitle were removed.
Checked both catalogs and the NIfTI viewer in isolated Edge. At a 1024px viewer
width the brand ends at 218px and tools start at 295px; its height is 24px.
Evidence: local-data/acceptance/text-brand-live.png. Updated catalog regression
assertions to check text-only, single-line branding instead of SVG dimensions.
