/* Read-only production verification: no restore, copy or save operations. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.NIFTI_TEST_URL,sourceId='a26e1d05ee5944afb479290d481dbf79';
const out=process.env.NIFTI_TEST_OUTPUT||path.join(__dirname,'acceptance-results/annotation-production');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});const context=await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base},viewport:{width:1500,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(240000);const report={base,sourceId,errors:[],writes:0};page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/nifti-images'))report.writes++;});
 try{
  const catalog=(await(await context.request.get(base+'/monai/nifti-images/'+sourceId+'/masks')).json()).items;report.annotations=catalog.length;assert(catalog.length>=7);
  const first=catalog[0],history=(await(await context.request.get(base+'/monai/nifti-images/'+sourceId+'/masks/history?maskId='+first.maskId)).json());assert(history.items.every(m=>m.maskId===first.maskId));report.selectedVersions=history.total;
  await page.goto(base+'/nifti?sourceId='+sourceId,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'标注历史',exact:true}).click();
  await page.getByRole('combobox',{name:'选择标注',exact:true}).waitFor();await page.getByRole('button',{name:'选择版本 v'+first.version,exact:true}).waitFor();
  assert.equal(await page.locator('ol[aria-label="当前标注的版本轨迹"] li').count(),history.total);
  const memory=()=>page.evaluate(()=>window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().bytes);
  const before=await memory();await page.getByRole('button',{name:'只读预览',exact:true}).click();await page.getByRole('region',{name:'只读历史影像预览'}).waitFor();
  const compressed=await(await context.request.get(base+'/monai/nifti-images/'+sourceId+'/masks/'+first.maskId+'?version='+first.version)).body();const nii=zlib.gunzipSync(compressed);assert.equal(nii.readInt16LE(70),2);const offset=nii.readFloatLE(108),positive=nii.subarray(offset).findIndex(v=>v===1);const plane=nii.readInt16LE(42)*nii.readInt16LE(44);const slice=positive<0?0:Math.floor(positive/plane);
  await page.getByLabel('历史预览切片',{exact:true}).fill(String(slice));report.previewSlice=slice+1;
  assert.equal(await page.evaluate(()=>window.services.segmentationService.getSegmentations().length),0);
  await page.screenshot({path:path.join(out,'rex-independent-history.png'),animations:'disabled'});
  await page.getByRole('button',{name:'结束预览',exact:true}).click();assert.equal(await memory(),before);
  await page.getByLabel('搜索标注名称',{exact:true}).fill('finding_1');assert(await page.getByRole('combobox',{name:'选择标注',exact:true}).locator('option').count()>=1);
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.deepEqual(report.errors,[]);assert.equal(report.writes,0);report.passed=true;
 }catch(e){report.passed=false;report.failure=e.stack;report.text=(await page.locator('body').innerText()).slice(0,4500);await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'});process.exitCode=1;}
 finally{fs.writeFileSync(path.join(out,'production-annotation-history.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
