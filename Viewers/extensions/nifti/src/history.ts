import { sources, reserve, release } from './sourceStore';
import { downloadMask, request } from './api';
import { parseInWorker, alignInWorker } from './workerClient';
import { alignedIndexTransform, currentSource, createMask, isMaskDirty } from './masks';

function assertSource(servicesManager, source, signal?) {
  signal?.throwIfAborted();
  if (sources.get(source.sourceKey) !== source || currentSource(servicesManager).source !== source) {
    throw new DOMException('病例已切换。', 'AbortError');
  }
}

export function loadedAnnotation(source, maskId) {
  return [...source.masks.values()].find((mask: any) => mask.saved?.maskId === maskId) as any;
}

/** No editable segmentation is registered for a history preview. */
export async function readSavedVersion(servicesManager, source, item, signal, progress, preview = false) {
  assertSource(servicesManager, source, signal);
  const owner = source.sourceKey + ':history:' + crypto.randomUUID();
  try {
    progress('下载历史版本…');
    const file = await downloadMask(`/${source.descriptor.sourceId}/masks/${item.maskId}?version=${item.version}`, signal, progress);
    reserve(owner, file.size + 16 * 1024 ** 2);
    const parsed = await parseInWorker(file, { mask: true, unit: source.descriptor.unit }, signal,
      p => progress(`解压历史版本 ${Math.round(p * 100)}%`),
      h => reserve(owner, file.size + h.offset + h.sourceBytes + h.workingBytes + 16 * 1024 ** 2));
    assertSource(servicesManager, source, signal);
    const map = alignedIndexTransform(parsed.descriptor, source.descriptor);
    if (parsed.scalarData.some(value => value !== 0 && value !== 1)) throw Error('已存标注版本必须是二值 mask。');
    reserve(owner, file.size + parsed.scalarData.byteLength + source.descriptor.count);
    progress('对齐历史版本…');
    const aligned = await alignInWorker(parsed.scalarData, source.descriptor.dimensions, parsed.descriptor.dimensions, map, 1, signal);
    assertSource(servicesManager, source, signal);
    const [nx, ny] = source.descriptor.dimensions;
    reserve(owner, aligned.binary.byteLength + (preview ? nx * ny * 8 : 0));
    return { source, item, pixels: aligned.binary, dispose: () => release(owner) };
  } catch (error) { release(owner); throw error; }
}

async function installVersion(servicesManager, source, item, pixels, signal) {
  assertSource(servicesManager, source, signal);
  const existing = loadedAnnotation(source, item.maskId);
  if (existing && isMaskDirty(servicesManager, existing)) throw Error('这份标注有未保存修改，请先保存或导出。');
  const { segmentationService, viewportGridService } = servicesManager.services;
  const viewportId = viewportGridService.getState().activeViewportId;
  const active = segmentationService.getActiveSegmentation(viewportId)?.segmentationId;
  const id = await createMask(servicesManager, item.name, pixels, item, signal);
  try {
    assertSource(servicesManager, source, signal);
    if (existing && isMaskDirty(servicesManager, existing)) throw Error('加载期间当前标注发生变化，已保留当前编辑。');
    const mask = source.masks.get(id);
    Object.assign(mask, { originalLabel: item.originalLabel, originalFile: item.originalFile, alignment: item.alignment, derivedFrom: item.derivedFrom });
    if (existing) segmentationService.remove(existing.segmentationId);
    return mask;
  } catch (error) {
    segmentationService.remove(id);
    if (active) segmentationService.setActiveSegmentation(viewportId, active);
    throw error;
  }
}

export async function loadLatestAnnotation(servicesManager, source, item, signal, progress) {
  const existing = loadedAnnotation(source, item.maskId);
  if (existing && isMaskDirty(servicesManager, existing)) throw Error('这份标注有未保存修改，请先保存或导出。');
  if (existing?.saved.version === item.version) return;
  const staged = await readSavedVersion(servicesManager, source, item, signal, progress);
  try { await installVersion(servicesManager, source, item, staged.pixels, signal); }
  finally { staged.dispose(); }
}

export async function restoreAnnotation(servicesManager, source, item, latestVersion, requestId, signal, progress) {
  const existing = loadedAnnotation(source, item.maskId);
  if (existing && isMaskDirty(servicesManager, existing)) throw Error('这份标注有未保存修改，请先保存或导出。');
  const staged = await readSavedVersion(servicesManager, source, item, signal, progress);
  let committed;
  try {
    const current = loadedAnnotation(source, item.maskId);
    if (current && isMaskDirty(servicesManager, current)) throw Error('当前编辑发生变化，已取消恢复。');
    // Reserve the additional editable buffer before committing a server version.
    reserve(source.sourceKey + ':restore-allocation', source.descriptor.count);
    progress('保存恢复版本…');
    const response = await request(`/${source.descriptor.sourceId}/masks/${item.maskId}/restore`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: item.version, expectedVersion: latestVersion, requestId }),
    });
    committed = (await response.json()).item;
    release(source.sourceKey + ':restore-allocation');
    await installVersion(servicesManager, source, committed, staged.pixels, signal);
    return committed;
  } catch (error) {
    if (committed) throw Error(`服务器已保存恢复版本 v${committed.version}，当前视图未替换：${error.message} 请保留当前编辑后加载最新版本。`);
    throw error;
  } finally { release(source.sourceKey + ':restore-allocation'); staged.dispose(); }
}
