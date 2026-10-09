jest.mock('@cornerstonejs/core', () => ({ cache: { getImage: jest.fn(), getImageLoadObject: jest.fn() }, eventTarget: { addEventListener: jest.fn() } }), { virtual: true });
jest.mock('@cornerstonejs/tools', () => ({ segmentation: { state: { getSegmentation: jest.fn() } }, Enums: { SegmentationRepresentations: { Labelmap: 'Labelmap' } } }), { virtual: true });
jest.mock('@cornerstonejs/tools/segmentation/triggerSegmentationEvents', () => ({ triggerSegmentationDataModified: jest.fn() }), { virtual: true });
jest.mock('./sourceStore', () => {
  const reservations = new Map();
  return { sources: new Map(), config: { enableNiftiEditing: true }, reservations,
    reserve: (id, size) => { const used = [...reservations].reduce((n, [k, v]) => n + (k === id ? 0 : v), 0); if (used + size > 64 * 1024 ** 2) throw Error('budget exceeded'); reservations.set(id, size); },
    release: id => reservations.delete(id) };
});
jest.mock('./workerClient', () => ({ parseInWorker: jest.fn(), alignInWorker: jest.fn() }));
jest.mock('./api', () => ({ request: jest.fn(), downloadMask: jest.fn() }));
jest.mock('./format.mjs', () => ({ transformPoint: (matrix, p) => matrix.slice(0, 3).map(row => row[3] + row[0]*p[0] + row[1]*p[1] + row[2]*p[2]) }));
jest.mock('./maskColors.mjs', () => ({ validColor: () => false, initialMaskColor: () => [0,200,255,255] }));

import { cache } from '@cornerstonejs/core';
import { segmentation } from '@cornerstonejs/tools';
import { sources, reservations } from './sourceStore';
import { parseInWorker, alignInWorker } from './workerClient';
import { request, downloadMask } from './api';
import { importMasks, loadSaved, createMask } from './masks';
import { groupedMasks, targetName } from './groups';
import { readSavedVersion, restoreAnnotation } from './history';

let source, manager, segments, images, sequence = 0;
const affine = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
const saved = { maskId: 'a', version: 2, name: 'A', labelOnly: false };
beforeEach(() => {
  jest.clearAllMocks(); sources.clear(); reservations.clear(); segments = new Map(); images = new Map();
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => String(++sequence), configurable: true });
  // This repository's jsdom predates the browser AbortSignal.throwIfAborted API.
  if (!AbortSignal.prototype.throwIfAborted) AbortSignal.prototype.throwIfAborted = function () { if (this.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  source = { sourceKey: 'source', descriptor: { sourceId: 'id', count: 8, dimensions: [2,2,2], voxelToLPS: affine }, masks: new Map() };
  sources.set('source', source);
  manager = { services: { viewportGridService: { getState: () => ({ activeViewportId: 'v', viewports: new Map([['v', { displaySetInstanceUIDs: ['ds'] }]]) }) },
    displaySetService: { getDisplaySetByUID: () => ({ sourceKey: 'source' }) }, segmentationService: {
      createLabelmapForDisplaySet: jest.fn(async (_ds, { segmentationId: id }) => {
        const ids = [id + ':0', id + ':1']; ids.forEach(i => images.set(i, { voxelManager: { getScalarData: () => images.get(i).data }, data: new Uint8Array(4) }));
        segments.set(id, { representationData: { Labelmap: { imageIds: ids } } });
      }), addSegmentationRepresentation: jest.fn(), setSegmentColor: jest.fn(), setActiveSegmentation: jest.fn(), setActiveSegment: jest.fn(), getActiveSegmentation: jest.fn(),
      remove: jest.fn(id => { segments.delete(id); source.masks.delete(id); reservations.delete(id); }),
    } } };
  cache.getImage.mockImplementation(id => images.get(id)); segmentation.state.getSegmentation.mockImplementation(id => segments.get(id));
  parseInWorker.mockImplementation(async (_file, _options, _signal, _progress, allocate) => {
    allocate({ offset: 352, sourceBytes: 8, workingBytes: 8 });
    return { descriptor: source.descriptor, scalarData: new Uint8Array([1,0,0,0,0,0,0,0]) };
  });
  alignInWorker.mockImplementation(async scalarData => ({ scalarData, binary: new Uint8Array([1,0,0,0,0,0,0,0]) }));
  request.mockResolvedValue({ json: async () => ({ items: [saved] }) }); downloadMask.mockResolvedValue(new Blob([new Uint8Array(8)]));
});

test('small saved masks load under 64 MiB; repeated loads report existing without changing edits', async () => {
  expect((await loadSaved(manager))[0].status).toBe('loaded');
  const mask = [...source.masks.values()][0]; mask.revision = 9;
  expect((await loadSaved(manager))[0].status).toBe('alreadyLoaded');
  expect(mask.revision).toBe(9); expect(downloadMask).toHaveBeenCalledTimes(1);
  expect([...reservations.values()]).toEqual([8]);
});

test('one failed file is reported while remaining files load and retry stays usable', async () => {
  request.mockResolvedValue({ json: async () => ({ items: [saved, { ...saved, maskId: 'b' }] }) });
  downloadMask.mockRejectedValueOnce(Error('network failure'));
  expect((await loadSaved(manager)).map(r => r.status)).toEqual(['failed', 'loaded']);
  expect((await loadSaved(manager)).map(r => r.status)).toEqual(['loaded', 'alreadyLoaded']);
});

test('cancelled alignment and source switching cannot commit a mask to another case', async () => {
  const controller = new AbortController();
  alignInWorker.mockImplementationOnce(async scalarData => { controller.abort(); return { scalarData, binary: new Uint8Array(8) }; });
  await expect(importMasks(manager, new File(['x'], 'mask.nii'), controller.signal)).rejects.toHaveProperty('name', 'AbortError');
  expect(source.masks.size).toBe(0); expect(reservations.size).toBe(0);
  alignInWorker.mockImplementationOnce(async scalarData => { sources.delete('source'); return { scalarData, binary: new Uint8Array(8) }; });
  await expect(importMasks(manager, new File(['x'], 'mask.nii'))).rejects.toHaveProperty('name', 'AbortError');
  expect(reservations.size).toBe(0);
});

test('historical copy has a new identity, dirty state and explicit lineage', async () => {
  await loadSaved(manager);
  await loadSaved(manager, undefined, undefined, { items: [{ ...saved, version: 1 }], asCopy: true });
  const [original, copy] = [...source.masks.values()];
  expect(original.saved.version).toBe(2); expect(copy.saved).toBeUndefined();
  expect(copy.savedRevision).toBe(-1); expect(copy.derivedFrom).toEqual({ maskId: 'a', version: 1 });
  expect(copy.label).toContain('v1 副本');
});

test('multi-label import groups targets by file operation, not by basename or runtime ID', async () => {
  parseInWorker.mockResolvedValue({ descriptor: source.descriptor, scalarData: new Uint8Array([1,4,0,0,0,0,0,0]) });
  await importMasks(manager, new File(['x'], 'finding.nii.gz'));
  const [a,b] = [...source.masks.values()];
  expect(a.segmentationSet.id).toBe(b.segmentationSet.id);
  expect(targetName(a)).toBe('目标 1'); expect(targetName(b)).toBe('目标 4');
  await importMasks(manager, new File(['x'], 'finding.nii.gz'));
  expect(groupedMasks(source)).toHaveLength(2);
  expect(source.masks.size).toBe(4);
});

test('adding joins active group, while saved loads and historical copies retain explicit group', async () => {
  const item = {...saved, segmentationSet:{id:'stable-group',name:'A group',kind:'import'}};
  await loadSaved(manager, undefined, undefined, {items:[item]});
  const original = [...source.masks.values()][0];
  manager.services.segmentationService.getActiveSegmentation.mockReturnValue({segmentationId: original.segmentationId});
  const id = await createMask(manager, 'new');
  expect(source.masks.get(id).segmentationSet).toEqual(item.segmentationSet);
  await loadSaved(manager, undefined, undefined, {items:[item],asCopy:true});
  expect(groupedMasks(source)).toHaveLength(1);
  expect([...source.masks.values()][2].segmentationSet).toEqual(item.segmentationSet);
});

test('read-only preview has no editable segmentation and releases its own buffers', async () => {
  const preview = await readSavedVersion(manager, source, saved, undefined, jest.fn(), true);
  expect(source.masks.size).toBe(0);
  expect(manager.services.segmentationService.createLabelmapForDisplaySet).not.toHaveBeenCalled();
  expect([...reservations.values()]).toEqual([8 + 4 * 8]);
  preview.dispose(); expect(reservations.size).toBe(0);
});

test('restore replaces only a clean selected target after commit and preserves mask identity', async () => {
  await loadSaved(manager);
  const old = [...source.masks.values()][0];
  request.mockResolvedValueOnce({ json: async () => ({ item: { ...saved, version: 3, restoredFrom: 1 } }) });
  const record = await restoreAnnotation(manager, source, { ...saved, version: 1 }, 2, 'request', undefined, jest.fn());
  expect(record.version).toBe(3); expect(source.masks.size).toBe(1);
  const current = [...source.masks.values()][0];
  expect(current.saved.maskId).toBe(saved.maskId); expect(current.saved.version).toBe(3);
  expect(current.segmentationId).not.toBe(old.segmentationId);
  expect([...reservations.values()]).toEqual([8]);
});

test('dirty target is rejected before restore; a late edit after commit is never overwritten', async () => {
  await loadSaved(manager);
  const old = [...source.masks.values()][0];old.revision++;
  await expect(restoreAnnotation(manager, source, { ...saved, version: 1 }, 2, 'request', undefined, jest.fn())).rejects.toThrow(/未保存修改/);
  expect(request).toHaveBeenCalledTimes(1); // Original list call only.
  old.savedRevision = old.revision;
  request.mockImplementationOnce(async () => { old.revision++; return { json: async () => ({ item: { ...saved, version: 3, restoredFrom: 1 } }) }; });
  await expect(restoreAnnotation(manager, source, { ...saved, version: 1 }, 2, 'request', undefined, jest.fn())).rejects.toThrow(/服务器已保存恢复版本 v3/);
  expect([...source.masks.values()]).toEqual([old]); expect(old.saved.version).toBe(2);
  expect([...reservations.values()]).toEqual([8]);
});
