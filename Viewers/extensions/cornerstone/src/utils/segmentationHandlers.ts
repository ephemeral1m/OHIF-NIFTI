import * as cornerstoneTools from '@cornerstonejs/tools';
import { updateSegmentationStats } from './updateSegmentationStats';

/**
 * Sets up the handler for segmentation data modification events
 */
export function setupSegmentationDataModifiedHandler({
  segmentationService,
  customizationService,
  commandsManager,
}) {
  const { unsubscribe } = segmentationService.subscribeDebounced(
    segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
    async ({ segmentationId }) => {
      try {
        const segmentation = segmentationService.getSegmentation(segmentationId);

        if (!segmentation) {
          return;
        }

        const readableText = customizationService.getCustomization('panelSegmentation.readableText');

        // Check for segments with bidirectional measurements and update them
        const segmentIndices = Object.keys(segmentation.segments)
          .map(index => parseInt(index))
          .filter(index => index > 0);

        for (const segmentIndex of segmentIndices) {
          const segment = segmentation.segments[segmentIndex];
          if (segment?.cachedStats?.namedStats?.bidirectional) {
            try {
              commandsManager.runCommand('runSegmentBidirectional', {
                segmentationId,
                segmentIndex,
              });
            } catch (e) {
              console.warn('runSegmentBidirectional failed for segment', segmentIndex, e);
            }
          }
        }

        // Skip expensive full-volume stats recomputation if all segments already have
        // cached stats (e.g. from nninter/draft loading pipeline). getStatistics() scans
        // every voxel across all segments — for a 512×512×300 volume that's ~78M voxels
        // per segment, blocking the main thread and causing visible brush lag.
        const segmentsNeedingStats = segmentIndices.filter(index => {
          const segment = segmentation.segments[index];
          return !segment?.cachedStats?.namedStats || Object.keys(segment.cachedStats.namedStats).length === 0;
        });

        if (segmentsNeedingStats.length === 0) {
          return;
        }

        const updatedSegmentation = await updateSegmentationStats({
          segmentation,
          segmentationId,
          readableText,
        });

        if (updatedSegmentation) {
          segmentationService.addOrUpdateSegmentation({
            segmentationId,
            segments: updatedSegmentation.segments,
          });
        }
      } catch (e) {
        console.warn('SEGMENTATION_DATA_MODIFIED handler error:', e);
      }
    },
    1000
  );

  return { unsubscribe };
}

/**
 * Sets up the handler for segmentation modification events
 */
export function setupSegmentationModifiedHandler({ segmentationService }) {
  const { unsubscribe } = segmentationService.subscribe(
    segmentationService.EVENTS.SEGMENTATION_MODIFIED,
    async ({ segmentationId }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        return;
      }

      const annotationState = cornerstoneTools.annotation.state.getAllAnnotations();
      const bidirectionalAnnotations = annotationState.filter(
        annotation =>
          annotation.metadata.toolName === cornerstoneTools.SegmentBidirectionalTool.toolName
      );

      let toRemoveUIDs = [];
      if (!segmentation) {
        toRemoveUIDs = bidirectionalAnnotations.map(
          annotation => annotation.metadata.segmentationId === segmentationId
        );
        return;
      } else {
        const segmentIndices = Object.keys(segmentation.segments)
          .map(index => parseInt(index))
          .filter(index => index > 0);

        // check if there is a bidirectional data that exists but the segment
        // does not exists anymore we need to remove the bidirectional data
        const bidirectionalAnnotationsToRemove = bidirectionalAnnotations.filter(
          annotation =>
            annotation.metadata.segmentationId === segmentationId &&
            !segmentIndices.includes(annotation.metadata.segmentIndex)
        );

        toRemoveUIDs = bidirectionalAnnotationsToRemove.map(annotation => annotation.annotationUID);
      }

      toRemoveUIDs.forEach(uid => {
        cornerstoneTools.annotation.state.removeAnnotation(uid);
      });
    }
  );

  return { unsubscribe };
}
