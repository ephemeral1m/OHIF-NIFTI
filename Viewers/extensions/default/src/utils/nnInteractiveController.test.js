import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { TextEncoder, TextDecoder } from 'util';
import CommandsManager from '../../../../platform/core/src/classes/CommandsManager';
import { createNnInteractiveController } from './nnInteractiveController';
import { normalizeNnInteractiveArgs } from './nnInteractiveArgs';

jest.mock('../../../../platform/core/src/log.js', () => ({ __esModule: true, default: { warn: jest.fn() } }));
jest.mock('../../../nifti/src/sourceStore', () => ({ reserve: jest.fn(), release: jest.fn() }));

// jsdom lacks these modern browser APIs. Keep the real File/FormData behavior.
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

function eventService(events) {
  const handlers = new Map();
  return { EVENTS: Object.fromEntries(events.map(e => [e, e])),
    listenerCount: name => (handlers.get(name) || []).length,
    subscribe: (name, callback) => { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); return { unsubscribe() {} }; },
    emit: (name, value) => { for (const callback of handlers.get(name) || []) callback(value); } };
}

function multipart(meta, pixels) {
  const encoder = new TextEncoder();
  const pieces = [encoder.encode('--test\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(meta) + '\r\n--test\r\nContent-Disposition: form-data; name="seg"\r\nContent-Type: application/octet-stream\r\n\r\n'), pixels, encoder.encode('\r\n--test--\r\n')];
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const p of pieces) { bytes.set(p, offset); offset += p.length; }
  return { data: bytes.buffer, headers: { 'content-type': 'multipart/form-data; boundary=test' } };
}

export function controllerHarness(reverseVolume = false, lateCornerstone = false) {
  const refs = ['ct1', 'ct2'];
  const pixels = { a1: new Uint8Array([1, 0, 0, 0]), a2: new Uint8Array([0, 1, 0, 0]), b1: new Uint8Array(4), b2: new Uint8Array(4) };
  const group = (id, images) => ({ segmentationId: id, cachedStats: { info: 'manual brush group' }, segments: {
    1: { segmentIndex: 1, active: true, locked: false, label: 'my mask', cachedStats: { draftOrigin: 'original.nii.gz', savedMaskHash: 'baseline', savedLabel: 'my mask' } },
  }, representationData: { Labelmap: { imageIds: images, referencedImageIds: refs } } });
  const groups = { A: group('A', ['a1', 'a2']), B: group('B', ['b1', 'b2']) };
  let active = 'A';
  let activeIndex = 1;
  let live = false;
  const measurements = [];
  const segmentationService = Object.assign(eventService(['SEGMENTATION_MODIFIED', 'SEGMENTATION_REMOVED']), {
    getActiveSegmentation: () => groups[active], getActiveSegment: () => groups[active]?.segments[activeIndex],
  });
  const measurementService = Object.assign(eventService(['MEASUREMENT_ADDED', 'MEASUREMENT_REMOVED', 'MEASUREMENTS_CLEARED']), {
    getMeasurements: () => measurements, toggleVisibilityMeasurement: jest.fn(),
  });
  const viewportGridService = Object.assign(eventService(['ACTIVE_VIEWPORT_ID_CHANGED', 'GRID_STATE_CHANGED']), {
    getState: () => ({ activeViewportId: 'v', viewports: new Map([['v', { displaySetInstanceUIDs: ['ds'] }]]) }),
  });
  const notification = { show: jest.fn() };
  const source = { SeriesInstanceUID: 'series', StudyInstanceUID: 'study', imageIds: refs };
  const cache = { getImage: id => pixels[id] && ({ rows: 2, columns: 2, voxelManager: { getScalarData: () => pixels[id] } }),
    getVolume: () => ({ imageIds: reverseVolume ? [...refs].reverse() : refs }) };
  const metaData = { get: (kind, id) => kind === 'sopCommonModule' ? { sopInstanceUID: id } : kind === 'imagePlaneModule' ? {
    imagePositionPatient: [0, 0, refs.indexOf(id)], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0], rowPixelSpacing: 1, columnPixelSpacing: 1,
  } : {} };
  const toolboxState = { getLocked: () => false, getLiveMode: () => live };
  const sent = [];
  let output = new Uint8Array([0, 0, 1, 0, 0, 0, 0, 1]);
  const axios = { post: jest.fn(async (_, form) => {
    const params = JSON.parse(form.get('params'));
    const seed = form.get('nn_seed');
    sent.push({ params, seed: seed ? new Uint8Array(await seed.arrayBuffer()) : undefined });
    return multipart({ nn_context: { ...params.nn_context, sessionToken: 'token' }, mask_shape: [2, 2, 2] }, output);
  }) };
  const rawEvents = eventService(['DATA']);
  const servicesManager = { services: { measurementService, viewportGridService,
      displaySetService: { getDisplaySetByUID: () => source },
      uiNotificationService: notification } };
  const cornerstoneViewportService = { getCornerstoneViewport: () => ({ getVolumeId: () => 'vol' }) };
  const registerCornerstone = () => Object.assign(servicesManager.services, { segmentationService, cornerstoneViewportService });
  if (!lateCornerstone) registerCornerstone();
  const editor = createNnInteractiveController({
    servicesManager,
    cache, metaData, toolboxState, axios,
    csToolsSegmentation: { state: { getSegmentation: id => groups[id] }, segmentLocking: { isSegmentIndexLocked: (id, index) => groups[id]?.segments[index]?.locked } },
    csToolsEnums: { Events: { SEGMENTATION_DATA_MODIFIED: 'DATA' } },
    eventTarget: { addEventListener: rawEvents.subscribe }, patchStackLabelmapModifiedSlices: jest.fn(),
    triggerSegmentationDataModified: id => rawEvents.emit('DATA', { detail: { segmentationId: id } }),
    triggerSegmentationModified: id => segmentationService.emit('SEGMENTATION_MODIFIED', { segmentationId: id }),
  });
  // Compile the actual command and invoke it using the real CommandsManager.
  const filename = path.join(__dirname, '../commandsModule.ts');
  const sourceFile = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  let method;
  const visit = node => { if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === 'nninter') method = node; ts.forEachChild(node, visit); };
  visit(sourceFile);
  const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, method, sourceFile);
  const js = ts.transpileModule(`const action = ({ ${printed} }).nninter`, { compilerOptions: { target: ts.ScriptTarget.ES2021 } }).outputText;
  const action = new Function('nnEditor', 'toolboxState', 'normalizeNnInteractiveArgs', 'uiNotificationService', `${js}; return action;`)(editor, toolboxState, normalizeNnInteractiveArgs, notification);
  const manager = new CommandsManager(); manager.createContext('DEFAULT'); manager.registerCommand('DEFAULT', 'nninter', action);
  return { editor, manager, sent, pixels, groups, notification, axios, registerCornerstone, servicesManager, segmentationService, source, metaData,
    setOutput: p => { output = p; }, setLive: value => { live = value; },
    select: (id, index = 1) => { active = id; activeIndex = index; segmentationService.emit('SEGMENTATION_MODIFIED', {}); },
    brush: (id, values) => { pixels[id].set(values); rawEvents.emit('DATA', { detail: { segmentationId: active } }); },
    prompt: (uid, point, neg = false) => {
      const m = { uid, toolName: 'Probe2', referenceSeriesUID: 'series', metadata: { neg }, data: { 'volumeId:vol': { index: point } } };
      measurements.push(m); measurementService.emit('MEASUREMENT_ADDED', { measurement: m });
    },
  };
}

test('real command -> controller -> multipart -> in-place B update, no A prompt or new C', async () => {
  const h = controllerHarness();
  h.prompt('old-A', [0, 0, 0]);
  h.select('B');
  h.prompt('new-B', [1, 1, 1]);
  const originalBuffer = h.pixels.b1;
  await h.manager.run('nninter');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].params.nn_context.segmentationId).toBe('B');
  expect(h.sent[0].params.pos_points).toEqual([[1, 1, 1]]);
  expect(h.sent[0].seed).toEqual(new Uint8Array(8));
  expect(Object.keys(h.groups)).toEqual(['A', 'B']);
  expect(Array.from(h.pixels.a1)).toEqual([1, 0, 0, 0]);
  expect(h.pixels.b1).toBe(originalBuffer);
  expect(h.notification.show.mock.calls.map(([m]) => m.message)).not.toEqual(expect.arrayContaining([expect.stringMatching(/失败|invalid|not|Missing|错误|匹配/)]));
  expect(Array.from(h.pixels.b1)).toEqual([0, 0, 1, 0]);
  expect(h.groups.B.segments[1].cachedStats).toMatchObject({ draftOrigin: 'original.nii.gz', savedMaskHash: 'baseline', savedLabel: 'my mask', isDirty: true });
});

test('brush edit reseeds current pixels; empty AI result replaces draft foreground', async () => {
  const h = controllerHarness();
  h.select('B'); h.brush('b1', [1, 1, 0, 0]);
  h.prompt('new', [0, 0, 0], true); h.setOutput(new Uint8Array(8));
  await h.manager.run('nninter');
  expect(Array.from(h.sent[0].seed)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  expect(Array.from(h.pixels.b1)).toEqual([0, 0, 0, 0]);
  expect(h.groups.B.segments[1].label).toBe('my mask');
});

test('no selected mask refuses inference without new segmentation', async () => {
  const h = controllerHarness(); h.select(undefined);
  await h.manager.run('nninter');
  expect(h.axios.post).not.toHaveBeenCalled();
  expect(Object.keys(h.groups)).toEqual(['A', 'B']);
});

test('bundled MPR tool indices already use display-set order, not reversed volume order', async () => {
  const h = controllerHarness(true); h.select('B'); h.prompt('mpr', [1, 1, 0]);
  await h.manager.run('nninter');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].params.nn_context.promptSlices).toEqual(['ct1', 'ct2']);
  expect(h.sent[0].params.pos_points).toEqual([[1, 1, 0]]);
  expect(Array.from(h.pixels.b1)).toEqual([0, 0, 1, 0]);
});

test('same group second mask refines in place and cannot overwrite first mask', async () => {
  const h = controllerHarness();
  h.groups.B.segments[2] = { segmentIndex: 2, label: 'second', active: true, cachedStats: {} };
  h.select('B', 2); h.brush('b1', [1, 2, 0, 0]);
  h.prompt('second', [1, 0, 0]);
  h.setOutput(new Uint8Array([1, 0, 1, 0, 0, 0, 0, 0]));
  await h.manager.run('nninter');
  expect(h.sent[0].params.nn_context.segmentIndex).toBe(2);
  expect(Array.from(h.sent[0].seed)).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  expect(Array.from(h.pixels.b1)).toEqual([1, 0, 2, 0]);
});

test('locked target is rejected without sending or creating anything', async () => {
  const h = controllerHarness(); h.groups.B.segments[1].locked = true; h.select('B');
  h.prompt('locked', [0, 0, 0]); await h.manager.run('nninter');
  expect(h.axios.post).not.toHaveBeenCalled();
  expect(Object.keys(h.groups)).toEqual(['A', 'B']);
});

test('reset preserves mask and prevents old prompts from being replayed', async () => {
  const h = controllerHarness(); h.select('B'); h.brush('b1', [1, 1, 0, 0]);
  h.prompt('before-reset', [0, 0, 0]); h.editor.reset();
  h.prompt('after-reset', [1, 1, 1]); await h.manager.run('nninter');
  expect(h.sent[0].params.pos_points).toEqual([[1, 1, 1]]);
  expect(Array.from(h.sent[0].seed)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
});

test('default command registration succeeds BEFORE Cornerstone registers its services', async () => {
  // pluginConfig registers default first, then cornerstone.preRegistration.
  // In production this used to throw undefined.subscribe and abort default's
  // remaining modules, including the worklist data source / layout modules.
  const h = controllerHarness(false, true);
  expect(h.editor.capture()).toBeUndefined();
  expect(h.axios.post).not.toHaveBeenCalled();
  await h.manager.run('nninter');
  expect(h.axios.post).not.toHaveBeenCalled();
  h.registerCornerstone();
  h.select('B'); h.prompt('first-prompt', [1, 1, 1]);
  await h.manager.run('nninter');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].params.nn_context.segmentationId).toBe('B');
  expect(Array.from(h.pixels.b1)).toEqual([0, 0, 1, 0]);
});

test('partially registered Cornerstone is retried and subscriptions bind exactly once', () => {
  const h = controllerHarness(false, true);
  h.servicesManager.services.segmentationService = h.segmentationService;
  expect(h.editor.capture()).toBeUndefined();
  expect(h.segmentationService.listenerCount('SEGMENTATION_MODIFIED')).toBe(0);
  h.registerCornerstone();
  for (let i = 0; i < 5; i++) expect(h.editor.capture().target.segmentationId).toBe('A');
  expect(h.segmentationService.listenerCount('SEGMENTATION_MODIFIED')).toBe(1);
  expect(h.segmentationService.listenerCount('SEGMENTATION_REMOVED')).toBe(1);
});

test('native source uses v2 endpoint and explicit original slice mapping', async () => {
  const h = controllerHarness();
  h.source.sourceType = 'nifti'; h.source.sourceKey = 'native-key';
  h.source.sourceDescriptor = { sourceId: 'a'.repeat(32), geometryHash: 'geometry', capabilities: { ai: true } };
  const originalGet = h.metaData.get;
  h.metaData.get = (type, id) => type === 'niftiSource'
    ? { sourceKey: 'native-key', slice: ['ct1', 'ct2'].indexOf(id) } : originalGet(type, id);
  h.select('B'); h.prompt('native-point', [1, 1, 1]);
  await h.manager.run('nninter');
  expect(h.sent).toHaveLength(1);
  expect(h.axios.post.mock.calls[0][0]).toBe('/monai/nifti-images/' + 'a'.repeat(32) + '/infer');
  expect(h.sent[0].params.nn_context).toMatchObject({ version: 2, sourceType: 'nifti',
    sourceId: 'a'.repeat(32), geometryHash: 'geometry', maskOrder: [0, 1], promptOrder: [0, 1] });
  expect(Array.from(h.pixels.a1)).toEqual([1, 0, 0, 0]);
  expect(Array.from(h.pixels.b1)).toEqual([0, 0, 1, 0]);
});

test('unregistered native source cannot fall through to DICOM inference', async () => {
  const h = controllerHarness();
  h.source.sourceType = 'nifti'; h.source.sourceDescriptor = { capabilities: { ai: true } };
  h.select('B'); h.prompt('not-uploaded', [0, 0, 0]);
  await h.manager.run('nninter');
  expect(h.axios.post).not.toHaveBeenCalled();
});
