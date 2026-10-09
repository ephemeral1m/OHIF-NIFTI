import { commitPrediction, targetKey, createNnEditor } from './nnInteractiveEdit';

describe('nnInteractive edits the selected brush mask', () => {
  test('A/1 brush pixels survive inference into empty B/1 without creating C', () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array(4);
    const original = b;
    commitPrediction([b], 1, new Uint8Array([0, 0, 1, 1]));
    expect(Array.from(a)).toEqual([1, 1, 0, 0]);
    expect(b).toBe(original);
    expect(Array.from(b)).toEqual([0, 0, 1, 1]);
    expect(targetKey({ seriesUID: 's', segmentationId: 'A', segmentIndex: 1 }))
      .not.toBe(targetKey({ seriesUID: 's', segmentationId: 'B', segmentIndex: 1 }));
  });

  test('negative result removes draft foreground but protects another segment', () => {
    const pixels = new Uint8Array([1, 1, 2, 0]);
    expect(commitPrediction([pixels], 1, new Uint8Array([0, 1, 1, 1])).clipped).toBe(true);
    expect(Array.from(pixels)).toEqual([0, 1, 2, 1]);
    commitPrediction([pixels], 1, new Uint8Array(4));
    expect(Array.from(pixels)).toEqual([0, 0, 2, 0]);
  });

  test('invalid output cannot partially overwrite any slice', () => {
    const pixels = new Uint8Array([1, 0]);
    expect(() => commitPrediction([pixels], 1, new Uint8Array([0, 2]))).toThrow();
    expect(Array.from(pixels)).toEqual([1, 0]);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  let target = { seriesUID: 'series', studyUID: 'study', segmentationId: 'B', segmentIndex: 1,
    viewportId: 'v', imageIds: ['b'], referenceImageIds: ['ct'], shape: [1, 2, 2], slices: [], promptSlices: [] };
  const pixels = new Uint8Array(4);
  let prompts = [{ uid: 'p1', kind: 'pos_points', value: [0, 0, 0] }];
  const notify = jest.fn();
  const infer = jest.fn(async context => ({ pixels: new Uint8Array([1, 0, 0, 0]), context: { ...context, sessionToken: 'token' }, shape: context.shape }));
  const inspect = jest.fn(async (_, buffer) => ({ buffer: buffer ? pixels.slice() : undefined, maskHash: Array.from(pixels).join(',') }));
  const commit = jest.fn((t, reply) => commitPrediction([pixels], t.segmentIndex, reply.pixels));
  const editor = createNnEditor({ capture: () => {
    if (!target) throw new Error('No target');
    return target;
  }, inspect, prompts: () => prompts, infer, commit, retirePrompts: jest.fn(), notify });
  return { editor, infer, inspect, commit, notify, pixels, setTarget: t => { target = t; editor.selectionChanged(); },
    target: () => target, addPrompt: p => prompts.push(p) };
}

test('continuous interaction reuses token; brush edit reseeds latest pixels', async () => {
  const h = harness();
  await h.editor.run();
  expect(h.infer.mock.calls[0][1]).toEqual(new Uint8Array(4));
  h.addPrompt({ uid: 'p2', kind: 'neg_points', value: [0, 0, 0] });
  await h.editor.run();
  expect(h.infer.mock.calls[1][0].sessionToken).toBe('token');
  expect(h.infer.mock.calls[1][1]).toBeUndefined();
  expect(h.infer.mock.calls[1][2].map(p => p.uid)).toEqual(['p2']);
  h.pixels[3] = 1;
  h.editor.changed('B');
  await h.editor.run();
  expect(h.infer.mock.calls[2][1]).toEqual(new Uint8Array([1, 0, 0, 1]));
});

test.each(['switch', 'brush', 'delete', 'switch-away-and-back', 'reset'])('stale %s response cannot write pixels', async mode => {
  const h = harness();
  const entered = deferred(), finish = deferred();
  h.infer.mockImplementation(async context => {
    entered.resolve(); await finish.promise;
    return { pixels: new Uint8Array([1, 1, 1, 1]), context: { ...context, sessionToken: 't' }, shape: context.shape };
  });
  const run = h.editor.run();
  await entered.promise;
  const original = h.target();
  if (mode === 'brush') { h.pixels[3] = 1; h.editor.changed('B'); }
  else if (mode === 'reset') h.editor.reset();
  else {
    h.setTarget(mode === 'delete' ? undefined : { ...original, segmentationId: 'A' });
    if (mode === 'switch-away-and-back') h.setTarget(original);
  }
  finish.resolve(); await run;
  expect(h.commit).not.toHaveBeenCalled();
  expect(Array.from(h.pixels)).toEqual(mode === 'brush' ? [0, 0, 0, 1] : [0, 0, 0, 0]);
});

test('restarted backend gets one seed retry, never a fallback old mask', async () => {
  const h = harness();
  await h.editor.run();
  h.addPrompt({ uid: 'p2', kind: 'neg_points', value: [1, 1, 0] });
  h.infer.mockRejectedValueOnce(Object.assign(new Error('resync'), { code: 'NN_RESYNC_REQUIRED' }));
  await h.editor.run();
  expect(h.infer).toHaveBeenCalledTimes(3);
  expect(h.infer.mock.calls[1][1]).toBeUndefined();
  expect(h.infer.mock.calls[2][1]).toEqual(new Uint8Array([1, 0, 0, 0]));
  expect(h.infer.mock.calls[2][2].map(p => p.uid)).toEqual(['p2']);
});

test('new live prompts coalesce behind one in-flight request', async () => {
  const h = harness();
  const entered = deferred(), finish = deferred();
  h.infer.mockImplementationOnce(async context => {
    entered.resolve(); await finish.promise;
    return { pixels: new Uint8Array([1, 0, 0, 0]), context: { ...context, sessionToken: 'token' }, shape: context.shape };
  });
  const first = h.editor.run(); await entered.promise;
  h.addPrompt({ uid: 'p2', kind: 'pos_points', value: [1, 0, 0] });
  h.editor.run();
  h.addPrompt({ uid: 'p3', kind: 'neg_points', value: [1, 1, 0] });
  h.editor.run();
  expect(h.infer).toHaveBeenCalledTimes(1);
  finish.resolve(); await first;
  expect(h.infer).toHaveBeenCalledTimes(2);
  expect(h.infer.mock.calls[1][2].map(p => p.uid)).toEqual(['p2', 'p3']);
});
