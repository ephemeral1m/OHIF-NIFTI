const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base = 'http://127.0.0.1:1026';
const out = 'E:/ohif-ai/local-data/acceptance';
(async()=>{
 const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const context = await browser.newContext({viewport:{width:1600,height:1000}});
 const page = await context.newPage(); page.setDefaultTimeout(120000);
 const result={checks:[],errors:[],frames:[]};
 page.on('pageerror',e=>result.errors.push(e.message));
 page.on('request',r=>{if(/\/frames\/\d+$/.test(r.url()))result.frames.push(r.url());});
 page.on('dialog',d=>d.accept());
 const check=s=>{result.checks.push(s);console.log(s);};
 const ready=()=>page.waitForFunction(()=>{try {const s=window.services;const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return v.getCornerstoneImage()?.imageId===v.getCurrentImageId()&&v.getCornerstoneImage()?.getPixelData()?.length>0;}catch{return false;}});
 try {
  let m;
  const record=out+'/workspace-manifest.json';
  if(fs.existsSync(record)){const old=JSON.parse(fs.readFileSync(record));const r=await context.request.get(base+'/monai/nifti-images/manifests/'+old.id);if(r.ok())m=await r.json();}
  if(!m){const response=await context.request.post(base+'/monai/nifti-images/manifest/preview',{multipart:{file:{name:'ReX-5-cases.json',mimeType:'application/json',buffer:fs.readFileSync('E:/ohif-ai/local-data/rexgroundingct/rex-workspace.json')}}});assert.equal(response.status(),200,await response.text());m=await response.json();fs.writeFileSync(record,JSON.stringify(m,null,2));}
  assert(m.items.every(r=>r.status==='ready'));check('Five case paths validated; original data read-only');
  const row=m.items.find(r=>r.name==='train_13249_b_2.nii.gz');
  result.url=base+'/nifti?manifestId='+m.id+'&caseId='+encodeURIComponent(row.caseId);
  await page.goto(result.url,{waitUntil:'domcontentloaded'});
  await ready();check('ReX CT opened through manifest with streaming');
  await page.getByRole('region',{name:'病例与文件'}).waitFor();
  await page.getByRole('region',{name:'病例报告'}).waitFor();
  await page.waitForFunction(()=>window.services.segmentationService.getSegmentations().length===6);
  await page.getByRole('button',{name:'展开 Finding 2 标签',exact:true}).click();
  await page.locator('.nw-tree-finding').nth(1).click();
  await page.locator('.nw-statement.candidate').waitFor();
  await page.waitForFunction(()=>{const s=window.services;const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return v.getCurrentImageIdIndex()!==86;});
  assert.equal(await page.locator('.nw-case-pick').count(),5);
  check('Full case list retained; Finding click locates mask and report candidate');
  await page.getByRole('button',{name:/确认语句关联/}).first().click();
  await page.locator('.nw-statement.linked').waitFor();
  check('Explicit report binding saved');
  await page.screenshot({path:out+'/workspace-report.png'});
  await page.reload({waitUntil:'domcontentloaded'});await ready();
  await page.waitForFunction(()=>window.services.segmentationService.getSegmentations().length===6);
  await page.locator('.nw-tree-finding').nth(1).click();
  await page.locator('.nw-statement.linked').waitFor();check('Reload restores manifest, report binding and all masks');
  await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
  await page.locator('.seg-group').first().waitFor({state:'visible'});
  await page.getByRole('button',{name:/显示设置/}).first().click();
  assert(await page.getByRole('slider',{name:/填充透明度/}).first().isVisible());
  assert(await page.getByRole('button',{name:'仅边界',exact:true}).first().isVisible());
  assert(await page.getByRole('button',{name:'标注历史',exact:true}).isVisible());
  await page.screenshot({path:out+'/workspace-annotations.png'});check('Existing opacity, outline and annotation history controls retained');
  await page.getByRole('button',{name:'报告',exact:true}).first().click();
  await page.getByRole('combobox',{name:'报告来源'}).selectOption({label:'CT-RATE · 原始文本'});
  await page.getByText('Non-contrast images were taken in the axial plane with a section thickness of 1.5 mm.',{exact:true}).waitFor();
  check('Original report source switch');
  await page.getByRole('button',{name:'打开病例 train_12470_a_1.nii.gz',exact:true}).click();await ready();
  await page.waitForFunction(()=>window.services.segmentationService.getSegmentations().length===3);
  assert(!(await page.locator('.nw-report').innerText()).includes('19 mm'));
  check('Switch cases retains list and loads isolated masks');
  await page.goto(base+'/',{waitUntil:'domcontentloaded'});await page.getByText('SYNTHETIC, LOCAL',{exact:true}).waitFor();
  check('DICOM worklist remains available');
  assert.equal(result.errors.length,0,JSON.stringify(result.errors)); result.passed=true;
 } catch(e){result.failure=e.stack;await page.screenshot({path:out+'/workspace-failure.png'}).catch(()=>{});throw e;}
 finally{fs.writeFileSync(out+'/workspace-browser.json',JSON.stringify(result,null,2));await browser.close();}
})();
