import { FrameWorkerPool } from './frameWorkerPool.mjs';

/** Termination cancels decompression, parsing and queued results as one operation. */
export function parseInWorker(file: Blob, options = {}, signal?: AbortSignal, progress = (_: number) => {}, beforeAllocate?) {
  return runWorker(() => new Worker(new URL('./parse.worker.js', import.meta.url)), { file, options }, [], signal, progress, beforeAllocate);
}

export function alignInWorker(scalarData, dimensions, inputDimensions, map, label, signal?) {
  return runWorker(() => new Worker(new URL('./align.worker.js', import.meta.url)),
    { scalarData, dimensions, inputDimensions, map, label }, [scalarData.buffer], signal);
}

export function createFrameDecoder() {
  return new FrameWorkerPool(() => new Worker(new URL('./frame.worker.js', import.meta.url)));
}

function runWorker(createWorker: () => Worker, payload, transfer: Transferable[], signal?: AbortSignal, progress = (_: number) => {}, beforeAllocate?) {
  return new Promise<any>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = createWorker();
    const timeout = setTimeout(() => finish(new Error('NIfTI 解析超时，请重试。')), 5 * 60 * 1000);
    const finish = (error?, value?) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessageerror = () => finish(new Error('NIfTI worker 返回数据失败，请重试。'));
    worker.onmessage = ({ data }) => {
      if (data.allocation) {
        try { beforeAllocate?.(data.allocation); worker.postMessage({ allocationApproved: true }); }
        catch (error) { finish(error); }
      } else if (data.error) finish(Object.assign(new Error(data.error.message), { code: data.error.code }));
      else if (data.result) finish(null, data.result);
      else if (data.progress !== undefined) progress(data.progress);
    };
    try { worker.postMessage(payload, transfer); } catch (error) { finish(error); }
  });
}
