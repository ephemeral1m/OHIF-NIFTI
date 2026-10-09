// Read-only browser audit: actual VTK slice data must match the saved source mask.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const audit = JSON.parse(fs.readFileSync('local-data/acceptance/valid_254_a_2-mask-audit.json', 'utf8'));
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(90000);
  const results = [];
  try {
    await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Avalid_254_a_2');
    await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 13);
    for (const index of [73, 109, 50, 73]) {
      await page.evaluate(async index => {
        const s = window.services;
        const vp = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        await vp.setImageIdIndex(index); vp.render();
      }, index);
      await page.waitForTimeout(500);
      const frame = await page.evaluate(async () => {
        const s = window.services;
        const vp = s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);
        const actors = vp.getActors().filter(e => e.representationUID?.includes('-Labelmap'));
        const buffers = actors.map(e => e.actor.getMapper().getInputData().getPointData().getScalars().getData());
        return {
          index: vp.getCurrentImageIdIndex(), count: actors.length,
          distinctBuffers: new Set(buffers.map(b => b.buffer)).size,
          masks: await Promise.all(actors.map(async (e, i) => {
            const seg = s.segmentationService.getSegmentations().find(seg => e.representationUID.startsWith(seg.segmentationId + '-Labelmap'));
            const bytes = buffers[i];
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return { label: seg.label, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
          })),
        };
      });
      assert.equal(frame.count, 13); assert.equal(frame.distinctBuffers, 13);
      for (const mask of frame.masks) {
        const match = mask.label.match(/(valid_254_a_2__finding_\d+\.nii\.gz)(?: \/ (\d+))?/);
        assert(match, mask.label);
        const saved = audit.savedMasks.find(m => m.file === match[1] && m.label === Number(match[2] || 1));
        assert.equal(mask.sha256, saved.sliceHashes[frame.index], mask.label + ' at ' + frame.index);
      }
      results.push(frame); console.log('Verified slice', index, '13 separate buffers, all match source');
    }
    fs.writeFileSync('local-data/acceptance/valid_254_a_2-render-audit.json', JSON.stringify({ passed: true, results }, null, 2));
  } finally { await browser.close(); }
})();
