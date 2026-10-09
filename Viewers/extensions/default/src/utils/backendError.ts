/** Read only small error payloads; never retain/decode a segmentation volume. */
export function backendErrorMessage(error: any): string {
  let payload = error?.response?.data;
  try {
    if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
      if (payload.byteLength > 16384) return String(error?.message || 'Request failed').slice(0, 500);
      const bytes = payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      payload = new TextDecoder().decode(bytes);
    }
    if (typeof payload === 'string') {
      payload = payload.length <= 16384 ? JSON.parse(payload) : undefined;
    }
    const detail = payload?.detail ?? payload;
    const message = typeof detail === 'string' ? detail : detail?.message;
    return String(message || error?.message || 'Request failed').slice(0, 500);
  } catch {
    return String(error?.message || 'Request failed').slice(0, 500);
  }
}
