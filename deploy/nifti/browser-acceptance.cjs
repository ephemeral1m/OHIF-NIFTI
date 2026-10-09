/* Run against the isolated test deployment only. See README for environment.
 * Uses actual OHIF viewports and UI actions, with service inspection for assertions.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const base = process.env.NIFTI_TEST_URL || 'http://localhost:1126';
const fixtures = process.env.NIFTI_FIXTURES || path.join(root, 'release-artifacts/nifti-phantoms');
const output = process.env.NIFTI_TEST_OUTPUT || path.join(__dirname, 'acceptance-results');
const scenario = process.argv[2] || 'workflow';
fs.mkdirSync(output, { recursive: true });

async function active(page, action) {
  return page.evaluate(action);
}
async function loadSavedUi(page) {
  await page.getByRole('button', { name: '标注历史', exact: true }).click();
  await page.getByRole('button', { name: '补充加载其他标注', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '加载完成' }).waitFor({ timeout: 180000 });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function openLocal(page, filename) {
  if (page.url().startsWith(base + '/nifti-viewer')) {
    await page.getByRole('link', { name: '打开另一例 NIfTI', exact: true }).click();
  } else if (!page.url().startsWith(base + '/nifti')) {
    await page.goto(base + '/nifti', { waitUntil: 'domcontentloaded', timeout: 180000 });
  }
  await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor({ timeout: 180000 });
  await page.getByLabel('本地 NIfTI 原图', { exact: true }).setInputFiles(path.join(fixtures, filename));
  await page.locator('canvas').first().waitFor({ timeout: 120000 });
  await page.waitForFunction(() => window.services?.cornerstoneViewportService
    .getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId)?.getCurrentImageId?.());
}
async function masks(page) {
  return page.evaluate(async () => {
    const results = [];
    for (const s of window.services.segmentationService.getSegmentations()) {
      const images = s.representationData.Labelmap.imageIds.map(id => window.cornerstone.cache.getImage(id));
      // SEG hydration may reorder frames. Compare in source SOP order, not cache order.
      const key = image => {
        const id = image.referencedImageId;
        if (!id || id.startsWith('nifti:')) return '';
        return window.cornerstone.metaData.get('sopCommonModule', id)?.sopInstanceUID || id;
      };
      images.sort((a, b) => key(a).localeCompare(key(b)));
      const slices = images.map(image => image.getPixelData());
      const bytes = new Uint8Array(slices.reduce((n, p) => n + p.length, 0));
      let offset = 0; for (const p of slices) { bytes.set(p, offset); offset += p.length; }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      results.push({ id: s.segmentationId, label: s.label, hash, foreground: bytes.reduce((a,b) => a+b, 0),
        slices: slices.length, foregroundReferences: images.filter(image => image.getPixelData().some(Boolean)).map(key).filter(Boolean) });
    }
    return results;
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
  const context = await browser.newContext({ httpCredentials: {
    username: process.env.NIFTI_TEST_USERNAME, password: process.env.NIFTI_TEST_PASSWORD, origin: base,
  }, viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const report = { scenario, base, errors: [], started: new Date().toISOString(),
    environment: { browser: browser.version(), executable: path.basename(process.env.CHROMIUM_EXECUTABLE || 'chromium'),
      platform: process.platform, cpu: require('node:os').cpus()[0].model, viewport: '1500x950', headless: true } };
  page.on('pageerror', e => { report.errors.push(e.message); console.log('Page error:', e.message); });
  page.on('console', e => { if (e.type() === 'error') {
    if (e.text().includes('Shepherd step') || e.text().includes('selector supplied to advanceOn')) {
      (report.baselineTourWarnings ||= []).push(e.text()); return;
    }
    report.errors.push(e.text()); console.log('Console error:', e.text());
  } });
  page.on('dialog', d => d.accept());
  if (scenario === 'interpolation') {
    page.on('requestfailed', r => console.log('REQUEST FAILED', r.url(), r.failure()?.errorText));
    page.on('console', m => { if (m.type() === 'warning') console.log('WARNING', m.text()); });
  }
  try {
    if (scenario === 'ui-ai') {
      await openLocal(page, 'ct-oblique.nii.gz');
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      await page.evaluate(async () => { const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId); await v.setImageIdIndex(58); v.render(); });
      const unlock = page.getByRole('button', { name: 'Unlock tools', exact: true });
      if (await unlock.isVisible()) await unlock.click();
      assert.equal(await page.locator('[data-cy="saveToPACS"]').count(), 0);
      assert.equal(await page.locator('[data-cy="saveDraft"]').count(), 0);
      const uploadEvent = page.waitForResponse(r => r.url().endsWith('/monai/nifti-images') && r.request().method() === 'POST');
      await page.locator('[data-cy="Probe2"] button').click();
      const uploaded = await uploadEvent; assert.equal(uploaded.status(), 200);
      await page.getByRole('link', { name: '原图访问链接', exact: true }).waitFor();
      const responseEvent = page.waitForResponse(r => r.url().includes('/nifti-images/') && r.url().endsWith('/infer'), { timeout: 180000 });
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      const response = await responseEvent; assert.equal(response.status(), 200, await response.text());
      await response.finished(); await page.waitForTimeout(1000);
      report.aiMask = (await masks(page))[0]; assert(report.aiMask.foreground > 0);
      await page.getByRole('button', { name: 'Save All', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存 1 / 1' }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loadSavedUi(page);
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '标注历史' && !b.disabled));
      report.reloaded = await masks(page); assert(report.reloaded.some(m => m.hash === report.aiMask.hash));
    } else if (scenario === 'ct-rate') {
      await page.goto(base + '/nifti', { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
      await page.getByLabel('清单基准目录').selectOption('/data/cache/datasets/CT-RATE');
      await page.getByLabel('NIfTI 病例清单').setInputFiles(path.join(root, 'deploy/nifti/examples/ct-rate.csv'));
      const open = page.getByRole('button', { name: '打开 valid_668_b_2.nii.gz', exact: true });
      await open.waitFor(); await open.click();
      await page.locator('canvas').first().waitFor({ timeout: 240000 });
      await page.waitForFunction(() => window.services?.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId)?.getCurrentImageId?.());
      report.source = await page.evaluate(async () => {
        const id = window.services.viewportGridService.getState().activeViewportId;
        const ds = window.services.displaySetService.getDisplaySetByUID(window.services.viewportGridService.getState().viewports.get(id).displaySetInstanceUIDs[0]);
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(id);
        await v.setImageIdIndex(Math.floor(ds.sourceDescriptor.dimensions[2] / 2)); v.render();
        return ds.sourceDescriptor;
      });
      await page.screenshot({ path: path.join(output, 'ct-rate-stack.png') });
      await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
      await page.waitForFunction(() => [...window.services.viewportGridService.getState().viewports.keys()].every(id => window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
      await page.screenshot({ path: path.join(output, 'ct-rate-mpr.png') });
    } else if (scenario === 'ui-manifest') {
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      const entry = page.getByRole('link', { name: 'NIfTI 检查列表', exact: true });
      await entry.waitFor(); assert.equal(await entry.count(), 1); assert.equal(await entry.locator('svg').count(), 1);
      await page.screenshot({ path: path.join(output, 'dicom-home-revised.png') });
      await entry.click();
      await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
      const image = '/nifti-acceptance-data/ct-oblique.nii.gz', mask = '/nifti-acceptance-data/ct-oblique-labels.nii.gz';
      await page.getByLabel('NIfTI 病例清单').setInputFiles({ name: 'cases.csv', mimeType: 'text/csv', buffer: Buffer.from(`image,seg1,seg2\n${image},${mask},\nmissing.nii,,\n`) });
      await page.getByText('路径错误', { exact: true }).waitFor();
      assert(await page.getByRole('button', { name: '打开 missing.nii', exact: true }).isDisabled());
      await page.getByLabel('NIfTI 病例清单').setInputFiles({ name: 'cases.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ image, segmentations: [mask], name: 'CT with masks' }])) });
      await page.getByRole('button', { name: '打开 CT with masks', exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, 'nifti-home-revised.png') });
      await page.getByRole('button', { name: '打开 CT with masks', exact: true }).click();
      await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 2, null, { timeout: 180000 });
      assert.equal(await page.getByText('Segmentation Not Supported', { exact: true }).count(), 0);
      report.loaded = await masks(page);
      assert(report.loaded.some(m => m.foreground === 729)); assert(report.loaded.some(m => m.foreground === 1331));
      await page.getByText('ct-oblique-labels.nii.gz / 300', { exact: true }).first().click();
      await page.waitForFunction(() => window.services.segmentationService.getActiveSegmentation(window.services.viewportGridService.getState().activeViewportId)?.label.endsWith('/ 300'));
      await page.locator('[data-cy="Brush"] button').click();
      await page.evaluate(async () => { const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId); await v.setImageIdIndex(48); v.render(); });
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .54, box.y + box.height * .5, { steps: 8 }); await page.mouse.up();
      report.edited = await masks(page);
      assert.equal(report.edited.find(m => m.label.endsWith('/ 900')).hash, report.loaded.find(m => m.label.endsWith('/ 900')).hash);
      assert.notEqual(report.edited.find(m => m.label.endsWith('/ 300')).hash, report.loaded.find(m => m.label.endsWith('/ 300')).hash);
      await page.screenshot({ path: path.join(output, 'nifti-viewer-revised.png') });
    } else if (scenario === 'interpolation') {
      await openLocal(page, 'ct-oblique.nii.gz');
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      await page.evaluate(() => {
        const s = window.services.segmentationService.getSegmentations()[0];
        window.interpolationTarget = s.segmentationId;
        for (const z of [30, 40]) {
          const p = window.cornerstone.cache.getImage(s.representationData.Labelmap.imageIds[z]).getPixelData();
          for (let y = 60; y < 80; y++) for (let x = 50; x < 70; x++) p[y * 128 + x] = 1;
        }
        window.commandsManager.runCommand('interpolateLabelmap');
      });
      await page.waitForFunction(() => {
        const s = window.services.segmentationService.getSegmentation(window.interpolationTarget);
        return window.cornerstone.cache.getImage(s.representationData.Labelmap.imageIds[35]).getPixelData().some(Boolean);
      }, null, { timeout: 90000 });
      report.interpolated = await masks(page);
    } else if (scenario === 'capabilities') {
      await openLocal(page, 'ct-oblique.nii.gz');
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      assert(await page.getByRole('button', { name: 'Save to PACS（不可用）', exact: true }).isDisabled());
      assert.equal(await page.locator('[data-cy="panelSegmentationWithTools-btn"]').count(), 0);
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.getByRole('button', { name: '选择 Mask 1', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '选择 Mask 1', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '画笔', exact: true }).click();
      await page.evaluate(async () => {
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId);
        await v.setImageIdIndex(48); v.render();
      });
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .54, box.y + box.height * .5, { steps: 8 }); await page.mouse.up();
      report.masks = await masks(page);
      assert(report.masks.find(m => m.label === 'Mask 1').foreground > 0);
      assert.equal(report.masks.find(m => m.label === 'Mask 2').foreground, 0);
      await page.getByRole('slider', { name: 'Mask 不透明度' }).fill('0.25');
      report.opacity = await page.evaluate(() => {
        const s = window.services.segmentationService;
        return s.getStyle({ viewportId: window.services.viewportGridService.getState().activeViewportId,
          segmentationId: s.getSegmentations()[0].segmentationId, type: 'Labelmap' }).fillAlpha;
      });
      assert.equal(report.opacity, .25);
      await page.getByRole('checkbox', { name: 'Live Mode（提示后自动推理）' }).uncheck();
      assert.equal(await page.getByRole('checkbox', { name: 'Live Mode（提示后自动推理）' }).isChecked(), false);
      await page.getByRole('button', { name: '删除 Mask 2', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      assert.equal((await masks(page))[0].hash, report.masks[0].hash);
      await page.screenshot({ path: path.join(output, 'native-controls.png') });
      report.nativeControls = true;
    } else if (scenario === 'pacs-reload') {
      const previous = JSON.parse(fs.readFileSync(path.join(output, 'dicom-draft-pacs.json')));
      assert(previous.pacs?.series_uid);
      await page.goto(base + '/viewer?StudyInstanceUIDs=' + previous.studyUID + '&initialSeriesInstanceUID=' + previous.seriesUID, { waitUntil: 'domcontentloaded', timeout: 180000 });
      await page.waitForFunction(uid => window.services?.displaySetService.getActiveDisplaySets().some(s => s.SeriesInstanceUID === uid && s.referencedDisplaySetInstanceUID), previous.pacs.series_uid, { timeout: 180000 });
      await page.evaluate(async uid => {
        const ds = window.services.displaySetService.getActiveDisplaySets().find(s => s.SeriesInstanceUID === uid);
        await ds.load({ headers: {} });
      }, previous.pacs.series_uid);
      report.expectedMask = previous.mask;
      report.reloadedPacsMasks = await masks(page);
      assert(report.reloadedPacsMasks.some(m => m.hash === previous.mask.hash));
      report.pacsSeriesUID = previous.pacs.series_uid;
    } else if (scenario === 'workflow') {
      await openLocal(page, 'ct-oblique.nii.gz');
      console.log('Local image open');
      await page.evaluate(async () => {
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId);
        await v.setImageIdIndex(48); v.render();
      });
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      await page.evaluate(() => window.commandsManager.runCommand('setToolActive', { toolName: 'CircularBrush' }));
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .54, box.y + box.height * .5, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(1000);
      report.brush = (await masks(page))[0];
      assert(report.brush.foreground > 0, 'Brush must change actual mask voxels');
      await page.locator('input[type=file]').setInputFiles(path.join(fixtures, 'ct-oblique-labels.nii.gz'));
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 3);
      report.beforeSave = await masks(page);
      assert(report.beforeSave.some(m => m.label.endsWith('/ 300')));
      assert(report.beforeSave.some(m => m.label.endsWith('/ 900')));
      await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
      await page.waitForFunction(() => [...window.services.viewportGridService.getState().viewports.keys()].every(id =>
        window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
      await page.waitForTimeout(2000);
      report.geometryErrorMm = await page.evaluate(() => {
        const id = window.services.viewportGridService.getState().activeViewportId;
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(id);
        const volume = window.cornerstone.cache.getVolume(v.getVolumeId());
        const ds = window.services.displaySetService.getDisplaySetByUID(window.services.viewportGridService.getState().viewports.get(id).displaySetInstanceUIDs[0]);
        const a = ds.sourceDescriptor.voxelToLPS;
        let error = 0;
        for (const p of [[0,0,0], [127,159,95], [41,63,28]]) {
          const expected = a.slice(0,3).map(row => row[3]+row[0]*p[0]+row[1]*p[1]+row[2]*p[2]);
          const actual = volume.imageData.indexToWorld(p);
          error = Math.max(error, ...actual.map((x,i) => Math.abs(x-expected[i])));
        }
        return error;
      });
      assert(report.geometryErrorMm <= 1e-3, 'MPR physical coordinates must match source affine');
      await page.screenshot({ path: path.join(output, 'native-mpr.png') });
      console.log('Brush, multilabel import and MPR passed; saving');
      await page.getByRole('button', { name: 'Save All', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存 3 / 3' }).waitFor({ timeout: 180000 });
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出 NIfTI ZIP（本地）', exact: true }).click();
      await (await downloadEvent).saveAs(path.join(output, 'native-masks.zip'));
      report.serverUrl = page.url();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loadSavedUi(page);
      await page.getByText('ct-oblique-labels.nii.gz / 300', { exact: true }).first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '标注历史' && !b.disabled));
      report.afterReload = await masks(page);
      for (const expected of report.beforeSave) assert(report.afterReload.some(m => m.label === expected.label && m.hash === expected.hash), 'Saved mask must roundtrip exactly: ' + expected.label);
      console.log('Server save, ZIP export and refresh roundtrip passed');
    } else if (['dicom', 'dicom-ai', 'dicom-draft-pacs', 'dicom-interpolation'].includes(scenario)) {
      const response = await context.request.get(base + '/pacs/dicom-web/series?Modality=CT');
      assert.equal(response.status(), 200);
      const series = (await response.json()).filter(s => Number(s['00201209']?.Value?.[0]) >= 30)
        .sort((a,b) => Number(a['00201209'].Value[0]) - Number(b['00201209'].Value[0]))[0];
      report.studyUID = series['0020000D'].Value[0]; report.seriesUID = series['0020000E'].Value[0];
      await page.goto(base + '/viewer?StudyInstanceUIDs=' + report.studyUID + '&initialSeriesInstanceUID=' + report.seriesUID, { waitUntil: 'domcontentloaded', timeout: 180000 });
      await page.locator('canvas').first().waitFor({ timeout: 180000 });
      if (await page.getByText('Skip all', { exact: true }).isVisible()) await page.getByText('Skip all', { exact: true }).click();
      await page.waitForFunction(() => window.services?.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId)?.getCurrentImageId?.());
      await page.waitForFunction(() => {
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId);
        return window.cornerstone.cache.getImage(v.getCurrentImageId())?.getPixelData?.()?.length > 0;
      }, null, { timeout: 180000 });
      await page.waitForTimeout(1500);
      await page.evaluate(async () => {
        const services = window.services, id = services.viewportGridService.getState().activeViewportId;
        const ds = services.displaySetService.getDisplaySetByUID(services.viewportGridService.getState().viewports.get(id).displaySetInstanceUIDs[0]);
        const segmentationId = 'dicom-acceptance-' + crypto.randomUUID();
        await services.segmentationService.createLabelmapForDisplaySet(ds, { segmentationId, label: 'DICOM regression', segments: { 1: { label: 'Regression target', active: true } } });
        await services.segmentationService.addSegmentationRepresentation(id, { segmentationId });
        services.segmentationService.setActiveSegmentation(id, segmentationId);
        services.segmentationService.setActiveSegment(segmentationId, 1);
        window.commandsManager.runCommand('setToolActive', { toolName: 'CircularBrush' });
      });
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
      await page.mouse.down(); await page.mouse.move(box.x+box.width*.53,box.y+box.height*.5,{steps:5}); await page.mouse.up();
      report.mask = (await masks(page))[0]; assert(report.mask.foreground > 0);
      if (scenario === 'dicom-draft-pacs') {
        const drafts = await (await context.request.get(base + '/monai/nifti-segs/' + report.seriesUID)).json();
        const items = Array.isArray(drafts) ? drafts : drafts.drafts;
        const saved = items.filter(d => d.label === 'Regression target').at(-1);
        assert(saved, 'Run dicom-ai first to create a regression draft');
        await page.evaluate(async ({ id, seriesUID, studyUID, filename }) => {
          window.services.segmentationService.remove(id);
          await window.commandsManager.runCommand('loadNiftiDraft', { seriesUID, studyInstanceUID: studyUID, filename });
        }, { id: report.mask.id, seriesUID: report.seriesUID, studyUID: report.studyUID, filename: saved.filename });
        report.mask = (await masks(page))[0]; report.loadedDraft = saved.filename;
      }
      if (scenario === 'dicom-ai') {
        const aiEvent = page.waitForResponse(r => r.url().includes('/monai/infer/segmentation?'), { timeout: 240000 });
        await page.evaluate(() => window.commandsManager.runCommand('setToolActive', { toolName: 'Probe2' }));
        await page.mouse.click(box.x+box.width*.52, box.y+box.height*.52);
        const aiResponse = await aiEvent; assert.equal(aiResponse.status(), 200);
        await aiResponse.finished(); await page.waitForTimeout(1500);
        const edited = await masks(page);
        assert.equal(edited.length, 1); assert.equal(edited[0].id, report.mask.id);
        assert(edited[0].foreground > 0); report.mask = edited[0];
        const saveDraftEvent = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/monai/nifti-segs/'), { timeout: 240000 });
        await page.evaluate(() => window.commandsManager.runCommand('saveToNifti'));
        const draftResponse = await saveDraftEvent; assert.equal(draftResponse.status(), 200);
        report.dicomDraft = await draftResponse.json();
        await page.evaluate(async ({ seriesUID, studyUID, filename, id }) => {
          window.services.segmentationService.remove(id);
          await window.commandsManager.runCommand('loadNiftiDraft', { seriesUID, studyInstanceUID: studyUID, filename });
        }, { seriesUID: report.seriesUID, studyUID: report.studyUID, filename: report.dicomDraft.filename, id: report.mask.id });
        report.reloadedDicomDraft = (await masks(page))[0];
        assert.equal(report.reloadedDicomDraft.hash, report.mask.hash, 'DICOM NIfTI draft must preserve source SOP pixel mapping');
      }
      if (scenario === 'dicom-interpolation') {
        report.pipelineRequests = [];
        page.on('request', r => { if (r.url().includes('/pipelines/') || r.url().includes('/itk/interpolation/')) report.pipelineRequests.push(r.url()); });
        await page.evaluate(() => {
          const s = window.services.segmentationService.getSegmentations()[0]; window.interpolationTarget = s.segmentationId;
          for (const id of s.representationData.Labelmap.imageIds) window.cornerstone.cache.getImage(id).getPixelData().fill(0);
          for (const z of [10, 20]) {
            const image = window.cornerstone.cache.getImage(s.representationData.Labelmap.imageIds[z]), p = image.getPixelData();
            for (let y = 100; y < 120; y++) for (let x = 100; x < 120; x++) p[y * image.width + x] = 1;
          }
        });
        await page.getByText('Non-Interactive Segmentation (Legacy)', { exact: true }).click();
        await page.locator('[data-cy="InterpolateLabelmap"] button').click();
        await page.waitForFunction(() => {
          const s = window.services.segmentationService.getSegmentation(window.interpolationTarget);
          return window.cornerstone.cache.getImage(s.representationData.Labelmap.imageIds[15]).getPixelData().some(Boolean);
        }, null, { timeout: 120000 });
        report.interpolated = await masks(page);
        assert(report.pipelineRequests.some(url => url.includes('/itk/interpolation/')));
        assert(report.pipelineRequests.every(url => url.startsWith(base)));
        await page.screenshot({ path: path.join(output, 'dicom-interpolation.png') });
        assert.equal(report.errors.length, 0); report.passed = true; return;
      }
      console.log('DICOM browsing and brush passed; saving DICOM-SEG to isolated PACS');
      const savedEvent = page.waitForResponse(r => r.url().includes('/monai/infer/save/segmentation'), { timeout: 900000 });
      await page.evaluate(() => { window.commandsManager.runCommand('saveToPACS'); });
      const saved = await savedEvent; assert.equal(saved.status(), 200, (await saved.text()).slice(0,500));
      report.pacs = await saved.json();
      await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
      await page.waitForFunction(() => [...window.services.viewportGridService.getState().viewports.keys()].every(id => window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()), { timeout: 180000 });
      await page.waitForTimeout(2000); await page.screenshot({path:path.join(output,'dicom-mpr.png')});
      const segs = await context.request.get(base + '/pacs/dicom-web/series?Modality=SEG&StudyInstanceUID=' + report.studyUID);
      assert((await segs.json()).length > 0, 'The saved SEG must be discoverable in PACS');
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForFunction(uid => window.services?.displaySetService.getActiveDisplaySets().some(s => s.SeriesInstanceUID === uid && s.referencedDisplaySetInstanceUID), report.pacs.series_uid, {timeout:180000});
      await page.evaluate(async uid => {
        const ds = window.services.displaySetService.getActiveDisplaySets().find(s => s.SeriesInstanceUID === uid);
        await ds.load({ headers: {} });
      }, report.pacs.series_uid);
      report.reloadedPacsMasks = await masks(page);
      assert(report.reloadedPacsMasks.some(m => m.hash === report.mask.hash), 'DICOM-SEG reload must preserve the voxel mask');
    } else if (scenario === 'ai' || scenario === 'ai-reload') {
      if (process.env.NIFTI_STREAM_AI === 'true') {
        const res = await context.request.post(base + '/monai/nifti-images', { multipart: {
          file: { name: 'ct-oblique.nii.gz', mimeType: 'application/gzip', buffer: fs.readFileSync(path.join(fixtures, 'ct-oblique.nii.gz')) }, modality: 'CT' } });
        assert.equal(res.status(), 200); report.sourceId = (await res.json()).sourceId;
        await page.goto(base + '/nifti?sourceId=' + report.sourceId, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => { try { const s = window.services, v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId); return !!v.getCornerstoneImage?.() && v.getCornerstoneImage().imageId === v.getCurrentImageId(); } catch { return false; } });
      } else await openLocal(page, 'ct-oblique.nii.gz');
      await page.evaluate(async () => {
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId);
        await v.setImageIdIndex(58); v.render();
      });
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
      const unlock = page.getByRole('button', { name: 'Unlock tools', exact: true });
      if (await unlock.isVisible()) await unlock.click();
      const infer = async (label, x, y, drag) => {
        const sign = page.locator('#pos-neg');
        if ((await sign.getAttribute('aria-checked') === 'true') !== (label === '负点')) await sign.click();
        await page.locator(`[data-cy="${({ 正点: 'Probe2', 负点: 'Probe2', 框: 'RectangleROI2', 涂鸦: 'PlanarFreehandROI2' })[label]}"] button`).click();
        await page.getByRole('link', { name: '原图访问链接', exact: true }).waitFor();
        const responseEvent = page.waitForResponse(r => r.url().includes('/nifti-images/') && r.url().endsWith('/infer'), { timeout: 180000 });
        const box = await page.locator('canvas').first().boundingBox();
        if (drag) {
          await page.mouse.move(box.x + box.width*x, box.y + box.height*y);
          await page.mouse.down();
          for (const [dx, dy] of drag) await page.mouse.move(box.x + box.width*dx, box.y + box.height*dy, { steps: 12 });
          await page.mouse.up();
        } else await page.mouse.click(box.x + box.width*x, box.y + box.height*y);
        const response = await responseEvent;
        assert.equal(response.status(), 200, await response.text().then(t => t.slice(0, 300)));
        await response.finished(); await page.waitForTimeout(1500);
        return masks(page);
      };
      report.firstPoint = await infer('正点', .5, .5);
      assert(report.firstPoint[0].foreground > 0);
      if (scenario === 'ai-reload') {
        await page.getByRole('button', { name: 'Save All', exact: true }).click();
        await page.getByText('已保存 1 / 1 个 mask。', { exact: true }).waitFor({ timeout: 180000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: '标注历史', exact: true }).waitFor({ timeout: 180000 });
        await loadSavedUi(page);
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === '标注历史' && !b.disabled), null, { timeout: 180000 });
        report.beforeReloadEdit = await masks(page);
        const selected = report.beforeReloadEdit.find(m => m.hash === report.firstPoint[0].hash);
        assert(selected, 'Saved AI result must reload with identical voxels');
        await page.evaluate(id => {
          const viewportId = window.services.viewportGridService.getState().activeViewportId;
          window.services.segmentationService.setActiveSegmentation(viewportId, id);
          window.services.segmentationService.setActiveSegment(id, 1);
        }, selected.id);
        report.afterReloadEdit = await infer('负点', .5, .5);
        for (const original of report.beforeReloadEdit.filter(m => m.id !== selected.id)) {
          assert.equal(report.afterReloadEdit.find(m => m.id === original.id).hash, original.hash);
        }
        report.closedLoop = true;
      } else {
      await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
      await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 2);
      report.secondTarget = await infer('正点', .6, .52);
      assert.equal(report.secondTarget[0].hash, report.firstPoint[0].hash, 'Changing target must preserve the first mask');
      assert(report.secondTarget[1].foreground > 0);
      report.negativePoint = await infer('负点', .6, .52);
      assert.equal(report.negativePoint[0].hash, report.firstPoint[0].hash);
      await page.locator('[data-cy="resetNninter"] button').click();
      report.afterReset = await infer('正点', .54, .55);
      assert.equal(report.afterReset[0].hash, report.firstPoint[0].hash);
      report.box = await infer('框', .45, .45, [[.6, .58]]);
      assert.equal(report.box[0].hash, report.firstPoint[0].hash);
      report.scribble = await infer('涂鸦', .47, .49, [[.5, .53], [.56, .50]]);
      assert.equal(report.scribble[0].hash, report.firstPoint[0].hash);
      console.log('Native points, box, scribble, target isolation and reset passed');
      }
      if (process.env.NIFTI_STREAM_AI === 'true') {
        report.stream = await page.evaluate(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().streams[0]);
        assert(report.stream.loaded < report.stream.total, 'AI prompts must not force complete original loading');
      }
    } else if (scenario === 'formats') {
      report.formats = [];
      for (const dtype of ['uint8', 'int8', 'uint16', 'int16', 'float32']) {
        for (const suffix of ['nii', 'nii.gz']) {
          await openLocal(page, 'scalar-' + dtype + '.' + suffix);
          await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
          await page.waitForFunction(() => [...window.services.viewportGridService.getState().viewports.keys()].every(id => window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
          await page.waitForTimeout(200);
          report.formats.push({ dtype, suffix, stack: true, mpr: true });
        }
      }
    } else if (scenario === 'recovery') {
      await page.goto(base + '/nifti', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('本地 NIfTI 原图', { exact: true }).setInputFiles({ name: 'broken.nii.gz', mimeType: 'application/octet-stream', buffer: Buffer.from([31, 139, 8, 0]) });
      await page.getByRole('alert').waitFor();
      report.invalidFileMessage = await page.getByRole('alert').innerText();
      await openLocal(page, 'mr-anisotropic.nii.gz');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('本地原图已关闭或页面已刷新，请重新选择文件。', { exact: true }).waitFor();
      report.localRefreshRecovers = true;
      const library = await (await context.request.get(base + '/monai/nifti-images')).json();
      assert(library.items.length);
      let pending;
      const intercepted = new Promise(resolve => { pending = resolve; });
      await page.route('**/nifti-images/*/file', route => { pending(route); });
      await page.goto(base + '/nifti?sourceId=' + library.items[0].sourceId, { waitUntil: 'domcontentloaded' });
      const route = await intercepted;
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled);
      await route.abort().catch(() => {}); await page.unroute('**/nifti-images/*/file');
      report.afterCancel = await page.evaluate(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
      assert.equal(report.afterCancel.sources, 0); assert.equal(report.afterCancel.bytes, 0);
      await openLocal(page, 'mr-anisotropic.nii.gz');
      report.openAfterCancel = true;
    } else if (scenario === 'memory') {
      report.cycles = [];
      await openLocal(page, 'ct-oblique.nii.gz');
      for (let i = 0; i < 10; i++) {
        if (i % 3 === 1) {
          await page.evaluate(() => window.commandsManager.runCommand('toggleHangingProtocol', { protocolId: 'mpr' }));
          await page.waitForFunction(() => [...window.services.viewportGridService.getState().viewports.keys()].every(id => window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
        } else if (i % 3 === 2) {
          await page.getByRole('button', { name: '新建二值 mask', exact: true }).click();
          await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 1);
        }
        await page.getByRole('link', { name: '打开另一例 NIfTI', exact: true }).click();
        await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
        // Let viewport effects and completed image promises relinquish their references.
        await page.waitForTimeout(1000);
        const cdp = await context.newCDPSession(page);
        await cdp.send('HeapProfiler.collectGarbage');
        await page.waitForTimeout(100);
        await cdp.send('HeapProfiler.collectGarbage'); await cdp.detach();
        const state = await page.evaluate(() => window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot());
        assert.equal(state.sources, 0); assert.equal(state.images, 0); assert.equal(state.bytes, 0);
        assert.equal(state.sourceReleasedButReachableBytes, 0, 'Old source allocation must be collectible');
        const nativeColorTables = await page.evaluate(() => window.services.segmentationService._nativeColorLUTs?.size || 0);
        assert.equal(nativeColorTables, 0, 'Closed native masks must release their owned color tables');
        state.nativeColorTables = nativeColorTables;
        report.cycles.push(state);
        console.log('Collected source cycle', i + 1);
        await page.getByLabel('本地 NIfTI 原图', { exact: true }).setInputFiles(path.join(fixtures, i % 2 ? 'ct-oblique.nii.gz' : 'mr-anisotropic.nii.gz'));
        await page.locator('canvas').first().waitFor();
      }
      await openLocal(page, 'ct-standard-128mib.nii.gz');
      let network = 0;
      page.on('request', r => { if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') network++; });
      report.latencies = await page.evaluate(async () => {
        const v = window.services.cornerstoneViewportService.getCornerstoneViewport(window.services.viewportGridService.getState().activeViewportId);
        const samples = [];
        for (let i = 80; i < 130; i++) {
          const start = performance.now();
          const rendered = new Promise(resolve => v.element.addEventListener(window.cornerstone.Enums.Events.IMAGE_RENDERED, resolve, { once: true }));
          await v.setImageIdIndex(i); v.render(); await rendered;
          samples.push(performance.now() - start);
        }
        return samples;
      });
      report.sliceNetworkRequests = network;
      assert.equal(network, 0);
      report.p95ms = [...report.latencies].sort((a,b) => a-b)[Math.ceil(report.latencies.length * .95)-1];
      report.performanceTargetMet = report.p95ms <= 100;
    }
    assert.equal(report.errors.length, 0, 'Browser must not report runtime errors');
    report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.message;
    report.url = page.url(); report.text = (await page.locator('body').innerText()).slice(0, 6000);
    await page.screenshot({ path: path.join(output, scenario + '-failure.png') });
    if (scenario === 'memory') {
      const cdp = await context.newCDPSession(page);
      const fd = fs.openSync(path.join(output, 'memory.heapsnapshot'), 'w');
      cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => fs.writeSync(fd, chunk));
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      fs.closeSync(fd); await cdp.detach();
    }
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, scenario + '.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); await browser.close();
  }
})();

