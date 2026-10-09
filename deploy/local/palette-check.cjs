const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page = await browser.newPage({viewport:{width:1600,height:1000}});
  page.setDefaultTimeout(90000);
  const result = {errors:[],checks:[]};
  page.on('pageerror', e => result.errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_13249_b_2');
    await page.waitForFunction(() => window.services?.segmentationService.getSegmentations().length === 6);
    await page.locator('.nw-tree-finding').nth(1).click();
    await page.locator('.nw-selected').waitFor();
    result.palette = await page.evaluate(() => {
      const style = selector => {const el=document.querySelector(selector),s=getComputedStyle(el); return {color:s.color,background:s.backgroundColor,image:s.backgroundImage};};
      return {header:style('.ohif-workbench-header'),report:style('.nw-report'),image:style('.nw-image-entry'),reportTab:style('.nw-tabs button:first-child'),tools:[...document.querySelectorAll('.ohif-workbench-header [data-workbench-tool]')].map(el=>({id:el.dataset.workbenchTool,buttons:[...el.querySelectorAll('button')].map(b=>({id:b.id,bg:getComputedStyle(b).backgroundColor,active:b.getAttribute('aria-pressed')}))}))};
    });
    assert(result.palette.header.image.includes('gradient'));
    assert.equal(result.palette.image.color,'rgb(126, 227, 224)');
    assert.equal(result.palette.reportTab.color,'rgb(247, 206, 158)');
    assert.equal(result.palette.report.background,'rgb(16, 16, 20)');
    result.checks.push('Purple header, teal image entry, warm report tab and neutral report text');
    await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/palette-report.png'});
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('menu').waitFor(); await page.keyboard.press('Escape');
    result.checks.push('Settings menu opens');
    await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
    await page.getByRole('button',{name:'显示配置',exact:true}).click();
    await page.locator('[aria-label="全局显示配置"]').waitFor();
    await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/palette-annotation.png'});
    result.checks.push('Annotation panel and display configuration retained');
    assert.equal(result.errors.length,0,result.errors.join('\n'));
    result.passed=true;
  } catch(e) {result.failure=e.stack;await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/palette-failure.png'}).catch(()=>{});throw e;}
  finally {fs.writeFileSync('E:/ohif-ai/local-data/acceptance/palette.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();}
})();
