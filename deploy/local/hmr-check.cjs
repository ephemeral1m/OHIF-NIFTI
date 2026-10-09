/* Verify source watching and browser hot updates; restore source bytes afterward. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const target = path.join(root, 'Viewers/extensions/nifti/src/Gateway.tsx');
const original = fs.readFileSync(target);
const marker = Buffer.from('\n// Temporary local development hot-update verification.\n');
const modified = Buffer.concat([original, marker]);
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const report = { passed: false, errors: [], updates: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => {
    if (/webpack-dev-server|\[HMR\]/.test(message.text())) report.updates.push(message.text());
  });
  let changed = false;
  try {
    await page.goto('http://127.0.0.1:1026/nifti', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
    const update = page.waitForResponse(response => response.url().endsWith('.hot-update.json'), { timeout: 60000 });
    fs.writeFileSync(target, modified);
    changed = true;
    assert.equal((await update).status(), 200);
    const restoreUpdate = page.waitForResponse(response => response.url().endsWith('.hot-update.json'), { timeout: 60000 });
    assert(fs.readFileSync(target).equals(modified), 'Source changed concurrently; do not overwrite it');
    fs.writeFileSync(target, original);
    changed = false;
    assert.equal((await restoreUpdate).status(), 200);
    await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
    assert(fs.readFileSync(target).equals(original));
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    if (changed && fs.readFileSync(target).equals(modified)) fs.writeFileSync(target, original);
    fs.writeFileSync(path.join(root, 'local-data/acceptance/hmr.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report));
  }
})();
