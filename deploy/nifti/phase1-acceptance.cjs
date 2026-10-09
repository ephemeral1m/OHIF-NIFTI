const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.NIFTI_TEST_URL;
assert(base, 'Set the isolated acceptance URL explicitly');
const out = process.env.NIFTI_TEST_OUTPUT || path.join(__dirname, 'acceptance-results/phase1');
fs.mkdirSync(out, { recursive: true });
const auth = { username: process.env.NIFTI_TEST_USERNAME, password: process.env.NIFTI_TEST_PASSWORD, origin: base };
async function colors(page) {
  return page.evaluate(() => {
    const s = window.services, id = s.viewportGridService.getState().activeViewportId;
    return s.segmentationService.getSegmentations().map(m => ({ name:m.label, color:s.segmentationService.getSegmentColor(id,m.segmentationId,1),
      foreground:m.representationData.Labelmap.imageIds.reduce((n,id)=>n+window.cornerstone.cache.getImage(id).getPixelData().reduce((a,v)=>a+Number(v!==0),0),0) }));
  });
}
(async()=>{
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({httpCredentials:auth,viewport:{width:1500,height:950}});
  const page = await context.newPage(); page.setDefaultTimeout(120000); page.on('dialog',d=>d.accept());
  const report={base, errors:[]}; page.on('pageerror',e=>report.errors.push(e.message));
  try {
    await page.goto(base+'/nifti',{waitUntil:'domcontentloaded'});
    await page.getByRole('heading',{name:'NIfTI 检查列表',exact:true}).waitFor();
    assert.equal(await page.getByLabel('原图类型',{exact:true}).count(),0);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('menuitem',{name:'导入默认设置',exact:true}).waitFor();
    report.menuHitTest=await page.getByRole('menuitem',{name:'导入默认设置',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
    assert(report.menuHitTest); await page.screenshot({animations:'disabled',path:path.join(out,'settings-menu.png')});
    await page.getByRole('menuitem',{name:'导入默认设置',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('原图类型',{exact:true}).selectOption('MR');
    await page.getByRole('button',{name:'保存默认设置',exact:true}).click();
    await page.getByRole('status').filter({hasText:'MR'}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'打开本地原图',exact:true}).click();
    assert.equal(await page.getByLabel('原图类型',{exact:true}).inputValue(),'MR');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'导入 CSV / JSON',exact:true}).click();
    await page.getByLabel('原图类型',{exact:true}).selectOption('CT');
    await page.screenshot({animations:'disabled',path:path.join(out,'import-dialog.png')});
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'选择 CSV / JSON 文件',exact:true}).click();
    await (await chooser).setFiles({name:'phase1.csv',mimeType:'text/csv',buffer:Buffer.from('image,segmentation1,segmentation2\n/nifti-acceptance-data/ct-oblique.nii.gz,/nifti-acceptance-data/ct-oblique-labels.nii.gz,\n')});
    const open = page.getByRole('button',{name:'打开 ct-oblique.nii.gz',exact:true});
    await open.waitFor();
    // The library can already contain this filename; wait for manifest validation,
    // not merely for an identically named library button.
    await page.getByText('使用绝对路径，无需设置路径起点',{exact:false}).waitFor();
    report.fonts=await page.evaluate(()=>({heading:getComputedStyle(document.querySelector('h1')).fontSize,table:getComputedStyle(document.querySelector('table')).fontSize,path:getComputedStyle(document.querySelector('tbody td p')).fontSize}));
    assert.deepEqual(report.fonts,{heading:'24px',table:'16px',path:'14px'});
    await page.getByText('1 个分割文件',{exact:true}).click();
    await page.getByText('目标数量在加载后确认',{exact:true}).waitFor();
    await page.screenshot({animations:'disabled',path:path.join(out,'manifest-list.png')});
    // Changing future import defaults must not relabel the current manifest.
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('menuitem',{name:'导入默认设置',exact:true}).click();
    await page.getByLabel('原图类型',{exact:true}).selectOption('MR');
    await page.getByRole('button',{name:'保存默认设置',exact:true}).click();
    assert.equal(await page.locator('tbody tr td').nth(1).innerText(),'CT');
    await open.click();
    await page.waitForFunction(()=>window.services?.segmentationService.getSegmentations().length===2);
    report.initial=await colors(page);
    assert.equal(new Set(report.initial.map(m=>JSON.stringify(m.color))).size,2);
    await page.evaluate(()=>{const s=window.services,id=s.viewportGridService.getState().activeViewportId,m=s.segmentationService.getSegmentations()[0];const used=s.segmentationService.getSegmentations().map(m=>JSON.stringify(s.segmentationService.getSegmentColor(id,m.segmentationId,1)));const next=[[90,230,150,255],[255,185,45,255],[180,120,245,255]].find(c=>!used.includes(JSON.stringify(c)));s.segmentationService.setSegmentColor(id,m.segmentationId,1,next);});
    await page.getByText(/个目标未保存/).first().waitFor();
    await page.getByRole('button',{name:'Save All',exact:true}).click();
    await page.getByRole('status').filter({hasText:'已保存 2 / 2'}).waitFor();
    report.saved=await colors(page);
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.services?.segmentationService.getSegmentations().length===2);
    report.reloaded=await colors(page);
    for(const expected of report.saved) assert.deepEqual(report.reloaded.find(m=>m.name===expected.name),expected);
    // MPR must retain the same colors, not restore the default red LUT.
    await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
    await page.waitForFunction(()=>[...window.services.viewportGridService.getState().viewports.keys()].every(id=>window.services.cornerstoneViewportService.getCornerstoneViewport(id)?.getVolumeId?.()));
    report.mprColors=await page.evaluate(()=>{const s=window.services;return [...s.viewportGridService.getState().viewports.keys()].map(id=>s.segmentationService.getSegmentations().map(m=>s.segmentationService.getSegmentColor(id,m.segmentationId,1)));});
    assert(report.mprColors.every(list=>list.every((c,i)=>JSON.stringify(c)===JSON.stringify(report.reloaded[i].color))));
    await page.screenshot({animations:'disabled',path:path.join(out,'colored-masks.png')});
    const dpi=await browser.newContext({httpCredentials:auth,viewport:{width:1100,height:700},deviceScaleFactor:2});
    const small=await dpi.newPage(); await small.goto(base+'/nifti',{waitUntil:'domcontentloaded'});
    await small.getByRole('button',{name:'设置',exact:true}).click();
    await small.getByRole('menuitem',{name:'数据来源与保存说明',exact:true}).click();
    const dialog=small.getByRole('dialog'); await dialog.waitFor();
    const bounds=await dialog.boundingBox(); assert(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=1100 && bounds.y+bounds.height<=700);
    await small.screenshot({animations:'disabled',path:path.join(out,'help-high-dpi.png')});
    await small.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'}); await dpi.close();
    assert.equal(report.errors.length,0); report.passed=true;
  }catch(error){report.passed=false;report.failure=error.message;report.text=(await page.locator('body').innerText()).slice(0,4000);await page.screenshot({animations:'disabled',path:path.join(out,'failure.png')});process.exitCode=1;}
  finally{fs.writeFileSync(path.join(out,'phase1.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
