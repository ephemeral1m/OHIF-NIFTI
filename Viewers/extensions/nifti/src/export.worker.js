import { gzipSync, zipSync, strToU8 } from 'fflate';

function encodeMask(pixels, descriptor) {
  const buffer = new ArrayBuffer(352 + pixels.length);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true); view.setInt16(40, 3, true);
  descriptor.dimensions.forEach((n, i) => view.setInt16(42 + i*2, n, true));
  for (let i = 4; i < 8; i++) view.setInt16(40 + i*2, 1, true);
  view.setInt16(70, 2, true); view.setInt16(72, 8, true);
  view.setFloat32(76, 1, true);
  [0, 1, 2].forEach(c => view.setFloat32(80 + c*4, Math.hypot(...descriptor.affine.slice(0, 3).map(row => row[c])), true));
  view.setFloat32(108, 352, true); view.setFloat32(112, 1, true);
  view.setUint8(123, { m: 1, mm: 2, um: 3 }[descriptor.unit]);
  view.setInt16(254, 1, true);
  descriptor.affine.slice(0, 3).flat().forEach((v, i) => view.setFloat32(280 + i*4, v, true));
  new Uint8Array(buffer, 344, 4).set([110, 43, 49, 0]);
  new Uint8Array(buffer, 352).set(pixels);
  return gzipSync(new Uint8Array(buffer));
}
self.onmessage = ({ data: { masks, descriptor } }) => {
  try {
    const files = {};
    const manifest = [];
    for (let i = 0; i < masks.length; i++) {
      const { pixels, ...metadata } = masks[i];
      const filename = `mask-${i + 1}.nii.gz`;
      files[filename] = encodeMask(pixels, descriptor);
      manifest.push({ ...metadata, file: filename });
    }
    files['manifest.json'] = strToU8(JSON.stringify({ source: descriptor, masks: manifest }, null, 2));
    const result = zipSync(files, { level: 0 });
    self.postMessage({ result }, [result.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
