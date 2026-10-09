const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/@cornerstonejs/labelmap-interpolation');
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '3.33.5') throw Error('Interpolation patch requires 3.33.5');
function patch(relative, before, after) {
  const file = path.join(root, relative), source = fs.readFileSync(file, 'utf8');
  if (source.includes(after)) return;
  if (!source.includes(before)) throw Error('Unexpected interpolation runtime: ' + relative);
  fs.writeFileSync(file, source.replace(before, after));
}
patch('dist/esm/workers/interpolationWorker.js',
  'const { outputImage } = await itkModule.morphologicalContourInterpolation(inputImage, {',
  'itkModule.setPipelinesBaseUrl(configuration.pipelinesBaseUrl);\n            const { outputImage } = await itkModule.morphologicalContourInterpolation(inputImage, {');
patch('dist/esm/workers/interpolationWorker.js',
  "console.warn('Warning: Failed to perform morphological contour interpolation');\n            return { data: scalarData };",
  "console.warn('Warning: Failed to perform morphological contour interpolation');\n            throw error;");
patch('dist/esm/utilities/interpolateLabelmap.js',
  "console.warn('Warning: Failed to perform morphological contour interpolation', error);\n        triggerWorkerProgress(eventTarget, 100);",
  "console.warn('Warning: Failed to perform morphological contour interpolation', error);\n        triggerWorkerProgress(eventTarget, 100);\n        throw error;");
console.log('Interpolation 3.33.5: same-origin pipeline configuration and error propagation installed.');
