import { cache, utilities as csUtils, VolumeViewport, getEnabledElementByViewportId } from '@cornerstonejs/core';
import { SegmentationRepresentations } from '../../../enums';
import { getLabelmapActorEntries } from '../../../stateManagement/segmentation/helpers/getSegmentationActor';
import { getSegmentationRepresentations } from '../../../stateManagement/segmentation/getSegmentationRepresentation';
import { getCurrentLabelmapImageIdsForViewport } from '../../../stateManagement/segmentation/getCurrentLabelmapImageIdForViewport';

// OHIF 3.33.5 patch: stable actors must be matched by image identity, not index.
export function performStackLabelmapUpdate({ viewportIds, segmentationId }) {
  for (const viewportId of viewportIds) {
    const viewport = getEnabledElementByViewportId(viewportId)?.viewport;
    if (!viewport || viewport instanceof VolumeViewport) continue;
    const representations = getSegmentationRepresentations(viewportId, { segmentationId });
    if (!representations.some(r => r.segmentationId === segmentationId && r.type === SegmentationRepresentations.Labelmap)) continue;
    const currentIds = new Set(getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId) || []);
    for (const actorEntry of getLabelmapActorEntries(viewportId, segmentationId) || []) {
      // A scroll/target change can leave a stale actor until IMAGE_RENDERED.
      // Never update it with another target's slice or call cache with undefined.
      if (!currentIds.has(actorEntry.referencedId)) continue;
      const image = cache.getImage(actorEntry.referencedId);
      const imageData = actorEntry.actor?.getMapper?.()?.getInputData?.();
      if (!image || !imageData) continue;
      imageData.modified();
      csUtils.updateVTKImageDataWithCornerstoneImage(imageData, image);
    }
  }
}
