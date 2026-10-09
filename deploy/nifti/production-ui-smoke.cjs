/* Read-only production smoke: imports manifest references, never opens/writes a case. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, request } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.NIFTI_TEST_URL;
const output = process.env.NIFTI_TEST_OUTPUT || path.join(__dirname, 'acceptance-results');
assert(base, 'Set NIFTI_TEST_URL explicitly');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const report = { base, errors: [], started: new Date().toISOString() };
  const anonymous = await request.newContext();
  report.unauthenticated = (await anonymous.get(base + '/monai/nifti-images')).status();
  assert.equal(report.unauthenticated, 401); await anonymous.dispose();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
  try {
    const context = await browser.newContext({ httpCredentials: { username: process.env.NIFTI_TEST_USERNAME,
      password: process.env.NIFTI_TEST_PASSWORD, origin: base }, viewport: { width: 1500, height: 950 } });
    for (const [name, url] of [['health', '/monai/health'], ['library', '/monai/nifti-images'],
      ['dicom', '/pacs/dicom-web/studies'], ['roots', '/monai/nifti-images/manifest/roots']]) {
      const response = await context.request.get(base + url); assert.equal(response.status(), 200, name);
      const data = await response.json();
      if (name === 'library') report.sourceCount = data.total;
      if (name === 'dicom') report.dicomStudyCount = data.length;
      if (name === 'roots') report.roots = data.roots;
    }
    assert(report.sourceCount >= 3); assert.equal(report.dicomStudyCount, 4);
    assert.deepEqual(report.roots, ['/data/cache/datasets/CT-RATE', '/home/ubuntu/ohif-ai/nifti-demo/rex-grounding-ct']);
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const entry = page.getByRole('link', { name: 'NIfTI 检查列表', exact: true });
    await entry.waitFor(); assert.equal(await entry.count(), 1); assert.equal(await entry.locator('svg').count(), 1);
    await page.screenshot({ path: path.join(output, 'production-dicom-home.png') });
    await entry.click();
    await page.getByRole('heading', { name: 'NIfTI 检查列表', exact: true }).waitFor();
    report.headingFont = await page.locator('h1').evaluate(e => getComputedStyle(e).fontSize);
    assert.equal(report.headingFont, '24px');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('menuitem', { name: '数据来源与保存说明', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByLabel('NIfTI 病例清单', { exact: true }).setInputFiles(path.join(__dirname, 'examples/ct-rate.csv'));
    await page.getByText('valid_668_b_2.nii.gz', { exact: true }).first().waitFor();
    report.caseReady = await page.getByRole('button', { name: /打开.*valid_668/ }).isEnabled();
    assert(report.caseReady);
    await page.screenshot({ path: path.join(output, 'production-nifti-home.png') });
    assert.equal(report.errors.length, 0); report.passed = true;
  } catch (error) { report.passed = false; report.failure = error.message; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(output, 'production-ui.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
