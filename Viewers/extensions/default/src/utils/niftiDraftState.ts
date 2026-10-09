export type NiftiDraft = {
  filename: string;
  origin?: string;
  label?: string;
  created?: string;
  source?: string;
  [key: string]: unknown;
};

export type DraftDirtyReason =
  | 'new'
  | 'voxel-modified'
  | 'label-modified'
  | 'explicit-dirty'
  | 'mask-read-error'
  | 'missing-baseline';

export type LoadedDraftMask = {
  segmentationId: string;
  segmentIndex: number;
  label: string;
  isLabelOnlyDraft?: boolean;
  draftRoot?: string;
  currentDraftFilename?: string;
  savedMaskHash?: string;
  savedLabel?: string;
  isDirty?: boolean;
  currentMaskHash?: string;
  maskReadError?: boolean;
  standalone: boolean;
};

export type LoadedDraftMaskWithDirtyState = LoadedDraftMask & {
  dirtyReasons: DraftDirtyReason[];
};

export type DraftReconcilePlan = {
  keep: Array<{ draft: NiftiDraft; mask: LoadedDraftMaskWithDirtyState }>;
  load: NiftiDraft[];
  removeSegmentationIds: string[];
};

export function draftFamilyRoot(draft: Pick<NiftiDraft, 'filename' | 'origin'>): string {
  return draft.origin || draft.filename || '';
}

function draftCreatedTime(draft: NiftiDraft): number {
  const created = Date.parse(draft.created || '');
  return Number.isFinite(created) ? created : 0;
}

export function preferDraftForFamily(current: NiftiDraft | undefined, candidate: NiftiDraft) {
  if (!current) {
    return candidate;
  }

  const currentIsRefined = !!current.origin;
  const candidateIsRefined = !!candidate.origin;
  if (candidateIsRefined !== currentIsRefined) {
    return candidateIsRefined ? candidate : current;
  }

  const currentTime = draftCreatedTime(current);
  const candidateTime = draftCreatedTime(candidate);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime ? candidate : current;
  }

  return String(candidate.filename || '') > String(current.filename || '') ? candidate : current;
}

export function canonicalDraftsForLoad(drafts: NiftiDraft[]): NiftiDraft[] {
  const byFamily = new Map<string, NiftiDraft>();

  for (const draft of drafts) {
    const root = draftFamilyRoot(draft);
    if (!root) {
      continue;
    }
    byFamily.set(root, preferDraftForFamily(byFamily.get(root), draft));
  }

  return Array.from(byFamily.values()).sort((a, b) => {
    const aLabel = String(a.label || a.filename || '');
    const bLabel = String(b.label || b.filename || '');
    const labelOrder = aLabel.localeCompare(bLabel);
    return labelOrder || String(a.filename).localeCompare(String(b.filename));
  });
}

export function getDraftDirtyReasons(mask: LoadedDraftMask): DraftDirtyReason[] {
  const reasons = new Set<DraftDirtyReason>();
  const hasStoredIdentity = !!(mask.draftRoot || mask.currentDraftFilename);

  if (!hasStoredIdentity) {
    reasons.add('new');
  }
  if (mask.maskReadError) {
    reasons.add('mask-read-error');
  }
  if (mask.isDirty === true) {
    reasons.add('explicit-dirty');
  }

  if (mask.savedMaskHash && mask.currentMaskHash && mask.savedMaskHash !== mask.currentMaskHash) {
    reasons.add('voxel-modified');
  } else if (hasStoredIdentity && !mask.savedMaskHash) {
    reasons.add('missing-baseline');
  }

  if (mask.savedLabel !== undefined) {
    if (mask.label !== mask.savedLabel) {
      reasons.add('label-modified');
    }
  } else if (hasStoredIdentity && mask.label.endsWith(' (edited)')) {
    // Compatibility with sessions produced before savedLabel was recorded.
    reasons.add('label-modified');
  }

  return Array.from(reasons);
}

export function withDraftDirtyState(mask: LoadedDraftMask): LoadedDraftMaskWithDirtyState {
  return {
    ...mask,
    dirtyReasons: getDraftDirtyReasons(mask),
  };
}

export function buildDraftReconcilePlan(
  drafts: NiftiDraft[],
  masks: LoadedDraftMaskWithDirtyState[]
): DraftReconcilePlan {
  const keep: DraftReconcilePlan['keep'] = [];
  const load: NiftiDraft[] = [];
  const keptSegmentationIds = new Set<string>();

  for (const draft of drafts) {
    const root = draftFamilyRoot(draft);
    const candidates = masks.filter(mask => mask.draftRoot === root);
    const exactCleanStandalone = candidates.find(
      mask =>
        mask.standalone &&
        mask.currentDraftFilename === draft.filename &&
        mask.dirtyReasons.length === 0 &&
        !keptSegmentationIds.has(mask.segmentationId)
    );

    if (exactCleanStandalone) {
      keep.push({ draft, mask: exactCleanStandalone });
      keptSegmentationIds.add(exactCleanStandalone.segmentationId);
    } else {
      load.push(draft);
    }
  }

  const removeSegmentationIds = Array.from(
    new Set(
      masks
        // Every current-series NIfTI segmentation not explicitly kept is replaced or removed.
        // This includes local-only, stale, duplicate, dirty and legacy multi-segment entries.
        .filter(mask => !keptSegmentationIds.has(mask.segmentationId))
        .map(mask => mask.segmentationId)
    )
  );

  return { keep, load, removeSegmentationIds };
}

export const DRAFT_DIRTY_REASON_LABELS: Record<DraftDirtyReason, string> = {
  new: '新建，尚未保存',
  'voxel-modified': '体素已修改',
  'label-modified': '名称已修改',
  'explicit-dirty': '存在未保存修改',
  'mask-read-error': 'mask 数据无法读取',
  'missing-baseline': '缺少已保存状态基线',
};
