import { cache, eventTarget } from '@cornerstonejs/core';
import { segmentation, Enums } from '@cornerstonejs/tools';
import { triggerSegmentationDataModified } from '@cornerstonejs/tools/segmentation/triggerSegmentationEvents';
import { sources, reserve, release, config } from './sourceStore';
import { parseInWorker, alignInWorker } from './workerClient';
import { ensureStored, request, upload, downloadMask } from './api';
import { transformPoint } from './format.mjs';
import { initialMaskColor, validColor } from './maskColors.mjs';
import { newGroup, importGroup, maskGroup, targetName } from './groups';

export function currentSource(servicesManager) {
  const { viewportGridService, displaySetService } = servicesManager.services;
  const { activeViewportId, viewports } = viewportGridService.getState();
  const ds = displaySetService.getDisplaySetByUID(viewports.get(activeViewportId)?.displaySetInstanceUIDs?.[0]);
  const source = sources.get(ds?.sourceKey);
  if (!source) throw new Error('请先打开 NIfTI 原图。');
  return { source, ds, viewportId: activeViewportId };
}

function sliceHashes(ids: string[], previous?: number[], modified?: number[]) {
  const result = previous?.length === ids.length ? [...previous] : [];
  const indices = result.length && modified?.length ? modified : ids.map((_, i) => i);
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= ids.length) continue;
    let hash = 2166136261;
    for (const value of cache.getImage(ids[index]).voxelManager.getScalarData()) hash = Math.imul(hash ^ value, 16777619) >>> 0;
    result[index] = hash;
  }
  return result;
}

function assertActive(servicesManager, source, signal?) {
  signal?.throwIfAborted();
  if (sources.get(source.sourceKey) !== source || currentSource(servicesManager).source !== source) {
    throw new DOMException('病例已切换，已取消旧病例加载。', 'AbortError');
  }
}

export async function createMask(servicesManager, label: string, pixels?: Uint8Array, saved?, signal?, group?) {
  const { source, ds, viewportId } = currentSource(servicesManager);
  assertActive(servicesManager, source, signal);
  if (!config.enableNiftiEditing) throw new Error('NIfTI 编辑尚未启用。');
  const { segmentationService } = servicesManager.services;
  const active = source.masks.get(segmentationService.getActiveSegmentation(viewportId)?.segmentationId);
  const selectedGroup = group || saved?.segmentationSet || (active && maskGroup(source, active)) || newGroup();
  // UI group views also contain masks and presentation state; persist only identity metadata.
  const segmentationSet = { id: selectedGroup.id, name: selectedGroup.name, kind: selectedGroup.kind,
    ...(selectedGroup.sourceFile ? { sourceFile: selectedGroup.sourceFile } : {}) };
  const id = `${source.sourceKey}:mask:${crypto.randomUUID()}`;
  reserve(id, source.descriptor.count);
  try {
    await segmentationService.createLabelmapForDisplaySet(ds, { segmentationId: id, label,
      segments: { 1: { label, active: true, cachedStats: { sourceType: 'native-nifti', isDirty: !saved } } } });
    assertActive(servicesManager, source, signal);
    const seg = segmentation.state.getSegmentation(id);
    if (pixels) {
      let offset = 0;
      for (const imageId of seg.representationData.Labelmap.imageIds) {
        const target = cache.getImage(imageId).voxelManager.getScalarData();
        target.set(pixels.subarray(offset, offset + target.length)); offset += target.length;
      }
    }
    await segmentationService.addSegmentationRepresentation(viewportId, { segmentationId: id, type: Enums.SegmentationRepresentations.Labelmap });
    assertActive(servicesManager, source, signal);
    const displayColor = validColor(saved?.displayColor) ? saved.displayColor : initialMaskColor(
      `${source.descriptor.contentHash}:${saved?.maskId || label}`,
      [...source.masks.values()].map(mask => mask.displayColor)
    );
    segmentationService.setSegmentColor(viewportId, id, 1, displayColor);
    segmentationService.setActiveSegmentation(viewportId, id);
    segmentationService.setActiveSegment(id, 1);
    source.masks.set(id, { segmentationId: id, label, saved, segmentationSet, displayColor, revision: 0, savedRevision: saved ? 0 : -1, generation: 0,
      imageIds: [...seg.representationData.Labelmap.imageIds], hashes: sliceHashes(seg.representationData.Labelmap.imageIds) });
    triggerSegmentationDataModified(id);
    return id;
  } catch (error) { segmentationService.remove(id); release(id); throw error; }
}

export function maskAppearance(servicesManager, mask) {
  try {
    const { viewportId } = currentSource(servicesManager);
    const color = servicesManager.services.segmentationService.getSegmentColor(viewportId, mask.segmentationId, 1);
    if (validColor(color)) return [...color];
  } catch { /* A viewport may be switching layouts. */ }
  return mask.displayColor;
}

export function isMaskDirty(servicesManager, mask) {
  return mask.revision !== mask.savedRevision || (!!mask.saved &&
    JSON.stringify(maskAppearance(servicesManager, mask)) !== JSON.stringify(mask.saved.displayColor || mask.displayColor));
}

export function readMask(source, id): Uint8Array {
  const seg = segmentation.state.getSegmentation(id);
  const ids = seg?.representationData?.Labelmap?.imageIds;
  if (!ids?.length) throw new Error('Mask 缓存不完整。');
  const pixels = new Uint8Array(source.descriptor.count);
  let offset = 0;
  for (let i = 0; i < ids.length; i++) {
    const image = cache.getImage(ids[i]);
    if ((image?.referencedImageId || seg.representationData.Labelmap.referencedImageIds?.[i]) !== source.imageIds[i]) throw new Error('Mask 与原图切片顺序不一致。');
    const slice = image.voxelManager.getScalarData();
    for (let j = 0; j < slice.length; j++) pixels[offset++] = slice[j] === 1 ? 1 : 0;
  }
  if (offset !== pixels.length) throw new Error('Mask 尺寸不一致。');
  return pixels;
}

export function attachMaskEvents() {
  eventTarget.addEventListener(Enums.Events.SEGMENTATION_MODIFIED, (event: any) => {
    const seg = segmentation.state.getSegmentation(event.detail.segmentationId);
    for (const source of sources.values()) {
      const mask = source.masks.get(event.detail.segmentationId);
      const next = seg?.segments?.[1]?.label;
      if (mask && next && mask.label !== next) { mask.label = next; mask.revision++; }
    }
  });
  eventTarget.addEventListener(Enums.Events.SEGMENTATION_ADDED, (event: any) => {
    const seg = segmentation.state.getSegmentation(event.detail.segmentationId);
    const refs = seg?.representationData?.Labelmap?.referencedImageIds;
    const source = [...sources.values()].find(s => refs?.length && refs[0] === s.imageIds[0]);
    if (source && !source.masks.has(seg.segmentationId)) {
      source.masks.set(seg.segmentationId, { segmentationId: seg.segmentationId, label: seg.label || 'Mask',
        revision: 0, savedRevision: -1, imageIds: [...seg.representationData.Labelmap.imageIds] });
    }
  });
  eventTarget.addEventListener(Enums.Events.SEGMENTATION_DATA_MODIFIED, (event: any) => {
    for (const source of sources.values()) {
      const mask = source.masks.get(event.detail.segmentationId);
      if (mask) {
        const hashes = sliceHashes(mask.imageIds, mask.hashes, event.detail.modifiedSlicesToUse);
        if (!mask.hashes || hashes.some((h, i) => h !== mask.hashes[i])) mask.revision++;
        mask.hashes = hashes;
      }
    }
  });
  eventTarget.addEventListener(Enums.Events.SEGMENTATION_REMOVED, (event: any) => {
    for (const source of sources.values()) {
      const mask = source.masks.get(event.detail.segmentationId);
      source.masks.delete(event.detail.segmentationId);
      for (const id of mask?.imageIds || []) if (cache.getImageLoadObject(id)) cache.removeImageLoadObject(id, { force: true });
    }
    release(event.detail.segmentationId);
  });
}

/** Each output axis maps to exactly one input axis; compare all physical corners. */
export function alignedIndexTransform(input, source) {
  const a = input.voxelToLPS, b = source.voxelToLPS;
  const map = [0, 1, 2].map(r => {
    const col = a.slice(0, 3).map(row => row[r]);
    const square = col.reduce((s, x) => s + x*x, 0);
    return [0, 1, 2, 3].map(c => col.reduce((s, x, k) => s + x * (b[k][c] - (c === 3 ? a[k][3] : 0)), 0) / square);
  }).concat([[0, 0, 0, 1]]);
  const rounded = map.map(row => row.map(Math.round));
  for (let i = 0; i < 3; i++) {
    if (rounded[i].slice(0, 3).reduce((s, x) => s + Math.abs(x), 0) !== 1 || rounded.slice(0, 3).reduce((s, row) => s + Math.abs(row[i]), 0) !== 1) throw new Error('Mask 需要重采样或配准，首版不支持。');
  }
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = source.dimensions.map((n, i) => corner & (1 << i) ? n - 1 : 0);
    const mapped = transformPoint(rounded, p);
    const actual = transformPoint(a, mapped), expected = transformPoint(b, p);
    if (actual.some((x, i) => Math.abs(x - expected[i]) > 1e-3)) throw new Error('Mask 与原图物理网格不一致。');
    mapped.forEach((x, i) => { mins[i] = Math.min(mins[i], x); maxs[i] = Math.max(maxs[i], x); });
  }
  if (mins.some(x => x !== 0) || maxs.some((x, i) => x !== input.dimensions[i] - 1)) throw new Error('Mask 覆盖范围不同。');
  return rounded;
}

export async function importMasks(servicesManager, file: File, signal?, saved?, progress = (_: string) => {}) {
  const { source } = currentSource(servicesManager);
  assertActive(servicesManager, source, signal);
  const owner = source.sourceKey + ':import:' + crypto.randomUUID();
  // Header/stream overhead first; worker pauses until its true allocation is approved.
  const overhead = 16 * 1024 ** 2;
  reserve(owner, overhead + file.size);
  const created = [];
  const group = saved?.segmentationSet || (saved ? newGroup(saved.name, 'legacy') : importGroup(file.name));
  try {
    let { descriptor, scalarData } = await parseInWorker(file, { mask: true, unit: source.descriptor.unit }, signal,
      p => progress(`解压 ${Math.round(p * 100)}%`),
      h => reserve(owner, file.size + h.offset + h.sourceBytes + h.workingBytes + overhead));
    assertActive(servicesManager, source, signal);
    const map = alignedIndexTransform(descriptor, source.descriptor);
    const labels = new Set<number>();
    for (const value of scalarData) if (value) { labels.add(value); if (labels.size > 256) throw new Error('每次最多导入 256 个标签。'); }
    if (!labels.size && saved?.labelOnly) labels.add(1);
    if (!labels.size) throw new Error('空文件仅能作为明确保存的 label-only 草稿加载。');
    reserve(owner, file.size + scalarData.byteLength + source.descriptor.count * (labels.size + 1));
    for (const label of labels) {
      progress(`对齐标签 ${created.length + 1} / ${labels.size}`);
      const aligned = await alignInWorker(scalarData, source.descriptor.dimensions, descriptor.dimensions, map, label, signal);
      assertActive(servicesManager, source, signal);
      scalarData = aligned.scalarData;
      const binary = aligned.binary;
      const labelName = saved?.name || file.name + (labels.size > 1 ? ` / ${label}` : '');
      // Release the reservation for this permanent mask immediately before allocating it.
      reserve(owner, file.size + scalarData.byteLength + source.descriptor.count * (labels.size - created.length));
      const id = await createMask(servicesManager, labelName, binary, saved, signal, group);
      const mask = source.masks.get(id);
      mask.originalLabel = saved?.originalLabel ?? label;
      mask.originalFile = saved?.originalFile ?? file.name;
      mask.alignment = saved?.alignment ?? map;
      mask.derivedFrom = saved?.derivedFrom;
      if (saved) mask.savedRevision = mask.revision;
      created.push(id);
    }
    return created;
  } catch (error) {
    for (const id of created) servicesManager.services.segmentationService.remove(id);
    throw error;
  } finally { release(owner); }
}

export async function saveAll(servicesManager, signal?, progress?) {
  const { source } = currentSource(servicesManager);
  await ensureStored(source, signal, progress);
  const results = [];
  for (const [id, mask] of source.masks) {
    const displayColor = maskAppearance(servicesManager, mask);
    if (mask.saved && !isMaskDirty(servicesManager, mask) && mask.saved.displayColor) { results.push({ id, success: true }); continue; }
    const owner = source.sourceKey + ':save';
    try {
      reserve(owner, source.descriptor.count * 2);
      const revision = mask.revision;
      const pixels = readMask(source, id);
      const form = new FormData();
      form.append('file', new Blob([pixels]), 'mask.bin'); form.append('raw', 'true');
      form.append('geometryHash', source.descriptor.geometryHash); form.append('label', mask.label);
      form.append('provenance', JSON.stringify({ originalLabel: mask.originalLabel || 1, originalFile: mask.originalFile, alignment: mask.alignment, displayColor, derivedFrom: mask.derivedFrom, segmentationSet: maskGroup(source, mask) }));
      form.append('labelOnly', String(!pixels.some(x => x)));
      if (mask.saved) { form.append('maskId', mask.saved.maskId); form.append('expectedVersion', String(mask.saved.version)); }
      const reply = await upload(`/${source.descriptor.sourceId}/masks`, form, signal);
      mask.saved = reply.items[0]; mask.savedRevision = revision;
      if (mask.saved.segmentationSet) mask.segmentationSet = mask.saved.segmentationSet;
      results.push({ id, success: true });
    } catch (error) { results.push({ id, success: false, error: error.message }); }
    finally { release(owner); }
  }
  return results;
}

export async function loadSaved(servicesManager, signal?, maskIds?: string[], options: any = {}) {
  const { source } = currentSource(servicesManager);
  if (!source.descriptor.sourceId) throw new Error('此原图尚未上传。');
  const all = options.items || (await (await request(`/${source.descriptor.sourceId}/masks`, { signal })).json()).items;
  assertActive(servicesManager, source, signal);
  const items = all.filter(item => !maskIds || maskIds.includes(item.maskId));
  const results = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    assertActive(servicesManager, source, signal);
    if (!options.asCopy && [...source.masks.values()].some(m => m.saved?.maskId === item.maskId)) {
      results.push({ item, status: 'alreadyLoaded' }); continue;
    }
    const progress = stage => options.progress?.(`${index + 1} / ${items.length} · ${item.name} · ${stage}`);
    try {
      progress('下载中');
      const blob = await downloadMask(`/${source.descriptor.sourceId}/masks/${item.maskId}?version=${item.version}`, signal, progress);
      assertActive(servicesManager, source, signal);
      const imported = options.asCopy ? { ...item, name: `${item.name} · v${item.version} 副本`, displayColor: undefined } : item;
      const created = await importMasks(servicesManager, new File([blob], item.name + '.nii.gz'), signal, imported, progress);
      if (options.asCopy) for (const id of created) {
        const mask = source.masks.get(id);
        mask.derivedFrom = { maskId: item.maskId, version: item.version };
        mask.saved = undefined; mask.savedRevision = -1;
        // Keep the historical version immutable; the next save creates a new mask identity.
      }
      results.push({ item, status: 'loaded' });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      results.push({ item, status: 'failed', error: error.message });
    }
  }
  return results;
}

export async function exportLocal(servicesManager, signal?) {
  const { source } = currentSource(servicesManager);
  const owner = source.sourceKey + ':export';
  reserve(owner, source.descriptor.count * source.masks.size * 4 + 1024 ** 2);
  try {
    const masks = [...source.masks].map(([id, mask]) => ({ pixels: readMask(source, id),
      name: mask.label, originalLabel: mask.originalLabel || 1, originalFile: mask.originalFile, segmentationSet: maskGroup(source, mask),
      alignment: mask.alignment, displayColor: maskAppearance(servicesManager, mask), saved: mask.saved }));
    const result = await new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(new URL('./export.worker.js', import.meta.url));
      const finish = (error?, data?) => { signal?.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(data); };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      worker.onerror = e => finish(new Error(e.message));
      worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data.result);
      worker.postMessage({ masks, descriptor: source.descriptor }, masks.map(m => m.pixels.buffer));
    });
    const url = URL.createObjectURL(new Blob([result], { type: 'application/zip' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'nifti-masks.zip'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally { release(owner); }
}

/** Explicitly duplicate loaded targets into another logical scheme; never move originals. */
export async function copyGroup(servicesManager, groupId, signal?) {
  const { source } = currentSource(servicesManager);
  const targets = [...source.masks.values()].filter(m => maskGroup(source, m).id === groupId);
  if (!targets.length) return;
  if (targets.some(mask => !mask.saved || isMaskDirty(servicesManager, mask))) throw Error('复制方案前请先保存组内全部目标。');
  const group = newGroup(`${maskGroup(source, targets[0]).name} · 副本`, 'copy');
  const created = [];
  const originalActive = servicesManager.services.segmentationService.getActiveSegmentation(currentSource(servicesManager).viewportId)?.segmentationId;
  for (const original of targets) {
    const owner = source.sourceKey + ':copy-buffer';
    try {
      assertActive(servicesManager, source, signal);
      reserve(owner, source.descriptor.count);
      const pixels = readMask(source, original.segmentationId);
      const id = await createMask(servicesManager, targetName(original), pixels, undefined, signal, group);
      const mask = source.masks.get(id);
      Object.assign(mask, { originalLabel: original.originalLabel, originalFile: original.originalFile, alignment: original.alignment,
        derivedFrom: original.saved ? { maskId: original.saved.maskId, version: original.saved.version } : undefined });
      created.push(id);
    } catch (error) {
      // A partial scheme would look complete. Roll back this explicit copy only.
      for (const id of created) servicesManager.services.segmentationService.remove(id);
      if (originalActive && sources.get(source.sourceKey) === source) {
        try { servicesManager.services.segmentationService.setActiveSegmentation(currentSource(servicesManager).viewportId, originalActive); } catch { /* Case already closed. */ }
      }
      throw error;
    } finally { release(owner); }
  }
  return created;
}
