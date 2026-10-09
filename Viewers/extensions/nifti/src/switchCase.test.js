jest.mock('@ohif/core', () => ({ DicomMetadataStore: { getStudy: jest.fn(), addStudy: jest.fn() } }));
jest.mock('@cornerstonejs/core', () => ({ utilities: { HistoryMemo: { DefaultHistoryMemo: { size: 50 } } } }), { virtual: true });
jest.mock('./api', () => ({ request: jest.fn(), downloadSource: jest.fn(), openManifestCase: jest.fn() }));
jest.mock('./sourceStore', () => ({ config: { enableNiftiStreaming: true }, sources: new Map(), openStreaming: jest.fn(), releaseSource: jest.fn(), openLocal: jest.fn() }));
jest.mock('./streaming', () => ({ prepareStreaming: jest.fn(), ensureSlice: jest.fn() }));
jest.mock('./dataSource', () => ({ activateNativeSource: jest.fn() }));
jest.mock('./navigation', () => ({ activateNativeBrowse: jest.fn() }));
jest.mock('./workspace', () => ({ getWorkspace: jest.fn(), setWorkspace: jest.fn(), workspaceQuery: () => '&manifestId=m&caseId=b' }));
import { DicomMetadataStore } from '@ohif/core';
import { request, openManifestCase } from './api';
import { openStreaming, releaseSource, sources } from './sourceStore';
import { prepareStreaming, ensureSlice } from './streaming';
import { activateNativeSource } from './dataSource';
import { activateNativeBrowse } from './navigation';
import { getWorkspace, setWorkspace } from './workspace';
import { switchCase } from './switchCase';
import { useDisplaySetSelectorStore } from '../../default/src/stores/useDisplaySetSelectorStore';

let previous, next, options, services, events;
beforeAll(() => { AbortSignal.prototype.throwIfAborted = function () { if (this.aborted) throw new DOMException('Cancelled', 'AbortError'); }; });
beforeEach(() => {
  jest.clearAllMocks(); sources.clear(); events = [];
  useDisplaySetSelectorStore.setState({ displaySetSelectorMap: { 'old-study:default:0': 'old-set' } });
  previous = { sourceKey: 'old', studyUID: 'old-study', masks: new Map([['old-mask', { segmentationId: 'old-mask' }]]) };
  next = { sourceKey: 'new', studyUID: 'new-study', imageIds: ['new:0', 'new:1'], masks: new Map() };
  sources.set('old', previous);
  const metadata = { sourceId: 'stored', capabilities: { streamingViewing: true } };
  // The upload response deliberately lacks the dynamic streaming capability.
  openManifestCase.mockResolvedValue({ descriptor: { sourceId: 'stored' }, maskIds: ['mask-b'], errors: [], manifest: { id: 'm', items: [] } });
  request.mockResolvedValueOnce({ json: async () => metadata });
  prepareStreaming.mockResolvedValue({}); ensureSlice.mockResolvedValue();
  openStreaming.mockImplementation(() => { sources.set('new', next); return next; });
  releaseSource.mockImplementation(key => { events.push('release:' + key); sources.delete(key); });
  getWorkspace.mockReturnValue({ manifest: { id: 'm' }, caseId: 'a' });
  DicomMetadataStore.getStudy.mockReturnValue({ addInstancesToSeries: jest.fn() });
  const oldSet = { sourceKey: 'old', displaySetInstanceUID: 'old-set' };
  let imageId = 'old:0';
  services = {
    displaySetService: { getActiveDisplaySets: () => [oldSet], makeDisplaySets: jest.fn(() => [{ sourceKey: 'new', displaySetInstanceUID: 'new-set' }]), deleteDisplaySet: jest.fn() },
    hangingProtocolService: { run: jest.fn(() => { events.push('show:new'); imageId = 'new:1'; }) },
    segmentationService: { remove: jest.fn() }, measurementService: { getMeasurements: () => [], removeMany: jest.fn() },
    viewportGridService: { getState: () => ({ activeViewportId: 'vp' }) },
    cornerstoneViewportService: { getCornerstoneViewport: () => ({ getCurrentImageId: () => imageId, getCornerstoneImage: () => ({ imageId }) }) },
  };
  options = { servicesManager: { services }, previous, manifest: { id: 'm' }, row: { caseId: 'b' }, signal: new AbortController().signal, progress: jest.fn() };
});

test('first slice validation failure releases only staging data and retains old masks and workspace', async () => {
  ensureSlice.mockRejectedValueOnce(Error('bad checksum'));
  await expect(switchCase(options)).rejects.toThrow('bad checksum');
  expect(sources.get('old')).toBe(previous); expect(sources.has('new')).toBe(false);
  expect(services.segmentationService.remove).not.toHaveBeenCalled();
  expect(setWorkspace).not.toHaveBeenCalled(); expect(activateNativeSource).not.toHaveBeenCalled();
  expect(activateNativeBrowse).not.toHaveBeenCalled();
  expect(useDisplaySetSelectorStore.getState().displaySetSelectorMap['old-study:default:0']).toBe('old-set');
});

test('commit uses fresh capabilities and releases the old source only after displaying the new one', async () => {
  await switchCase(options);
  expect(request.mock.calls[0][0]).toBe('/stored/metadata');
  expect(events).toEqual(['show:new', 'release:old']);
  expect(next.pendingMaskIds).toEqual(['mask-b']);
  expect(activateNativeBrowse).toHaveBeenCalledWith(options.servicesManager);
  expect(services.segmentationService.remove).toHaveBeenCalledWith('old-mask');
  expect(sources.size).toBe(1);
  expect(useDisplaySetSelectorStore.getState().displaySetSelectorMap).toEqual({});
  expect(window.location.pathname).toBe('/nifti-viewer/nifti');
});

test('cancelled preparation never replaces the current viewport', async () => {
  const controller = new AbortController(); controller.abort(); options.signal = controller.signal;
  await expect(switchCase(options)).rejects.toThrow();
  expect(openStreaming).not.toHaveBeenCalled(); expect(services.hangingProtocolService.run).not.toHaveBeenCalled();
  expect(sources.get('old')).toBe(previous);
});

test('a late AI/edit result during preparation prevents discarding the updated original', async () => {
  ensureSlice.mockImplementationOnce(async () => { previous.masks.get('old-mask').revision = 2; });
  await expect(switchCase(options)).rejects.toThrow('标注发生更新');
  expect(services.segmentationService.remove).not.toHaveBeenCalled();
  expect(sources.get('old').masks.get('old-mask').revision).toBe(2);
  expect(sources.has('new')).toBe(false);
});
