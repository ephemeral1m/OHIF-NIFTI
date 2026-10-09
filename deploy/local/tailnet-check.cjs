/* Read-only HTTPS, streaming and WebSocket check of the local tailnet entry. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const host = JSON.parse(fs.readFileSync(path.join(__dirname, 'tailnet.json'), 'utf8')).hostname;
const base = `https://${host}:${Number(process.argv[2] || 9443)}`;
const seed = JSON.parse(fs.readFileSync(path.join(root, 'local-data/acceptance/api.json'), 'utf8').replace(/^\uFEFF/, ''));
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(90000);
  const report = { base, passed: false, checks: [], errors: [], frames: [], fullFiles: [], websockets: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    if (/\/nifti-images\/[^/]+\/frames\/\d+$/.test(request.url())) report.frames.push(request.url());
    if (/\/nifti-images\/[^/]+\/file$/.test(request.url())) report.fullFiles.push(request.url());
  });
  page.on('websocket', socket => {
    const state = { url: socket.url(), received: false, error: null };
    report.websockets.push(state);
    socket.on('framereceived', () => { state.received = true; });
    socket.on('socketerror', error => { state.error = error; });
  });
  try {
    const health = await page.request.get(base + '/monai/health');
    assert.equal(health.status(), 200);
    report.checks.push('HTTPS certificate and backend API');
    await page.goto(base + '/nifti', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    assert(report.websockets.some(socket => socket.url.startsWith('wss://') && socket.received && !socket.error));
    report.checks.push('NIfTI home, secure browser context and WSS development connection');
    const ct = seed.sources.find(source => source.modality === 'CT');
    await page.goto(base + '/nifti?sourceId=' + ct.sourceId, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      try {
        const s = window.services, view = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        return view.getCornerstoneImage()?.imageId === view.getCurrentImageId() && view.getCornerstoneImage()?.getPixelData()?.length > 0;
      } catch { return false; }
    });
    await page.waitForFunction(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0]?.loaded === 17);
    report.stream = await page.evaluate(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0]);
    assert.equal(report.fullFiles.length, 0);
    assert.equal(report.stream.total, 96);
    await page.screenshot({ path: path.join(root, 'local-data/acceptance/tailnet-viewer.png') });
    report.checks.push('CT viewer and 17 gzip frames through tailnet HTTPS');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.getByText('SYNTHETIC, LOCAL', { exact: true }).waitFor();
    report.checks.push('DICOM worklist through tailnet HTTPS');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
    await page.screenshot({ path: path.join(root, 'local-data/acceptance/tailnet-failure.png') }).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(root, 'local-data/acceptance/tailnet.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report));
  }
})();
