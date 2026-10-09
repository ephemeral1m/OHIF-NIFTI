import {
  buildDraftReconcilePlan,
  canonicalDraftsForLoad,
  getDraftDirtyReasons,
  withDraftDirtyState,
} from './niftiDraftState';

describe('niftiDraftState', () => {
  test('selects the refined draft for a lineage and sorts by label', () => {
    const drafts = canonicalDraftsForLoad([
      { filename: 'b.nii.gz', label: 'B' },
      { filename: 'a.nii.gz', label: 'A' },
      {
        filename: 'a-refined.nii.gz',
        origin: 'a.nii.gz',
        label: 'A refined',
        created: '2026-01-02T00:00:00Z',
      },
    ]);

    expect(drafts.map(draft => draft.filename)).toEqual(['a-refined.nii.gz', 'b.nii.gz']);
  });

  test('classifies independent dirty reasons', () => {
    expect(
      getDraftDirtyReasons({
        segmentationId: 'seg-1',
        segmentIndex: 1,
        label: 'Liver renamed',
        draftRoot: 'liver.nii.gz',
        currentDraftFilename: 'liver.nii.gz',
        savedMaskHash: 'before',
        currentMaskHash: 'after',
        savedLabel: 'Liver',
        isDirty: true,
        standalone: true,
      })
    ).toEqual(expect.arrayContaining(['voxel-modified', 'label-modified', 'explicit-dirty']));

    expect(
      getDraftDirtyReasons({
        segmentationId: 'seg-new',
        segmentIndex: 1,
        label: 'New mask',
        standalone: true,
      })
    ).toContain('new');
  });

  test('keeps an unchanged label-only draft clean and tracks later voxel changes', () => {
    const labelOnly = {
      segmentationId: 'empty-draft',
      segmentIndex: 1,
      label: 'Honeycomb',
      isLabelOnlyDraft: true,
      draftRoot: 'honeycomb.nii.gz',
      currentDraftFilename: 'honeycomb.nii.gz',
      savedMaskHash: 'zero-mask-hash',
      currentMaskHash: 'zero-mask-hash',
      savedLabel: 'Honeycomb',
      standalone: true,
    };

    expect(withDraftDirtyState(labelOnly)).toMatchObject({
      isLabelOnlyDraft: true,
      dirtyReasons: [],
    });
    expect(
      getDraftDirtyReasons({
        ...labelOnly,
        currentMaskHash: 'painted-mask-hash',
      })
    ).toEqual(['voxel-modified']);
    expect(
      getDraftDirtyReasons({
        ...labelOnly,
        label: 'Honeycomb renamed',
      })
    ).toEqual(['label-modified']);
  });

  test('keeps one exact clean standalone mask and removes duplicates', () => {
    const masks = [
      withDraftDirtyState({
        segmentationId: 'keep',
        segmentIndex: 1,
        label: 'Liver',
        draftRoot: 'liver.nii.gz',
        currentDraftFilename: 'liver.nii.gz',
        savedMaskHash: 'same',
        currentMaskHash: 'same',
        savedLabel: 'Liver',
        standalone: true,
      }),
      withDraftDirtyState({
        segmentationId: 'duplicate',
        segmentIndex: 1,
        label: 'Liver',
        draftRoot: 'liver.nii.gz',
        currentDraftFilename: 'liver.nii.gz',
        savedMaskHash: 'same',
        currentMaskHash: 'same',
        savedLabel: 'Liver',
        standalone: true,
      }),
    ];

    const plan = buildDraftReconcilePlan([{ filename: 'liver.nii.gz', label: 'Liver' }], masks);

    expect(plan.keep.map(item => item.mask.segmentationId)).toEqual(['keep']);
    expect(plan.load).toEqual([]);
    expect(plan.removeSegmentationIds).toEqual(['duplicate']);
  });

  test('replaces dirty, legacy multi-segment, stale and local-only masks', () => {
    const masks = [
      withDraftDirtyState({
        segmentationId: 'dirty',
        segmentIndex: 1,
        label: 'Liver',
        draftRoot: 'liver.nii.gz',
        currentDraftFilename: 'liver.nii.gz',
        savedMaskHash: 'old',
        currentMaskHash: 'new',
        savedLabel: 'Liver',
        standalone: true,
      }),
      withDraftDirtyState({
        segmentationId: 'legacy',
        segmentIndex: 1,
        label: 'Kidney',
        draftRoot: 'kidney.nii.gz',
        currentDraftFilename: 'kidney.nii.gz',
        savedMaskHash: 'same',
        currentMaskHash: 'same',
        savedLabel: 'Kidney',
        standalone: false,
      }),
      withDraftDirtyState({
        segmentationId: 'stale',
        segmentIndex: 1,
        label: 'Stale',
        draftRoot: 'stale.nii.gz',
        currentDraftFilename: 'stale.nii.gz',
        savedMaskHash: 'same',
        currentMaskHash: 'same',
        savedLabel: 'Stale',
        standalone: true,
      }),
      withDraftDirtyState({
        segmentationId: 'local',
        segmentIndex: 1,
        label: 'Local',
        standalone: true,
      }),
    ];

    const plan = buildDraftReconcilePlan(
      [
        { filename: 'liver.nii.gz', label: 'Liver' },
        { filename: 'kidney.nii.gz', label: 'Kidney' },
      ],
      masks
    );

    expect(plan.load.map(draft => draft.filename)).toEqual(['liver.nii.gz', 'kidney.nii.gz']);
    expect(plan.removeSegmentationIds).toEqual(
      expect.arrayContaining(['dirty', 'legacy', 'stale', 'local'])
    );
  });
});
