import { TextDecoder, TextEncoder } from 'util';
import { backendErrorMessage } from './backendError';

globalThis.TextDecoder = TextDecoder;

describe('backendErrorMessage', () => {
  test('reads a structured model error from an arraybuffer', () => {
    // util.TextEncoder creates a Node-realm buffer; construct the browser-realm payload.
    const data = Uint8Array.from(new TextEncoder().encode(JSON.stringify({ code: 'MODEL_DISABLED', message: 'Model disabled' })));
    expect(backendErrorMessage({ response: { data: data.buffer } })).toBe('Model disabled');
  });
  test('reads the source DICOM error detail used by Save Draft', () => {
    expect(backendErrorMessage({ response: { data: { detail: { message: 'Source unavailable' } } } })).toBe('Source unavailable');
  });
  test('does not decode large binary payloads', () => {
    expect(backendErrorMessage({ message: 'HTTP 503', response: { data: new Uint8Array(20000) } })).toBe('HTTP 503');
  });
  test('malformed response retains the safe fallback', () => {
    expect(backendErrorMessage({ message: 'Network error', response: { data: '<html>error</html>' } })).toBe('Network error');
  });
  test('honors a typed-array subview offset', () => {
    const bytes = new TextEncoder().encode('xx{"message":"subview"}yy');
    expect(backendErrorMessage({ response: { data: bytes.subarray(2, bytes.length - 2) } })).toBe('subview');
  });
});
