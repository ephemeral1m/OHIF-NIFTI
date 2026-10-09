const fs = require('node:fs'), assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
 const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
 const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(90000);
 const result = { errors: [], states: [] };
 page.on('pageerror', e => result.errors.push(e.stack));
 page.on('console', m => { if (m.type() === 'error') { result.errors.push(m.text()); console.log('BROWSER', m.text()); } });
 const snapshot = async name => {
  const data = await page.evaluate(() => {
   const s = window.services, hp = s.hangingProtocolService;
   return { hp: hp.getState(), studies: hp.studies?.map(x => x.StudyInstanceUID), hpSets: hp.displaySets?.map(x => x.displaySetInstanceUID),
    activeSets: s.displaySetService.getActiveDisplaySets().map(x => ({ id: x.displaySetInstanceUID, study: x.StudyInstanceUID, complete: x.nativeIsComplete?.() })),
    viewports: [...s.viewportGridService.getState().viewports.values()].map(v => ({ id: v.viewportId, ds: v.displaySetInstanceUIDs, actors: s.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.getActors().length })) };
  }); result.states.push({ name, ...data }); console.log(name, JSON.stringify(data));
 };
 try {
  await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_12470_a_1');
  await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 3);
  await snapshot('initial');
  await page.getByRole('button', { name: 'Change layout', exact: true }).click();
  await page.locator('[data-cy="Axial Primary"]').click();
  await page.waitForFunction(() => window.services.viewportGridService.getState().viewports.size === 3);
  await snapshot('initial-mpr');
  await page.getByRole('button', { name: '打开病例 train_13249_b_2.nii.gz', exact: true }).click();
  await page.waitForFunction(() => location.search.includes('case%3Atrain_13249_b_2') && window.services.segmentationService.getSegmentations().length === 6);
  await snapshot('switched');
  await page.getByRole('button', { name: 'Change layout', exact: true }).click();
  await page.locator('[data-cy="Axial Primary"]').click();
  await page.waitForFunction(() => document.body.textContent.includes('The hanging protocol could not be applied.') || window.services.viewportGridService.getState().viewports.size === 3);
  await snapshot('axial');
  assert.equal(result.states.at(-1).viewports.length, 3, 'Axial Primary after switch');
  await page.waitForFunction(() => { const s=window.services;return [...s.viewportGridService.getState().viewports.keys()].every(id=>s.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length===7); });
  // Also exercise layout reuse before another switch, then reopen an earlier case.
  await page.getByRole('button', { name: 'Change layout', exact: true }).click();
  await page.getByRole('button', { name: '布局 2 × 2', exact: true }).click();
  await page.waitForFunction(() => window.services.viewportGridService.getState().viewports.size === 4);
  for (const [name, count] of [['train_13092_a_2',14], ['train_12470_a_1',3]]) {
    await page.getByRole('button', {name:`打开病例 ${name}.nii.gz`,exact:true}).click();
    await page.waitForFunction(({name,count})=>location.search.includes('case%3A'+name)&&window.services.segmentationService.getSegmentations().length===count,{name,count});
    await snapshot('switched-'+name);
    assert.equal(result.states.at(-1).activeSets.length,1);
    await page.getByRole('button',{name:'Change layout',exact:true}).click();
    await page.locator('[data-cy="Axial Primary"]').click();
    await page.waitForFunction(count=>{const s=window.services;return s.viewportGridService.getState().viewports.size===3&&[...s.viewportGridService.getState().viewports.keys()].every(id=>s.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length===count+1);},count);
    await snapshot('axial-'+name);
  }
  assert.deepEqual(result.errors,[]);
  result.passed = true;
 } catch (e) { result.failure = e.stack; throw e; }
 finally { await page.screenshot({path:'local-data/acceptance/case-layout.png'}).catch(()=>{});fs.writeFileSync('local-data/acceptance/case-layout.json',JSON.stringify(result,null,2)); await browser.close(); }
})();
