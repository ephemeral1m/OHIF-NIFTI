const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.setDefaultTimeout(90000);
  const result = { errors: [], states: [] };
  page.on('pageerror', e => result.errors.push(e.message));
  const snapshot = async name => {
    const state = await page.evaluate(() => {
      const s = window.services;
      return [...s.viewportGridService.getState().viewports.keys()].map(id => {
        const vp = s.cornerstoneViewportService.getCornerstoneViewport(id), group = s.toolGroupService.getToolGroupForViewport(id);
        return { id, group: group.id, active: group.getActivePrimaryMouseButtonTool(), crosshairs: group.getToolOptions('Crosshairs')?.mode,
          cursor: getComputedStyle(vp.element).cursor, canvasCursor: getComputedStyle(vp.canvas).cursor, inlineCursor: vp.element.style.cursor };
      });
    });
    result.states.push({ name, viewports: state }); console.log(name, JSON.stringify(state));
  };
  try {
    await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_13249_b_2');
    await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 6);
    await page.getByRole('button', { name: '标注与 AI', exact: true }).click();
    assert(await page.locator('.nifti-annotation > :first-child').evaluate(el => el.classList.contains('annotation-tools')));
    const collapse = page.getByRole('button', { name: '标注工具面板', exact: true });
    await page.getByRole('tab', { name: '手工编辑', exact: true }).click();
    await page.locator('.annotation-tools [data-tool="Brush"]').click();
    await snapshot('brush-stack');
    await page.getByRole('tab', { name: 'AI 提示', exact: true }).click();
    await page.locator('.annotation-tools [data-tool="Probe2"]').click();
    await snapshot('points-stack');
    const cursor = result.states.at(-1).viewports[0].cursor;
    assert(cursor.startsWith('url('), 'points have a registered aiming cursor');
    await page.evaluate(async () => {
      const s = window.services, v = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getActiveViewportId());
      const url = getComputedStyle(v.element).cursor.match(/url\("?([^"\)]+)"?\)/)[1];
      const image = new Image(); image.src = url; await image.decode();
    });
    await collapse.click();
    assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('tab', { name: 'AI 提示', exact: true }).isVisible(), false);
    await snapshot('collapsed');
    assert.equal(result.states.at(-1).viewports[0].active, 'Probe2');
    await page.screenshot({ path: 'local-data/acceptance/annotation-collapsed.png' });
    await collapse.click();
    assert.equal(await page.getByRole('tab', { name: 'AI 提示', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Change layout', exact: true }).click();
    await page.locator('[data-cy="Axial Primary"]').click();
    await page.waitForFunction(() => { const s = window.services; return s.viewportGridService.getState().viewports.size === 3 && [...s.viewportGridService.getState().viewports.keys()].every(id => s.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length === 7); });
    await page.locator('.annotation-tools [data-tool="Probe2"]').click();
    await snapshot('points-mpr');
    assert(result.states.at(-1).viewports.every(v => v.cursor.startsWith('url(') && v.canvasCursor === v.cursor));
    const toggle = () => page.locator('[data-cy="Crosshairs"]').click();
    await toggle();
    await snapshot('crosshairs-first');
    assert(result.states.at(-1).viewports.every(v => v.crosshairs === 'Active'));
    await toggle();
    await snapshot('crosshairs-second');
    assert(result.states.at(-1).viewports.every(v => v.crosshairs === 'Disabled' && v.active === 'Probe2'));
    await page.getByRole('tab', { name: '手工编辑', exact: true }).click();
    await page.locator('.annotation-tools [data-tool="Brush"]').click();
    for (let i=0;i<2;i++) {
      await toggle(); await toggle();
      await snapshot(`restore-brush-${i}`);
      assert(result.states.at(-1).viewports.every(v => v.crosshairs === 'Disabled' && v.active === 'CircularBrush'));
    }
    await toggle();
    await page.getByRole('tab', { name: 'AI 提示', exact: true }).click();
    await page.locator('.annotation-tools [data-tool="Probe2"]').click();
    await snapshot('points-exits-crosshairs');
    assert(result.states.at(-1).viewports.every(v => v.crosshairs === 'Disabled' && v.active === 'Probe2' && v.cursor.startsWith('url(')));
    await page.screenshot({ path: 'local-data/acceptance/annotation-top.png' });
    assert.deepEqual(result.errors, []); result.passed = true;
  } finally {
    fs.writeFileSync('local-data/acceptance/annotation-controls.json', JSON.stringify(result, null, 2));
    await browser.close();
  }
})();
