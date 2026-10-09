const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(90000);
  const result = { errors: [], checks: [], inferenceRequests: 0 };
  page.on('pageerror', e => result.errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/infer(?:\?|$|\/)/.test(r.url())) result.inferenceRequests++; });
  const check = async (expected, name) => {
    await page.waitForFunction(expected => {
      const s = window.services;
      return ['default', 'mpr'].every(id => s.toolGroupService.getToolGroup(id)?.getActivePrimaryMouseButtonTool() === expected);
    }, expected);
    result.checks.push(name); console.log(name);
  };
  const pan = () => page.locator('[data-cy="Pan"]').click();
  const cycle = async context => {
    for (const [mode, id, expected] of [
      ['AI 提示', 'Probe2', 'Probe2'], ['AI 提示', 'PlanarFreehandROI2', 'PlanarFreehandROI2'],
      ['AI 提示', 'PlanarFreehandROI3', 'PlanarFreehandROI3'], ['AI 提示', 'RectangleROI2', 'RectangleROI2'],
      ['手工编辑', 'Brush', 'CircularBrush'], ['手工编辑', 'Eraser', 'CircularEraser'],
      ['手工编辑', 'Threshold', 'ThresholdCircularBrushDynamic'], ['手工编辑', 'Shapes', 'CircleScissor'],
    ]) {
      await page.getByRole('tab', { name: mode, exact: true }).click();
      await check('Pan', `${context}: category does not activate ${id}`);
      const button = page.locator(`.annotation-tools [data-tool="${id}"]`);
      await button.click(); await check(expected, `${context}: activate ${id}`);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      await button.click(); await check('Pan', `${context}: deactivate ${id}`);
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
    }
  };
  try {
    await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_13249_b_2');
    await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 6);
    await page.getByRole('button', { name: '标注与 AI', exact: true }).click();
    await check('Pan', 'initial browse');
    await cycle('Stack');
    await page.getByRole('button', { name: 'Change layout', exact: true }).click();
    await page.locator('[data-cy="Axial Primary"]').click();
    await page.waitForFunction(() => { const s = window.services; return s.viewportGridService.getState().viewports.size === 3 && [...s.viewportGridService.getState().viewports.keys()].every(id => s.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length === 7); });
    await check('Pan', 'MPR starts in browse');
    const ids = await page.evaluate(() => [...window.services.viewportGridService.getState().viewports.keys()]);
    for (const id of ids) {
      await page.evaluate(id => window.services.viewportGridService.setActiveViewportId(id), id);
      await cycle(`MPR ${id}`);
    }
    await page.getByRole('tab', { name: 'AI 提示', exact: true }).click();
    await page.locator('.annotation-tools [data-tool="Probe2"]').click();
    await pan(); await check('Pan', 'top browse exits AI');
    const modes = await page.evaluate(() => ['default', 'mpr'].map(id => window.services.toolGroupService.getToolGroup(id).getToolOptions('Probe2').mode));
    assert.deepEqual(modes, ['Enabled', 'Enabled'], 'AI handles cannot be edited in browse');
    await page.locator('[data-cy="Crosshairs"]').click();
    await pan(); await check('Pan', 'top browse exits crosshairs');
    const before = await page.evaluate(() => {
      const s = window.services, v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
      const r = v.element.getBoundingClientRect(); return { focal: [...v.getCamera().focalPoint], x: r.x+r.width*.5, y: r.y+r.height*.5 };
    });
    await page.mouse.move(before.x, before.y); await page.mouse.down();
    await page.mouse.move(before.x+30, before.y+15, { steps: 5 }); await page.mouse.up();
    const after = await page.evaluate(() => { const s = window.services; return [...s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId()).getCamera().focalPoint]; });
    assert.notDeepEqual(after, before.focal, 'browse drag pans image');
    await page.locator('.annotation-tools [data-tool="Probe2"]').click();
    await page.getByRole('button', { name: '打开病例 train_12470_a_1.nii.gz', exact: true }).click();
    await page.waitForFunction(() => window.services.segmentationService.getSegmentations().length === 3);
    await check('Pan', 'switch case resets AI to browse');
    await page.screenshot({ path: 'local-data/acceptance/browse-tools.png' });
    assert.deepEqual(result.errors, []); assert.equal(result.inferenceRequests, 0); result.passed = true;
  } finally {
    console.log('final state', await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(-3000) })).catch(() => null));
    fs.writeFileSync('local-data/acceptance/browse-tools.json', JSON.stringify(result, null, 2));
    await browser.close();
  }
})();
