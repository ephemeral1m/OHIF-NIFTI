// Lossless permutation/flip of an already validated grid. Ownership is
// transferred both ways so large masks remain cancellable without extra copies.
self.onmessage = ({ data: { scalarData, dimensions, inputDimensions, map, label } }) => {
  try {
    const [nx, ny, nz] = dimensions, [mx, my] = inputDimensions;
    const binary = new Uint8Array(nx * ny * nz);
    const stride = [1, mx, mx * my];
    const start = stride.reduce((v, s, r) => v + s * map[r][3], 0);
    const step = [0, 1, 2].map(c => stride.reduce((v, s, r) => v + s * map[r][c], 0));
    let index = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      let input = start + k * step[2] + j * step[1];
      for (let i = 0; i < nx; i++, index++, input += step[0]) binary[index] = scalarData[input] === label ? 1 : 0;
    }
    self.postMessage({ result: { scalarData, binary } }, [scalarData.buffer, binary.buffer]);
  } catch (error) { self.postMessage({ error: { message: error.message } }); }
};
