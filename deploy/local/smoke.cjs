/* End-to-end smoke test for the isolated local Docker development environment. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'local-data/acceptance');
const base = 'http://127.0.0.1:1026';
const seed = JSON.parse(fs.readFileSync(path.join(output, 'api.json'), 'utf8').replace(/^\uFEFF/, ''));
fs.mkdirSync(output, { recursive: true });

function phantom() {
  const count = 128 * 128 * 96;
  const buffer = Buffer.alloc(352 + count * 2);
  buffer.writeInt32LE(348);
  buffer.writeInt16LE(3, 40);
  [128, 128, 96].forEach((n, i) => buffer.writeInt16LE(n, 42 + i * 2));
  buffer.writeInt16LE(4, 70);
  buffer.writeInt16LE(16, 72);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer[123] = 2;
  buffer.writeInt16LE(1, 254);
  [280, 300, 320].forEach(offset => buffer.writeFloatLE(1, offset));
  buffer.write('n+1\0', 344, 'ascii');
  for (let i = 0; i < count; i++) buffer.writeInt16LE(i % 2000 - 1024, 352 + i * 2);
  return gzipSync(buffer);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  page.on('dialog', dialog => dialog.accept());
  const report = { base, started: new Date().toISOString(), checks: [], errors: [], frames: [], files: [] };
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('request', request => {
    if (/\/nifti-images\/[^/]+\/frames\/\d+$/.test(request.url())) report.frames.push(request.url());
    if (/\/nifti-images\/[^/]+\/file$/.test(request.url())) report.files.push(request.url());
  });
  const button = name => page.getByRole('button', { name, exact: true });
  const ready = () => page.waitForFunction(() => {
    try {
      const services = window.services;
      const view = services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getState().activeViewportId);
      return view.getCurrentImageId() === view.getCornerstoneImage()?.imageId && view.getCornerstoneImage().getPixelData().length > 0;
    } catch { return false; }
  });
  const memory = () => page.evaluate(() => window.extensionManager
    .getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
  const masks = () => page.evaluate(async () => {
    const result = [];
    for (const mask of window.services.segmentationService.getSegmentations()) {
      const slices = mask.representationData.Labelmap.imageIds.map(id => window.cornerstone.cache.getImage(id).getPixelData());
      const bytes = new Uint8Array(slices.reduce((sum, slice) => sum + slice.length, 0));
      let offset = 0;
      for (const slice of slices) { bytes.set(slice, offset); offset += slice.length; }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      result.push({ id: mask.segmentationId, label: mask.label, hash, foreground: bytes.reduce((sum, n) => sum + Number(n !== 0), 0) });
    }
    return result;
  });
  const check = message => { report.checks.push(message); console.log(message); };
  try {
    await page.goto(base + '/nifti', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.config.enableNiftiStreaming), true);
    check('NIfTI home and paired local streaming flag');
    const response = await context.request.post(base + '/monai/nifti-images', { multipart: {
      file: { name: 'local-stream-smoke.nii.gz', mimeType: 'application/gzip', buffer: phantom() }, modality: 'CT',
    } });
    assert.equal(response.status(), 200, await response.text());
    report.sourceId = (await response.json()).sourceId;
    await page.goto(base + '/nifti?sourceId=' + report.sourceId, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForFunction(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0]?.loaded === 17);
    report.partial = await memory();
    assert.equal(report.partial.streams[0].total, 96);
    assert.equal(report.files.length, 0);
    const first = await page.evaluate(() => {
      const s = window.services, v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
      return { index: v.getCurrentImageIdIndex(), value: v.getCornerstoneImage().getPixelData()[123] };
    });
    assert.equal(first.index, 48);
    assert.equal(first.value, (48 * 128 * 128 + 123) % 2000 - 1024);
    check('Exact middle slice, only 17 frames, no full original download');
    if (await button('Unlock tools').isVisible()) await button('Unlock tools').click();
    await button('新建二值 mask').click();
    await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length > 0);
    await page.evaluate(() => window.commandsManager.runCommand('setToolActive', { toolName: 'CircularBrush' }));
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .53, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => window.services.segmentationService.getSegmentations().some(m => m.representationData.Labelmap.imageIds.some(id => window.cornerstone.cache.getImage(id).getPixelData().some(Boolean))));
    report.brush = await masks();
    assert((await memory()).streams[0].loaded < 96);
    check('Real brush edits on a partially loaded source');
    const inference = page.waitForResponse(r => r.url().endsWith('/infer'), { timeout: 300000 });
    await page.locator('[data-cy="Probe2"] button').click();
    await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
    const ai = await inference;
    assert.equal(ai.status(), 200, await ai.text());
    await ai.finished();
    await page.waitForTimeout(1000);
    report.aiMask = (await masks()).at(-1);
    assert(report.aiMask.foreground > 0);
    assert((await memory()).streams[0].loaded < 96);
    check('GPU nnInteractive inference on a partially loaded source');
    const saved = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/masks'));
    await button('Save All').click();
    assert.equal((await saved).status(), 200);
    await page.getByRole('status').filter({ hasText: /已保存/ }).waitFor();
    await page.screenshot({ path: path.join(output, 'partial-viewer.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await button('标注历史').click();
    await button('补充加载其他标注').click();
    await page.getByRole('status').filter({ hasText: '加载完成' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    report.reloaded = await masks();
    assert(report.reloaded.some(mask => mask.hash === report.aiMask.hash));
    check('Mask save and UI history reload preserve every voxel');
    await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
    await page.waitForFunction(() => {
      try { const s = window.services; return !!s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId)?.getVolumeId?.(); } catch { return false; }
    });
    assert.equal((await memory()).streams[0].loaded, 96);
    await page.screenshot({ path: path.join(output, 'mpr-viewer.png') });
    check('MPR explicitly completes the volume');
    const mr = seed.sources.find(source => source.modality === 'MR');
    await page.goto(base + '/nifti?sourceId=' + mr.sourceId, { waitUntil: 'domcontentloaded' });
    await ready();
    assert((await memory()).streams[0].loaded < (await memory()).streams[0].total);
    check('Seeded MR opens through the streaming path');
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.getByText('SYNTHETIC, LOCAL', { exact: true }).waitFor();
    await page.goto(base + '/viewer?StudyInstanceUIDs=' + seed.studyInstanceUID, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.screenshot({ path: path.join(output, 'dicom-viewer.png') });
    check('DICOM worklist and actual viewport still work');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    await page.screenshot({ path: path.join(output, 'smoke-failure.png') }).catch(() => {});
    console.error(report.failure);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, 'browser.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errors: report.errors }));
  }
})();
