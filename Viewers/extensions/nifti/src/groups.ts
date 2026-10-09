export type SegmentationSet = { id: string; name: string; kind: 'import' | 'manual' | 'copy' | 'legacy'; sourceFile?: string };

export function newGroup(name = '手工分割', kind: SegmentationSet['kind'] = 'manual', sourceFile?: string): SegmentationSet {
  return { id: crypto.randomUUID().replace(/-/g, ''), name: name.slice(0, 200), kind, ...(sourceFile ? { sourceFile } : {}) };
}

export function importGroup(filename: string) {
  const stem = filename.replace(/\.nii(?:\.gz)?$/i, '').split('__').pop();
  return newGroup(`${stem} · 原始标注`, 'import', filename);
}

export function targetName(mask) {
  const name = mask.label || mask.name || '未命名目标';
  const file = mask.originalFile || mask.saved?.originalFile;
  const value = mask.originalLabel ?? mask.saved?.originalLabel;
  if (file && value && (name === file || name === `${file} / ${value}`)) return `目标 ${value}`;
  if (file && value && name.startsWith(`${file} / ${value} · `)) return `目标 ${value}` + name.slice(`${file} / ${value}`.length);
  return name;
}

export function maskGroup(source, mask): SegmentationSet {
  if (!mask.segmentationSet) mask.segmentationSet = mask.saved?.segmentationSet || newGroup(targetName(mask), 'legacy');
  return mask.segmentationSet;
}

export function groupedMasks(source) {
  const groups = new Map<string, any>();
  for (const mask of source.masks.values()) {
    const group = maskGroup(source, mask);
    if (!groups.has(group.id)) groups.set(group.id, { ...group, masks: [] });
    groups.get(group.id).masks.push(mask);
  }
  return [...groups.values()];
}

// Resolve display text through manifest identities, never through filename order.
export function groupFindingName(group, row) {
  const ids = new Set(group.masks.map(mask => mask.saved?.maskId).filter(Boolean));
  const names = (row?.findings || [])
    .filter(finding => finding.maskIds?.some(id => ids.has(id)))
    .map(finding => [finding.name, finding.text].find(value => typeof value === 'string' && value.trim())?.trim())
    .filter(Boolean);
  return [...new Set(names)].join(' / ') || group.name;
}

export function groupPresentation(source, id) {
  source.groupPresentation ||= new Map();
  if (!source.groupPresentation.has(id)) source.groupPresentation.set(id, { visible: true, opacity: 1, expanded: true });
  return source.groupPresentation.get(id);
}
