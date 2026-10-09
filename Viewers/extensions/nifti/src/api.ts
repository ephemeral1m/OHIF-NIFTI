import { config, reserve, release } from './sourceStore';

export const apiRoot = () => config.niftiApiRoot || '/monai/nifti-images';
export async function openManifestCase(payload, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await (await request('/manifest/open', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json(); }
    catch (error) {
      if (error.status !== 429 || attempt >= 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
export async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(apiRoot() + path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body?.detail?.message || body?.detail || `NIfTI request failed (${response.status}).`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response;
}

export async function downloadSource(id: string, signal?: AbortSignal, progress = (_: number) => {}) {
  const path = '/' + encodeURIComponent(id);
  const descriptor = await (await request(path + '/metadata', { signal })).json();
  const response = await request(path + '/file', { signal });
  const limit = 514 * 1024 ** 2;
  const size = Number(response.headers.get('content-length'));
  if (size > limit) { await response.body?.cancel(); throw new Error('NIfTI download exceeds the limit.'); }
  const reader = response.body.getReader();
  const allocation = `nifti-download:${crypto.randomUUID()}`;
  const chunks = []; let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) throw new Error('NIfTI download exceeds the limit.');
      // Account for both network chunks and the immutable File made from them.
      reserve(allocation, received * 2);
      chunks.push(value); progress(size ? received / size : 0);
    }
    return { descriptor, file: new File(chunks, descriptor.name) };
  } finally { chunks.length = 0; release(allocation); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function upload(path: string, form: FormData, signal?: AbortSignal, progress = (_: number) => {}) {
  return new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const finish = (error?, value?) => {
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    xhr.open('POST', apiRoot() + path);
    xhr.withCredentials = true;
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded / e.total); };
    xhr.onerror = () => finish(new Error('NIfTI network request failed. Your local edits are retained.'));
    xhr.ontimeout = () => finish(new Error('NIfTI upload timed out. Your local edits are retained.'));
    xhr.onabort = () => finish(new DOMException('Cancelled', 'AbortError'));
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { finish(new Error(`Invalid server response (${xhr.status}).`)); return; }
      if (xhr.status < 200 || xhr.status >= 300) finish(new Error(data?.detail?.message || data?.detail || `Upload failed (${xhr.status}).`));
      else finish(null, data);
    };
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(form);
  });
}

/** Bounded download with an idle deadline, including response-body stalls. */
export async function downloadMask(path: string, signal?: AbortSignal, progress = (_: string) => {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  let timer, reader, timedOut = false;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, 90000); };
  const owner = `nifti-mask-download:${crypto.randomUUID()}`, chunks = [];
  let received = 0;
  try {
    reset();
    const response = await request(path, { signal: controller.signal });
    const size = Number(response.headers.get('content-length'));
    const limit = 514 * 1024 ** 2;
    if (size > limit) throw Error('Mask 下载超过 514 MiB 限制。');
    reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reset(); received += value.byteLength;
      if (received > limit) throw Error('Mask 下载超过 514 MiB 限制。');
      reserve(owner, received * 2); chunks.push(value);
      progress(size ? `下载 ${Math.round(received / size * 100)}%` : `下载 ${(received / 1024 ** 2).toFixed(1)} MiB`);
    }
    return new Blob(chunks);
  } catch (error) {
    if (timedOut) throw Error('Mask 下载连续 90 秒无响应，已停止。可重新加载，当前编辑已保留。');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort(); await reader?.cancel().catch(() => {}); reader?.releaseLock();
    chunks.length = 0; release(owner);
  }
}

export async function ensureStored(source, signal?, progress?) {
  if (source.descriptor.sourceId) return source.descriptor;
  if (!config.enableNiftiLibrary) throw new Error('NIfTI library is disabled.');
  const form = new FormData();
  form.append('file', source.file);
  form.append('unit', source.descriptor.unit);
  form.append('modality', source.descriptor.modality);
  const descriptor = await upload('', form, signal, progress);
  if (descriptor.geometryHash !== source.descriptor.geometryHash) throw new Error('Server and viewer geometry differ. Update both components before continuing.');
  if (descriptor.contentHash !== source.descriptor.contentHash) throw new Error('Server and viewer voxel identity differ. Update both components before continuing.');
  // Preserve the already-parsed source allocation and its internal viewport IDs.
  Object.assign(source.descriptor, descriptor);
  const url = new URL(window.location.href);
  if (url.pathname.includes('nifti-viewer')) {
    url.searchParams.set('sourceId', descriptor.sourceId);
    window.history.replaceState(window.history.state, '', url);
  }
  return descriptor;
}
