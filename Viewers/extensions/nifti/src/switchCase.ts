import { DicomMetadataStore } from '@ohif/core';
import { utilities } from '@cornerstonejs/core';
import { request, downloadSource, openManifestCase } from './api';
import { config, openLocal, openStreaming, releaseSource, sources } from './sourceStore';
import { prepareStreaming, ensureSlice } from './streaming';
import { activateNativeSource } from './dataSource';
import { getWorkspace, setWorkspace, workspaceQuery } from './workspace';
import { releaseStudyLayoutState } from '../../default/src/utils/releaseStudyLayoutState';
import { activateNativeBrowse } from './navigation';

async function displayed(services, next) {
  const deadline = performance.now() + 60000;
  while (performance.now() < deadline) {
    const view = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
    const imageId = view?.getCornerstoneImage?.()?.imageId;
    if (imageId && next.imageIds.includes(imageId) && imageId === view.getCurrentImageId?.()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('新病例显示超时，已保留原病例。');
}

/** Stage independently; commit only after identity and first-slice validation.
 * Do not navigate React Router: Mode treats every location change as a full teardown.
 */
export async function switchCase({ servicesManager, previous, manifest, row, signal, progress }) {
  const services = servicesManager.services;
  const { displaySetService, hangingProtocolService, segmentationService, measurementService } = services;
  let next, committed = false, switching = false;
  const oldContext = getWorkspace();
  const oldSets = displaySetService.getActiveDisplaySets().filter(ds => ds.sourceKey === previous.sourceKey);
  const oldStudy = DicomMetadataStore.getStudy(previous.studyUID);
  const editState = () => JSON.stringify([...previous.masks].map(([id, mask]: any) => [id, mask.revision, mask.generation, mask.label, mask.saved?.version]));
  const initialEdits = editState();
  try {
    progress('校验原图与标注…');
    const reply = await openManifestCase({ manifestId: manifest.id, caseId: row.caseId, image: row.image, segmentations: row.segmentations, base: manifest.base, unit: manifest.unit, modality: row.modality || manifest.modality || 'OT' }, signal);
    const metadata = await (await request(`/${reply.descriptor.sourceId}/metadata`, { signal })).json();
    if (config.enableNiftiStreaming) {
      if (!metadata.capabilities.streamingViewing) throw Error('后端未启用渐进加载。');
      const transport = await prepareStreaming(metadata.sourceId, metadata, signal, progress);
      signal.throwIfAborted();
      next = openStreaming(metadata, transport);
      progress('加载首层…');
      await ensureSlice(next, Math.floor(next.imageIds.length / 2), signal);
    } else {
      const { file, descriptor } = await downloadSource(metadata.sourceId, signal, p => progress(`下载原图 ${Math.round(p * 100)}%`));
      next = await openLocal(file, { unit: descriptor.unit, modality: descriptor.modality }, signal);
      if (next.descriptor.geometryHash !== descriptor.geometryHash || next.descriptor.contentHash !== descriptor.contentHash) throw Error('前后端原图身份不一致。');
      Object.assign(next.descriptor, descriptor);
    }
    signal.throwIfAborted();
    if (!sources.has(previous.sourceKey)) throw new DOMException('已离开原病例', 'AbortError');
    if (editState() !== initialEdits) throw Error('准备期间原病例的标注发生更新。已保留编辑，请重新确认切换。');
    progress('切换视图…');
    switching = true;
    next.importWarnings = reply.errors.map(e => `${e.file}: ${e.message}`);
    DicomMetadataStore.addStudy({ StudyInstanceUID: next.studyUID, PatientID: 'NIFTI', PatientName: { Alphabetic: metadata.name }, ModalitiesInStudy: [metadata.modality], StudyDescription: metadata.name });
    const study = DicomMetadataStore.getStudy(next.studyUID);
    // Avoid INSTANCES_ADDED: its original route subscription is tied to the old study.
    study.addInstancesToSeries(next.instances);
    const sets = displaySetService.makeDisplaySets(next.instances, { madeInClient: true });
    activateNativeSource(next);
    hangingProtocolService.run({ studies: [study], activeStudy: study, displaySets: sets }, 'default', { stageIndex: 0 });
    await displayed(services, next);
    activateNativeBrowse(servicesManager);
    const updated = reply.manifest || { ...manifest, items: manifest.items.map(item => item.caseId === row.caseId ? { ...item, sourceId: metadata.sourceId } : item) };
    setWorkspace(updated, row.caseId);
    next.pendingMaskIds = reply.maskIds;
    // The panel may have seen the source before first render completed.
    window.dispatchEvent(new CustomEvent('nifti:load-pending-masks', { detail: next.sourceKey }));
    try { sessionStorage.setItem('ohif.nifti.manifest.v1', JSON.stringify(updated)); } catch { /* Server manifest remains durable. */ }
    const params = `?source=${encodeURIComponent(next.sourceKey)}&sourceId=${metadata.sourceId}${reply.maskIds.length ? '&maskIds=' + reply.maskIds.join(',') : ''}${workspaceQuery()}`;
    window.history.replaceState(window.history.state, '', '/nifti-viewer/nifti' + params);
    committed = true;
    for (const mask of previous.masks.values()) segmentationService.remove(mask.segmentationId);
    const measurements = measurementService.getMeasurements().filter(m => m.referenceStudyUID === previous.studyUID).map(m => m.uid);
    if (measurements.length) measurementService.removeMany(measurements);
    const history = utilities.HistoryMemo.DefaultHistoryMemo;
    history.size = history.size; // Public setter clears undo/redo references to the old source.
    releaseStudyLayoutState(previous.studyUID);
    for (const ds of oldSets) displaySetService.deleteDisplaySet(ds.displaySetInstanceUID);
    releaseSource(previous.sourceKey);
    return next;
  } catch (error) {
    if (!committed && next) {
      if (switching && sources.has(previous.sourceKey)) {
        activateNativeSource(previous); setWorkspace(oldContext.manifest, oldContext.caseId);
        hangingProtocolService.run({ studies: [oldStudy], activeStudy: oldStudy, displaySets: oldSets }, 'default', { stageIndex: 0 });
        await displayed(services, previous);
      }
      releaseStudyLayoutState(next.studyUID);
      for (const ds of displaySetService.getActiveDisplaySets().filter(ds => ds.sourceKey === next.sourceKey)) displaySetService.deleteDisplaySet(ds.displaySetInstanceUID);
      releaseSource(next.sourceKey);
    }
    throw error;
  }
}
