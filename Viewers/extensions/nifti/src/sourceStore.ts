import { cache, imageLoader, volumeLoader, ImageVolume, metaData, utilities, Enums } from '@cornerstonejs/core';
import { BrushTool } from '@cornerstonejs/tools';
import { DicomMetadataStore } from '@ohif/core';
import { transformPoint } from './format.mjs';
import { parseInWorker } from './workerClient';
import { niftiMemoryLedger } from '../../default/src/utils/niftiMemoryLedger';
import type { SourceDescriptor } from './types';
import { createStream, ensureSlice, ensureComplete } from './streaming';
import { scalarTypes, dtypeName } from './frameCodec.mjs';
import { releaseBrushPreview } from './releaseBrushPreview.mjs';

export const NIFTI_HANDLER = '@ohif/extension-nifti.sopClassHandlerModule.nifti';
export const INTERNAL_CLASS = 'ohif.native-nifti';
export const sources = new Map<string, any>();
export let config: any = {};
const metadata = new Map<string, any>();
const reservations = new Map<string, number>();
export function reserve(key: string, bytes: number) {
  const used = [...reservations].reduce((sum, [k, n]) => sum + (k === key ? 0 : n), 0);
  if (used + bytes > (config.niftiWorkingSetBytes || 1.5 * 1024 ** 3)) {
    throw new Error(`NIfTI 内存预算不足：此操作预计共需 ${Math.ceil((used + bytes) / 1024 ** 2)} MiB。请先保存并移除部分 mask 后重试。`);
  }
  reservations.set(key, bytes);
}
export function release(key: string) { reservations.delete(key); }
export function memorySnapshot() {
  const sourceMemory = niftiMemoryLedger.report({ includeSamples: false }).bySource.find(s => s.source === 'native-nifti-source');
  return { sources: sources.size, images: metadata.size,
    streams: [...sources.values()].filter(s => s.stream).map(s => ({ sourceId: s.descriptor.sourceId,
      loaded: s.stream.loaded.reduce((a, b) => a + b, 0), total: s.stream.loaded.length,
      pending: s.stream.queue.jobs.size, completing: s.stream.completing, errors: [...s.stream.errors.entries()],
      preparationSeconds: s.stream.descriptor.preparationSeconds, timings: s.stream.timings })),
    bytes: [...reservations.values()].reduce((a, b) => a + b, 0),
    sourceReachableBytes: sourceMemory?.reachableBytes || 0,
    sourceReleasedButReachableBytes: sourceMemory?.releasedButReachableBytes || 0 };
}

export function registerNifti(appConfig) {
  config = appConfig;
  metaData.addProvider((type, imageId) => metadata.get(imageId)?.[type], 10000);
  imageLoader.registerImageLoader('nifti', imageId => {
    const entry = metadata.get(imageId);
    const source = entry && sources.get(entry.sourceKey);
    if (!source) return { promise: Promise.reject(new Error('NIfTI source was released; reopen the image.')) };
    const controller = new AbortController();
    const promise = (async () => {
    await ensureSlice(source, entry.slice, controller.signal);
    if (source.stream?.disposed) throw new DOMException('Cancelled', 'AbortError');
    const { descriptor: d, scalarData } = source;
    const [columns, rows] = d.dimensions;
    const count = columns * rows;
    // Subarray keeps one source allocation shared by every stack slice.
    const pixels = scalarData.subarray(entry.slice * count, (entry.slice + 1) * count);
    const plane = entry.imagePlaneModule;
    const voxelManager = utilities.VoxelManager.createImageVoxelManager({ width: columns, height: rows, numberOfComponents: 1, scalarData: pixels });
    return {
      imageId, dataType: scalarData.constructor.name, rows, columns, width: columns, height: rows,
      // Drive the window from the displayed image, including cached slices.
      // A stale loader response or a thumbnail must not move the window.
      niftiOnDisplayed: () => {
        if (source.stream && !source.stream.disposed && !source.stream.completing && !source.stream.loaded.every(Boolean)) source.stream.queue.prefetch(entry.slice);
      },
      imageQualityStatus: Enums.ImageQualityStatus.FULL_RESOLUTION,
      color: false, rgba: false, numberOfComponents: 1, invert: false,
      slope: 1, intercept: 0, preScale: { scaled: true, scalingParameters: { rescaleSlope: 1, rescaleIntercept: 0 } },
      rowPixelSpacing: plane.rowPixelSpacing, columnPixelSpacing: plane.columnPixelSpacing,
      sizeInBytes: pixels.byteLength, voxelManager, getPixelData: () => pixels,
      minPixelValue: d.min, maxPixelValue: d.max,
      windowCenter: (d.min + d.max) / 2, windowWidth: Math.max(1, d.max - d.min),
    };
    })();
    promise.catch(() => setTimeout(() => {
      if (cache.getImageLoadObject(imageId)?.promise === promise) cache.removeImageLoadObject(imageId);
    }, 0));
    return { promise, cancelFn: () => controller.abort() };
  });
  volumeLoader.registerVolumeLoader('nativeNiftiVolume', (volumeId, options) => {
    const entry = metadata.get(options.imageIds?.[0]);
    const source = entry && sources.get(entry.sourceKey);
    let cancelled = false;
    let loadedVolume;
    const controller = new AbortController();
    const promise = (async () => {
      if (!source || options.imageIds.length !== source.imageIds.length || options.imageIds.some((id, i) => id !== source.imageIds[i])) {
        throw new Error('NIfTI volume references do not match the source grid.');
      }
      await ensureComplete(source, controller.signal);
      await Promise.all(source.imageIds.map(id => imageLoader.loadAndCacheImage(id)));
      if (cancelled || !sources.has(source.sourceKey)) throw new DOMException('Cancelled', 'AbortError');
      const { descriptor: d, scalarData } = source;
      const a = d.voxelToLPS;
      const spacing = [0, 1, 2].map(c => Math.hypot(a[0][c], a[1][c], a[2][c]));
      const direction = [0, 1, 2].flatMap(c => [0, 1, 2].map(r => a[r][c] / spacing[c]));
      const voxelManager = utilities.VoxelManager.createScalarVolumeVoxelManager({ dimensions: d.dimensions, scalarData, numberOfComponents: 1 });
      // The pinned scalar manager lacks the range accessor used when MPR
      // restores opacity/VOI. These are immutable, already-scaled source voxels.
      voxelManager.getRange = () => [d.min, d.max];
      const volume = new ImageVolume({ volumeId, imageIds: [...source.imageIds],
        dimensions: d.dimensions, spacing, direction, origin: a.slice(0, 3).map(row => row[3]),
        dataType: scalarData.constructor.name, numberOfComponents: 1,
        metadata: { ...source.instances[0], FrameOfReferenceUID: `${source.sourceKey}:frame` },
        voxelManager,
      });
      volume.isPreScaled = true;
      (volume as any).loadStatus = { loaded: true, loading: false };
      volume.invalidate();
      loadedVolume = volume;
      source.volumeIds.add(volumeId);
      return volume;
    })();
    return { promise, cancelFn: () => {
      cancelled = true;
      controller.abort();
      if (loadedVolume) {
        loadedVolume.vtkOpenGLTexture.releaseGraphicsResources();
        loadedVolume.vtkOpenGLTexture.delete();
        loadedVolume = undefined;
      }
    } };
  });
}

export async function openLocal(file: File, options, signal, progress) {
  if (!config.enableNiftiViewing) throw new Error('NIfTI viewing is disabled.');
  const sourceKey = `nifti-${crypto.randomUUID()}`;
  // Covers decompression + working array while the worker is active.
  reserve(sourceKey, 1024 ** 3 + 1024 ** 2 + file.size);
  try {
    const parsed = await parseInWorker(file, options, signal, progress);
    const descriptor: SourceDescriptor = { ...parsed.descriptor, sourceType: 'nifti', sourceId: undefined,
      name: file.name, modality: options.modality || 'OT', provenance: { originalName: file.name, transforms: [] },
      capabilities: { viewing: true, serverSave: !!config.enableNiftiLibrary,
        editing: !!config.enableNiftiEditing, ai: !!config.enableNiftiAI, pacsExport: false } };
    reserve(sourceKey, parsed.scalarData.byteLength + file.size);
    const source = { sourceKey, descriptor, scalarData: parsed.scalarData, file, imageIds: [], masks: new Map(), volumeIds: new Set() };
    niftiMemoryLedger.trackBuffer(parsed.scalarData, { source: 'native-nifti-source', owner: sourceKey });
    sources.set(sourceKey, source);
    populateMetadata(source);
    return source;
  } catch (error) { releaseSource(sourceKey); throw error; }
}

export function openStreaming(descriptor, transport) {
  const sourceKey = `nifti-${crypto.randomUUID()}`;
  const Type = scalarTypes[dtypeName(descriptor.workingDtype)];
  if (!Type || descriptor.workingBytes > 512 * 1024 ** 2 || descriptor.count * Type.BYTES_PER_ELEMENT !== descriptor.workingBytes) throw Error('Invalid NIfTI working buffer.');
  reserve(sourceKey, descriptor.workingBytes);
  try {
    const source = { sourceKey, descriptor, scalarData: new Type(descriptor.count), file: null,
      imageIds: [], masks: new Map(), volumeIds: new Set(), stream: null };
    createStream(source, transport);
    niftiMemoryLedger.trackBuffer(source.scalarData, { source: 'native-nifti-source', owner: sourceKey });
    sources.set(sourceKey, source); populateMetadata(source); return source;
  } catch (error) { releaseSource(sourceKey); throw error; }
}

function populateMetadata(source) {
  const { descriptor: d, sourceKey } = source;
  const a = d.voxelToLPS;
  const spacing = [0, 1, 2].map(c => Math.hypot(a[0][c], a[1][c], a[2][c]));
  const dirs = [0, 1, 2].map(c => [0, 1, 2].map(r => a[r][c] / spacing[c]));
  const [columns, rows, slices] = d.dimensions;
  source.studyUID = `${sourceKey}:study`;
  source.seriesUID = `${sourceKey}:series`;
  source.instances = Array.from({ length: slices }, (_, slice) => {
    const imageId = `nifti:${sourceKey}:${slice}`;
    source.imageIds.push(imageId);
    const position = transformPoint(a, [0, 0, slice]);
    const frame = `${sourceKey}:frame`;
    const instance = {
      sourceType: 'nifti', sourceKey, isSynthetic: true,
      StudyInstanceUID: source.studyUID, SeriesInstanceUID: source.seriesUID,
      SOPInstanceUID: `${sourceKey}:slice:${slice}`, SOPClassUID: INTERNAL_CLASS,
      FrameOfReferenceUID: frame, Rows: rows, Columns: columns, InstanceNumber: slice + 1,
      ImagePositionPatient: position, ImageOrientationPatient: [...dirs[0], ...dirs[1]],
      PixelSpacing: [spacing[1], spacing[0]], SliceThickness: spacing[2],
      Modality: d.modality, SeriesNumber: 1, SeriesDescription: d.name,
      StudyDescription: d.name, PatientID: 'NIFTI', PatientName: { Alphabetic: d.name },
      SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2',
      BitsAllocated: source.scalarData.BYTES_PER_ELEMENT * 8,
      BitsStored: source.scalarData.BYTES_PER_ELEMENT * 8,
      PixelRepresentation: source.scalarData instanceof Uint8Array || source.scalarData instanceof Uint16Array ? 0 : 1,
      url: imageId, imageId, NumberOfFrames: 1,
    };
    metadata.set(imageId, {
      sourceKey, slice, instance, niftiSource: { sourceKey, descriptor: d, slice },
      imagePlaneModule: { frameOfReferenceUID: frame, rows, columns, rowCosines: dirs[0],
        columnCosines: dirs[1], imagePositionPatient: position, imageOrientationPatient: instance.ImageOrientationPatient,
        rowPixelSpacing: spacing[1], columnPixelSpacing: spacing[0], pixelSpacing: instance.PixelSpacing,
        sliceThickness: spacing[2], usingDefaultValues: false },
      imagePixelModule: { rows, columns, samplesPerPixel: 1, photometricInterpretation: 'MONOCHROME2',
        bitsAllocated: instance.BitsAllocated, bitsStored: instance.BitsStored,
        highBit: instance.BitsStored - 1, pixelRepresentation: instance.PixelRepresentation },
      generalSeriesModule: { modality: d.modality, seriesInstanceUID: source.seriesUID, studyInstanceUID: source.studyUID },
      generalImageModule: { instanceNumber: slice + 1 },
      // These are explicitly internal references, never used for DICOM export.
      sopCommonModule: { sopClassUID: INTERNAL_CLASS, sopInstanceUID: instance.SOPInstanceUID, sourceType: 'nifti' },
      modalityLutModule: { rescaleSlope: 1, rescaleIntercept: 0 },
      voiLutModule: { windowCenter: [(d.min + d.max) / 2], windowWidth: [Math.max(1, d.max - d.min)] },
    });
    return instance;
  });
}

export function releaseSource(key: string) {
  const source = sources.get(key);
  if (source) {
    source.stream?.dispose();
    releaseBrushPreview((BrushTool as any).previewData, key);
    // Cornerstone may create additional volumes from these images when materializing
    // labelmaps/MPR. Those are not necessarily created by our native volume loader.
    const ownedImages = new Set([...source.imageIds, ...[...source.masks.values()].flatMap((m: any) => m.imageIds || [])]);
    for (const volume of cache.getVolumes()) {
      if (volume && (source.volumeIds.has(volume.volumeId) || volume.imageIds?.some(id => ownedImages.has(id)))) {
        cache.removeVolumeLoadObject(volume.volumeId);
      }
    }
    for (const id of source.volumeIds) if (cache.getVolumeLoadObject(id)) cache.removeVolumeLoadObject(id);
    for (const mask of source.masks.values()) {
      for (const id of mask.imageIds || []) if (cache.getImageLoadObject(id)) cache.removeImageLoadObject(id, { force: true });
    }
    for (const imageId of source.imageIds) {
      if (cache.getImageLoadObject(imageId)) cache.removeImageLoadObject(imageId, { force: true });
      metadata.delete(imageId);
    }
    DicomMetadataStore.removeNativeNiftiStudy(source.studyUID);
    source.masks.clear();
    source.scalarData = null;
    source.file = null;
    source.instances = [];
    source.imageIds = [];
    source.volumeIds.clear();
    niftiMemoryLedger.releaseOwner(key);
    sources.delete(key);
  }
  for (const reservation of [...reservations.keys()]) if (reservation === key || reservation.startsWith(key + ':')) release(reservation);
}

export function releaseAllSources() { for (const key of [...sources.keys()]) releaseSource(key); }

export function getSource(key) {
  const source = sources.get(key);
  if (!source) throw new Error('Local image is no longer available. Open the NIfTI file again.');
  return source;
}
