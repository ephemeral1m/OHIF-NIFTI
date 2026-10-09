import { DicomMetadataStore, IWebApiDataSource, classes } from '@ohif/core';
import { sources, INTERNAL_CLASS, NIFTI_HANDLER } from './sourceStore';
import { requestComplete } from './streaming';

let source;
export function activateNativeSource(next) { source = next; }
export function createDataSource(commandsManager) {
  return IWebApiDataSource.create({
    initialize: async ({ query }) => {
      source = sources.get(query.get('source'));
      if (!source) {
        const id = query.get('sourceId');
        // Route refreshed/server links through the cancellable progress UI.
        commandsManager.runCommand('navigateHistory', {
          to: id ? '/nifti?sourceId=' + encodeURIComponent(id) + (query.get('maskIds') ? '&maskIds=' + encodeURIComponent(query.get('maskIds')) : '') + (query.get('manifestId') ? '&manifestId=' + encodeURIComponent(query.get('manifestId')) + '&caseId=' + encodeURIComponent(query.get('caseId') || '') : '') : '/nifti?error=local-unavailable',
          options: { replace: true },
        });
      }
    },
    getStudyInstanceUIDs: () => source ? [source.studyUID] : [],
    getConfig: () => ({ name: 'nifti', dicomUploadEnabled: false }),
    query: {
      studies: { search: async () => [{ studyInstanceUid: source.studyUID,
        patientName: source.descriptor.name, mrn: 'NIFTI', description: source.descriptor.name,
        date: '', time: '', accession: '', modalities: source.descriptor.modality,
        instances: source.imageIds.length, NumInstances: source.imageIds.length }] },
      series: { search: async () => [{ seriesInstanceUid: source.seriesUID, studyInstanceUid: source.studyUID, modality: source.descriptor.modality, numSeriesInstances: source.imageIds.length, description: source.descriptor.name }] },
      instances: { search: async () => source.instances },
    },
    retrieve: { series: { metadata: async () => {
      DicomMetadataStore.addStudy({ StudyInstanceUID: source.studyUID, PatientID: 'NIFTI',
        PatientName: { Alphabetic: source.descriptor.name }, ModalitiesInStudy: [source.descriptor.modality],
        StudyDescription: source.descriptor.name, NumInstances: source.imageIds.length });
      DicomMetadataStore.addSeriesMetadata([source.instances[0]], true);
      DicomMetadataStore.addInstances(source.instances, true);
    } } },
    getImageIdsForDisplaySet: displaySet => displaySet.images.map(i => i.imageId),
    getImageIdsForInstance: ({ instance }) => instance.imageId,
    deleteStudyMetadataPromise: () => {},
    store: { dicom: async () => { throw new Error('PACS export is unavailable for native NIfTI. Use NIfTI export.'); } },
  });
}

export function getSopClassHandlerModule() {
  return [{ name: 'nifti', sopClassUids: [INTERNAL_CLASS], getDisplaySetsFromSeries: instances => {
    if (!instances.length || instances[0].sourceType !== 'nifti') return [];
    const source = sources.get(instances[0].sourceKey);
    const imageSet = new classes.ImageSet(instances);
    imageSet.setAttributes({
      ...instances[0], sourceType: 'nifti', sourceDescriptor: source.descriptor,
      displaySetInstanceUID: imageSet.uid, SOPClassHandlerId: NIFTI_HANDLER,
      numImageFrames: instances.length, isReconstructable: instances.length > 1,
      isMultiFrame: false, isDynamicVolume: false, sopClassUids: [INTERNAL_CLASS],
      volumeLoaderSchema: 'nativeNiftiVolume', countIcon: 'icon-mpr', imageIds: [...source.imageIds],
      imageIdForThumbnail: source.imageIds[Math.floor(source.imageIds.length / 2)],
      nativeIsComplete: () => !source.stream || source.stream.loaded.every(Boolean),
      ensureNativeComplete: () => requestComplete(source),
    });
    return [imageSet];
  } }];
}
