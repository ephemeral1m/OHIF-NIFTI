const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const toolsRoot = path.join(root, 'node_modules', '@cornerstonejs', 'tools');
const packageJsonPath = path.join(toolsRoot, 'package.json');
const listenerPath = path.join(
  toolsRoot,
  'dist',
  'esm',
  'eventListeners',
  'segmentation',
  'imageChangeEventListener.js'
);
const disposerPath = path.join(
  toolsRoot,
  'dist',
  'esm',
  'tools',
  'displayTools',
  'Labelmap',
  'disposeStackLabelmapActors.js'
);
const removalPath = path.join(
  toolsRoot,
  'dist',
  'esm',
  'tools',
  'displayTools',
  'Labelmap',
  'removeLabelmapFromElement.js'
);

function fail(message) {
  console.error(`[Cornerstone stack labelmap patch] ${message}`);
  process.exitCode = 1;
}

for (const requiredPath of [packageJsonPath, listenerPath, disposerPath, removalPath]) {
  if (!fs.existsSync(requiredPath)) {
    fail(`Missing required file: ${path.relative(root, requiredPath)}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const listener = fs.readFileSync(listenerPath, 'utf8');
const disposer = fs.readFileSync(disposerPath, 'utf8');
const removal = fs.readFileSync(removalPath, 'utf8');
for (const file of ['labelmapDisplay.js', 'addLabelmapToElement.js']) {
  const installed = fs.readFileSync(path.join(toolsRoot, 'dist/esm/tools/displayTools/Labelmap', file), 'utf8').replace(/\r\n/g, '\n');
  const expected = fs.readFileSync(path.join(root, 'backup/esm', file), 'utf8').replace(/\r\n/g, '\n');
  if (installed !== expected) fail(`Stack rendering replacement is stale: ${file}`);
}
const updatePath = path.join(toolsRoot, 'dist/esm/eventListeners/segmentation/labelmap/performStackLabelmapUpdate.js');
if (!fs.existsSync(updatePath) || fs.readFileSync(updatePath, 'utf8') !== fs.readFileSync(path.join(__dirname, 'stack-labelmap-update.js'), 'utf8')) {
  fail('Identity-based Stack data update patch is missing or differs from the project source');
}

if (packageJson.version !== '3.33.5') {
  fail(`Expected @cornerstonejs/tools 3.33.5, found ${packageJson.version}`);
}

if (!listener.includes('function updateStableActor')) {
  fail('Stable stack labelmap actor update is missing');
}

if (!listener.includes('disposeStackLabelmapActors')) {
  fail('Stack labelmap actor disposal is not wired into the image-change listener');
}

if (listener.includes('values: new constructor(newPixelData)')) {
  fail('Legacy per-slice labelmap scalar copy is still present');
}

if (!disposer.includes('viewport.removeActors') || !disposer.includes('safeDelete(imageData)')) {
  fail('VTK actor disposal helper is incomplete');
}

if (!removal.includes('getLabelmapActorEntries') || removal.includes('getLabelmapActorUID')) {
  fail('Representation removal still handles only one labelmap actor');
}

if (!removal.includes('viewport instanceof BaseVolumeViewport')) {
  fail('Volume labelmap removal is not protected from stack-only VTK disposal');
}

if (!process.exitCode) {
  console.log('[Cornerstone stack labelmap patch] verified @cornerstonejs/tools 3.33.5');
}
