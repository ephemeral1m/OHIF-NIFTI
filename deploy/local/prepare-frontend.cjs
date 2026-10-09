const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = '/usr/src/app';
const inputs = ['package.json', 'yarn.lock'];
for (const parent of ['platform', 'extensions', 'modes', 'addOns/externals']) {
  for (const child of fs.readdirSync(path.join(root, parent))) {
    const relative = `${parent}/${child}/package.json`;
    if (fs.existsSync(path.join(root, relative))) inputs.push(relative);
  }
}
const digest = crypto.createHash('sha256');
for (const input of inputs.sort()) digest.update(input).update(fs.readFileSync(path.join(root, input)));
const fingerprint = digest.digest('hex');
const marker = path.join(root, 'node_modules/.ohif-local-dependencies');
if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== fingerprint) {
  console.log('Installing locked OHIF development dependencies.');
  execFileSync('yarn', ['install', '--frozen-lockfile', '--network-concurrency', '2', '--network-timeout', '120000'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, GITHUB_TOKEN: '' },
  });
}
// Apply the same project replacements as the established image recipe.
const recipe = fs.readFileSync(path.join(root, 'platform/app/.recipes/Nginx-Orthanc/dockerfile'), 'utf8');
for (const line of recipe.split(/\r?\n/)) {
  const match = line.match(/^COPY \.\/backup\/(\S+) (\/usr\/src\/app\/node_modules\/\S+)/);
  if (!match) continue;
  const source = path.join(root, 'backup', match[1]);
  const target = match[2].endsWith('/') ? path.join(match[2], path.basename(source)) : match[2];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
for (const script of ['install-stack-labelmap-update.js', 'install-interpolation-runtime.js', 'verify-cornerstone-stack-labelmap-patch.js']) {
  execFileSync('node', [path.join(root, '.scripts', script)], { cwd: root, stdio: 'inherit' });
}
fs.writeFileSync(marker, fingerprint);
console.log('OHIF development dependencies and Cornerstone patches are ready.');
