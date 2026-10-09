jest.mock('@cornerstonejs/core', () => ({
  cache: {}, imageLoader: { registerImageLoader: jest.fn() },
  volumeLoader: { registerVolumeLoader: jest.fn() }, ImageVolume: jest.fn(),
  metaData: { addProvider: jest.fn() }, utilities: {}, Enums: {},
}), { virtual: true });
jest.mock('@cornerstonejs/tools', () => ({ BrushTool: { previewData: {} } }), { virtual: true });
jest.mock('@ohif/core', () => ({ DicomMetadataStore: {} }));
jest.mock('./format.mjs', () => ({ transformPoint: jest.fn() }));
jest.mock('./workerClient', () => ({ parseInWorker: jest.fn() }));

import { registerNifti, reserve, release, memorySnapshot, openLocal } from './sourceStore';
import { parseInWorker } from './workerClient';

Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'budget-test', configurable: true });

test('budget refusal preserves existing allocations and deleting a mask permits retry', () => {
  registerNifti({ niftiWorkingSetBytes: 100 });
  reserve('source', 60); reserve('mask', 30);
  expect(() => reserve('new-mask', 20)).toThrow(/内存预算不足/);
  expect(memorySnapshot().bytes).toBe(90);
  release('mask'); reserve('new-mask', 20);
  expect(memorySnapshot().bytes).toBe(80);
  release('source'); release('new-mask');
  expect(memorySnapshot().bytes).toBe(0);
});

test('original File storage is budgeted before starting decompression', async () => {
  registerNifti({ enableNiftiViewing: true, niftiWorkingSetBytes: 1.5 * 1024 ** 3 });
  await expect(openLocal({ size: 600 * 1024 ** 2 }, {}, undefined, undefined)).rejects.toThrow(/内存预算不足/);
  expect(parseInWorker).not.toHaveBeenCalled();
  expect(memorySnapshot().bytes).toBe(0);
});
