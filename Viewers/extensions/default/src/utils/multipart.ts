// multipart.ts
// Optional fallback (uncomment the import and the line in gunzip() if you install pako):
// import { ungzip as pakoUngzip } from 'pako';

function uint8ToString(u8: Uint8Array): string {
  return new TextDecoder('utf-8').decode(u8);
}

function matchesAt(data: Uint8Array, pattern: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + pattern.length > data.length) {
    return false;
  }
  for (let index = 0; index < pattern.length; index++) {
    if (data[offset + index] !== pattern[index]) {
      return false;
    }
  }
  return true;
}

function findCRLFCRLF(data: Uint8Array, start = 0, end = data.length): number {
  for (let index = start; index + 3 < end; index++) {
    if (
      data[index] === 13 &&
      data[index + 1] === 10 &&
      data[index + 2] === 13 &&
      data[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function findPattern(data: Uint8Array, pattern: Uint8Array, start = 0, end = data.length): number {
  for (let index = start; index + pattern.length <= end; index++) {
    if (matchesAt(data, pattern, index)) {
      return index;
    }
  }
  return -1;
}

function parseHeaders(headerStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerStr.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > -1) {
      out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  }
  return out;
}

function getBoundary(contentType: string | null): string {
  if (!contentType) {
    throw new Error('Missing Content-Type');
  }
  const match = /boundary=([^;]+)/i.exec(contentType);
  if (!match) {
    throw new Error('No boundary in Content-Type');
  }
  return match[1].replace(/^"(.*)"$/, '$1');
}

async function gunzip(buf: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const DecompressionStreamConstructor: any = (globalThis as any).DecompressionStream;
  if (typeof DecompressionStreamConstructor === 'function') {
    const decompressionStream = new DecompressionStreamConstructor('gzip');
    const stream = new Blob([u8]).stream().pipeThrough(decompressionStream);
    const arrayBuffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  // Fallback: use pako if you installed it
  // return pakoUngzip(u8);
  throw new Error('Gzip content received but no DecompressionStream (install pako for fallback).');
}

async function gunzipIfNeeded(
  u8: Uint8Array,
  headers: Record<string, string>
): Promise<Uint8Array> {
  const encoding = (headers['content-encoding'] || '').toLowerCase();
  return encoding.includes('gzip') ? gunzip(u8) : u8;
}

/** If the WHOLE HTTP response is gzipped, decompress it before parsing multipart. */
export async function maybeGunzipWholeResponse(
  bodyBuf: ArrayBuffer,
  responseHeaders: Record<string, string | string[] | undefined>
): Promise<ArrayBuffer> {
  const encoding = (responseHeaders['content-encoding'] || '').toString().toLowerCase();
  if (!encoding.includes('gzip')) {
    return bodyBuf;
  }

  const u8 = new Uint8Array(bodyBuf);
  const looksGzip = u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  if (!looksGzip) {
    return bodyBuf;
  }

  const unzipped = await gunzip(u8);
  return unzipped.buffer;
}

/**
 * Parse a multipart/form-data response without copying uncompressed part bodies.
 * Per-part gzip data is represented by the single unavoidable decompressed buffer.
 */
export async function parseMultipart(
  bodyBuf: ArrayBuffer,
  contentType: string
): Promise<{ meta: any; seg: Uint8Array }> {
  const boundary = getBoundary(contentType);
  const data = new Uint8Array(bodyBuf);
  const encoder = new TextEncoder();
  const boundaryBytes = encoder.encode(`--${boundary}`);
  const finalBoundaryBytes = encoder.encode(`--${boundary}--`);
  const nextMarker = encoder.encode(`\r\n--${boundary}`);
  const partRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  while (cursor < data.length) {
    if (data[cursor] === 13 && data[cursor + 1] === 10) {
      cursor += 2;
    }
    if (matchesAt(data, finalBoundaryBytes, cursor)) {
      break;
    }
    if (!matchesAt(data, boundaryBytes, cursor)) {
      cursor++;
      continue;
    }

    let partStart = cursor + boundaryBytes.length;
    if (data[partStart] === 13 && data[partStart + 1] === 10) {
      partStart += 2;
    }
    if (findCRLFCRLF(data, partStart) < 0) {
      break;
    }

    const partEnd = findPattern(data, nextMarker, partStart);
    partRanges.push({
      start: partStart,
      end: partEnd === -1 ? data.length : partEnd,
    });
    cursor = partEnd === -1 ? data.length : partEnd + 2;
  }

  let metaObj: any = null;
  let seg = new Uint8Array(0);

  for (let rangeIndex = 0; rangeIndex < partRanges.length; rangeIndex++) {
    const range = partRanges[rangeIndex];
    const headerEnd = findCRLFCRLF(data, range.start, range.end);
    if (headerEnd < 0) {
      continue;
    }

    const headers = parseHeaders(uint8ToString(data.subarray(range.start, headerEnd)));
    let bodyStart = headerEnd + 4;
    let body = data.subarray(bodyStart, range.end);

    const headProbe = uint8ToString(body.subarray(0, 16));
    if (/^Content-\w+/i.test(headProbe)) {
      const leakedHeaderEnd = findCRLFCRLF(data, bodyStart, range.end);
      if (leakedHeaderEnd > -1) {
        const leakedHeaders = parseHeaders(
          uint8ToString(data.subarray(bodyStart, leakedHeaderEnd))
        );
        Object.assign(headers, leakedHeaders);
        bodyStart = leakedHeaderEnd + 4;
        body = data.subarray(bodyStart, range.end);
      }
    }

    const contentDisposition = headers['content-disposition'] || '';
    const nameMatch = /name="([^"]+)"/i.exec(contentDisposition);
    const name = nameMatch ? nameMatch[1] : '';
    const contentTypeHeader = (headers['content-type'] || '').toLowerCase();

    if (name === 'meta' && contentTypeHeader.includes('application/json')) {
      const unzipped = await gunzipIfNeeded(body, headers);
      try {
        metaObj = JSON.parse(uint8ToString(unzipped));
      } catch (error) {
        const preview = uint8ToString(unzipped.subarray(0, 24));
        throw new Error(`Failed to parse meta JSON (starts with: ${JSON.stringify(preview)})`);
      }
    } else if (name === 'seg' && contentTypeHeader.includes('application/octet-stream')) {
      seg = await gunzipIfNeeded(body, headers);
    }
  }

  if (!metaObj) {
    throw new Error('meta part not found');
  }
  if (!seg.length) {
    throw new Error('seg part not found');
  }

  return { meta: metaObj, seg };
}
