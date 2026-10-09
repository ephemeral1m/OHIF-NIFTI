import { decodeBlob, geometryKey, sha256, contentHash as hashContent } from './format.mjs';

self.onmessage = async ({ data: { file, options } }) => {
  if (!file) return;
  try {
    const parsed = await decodeBlob(file, options, value => self.postMessage({ progress: value }), header =>
      new Promise(resolve => {
        const approved = ({ data }) => {
          if (!data.allocationApproved) return;
          self.removeEventListener('message', approved); resolve();
        };
        self.addEventListener('message', approved);
        self.postMessage({ allocation: { offset: header.offset, sourceBytes: header.sourceBytes, workingBytes: header.workingBytes } });
      }));
    const geometryHash = await sha256(new TextEncoder().encode(geometryKey(parsed.dimensions, parsed.voxelToLPS)));
    const contentHash = await hashContent(parsed.scalarData, geometryHash);
    const { scalarData, ...descriptor } = parsed;
    self.postMessage({ result: { descriptor: { ...descriptor, geometryHash, contentHash, hashVersion: 1 }, scalarData } }, [scalarData.buffer]);
  } catch (error) {
    self.postMessage({ error: { code: error.code || 'NIFTI_PARSE', message: error.message } });
  }
};
