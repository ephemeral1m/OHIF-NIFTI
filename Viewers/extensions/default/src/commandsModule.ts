import { utils, Types, DicomMetadataStore } from '@ohif/core';

import { ContextMenuController } from './CustomizableContextMenu';
import DicomTagBrowser from './DicomTagBrowser/DicomTagBrowser';
import reuseCachedLayouts from './utils/reuseCachedLayouts';
import findViewportsByPosition, {
  findOrCreateViewport as layoutFindOrCreate,
} from './findViewportsByPosition';

import { ContextMenuProps } from './CustomizableContextMenu/types';
import { NavigateHistory } from './types/commandModuleTypes';
import { history } from '@ohif/app';
import { useViewportGridStore } from './stores/useViewportGridStore';
import { useDisplaySetSelectorStore } from './stores/useDisplaySetSelectorStore';
import { useHangingProtocolStageIndexStore } from './stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from './stores/useToggleHangingProtocolStore';
import { useViewportsByPositionStore } from './stores/useViewportsByPositionStore';
import { useToggleOneUpViewportGridStore } from './stores/useToggleOneUpViewportGridStore';
import requestDisplaySetCreationForStudy from './Panels/requestDisplaySetCreationForStudy';
import promptSaveReport from './utils/promptSaveReport';

import {
  CONSTANTS as csToolsConstants,
  Enums as csToolsEnums,
  Types as cstTypes,
  segmentation as csToolsSegmentation,
} from '@cornerstonejs/tools';
import { updateLabelmapSegmentationImageReferences } from '@cornerstonejs/tools/segmentation/updateLabelmapSegmentationImageReferences';
import { triggerSegmentationRepresentationModified, triggerSegmentationDataModified, triggerSegmentationModified } from '@cornerstonejs/tools/segmentation/triggerSegmentationEvents';
import {
  cache,
  imageLoader,
  metaData,
  Types as csTypes,
  utilities as csUtils,
  VolumeViewport3D,
  eventTarget,
} from '@cornerstonejs/core';
import { adaptersSEG } from '@cornerstonejs/adapters';
const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
import MonaiLabelClient from '../../monai-label/src/services/MonaiLabelClient';
import { updateSegmentationStats } from '../../cornerstone/src/utils/updateSegmentationStats';
import axios from 'axios';
import { toolboxState } from './stores/toolboxState';
import { parseMultipart } from './utils/multipart';
import { inspectBinaryMaskSlices } from './utils/niftiMaskInspection';
import { niftiMemoryLedger, niftiSegmentationMemoryOwner } from './utils/niftiMemoryLedger';
import { callInputDialog } from './utils/callInputDialog';
import { confirmLoadDraftDiscard } from './utils/confirmLoadDraftDiscard';
import { backendErrorMessage } from './utils/backendError';
import { normalizeNnInteractiveArgs, NnInteractiveOptions } from './utils/nnInteractiveArgs';
import { createNnInteractiveController } from './utils/nnInteractiveController';
import {
  buildDraftReconcilePlan,
  canonicalDraftsForLoad,
  draftFamilyRoot,
  LoadedDraftMaskWithDirtyState,
  NiftiDraft,
  withDraftDirtyState,
} from './utils/niftiDraftState';

function payloadByteLength(data: any): number | undefined {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  return undefined;
}

function summarizeHttpResponse(response: any) {
  return {
    status: response?.status,
    method: response?.config?.method,
    contentType: response?.headers?.['content-type'],
    dataType: response?.data?.constructor?.name,
    byteLength: payloadByteLength(response?.data),
  };
}

function summarizeHttpError(error: any) {
  return {
    name: error?.name,
    code: error?.code,
    message: backendErrorMessage(error),
    status: error?.response?.status,
    method: error?.config?.method,
    responseByteLength: payloadByteLength(error?.response?.data),
  };
}

function notificationSafeHttpPromise<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    response => summarizeHttpResponse(response),
    error => {
      const summary = summarizeHttpError(error);
      const safeError = new Error(summary.message);
      safeError.name = summary.name || 'HttpError';
      Object.assign(safeError, {
        code: summary.code,
        status: summary.status,
        responseByteLength: summary.responseByteLength,
      });
      throw safeError;
    }
  );
}

export type HangingProtocolParams = {
  protocolId?: string;
  stageIndex?: number;
  activeStudyUID?: string;
  stageId?: string;
  reset?: false;
};

export type UpdateViewportDisplaySetParams = {
  direction: number;
  excludeNonImageModalities?: boolean;
};

const commandsModule = ({
  servicesManager,
  commandsManager,
  extensionManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const {
    customizationService,
    measurementService,
    hangingProtocolService,
    uiNotificationService,
    viewportGridService,
    displaySetService,
    multiMonitorService,
  } = servicesManager.services;

  const nnEditor = createNnInteractiveController({
    servicesManager, cache, metaData, csToolsSegmentation, csToolsEnums,
    eventTarget, axios, toolboxState, patchStackLabelmapModifiedSlices,
    triggerSegmentationDataModified, triggerSegmentationModified,
  });

  // Define a context menu controller for use with any context menus
  const contextMenuController = new ContextMenuController(servicesManager, commandsManager);

  /**
   * Helper function to handle post-segmentation processing after segmentation data is created/updated.
   * This includes updating representations, handling viewports, and triggering events.
   */
  async function postSegmentationProcessing({
    activeViewportId,
    segmentationId,
    segmentNumber,
    segments,
    derivedImageIds,
    currentDisplaySets,
    imageIds,
    existingSegments,
    existing,
    activeSegmentation,
    currentImageIdIndex,
    z_range,
    segmentationLabel,
  }: {
    activeViewportId: string;
    segmentationId: string;
    segmentNumber: number;
    segments: { [segmentIndex: string]: cstTypes.Segment };
    derivedImageIds: string[];
    currentDisplaySets: any;
    imageIds: string[];
    existingSegments: { [segmentIndex: string]: cstTypes.Segment };
    existing: boolean;
    activeSegmentation: any;
    currentImageIdIndex?: number;
    z_range: number[];
    segmentationLabel?: string;
  }) {
    const priorNiftiResources = getNiftiDraftResourceSnapshot(segmentationId);
    const shouldTrackNiftiResources =
      priorNiftiResources?.isNiftiDraft === true ||
      Object.values(segments).some(
        (segment: any) => segment?.cachedStats?.sourceType === 'nifti-draft'
      );
    // Get the representations for the segmentation to recover the visibility of the segments
    const representations =
      servicesManager.services.segmentationService.getSegmentationRepresentations(
        activeViewportId,
        { segmentationId }
      );
    const priorSegmentVisibility = new Map<number, boolean>();
    for (const representation of representations) {
      for (const segment of Object.values(representation.segments || {}) as any[]) {
        if (segment?.segmentIndex !== undefined) {
          priorSegmentVisibility.set(segment.segmentIndex, segment.visible !== false);
        }
      }
    }
    // Save all OTHER segmentation representations (e.g., DICOM-SEG) to restore if lost during processing
    const otherSegRepresentations = servicesManager.services.segmentationService
      .getSegmentationRepresentations(activeViewportId)
      .filter(rep => rep.segmentationId !== segmentationId);

    if (!existing) {
      csToolsSegmentation.addSegmentations([
        {
          segmentationId,
          representation: {
            type: LABELMAP,
            data: {
              imageIds: derivedImageIds,
              referencedImageIds: imageIds,
            },
          },
          config: {
            cachedStats: {
              center:
                z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0,
            },
            label: segmentationLabel || currentDisplaySets.SeriesDescription,
            segments,
          },
        },
      ]);
    } else {
      servicesManager.services.segmentationService.removeSegmentationRepresentations(
        activeViewportId,
        { segmentationId }
      );
      const readableText = customizationService.getCustomization('panelSegmentation.readableText');

      // Get existing segmentation to preserve other representation data
      const existingSegmentation = csToolsSegmentation.state.getSegmentation(segmentationId);
      const existingRepresentationData = existingSegmentation?.representationData || {};
      const existingLabelmapData = existingRepresentationData[LABELMAP] || {};

      // For Surface representation, remove it entirely to force regeneration from updated labelmap
      // This ensures surfaces are recomputed from the new labelmap data
      const updatedRepresentationData = { ...existingRepresentationData };
      const SURFACE = csToolsEnums.SegmentationRepresentations.Surface;
      if (updatedRepresentationData[SURFACE]) {
        // Remove Surface representation data to force regeneration from updated labelmap
        delete updatedRepresentationData[SURFACE];
      }

      // Update the segmentation data, preserving other representation data (but not Surface)
      csToolsSegmentation.updateSegmentations([
        {
          segmentationId,
          payload: {
            segments: segments,
            representationData: {
              ...updatedRepresentationData, // Surface data removed to force regeneration
              [LABELMAP]: {
                ...existingLabelmapData, // Preserve existing labelmap data (e.g., volumeId)
                imageIds: derivedImageIds,
                referencedImageIds: imageIds,
              },
            },
          },
        },
      ]);

      // Update the segmentation stats
      Promise.resolve()
        .then(() =>
          updateSegmentationStats({
            segmentation: activeSegmentation,
            segmentationId,
            readableText,
          })
        )
        .catch(error => {
          console.warn('Failed to update segmentation stats:', error);
        });
    }

    servicesManager.services.segmentationService.setActiveSegment(segmentationId, segmentNumber);
    toolboxState.setCurrentActiveSegment(segmentNumber);
    patchStackLabelmapModifiedSlices(derivedImageIds);

    // Add the segmentation representation with type: LABELMAP so that
    // handleStackViewportCase is invoked, which calls updateLabelmapSegmentationImageReferences.
    // Keep as stack-based (no volume conversion) — brush works in stack mode now that
    // crash-causing event handlers are wrapped in try/catch.
    await servicesManager.services.segmentationService.addSegmentationRepresentation(
      activeViewportId,
      {
        segmentationId: segmentationId,
        type: LABELMAP,
      }
    );

    if (toolboxState.getRefineNew()) {
      toolboxState.setRefineNew(false);
    }

    // Recover previous visibility where known; newly loaded draft segments default visible.
    for (const segment of Object.values(segments) as any[]) {
      if (!segment || segment.segmentIndex === 0) {
        continue;
      }
      servicesManager.services.segmentationService.setSegmentVisibility(
        activeViewportId,
        segmentationId,
        segment.segmentIndex,
        priorSegmentVisibility.get(segment.segmentIndex) ?? true,
        LABELMAP
      );
    }
    forceLabelmapDisplayVisible(activeViewportId, segmentationId, segments, priorSegmentVisibility);

    // Update only VolumeViewport3D viewports with the segmentation (for surface rendering).
    // Do NOT add to other stack viewports: performStackLabelmapUpdate (triggered by brush)
    // iterates ALL viewports with the segmentation and crashes if any viewport's reference
    // map isn't populated — this prevents brush from working even on the active viewport.
    const currentViewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
    for (let i = 0; i < currentViewportIds.length; i++) {
      const viewportId = currentViewportIds[i];
      if (viewportId === activeViewportId) {
        continue;
      }
      const viewport =
        servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
      const isVolume3D = viewport instanceof VolumeViewport3D;

      if (!isVolume3D) {
        continue; // Skip non-3D viewports to avoid breaking performStackLabelmapUpdate
      }

      servicesManager.services.segmentationService.removeSegmentationRepresentations(viewportId, {
        segmentationId,
      });

      updateLabelmapSegmentationImageReferences(viewportId, segmentationId);

      await servicesManager.services.segmentationService.addSegmentationRepresentation(viewportId, {
        segmentationId: segmentationId,
        type: LABELMAP,
      });

      // Give time for surface computation to complete, then render
      await new Promise(resolve => setTimeout(resolve, 100));
      requestAnimationFrame(() => {
        if (viewport) {
          viewport.render();
        }
      });
    }

    if (priorNiftiResources?.isNiftiDraft) {
      const currentImageIds = new Set(derivedImageIds);
      const replacedImageIds = priorNiftiResources.imageIds.filter(
        imageId => !currentImageIds.has(imageId)
      );
      if (replacedImageIds.length > 0) {
        releaseNiftiDraftResources({
          segmentationId,
          imageIds: replacedImageIds,
          volumeIds: [],
          isNiftiDraft: true,
        });
      }
    }
    if (shouldTrackNiftiResources) {
      trackNiftiDerivedResources(segmentationId, derivedImageIds);
    }

    // Set active segmentation AFTER all representations are finalized, so the brush tool
    // correctly targets the nnInteractive segmentation (not the DICOM-SEG or nothing)
    servicesManager.services.segmentationService.setActiveSegmentation(
      activeViewportId,
      segmentationId
    );
    forceLabelmapDisplayVisible(activeViewportId, segmentationId, segments, priorSegmentVisibility);
    servicesManager.services.cornerstoneViewportService
      .getCornerstoneViewport(activeViewportId)
      ?.render();

    // Debug logging: verify final state after all representations and active segmentation set
    const dbgFinalSegIdx = csToolsSegmentation.segmentIndex.getActiveSegmentIndex(segmentationId);
    const dbgFinalActiveSeg =
      csToolsSegmentation.activeSegmentation.getActiveSegmentation(activeViewportId);
    patchStackLabelmapModifiedSlices(derivedImageIds);
    const dbgFinalMapResult = updateLabelmapSegmentationImageReferences(
      activeViewportId,
      segmentationId
    );
    const dbgSegState = csToolsSegmentation.state.getSegmentation(segmentationId);
    const dbgReps =
      servicesManager.services.segmentationService.getSegmentationRepresentations(activeViewportId);
    console.log('[nnInteractive DEBUG] Final state after postSegmentationProcessing:', {
      segmentationId,
      segmentNumber,
      activeSegmentIndex: dbgFinalSegIdx,
      activeSegmentationId: dbgFinalActiveSeg?.segmentationId,
      labelmapMapResult: dbgFinalMapResult,
      segmentKeys: dbgSegState ? Object.keys(dbgSegState.segments) : 'no segmentation',
      segmentActiveStates: dbgSegState
        ? Object.entries(dbgSegState.segments).map(([k, v]: [string, any]) => `${k}:${v.active}`)
        : [],
      representationCount: dbgReps?.length,
      representationIds: dbgReps?.map(r => r.segmentationId),
    });

    // Trigger SEGMENTATION_DATA_MODIFIED event AFTER all representations are re-added
    // This ensures surface representations exist before they try to update
    eventTarget.dispatchEvent(
      new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, {
        detail: { segmentationId },
      })
    );
    requestAnimationFrame(() => {
      servicesManager.services.cornerstoneViewportService
        .getCornerstoneViewport(activeViewportId)
        ?.render();
    });

    // Restore any other segmentation representations (e.g., DICOM-SEG loaded from PACS)
    // that may have been removed during viewport updates
    for (const rep of otherSegRepresentations) {
      const stillPresent =
        servicesManager.services.segmentationService.getSegmentationRepresentations(
          activeViewportId,
          { segmentationId: rep.segmentationId }
        );
      if (!stillPresent.length) {
        await servicesManager.services.segmentationService.addSegmentationRepresentation(
          activeViewportId,
          { segmentationId: rep.segmentationId }
        );
      }
    }
  }

  function isForegroundMaskValue(value: number): boolean {
    return value > 0;
  }

  function hashForegroundMask(data: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= isForegroundMaskValue(data[i]) ? 1 : 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${data.length}:${hash.toString(16).padStart(8, '0')}`;
  }

  function inspectForegroundMaskBuffer(data: Uint8Array): {
    maskHash: string;
    nonZeroVoxels: number;
  } {
    let hash = 0x811c9dc5;
    let nonZeroVoxels = 0;
    for (let i = 0; i < data.length; i++) {
      const value = isForegroundMaskValue(data[i]) ? 1 : 0;
      nonZeroVoxels += value;
      hash ^= value;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return {
      maskHash: `${data.length}:${hash.toString(16).padStart(8, '0')}`,
      nonZeroVoxels,
    };
  }

  async function inspectSegmentBinaryMask({
    segmentationId,
    segmentIndex,
    flipped,
    includeBuffer,
    allowEmpty = false,
    yieldEverySlices = 16,
  }: {
    segmentationId: string;
    segmentIndex: number;
    flipped: boolean;
    includeBuffer: boolean;
    allowEmpty?: boolean;
    yieldEverySlices?: number;
  }): Promise<{ buffer?: Uint8Array; maskHash: string; nonZeroVoxels: number }> {
    const csSeg = csToolsSegmentation.state.getSegmentation(segmentationId);
    const labelmapImageIds = (csSeg?.representationData?.[LABELMAP] as any)?.imageIds;
    if (!labelmapImageIds?.length) {
      throw new Error('No labelmap data found for this segmentation');
    }

    return inspectBinaryMaskSlices({
      sliceCount: labelmapImageIds.length,
      getSlice: sourceSliceIndex => {
        const img = cache.getImage(labelmapImageIds[sourceSliceIndex]);
        if (!img?.voxelManager) {
          throw new Error(`Labelmap slice ${sourceSliceIndex + 1} is not available in cache`);
        }
        return (img.voxelManager as csTypes.IVoxelManager<number>).getScalarData();
      },
      segmentIndex,
      flipped,
      includeBuffer,
      allowEmpty,
      yieldEverySlices,
    });
  }

  function getDraftRoot(filename: string, origin?: string): string {
    return origin || filename;
  }

  function algorithmFromSegment(seg: any): string {
    const name = seg.cachedStats?.algorithmName || '';
    const normalizedName = name.toLowerCase();
    if (normalizedName.startsWith('sam')) return 'sam2';
    if (normalizedName.startsWith('medsam')) return 'sam2';
    if (normalizedName.startsWith('voxtell')) return 'voxtell';
    return name || 'brush';
  }

  function segmentationSeriesUid(segmentation: any): string | undefined {
    if (!segmentation) return undefined;
    if (
      segmentation.cachedStats?.seriesInstanceUID ||
      segmentation.cachedStats?.seriesInstanceUid
    ) {
      return (
        segmentation.cachedStats.seriesInstanceUID || segmentation.cachedStats.seriesInstanceUid
      );
    }

    for (const segment of Object.values(segmentation.segments || {}) as any[]) {
      if (segment?.cachedStats?.algorithmType) {
        return segment.cachedStats.algorithmType;
      }
    }

    return undefined;
  }

  function getActiveCurrentSeriesSegmentation(activeViewportId: string, seriesUID: string) {
    const activeSegmentation =
      servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId);
    if (!activeSegmentation) return undefined;
    return segmentationSeriesUid(activeSegmentation) === seriesUID ? activeSegmentation : undefined;
  }

  function visibleSegments(segmentation: any): any[] {
    return Object.values(segmentation?.segments || {}).filter(
      (segment: any) => segment && segment.segmentIndex !== 0
    );
  }

  function forceLabelmapDisplayVisible(
    viewportId: string,
    segmentationId: string,
    segments: { [segmentIndex: string]: cstTypes.Segment },
    visibilityBySegment?: Map<number, boolean>
  ) {
    try {
      csToolsSegmentation.config.visibility.setSegmentationRepresentationVisibility(
        viewportId,
        {
          segmentationId,
          type: LABELMAP,
        },
        true
      );
    } catch (error) {
      console.warn('Failed to set labelmap representation visibility:', error);
    }

    for (const segment of Object.values(segments || {}) as any[]) {
      if (!segment || segment.segmentIndex === 0) {
        continue;
      }

      try {
        csToolsSegmentation.config.visibility.setSegmentIndexVisibility(
          viewportId,
          {
            segmentationId,
            type: LABELMAP,
          },
          segment.segmentIndex,
          visibilityBySegment?.get(segment.segmentIndex) ?? true
        );
      } catch (error) {
        console.warn(`Failed to set visibility for segment ${segment.segmentIndex}:`, error);
      }
    }

    triggerSegmentationRepresentationModified(viewportId, segmentationId, LABELMAP);
  }

  type PreparedNiftiDraft = {
    draft: NiftiDraft;
    meta: any;
    buffer: Uint8Array;
    memoryOwner: string;
    maskHash: string;
    isLabelOnlyDraft: boolean;
    nonZeroVoxels: number;
  };

  type StagedNiftiDraft = {
    draft: NiftiDraft;
    segmentationId: string;
    segmentationInput: cstTypes.SegmentationPublicInput;
    derivedImageIds: string[];
    ownedVolumeIds: string[];
    isLabelOnlyDraft: boolean;
    zRange: number[];
  };

  type NiftiDraftResourceSnapshot = {
    segmentationId?: string;
    imageIds: string[];
    volumeIds: string[];
    isNiftiDraft: boolean;
  };

  function isDicomBackedSegmentation(segmentationId: string): boolean {
    const displaySet = displaySetService.getDisplaySetByUID?.(segmentationId);
    const modality = String(displaySet?.Modality || '').toUpperCase();
    return modality === 'SEG' || modality === 'RTSTRUCT' || modality === 'RTSS';
  }

  function segmentationReferencesCurrentSeries(
    segmentation: any,
    seriesUID: string,
    imageIds: string[]
  ): boolean {
    if (!segmentation || isDicomBackedSegmentation(segmentation.segmentationId)) {
      return false;
    }

    const segments = visibleSegments(segmentation);
    const hasCurrentSeriesMetadata = segments.some(segment => {
      const stats = segment.cachedStats || {};
      return stats.seriesInstanceUID === seriesUID || stats.algorithmType === seriesUID;
    });
    if (hasCurrentSeriesMetadata) {
      return true;
    }

    const referencedImageIds =
      segmentation.representationData?.[LABELMAP]?.referencedImageIds || [];
    return (
      imageIds.length > 0 && referencedImageIds.length > 0 && referencedImageIds[0] === imageIds[0]
    );
  }

  async function collectCurrentSeriesNiftiMasks({
    seriesUID,
    imageIds,
  }: {
    seriesUID: string;
    imageIds: string[];
  }): Promise<LoadedDraftMaskWithDirtyState[]> {
    const segmentations = servicesManager.services.segmentationService.getSegmentations() || [];
    const masks: LoadedDraftMaskWithDirtyState[] = [];

    for (const segmentation of segmentations) {
      if (!segmentationReferencesCurrentSeries(segmentation, seriesUID, imageIds)) {
        continue;
      }

      const segments = visibleSegments(segmentation);
      const standalone = segments.length === 1;
      for (const segment of segments) {
        const stats = segment.cachedStats || {};
        let currentMaskHash: string | undefined;
        let maskReadError = false;
        try {
          currentMaskHash = (
            await inspectSegmentBinaryMask({
              segmentationId: segmentation.segmentationId,
              segmentIndex: segment.segmentIndex,
              flipped: stats.flipped ?? false,
              includeBuffer: false,
              allowEmpty: true,
            })
          ).maskHash;
        } catch (error) {
          maskReadError = true;
        }

        masks.push(
          withDraftDirtyState({
            segmentationId: segmentation.segmentationId,
            segmentIndex: segment.segmentIndex,
            label: segment.label || segmentation.label || `Segment ${segment.segmentIndex}`,
            isLabelOnlyDraft: stats.isLabelOnlyDraft === true,
            draftRoot: stats.draftOrigin || stats.currentDraftFilename,
            currentDraftFilename: stats.currentDraftFilename,
            savedMaskHash: stats.savedMaskHash || stats.loadedMaskHash,
            savedLabel: stats.savedLabel,
            isDirty: stats.isDirty,
            currentMaskHash,
            maskReadError,
            standalone,
          })
        );
      }
    }

    return masks;
  }

  function draftConflictItems(masks: LoadedDraftMaskWithDirtyState[]) {
    return masks
      .filter(mask => mask.dirtyReasons.length > 0)
      .map(mask => ({
        key: `${mask.segmentationId}:${mask.segmentIndex}`,
        label: mask.label,
        reasons: mask.dirtyReasons,
      }));
  }

  async function prepareNiftiDraft({
    seriesUID,
    draft,
    imageIds,
  }: {
    seriesUID: string;
    draft: NiftiDraft;
    imageIds: string[];
  }): Promise<PreparedNiftiDraft> {
    const memoryOwner = niftiMemoryLedger.createOwner('nifti-prepare');
    try {
      const response = await axios.get(`/monai/nifti-segs/${seriesUID}/${draft.filename}`, {
        responseType: 'arraybuffer',
        headers: { accept: 'multipart/form-data' },
      });
      niftiMemoryLedger.trackObject(response, {
        source: 'nifti-axios-response-object',
        owner: memoryOwner,
      });
      niftiMemoryLedger.trackBuffer(response.data, {
        source: 'nifti-axios-response',
        owner: memoryOwner,
      });
      const contentType = response.headers['content-type'] as string;
      const { meta, seg } = await parseMultipart(response.data, contentType);
      niftiMemoryLedger.trackBuffer(seg, {
        source: 'nifti-multipart-seg',
        owner: memoryOwner,
      });
      const buffer = seg;

      const pixelModule = imageIds.length
        ? metaData.get('imagePixelModule', imageIds[0])
        : undefined;
      const rows = Number(pixelModule?.rows);
      const columns = Number(pixelModule?.columns);
      if (rows > 0 && columns > 0) {
        const expectedLength = rows * columns * imageIds.length;
        if (buffer.length !== expectedLength) {
          throw new Error(
            `Draft ${draft.filename} has ${buffer.length} voxels; expected ${expectedLength}`
          );
        }
      }
      const { maskHash, nonZeroVoxels } = inspectForegroundMaskBuffer(buffer);
      return {
        draft,
        meta,
        buffer,
        memoryOwner,
        maskHash,
        isLabelOnlyDraft: nonZeroVoxels === 0,
        nonZeroVoxels,
      };
    } catch (error) {
      niftiMemoryLedger.releaseOwner(memoryOwner);
      throw error;
    }
  }

  function trackNiftiDerivedResources(
    segmentationId: string,
    derivedImagesOrIds: Array<any | string>
  ): void {
    const owner = niftiSegmentationMemoryOwner(segmentationId);
    niftiMemoryLedger.releaseOwner(owner);
    for (const derivedImageOrId of derivedImagesOrIds) {
      const image =
        typeof derivedImageOrId === 'string'
          ? (cache.getImage(derivedImageOrId) as any)
          : derivedImageOrId;
      if (!image) {
        continue;
      }
      niftiMemoryLedger.trackObject(image, {
        source: 'cornerstone-derived-image',
        owner,
      });
      const voxelManager = image.voxelManager;
      niftiMemoryLedger.trackObject(voxelManager, {
        source: 'cornerstone-voxel-manager',
        owner,
      });
      niftiMemoryLedger.trackBuffer(voxelManager?.getScalarData?.(), {
        source: 'cornerstone-derived-labelmap',
        owner,
      });
      niftiMemoryLedger.trackBuffer(image.imageFrame?.pixelData, {
        source: 'cornerstone-derived-pixel-data',
        owner,
      });
      niftiMemoryLedger.trackBuffer(image.pixelData, {
        source: 'cornerstone-derived-pixel-data',
        owner,
      });
    }
  }

  async function stagePreparedNiftiDraft({
    prepared,
    segmentationId,
    currentDisplaySets,
  }: {
    prepared: PreparedNiftiDraft;
    segmentationId: string;
    currentDisplaySets: any;
  }): Promise<StagedNiftiDraft> {
    const imageIds = currentDisplaySets.imageIds;
    const flipped = String(prepared.meta.flipped).toLowerCase() === 'true';
    const label = prepared.meta.label_name || prepared.draft.label || prepared.draft.filename;
    let derivedImages: any[] = [];
    const ownedDerivedImageIds: string[] = [];

    try {
      if (cache.getBytesAvailable() < prepared.buffer.byteLength) {
        throw new Error(
          `Insufficient Cornerstone cache space to stage ${prepared.draft.filename} atomically`
        );
      }
      derivedImages = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds, {
        getDerivedImageId: () => {
          const imageId = `derived:${csUtils.uuidv4()}`;
          ownedDerivedImageIds.push(imageId);
          return imageId;
        },
      } as any);
      trackNiftiDerivedResources(segmentationId, derivedImages);
      const zRange: number[] = [];
      let sourceOffset = 0;

      for (let sourceSliceIndex = 0; sourceSliceIndex < derivedImages.length; sourceSliceIndex++) {
        const targetSliceIndex = flipped
          ? derivedImages.length - sourceSliceIndex - 1
          : sourceSliceIndex;
        const voxelManager = derivedImages[targetSliceIndex]
          .voxelManager as csTypes.IVoxelManager<number>;
        const scalarData = voxelManager.getScalarData();
        const sourceEnd = sourceOffset + scalarData.length;
        if (sourceEnd > prepared.buffer.length) {
          throw new Error(
            `Draft ${prepared.draft.filename} has fewer voxels than its labelmap geometry`
          );
        }

        let hasForeground = false;
        for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
          const foreground = isForegroundMaskValue(prepared.buffer[sourceOffset + voxelIndex]);
          scalarData[voxelIndex] = foreground ? 1 : 0;
          hasForeground ||= foreground;
        }
        if (hasForeground) {
          zRange.push(targetSliceIndex);
        }
        sourceOffset = sourceEnd;
      }

      if (sourceOffset !== prepared.buffer.length) {
        throw new Error(
          `Draft ${prepared.draft.filename} has ${prepared.buffer.length} voxels; labelmap expects ${sourceOffset}`
        );
      }

      const derivedImageIds = derivedImages.map(image => image.imageId);
      const draftOrigin = prepared.meta.origin || prepared.draft.origin;
      const segments: { [segmentIndex: string]: cstTypes.Segment } = {
        1: {
          segmentIndex: 1,
          label,
          locked: false,
          active: false,
          cachedStats: {
            modifiedTime: utils.formatDate(String(Date.now()), 'YYYYMMDD'),
            algorithmType: currentDisplaySets.SeriesInstanceUID,
            algorithmName: `draft_${prepared.meta.algorithm || 'unknown'}`,
            description: prepared.meta.prompt_info || '',
            center:
              zRange.length > 0
                ? zRange.reduce((sum, sliceIndex) => sum + sliceIndex, 0) / zRange.length
                : 0,
            flipped,
            sourceType: 'nifti-draft',
            seriesInstanceUID: currentDisplaySets.SeriesInstanceUID,
            draftOrigin: getDraftRoot(prepared.draft.filename, draftOrigin),
            currentDraftFilename: prepared.draft.filename,
            savedMaskHash: prepared.maskHash,
            savedLabel: label,
            isLabelOnlyDraft: prepared.isLabelOnlyDraft,
            nonZeroVoxels: prepared.nonZeroVoxels,
            isDirty: false,
          },
        },
      };

      return {
        draft: prepared.draft,
        segmentationId,
        segmentationInput: {
          segmentationId,
          representation: {
            type: LABELMAP,
            data: {
              imageIds: derivedImageIds,
              referencedImageIds: imageIds,
            },
          },
          config: {
            cachedStats: {
              center:
                zRange.length > 0
                  ? zRange.reduce((sum, sliceIndex) => sum + sliceIndex, 0) / zRange.length
                  : 0,
            },
            label,
            segments,
          },
        },
        derivedImageIds,
        ownedVolumeIds: [],
        isLabelOnlyDraft: prepared.isLabelOnlyDraft,
        zRange,
      };
    } catch (error) {
      releaseNiftiDraftResources({
        segmentationId,
        imageIds: ownedDerivedImageIds,
        volumeIds: [],
        isNiftiDraft: true,
      });
      throw error;
    } finally {
      // The staged labelmap cache now owns the voxel data. Do not retain the multipart view.
      prepared.buffer = new Uint8Array(0);
      niftiMemoryLedger.releaseOwner(prepared.memoryOwner);
    }
  }

  async function materializePreparedNiftiDraft({
    prepared,
    segmentationId,
    activeViewportId,
    currentDisplaySets,
  }: {
    prepared: PreparedNiftiDraft;
    segmentationId: string;
    activeViewportId: string;
    currentDisplaySets: any;
  }): Promise<string> {
    const staged = await stagePreparedNiftiDraft({
      prepared,
      segmentationId,
      currentDisplaySets,
    });
    const config = staged.segmentationInput.config as any;

    try {
      await postSegmentationProcessing({
        activeViewportId,
        segmentationId,
        segmentNumber: 1,
        segments: config.segments,
        derivedImageIds: staged.derivedImageIds,
        currentDisplaySets,
        imageIds: currentDisplaySets.imageIds,
        existingSegments: {},
        existing: false,
        activeSegmentation: undefined,
        currentImageIdIndex: servicesManager.services.cornerstoneViewportService
          .getCornerstoneViewport(activeViewportId)
          ?.getCurrentImageIdIndex?.(),
        z_range: staged.zRange,
        segmentationLabel: config.label,
      });
      return segmentationId;
    } catch (error) {
      if (servicesManager.services.segmentationService.getSegmentation(segmentationId)) {
        removeSegmentationFromAllViewports(segmentationId);
      } else {
        releaseNiftiDraftResources(staged);
      }
      throw error;
    }
  }

  function getNiftiDraftResourceSnapshot(
    segmentationId: string
  ): NiftiDraftResourceSnapshot | undefined {
    const segmentation = csToolsSegmentation.state.getSegmentation(segmentationId);
    if (!segmentation) {
      return undefined;
    }
    const labelmapData = (segmentation.representationData?.[LABELMAP] as any) || {};
    const isNiftiDraft = visibleSegments(segmentation).some(
      segment => segment.cachedStats?.sourceType === 'nifti-draft'
    );
    return {
      segmentationId,
      imageIds: [...(labelmapData.imageIds || [])],
      volumeIds: labelmapData.volumeId ? [labelmapData.volumeId] : [],
      isNiftiDraft,
    };
  }

  function isResourceReferencedByAnotherSegmentation(
    resourceId: string,
    excludedSegmentationId: string | undefined,
    resourceType: 'image' | 'volume'
  ): boolean {
    const segmentations = servicesManager.services.segmentationService.getSegmentations() || [];
    return segmentations.some(segmentation => {
      if (segmentation.segmentationId === excludedSegmentationId) {
        return false;
      }
      const labelmapData = (segmentation.representationData?.[LABELMAP] as any) || {};
      return resourceType === 'image'
        ? (labelmapData.imageIds || []).includes(resourceId)
        : labelmapData.volumeId === resourceId;
    });
  }

  function releaseNiftiDraftResources(
    target: string | StagedNiftiDraft | NiftiDraftResourceSnapshot
  ): void {
    let snapshot: NiftiDraftResourceSnapshot | undefined;
    if (typeof target === 'string') {
      snapshot = getNiftiDraftResourceSnapshot(target);
    } else if ('derivedImageIds' in target) {
      snapshot = {
        segmentationId: target.segmentationId,
        imageIds: target.derivedImageIds,
        volumeIds: target.ownedVolumeIds,
        isNiftiDraft: true,
      };
    } else {
      snapshot = target;
    }

    if (!snapshot?.isNiftiDraft) {
      return;
    }

    for (const volumeId of snapshot.volumeIds) {
      if (isResourceReferencedByAnotherSegmentation(volumeId, snapshot.segmentationId, 'volume')) {
        continue;
      }
      try {
        if (cache.getVolumeLoadObject(volumeId) || cache.getVolume(volumeId)) {
          cache.removeVolumeLoadObject(volumeId);
        }
      } catch (error) {
        console.warn(`Failed to release NIfTI draft volume ${volumeId}:`, error);
      }
    }

    for (const imageId of snapshot.imageIds) {
      if (isResourceReferencedByAnotherSegmentation(imageId, snapshot.segmentationId, 'image')) {
        continue;
      }
      try {
        if (cache.getImageLoadObject(imageId)) {
          cache.removeImageLoadObject(imageId, { force: true });
        }
      } catch (error) {
        console.warn(`Failed to release NIfTI draft image ${imageId}:`, error);
      }
    }
    if (snapshot.segmentationId) {
      niftiMemoryLedger.releaseOwner(niftiSegmentationMemoryOwner(snapshot.segmentationId));
    }
  }

  function removeSegmentationFromAllViewports(segmentationId: string) {
    const segmentationService = servicesManager.services.segmentationService;
    const resources = getNiftiDraftResourceSnapshot(segmentationId);
    const viewportIds = segmentationService.getViewportIdsWithSegmentation(segmentationId) || [];
    for (const viewportId of viewportIds) {
      segmentationService.removeSegmentationRepresentations(viewportId, { segmentationId });
    }
    segmentationService.remove(segmentationId);
    if (resources) {
      releaseNiftiDraftResources(resources);
    }
  }

  async function registerStagedNiftiDrafts({
    stagedDrafts,
    activeViewportId,
  }: {
    stagedDrafts: StagedNiftiDraft[];
    activeViewportId: string;
  }): Promise<void> {
    if (stagedDrafts.length === 0) {
      return;
    }

    const segmentationService = servicesManager.services.segmentationService;
    const cornerstoneViewportService = servicesManager.services.cornerstoneViewportService;

    try {
      csToolsSegmentation.addSegmentations(
        stagedDrafts.map(staged => staged.segmentationInput),
        true
      );

      for (const staged of stagedDrafts) {
        patchStackLabelmapModifiedSlices(staged.derivedImageIds);
        updateLabelmapSegmentationImageReferences(activeViewportId, staged.segmentationId);
      }

      csToolsSegmentation.addSegmentationRepresentations(
        activeViewportId,
        stagedDrafts.map(staged => ({
          segmentationId: staged.segmentationId,
          type: LABELMAP,
        }))
      );

      const volume3DViewportIds = cornerstoneViewportService.getViewportIds().filter(viewportId => {
        if (viewportId === activeViewportId) {
          return false;
        }
        return (
          cornerstoneViewportService.getCornerstoneViewport(viewportId) instanceof VolumeViewport3D
        );
      });

      for (const viewportId of volume3DViewportIds) {
        for (const staged of stagedDrafts) {
          updateLabelmapSegmentationImageReferences(viewportId, staged.segmentationId);
          await segmentationService.addSegmentationRepresentation(viewportId, {
            segmentationId: staged.segmentationId,
            type: LABELMAP,
          });
        }
      }
    } catch (error) {
      for (const staged of [...stagedDrafts].reverse()) {
        if (segmentationService.getSegmentation(staged.segmentationId)) {
          removeSegmentationFromAllViewports(staged.segmentationId);
        } else {
          releaseNiftiDraftResources(staged);
        }
      }
      throw error;
    }
  }

  function memoryBufferObject(value: any): object | undefined {
    if (!value) {
      return;
    }
    const buffer = ArrayBuffer.isView(value) ? value.buffer : value;
    const isArrayBuffer =
      buffer instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer);
    return isArrayBuffer ? buffer : undefined;
  }

  function addMemoryBuffer(target: Set<object>, value: any): void {
    const buffer = memoryBufferObject(value);
    if (buffer) {
      target.add(buffer);
    }
  }

  function summarizeMemoryBuffers(buffers: Set<object>) {
    return {
      uniqueBufferCount: buffers.size,
      bytes: [...buffers].reduce(
        (total, buffer: any) => total + (Number(buffer.byteLength) || 0),
        0
      ),
    };
  }

  function debugNiftiDraftMemory() {
    const segmentationService = servicesManager.services.segmentationService;
    const cornerstoneViewportService = servicesManager.services.cornerstoneViewportService;
    const niftiSegmentations = (segmentationService.getSegmentations() || []).filter(segmentation =>
      visibleSegments(segmentation).some(
        segment => segment.cachedStats?.sourceType === 'nifti-draft'
      )
    );
    const niftiSegmentationIds = new Set(
      niftiSegmentations.map(segmentation => segmentation.segmentationId)
    );
    const viewportIds = cornerstoneViewportService.getViewportIds() || [];
    const representationCount = viewportIds.reduce((total, viewportId) => {
      const representations = segmentationService.getSegmentationRepresentations(viewportId) || [];
      return (
        total +
        representations.filter(rep => niftiSegmentationIds.has(rep.segmentationId)).length
      );
    }, 0);

    const niftiBuffers = new Set<object>();
    const masks = niftiSegmentations.map(segmentation => {
      const imageIds = (segmentation.representationData?.[LABELMAP] as any)?.imageIds || [];
      const estimatedBytes = imageIds.reduce((total: number, imageId: string) => {
        const image = cache.getImage(imageId) as any;
        if (!image) {
          return total;
        }
        addMemoryBuffer(niftiBuffers, image.voxelManager?.getScalarData?.());
        addMemoryBuffer(niftiBuffers, image.imageFrame?.pixelData);
        addMemoryBuffer(niftiBuffers, image.pixelData);
        if (Number.isFinite(image.sizeInBytes)) {
          return total + image.sizeInBytes;
        }
        const scalarData = image.voxelManager?.getScalarData?.();
        return total + (scalarData?.byteLength || 0);
      }, 0);
      const segments = visibleSegments(segmentation);
      return {
        segmentationId: segmentation.segmentationId,
        derivedImageCount: imageIds.length,
        estimatedBytes,
        isLabelOnlyDraft: segments.some(segment => segment.cachedStats?.isLabelOnlyDraft === true),
      };
    });

    const sourceImageBuffers = new Set<object>();
    const actorBuffers = new Set<object>();
    const stackViewports = viewportIds.map(viewportId => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId) as any;
      const actorEntries = viewport?.getActors?.() || [];

      for (const imageId of viewport?.getImageIds?.() || []) {
        const image = cache.getImage(imageId) as any;
        addMemoryBuffer(sourceImageBuffers, image?.voxelManager?.getScalarData?.());
        addMemoryBuffer(sourceImageBuffers, image?.imageFrame?.pixelData);
        addMemoryBuffer(sourceImageBuffers, image?.pixelData);
      }

      const segmentations = niftiSegmentations
        .map(segmentation => {
          const prefix = `${segmentation.segmentationId}-${LABELMAP}`;
          const entries = actorEntries.filter((actorEntry: any) =>
            actorEntry?.representationUID?.startsWith(prefix)
          );
          const scalarBuffers = new Set<object>();
          const actors = entries.map((actorEntry: any) => {
            const scalars = actorEntry?.actor
              ?.getMapper?.()
              ?.getInputData?.()
              ?.getPointData?.()
              ?.getScalars?.()
              ?.getData?.();
            addMemoryBuffer(scalarBuffers, scalars);
            addMemoryBuffer(actorBuffers, scalars);
            return {
              uid: actorEntry.uid,
              referencedId: actorEntry.referencedId,
              scalarBytes: Number(scalars?.byteLength) || 0,
            };
          });
          return {
            segmentationId: segmentation.segmentationId,
            actorCount: entries.length,
            actors,
            ...summarizeMemoryBuffers(scalarBuffers),
          };
        })
        .filter(item => item.actorCount > 0);

      return {
        viewportId,
        totalActorCount: actorEntries.length,
        segmentations,
      };
    });
    const knownBuffers = new Set<object>([
      ...niftiBuffers,
      ...sourceImageBuffers,
      ...actorBuffers,
    ]);
    const performanceMemory = (globalThis.performance as any)?.memory;

    return {
      niftiSegmentationCount: niftiSegmentations.length,
      representationCount,
      masks,
      cache: {
        currentBytes: cache.getCacheSize(),
        maxBytes: cache.getMaxCacheSize(),
        remainingBytes: cache.getBytesAvailable(),
      },
      labelOnlyCount: masks.filter(mask => mask.isLabelOnlyDraft).length,
      stackViewports,
      memoryRoots: {
        niftiDerivedLabelmaps: summarizeMemoryBuffers(niftiBuffers),
        viewportSourceImages: summarizeMemoryBuffers(sourceImageBuffers),
        niftiLabelmapActorScalars: summarizeMemoryBuffers(actorBuffers),
        union: summarizeMemoryBuffers(knownBuffers),
      },
      ...(performanceMemory
        ? {
            performanceMemory: {
              jsHeapSizeLimit: performanceMemory.jsHeapSizeLimit,
              totalJSHeapSize: performanceMemory.totalJSHeapSize,
              usedJSHeapSize: performanceMemory.usedJSHeapSize,
            },
          }
        : {}),
    };
  }

  function debugNiftiBufferLedger() {
    const segmentationService = servicesManager.services.segmentationService;
    const cornerstoneViewportService = servicesManager.services.cornerstoneViewportService;
    const niftiBuffers = new Set<object>();
    const sourceImageBuffers = new Set<object>();
    const actorBuffers = new Set<object>();

    const niftiSegmentations = (segmentationService.getSegmentations() || []).filter(segmentation =>
      visibleSegments(segmentation).some(
        segment => segment.cachedStats?.sourceType === 'nifti-draft'
      )
    );
    for (const segmentation of niftiSegmentations) {
      const imageIds = (segmentation.representationData?.[LABELMAP] as any)?.imageIds || [];
      trackNiftiDerivedResources(segmentation.segmentationId, imageIds);
      for (const imageId of imageIds) {
        const image = cache.getImage(imageId) as any;
        addMemoryBuffer(niftiBuffers, image?.voxelManager?.getScalarData?.());
        addMemoryBuffer(niftiBuffers, image?.imageFrame?.pixelData);
        addMemoryBuffer(niftiBuffers, image?.pixelData);
      }
    }

    for (const viewportId of cornerstoneViewportService.getViewportIds() || []) {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId) as any;
      for (const imageId of viewport?.getImageIds?.() || []) {
        const image = cache.getImage(imageId) as any;
        addMemoryBuffer(sourceImageBuffers, image?.voxelManager?.getScalarData?.());
        addMemoryBuffer(sourceImageBuffers, image?.imageFrame?.pixelData);
        addMemoryBuffer(sourceImageBuffers, image?.pixelData);
      }
      for (const actorEntry of viewport?.getActors?.() || []) {
        const scalars = actorEntry?.actor
          ?.getMapper?.()
          ?.getInputData?.()
          ?.getPointData?.()
          ?.getScalars?.()
          ?.getData?.();
        addMemoryBuffer(actorBuffers, scalars);
      }
    }

    const knownBuffers = new Set<object>([...niftiBuffers, ...sourceImageBuffers, ...actorBuffers]);

    return {
      ledger: niftiMemoryLedger.report(),
      knownRoots: {
        niftiDerivedLabelmaps: summarizeMemoryBuffers(niftiBuffers),
        viewportSourceImages: summarizeMemoryBuffers(sourceImageBuffers),
        viewportActorScalars: summarizeMemoryBuffers(actorBuffers),
        union: summarizeMemoryBuffers(knownBuffers),
      },
      cornerstoneCache: {
        currentBytes: cache.getCacheSize(),
        maxBytes: cache.getMaxCacheSize(),
        remainingBytes: cache.getBytesAvailable(),
      },
      interpretation: {
        active: '仍属于当前下载、分割或 Cornerstone labelmap 的追踪对象',
        releasedButReachable:
          'OHIF 已结束逻辑 owner，但浏览器尚未回收；若 Firefox Minimize memory 后仍存在，才说明被 Promise、通知、Console 或其他 root 保留',
        collected: 'WeakRef 已确认对象可被垃圾回收；数量受 GC 时机影响',
      },
    };
  }

  (window as any)._debugNiftiDraftMemory = debugNiftiDraftMemory;
  (window as any)._debugNiftiBufferLedger = debugNiftiBufferLedger;
  (window as any)._resetNiftiBufferLedger = () => niftiMemoryLedger.reset();

  let niftiMemoryDebugLoggingEnabled = false;
  (window as any)._setNiftiMemoryDebugLogging = (enabled: boolean) => {
    niftiMemoryDebugLoggingEnabled = enabled === true;
    return niftiMemoryDebugLoggingEnabled;
  };

  function logNiftiDraftMemory(checkpoint: string): void {
    if (!niftiMemoryDebugLoggingEnabled) {
      return;
    }
    console.debug(`[NIfTI Draft Memory] ${checkpoint}`, {
      draftMemory: debugNiftiDraftMemory(),
      bufferLedger: niftiMemoryLedger.report({ includeSamples: false }),
    });
  }

  async function autoSaveRefinedDraft({
    segmentationId,
    segmentIndex,
    seriesUID,
    studyInstanceUID,
    label,
    flipped,
    draftOrigin,
    allowEmpty = false,
  }: {
    segmentationId: string;
    segmentIndex: number;
    seriesUID: string;
    studyInstanceUID: string;
    label: string;
    flipped: boolean;
    draftOrigin: string;
    allowEmpty?: boolean;
  }): Promise<{
    filename?: string;
    maskHash: string;
    nonZeroVoxels: number;
    isLabelOnlyDraft: boolean;
  }> {
    const editedLabel = label.replace(/ \(edited\)$/, '') + ' (edited)';
    const { buffer, maskHash, nonZeroVoxels } = await inspectSegmentBinaryMask({
      segmentationId,
      segmentIndex,
      flipped,
      includeBuffer: true,
      allowEmpty,
    });
    if (!buffer) {
      throw new Error('Failed to extract segment mask buffer');
    }
    const isLabelOnlyDraft = nonZeroVoxels === 0;

    const params = {
      label: editedLabel,
      algorithm: 'nninteractive',
      flipped,
      origin: draftOrigin,
      segments: { '1': editedLabel },
      raw_binary: true,
      studyInstanceUID,
      ...(allowEmpty && isLabelOnlyDraft ? { allow_empty: true } : {}),
    };
    const formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append(
      'seg_data',
      new Blob([buffer], { type: 'application/octet-stream' }),
      'seg.bin'
    );

    const resp = await axios.post(`/monai/nifti-segs/${seriesUID}`, formData);
    console.log('Auto-saved refined draft:', resp.data);
    return { filename: resp.data?.filename, maskHash, nonZeroVoxels, isLabelOnlyDraft };
  }

  // Save a freshly user-created segment (no draftOrigin) as a new NIfTI draft.
  // Similar to autoSaveRefinedDraft but without the "(edited)" suffix and without origin.
  async function saveNewMaskDraft({
    segmentationId,
    segmentIndex,
    seriesUID,
    studyInstanceUID,
    label,
    flipped,
    algorithm,
  }: {
    segmentationId: string;
    segmentIndex: number;
    seriesUID: string;
    studyInstanceUID: string;
    label: string;
    flipped: boolean;
    algorithm: string;
  }): Promise<{
    filename?: string;
    maskHash: string;
    nonZeroVoxels: number;
    isLabelOnlyDraft: boolean;
  }> {
    const { buffer, maskHash, nonZeroVoxels } = await inspectSegmentBinaryMask({
      segmentationId,
      segmentIndex,
      flipped,
      includeBuffer: true,
    });
    if (!buffer) {
      throw new Error('Failed to extract segment mask buffer');
    }

    const params = {
      label,
      algorithm,
      flipped,
      segments: { '1': label },
      raw_binary: true,
      studyInstanceUID,
    };
    const formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append(
      'seg_data',
      new Blob([buffer], { type: 'application/octet-stream' }),
      'seg.bin'
    );

    const resp = await axios.post(`/monai/nifti-segs/${seriesUID}`, formData);
    console.log('Saved new mask draft:', resp.data);
    return {
      filename: resp.data?.filename,
      maskHash,
      nonZeroVoxels,
      isLabelOnlyDraft: nonZeroVoxels === 0,
    };
  }

  // Global debug function: call window._debugBrushState() from browser console
  // to diagnose why the brush tool can't paint
  (window as any)._debugBrushState = () => {
    const { activeViewportId } = viewportGridService.getState();
    const csViewport =
      servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
    const toolGroupService = servicesManager.services.toolGroupService;
    const segService = servicesManager.services.segmentationService;

    // 1. Viewport info
    const vpType = csViewport?.type;
    const vpClassName = csViewport?.constructor?.name;
    const currentImageId = csViewport?.getCurrentImageId?.() || 'N/A (volume viewport)';
    const currentImageIdIndex = csViewport?.getCurrentImageIdIndex?.();

    // 2. Tool group info
    const toolGroup = toolGroupService.getToolGroupForViewport(activeViewportId);
    const activePrimaryTool = toolGroup?.getActivePrimaryMouseButtonTool?.();
    const toolNames = toolGroup ? Object.keys(toolGroup._toolInstances || {}) : [];

    // 3. Active segmentation
    const activeSeg =
      csToolsSegmentation.activeSegmentation.getActiveSegmentation(activeViewportId);
    const activeSegId = activeSeg?.segmentationId;

    // 4. Active segment index
    const activeSegIdx = activeSegId
      ? csToolsSegmentation.segmentIndex.getActiveSegmentIndex(activeSegId)
      : undefined;

    // 5. Segmentation representations
    const reps = segService.getSegmentationRepresentations(activeViewportId);

    // 6. Labelmap image reference map - try to update and get result
    let labelmapMapResult: any = 'no active segmentation';
    if (activeSegId) {
      labelmapMapResult = updateLabelmapSegmentationImageReferences(activeViewportId, activeSegId);
    }

    // 7. Check segmentation state
    const segState = activeSegId ? csToolsSegmentation.state.getSegmentation(activeSegId) : null;
    const labelmapData =
      segState?.representationData?.Labelmap || segState?.representationData?.LABELMAP;
    patchStackLabelmapModifiedSlices(labelmapData?.imageIds);
    const currentLabelmapImageId =
      typeof currentImageIdIndex === 'number'
        ? labelmapData?.imageIds?.[currentImageIdIndex]
        : undefined;
    const currentLabelmapImage = currentLabelmapImageId
      ? cache.getImage(currentLabelmapImageId)
      : undefined;
    const currentLabelmapScalarData = currentLabelmapImage?.voxelManager?.getScalarData?.();
    const invalidLabelmapIndexes = getInvalidLabelmapImageIndexes(
      labelmapData?.imageIds,
      csViewport?.getImageIds?.()?.length || labelmapData?.imageIds?.length
    );
    const modifiedSliceSamples = Array.isArray(labelmapData?.imageIds)
      ? labelmapData.imageIds
          .map((imageId, index) => {
            const voxelManager = imageId
              ? (cache.getImage(imageId)?.voxelManager as any)
              : undefined;
            const modifiedSlices = voxelManager?.getArrayOfModifiedSlices?.();
            return modifiedSlices?.length ? { index, modifiedSlices } : null;
          })
          .filter(Boolean)
          .slice(0, 10)
      : [];
    let labelmapRepresentationVisible: any = 'unknown';
    let labelmapSegmentVisibility: any = 'unknown';
    if (activeSegId) {
      try {
        labelmapRepresentationVisible = (
          csToolsSegmentation.config.visibility as any
        ).getSegmentationRepresentationVisibility?.(activeViewportId, {
          segmentationId: activeSegId,
          type: LABELMAP,
        });
      } catch (error) {
        labelmapRepresentationVisible = `error: ${error?.message || error}`;
      }

      try {
        labelmapSegmentVisibility = segState
          ? Object.values(segState.segments || {}).map((segment: any) => ({
              index: segment.segmentIndex,
              visible: (csToolsSegmentation.config.visibility as any).getSegmentIndexVisibility?.(
                activeViewportId,
                {
                  segmentationId: activeSegId,
                  type: LABELMAP,
                },
                segment.segmentIndex
              ),
            }))
          : [];
      } catch (error) {
        labelmapSegmentVisibility = `error: ${error?.message || error}`;
      }
    }

    console.log('=== BRUSH DEBUG STATE ===');
    console.log('Viewport:', {
      activeViewportId,
      type: vpType,
      className: vpClassName,
      currentImageId:
        typeof currentImageId === 'string'
          ? currentImageId.substring(0, 80) + '...'
          : currentImageId,
      currentImageIdIndex,
    });
    console.log('Tool Group:', {
      activePrimaryTool,
      availableTools: toolNames,
      toolGroupId: toolGroup?.id,
    });
    console.log('Active Segmentation:', {
      segmentationId: activeSegId,
      activeSegmentIndex: activeSegIdx,
      segments: segState
        ? Object.entries(segState.segments).map(([k, v]: [string, any]) => ({
            index: k,
            active: v.active,
            locked: v.locked,
            label: v.label,
          }))
        : 'none',
    });
    console.log('Representations:', {
      count: reps?.length,
      details: reps?.map(r => ({ segId: r.segmentationId, type: r.type })),
    });
    console.log('Labelmap Data:', {
      labelmapMapResult,
      hasImageIds: !!labelmapData?.imageIds,
      imageIdCount: labelmapData?.imageIds?.length,
      hasVolumeId: !!labelmapData?.volumeId,
      firstImageId: labelmapData?.imageIds?.[0]?.substring(0, 80),
      currentLabelmapImageId: currentLabelmapImageId?.substring(0, 80),
      currentLabelmapImageInCache: !!currentLabelmapImage,
      currentLabelmapNonZero: currentLabelmapScalarData
        ? currentLabelmapScalarData.some(v => v !== 0)
        : false,
      invalidLabelmapIndexes,
      modifiedSliceSamples,
      labelmapRepresentationVisible,
      labelmapSegmentVisibility,
    });
    console.log('=== END BRUSH DEBUG ===');
  };

  function patchStackLabelmapModifiedSlices(labelmapImageIds?: string[]) {
    if (!Array.isArray(labelmapImageIds)) {
      return;
    }

    labelmapImageIds.forEach((imageId, stackSliceIndex) => {
      if (!imageId) {
        return;
      }

      const image = cache.getImage(imageId);
      const voxelManager = image?.voxelManager as any;
      if (!voxelManager || typeof voxelManager.getArrayOfModifiedSlices !== 'function') {
        return;
      }

      const dimensions = voxelManager.dimensions;
      const isSingleSliceVoxelManager =
        !Array.isArray(dimensions) || dimensions.length < 3 || dimensions[2] <= 1;
      if (!isSingleSliceVoxelManager) {
        return;
      }

      voxelManager.__ohifStackSliceIndex = stackSliceIndex;
      if (voxelManager.__ohifStackModifiedSlicesPatch) {
        return;
      }

      const getArrayOfModifiedSlices = voxelManager.getArrayOfModifiedSlices.bind(voxelManager);
      voxelManager.getArrayOfModifiedSlices = () => {
        const modifiedSlices = getArrayOfModifiedSlices();
        if (!modifiedSlices?.length) {
          return modifiedSlices;
        }

        const sliceIndex = voxelManager.__ohifStackSliceIndex;
        return Number.isFinite(sliceIndex)
          ? [sliceIndex]
          : modifiedSlices.filter(slice => Number.isFinite(slice));
      };
      voxelManager.__ohifStackModifiedSlicesPatch = true;
    });
  }

  function getInvalidLabelmapImageIndexes(labelmapImageIds?: string[], expectedLength?: number) {
    const invalidIndexes: number[] = [];
    if (!Array.isArray(labelmapImageIds)) {
      return invalidIndexes;
    }

    const length = expectedLength ?? labelmapImageIds.length;
    for (let i = 0; i < length; i++) {
      const imageId = labelmapImageIds[i];
      if (!imageId || !cache.getImage(imageId)) {
        invalidIndexes.push(i);
      }
    }

    return invalidIndexes;
  }

  const actions = {
    setAiToolActive: ({ toolName }: { toolName: string }) => {
      if (!toolName) {
        return;
      }

      if (toolboxState.getLocked() && toolName !== 'Pan') {
        return commandsManager.run('setToolActive', { toolName: 'Pan' });
      }

      return commandsManager.run('setToolActive', { toolName });
    },

    runAiSegmentation: () => {
      if (toolboxState.getLocked()) {
        return;
      }

      const selectedModel = toolboxState.getSelectedModel();
      if (selectedModel === 'sam2' || selectedModel === 'medsam2' || selectedModel === 'sam3') {
        return commandsManager.run('sam2');
      }

      return commandsManager.run('nninter');
    },

    /**
     * Runs a command in multi-monitor mode.  No-op if not multi-monitor.
     */
    multimonitor: async options => {
      const { screenDelta, StudyInstanceUID, commands, hashParams } = options;
      if (multiMonitorService.numberOfScreens < 2) {
        return options.fallback?.(options);
      }

      const newWindow = await multiMonitorService.launchWindow(
        StudyInstanceUID,
        screenDelta,
        hashParams
      );

      // Only run commands if we successfully got a window with a commands manager
      if (newWindow && commands) {
        // Todo: fix this properly, but it takes time for the new window to load
        // and then the commandsManager is available for it
        setTimeout(() => {
          multiMonitorService.run(screenDelta, commands, options);
        }, 1000);
      }
    },

    /** Displays a prompt and then save the report if relevant */
    promptSaveReport: props => {
      const { StudyInstanceUID } = props;
      promptSaveReport({ servicesManager, commandsManager, extensionManager }, props, {
        data: { StudyInstanceUID },
      });
    },

    /**
     * Ensures that the specified study is available for display
     * Then, if commands is specified, runs the given commands list/instance
     */
    loadStudy: async options => {
      const { StudyInstanceUID } = options;
      const displaySets = displaySetService.getActiveDisplaySets();
      const isActive = displaySets.find(ds => ds.StudyInstanceUID === StudyInstanceUID);
      if (isActive) {
        return;
      }
      const [dataSource] = extensionManager.getActiveDataSource();
      await requestDisplaySetCreationForStudy(dataSource, displaySetService, StudyInstanceUID);

      const study = DicomMetadataStore.getStudy(StudyInstanceUID);
      hangingProtocolService.addStudy(study);
    },

    /**
     * Show the context menu.
     * @param options.menuId defines the menu name to lookup, from customizationService
     * @param options.defaultMenu contains the default menu set to use
     * @param options.element is the element to show the menu within
     * @param options.event is the event that caused the context menu
     * @param options.selectorProps is the set of selection properties to use
     */
    showContextMenu: (options: ContextMenuProps) => {
      const {
        menuCustomizationId,
        element,
        event,
        selectorProps,
        defaultPointsPosition = [],
      } = options;

      const optionsToUse = { ...options };

      if (menuCustomizationId) {
        Object.assign(optionsToUse, customizationService.getCustomization(menuCustomizationId));
      }

      // TODO - make the selectorProps richer by including the study metadata and display set.
      const { protocol, stage } = hangingProtocolService.getActiveProtocol();
      optionsToUse.selectorProps = {
        event,
        protocol,
        stage,
        ...selectorProps,
      };

      contextMenuController.showContextMenu(optionsToUse, element, defaultPointsPosition);
    },

    /** Close a context menu currently displayed */
    closeContextMenu: () => {
      contextMenuController.closeContextMenu();
    },

    displayNotification: ({ text, title, type }) => {
      uiNotificationService.show({
        title: title,
        message: text,
        type: type,
      });
    },

    clearMeasurements: options => {
      measurementService.clearMeasurements(options.measurementFilter);
    },

    /**
     *  Sets the specified protocol
     *    1. Records any existing state using the viewport grid service
     *    2. Finds the destination state - this can be one of:
     *       a. The specified protocol stage
     *       b. An alternate (toggled or restored) protocol stage
     *       c. A restored custom layout
     *    3. Finds the parameters for the specified state
     *       a. Gets the displaySetSelectorMap
     *       b. Gets the map by position
     *       c. Gets any toggle mapping to map position to/from current view
     *    4. If restore, then sets layout
     *       a. Maps viewport position by currently displayed viewport map id
     *       b. Uses toggle information to map display set id
     *    5. Else applies the hanging protocol
     *       a. HP Service is provided displaySetSelectorMap
     *       b. HP Service will throw an exception if it isn't applicable
     * @param options - contains information on the HP to apply
     * @param options.activeStudyUID - the updated study to apply the HP to
     * @param options.protocolId - the protocol ID to change to
     * @param options.stageId - the stageId to apply
     * @param options.stageIndex - the index of the stage to go to.
     * @param options.reset - flag to indicate if the HP should be reset to its original and not restored to a previous state
     *
     * commandsManager.run('setHangingProtocol', {
     *   activeStudyUID: '1.2.3',
     *   protocolId: 'myProtocol',
     *   stageId: 'myStage',
     *   stageIndex: 0,
     *   reset: false,
     * });
     */
    setHangingProtocol: ({
      activeStudyUID = '',
      StudyInstanceUID = '',
      protocolId,
      stageId,
      stageIndex,
      reset = false,
    }: HangingProtocolParams): boolean => {
      const toUseStudyInstanceUID = activeStudyUID || StudyInstanceUID;
      try {
        const native = displaySetService.getActiveDisplaySets().find(ds => ds.sourceType === 'nifti');
        const requestedProtocol = hangingProtocolService.getProtocolById(protocolId || hangingProtocolService.getState().protocolId);
        const needsVolume = requestedProtocol?.stages?.some(stage => stage.viewports?.some(viewport =>
          ['volume', 'volume3d', 'orthographic'].includes(viewport.viewportOptions?.viewportType)));
        if (needsVolume && native?.nativeIsComplete && !native.nativeIsComplete()) {
          native.ensureNativeComplete().then(() => {
            if (displaySetService.getActiveDisplaySets().includes(native)) actions.setHangingProtocol({
              activeStudyUID, StudyInstanceUID, protocolId, stageId, stageIndex, reset,
            });
          }).catch(error => {
            if (error.name !== 'AbortError') uiNotificationService.show({ title: 'NIfTI', message: error.message, type: 'error' });
          });
          return false;
        }
        // Stores in the state the display set selector id to displaySetUID mapping
        // Pass in viewportId for the active viewport.  This item will get set as
        // the activeViewportId
        const state = viewportGridService.getState();
        const hpInfo = hangingProtocolService.getState();
        reuseCachedLayouts(state, hangingProtocolService);
        const { hangingProtocolStageIndexMap } = useHangingProtocolStageIndexStore.getState();
        const { displaySetSelectorMap } = useDisplaySetSelectorStore.getState();

        if (!protocolId) {
          // Reuse the previous protocol id, and optionally stage
          protocolId = hpInfo.protocolId;
          if (stageId === undefined && stageIndex === undefined) {
            stageIndex = hpInfo.stageIndex;
          }
        } else if (stageIndex === undefined && stageId === undefined) {
          // Re-set the same stage as was previously used
          const hangingId = `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:${protocolId}`;
          stageIndex = hangingProtocolStageIndexMap[hangingId]?.stageIndex;
        }

        const useStageIdx =
          stageIndex ??
          hangingProtocolService.getStageIndex(protocolId, {
            stageId,
            stageIndex,
          });

        const activeStudyChanged = hangingProtocolService.setActiveStudyUID(toUseStudyInstanceUID);

        const storedHanging = `${toUseStudyInstanceUID || hangingProtocolService.getState().activeStudyUID}:${protocolId}:${
          useStageIdx || 0
        }`;

        const { viewportGridState } = useViewportGridStore.getState();
        const restoreProtocol = !reset && viewportGridState[storedHanging];

        if (
          reset ||
          (activeStudyChanged &&
            !viewportGridState[storedHanging] &&
            stageIndex === undefined &&
            stageId === undefined)
        ) {
          // Run the hanging protocol fresh, re-using the existing study data
          // This is done on reset or when the study changes and we haven't yet
          // applied it, and don't specify exact stage to use.
          const displaySets = displaySetService.getActiveDisplaySets();
          const activeStudy = {
            StudyInstanceUID: toUseStudyInstanceUID,
            displaySets,
          };
          hangingProtocolService.run(activeStudy, protocolId);
        } else if (
          protocolId === hpInfo.protocolId &&
          useStageIdx === hpInfo.stageIndex &&
          !toUseStudyInstanceUID
        ) {
          // Clear the HP setting to reset them
          hangingProtocolService.setProtocol(protocolId, {
            stageId,
            stageIndex: useStageIdx,
          });
        } else {
          hangingProtocolService.setProtocol(protocolId, {
            displaySetSelectorMap,
            stageId,
            stageIndex: useStageIdx,
            restoreProtocol,
          });
          if (restoreProtocol) {
            viewportGridService.set(viewportGridState[storedHanging]);
          }
        }
        // Do this after successfully applying the update
        const { setDisplaySetSelector } = useDisplaySetSelectorStore.getState();
        setDisplaySetSelector(
          `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:activeDisplaySet:0`,
          null
        );
        return true;
      } catch (e) {
        console.error(e);
        uiNotificationService.show({
          title: 'Apply Hanging Protocol',
          message: 'The hanging protocol could not be applied.',
          type: 'error',
          duration: 3000,
        });
        return false;
      }
    },

    toggleHangingProtocol: ({ protocolId, stageIndex }: HangingProtocolParams): boolean => {
      const {
        protocol,
        stageIndex: desiredStageIndex,
        activeStudy,
      } = hangingProtocolService.getActiveProtocol();
      const { toggleHangingProtocol, setToggleHangingProtocol } =
        useToggleHangingProtocolStore.getState();
      const storedHanging = `${activeStudy.StudyInstanceUID}:${protocolId}:${stageIndex | 0}`;
      if (
        protocol.id === protocolId &&
        (stageIndex === undefined || stageIndex === desiredStageIndex)
      ) {
        // Toggling off - restore to previous state
        const previousState = toggleHangingProtocol[storedHanging] || {
          protocolId: 'default',
        };
        return actions.setHangingProtocol(previousState);
      } else {
        setToggleHangingProtocol(storedHanging, {
          protocolId: protocol.id,
          stageIndex: desiredStageIndex,
        });
        return actions.setHangingProtocol({
          protocolId,
          stageIndex,
          reset: true,
        });
      }
    },

    deltaStage: ({ direction }) => {
      const { protocolId, stageIndex: oldStageIndex } = hangingProtocolService.getState();
      const { protocol } = hangingProtocolService.getActiveProtocol();
      for (
        let stageIndex = oldStageIndex + direction;
        stageIndex >= 0 && stageIndex < protocol.stages.length;
        stageIndex += direction
      ) {
        if (protocol.stages[stageIndex].status !== 'disabled') {
          return actions.setHangingProtocol({
            protocolId,
            stageIndex,
          });
        }
      }
      uiNotificationService.show({
        title: 'Change Stage',
        message: 'The hanging protocol has no more applicable stages',
        type: 'info',
        duration: 3000,
      });
    },

    /**
     * Changes the viewport grid layout in terms of the MxN layout.
     */
    setViewportGridLayout: ({ numRows, numCols, isHangingProtocolLayout = false }) => {
      const { protocol } = hangingProtocolService.getActiveProtocol();
      const onLayoutChange = protocol.callbacks?.onLayoutChange;
      if (commandsManager.run(onLayoutChange, { numRows, numCols }) === false) {
        // Don't apply the layout if the run command returns false
        return;
      }

      const completeLayout = () => {
        const state = viewportGridService.getState();
        findViewportsByPosition(state, { numRows, numCols });

        const { viewportsByPosition, initialInDisplay } = useViewportsByPositionStore.getState();

        const defaultFindOrCreateViewport = layoutFindOrCreate.bind(
          null,
          hangingProtocolService,
          isHangingProtocolLayout,
          { ...viewportsByPosition, initialInDisplay }
        );

        // A native case has one source: additional grid cells should show that
        // source rather than wait for a second DICOM series that does not exist.
        const activeViewport = state.viewports.get(state.activeViewportId);
        const nativeSource = activeViewport?.displaySetInstanceUIDs?.some(uid =>
          displaySetService.getDisplaySetByUID(uid)?.sourceType === 'nifti');
        const findOrCreateViewport = (position: number, positionId: string, options: Record<string, unknown>) => {
          const candidate = defaultFindOrCreateViewport(position, positionId, options);
          if (!nativeSource || candidate?.displaySetInstanceUIDs?.length) return candidate;
          const { viewportId, presentationIds, ...viewportOptions } = activeViewport.viewportOptions || {};
          return {
            displaySetInstanceUIDs: [...activeViewport.displaySetInstanceUIDs],
            displaySetOptions: activeViewport.displaySetOptions?.map(options => ({ ...options })),
            viewportOptions,
          };
        };

        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport,
          isHangingProtocolLayout,
        });
      };
      // Need to finish any work in the callback
      window.setTimeout(completeLayout, 0);
    },

    toggleOneUp() {
      const viewportGridState = viewportGridService.getState();
      const { activeViewportId, viewports, layout, isHangingProtocolLayout } = viewportGridState;
      const { displaySetInstanceUIDs, displaySetOptions, viewportOptions } =
        viewports.get(activeViewportId);

      if (layout.numCols === 1 && layout.numRows === 1) {
        // The viewer is in one-up. Check if there is a state to restore/toggle back to.
        const { toggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();

        if (!toggleOneUpViewportGridStore) {
          return;
        }
        // There is a state to toggle back to. The viewport that was
        // originally toggled to one up was the former active viewport.
        const viewportIdToUpdate = toggleOneUpViewportGridStore.activeViewportId;

        // We are restoring the previous layout but taking into the account that
        // the current one up viewport might have a new displaySet dragged and dropped on it.
        // updatedViewportsViaHP below contains the viewports applicable to the HP that existed
        // prior to the toggle to one-up - including the updated viewports if a display
        // set swap were to have occurred.
        const updatedViewportsViaHP =
          displaySetInstanceUIDs.length > 1
            ? []
            : displaySetInstanceUIDs
                .map(displaySetInstanceUID =>
                  hangingProtocolService.getViewportsRequireUpdate(
                    viewportIdToUpdate,
                    displaySetInstanceUID,
                    isHangingProtocolLayout
                  )
                )
                .flat();

        // findOrCreateViewport returns either one of the updatedViewportsViaHP
        // returned from the HP service OR if there is not one from the HP service then
        // simply returns what was in the previous state for a given position in the layout.
        const findOrCreateViewport = (position: number, positionId: string) => {
          // Find the viewport for the given position prior to the toggle to one-up.
          const preOneUpViewport = Array.from(toggleOneUpViewportGridStore.viewports.values()).find(
            viewport => viewport.positionId === positionId
          );

          // Use the viewport id from before the toggle to one-up to find any updates to the viewport.
          const viewport = updatedViewportsViaHP.find(
            viewport => viewport.viewportId === preOneUpViewport.viewportId
          );

          return viewport
            ? // Use the applicable viewport from the HP updated viewports
              { viewportOptions, displaySetOptions, ...viewport }
            : // Use the previous viewport for the given position
              preOneUpViewport;
        };

        const layoutOptions = viewportGridService.getLayoutOptionsFromState(
          toggleOneUpViewportGridStore
        );

        // Restore the previous layout including the active viewport.
        viewportGridService.setLayout({
          numRows: toggleOneUpViewportGridStore.layout.numRows,
          numCols: toggleOneUpViewportGridStore.layout.numCols,
          activeViewportId: viewportIdToUpdate,
          layoutOptions,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });

        // Reset crosshairs after restoring the layout
        setTimeout(() => {
          commandsManager.runCommand('resetCrosshairs');
        }, 0);
      } else {
        // We are not in one-up, so toggle to one up.

        // Store the current viewport grid state so we can toggle it back later.
        const { setToggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();
        setToggleOneUpViewportGridStore(viewportGridState);

        // one being toggled to one up.
        const findOrCreateViewport = () => {
          return {
            displaySetInstanceUIDs,
            displaySetOptions,
            viewportOptions,
          };
        };

        // Set the layout to be 1x1/one-up.
        viewportGridService.setLayout({
          numRows: 1,
          numCols: 1,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });
      }
    },

    /**
     * Exposes the browser history navigation used by OHIF. This command can be used to either replace or
     * push a new entry into the browser history. For example, the following will replace the current
     * browser history entry with the specified relative URL which changes the study displayed to the
     * study with study instance UID 1.2.3. Note that as a result of using `options.replace = true`, the
     * page prior to invoking this command cannot be returned to via the browser back button.
     *
     * navigateHistory({
     *   to: 'viewer?StudyInstanceUIDs=1.2.3',
     *   options: { replace: true },
     * });
     *
     * @param historyArgs - arguments for the history function;
     *                      the `to` property is the URL;
     *                      the `options.replace` is a boolean indicating if the current browser history entry
     *                      should be replaced or a new entry pushed onto the history (stack); the default value
     *                      for `replace` is false
     */
    navigateHistory(historyArgs: NavigateHistory) {
      history.navigate(historyArgs.to, historyArgs.options);
    },

    openDICOMTagViewer({ displaySetInstanceUID }: { displaySetInstanceUID?: string }) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      const { UIModalService } = servicesManager.services;

      const defaultDisplaySetInstanceUID = displaySetInstanceUID || displaySetInstanceUIDs[0];
      UIModalService.show({
        content: DicomTagBrowser,
        contentProps: {
          displaySets,
          displaySetInstanceUID: defaultDisplaySetInstanceUID,
        },
        title: 'DICOM Tag Browser',
        containerClassName: 'max-w-3xl',
      });
    },

    async sam2() {
      if (toolboxState.getLocked()) {
        return;
      }

      const overlap = false;
      const selectedModel = toolboxState.getSelectedModel();
      const medsam2 = selectedModel; //Check at monailabel server;
      const start = Date.now();

      const segs = servicesManager.services.segmentationService.getSegmentations();
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);

      const { setViewportGridState } = useViewportGridStore.getState();
      const currentImageIdIndex = servicesManager.services.cornerstoneViewportService
        .getCornerstoneViewport(activeViewportId)
        .getCurrentImageIdIndex();
      setViewportGridState('currentImageIdIndex', currentImageIdIndex);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];

      const currentMeasurements = measurementService.getMeasurements();

      const unAssignedMeasurements = currentMeasurements.filter(e => {
        return e.metadata.SegmentNumber === undefined;
      });

      const activeSegmentation =
        servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId);
      let segmentNumber = 1;
      let segments: { [segmentIndex: string]: cstTypes.Segment } = {};
      let segmentationId = `${csUtils.uuidv4()}`;
      if (activeSegmentation !== undefined) {
        segments = activeSegmentation.segments;
        if (Object.values(segments).length > 0) {
          // Find the minimum available segment number
          const existingSegmentNumbers = Object.values(segments)
            .map(e => e.segmentIndex)
            .sort((a, b) => a - b);
          let minAvailableNumber = 1;
          // Find the first gap in segment numbers, or use the next number after the highest
          for (let i = 0; i < existingSegmentNumbers.length; i++) {
            if (existingSegmentNumbers[i] !== minAvailableNumber) {
              break;
            }
            minAvailableNumber++;
          }
          segmentNumber = minAvailableNumber;
          if (!toolboxState.getRefineNew()) {
            const activeSegment =
              servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
            if (activeSegment !== undefined) {
              for (let i = 0; i < unAssignedMeasurements.length; i++) {
                const e = unAssignedMeasurements[i];
                e.metadata.SegmentNumber = activeSegment.segmentIndex;
                e.metadata.segmentationId = activeSegmentation.segmentationId;
              }
              segmentNumber = activeSegment.segmentIndex;
              if (toolboxState.getCurrentActiveSegment() !== segmentNumber) {
                await commandsManager.run('resetNninter');
                toolboxState.setCurrentActiveSegment(segmentNumber);
              }
            } else {
              uiNotificationService.show({
                title: 'Click Segment to refine',
                message: 'No active segment found, please click segment to refine',
                type: 'warning',
                duration: 4000,
              });
              return;
            }
          } else {
            // For new Segment
            for (let i = 0; i < unAssignedMeasurements.length; i++) {
              const e = unAssignedMeasurements[i];
              e.metadata.SegmentNumber = segmentNumber;
              e.metadata.segmentationId = activeSegmentation.segmentationId;
            }
          }
        } else {
          // No existing segments in current active segmentation
          for (let i = 0; i < unAssignedMeasurements.length; i++) {
            const e = unAssignedMeasurements[i];
            e.metadata.SegmentNumber = segmentNumber;
            e.metadata.segmentationId = activeSegmentation.segmentationId;
          }
        }
      } else {
        // No existing segmentation
        for (let i = 0; i < unAssignedMeasurements.length; i++) {
          const e = unAssignedMeasurements[i];
          e.metadata.SegmentNumber = segmentNumber;
          e.metadata.segmentationId = segmentationId;
        }
      }

      const pos_points = currentMeasurements
        .filter(e => {
          return (
            e.toolName === 'Probe2' &&
            e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID &&
            e.metadata.neg === false &&
            e.metadata.SegmentNumber === segmentNumber
          );
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });
      const neg_points = currentMeasurements
        .filter(e => {
          return (
            e.toolName === 'Probe2' &&
            e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID &&
            e.metadata.neg === true &&
            e.metadata.SegmentNumber === segmentNumber
          );
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });

      const pos_boxes = currentMeasurements
        .filter(e => {
          return (
            e.toolName === 'RectangleROI2' &&
            e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID &&
            e.metadata.neg === false &&
            e.metadata.SegmentNumber === segmentNumber
          );
        })
        .map(e => {
          return Object.values(e.data)[0].pointsInShape;
        })
        .map(e => {
          return [e.at(0).pointIJK, e.at(-1).pointIJK];
        });

      //Disable text prompts for SAM2
      const text_prompts = []; //currentMeasurements
      //.filter(e => { return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber; })
      //.map(e => { return e.label })

      // Hide the measurements after inference
      for (let i = 0; i < currentMeasurements.length; i++) {
        const e = currentMeasurements[i];
        if (e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID) {
          measurementService.toggleVisibilityMeasurement(e.uid, false);
        }
      }

      // Force a re-render of the segmentation table after a short delay
      setTimeout(() => {
        // This will trigger a re-render of components that depend on measurement state
        const event = new Event('measurement-state-changed');
        document.dispatchEvent(event);
      }, 200);
      if (
        pos_points.length == 0 &&
        neg_points.length == 0 &&
        pos_boxes.length == 0 &&
        text_prompts.length == 0
      ) {
        uiNotificationService.show({
          title: 'Prompt warning',
          message: 'Only pos/neg points and bbox are available for SAM2',
          type: 'warning',
          duration: 4000,
        });
        return;
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        pos_boxes: pos_boxes,
        texts: text_prompts,
        nninter: false,
        medsam2: medsam2,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const segmentationPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Processing segmentation...',
        type: 'info',
        promise: notificationSafeHttpPromise(segmentationPromise),
        promiseMessages: {
          loading: 'Processing segmentation...',
          success: () => 'Run Segmentation - Successful',
          error: error => `Run Segmentation - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      let responseMemoryOwner: string | undefined;
      try {
        // Process the response
        const response = await segmentationPromise;
        responseMemoryOwner = niftiMemoryLedger.createOwner('monai-segmentation-response');
        niftiMemoryLedger.trackObject(response, {
          source: 'monai-segmentation-response-object',
          owner: responseMemoryOwner,
        });
        niftiMemoryLedger.trackBuffer(response.data, {
          source: 'monai-segmentation-response',
          owner: responseMemoryOwner,
        });
        console.debug('MONAI segmentation response:', summarizeHttpResponse(response));
        if (response.status === 200) {
          const afterPost = Date.now();
          console.log(`Just after Post request: ${(afterPost - start) / 1000} Seconds`);
          const ct = response.headers['content-type'] as string;

          if (
            ct.includes('application/json') &&
            new TextDecoder('utf-8').decode(response.data).includes('sam3_not_found.nii.gz')
          ) {
            uiNotificationService.show({
              title: 'SAM3 not found',
              message: 'SAM3 model not found, please check the checkpoint path',
              type: 'warning',
              duration: 4000,
            });
            return;
          }

          const { meta, seg } = await parseMultipart(response.data, ct);
          niftiMemoryLedger.trackBuffer(seg, {
            source: 'monai-segmentation-multipart',
            owner: responseMemoryOwner,
          });
          console.log(`Just after parseMultipart: ${(Date.now() - start) / 1000} Seconds`);
          //const arrayBuffer = response.data
          const flipped = String(meta.flipped).toLowerCase() === 'true';
          const sam_elapsed = meta.sam_elapsed;
          const prompt_info = meta.prompt_info;
          const label_name = meta.label_name;
          const raw = seg;
          const new_arrayBuffer = new Uint8Array(raw);
          niftiMemoryLedger.trackBuffer(new_arrayBuffer, {
            source: 'monai-segmentation-copy',
            owner: responseMemoryOwner,
          });

          let imageIds = currentDisplaySets.imageIds;
          let existingSegments: { [segmentIndex: string]: cstTypes.Segment } = {};

          let segImageIds = [];

          let existing = false;
          // Find existing segmentation with matching seriesInstanceUid
          if (activeSegmentation !== undefined) {
            let existingseriesInstanceUid = activeSegmentation.cachedStats?.seriesInstanceUid;

            if (existingseriesInstanceUid === undefined) {
              const segments = Object.values(activeSegmentation.segments);
              for (let j = 0; j < segments.length; j++) {
                const segment = segments[j];
                if (segment.cachedStats?.algorithmType !== undefined) {
                  existingseriesInstanceUid = segment.cachedStats.algorithmType;
                }
              }
            }

            if (existingseriesInstanceUid === currentDisplaySets.SeriesInstanceUID) {
              existingSegments = activeSegmentation.segments || {};
              segmentationId = activeSegmentation.segmentationId;
              segImageIds = activeSegmentation.representationData.Labelmap.imageIds;
              existing = true;
            }
          }

          let merged_derivedImages = [];
          let z_range = [];
          if (overlap) {
            let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
            console.log(
              `Just after createAndCacheDerivedLabelmapImages: ${(Date.now() - start) / 1000} Seconds`
            );
            let derivedImages = [];
            if (segImageIds.length > 0) {
              derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
            }
            if (flipped) {
              derivedImages_new.reverse();
            }
            console.log(`After reverse: ${(Date.now() - start) / 1000} Seconds`);
            for (let i = 0; i < derivedImages_new.length; i++) {
              const voxelManager = derivedImages_new[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              const scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(
                i * scalarData.length,
                (i + 1) * scalarData.length
              );
              if (sliceData.some(v => v === 1)) {
                // Write in-place to preserve the original buffer reference (brush compatibility)
                for (let j = 0; j < scalarData.length; j++) {
                  scalarData[j] = sliceData[j] === 1 ? segmentNumber : scalarData[j];
                }
                if (flipped) {
                  z_range.push(derivedImages_new.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
            console.log(`After slice assignment: ${(Date.now() - start) / 1000} Seconds`);

            let filteredDerivedImages = [];
            const imgLength = imageIds.length;
            let updatedIndices = new Set<number>();

            // In replace/refine mode, exclude previous derived images that contain segmentNumber
            // Each derivedImage is binary mask of a single slice ([0],[0,1],[0,2],[0,3].. etc)
            // derivedImages size is imgLength * the number of segment
            // We need to filter out the derivedImages block that contain segmentNumber (consists of [0] or [0, segmentNumber] masks)
            // If filter out which contains segmentNumber and all [0] masks, it can lead to incorrect calculation of the segment. e.g. bidirectional measurement
            if (shouldReplaceActiveSegment && derivedImages.length > 0) {
              let addFlag = true;
              for (let i = 0; i < derivedImages.length; i++) {
                const image = derivedImages[i];
                const voxelManager = image.voxelManager as csTypes.IVoxelManager<number>;
                const scalarData = voxelManager.getScalarData();
                if (scalarData.some(value => value === segmentNumber)) {
                  // Clear in-place to preserve buffer reference (brush compatibility)
                  for (let j = 0; j < scalarData.length; j++) {
                    if (scalarData[j] === segmentNumber) scalarData[j] = 0;
                  }
                  if (addFlag) {
                    for (let j = 0; j < imgLength; j++) {
                      updatedIndices.add(Math.floor(i / imgLength) * imgLength + j);
                    }
                    addFlag = false;
                  }
                }
              }
              for (let i = 0; i < derivedImages.length; i++) {
                if (!updatedIndices.has(i)) {
                  filteredDerivedImages.push(derivedImages[i]);
                }
              }
            } else if (derivedImages.length > 0) {
              filteredDerivedImages = derivedImages;
            }
            console.log(
              `After refinement & filteredDerivedImages: ${(Date.now() - start) / 1000} Seconds`
            );
            merged_derivedImages = [...filteredDerivedImages, ...derivedImages_new];
          } else {
            if (segImageIds.length == 0) {
              let derivedImages_new =
                await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);

              if (flipped) {
                derivedImages_new.reverse();
              }
              console.log(`After reverse: ${(Date.now() - start) / 1000} Seconds`);
              for (let i = 0; i < derivedImages_new.length; i++) {
                const voxelManager = derivedImages_new[i]
                  .voxelManager as csTypes.IVoxelManager<number>;
                const scalarData = voxelManager.getScalarData();
                const sliceData = new_arrayBuffer.slice(
                  i * scalarData.length,
                  (i + 1) * scalarData.length
                );
                if (sliceData.some(v => v === 1)) {
                  // Write in-place to preserve the original buffer reference (brush compatibility)
                  for (let j = 0; j < scalarData.length; j++) {
                    scalarData[j] = sliceData[j] === 1 ? segmentNumber : scalarData[j];
                  }
                  if (flipped) {
                    z_range.push(derivedImages_new.length - i - 1);
                  } else {
                    z_range.push(i);
                  }
                }
              }
              if (flipped) {
                derivedImages_new.reverse();
              }
              merged_derivedImages = derivedImages_new;
            } else {
              merged_derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
              if (flipped) {
                merged_derivedImages.reverse();
              }
              for (let i = 0; i < merged_derivedImages.length; i++) {
                const voxelManager = merged_derivedImages[i]
                  .voxelManager as csTypes.IVoxelManager<number>;
                const scalarData = voxelManager.getScalarData();
                const sliceData = new_arrayBuffer.slice(
                  i * scalarData.length,
                  (i + 1) * scalarData.length
                );
                if (shouldReplaceActiveSegment) {
                  if (scalarData.some(v => v === segmentNumber)) {
                    // Clear in-place to preserve buffer reference (brush compatibility)
                    for (let j = 0; j < scalarData.length; j++) {
                      if (scalarData[j] === segmentNumber) scalarData[j] = 0;
                    }
                  }
                }
                if (sliceData.some(v => v === 1)) {
                  // Write in-place to preserve buffer reference (brush compatibility)
                  for (let j = 0; j < scalarData.length; j++) {
                    if (sliceData[j] === 1) scalarData[j] = segmentNumber;
                  }
                  if (flipped) {
                    z_range.push(merged_derivedImages.length - i - 1);
                  } else {
                    z_range.push(i);
                  }
                }
              }
              if (flipped) {
                merged_derivedImages.reverse();
              }
            }
          }

          const derivedImageIds = merged_derivedImages.map(image => image.imageId);
          console.log(`Just after derivedImageIds: ${(Date.now() - start) / 1000} Seconds`);

          const prevSegment = segments[segmentNumber];
          const isRefine = !toolboxState.getRefineNew() && prevSegment;
          const preservedDraftOrigin = isRefine ? prevSegment.cachedStats?.draftOrigin : undefined;
          const baseLabel = isRefine ? prevSegment.label.replace(/ \(edited\)$/, '') : label_name;
          const preservedLabel =
            isRefine && preservedDraftOrigin ? baseLabel + ' (edited)' : baseLabel;

          segments[segmentNumber] = {
            segmentIndex: segmentNumber,
            label: preservedLabel,
            locked: false,
            active: false,
            cachedStats: {
              modifiedTime: utils.formatDate(Date.now(), 'YYYYMMDD'),

              algorithmType: currentDisplaySets.SeriesInstanceUID,
              algorithmName: selectedModel + '_' + sam_elapsed,
              description: prompt_info,
              center:
                z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0,
              flipped: flipped,
              isDirty: true,
              ...(preservedDraftOrigin ? { draftOrigin: preservedDraftOrigin } : {}),
            },
          };

          // Post-segmentation processing: update representations, handle viewports, trigger events
          await postSegmentationProcessing({
            activeViewportId,
            segmentationId,
            segmentNumber,
            segments,
            derivedImageIds,
            currentDisplaySets,
            imageIds,
            existingSegments,
            existing,
            activeSegmentation,
            currentImageIdIndex,
            z_range,
          });

          const end = Date.now();
          console.log(`Time taken: ${(end - start) / 1000} Seconds`);
          return summarizeHttpResponse(response);
        }
      } catch (error) {
        if (!responseMemoryOwner && (error as any)?.response) {
          responseMemoryOwner = niftiMemoryLedger.createOwner('monai-segmentation-error-response');
          niftiMemoryLedger.trackBuffer((error as any).response.data, {
            source: 'monai-segmentation-error-response',
            owner: responseMemoryOwner,
          });
        }
        console.error('Segmentation error:', summarizeHttpError(error));
        throw error;
      } finally {
        niftiMemoryLedger.releaseOwner(responseMemoryOwner);
      }
    },
    async initNninter(options: { viewportId: string } = { viewportId: undefined }) {
      let { activeViewportId, viewports } = viewportGridService.getState();
      if (options.viewportId !== undefined) {
        activeViewportId = options.viewportId;
      }
      const activeViewportSpecificData = viewports.get(activeViewportId);
      if (activeViewportSpecificData === undefined) {
        return;
      }
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      let currentDisplaySets;
      for (let i = 0; i < displaySets.length; i++) {
        if (displaySets[i].displaySetInstanceUID == displaySetInstanceUID) {
          currentDisplaySets = displaySets[i];
          break; // Exit early once found
        }
      }
      if (currentDisplaySets === undefined || currentDisplaySets.Modality === 'SEG') {
        return;
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'init',
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const initPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'NNInit',
        message: 'Initializing nninter...',
        type: 'info',
        promise: notificationSafeHttpPromise(initPromise),
        promiseMessages: {
          loading: 'Initializing nninter...',
          success: () => 'Init nninter - Successful',
          error: error => `Init nninter - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      let responseMemoryOwner: string | undefined;
      try {
        const response = await initPromise;
        responseMemoryOwner = niftiMemoryLedger.createOwner('nninter-init-response');
        niftiMemoryLedger.trackObject(response, {
          source: 'nninter-init-response-object',
          owner: responseMemoryOwner,
        });
        niftiMemoryLedger.trackBuffer(response.data, {
          source: 'nninter-init-response',
          owner: responseMemoryOwner,
        });
        if (response.status === 200) {
          return summarizeHttpResponse(response);
        }
      } catch (error) {
        console.error('Init nninter error:', summarizeHttpError(error));
        // Don't re-throw — this would trigger the React Error Boundary and crash the viewer
        return null;
      } finally {
        niftiMemoryLedger.releaseOwner(responseMemoryOwner);
      }
    },
    async resetNninter() {
      if (!toolboxState.getLocked()) nnEditor.reset();
    },
    async medGemma(query: string, instruction?: string, startSlice?: number, endSlice?: number) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'medGemma',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      // For medGemma, we expect a text/string response, not arraybuffer
      const medgemmaPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'Medgemma 1.5 4B',
        message: 'Processing medgemma request...',
        type: 'info',
        promise: medgemmaPromise,
        promiseMessages: {
          loading: 'Processing medgemma request...',
          success: () => 'Medgemma request - Successful',
          error: error => `Medgemma request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await medgemmaPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Medgemma error:', error);
        throw error;
      }
    },
    async nninter(input?: unknown, legacyOptions?: NnInteractiveOptions) {
      const { textPrompts } = normalizeNnInteractiveArgs(input, legacyOptions);
      if (textPrompts) {
        uiNotificationService.show({
          title: 'VoxTell', message: '稳定版 v1 暂不支持文本分割；画笔与 nnInteractive 可正常使用。',
          type: 'warning',
        });
        return;
      }
      if (toolboxState.getLocked()) return;
      return nnEditor.run();
    },

    async textPromptSegmentation() {
      if (toolboxState.getLocked()) {
        return;
      }

      const { uiDialogService } = servicesManager.services;

      try {
        // Open dialog to get text input
        const textInput = await callInputDialog({
          uiDialogService,
          defaultValue: '',
          title: 'Text Prompt Segmentation (VoxTell)',
          placeholder: 'Enter text prompt for segmentation',
          submitOnEnter: true,
        });

        // If user cancelled or entered empty text, return early
        if (!textInput || textInput.trim() === '') {
          return;
        }

        const mode = toolboxState.getTextPromptReplaceNew() ? 'append' : 'replace-active';

        // Call nninter with the text prompt.
        // Reference actions.nninter - this works because the function executes
        // after the actions object is fully created.
        return await actions.nninter(textInput.trim(), { mode });
      } catch (error) {
        // User cancelled the dialog - callInputDialog may throw or return empty string
        console.error('Text prompt segmentation error:', error);
        return;
      }
    },
    async testMedgemma(options?: {
      instruction?: string;
      query?: string;
      startSlice?: number | null;
      endSlice?: number | null;
    }) {
      const instruction = options?.instruction;
      const query = options?.query;
      const startSlice = options?.startSlice;
      const endSlice = options?.endSlice;
      const { uiDialogService } = servicesManager.services;

      try {
        // Get instruction if not provided
        let instructionText = instruction;
        if (!instructionText?.trim()) {
          instructionText =
            'You are an instructor teaching medical students. You are analyzing the following CT slices. Please review the slices provided below carefully.';
        }
        toolboxState.setMedgemmaInstruction(instructionText.trim());

        // Get query if not provided
        let queryText = query;
        if (!queryText) {
          queryText = await callInputDialog({
            uiDialogService,
            defaultValue: toolboxState.getMedgemmaQuery() || '',
            title: 'Medgemma 1.5B - Query',
            placeholder: 'Enter your query/question',
            submitOnEnter: true,
          });

          if (!queryText || queryText.trim() === '') {
            return; // User cancelled or empty
          }
          toolboxState.setMedgemmaQuery(queryText.trim());
        }

        // Store slice range in state
        if (startSlice !== undefined) {
          toolboxState.setMedgemmaStartSlice(startSlice);
        }
        if (endSlice !== undefined) {
          toolboxState.setMedgemmaEndSlice(endSlice);
        }

        // Clear previous result
        toolboxState.setMedgemmaResult(null);

        // Call medGemma with instruction, query, and slice range
        const response = await actions.medGemma(
          queryText.trim(),
          instructionText.trim(),
          startSlice ?? undefined,
          endSlice ?? undefined
        );

        // Extract response text from the response
        let responseText = '';
        if (response && response.data) {
          // Response is a string from the backend
          responseText = typeof response.data === 'string' ? response.data : String(response.data);
          // Store result in toolboxState for display in Toolbox
          toolboxState.setMedgemmaResult(responseText);
        } else {
          toolboxState.setMedgemmaResult('No response received');
        }
      } catch (error) {
        // User cancelled the dialog or API call failed
        console.error('Test Medgemma error:', error);
        toolboxState.setMedgemmaResult(
          `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        return;
      }
    },
    async listNiftiDrafts() {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return [];
      const { SeriesInstanceUID } = currentDisplaySets;
      try {
        const response = await axios.get(`/monai/nifti-segs/${SeriesInstanceUID}`);
        return response.data;
      } catch (error) {
        console.error('listNiftiDrafts error:', error);
        return [];
      }
    },

    async syncDraftToSession({ seriesUID, filename, studyInstanceUID }) {
      const formData = new FormData();
      formData.append('filename', filename);
      formData.append('image', seriesUID);
      formData.append('studyInstanceUID', studyInstanceUID || '');
      await axios.post(`/monai/nifti-segs/${seriesUID}/load-session`, formData);
    },

    async loadNiftiDraft({
      seriesUID,
      filename,
      studyInstanceUID,
      syncSession = false,
      preparedDraft,
      segmentationId = `${csUtils.uuidv4()}`,
    }: {
      seriesUID: string;
      filename: string;
      studyInstanceUID?: string;
      syncSession?: boolean;
      preparedDraft?: PreparedNiftiDraft;
      segmentationId?: string;
    }) {
      const start = Date.now();

      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      if (!activeViewportSpecificData) {
        return;
      }
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return;
      const prepared =
        preparedDraft ||
        (await prepareNiftiDraft({
          seriesUID,
          draft: { filename },
          imageIds: currentDisplaySets.imageIds,
        }));

      await materializePreparedNiftiDraft({
        prepared,
        segmentationId,
        activeViewportId,
        currentDisplaySets,
      });

      // Loading a draft only materializes browser pixels. AI binds lazily to
      // those pixels (including later brush edits), never to the disk snapshot.
      nnEditor.selectionChanged();

      console.log(`loadNiftiDraft completed in ${(Date.now() - start) / 1000}s`);
      return segmentationId;
    },

    async saveDraft() {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return;

      const activeSegmentation =
        servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId);
      const activeSegment =
        servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
      if (!activeSegmentation || !activeSegment) {
        uiNotificationService.show({
          title: 'Save Draft',
          message: 'No active segment to save',
          type: 'warning',
          duration: 3000,
        });
        return;
      }
      if (
        !segmentationReferencesCurrentSeries(
          activeSegmentation,
          currentDisplaySets.SeriesInstanceUID,
          currentDisplaySets.imageIds
        )
      ) {
        uiNotificationService.show({
          title: 'Save Draft',
          message: 'The active segmentation is not an editable NIfTI mask for this series',
          type: 'warning',
          duration: 3500,
        });
        return;
      }

      const flipped = activeSegment.cachedStats?.flipped ?? false;
      const label = activeSegment.label || 'unknown';
      const draftOrigin = activeSegment.cachedStats?.draftOrigin;
      const isNewDraft = !draftOrigin;

      const savePromise = isNewDraft
        ? saveNewMaskDraft({
            segmentationId: activeSegmentation.segmentationId,
            segmentIndex: activeSegment.segmentIndex,
            seriesUID: currentDisplaySets.SeriesInstanceUID,
            studyInstanceUID: currentDisplaySets.StudyInstanceUID,
            label,
            flipped,
            algorithm: algorithmFromSegment(activeSegment),
          })
        : autoSaveRefinedDraft({
            segmentationId: activeSegmentation.segmentationId,
            segmentIndex: activeSegment.segmentIndex,
            seriesUID: currentDisplaySets.SeriesInstanceUID,
            studyInstanceUID: currentDisplaySets.StudyInstanceUID,
            label,
            flipped,
            draftOrigin,
            allowEmpty: activeSegment.cachedStats?.isLabelOnlyDraft === true,
          });

      const loadingMessage = isNewDraft ? 'Saving new draft...' : 'Saving edited draft...';

      uiNotificationService.show({
        title: 'Save Draft',
        message: loadingMessage,
        type: 'info',
        promise: savePromise,
        promiseMessages: {
          loading: loadingMessage,
          success: () => 'Draft saved successfully',
          error: error => `Failed to save draft: ${backendErrorMessage(error)}`,
        },
      });

      const saved = await savePromise;
      activeSegment.cachedStats = {
        ...(activeSegment.cachedStats || {}),
        sourceType: 'nifti-draft',
        seriesInstanceUID: currentDisplaySets.SeriesInstanceUID,
        ...(isNewDraft && saved.filename ? { draftOrigin: saved.filename } : {}),
        savedMaskHash: saved.maskHash,
        savedLabel: label,
        isLabelOnlyDraft: saved.isLabelOnlyDraft,
        nonZeroVoxels: saved.nonZeroVoxels,
        isDirty: false,
        ...(saved.filename ? { currentDraftFilename: saved.filename } : {}),
      };
    },

    async showDraftsList() {
      const drafts = (await actions.listNiftiDrafts()) as NiftiDraft[];
      if (!drafts || drafts.length === 0) {
        uiNotificationService.show({
          title: 'NIfTI Drafts',
          message: 'No drafts for this series',
          type: 'info',
          duration: 3000,
        });
        return;
      }

      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return;
      const { SeriesInstanceUID, StudyInstanceUID } = currentDisplaySets;
      const { uiDialogService } = servicesManager.services;

      // Filter out multi-segment "edited_seg" snapshots — they duplicate individual drafts
      const activeDrafts = drafts.filter(d => d.source !== 'ohif_save_nifti');
      const displayDrafts = canonicalDraftsForLoad(activeDrafts.length > 0 ? activeDrafts : drafts);
      if (displayDrafts.length === 0) {
        uiNotificationService.show({
          title: 'NIfTI Drafts',
          message: 'No valid drafts for this series',
          type: 'warning',
          duration: 3000,
        });
        return;
      }
      const segmentationService = servicesManager.services.segmentationService;

      const setDraftColor = (segmentationId: string, colorOrder: number) => {
        const colorIndex = (colorOrder % (csToolsConstants.COLOR_LUT.length - 1)) + 1;
        const color = csToolsConstants.COLOR_LUT[colorIndex];
        segmentationService.setSegmentColor(activeViewportId, segmentationId, 1, [
          ...color,
        ] as csTypes.Color);
      };

      const setDraftVisibility = (segmentationId: string, visible: boolean) => {
        const viewportIds =
          segmentationService.getViewportIdsWithSegmentation(segmentationId) || [];
        for (const viewportId of viewportIds) {
          csToolsSegmentation.config.visibility.setSegmentationRepresentationVisibility(
            viewportId,
            { segmentationId, type: LABELMAP },
            visible
          );
        }
      };

      const activateAndSyncDraft = async (segmentationId: string, draft: NiftiDraft) => {
        segmentationService.setRenderInactiveSegmentations(activeViewportId, true);
        segmentationService.setActiveSegmentation(activeViewportId, segmentationId);
        segmentationService.setActiveSegment(segmentationId, 1);
        const segmentation = segmentationService.getSegmentation(segmentationId);
        if (segmentation) {
          forceLabelmapDisplayVisible(
            activeViewportId,
            segmentationId,
            segmentation.segments || {}
          );
        }
        nnEditor.selectionChanged();
      };

      const loadSingleDraft = async (selectedDraft: NiftiDraft, colorOrder: number) => {
        const masks = await collectCurrentSeriesNiftiMasks({
          seriesUID: SeriesInstanceUID,
          imageIds: currentDisplaySets.imageIds,
        });
        const root = draftFamilyRoot(selectedDraft);
        const lineageMasks = masks.filter(mask => mask.draftRoot === root);
        const dirtyLineageMasks = lineageMasks.filter(mask => mask.dirtyReasons.length > 0);
        if (dirtyLineageMasks.length > 0) {
          const confirmed = await confirmLoadDraftDiscard({
            uiDialogService,
            items: draftConflictItems(dirtyLineageMasks),
          });
          if (!confirmed) {
            uiNotificationService.show({
              title: 'NIfTI Drafts',
              message: 'Load cancelled; existing masks were not changed',
              type: 'info',
              duration: 3000,
            });
            return;
          }
        }

        const exactCleanMask =
          dirtyLineageMasks.length === 0
            ? lineageMasks.find(
                mask =>
                  mask.standalone &&
                  mask.currentDraftFilename === selectedDraft.filename &&
                  mask.dirtyReasons.length === 0
              )
            : undefined;

        if (exactCleanMask) {
          for (const segmentationId of new Set(
            lineageMasks
              .filter(mask => mask.segmentationId !== exactCleanMask.segmentationId)
              .map(mask => mask.segmentationId)
          )) {
            removeSegmentationFromAllViewports(segmentationId);
          }
          setDraftColor(exactCleanMask.segmentationId, colorOrder);
          await activateAndSyncDraft(exactCleanMask.segmentationId, selectedDraft);
          uiNotificationService.show({
            title: 'NIfTI Drafts',
            message: `${selectedDraft.label || selectedDraft.filename} is already loaded`,
            type: 'info',
            duration: 2500,
          });
          return;
        }

        let prepared: PreparedNiftiDraft;
        try {
          prepared = await prepareNiftiDraft({
            seriesUID: SeriesInstanceUID,
            draft: selectedDraft,
            imageIds: currentDisplaySets.imageIds,
          });
        } catch (error) {
          uiNotificationService.show({
            title: 'NIfTI Drafts',
            message: `Failed to prepare ${selectedDraft.label || selectedDraft.filename}: ${(error as Error).message}`,
            type: 'error',
            duration: 5000,
          });
          return;
        }

        const newSegmentationId = `${csUtils.uuidv4()}`;
        try {
          await materializePreparedNiftiDraft({
            prepared,
            segmentationId: newSegmentationId,
            activeViewportId,
            currentDisplaySets,
          });
        } catch (error) {
          if (segmentationService.getSegmentation(newSegmentationId)) {
            removeSegmentationFromAllViewports(newSegmentationId);
          }
          uiNotificationService.show({
            title: 'NIfTI Drafts',
            message: `Failed to load ${selectedDraft.label || selectedDraft.filename}: ${(error as Error).message}`,
            type: 'error',
            duration: 5000,
          });
          return;
        }

        for (const segmentationId of new Set(lineageMasks.map(mask => mask.segmentationId))) {
          removeSegmentationFromAllViewports(segmentationId);
        }
        setDraftColor(newSegmentationId, colorOrder);
        await activateAndSyncDraft(newSegmentationId, selectedDraft);
        uiNotificationService.show({
          title: 'NIfTI Drafts',
          message: `Loaded ${selectedDraft.label || selectedDraft.filename}`,
          type: 'success',
          duration: 3000,
        });
      };

      const loadAllDrafts = async () => {
        logNiftiDraftMemory('before prepare');
        const masks = await collectCurrentSeriesNiftiMasks({
          seriesUID: SeriesInstanceUID,
          imageIds: currentDisplaySets.imageIds,
        });
        const conflicts = draftConflictItems(masks);
        if (conflicts.length > 0) {
          const confirmed = await confirmLoadDraftDiscard({
            uiDialogService,
            items: conflicts,
          });
          if (!confirmed) {
            uiNotificationService.show({
              title: 'NIfTI Drafts',
              message: 'Load cancelled; existing masks were not changed',
              type: 'info',
              duration: 3000,
            });
            return;
          }
        }

        const reconcilePlan = buildDraftReconcilePlan(displayDrafts, masks);
        const previousActive = segmentationService.getActiveSegmentation(activeViewportId);
        const previousActiveMask = masks.find(
          mask => mask.segmentationId === previousActive?.segmentationId
        );
        const previousRenderInactive =
          segmentationService.getRenderInactiveSegmentations(activeViewportId);
        const stagedDrafts: StagedNiftiDraft[] = [];
        const stagedByRoot = new Map<string, string>();

        try {
          for (let index = 0; index < reconcilePlan.load.length; index++) {
            const draft = reconcilePlan.load[index];
            const prepared = await prepareNiftiDraft({
              seriesUID: SeriesInstanceUID,
              draft,
              imageIds: currentDisplaySets.imageIds,
            });
            const staged = await stagePreparedNiftiDraft({
              prepared,
              segmentationId: `${csUtils.uuidv4()}`,
              currentDisplaySets,
            });
            stagedDrafts.push(staged);
            stagedByRoot.set(draftFamilyRoot(draft), staged.segmentationId);
            logNiftiDraftMemory(`after stage ${index + 1}/${reconcilePlan.load.length}`);
          }
        } catch (error) {
          for (const staged of stagedDrafts) {
            releaseNiftiDraftResources(staged);
          }
          logNiftiDraftMemory('after stage failure cleanup');
          uiNotificationService.show({
            title: 'NIfTI Drafts',
            message: `Load All stopped before changing the workspace: ${(error as Error).message}`,
            type: 'error',
            duration: 6000,
          });
          return;
        }

        logNiftiDraftMemory('before commit');
        try {
          await registerStagedNiftiDrafts({
            stagedDrafts,
            activeViewportId,
          });
        } catch (error) {
          if (
            previousActive &&
            segmentationService.getSegmentation(previousActive.segmentationId)
          ) {
            segmentationService.setActiveSegmentation(
              activeViewportId,
              previousActive.segmentationId
            );
          }
          segmentationService.setRenderInactiveSegmentations(
            activeViewportId,
            previousRenderInactive
          );
          logNiftiDraftMemory('after commit rollback');
          uiNotificationService.show({
            title: 'NIfTI Drafts',
            message: `Load All failed; the previous workspace was restored: ${(error as Error).message}`,
            type: 'error',
            duration: 6000,
          });
          return;
        }

        const finalByRoot = new Map<string, string>();
        for (const item of reconcilePlan.keep) {
          finalByRoot.set(draftFamilyRoot(item.draft), item.mask.segmentationId);
        }
        for (const [root, segmentationId] of stagedByRoot) {
          finalByRoot.set(root, segmentationId);
        }

        for (const segmentationId of reconcilePlan.removeSegmentationIds) {
          removeSegmentationFromAllViewports(segmentationId);
        }

        displayDrafts.forEach((draft, index) => {
          const segmentationId = finalByRoot.get(draftFamilyRoot(draft));
          if (!segmentationId) {
            return;
          }
          setDraftColor(segmentationId, index);
          setDraftVisibility(segmentationId, true);
          const segmentation = segmentationService.getSegmentation(segmentationId);
          if (segmentation) {
            forceLabelmapDisplayVisible(
              activeViewportId,
              segmentationId,
              segmentation.segments || {}
            );
          }
        });
        segmentationService.setRenderInactiveSegmentations(activeViewportId, true);

        const activeDraft =
          displayDrafts.find(draft => draftFamilyRoot(draft) === previousActiveMask?.draftRoot) ||
          displayDrafts[0];
        const activeSegmentationId = activeDraft
          ? finalByRoot.get(draftFamilyRoot(activeDraft))
          : undefined;
        if (activeDraft && activeSegmentationId) {
          await activateAndSyncDraft(activeSegmentationId, activeDraft);
        }

        for (const viewportId of servicesManager.services.cornerstoneViewportService.getViewportIds()) {
          servicesManager.services.cornerstoneViewportService
            .getCornerstoneViewport(viewportId)
            ?.render();
        }
        logNiftiDraftMemory('after commit/cleanup');

        const labelOnlyCount = displayDrafts.reduce((count, draft) => {
          const segmentationId = finalByRoot.get(draftFamilyRoot(draft));
          const segment = segmentationId
            ? visibleSegments(segmentationService.getSegmentation(segmentationId))[0]
            : undefined;
          return count + (segment?.cachedStats?.isLabelOnlyDraft === true ? 1 : 0);
        }, 0);
        const labelOnlySuffix = labelOnlyCount > 0 ? ` (${labelOnlyCount} label-only)` : '';
        uiNotificationService.show({
          title: 'NIfTI Drafts',
          message: `Workspace synchronized with ${displayDrafts.length} draft(s)${labelOnlySuffix}`,
          type: 'success',
          duration: 3000,
        });
      };

      if (displayDrafts.length === 1) {
        await loadSingleDraft(displayDrafts[0], 0);
        return;
      }

      // Multiple drafts: show numbered list with "all" option
      const draftList = displayDrafts
        .map((d, i) => {
          const edited = d.origin ? ' [edited]' : '';
          return `${i + 1}. ${(d.label || '').replace(/\n/g, ' | ')} (${String(d.algorithm || '')})${edited} - ${d.created || ''}`;
        })
        .join('\n');
      const selection = await callInputDialog({
        uiDialogService,
        defaultValue: 'all',
        title: `Select Draft (${displayDrafts.length} available):\n${draftList}`,
        placeholder: 'Enter number or "all"',
        submitOnEnter: true,
      });

      if (!selection || selection.trim() === '') return;
      const trimmed = selection.trim().toLowerCase();

      if (trimmed === 'all') {
        await loadAllDrafts();
        return;
      }

      const idx = parseInt(trimmed, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= displayDrafts.length) {
        uiNotificationService.show({
          title: 'NIfTI Drafts',
          message: `Invalid selection: ${selection}`,
          type: 'warning',
          duration: 3000,
        });
        return;
      }

      const selectedDraft = displayDrafts[idx];
      await loadSingleDraft(selectedDraft, idx);
    },

    async saveToPACS() {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return;
      if (currentDisplaySets.sourceType === 'nifti') {
        uiNotificationService.show({ title: 'NIfTI', message: '原生 NIfTI 请使用 NIfTI 面板导出；此原图不支持 PACS 保存。', type: 'info' });
        return;
      }

      const { SeriesInstanceUID, StudyInstanceUID } = currentDisplaySets;

      // Find nnInteractive segmentation: search all viewport representations for segments
      // whose algorithmType matches the CT SeriesInstanceUID. Fall back to active segmentation.
      let saveSegmentation: any = null;
      const allSegmentations = servicesManager.services.segmentationService.getSegmentations();
      for (const seg of allSegmentations) {
        const hasNninter = Object.values(seg.segments || {}).some(
          (s: any) => s?.cachedStats?.algorithmType === SeriesInstanceUID
        );
        if (hasNninter) {
          saveSegmentation = seg;
          break;
        }
      }
      if (!saveSegmentation) {
        saveSegmentation =
          servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId);
      }
      if (!saveSegmentation) {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'No segmentation to save',
          type: 'warning',
        });
        return;
      }

      // Get labelmap image IDs from Cornerstone3D state
      const csSeg = csToolsSegmentation.state.getSegmentation(saveSegmentation.segmentationId);
      const labelmapImageIds = (csSeg?.representationData?.[LABELMAP] as any)?.imageIds;
      if (!labelmapImageIds?.length) {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'No labelmap data found',
          type: 'warning',
        });
        return;
      }

      // Read all slices from cornerstone image cache
      // Each slice is a Uint8Array where value = segment index (0=bg, 1=seg1, 2=seg2, ...)
      const sourceSops: string[] = [];
      const slices: ArrayLike<number>[] = (labelmapImageIds as string[])
        .map(id => {
          const img = cache.getImage(id);
          if (!img) return null;
          const reference = metaData.get('sopCommonModule', img.referencedImageId);
          sourceSops.push(reference?.sopInstanceUID);
          const vm = img.voxelManager as csTypes.IVoxelManager<number>;
          return vm.getScalarData();
        })
        .filter(Boolean) as ArrayLike<number>[];

      if (slices.length !== labelmapImageIds.length || sourceSops.some(uid => !uid)
        || new Set(sourceSops).size !== sourceSops.length) {
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Labelmap slices or source SOP references are incomplete. Reload the source before saving.',
          type: 'warning',
        });
        return;
      }

      // The server maps each frame by SOP identity to its DICOM geometry order.
      // Manual masks have no AI flipped flag, and must follow the same rule.

      // Concatenate slices → flat labelmap buffer (Z * rows * cols)
      const sliceLen = slices[0].length;

      // Collect segment metadata for backend DICOM-SEG attribute creation
      const segmentsMeta = Object.values(saveSegmentation.segments || {})
        .filter((s: any) => s && s.segmentIndex > 0)
        .map((s: any) => ({
          segmentIndex: s.segmentIndex,
          label: s.label || `segment_${s.segmentIndex}`,
          algorithmName: s.cachedStats?.algorithmName || 'nninter_0.0',
          description: s.cachedStats?.description || '',
        }));
      const maxSegmentIndex = segmentsMeta.reduce(
        (max: number, s: any) => Math.max(max, s.segmentIndex || 0),
        0
      );
      const labelmapDtype = maxSegmentIndex > 255 ? 'uint16' : 'uint8';

      // POST: params JSON + binary labelmap as multipart form
      const params = {
        studyInstanceUID: StudyInstanceUID,
        labelmap_sop_instance_uids: sourceSops,
        segments: JSON.stringify(segmentsMeta),
        segmentationLabel: saveSegmentation.label || '',
        labelmap_dtype: labelmapDtype,
      };
      const formData = new FormData();
      formData.append('params', JSON.stringify(params));
      if (labelmapDtype === 'uint16') {
        const labelmapBuffer16 = new Uint16Array(slices.length * sliceLen);
        slices.forEach((s, i) => {
          for (let j = 0; j < sliceLen; j++) {
            labelmapBuffer16[i * sliceLen + j] = s[j] || 0;
          }
        });
        formData.append(
          'labelmap',
          new Blob([labelmapBuffer16], { type: 'application/octet-stream' })
        );
      } else {
        const labelmapBuffer = new Uint8Array(slices.length * sliceLen);
        slices.forEach((s, i) => labelmapBuffer.set(s, i * sliceLen));
        formData.append(
          'labelmap',
          new Blob([labelmapBuffer], { type: 'application/octet-stream' })
        );
      }

      const url = `/monai/infer/save/segmentation?image=${SeriesInstanceUID}`;
      const savePromise = axios.post(url, formData, { headers: { accept: 'application/json' } });

      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Saving segmentation to PACS...',
        type: 'info',
        promise: savePromise,
        promiseMessages: {
          loading: 'Saving to PACS...',
          success: () => 'Saved to PACS — refresh study list to see new SEG series',
          error: (e: Error) => `Save failed: ${e.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await savePromise;
        if (response.status === 200) console.log('Saved to PACS:', response.data);
      } catch (error) {
        console.error('Save to PACS error:', error);
      }
    },
    async saveToNifti() {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      if (!activeViewportSpecificData) {
        return;
      }
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID === displaySetInstanceUIDs[0]
      )[0];
      if (!currentDisplaySets) return;

      const { SeriesInstanceUID, StudyInstanceUID } = currentDisplaySets;
      const allSegmentations = servicesManager.services.segmentationService.getSegmentations();
      const currentSeriesSegmentations = allSegmentations.filter(segmentation =>
        segmentationReferencesCurrentSeries(
          segmentation,
          SeriesInstanceUID,
          currentDisplaySets.imageIds
        )
      );
      if (currentSeriesSegmentations.length === 0) {
        uiNotificationService.show({
          title: 'Save All',
          message: 'No segmentation found',
          type: 'warning',
        });
        return;
      }

      type SaveMaskTask = {
        label: string;
        kind: 'new' | 'refined';
        run: () => Promise<void>;
      };
      const tasks: SaveMaskTask[] = [];
      let unmodifiedCount = 0;

      for (const segmentation of currentSeriesSegmentations) {
        for (const segment of visibleSegments(segmentation)) {
          const stats = segment.cachedStats || {};
          const label = segment.label || `segment ${segment.segmentIndex}`;
          const draftOrigin = stats.draftOrigin || stats.currentDraftFilename;
          const flipped = stats.flipped ?? false;
          let currentMaskHash: string | undefined;
          let currentNonZeroVoxels: number | undefined;
          let extractionError: Error | undefined;
          try {
            const extracted = await inspectSegmentBinaryMask({
              segmentationId: segmentation.segmentationId,
              segmentIndex: segment.segmentIndex,
              flipped,
              includeBuffer: false,
              allowEmpty: true,
            });
            currentMaskHash = extracted.maskHash;
            currentNonZeroVoxels = extracted.nonZeroVoxels;
          } catch (error) {
            extractionError = error as Error;
          }

          const savedMaskHash = stats.savedMaskHash || stats.loadedMaskHash;
          const maskChanged =
            !savedMaskHash || (!!currentMaskHash && currentMaskHash !== savedMaskHash);
          const labelChanged =
            stats.savedLabel !== undefined
              ? label !== stats.savedLabel
              : typeof label === 'string' && label.endsWith(' (edited)');
          const needsSave =
            !draftOrigin ||
            stats.isDirty === true ||
            maskChanged ||
            labelChanged ||
            !!extractionError;

          if (!needsSave) {
            unmodifiedCount++;
            continue;
          }

          tasks.push({
            label,
            kind: draftOrigin ? 'refined' : 'new',
            run: async () => {
              if (extractionError) {
                throw extractionError;
              }

              const saved = draftOrigin
                ? await autoSaveRefinedDraft({
                    segmentationId: segmentation.segmentationId,
                    segmentIndex: segment.segmentIndex,
                    seriesUID: SeriesInstanceUID,
                    studyInstanceUID: StudyInstanceUID,
                    label,
                    flipped,
                    draftOrigin,
                    allowEmpty: stats.isLabelOnlyDraft === true && currentNonZeroVoxels === 0,
                  })
                : await saveNewMaskDraft({
                    segmentationId: segmentation.segmentationId,
                    segmentIndex: segment.segmentIndex,
                    seriesUID: SeriesInstanceUID,
                    studyInstanceUID: StudyInstanceUID,
                    label,
                    flipped,
                    algorithm: algorithmFromSegment(segment),
                  });

              segment.cachedStats = {
                ...stats,
                sourceType: 'nifti-draft',
                seriesInstanceUID: SeriesInstanceUID,
                draftOrigin: draftOrigin || saved.filename,
                currentDraftFilename: saved.filename || stats.currentDraftFilename,
                savedMaskHash: saved.maskHash,
                savedLabel: label,
                isLabelOnlyDraft: saved.isLabelOnlyDraft,
                nonZeroVoxels: saved.nonZeroVoxels,
                isDirty: false,
              };
            },
          });
        }
      }

      if (tasks.length === 0) {
        uiNotificationService.show({
          title: 'Save All',
          message: `${unmodifiedCount} loaded draft(s) unmodified — nothing to save`,
          type: 'info',
        });
        return;
      }

      uiNotificationService.show({
        title: 'Save All',
        message: `Saving ${tasks.length} modified mask(s)...`,
        type: 'info',
        duration: 2500,
      });

      // Keep allSettled reporting semantics without retaining one dense upload buffer per mask.
      // Each task begins only after the previous upload has either succeeded or failed.
      let saveQueue: Promise<unknown> = Promise.resolve();
      const queuedTaskPromises = tasks.map(task => {
        const taskPromise = saveQueue.then(() => task.run());
        saveQueue = taskPromise.catch(() => undefined);
        return taskPromise;
      });
      const results = await Promise.allSettled(queuedTaskPromises);
      const succeeded = results.filter(result => result.status === 'fulfilled').length;
      const failures = results
        .map((result, index) => ({ result, task: tasks[index] }))
        .filter(item => item.result.status === 'rejected');

      if (failures.length === 0) {
        const newCount = tasks.filter(task => task.kind === 'new').length;
        const refinedCount = tasks.length - newCount;
        uiNotificationService.show({
          title: 'Save All',
          message: `Saved ${succeeded} mask(s): ${newCount} new, ${refinedCount} refined; ${unmodifiedCount} unchanged skipped`,
          type: 'success',
          duration: 4000,
        });
        return;
      }

      const failedNames = failures.map(item => item.task.label).join(', ');
      uiNotificationService.show({
        title: 'Save All',
        message: `Saved ${succeeded}/${tasks.length}. Failed: ${failedNames}. ${backendErrorMessage((failures[0].result as PromiseRejectedResult).reason)}`,
        type: 'warning',
        duration: 7000,
      });
    },
    jumpToSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        const activeSegment = segmentationService.getActiveSegment(activeViewportId);
        const segmentIndex = activeSegment?.segmentIndex ?? 1;
        segmentationService.jumpToSegmentCenter(
          activeSegmentation.segmentationId,
          segmentIndex,
          activeViewportId
        );
      }
    },
    toggleCurrentSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        segmentationService.toggleSegmentationRepresentationVisibility(activeViewportId, {
          segmentationId: activeSegmentation.segmentationId,
          type: csToolsEnums.SegmentationRepresentations.Labelmap,
        });
      }
    },

    /**
     * Toggle viewport overlay (the information panel shown on the four corners
     * of the viewport)
     * @see ViewportOverlay and CustomizableViewportOverlay components
     */
    toggleOverlays: () => {
      const overlays = document.getElementsByClassName('viewport-overlay');
      for (let i = 0; i < overlays.length; i++) {
        overlays.item(i).classList.toggle('hidden');
      }
    },

    scrollActiveThumbnailIntoView: () => {
      const { activeViewportId, viewports } = viewportGridService.getState();

      const activeViewport = viewports.get(activeViewportId);
      const activeDisplaySetInstanceUID = activeViewport.displaySetInstanceUIDs[0];

      const thumbnailList = document.querySelector('#ohif-thumbnail-list');

      if (!thumbnailList) {
        return;
      }

      const thumbnailListBounds = thumbnailList.getBoundingClientRect();

      const thumbnail = document.querySelector(`#thumbnail-${activeDisplaySetInstanceUID}`);

      if (!thumbnail) {
        return;
      }

      const thumbnailBounds = thumbnail.getBoundingClientRect();

      // This only handles a vertical thumbnail list.
      if (
        thumbnailBounds.top >= thumbnailListBounds.top &&
        thumbnailBounds.top <= thumbnailListBounds.bottom
      ) {
        return;
      }

      thumbnail.scrollIntoView({ behavior: 'smooth' });
    },

    updateViewportDisplaySet: ({
      direction,
      excludeNonImageModalities,
    }: UpdateViewportDisplaySetParams) => {
      const nonImageModalities = ['SR', 'SEG', 'SM', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'];

      const currentDisplaySets = [...displaySetService.activeDisplaySets];

      const { activeViewportId, viewports, isHangingProtocolLayout } =
        viewportGridService.getState();

      const { displaySetInstanceUIDs } = viewports.get(activeViewportId);

      const activeDisplaySetIndex = currentDisplaySets.findIndex(displaySet =>
        displaySetInstanceUIDs.includes(displaySet.displaySetInstanceUID)
      );

      let displaySetIndexToShow: number;

      for (
        displaySetIndexToShow = activeDisplaySetIndex + direction;
        displaySetIndexToShow > -1 && displaySetIndexToShow < currentDisplaySets.length;
        displaySetIndexToShow += direction
      ) {
        if (
          !excludeNonImageModalities ||
          !nonImageModalities.includes(currentDisplaySets[displaySetIndexToShow].Modality)
        ) {
          break;
        }
      }

      if (displaySetIndexToShow < 0 || displaySetIndexToShow >= currentDisplaySets.length) {
        return;
      }

      const { displaySetInstanceUID } = currentDisplaySets[displaySetIndexToShow];

      let updatedViewports = [];

      try {
        updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
          activeViewportId,
          displaySetInstanceUID,
          isHangingProtocolLayout
        );
      } catch (error) {
        console.warn(error);
        uiNotificationService.show({
          title: 'Navigate Viewport Display Set',
          message:
            'The requested display sets could not be added to the viewport due to a mismatch in the Hanging Protocol rules.',
          type: 'info',
          duration: 3000,
        });
      }

      commandsManager.run('setDisplaySetsForViewports', { viewportsToUpdate: updatedViewports });

      setTimeout(() => actions.scrollActiveThumbnailIntoView(), 0);
    },
  };

  const definitions = {
    multimonitor: actions.multimonitor,
    promptSaveReport: actions.promptSaveReport,
    loadStudy: actions.loadStudy,
    showContextMenu: actions.showContextMenu,
    closeContextMenu: actions.closeContextMenu,
    clearMeasurements: actions.clearMeasurements,
    displayNotification: actions.displayNotification,
    setHangingProtocol: actions.setHangingProtocol,
    toggleHangingProtocol: actions.toggleHangingProtocol,
    navigateHistory: actions.navigateHistory,
    nextStage: {
      commandFn: actions.deltaStage,
      options: { direction: 1 },
    },
    previousStage: {
      commandFn: actions.deltaStage,
      options: { direction: -1 },
    },
    setViewportGridLayout: actions.setViewportGridLayout,
    toggleOneUp: actions.toggleOneUp,
    openDICOMTagViewer: actions.openDICOMTagViewer,
    setAiToolActive: actions.setAiToolActive,
    runAiSegmentation: actions.runAiSegmentation,
    sam2: actions.sam2,
    initNninter: actions.initNninter,
    resetNninter: actions.resetNninter,
    medGemma: actions.medGemma,
    nninter: actions.nninter,
    saveToPACS: actions.saveToPACS,
    saveToNifti: actions.saveToNifti,
    loadNiftiDraft: actions.loadNiftiDraft,
    listNiftiDrafts: actions.listNiftiDrafts,
    syncDraftToSession: actions.syncDraftToSession,
    showDraftsList: actions.showDraftsList,
    saveDraft: actions.saveDraft,
    textPromptSegmentation: actions.textPromptSegmentation,
    testMedgemma: actions.testMedgemma,
    jumpToSegment: actions.jumpToSegment,
    toggleCurrentSegment: actions.toggleCurrentSegment,
    updateViewportDisplaySet: actions.updateViewportDisplaySet,
  };

  return {
    actions,
    definitions,
    defaultContext: 'DEFAULT',
  };
};

export default commandsModule;

