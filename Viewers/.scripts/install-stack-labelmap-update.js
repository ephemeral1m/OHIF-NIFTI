const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const tools = path.join(root, 'node_modules/@cornerstonejs/tools');
if (JSON.parse(fs.readFileSync(path.join(tools, 'package.json'), 'utf8')).version !== '3.33.5') {
  throw new Error('Stack labelmap update patch requires @cornerstonejs/tools 3.33.5');
}
fs.copyFileSync(path.join(__dirname, 'stack-labelmap-update.js'),
  path.join(tools, 'dist/esm/eventListeners/segmentation/labelmap/performStackLabelmapUpdate.js'));
console.log('Installed identity-based Stack labelmap update patch (3.33.5).');
