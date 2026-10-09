// @ts-nocheck
import { gzipSync } from 'zlib';
import { DecompressionStream as NodeDecompressionStream } from 'stream/web';
import { Blob as NodeBlob } from 'buffer';
import { TextDecoder, TextEncoder } from 'util';

globalThis.TextDecoder = TextDecoder;
globalThis.TextEncoder = TextEncoder;

const encoder = new TextEncoder();
const { parseMultipart } = require('./multipart');

function concat(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function createMultipart({ seg, gzipSeg = false }) {
  const boundary = 'ohif-memory-test';
  const meta = encoder.encode(JSON.stringify({ label_name: 'test' }));
  const segBody = gzipSeg ? new Uint8Array(gzipSync(seg)) : seg;
  const segEncoding = gzipSeg ? 'Content-Encoding: gzip\r\n' : '';
  const body = concat([
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n`
    ),
    meta,
    encoder.encode(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="seg"\r\nContent-Type: application/octet-stream\r\n${segEncoding}\r\n`
    ),
    segBody,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('parseMultipart', () => {
  beforeAll(() => {
    globalThis.Blob = NodeBlob;
    if (!globalThis.DecompressionStream) {
      globalThis.DecompressionStream = NodeDecompressionStream;
    }
    globalThis.Response = class TestResponse {
      constructor(stream) {
        this.stream = stream;
      }

      async arrayBuffer() {
        const reader = this.stream.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
          total += value.byteLength;
        }
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result.buffer;
      }
    };
  });

  test('returns an uncompressed segmentation as a view of the response buffer', async () => {
    const seg = new Uint8Array([0, 1, 0, 1, 1]);
    const multipart = createMultipart({ seg });

    const parsed = await parseMultipart(multipart.body.buffer, multipart.contentType);

    expect(Array.from(parsed.seg)).toEqual(Array.from(seg));
    expect(parsed.seg.buffer).toBe(multipart.body.buffer);
  });

  test('returns one correct decompressed segmentation buffer for gzip parts', async () => {
    const seg = new Uint8Array(1024 * 1024);
    seg[12] = 1;
    seg[seg.length - 1] = 1;
    const multipart = createMultipart({ seg, gzipSeg: true });

    const parsed = await parseMultipart(multipart.body.buffer, multipart.contentType);

    expect(parsed.seg.byteLength).toBe(seg.byteLength);
    expect(parsed.seg[12]).toBe(1);
    expect(parsed.seg[seg.length - 1]).toBe(1);
    expect(parsed.seg.buffer).not.toBe(multipart.body.buffer);
  });
});
