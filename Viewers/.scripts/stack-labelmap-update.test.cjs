const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'stack-labelmap-update.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export function', 'function');

test('multiple targets and stale/reordered actors update only the referenced current slice', () => {
  const seen = [], updated = [];
  const actor = referencedId => ({ referencedId, actor: { getMapper: () => ({ getInputData: () => ({ modified() {} }) }) } });
  const context = {
    cache: { getImage(id) { assert(id); seen.push(id); return { imageId: id }; } },
    csUtils: { updateVTKImageDataWithCornerstoneImage(data, image) { updated.push(image.imageId); } },
    VolumeViewport: class {}, getEnabledElementByViewportId: () => ({ viewport: {} }),
    SegmentationRepresentations: { Labelmap: 'Labelmap' },
    getSegmentationRepresentations: () => [{ segmentationId: 'a', type: 'Labelmap' }, { segmentationId: 'b', type: 'Labelmap' }],
    getCurrentLabelmapImageIdsForViewport: (v, s) => [s + '-slice'],
    getLabelmapActorEntries: () => [actor('stale'), actor('b-slice'), actor('a-slice'), actor(undefined)],
  };
  vm.createContext(context); vm.runInContext(source, context);
  context.performStackLabelmapUpdate({ viewportIds: ['v'], segmentationId: 'a' });
  assert.deepEqual(seen, ['a-slice']); assert.deepEqual(updated, ['a-slice']);
  context.performStackLabelmapUpdate({ viewportIds: ['v'], segmentationId: 'b' });
  assert.deepEqual(updated, ['a-slice', 'b-slice']);
  context.getCurrentLabelmapImageIdsForViewport = () => undefined;
  context.performStackLabelmapUpdate({ viewportIds: ['v'], segmentationId: 'a' });
  assert.equal(updated.length, 2);
});
