import { decodeFrame } from './frameCodec.mjs';
self.onmessage = async ({ data }) => {
  try {
    const scalarData = await decodeFrame(data.file, data.wireDtype, data.workingDtype, data.frame);
    self.postMessage({ result: scalarData }, [scalarData.buffer]);
  } catch (error) { self.postMessage({ error: { message: error.message } }); }
};
