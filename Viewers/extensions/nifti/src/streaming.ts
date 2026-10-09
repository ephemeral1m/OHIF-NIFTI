import { FrameQueue } from './frameQueue.mjs';
import { scalarTypes, dtypeName } from './frameCodec.mjs';
import { createFrameDecoder } from './workerClient';
import { request } from './api';
import { reserve, release } from './sourceStore';

export async function prepareStreaming(id, descriptor, signal, progress) {
  const started = performance.now();
  let state = await (await request(`/${id}/stream/prepare`, { method: 'POST', signal })).json();
  while (true) {
    signal?.throwIfAborted();
    if (state.state === 'failed') throw Error(state.error.message);
    if (state.state === 'ready') {
      const d = state.descriptor;
      if (d.version !== 1 || !d.preScaled || d.sourceId !== id || d.contentHash !== descriptor.contentHash
          || d.geometryHash !== descriptor.geometryHash || JSON.stringify(d.dimensions) !== JSON.stringify(descriptor.dimensions)
          || d.unit !== descriptor.unit || JSON.stringify(d.voxelToLPS) !== JSON.stringify(descriptor.voxelToLPS)
          || d.workingDtype !== descriptor.workingDtype || d.frames.length !== descriptor.dimensions[2]
          || !scalarTypes[dtypeName(d.wireDtype)] || !scalarTypes[dtypeName(d.workingDtype)]) {
        throw Error('NIfTI 渐进加载协议或原图身份不匹配，请成套更新前后端。');
      }
      const length = descriptor.dimensions[0] * descriptor.dimensions[1] * scalarTypes[dtypeName(d.wireDtype)].BYTES_PER_ELEMENT;
      if (d.frames.some(f => f.bytes !== length || !/^[a-f0-9]{64}$/.test(f.sha256))) throw Error('Invalid NIfTI frame geometry.');
      return d;
    }
    if (performance.now() - started > 5 * 60 * 1000) throw Error('原图缓存准备超时，请重试。');
    progress(state.state === 'queued' ? '等待准备原图缓存…' : '正在准备原图缓存…');
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
      signal?.addEventListener('abort', abort, { once: true });
    });
    state = await (await request(`/${id}/stream`, { signal, cache: 'no-store' })).json();
  }
}

async function downloadFrame(source, index, signal) {
  const started = performance.now();
  const d = source.stream.descriptor, frame = d.frames[index];
  // A cancelled job and its new subscriber can overlap during cleanup.
  const owner = `${source.sourceKey}:frame:${index}:${++source.stream.requestSequence}`;
  reserve(owner, frame.bytes * 4 + source.descriptor.dimensions[0] * source.descriptor.dimensions[1] * source.scalarData.BYTES_PER_ELEMENT + 65536);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason); signal.addEventListener('abort', abort, { once: true });
  const timeout = () => controller.abort(new DOMException('切片下载超时，请重试。', 'TimeoutError'));
  const total = setTimeout(timeout, 180000); let idle = setTimeout(timeout, 60000), reader;
  try {
    signal.throwIfAborted();
    const response = await request(`/${source.descriptor.sourceId}/frames/${index}`, { signal: controller.signal, cache: 'no-store' });
    if (response.headers.get('X-Nifti-Cache-Key') !== d.cacheKey || response.headers.get('X-Nifti-Frame') !== String(index)) throw Error('NIfTI frame identity mismatch.');
    const bound = frame.bytes + Math.ceil(frame.bytes / 16384) * 6 + 1024;
    if (Number(response.headers.get('content-length')) > bound) throw Error('NIfTI compressed frame exceeds its limit.');
    reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      clearTimeout(idle); idle = setTimeout(timeout, 60000);
      size += value.length; if (size > bound) throw Error('NIfTI compressed frame exceeds its limit.');
      chunks.push(value);
    }
    const networkEnd = performance.now();
    const pixels = await source.stream.decoder.decode(new Blob(chunks), d, frame, controller.signal);
    if (source.stream.disposed || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const offset = index * source.descriptor.dimensions[0] * source.descriptor.dimensions[1];
    source.scalarData.set(pixels, offset);
    source.stream.loaded[index] = 1; source.stream.errors.delete(index);
    source.stream.timings[index] = { bytes: size, networkMs: Math.round(networkEnd - started), decodeMs: Math.round(performance.now() - networkEnd) };
  } catch (error) {
    if (controller.signal.reason?.name === 'TimeoutError') throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(total); clearTimeout(idle); signal.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {}); reader?.releaseLock(); release(owner);
  }
}

export function createStream(source, descriptor) {
  const state: any = { descriptor, loaded: new Uint8Array(descriptor.frames.length), errors: new Map(), timings: [], disposed: false, completing: 0, requestSequence: 0 };
  source.stream = state; state.decoder = createFrameDecoder();
  state.queue = new FrameQueue(state.loaded.length, async (index, signal) => {
    try {
      for (let attempt = 0; ; attempt++) {
        try { await downloadFrame(source, index, signal); return; }
        catch (error) {
          if (signal.aborted || attempt >= 2 || !(error.name === 'TimeoutError' || error instanceof TypeError
              || error.status === 425 || error.status === 429 || (error.status >= 500 && error.status <= 504)
              || /429|425|50[0-9]|繁忙|缓存正在|重新生成/.test(error.message))) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    } catch (error) { if (error.name !== 'AbortError') state.errors.set(index, error.message); throw error; }
  }, index => !!state.loaded[index]);
  state.dispose = () => { state.disposed = true; state.queue.close(); state.decoder.dispose(); };
  return state;
}

export async function ensureSlice(source, index, signal?, kind = 'interactive') {
  if (source.stream) {
    // Free old background transfers as soon as navigation starts, before paint.
    if (kind === 'interactive' && !source.stream.completing && !signal?.aborted) source.stream.queue.cancelObsolete(index);
    await source.stream.queue.ensure(index, kind, signal);
  }
}
export async function ensureComplete(source, signal?) {
  if (source.stream?.disposed) throw new DOMException('Cancelled', 'AbortError');
  if (!source.stream || source.stream.loaded.every(Boolean)) return;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  source.stream.completing++;
  try { await Promise.all([...source.stream.loaded].map((_, index) => ensureSlice(source, index, controller.signal, 'complete'))); }
  finally { controller.abort(); signal?.removeEventListener('abort', abort); source.stream.completing--; }
}

export function requestComplete(source) {
  if (!source.stream) return Promise.resolve();
  const state = source.stream;
  if (state.completion) return state.completion;
  const controller = new AbortController(); state.completeController = controller;
  state.completion = ensureComplete(source, controller.signal).finally(() => {
    state.completion = undefined; state.completeController = undefined;
  });
  return state.completion;
}

export function displayedSliceReady(viewport) {
  const requested = viewport?.getCurrentImageId?.();
  const actual = viewport?.getCornerstoneImage?.()?.imageId;
  return !requested?.startsWith('nifti:') || requested === actual;
}
